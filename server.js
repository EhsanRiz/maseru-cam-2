import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 3000,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  // Direct HLS stream URL for Maseru Bridge camera
  streamUrl: 'https://5c50a1c26792b.streamlock.net/live/ngrp:MaseruBridge.stream_all/playlist.m3u8',
  captureInterval: 60000,
  cacheTimeout: 30000,
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
});

let latestScreenshot = null;
let latestAnalysis = null;
let lastAnalysisTime = 0;
let lastCaptureTime = 0;
let isCapturing = false;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Capture a frame from the HLS stream using ffmpeg
async function captureFrame() {
  if (isCapturing) {
    console.log('⏳ Capture already in progress, returning cached screenshot');
    return latestScreenshot;
  }

  isCapturing = true;
  const outputPath = '/tmp/frame.jpg';

  return new Promise((resolve) => {
    console.log('📸 Capturing frame from HLS stream...');
    
    // Use ffmpeg to capture a single frame from the HLS stream
    const ffmpeg = spawn('ffmpeg', [
      '-y',                          // Overwrite output file
      '-i', config.streamUrl,        // Input HLS stream
      '-vframes', '1',               // Capture only 1 frame
      '-q:v', '2',                   // Quality (2 = high quality)
      '-vf', 'scale=800:-1',         // Scale to 800px width
      outputPath                      // Output file
    ], {
      timeout: 30000,
    });

    let stderr = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      isCapturing = false;
      
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          const imageBuffer = fs.readFileSync(outputPath);
          latestScreenshot = imageBuffer;
          lastCaptureTime = Date.now();
          console.log(`✅ Frame captured successfully, size: ${imageBuffer.length} bytes`);
          resolve(imageBuffer);
        } catch (err) {
          console.error('❌ Failed to read captured frame:', err.message);
          resolve(latestScreenshot);
        }
      } else {
        console.error(`❌ ffmpeg failed with code ${code}`);
        console.error('stderr:', stderr.slice(-500));
        resolve(latestScreenshot);
      }
    });

    ffmpeg.on('error', (err) => {
      isCapturing = false;
      console.error('❌ ffmpeg error:', err.message);
      resolve(latestScreenshot);
    });

    // Timeout after 25 seconds
    setTimeout(() => {
      if (isCapturing) {
        ffmpeg.kill('SIGKILL');
        isCapturing = false;
        console.error('❌ ffmpeg timeout');
        resolve(latestScreenshot);
      }
    }, 25000);
  });
}

async function analyzeTraffic(screenshot, userQuestion = null) {
  if (!screenshot) {
    return {
      success: false,
      message: "No camera feed available. The stream might be temporarily offline. Please try again in a moment.",
    };
  }

  const now = Date.now();
  if (!userQuestion && latestAnalysis && (now - lastAnalysisTime) < config.cacheTimeout) {
    return latestAnalysis;
  }

  try {
    const base64Image = screenshot.toString('base64');
    
    const systemPrompt = `You are a helpful traffic analysis assistant for the Maseru Bridge border crossing between Lesotho and South Africa. 

Your job is to analyze camera feed images and provide clear, practical information about:
- Current traffic conditions (light, moderate, heavy, gridlocked)
- Estimated queue length (number of vehicles visible)
- Wait time estimates based on queue length
- Any notable observations (accidents, road work, weather conditions affecting visibility)
- Best advice for travelers

Be conversational, friendly, and practical. If it's nighttime and visibility is limited, mention that. 
If you can't see clearly, be honest about it.

Keep responses concise but informative. Use local context - people crossing here are typically going between Maseru (Lesotho) and Ladybrand/Bloemfontein (South Africa).`;

    const userPrompt = userQuestion 
      ? `Looking at this camera feed from Maseru Bridge border crossing, please answer this question: ${userQuestion}`
      : `Analyze this camera feed from Maseru Bridge border crossing. Describe the current traffic conditions, estimated queue length, and provide advice for travelers.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: userPrompt,
            },
          ],
        },
      ],
    });

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
      cached: false,
    };

    if (!userQuestion) {
      latestAnalysis = analysis;
      lastAnalysisTime = now;
    }

    return analysis;
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    return {
      success: false,
      message: `Analysis temporarily unavailable: ${error.message}`,
    };
  }
}

// API Routes
app.get('/api/status', async (req, res) => {
  try {
    const screenshot = await captureFrame();
    const analysis = await analyzeTraffic(screenshot);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get traffic status' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, message: 'Please provide a message' });
    }

    const screenshot = await captureFrame();
    const analysis = await analyzeTraffic(screenshot, message);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to process your question' });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const screenshot = await captureFrame();
    
    if (!screenshot) {
      return res.status(503).json({ success: false, message: 'No screenshot available' });
    }

    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get screenshot' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    lastCapture: lastCaptureTime ? new Date(lastCaptureTime).toISOString() : 'none',
    hasScreenshot: !!latestScreenshot,
    uptime: process.uptime(),
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    streamUrl: config.streamUrl,
    lastCapture: lastCaptureTime ? new Date(lastCaptureTime).toISOString() : 'none',
    screenshotSize: latestScreenshot ? latestScreenshot.length : 0,
    isCapturing,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Background capture every 60 seconds
async function startBackgroundCapture() {
  console.log('🔄 Starting background capture...');
  
  // Initial capture
  await captureFrame();
  
  // Periodic capture
  setInterval(async () => {
    await captureFrame();
  }, config.captureInterval);
}

// Start server
async function start() {
  console.log('🌉 Maseru Bridge Traffic Bot (FFmpeg Edition)');
  console.log('============================================');
  console.log(`📡 Stream URL: ${config.streamUrl}`);
  
  // Start background capture
  startBackgroundCapture();
  
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.port}`);
  });
}

start().catch(console.error);
