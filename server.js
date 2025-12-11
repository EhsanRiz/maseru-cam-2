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

You are analyzing multiple camera snapshots captured over the past few minutes. Use ALL images together to form ONE unified assessment - DO NOT describe each image separately.

CRITICAL RULES:
1. NEVER mention "Image 1", "Image 2", "Image 3" or any image numbers
2. NEVER describe what each image shows separately - give ONE unified analysis
3. Synthesize information from all frames into a single coherent assessment

RESPONSE FORMAT - Use this exact structure with bullet points:

**Traffic:** [One sentence - light/moderate/busy/heavy + brief description]

**Conditions:**
• [Queue status - e.g., "No significant queuing" or "Some vehicles waiting"]
• [Flow - e.g., "Vehicles moving steadily" or "Slow movement visible"]
• [Weather - e.g., "Clear visibility" or "Overcast conditions"]

**Advice:** [One practical sentence for travelers]

⚠️ AI estimate from camera snapshots. Conditions change quickly.

GUIDELINES:
- Keep it SHORT - max 4-5 bullet points total
- Use broad terms: "appears light", "looks moderate", "seems busy"
- NO specific vehicle counts or wait time estimates
- Be honest if visibility is limited or camera angle doesn't show queue clearly`;

    // Build content array with multiple images
    const content = [];
    
    framesToUse.forEach((frame, i) => {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: frame.screenshot.toString('base64'),
        },
      });
    });

    const userPrompt = userQuestion 
      ? `Based on these camera snapshots from Maseru Bridge border crossing, please answer briefly: ${userQuestion}`
      : `Analyze these camera snapshots from Maseru Bridge border crossing. Give a brief, structured assessment.`;

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

    // Get timestamp of most recent frame
    const latestFrame = framesToUse[framesToUse.length - 1];

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
      frameTimestamp: latestFrame.timestamp,
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
