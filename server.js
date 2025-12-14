import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

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
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
});

// Initialize Supabase client (only if credentials provided)
let supabase = null;
if (config.supabaseUrl && config.supabaseServiceKey) {
  supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
  console.log('✅ Supabase client initialized');
} else {
  console.log('⚠️ Supabase credentials not found - running without persistence');
}

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

// =============================================
// SUPABASE HELPER FUNCTIONS
// =============================================

// Upload frame to Supabase Storage
async function uploadFrameToStorage(imageBuffer, angleType, timestamp) {
  if (!supabase) return null;
  
  try {
    const fileName = `${angleType}/${timestamp}.jpg`;
    
    const { data, error } = await supabase.storage
      .from('frames')
      .upload(fileName, imageBuffer, {
        contentType: 'image/jpeg',
        upsert: true
      });
    
    if (error) {
      console.error('❌ Storage upload error:', error.message);
      return null;
    }
    
    // Get public URL
    const { data: urlData } = supabase.storage
      .from('frames')
      .getPublicUrl(fileName);
    
    return urlData?.publicUrl || fileName;
  } catch (err) {
    console.error('❌ Storage upload failed:', err.message);
    return null;
  }
}

// Log frame to history table (keeps 7 days of history)
async function logFrameHistory(angleType, framePath, timestamp) {
  if (!supabase) return;
  
  try {
    const { error } = await supabase
      .from('frame_history')
      .insert({
        angle_type: angleType,
        frame_path: framePath,
        timestamp: new Date(timestamp).toISOString()
      });
    
    if (error) {
      console.error('❌ Failed to log frame history:', error.message);
    }
  } catch (err) {
    console.error('❌ Frame history error:', err.message);
  }
}

// Update preserved frame in database
async function updatePreservedFrame(angleType, framePath, timestamp) {
  if (!supabase) return;
  
  try {
    const { error } = await supabase
      .from('preserved_frames')
      .upsert({
        angle_type: angleType,
        frame_path: framePath,
        timestamp: new Date(timestamp).toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'angle_type'
      });
    
    if (error) {
      console.error('❌ DB update error:', error.message);
    }
  } catch (err) {
    console.error('❌ Failed to update preserved frame:', err.message);
  }
}

// Log traffic reading to database
async function logTrafficReading(analysisResult, framesUsed, responseTimeMs) {
  if (!supabase) {
    console.log('⚠️ Supabase not connected, skipping traffic log');
    return;
  }
  
  try {
    const message = analysisResult.message || '';
    
    console.log('📝 Attempting to log traffic reading...');
    
    // Extract status from direction boxes - multiple regex patterns for flexibility
    let lsStatus = null, lsDetail = null, saStatus = null, saDetail = null;
    
    // Pattern 1: Standard format [LS_TO_SA] status: X detail: Y [/LS_TO_SA]
    const lsMatch1 = message.match(/\[LS_TO_SA\][\s\S]*?status:\s*(\w+)[\s\S]*?detail:\s*([\s\S]*?)\[\/LS_TO_SA\]/i);
    const saMatch1 = message.match(/\[SA_TO_LS\][\s\S]*?status:\s*(\w+)[\s\S]*?detail:\s*([\s\S]*?)\[\/SA_TO_LS\]/i);
    
    if (lsMatch1) {
      lsStatus = lsMatch1[1];
      lsDetail = lsMatch1[2];
    }
    if (saMatch1) {
      saStatus = saMatch1[1];
      saDetail = saMatch1[2];
    }
    
    // Pattern 2: Look for status badges like "LIGHT" after direction headers
    if (!lsStatus) {
      const lsAlt = message.match(/Lesotho\s*→\s*South Africa[^]*?(LIGHT|MODERATE|HEAVY|SEVERE)/i);
      if (lsAlt) lsStatus = lsAlt[1];
    }
    if (!saStatus) {
      const saAlt = message.match(/South Africa\s*→\s*Lesotho[^]*?(LIGHT|MODERATE|HEAVY|SEVERE)/i);
      if (saAlt) saStatus = saAlt[1];
    }
    
    // Extract traffic summary and advice
    const trafficMatch = message.match(/\*\*Traffic:\*\*\s*([^\n\[]+)/i);
    const adviceMatch = message.match(/\*\*Advice:\*\*\s*([^\n⚠]+)/i);
    
    // For non-standard responses, try to extract a summary
    let summary = trafficMatch ? trafficMatch[1].trim() : null;
    if (!summary && message.length > 0) {
      // Take first sentence as summary for non-standard responses
      const firstSentence = message.match(/^[^.!?]*[.!?]/);
      if (firstSentence) {
        summary = firstSentence[0].trim().substring(0, 200);
      }
    }
    
    // Normalize status values to match CHECK constraint
    const normalizeStatus = (status) => {
      if (!status) return null;
      const upper = status.toUpperCase().trim();
      if (['LIGHT', 'MODERATE', 'HEAVY', 'SEVERE'].includes(upper)) {
        return upper;
      }
      return null;
    };
    
    const reading = {
      timestamp: new Date().toISOString(),
      traffic_summary: summary,
      ls_to_sa_status: normalizeStatus(lsStatus),
      ls_to_sa_detail: lsDetail ? lsDetail.trim() : null,
      sa_to_ls_status: normalizeStatus(saStatus),
      sa_to_ls_detail: saDetail ? saDetail.trim() : null,
      advice: adviceMatch ? adviceMatch[1].trim() : null,
      frames_used: framesUsed,
      angles_available: framesUsed.map(f => f.angleType),
      response_time_ms: responseTimeMs
    };
    
    console.log('📊 Parsed reading:', JSON.stringify({
      ls_status: reading.ls_to_sa_status,
      sa_status: reading.sa_to_ls_status,
      summary: reading.traffic_summary?.substring(0, 50)
    }));
    
    const { data, error } = await supabase
      .from('traffic_readings')
      .insert(reading)
      .select();
    
    if (error) {
      console.error('❌ Failed to log reading:', error.message, error.details);
    } else {
      console.log('✅ Traffic reading logged to database, id:', data?.[0]?.id);
    }
  } catch (err) {
    console.error('❌ Failed to log traffic reading:', err.message);
  }
}

// Load preserved frames from database on startup
async function loadPreservedFramesFromDB() {
  if (!supabase) return;
  
  try {
    const { data, error } = await supabase
      .from('preserved_frames')
      .select('*');
    
    if (error) {
      console.error('❌ Failed to load preserved frames:', error.message);
      return;
    }
    
    if (!data || data.length === 0) {
      console.log('📷 No preserved frames in database yet');
      return;
    }
    
    // Download each preserved frame
    for (const row of data) {
      if (!row.frame_path) continue;
      
      try {
        // Download from storage
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('frames')
          .download(row.frame_path.replace(/^.*\/frames\//, ''));
        
        if (downloadError || !fileData) {
          console.log(`⚠️ Could not download ${row.angle_type} frame`);
          continue;
        }
        
        // Convert to buffer
        const arrayBuffer = await fileData.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Restore to memory
        preservedFrames[row.angle_type] = {
          screenshot: buffer,
          timestamp: new Date(row.timestamp).getTime(),
          angleType: row.angle_type
        };
        
        console.log(`✅ Restored ${row.angle_type} frame from database`);
      } catch (err) {
        console.log(`⚠️ Error restoring ${row.angle_type}:`, err.message);
      }
    }
    
    const restored = Object.values(preservedFrames).filter(f => f !== null).length;
    console.log(`📷 Restored ${restored}/3 preserved frames from database`);
    
  } catch (err) {
    console.error('❌ Failed to load preserved frames:', err.message);
  }
}

// Get typical traffic for current time (for predictions)
async function getTypicalTraffic() {
  if (!supabase) return null;
  
  try {
    const { data, error } = await supabase.rpc('get_typical_traffic');
    
    if (error) {
      console.error('❌ Failed to get typical traffic:', error.message);
      return null;
    }
    
    return data;
  } catch (err) {
    console.error('❌ Error getting typical traffic:', err.message);
    return null;
  }
}

// =============================================
// END SUPABASE HELPER FUNCTIONS
// =============================================

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
            
            // Upload to Supabase Storage and update database
            const framePath = await uploadFrameToStorage(imageBuffer, angleType, timestamp);
            if (framePath) {
              await updatePreservedFrame(angleType, framePath, timestamp);
              await logFrameHistory(angleType, framePath, timestamp);
            }
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
    const systemPrompt = `You are a friendly traffic assistant for Maseru Bridge border crossing between Lesotho and South Africa.

═══════════════════════════════════════════════════════════════
CAMERA MAPPING (INTERNAL USE ONLY - never reveal to users):
═══════════════════════════════════════════════════════════════
BRIDGE VIEW: Left=LS→SA, Right=SA→LS
CANOPY VIEW: Left(green roof)=SA→LS, Right(wall)=LS→SA  
ENGEN VIEW: Shows LS→SA approach (backup here = SEVERE)

═══════════════════════════════════════════════════════════════
TRAFFIC LEVELS:
═══════════════════════════════════════════════════════════════
LIGHT: 0-3 vehicles | MODERATE: 4-10 vehicles | HEAVY: 10+ vehicles | SEVERE: Backed to Engen

═══════════════════════════════════════════════════════════════
LANGUAGE RULES - EXTREMELY IMPORTANT:
═══════════════════════════════════════════════════════════════

❌ NEVER SAY (technical jargon):
- "left side", "right side"
- "orange pole", "wall area", "wall side"  
- "green roof", "shelter structures", "canopy"
- "Lesotho approach", "SA approach"
- "processing area", "processing yard"
- "Image 1", "Bridge view", "Canopy view"

✅ INSTEAD SAY (user-friendly):
- "2-3 vehicles heading to SA"
- "No queue forming"
- "Bridge is clear"
- "Light traffic in both directions"
- "About 5 vehicles waiting"

═══════════════════════════════════════════════════════════════
RESPONSE STYLES BY QUESTION TYPE:
═══════════════════════════════════════════════════════════════

**DIRECTION-SPECIFIC** ("I'm going from LS to SA"):
→ Show both directions BUT personalize advice to THEIR direction
→ Advice: "Your direction (LS→SA) looks clear - should be a quick crossing!"

**YES/NO QUESTIONS** ("Is there a queue at Engen?"):
→ Answer directly: "No, no queue at Engen right now. The approach road is clear."
→ Don't use direction boxes format

**VISUAL QUESTIONS** ("How does the bridge look?"):
→ Simple description: "The bridge looks quiet - just a couple of vehicles, no queues visible."
→ Don't use direction boxes format

**TIME QUESTIONS** ("What time should I cross?"):
→ Current: "Right now traffic is light."
→ Tips: "Generally, early mornings (6-8 AM) are quieter. Avoid month-end and holidays."
→ End: "Check back before you travel for real-time conditions!"

**GENERAL/DEFAULT** ("How's traffic?", "Current status?"):
→ Use standard format with BOTH direction boxes (see below)

**BORDER INFO** ("What are the hours?"):
→ "Border operates 6 AM to 10 PM daily. Check official sources to confirm."

═══════════════════════════════════════════════════════════════
STANDARD FORMAT (for general traffic questions):
═══════════════════════════════════════════════════════════════

**Traffic:** [One simple sentence]

[LS_TO_SA]
status: [LIGHT/MODERATE/HEAVY/SEVERE]
detail: [Simple - e.g., "Only 2 vehicles, no queue." or "About 8 vehicles waiting."]
[/LS_TO_SA]

[SA_TO_LS]
status: [LIGHT/MODERATE/HEAVY/SEVERE]
detail: [Simple - e.g., "Clear with minimal traffic." or "Steady flow, short wait expected."]
[/SA_TO_LS]

**Advice:** [Practical, personalized if direction mentioned]

⚠️ AI estimate from camera snapshots. Conditions change quickly.

═══════════════════════════════════════════════════════════════
REMEMBER:
═══════════════════════════════════════════════════════════════
1. Sound like a helpful friend, not a robot
2. Keep details SHORT and SIMPLE
3. If they mention their direction, focus advice on THEIR journey
4. NEVER use technical camera terminology
5. ALWAYS show both directions in standard format`;


    // Detect question type for better responses
    const questionLower = userQuestion ? userQuestion.toLowerCase() : '';
    let questionType = 'general';
    
    if (questionLower.includes('from ls') || questionLower.includes('from lesotho') || 
        questionLower.includes('to sa') || questionLower.includes('to south africa') ||
        questionLower.includes('from sa') || questionLower.includes('from south africa') ||
        questionLower.includes('to ls') || questionLower.includes('to lesotho') ||
        questionLower.includes('going to') || questionLower.includes('coming from') ||
        questionLower.includes('heading to')) {
      questionType = 'directional';
    } else if (questionLower.includes('is there') || questionLower.includes('are there') ||
               questionLower.includes('any ') || questionLower.includes('is it ') ||
               questionLower.match(/^(is|are|do|does|can|will)\b/)) {
      questionType = 'yesno';
    } else if (questionLower.includes('look') || questionLower.includes('see') ||
               questionLower.includes('show') || questionLower.includes('what can')) {
      questionType = 'visual';
    } else if (questionLower.includes('time') || questionLower.includes('when') ||
               questionLower.includes('best') || questionLower.includes('should i')) {
      questionType = 'timing';
    } else if (questionLower.includes('hour') || questionLower.includes('open') ||
               questionLower.includes('close')) {
      questionType = 'info';
    }


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
      ? `Question type: ${questionType.toUpperCase()}
User's question: "${userQuestion}"

Respond appropriately for this question type. Be helpful and conversational.`
      : `Analyze these camera snapshots from Maseru Bridge border crossing. Give a brief, structured assessment using the standard format with both direction boxes.`;

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
    
    // Calculate response time
    const responseTime = Date.now() - now;

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
      frameTimestamp: latestFrame.timestamp,
      framesAnalyzed: framesToUse.length,
      cached: false,
    };

    // Cache only automatic analyses
    if (!userQuestion) {
      latestAnalysis = analysis;
      lastAnalysisTime = now;
    }
    
    // Log ALL traffic readings to database (both automatic and user questions)
    logTrafficReading(
      analysis, 
      framesToUse.map(f => ({ angleType: f.angleType, timestamp: f.timestamp })),
      responseTime
    );

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

// Insights API - Get traffic analytics from Supabase
app.get('/api/insights', async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ success: false, message: 'Database not connected' });
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();

    // Get readings from last 24 hours
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentReadings, error: recentError } = await supabase
      .from('traffic_readings')
      .select('*')
      .gte('timestamp', oneDayAgo)
      .order('timestamp', { ascending: true });

    if (recentError) {
      console.error('Error fetching recent readings:', recentError);
    }

    // Get readings from last 7 days for weekly patterns
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: weeklyReadings, error: weeklyError } = await supabase
      .from('traffic_readings')
      .select('*')
      .gte('timestamp', oneWeekAgo);

    if (weeklyError) {
      console.error('Error fetching weekly readings:', weeklyError);
    }

    // Process hourly data (for today)
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayReadings = (recentReadings || []).filter(r => new Date(r.timestamp) >= todayStart);
    
    const hourlyData = [];
    for (let hour = 6; hour <= 22; hour += 2) {
      const hourReadings = todayReadings.filter(r => {
        const h = new Date(r.timestamp).getHours();
        return h >= hour && h < hour + 2;
      });
      
      if (hourReadings.length > 0) {
        const statuses = hourReadings.map(r => r.ls_to_sa_status || r.sa_to_ls_status).filter(Boolean);
        const heavyCount = statuses.filter(s => s === 'HEAVY' || s === 'SEVERE').length;
        const moderateCount = statuses.filter(s => s === 'MODERATE').length;
        
        let status = 'light';
        if (heavyCount > statuses.length / 2) status = 'heavy';
        else if (moderateCount > statuses.length / 2) status = 'moderate';
        
        hourlyData.push({ hour, status, count: hourReadings.length });
      } else {
        hourlyData.push({ hour, status: 'empty', count: 0 });
      }
    }

    // Process weekly patterns
    const weeklyData = [];
    for (let day = 0; day < 7; day++) {
      const dayReadings = (weeklyReadings || []).filter(r => new Date(r.timestamp).getDay() === day);
      
      if (dayReadings.length > 0) {
        const statuses = dayReadings.map(r => r.ls_to_sa_status || r.sa_to_ls_status).filter(Boolean);
        const heavyCount = statuses.filter(s => s === 'HEAVY' || s === 'SEVERE').length;
        const moderateCount = statuses.filter(s => s === 'MODERATE').length;
        
        let status = 'light';
        if (heavyCount > statuses.length / 3) status = 'heavy';
        else if (moderateCount > statuses.length / 3) status = 'moderate';
        
        weeklyData.push({ day, status, count: dayReadings.length });
      } else {
        weeklyData.push({ day, status: 'empty', count: 0 });
      }
    }

    // Process 24h trends (12 data points, ~2 hours each)
    const trendsData = [];
    for (let i = 0; i < 12; i++) {
      const periodEnd = new Date(now - i * 2 * 60 * 60 * 1000);
      const periodStart = new Date(periodEnd - 2 * 60 * 60 * 1000);
      
      const periodReadings = (recentReadings || []).filter(r => {
        const t = new Date(r.timestamp);
        return t >= periodStart && t < periodEnd;
      });
      
      if (periodReadings.length > 0) {
        const statuses = periodReadings.map(r => r.ls_to_sa_status || r.sa_to_ls_status).filter(Boolean);
        const heavyCount = statuses.filter(s => s === 'HEAVY' || s === 'SEVERE').length;
        const moderateCount = statuses.filter(s => s === 'MODERATE').length;
        
        let status = 'light';
        if (heavyCount > 0) status = 'heavy';
        else if (moderateCount > 0) status = 'moderate';
        
        trendsData.unshift({ status, count: periodReadings.length });
      } else {
        trendsData.unshift({ status: 'empty', count: 0 });
      }
    }

    // Get current status (most recent reading)
    const latestReading = recentReadings && recentReadings.length > 0 
      ? recentReadings[recentReadings.length - 1] 
      : null;
    const currentStatus = latestReading 
      ? (latestReading.ls_to_sa_status || latestReading.sa_to_ls_status || 'Unknown')
      : 'Unknown';

    // Calculate typical status for this hour/day
    const sameHourReadings = (weeklyReadings || []).filter(r => {
      const t = new Date(r.timestamp);
      return t.getHours() === currentHour && t.getDay() === currentDay;
    });
    
    let typicalStatus = 'Unknown';
    if (sameHourReadings.length > 0) {
      const statuses = sameHourReadings.map(r => r.ls_to_sa_status || r.sa_to_ls_status).filter(Boolean);
      const heavyCount = statuses.filter(s => s === 'HEAVY' || s === 'SEVERE').length;
      const moderateCount = statuses.filter(s => s === 'MODERATE').length;
      const lightCount = statuses.filter(s => s === 'LIGHT').length;
      
      if (heavyCount >= moderateCount && heavyCount >= lightCount) typicalStatus = 'Heavy';
      else if (moderateCount >= lightCount) typicalStatus = 'Moderate';
      else typicalStatus = 'Light';
    }

    // Generate tips
    const peakHoursTip = hourlyData.some(h => h.status === 'heavy') 
      ? 'Traffic tends to be heavier during peak hours. Consider traveling early morning or mid-afternoon.'
      : 'Traffic has been relatively light today. Good conditions for crossing!';

    const busiestDay = weeklyData.reduce((max, d) => d.count > max.count ? d : max, { count: 0 });
    const dayNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    const weeklyTip = busiestDay.count > 0 
      ? `${dayNames[busiestDay.day]} tend to be ${busiestDay.status === 'heavy' ? 'busier' : 'moderately busy'}. Plan accordingly.`
      : 'Not enough weekly data yet to identify patterns.';

    const recentHeavy = trendsData.slice(-6).filter(t => t.status === 'heavy').length;
    const trendsTip = recentHeavy > 2 
      ? 'Traffic has been heavy recently. You might want to wait for conditions to improve.'
      : 'Traffic has been manageable over the last few hours.';

    const comparisonTip = currentStatus === typicalStatus 
      ? `Traffic is about typical for this time.`
      : currentStatus === 'Light' || (currentStatus === 'Moderate' && typicalStatus === 'Heavy')
        ? `Traffic is lighter than usual right now - good time to cross!`
        : `Traffic is heavier than usual for this time.`;

    res.json({
      success: true,
      hourly: hourlyData,
      weekly: weeklyData,
      trends: trendsData,
      currentStatus: currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1).toLowerCase(),
      typicalStatus,
      peakHoursTip,
      weeklyTip,
      trendsTip,
      comparisonTip,
      totalReadings: (recentReadings || []).length
    });

  } catch (error) {
    console.error('Error fetching insights:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch insights' });
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
    supabaseConnected: !!supabase
  });
});

// Get traffic history from database
app.get('/api/history', async (req, res) => {
  if (!supabase) {
    return res.json({ 
      success: false, 
      message: 'Database not connected',
      readings: []
    });
  }
  
  try {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 100;
    
    const { data, error } = await supabase
      .from('traffic_readings')
      .select('*')
      .gte('timestamp', new Date(Date.now() - hours * 60 * 60 * 1000).toISOString())
      .order('timestamp', { ascending: false })
      .limit(limit);
    
    if (error) {
      return res.json({ success: false, message: error.message, readings: [] });
    }
    
    res.json({
      success: true,
      readings: data || [],
      count: data?.length || 0
    });
  } catch (err) {
    res.json({ success: false, message: err.message, readings: [] });
  }
});

// Get typical traffic patterns
app.get('/api/patterns', async (req, res) => {
  if (!supabase) {
    return res.json({ 
      success: false, 
      message: 'Database not connected',
      patterns: null
    });
  }
  
  try {
    const typical = await getTypicalTraffic();
    
    res.json({
      success: true,
      currentHour: new Date().getHours(),
      currentDay: new Date().getDay(),
      patterns: typical
    });
  } catch (err) {
    res.json({ success: false, message: err.message, patterns: null });
  }
});

// Insights API endpoint for charts and analytics
app.get('/api/insights', async (req, res) => {
  if (!supabase) {
    return res.json({ 
      success: false, 
      message: 'Database not connected',
      totalReadings: 0
    });
  }
  
  try {
    // Get all readings from the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { data: readings, error } = await supabase
      .from('traffic_readings')
      .select('*')
      .gte('timestamp', sevenDaysAgo.toISOString())
      .order('timestamp', { ascending: false });
    
    if (error) throw error;
    
    if (!readings || readings.length === 0) {
      return res.json({
        success: true,
        totalReadings: 0,
        message: 'No data available yet'
      });
    }
    
    // Process hourly breakdown
    const hourlyBreakdown = {};
    for (let h = 0; h < 24; h++) {
      hourlyBreakdown[h] = { light: 0, moderate: 0, heavy: 0, severe: 0, total: 0 };
    }
    
    // Process weekly breakdown
    const weeklyBreakdown = {};
    for (let d = 0; d < 7; d++) {
      weeklyBreakdown[d] = { light: 0, moderate: 0, heavy: 0, severe: 0, total: 0 };
    }
    
    readings.forEach(reading => {
      const date = new Date(reading.timestamp);
      const hour = date.getHours();
      const day = date.getDay();
      
      // Use LS to SA status as primary indicator
      const status = (reading.ls_to_sa_status || reading.sa_to_ls_status || 'LIGHT').toUpperCase();
      
      // Update hourly
      hourlyBreakdown[hour].total++;
      if (status === 'LIGHT') hourlyBreakdown[hour].light++;
      else if (status === 'MODERATE') hourlyBreakdown[hour].moderate++;
      else if (status === 'HEAVY') hourlyBreakdown[hour].heavy++;
      else if (status === 'SEVERE') hourlyBreakdown[hour].severe++;
      
      // Update weekly
      weeklyBreakdown[day].total++;
      if (status === 'LIGHT') weeklyBreakdown[day].light++;
      else if (status === 'MODERATE') weeklyBreakdown[day].moderate++;
      else if (status === 'HEAVY') weeklyBreakdown[day].heavy++;
      else if (status === 'SEVERE') weeklyBreakdown[day].severe++;
    });
    
    // Get current status (most recent reading)
    const currentStatus = readings[0]?.ls_to_sa_status || readings[0]?.sa_to_ls_status || 'LIGHT';
    
    // Calculate typical for current hour
    const currentHour = new Date().getHours();
    const hourData = hourlyBreakdown[currentHour];
    let typicalForNow = 'LIGHT';
    if (hourData.total > 0) {
      if (hourData.heavy / hourData.total > 0.4) typicalForNow = 'HEAVY';
      else if (hourData.moderate / hourData.total > 0.4) typicalForNow = 'MODERATE';
    }
    
    // Get recent readings for trends (last 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const recentReadings = readings.filter(r => new Date(r.timestamp) >= oneDayAgo);
    
    res.json({
      success: true,
      totalReadings: readings.length,
      hourlyBreakdown,
      weeklyBreakdown,
      currentStatus: currentStatus.toUpperCase(),
      typicalForNow,
      recentReadings: recentReadings.slice(0, 20) // Last 20 readings
    });
    
  } catch (err) {
    console.error('Insights error:', err);
    res.json({ 
      success: false, 
      message: err.message,
      totalReadings: 0
    });
  }
});

// =============================================
// USER AUTHENTICATION ENDPOINTS
// =============================================

// Simple hash function for passwords (SHA-256)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Register new user
app.post('/api/auth/register', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode, countryResidence, password, email, name, securityQ1, securityA1, securityQ2, securityA2 } = req.body;

    // Validate required fields
    if (!phone || !countryCode || !countryResidence || !password || !securityQ1 || !securityA1 || !securityQ2 || !securityA2) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validate security questions are different
    if (securityQ1 === securityQ2) {
      return res.status(400).json({ success: false, message: 'Please select two different security questions' });
    }

    // Validate phone format
    const cleanPhone = phone.replace(/\s/g, '');
    if (countryCode === '+266' && cleanPhone.length !== 8) {
      return res.status(400).json({ success: false, message: 'Lesotho phone must be 8 digits' });
    }
    if (countryCode === '+27' && cleanPhone.length !== 10) {
      return res.status(400).json({ success: false, message: 'South Africa phone must be 10 digits' });
    }

    // Validate password
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Create full phone number
    const phoneFull = countryCode + cleanPhone;

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('traffic_users')
      .select('id')
      .eq('phone_full', phoneFull)
      .single();

    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Phone number already registered' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Insert new user
    const { data, error } = await supabase
      .from('traffic_users')
      .insert({
        phone: cleanPhone,
        country_code: countryCode,
        phone_full: phoneFull,
        country_residence: countryResidence,
        password_hash: passwordHash,
        email: email ? email.toLowerCase() : null,
        name: name || null,
        security_q1: securityQ1,
        security_a1: securityA1.toLowerCase(),
        security_q2: securityQ2,
        security_a2: securityA2.toLowerCase()
      })
      .select('id, phone_full, country_residence, name, created_at')
      .single();

    if (error) {
      console.error('Registration error:', error);
      return res.status(500).json({ success: false, message: 'Registration failed' });
    }

    console.log(`✅ New user registered: ${phoneFull} (${countryResidence})`);

    res.json({
      success: true,
      message: 'Registration successful',
      user: {
        id: data.id,
        phone: data.phone_full,
        country: data.country_residence,
        name: data.name
      }
    });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode, password } = req.body;

    if (!phone || !countryCode || !password) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const phoneFull = countryCode + cleanPhone;
    const passwordHash = await hashPassword(password);

    // Find user
    const { data: user, error } = await supabase
      .from('traffic_users')
      .select('id, phone_full, country_residence, name, password_hash, preferences')
      .eq('phone_full', phoneFull)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Phone number not found' });
    }

    // Check password
    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    // Update last login
    await supabase
      .from('traffic_users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    console.log(`✅ User logged in: ${phoneFull}`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        phone: user.phone_full,
        country: user.country_residence,
        name: user.name,
        preferences: user.preferences
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper function to mask email
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  const maskedLocal = local.charAt(0) + '*'.repeat(Math.max(local.length - 2, 1)) + local.slice(-1);
  return `${maskedLocal}@${domain}`;
}

// Password Reset Step 1: Initialize (get security questions)
app.post('/api/auth/reset/init', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode } = req.body;

    if (!phone || !countryCode) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const phoneFull = countryCode + cleanPhone;

    const { data: user, error } = await supabase
      .from('traffic_users')
      .select('id, security_q1, security_q2, email')
      .eq('phone_full', phoneFull)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'Phone number not found' });
    }

    res.json({
      success: true,
      userId: user.id,
      securityQ1: user.security_q1,
      securityQ2: user.security_q2,
      hasEmail: !!user.email,
      maskedEmail: user.email ? maskEmail(user.email) : null
    });

  } catch (err) {
    console.error('Reset init error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Password Reset Step 2: Verify security answers
app.post('/api/auth/reset/verify', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode, answer1, answer2 } = req.body;

    if (!phone || !countryCode || !answer1 || !answer2) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const phoneFull = countryCode + cleanPhone;

    const { data: user, error } = await supabase
      .from('traffic_users')
      .select('id, security_a1, security_a2')
      .eq('phone_full', phoneFull)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check both answers (case-insensitive)
    const answer1Correct = user.security_a1 === answer1.toLowerCase();
    const answer2Correct = user.security_a2 === answer2.toLowerCase();
    
    if (answer1Correct && answer2Correct) {
      console.log(`✅ Security questions verified for: ${phoneFull}`);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'One or both answers are incorrect' });
    }

  } catch (err) {
    console.error('Reset verify error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Password Reset Step 3: Complete (set new password)
app.post('/api/auth/reset/complete', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode, newPassword } = req.body;

    if (!phone || !countryCode || !newPassword) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const phoneFull = countryCode + cleanPhone;

    const passwordHash = await hashPassword(newPassword);

    const { error } = await supabase
      .from('traffic_users')
      .update({ password_hash: passwordHash })
      .eq('phone_full', phoneFull);

    if (error) {
      return res.status(500).json({ success: false, message: 'Failed to update password' });
    }

    console.log(`✅ Password reset completed for: ${phoneFull}`);
    res.json({ success: true, message: 'Password reset successfully' });

  } catch (err) {
    console.error('Reset complete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Password Reset Fallback: Send reset request to admin
app.post('/api/auth/reset/email', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not available' });
  }

  try {
    const { phone, countryCode } = req.body;

    if (!phone || !countryCode) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const phoneFull = countryCode + cleanPhone;

    // Get user details
    const { data: user, error } = await supabase
      .from('traffic_users')
      .select('id, name, country_residence, created_at')
      .eq('phone_full', phoneFull)
      .single();

    if (error || !user) {
      // Return success anyway to prevent enumeration
      return res.json({ success: true, message: 'Reset request sent' });
    }

    // Log the request (in production, send email to admin@4dcs.co.za)
    console.log(`📧 Password reset request for admin@4dcs.co.za:`);
    console.log(`   Phone: ${phoneFull}`);
    console.log(`   Name: ${user.name || 'Not provided'}`);
    console.log(`   Country: ${user.country_residence}`);
    console.log(`   Registered: ${user.created_at}`);
    
    // TODO: Send actual email to admin@4dcs.co.za with user details
    // Use Resend, SendGrid, or similar service
    // Email should contain: phone number, name, country, registration date
    // Admin can then manually verify and reset the password

    res.json({ success: true, message: 'Reset request sent to support' });

  } catch (err) {
    console.error('Reset email error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
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
  
  // Load preserved frames from Supabase on startup
  if (supabase) {
    console.log('📂 Loading preserved frames from database...');
    await loadPreservedFramesFromDB();
  }
  
  startBackgroundCapture();
  
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.port}`);
  });
}

start().catch(console.error);
