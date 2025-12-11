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
  captureInterval: 30000,       // Capture every 30 seconds
  cacheTimeout: 180000,         // Cache analysis for 3 minutes
  maxBufferSize: 12,            // Keep last 12 frames (6 minutes of history)
  analysisFrames: 3,            // Use 3 frames for analysis
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
});

// Buffer to store multiple screenshots with timestamps and angle classification
let screenshotBuffer = [];
let latestAnalysis = null;
let lastAnalysisTime = 0;
let isCapturing = false;
let isClassifying = false;

// Angle types
const ANGLE_TYPES = {
  BRIDGE: 'bridge',           // View of the bridge showing both lanes
  WIDE: 'wide',               // Wide view showing ENGEN, road to bridge
  PROCESSING: 'processing',   // Processing area with curved roof
  USELESS: 'useless'          // Trees, darkness, no useful info
};

// Classify frame angle using AI
async function classifyFrameAngle(imageBuffer) {
  if (isClassifying) return ANGLE_TYPES.USELESS;
  
  isClassifying = true;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: `Classify this Maseru Border camera image. Reply with ONLY one word:
- BRIDGE (if you see the bridge with lanes/vehicles on it)
- WIDE (if you see ENGEN station, Chiefs Fast Foods, road curving toward bridge)
- PROCESSING (if you see curved roof canopy, vehicles at border processing area)
- USELESS (if you only see trees, darkness, lights, or nothing useful)

Reply with ONE word only.`
          }
        ],
      }],
    });
    
    const result = response.content[0].text.trim().toUpperCase();
    console.log(`📷 Frame classified as: ${result}`);
    
    if (result.includes('BRIDGE')) return ANGLE_TYPES.BRIDGE;
    if (result.includes('WIDE')) return ANGLE_TYPES.WIDE;
    if (result.includes('PROCESSING')) return ANGLE_TYPES.PROCESSING;
    return ANGLE_TYPES.USELESS;
    
  } catch (error) {
    console.error('❌ Classification failed:', error.message);
    return ANGLE_TYPES.USELESS;
  } finally {
    isClassifying = false;
  }
}

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

    ffmpeg.on('close', async (code) => {
      isCapturing = false;
      
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          const imageBuffer = fs.readFileSync(outputPath);
          const timestamp = Date.now();
          
          // Classify the frame angle
          const angleType = await classifyFrameAngle(imageBuffer);
          
          // Add to buffer with angle type
          screenshotBuffer.push({
            screenshot: imageBuffer,
            timestamp: timestamp,
            angleType: angleType
          });
          
          // Keep only recent frames
          if (screenshotBuffer.length > config.maxBufferSize) {
            screenshotBuffer = screenshotBuffer.slice(-config.maxBufferSize);
          }
          
          // Count frames by type
          const counts = screenshotBuffer.reduce((acc, f) => {
            acc[f.angleType] = (acc[f.angleType] || 0) + 1;
            return acc;
          }, {});
          
          console.log(`✅ Frame captured (${angleType}), buffer: ${JSON.stringify(counts)}`);
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
    // Filter out useless frames and group by angle type
    const usefulFrames = screenshotBuffer.filter(f => f.angleType !== ANGLE_TYPES.USELESS);
    
    if (usefulFrames.length === 0) {
      return {
        success: false,
        message: "Camera view is currently limited. Please try again in a moment for a better view.",
      };
    }
    
    // Group frames by angle type
    const framesByAngle = {};
    usefulFrames.forEach(frame => {
      if (!framesByAngle[frame.angleType]) {
        framesByAngle[frame.angleType] = [];
      }
      framesByAngle[frame.angleType].push(frame);
    });
    
    // Find the angle type with the most frames
    let bestAngle = null;
    let maxCount = 0;
    for (const [angle, frames] of Object.entries(framesByAngle)) {
      if (frames.length > maxCount) {
        maxCount = frames.length;
        bestAngle = angle;
      }
    }
    
    // Get frames from the best angle (up to 3)
    const sameAngleFrames = framesByAngle[bestAngle];
    const framesToUse = [];
    
    if (sameAngleFrames.length >= 3) {
      // Get first, middle, and last frames from same angle
      framesToUse.push(sameAngleFrames[0]);
      framesToUse.push(sameAngleFrames[Math.floor(sameAngleFrames.length / 2)]);
      framesToUse.push(sameAngleFrames[sameAngleFrames.length - 1]);
    } else {
      // Use all available frames from same angle
      framesToUse.push(...sameAngleFrames);
    }

    console.log(`🔍 Analyzing ${framesToUse.length} frames from angle: ${bestAngle}`);

    // Create angle-specific prompt
    const angleGuide = {
      [ANGLE_TYPES.BRIDGE]: `You are viewing the BRIDGE. 
- LEFT lane (bright/lit side, closer to camera): Vehicles coming INTO Lesotho (SA → Lesotho)
- RIGHT lane (far/dark side): Vehicles going TO South Africa (Lesotho → SA)
Compare the frames to see if vehicles are moving or stationary.`,
      
      [ANGLE_TYPES.WIDE]: `You are viewing the WIDE ANGLE showing:
- RIGHT side: ENGEN petrol station, road curving toward bridge (Lesotho → SA traffic)
- Road area heading to bridge (Lesotho → SA traffic)
- You can see if vehicles are queued heading toward SA.`,
      
      [ANGLE_TYPES.PROCESSING]: `You are viewing the PROCESSING AREA showing:
- LEFT side: Curved roof canopy where vehicles wait (SA → Lesotho traffic)
- Vehicles entering Lesotho from the bridge
- Road heading to bridge on the right (Lesotho → SA traffic)
Compare frames to see if vehicles are moving or stationary.`
    };

    const systemPrompt = `You are a traffic observation assistant for the Maseru Bridge border crossing between Lesotho and South Africa.

You are viewing MULTIPLE FRAMES from the SAME camera angle taken over several minutes. Compare them to detect movement.

${angleGuide[bestAngle] || ''}

ANALYSIS METHOD:
1. Compare vehicle positions across frames
2. If vehicles are in SAME position = HEAVY (stagnant)
3. If vehicles have MOVED/CHANGED = traffic is flowing (LIGHT or MODERATE)
4. Count approximate vehicles: 0-2 = LIGHT, 3-6 = MODERATE, 7+ queued = HEAVY

TRAFFIC ASSESSMENT:

**LESOTHO → SOUTH AFRICA:**
- LIGHT: Road mostly empty, few vehicles, moving freely
- MODERATE: Some vehicles present, moving steadily
- HEAVY: Long queue, vehicles stagnant across multiple frames

**SOUTH AFRICA → LESOTHO:**
- LIGHT: Few vehicles, processing area mostly empty
- MODERATE: Several vehicles, some activity at processing
- HEAVY: Vehicles packed at processing area, not moving between frames

RESPONSE FORMAT:

**Traffic:** [Brief summary of overall conditions]

**Conditions:**
• Lesotho → SA: [Light/Moderate/Heavy based on what you see, or "Not visible" if this direction not in view]
• SA → Lesotho: [Light/Moderate/Heavy based on what you see, or "Not visible" if this direction not in view]

**Advice:** [One practical sentence]

⚠️ AI estimate from camera snapshots. Conditions change quickly.

RULES:
- Be ACCURATE - only report what you can see in these frames
- If a direction is not visible in this angle, say "Not visible in current view"
- Compare frames to detect if traffic is moving or stuck
- Keep response short and factual`;

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
  // Count frames by angle type
  const angleCounts = screenshotBuffer.reduce((acc, f) => {
    acc[f.angleType] = (acc[f.angleType] || 0) + 1;
    return acc;
  }, {});
  
  res.json({
    streamUrl: config.streamUrl,
    bufferSize: screenshotBuffer.length,
    angleCounts: angleCounts,
    frames: screenshotBuffer.map(f => ({
      timestamp: new Date(f.timestamp).toISOString(),
      angleType: f.angleType,
      size: f.screenshot.length
    })),
    isCapturing,
    isClassifying,
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
