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
  captureInterval: 180000,       // Capture every 3 minutes
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

// Preserved frames - one for each angle, never evicted
let preservedFrames = {
  bridge: null,
  processing: null,
  wide: null
};

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
      model: 'claude-haiku-4-5-20251001',
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

- BRIDGE: Shows bridge over river with orange/red pillar, vehicles on bridge lanes
- PROCESSING: Shows green curved roof canopy/shelter, vehicles in processing yard
- WIDE: Shows Engen petrol station OR Chiefs Fast Foods sign OR road with many vehicles heading to border
- USELESS: Shows mainly trees, bushes, greenery, darkness, sky, or no clear road/vehicles visible

IMPORTANT: If the image is mostly trees/vegetation with no clear infrastructure, answer USELESS.

Reply with ONE word only.`
          }
        ],
      }],
    });
    
    const result = response.content[0].text.trim().toUpperCase();
    console.log(`📷 Frame classified as: ${result}`);
    
    if (result.includes('BRIDGE')) return ANGLE_TYPES.BRIDGE;
    if (result.includes('PROCESSING')) return ANGLE_TYPES.PROCESSING;
    if (result.includes('WIDE')) return ANGLE_TYPES.WIDE;
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
          
          const frameData = {
            screenshot: imageBuffer,
            timestamp: timestamp,
            angleType: angleType
          };
          
          // Add to buffer
          screenshotBuffer.push(frameData);
          
          // Also preserve the latest frame for each useful angle type
          if (angleType !== 'useless' && preservedFrames.hasOwnProperty(angleType)) {
            preservedFrames[angleType] = frameData;
          }
          
          // Keep only recent frames in main buffer
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
    
    if (usefulFrames.length === 0 && !preservedFrames.bridge && !preservedFrames.processing && !preservedFrames.wide) {
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
    
    // Get the MOST RECENT frame from EACH useful angle type
    const framesToUse = [];
    const anglesUsed = [];
    
    // Priority: Bridge first (shows both directions), then others
    const anglePriority = [ANGLE_TYPES.BRIDGE, ANGLE_TYPES.PROCESSING, ANGLE_TYPES.WIDE];
    
    for (const angleType of anglePriority) {
      if (framesByAngle[angleType] && framesByAngle[angleType].length > 0) {
        // Get the most recent frame from this angle
        const frames = framesByAngle[angleType];
        framesToUse.push(frames[frames.length - 1]);
        anglesUsed.push(angleType);
      } else if (preservedFrames[angleType]) {
        // Use preserved frame as fallback
        framesToUse.push(preservedFrames[angleType]);
        anglesUsed.push(angleType + ' (preserved)');
      }
    }
    
    // If we have less than 3 frames, add more from the most common angle
    if (framesToUse.length < 3) {
      // Find angle with most frames
      let bestAngle = null;
      let maxCount = 0;
      for (const [angle, frames] of Object.entries(framesByAngle)) {
        if (frames.length > maxCount) {
          maxCount = frames.length;
          bestAngle = angle;
        }
      }
      
      // Add older frames from best angle if needed
      if (bestAngle && framesByAngle[bestAngle].length > 1) {
        const additionalFrames = framesByAngle[bestAngle].slice(0, -1); // exclude the one we already added
        for (const frame of additionalFrames.reverse()) {
          if (framesToUse.length >= 3) break;
          if (!framesToUse.includes(frame)) {
            framesToUse.push(frame);
          }
        }
      }
    }

    console.log(`🔍 Analyzing ${framesToUse.length} frames from angles: ${anglesUsed.join(', ')}`);

    // Create combined prompt for multiple angles
    const systemPrompt = `You are a traffic observation assistant for the Maseru Bridge border crossing between Lesotho and South Africa.

The camera rotates between THREE different views. Use LANDMARKS to identify traffic directions:

═══════════════════════════════════════════════════════════════
BRIDGE VIEW (river and orange pillar visible)
═══════════════════════════════════════════════════════════════
• LEFT side (away from orange pole) = LESOTHO → SA (traffic entering SA)
• RIGHT side (orange pole side) = SA → LESOTHO (traffic entering Lesotho)

═══════════════════════════════════════════════════════════════
CANOPY VIEW (green shelter structures, processing yard)
═══════════════════════════════════════════════════════════════
• LEFT side = GREEN CURVED ROOF CANOPY/SHELTER area = SA → LESOTHO (arriving from SA)
• RIGHT side = WALL SIDE with covered structure = LESOTHO → SA (waiting to leave)

HOW TO IDENTIFY LEFT vs RIGHT IN CANOPY VIEW:
- LEFT: Look for the distinctive GREEN CURVED ROOF shelter - vehicles under this roof are SA → LS
- RIGHT: Look for the wall/barrier side where vehicles queue in a LINE heading toward the covered structure - this is LS → SA

CRITICAL FOR CANOPY VIEW - READ CAREFULLY:
- If you see vehicles UNDER the green curved roof canopy = that's SA → LS traffic
- If you see vehicles in a LINE along the WALL on the right side = that's LS → SA traffic
- Scattered/parked cars in the MIDDLE of the open yard are NOT queued traffic - ignore them
- Assess each direction SEPARATELY - one can be heavy while the other is light

═══════════════════════════════════════════════════════════════
ENGEN VIEW (petrol station, wide road view)
═══════════════════════════════════════════════════════════════
• Shows approach road TO the border from Lesotho side
• If traffic backed up to Engen = SEVERE congestion for LS→SA
• This is the earliest warning of heavy queues

═══════════════════════════════════════════════════════════════
CROSS-REFERENCE VIEWS FOR ACCURACY:
═══════════════════════════════════════════════════════════════
Assess each direction by checking BOTH views when available:

**To confirm SA → LS traffic:**
- Bridge: Check RIGHT side (orange pole side)
- Canopy: Check under the GREEN CURVED ROOF shelter (left side)

**To confirm LS → SA traffic:**
- Bridge: Check LEFT side (away from orange pole)
- Canopy: Check the WALL SIDE where vehicles queue in a line (right side)

Both directions can have heavy traffic simultaneously!

═══════════════════════════════════════════════════════════════

TRAFFIC LEVEL DEFINITIONS (be accurate, don't over-report):
- LIGHT: 0-3 vehicles in that direction, no visible queue
- MODERATE: 4-10 vehicles, some waiting but manageable
- HEAVY: 10+ vehicles in a visible queue
- SEVERE: Traffic backed up to Engen petrol station (LS→SA only)

NIGHTTIME ANALYSIS (when image is dark):
- Count HEADLIGHTS as vehicles - each pair = 1 vehicle
- A ROW of headlights = a QUEUE = likely HEAVY traffic
- Multiple red taillights in a line = vehicles waiting
- At night, don't under-report - if you see many lights, it's busy

RESPONSE FORMAT:

**Traffic:** [Brief overall summary - one sentence]

[LS_TO_SA]
status: [LIGHT/MODERATE/HEAVY/SEVERE]
detail: [What you see - mention both bridge and canopy observations if available]
[/LS_TO_SA]

[SA_TO_LS]
status: [LIGHT/MODERATE/HEAVY/SEVERE]
detail: [What you see - mention both bridge and canopy observations if available]
[/SA_TO_LS]

**Advice:** [One practical sentence for travelers]

⚠️ AI estimate from camera snapshots. Conditions change quickly.

ANALYSIS METHODOLOGY - CROSS-REFERENCE BOTH VIEWS:
For EACH direction, check BOTH the bridge AND canopy if available:

**Lesotho → SA analysis:**
1. Bridge: Look at LEFT side (away from orange pole) - any queue there?
2. Canopy: Look at RIGHT side (wall side) - any queue there?
3. Combine observations for final LS→SA assessment

**SA → Lesotho analysis:**
1. Bridge: Look at RIGHT side (orange pole side) - any queue there?
2. Canopy: Look at LEFT side (green curved roof) - any vehicles there?
3. Combine observations for final SA→LS assessment

CRITICAL RULES:
1. NEVER mention "first image", "second image", "Image 1", etc.
2. NEVER mention "Bridge View", "Canopy View", or "VIEW 1/2/3" in your response
3. Synthesize ALL frames into ONE unified analysis
4. If you see Engen petrol station with backed-up traffic, specifically mention "traffic backed up to Engen"
5. Keep response concise - no technical explanations about camera angles or landmarks
6. Use landmarks internally to identify direction, but don't explain them to users
7. ACCURATELY identify which side has the queue - look for the GREEN CURVED ROOF to identify LEFT in canopy view
8. If an area is clear/empty, report it as LIGHT not Moderate
9. Only report what you actually SEE, not assumptions`;


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
      model: 'claude-haiku-4-5-20251001',
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

// Get all unique frames (one per angle type)
app.get('/api/frames', async (req, res) => {
  try {
    // Get the most recent frame of each angle type
    const framesByAngle = {};
    const angleLabels = {
      'bridge': 'Bridge',
      'processing': 'Canopy', 
      'wide': 'Engen',
      'useless': null // Skip useless frames
    };
    
    // Go through buffer in reverse to get most recent of each type
    for (let i = screenshotBuffer.length - 1; i >= 0; i--) {
      const frame = screenshotBuffer[i];
      const angleType = frame.angleType || 'unknown';
      
      // Skip useless frames and already captured angles
      if (angleType === 'useless' || framesByAngle[angleType]) continue;
      
      const label = angleLabels[angleType];
      if (label) {
        framesByAngle[angleType] = {
          angleType: angleType,
          label: label,
          timestamp: frame.timestamp,
          image: frame.screenshot.toString('base64')
        };
      }
    }
    
    // Fill in any missing angles from preserved frames
    const order = ['bridge', 'processing', 'wide'];
    for (const angleType of order) {
      if (!framesByAngle[angleType] && preservedFrames[angleType]) {
        const frame = preservedFrames[angleType];
        const label = angleLabels[angleType];
        if (label) {
          framesByAngle[angleType] = {
            angleType: angleType,
            label: label,
            timestamp: frame.timestamp,
            image: frame.screenshot.toString('base64')
          };
        }
      }
    }
    
    // Convert to array and sort by preferred order: Bridge, Canopy, Engen
    const frames = order
      .filter(type => framesByAngle[type])
      .map(type => framesByAngle[type]);
    
    res.json({
      success: true,
      frames: frames,
      totalInBuffer: screenshotBuffer.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get frames' });
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
