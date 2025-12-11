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
  streamUrl: 'https://5c50a1c26792b.streamlock.net/live/ngrp:MaseruBridge.stream_all/playlist.m3u8',
  captureInterval: 60000,      // Capture every 60 seconds
  cacheTimeout: 180000,        // Cache analysis for 3 minutes
  maxBufferSize: 6,            // Keep last 6 frames (6 minutes of history)
  analysisFrames: 3,           // Use 3 frames for analysis
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
});

// Buffer to store multiple screenshots with timestamps
let screenshotBuffer = [];
let latestAnalysis = null;
let lastAnalysisTime = 0;
let isCapturing = false;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Capture a frame from the HLS stream using ffmpeg
async function captureFrame() {
  if (isCapturing) {
    console.log('⏳ Capture already in progress');
    return screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null;
  }

  isCapturing = true;
  const outputPath = '/tmp/frame.jpg';

  return new Promise((resolve) => {
    console.log('📸 Capturing frame from HLS stream...');
    
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', config.streamUrl,
      '-vframes', '1',
      '-q:v', '2',
      '-vf', 'scale=800:-1',
      outputPath
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
          const timestamp = Date.now();
          
          // Add to buffer
          screenshotBuffer.push({
            screenshot: imageBuffer,
            timestamp: timestamp
          });
          
          // Keep only recent frames
          if (screenshotBuffer.length > config.maxBufferSize) {
            screenshotBuffer = screenshotBuffer.slice(-config.maxBufferSize);
          }
          
          console.log(`✅ Frame captured, buffer size: ${screenshotBuffer.length}`);
          resolve(imageBuffer);
        } catch (err) {
          console.error('❌ Failed to read captured frame:', err.message);
          resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
        }
      } else {
        console.error(`❌ ffmpeg failed with code ${code}`);
        resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
      }
    });

    ffmpeg.on('error', (err) => {
      isCapturing = false;
      console.error('❌ ffmpeg error:', err.message);
      resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
    });

    setTimeout(() => {
      if (isCapturing) {
        ffmpeg.kill('SIGKILL');
        isCapturing = false;
        console.error('❌ ffmpeg timeout');
        resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
      }
    }, 25000);
  });
}

// Get the latest screenshot for display
function getLatestScreenshot() {
  if (screenshotBuffer.length > 0) {
    return screenshotBuffer[screenshotBuffer.length - 1].screenshot;
  }
  return null;
}

async function analyzeTraffic(userQuestion = null) {
  if (screenshotBuffer.length === 0) {
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
    // Get frames for analysis (up to 3 frames spread across the buffer)
    const framesToUse = [];
    const bufferLen = screenshotBuffer.length;
    
    if (bufferLen >= 3) {
      // Get first, middle, and last frames
      framesToUse.push(screenshotBuffer[0]);
      framesToUse.push(screenshotBuffer[Math.floor(bufferLen / 2)]);
      framesToUse.push(screenshotBuffer[bufferLen - 1]);
    } else {
      // Use all available frames
      framesToUse.push(...screenshotBuffer);
    }

    console.log(`🔍 Analyzing ${framesToUse.length} frames...`);

    const systemPrompt = `You are a traffic observation assistant for the Maseru Bridge border crossing between Lesotho and South Africa.

You are being shown ${framesToUse.length} images captured over the last few minutes from the same camera. Analyze them together to understand traffic TRENDS and give more accurate observations.

IMPORTANT GUIDELINES:
1. COMPARE THE IMAGES - Look for changes between frames to understand if traffic is building up, clearing, or stable
2. BE CONSERVATIVE - Only describe what you can clearly see across the images
3. USE BROAD CATEGORIES for traffic: "appears light", "looks moderate", "seems busy", "appears heavy"
4. MENTION TRENDS if visible: "traffic appears to be building up", "queue seems stable", "conditions look similar across images"
5. AVOID SPECIFIC COUNTS - Say "several vehicles" or "a queue of vehicles" not exact numbers
6. AVOID SPECIFIC WAIT TIMES - Say "may experience some delays" not "30-45 minutes"
7. IF UNSURE, SAY SO - Better to be honest about limitations

What you CAN describe:
- General traffic level based on all images
- Whether traffic is increasing, decreasing, or stable
- Weather/visibility conditions
- General observations (trucks, pedestrians, etc.)

What you should AVOID:
- Specific vehicle counts
- Specific wait time estimates in minutes
- Definitive promises about conditions

Keep responses concise. Always end with:
"⚠️ This is an AI estimate from camera snapshots. Conditions change quickly - verify before critical travel decisions."`;

    // Build content array with multiple images
    const content = [];
    
    framesToUse.forEach((frame, i) => {
      const ageSeconds = Math.round((now - frame.timestamp) / 1000);
      const ageText = ageSeconds < 60 ? `${ageSeconds} seconds` : `${Math.round(ageSeconds / 60)} minutes`;
      
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: frame.screenshot.toString('base64'),
        },
      });
      content.push({
        type: 'text',
        text: `[Image ${i + 1} of ${framesToUse.length}: captured ${ageText} ago]`
      });
    });

    const userPrompt = userQuestion 
      ? `Based on these ${framesToUse.length} camera images from Maseru Bridge border crossing, please answer: ${userQuestion}`
      : `Analyze these ${framesToUse.length} camera images from Maseru Bridge border crossing. Describe current conditions and any trends you observe.`;

    content.push({
      type: 'text',
      text: userPrompt
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: content,
        },
      ],
    });

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
      framesAnalyzed: framesToUse.length,
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
    await captureFrame();
    const analysis = await analyzeTraffic();
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

    await captureFrame();
    const analysis = await analyzeTraffic(message);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to process your question' });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    await captureFrame();
    const screenshot = getLatestScreenshot();
    
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
    bufferSize: screenshotBuffer.length,
    lastCapture: screenshotBuffer.length > 0 ? new Date(screenshotBuffer[screenshotBuffer.length - 1].timestamp).toISOString() : 'none',
    uptime: process.uptime(),
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    streamUrl: config.streamUrl,
    bufferSize: screenshotBuffer.length,
    frames: screenshotBuffer.map(f => ({
      timestamp: new Date(f.timestamp).toISOString(),
      size: f.screenshot.length
    })),
    isCapturing,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Background capture
async function startBackgroundCapture() {
  console.log('🔄 Starting background capture...');
  
  await captureFrame();
  
  setInterval(async () => {
    await captureFrame();
  }, config.captureInterval);
}

// Start server
async function start() {
  console.log('🌉 Maseru Bridge Traffic Bot v2.0');
  console.log('=================================');
  console.log(`📡 Stream URL: ${config.streamUrl}`);
  console.log(`📊 Multi-frame analysis: ${config.analysisFrames} frames`);
  
  startBackgroundCapture();
  
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.port}`);
  });
}

start().catch(console.error);
