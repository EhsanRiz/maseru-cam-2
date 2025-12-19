import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import compression from 'compression';
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
  captureInterval: 90000,        // Capture every 90 seconds (was 3 min) to catch more angles
  cacheTimeout: 120000,          // Cache analysis for 2 minutes
  maxBufferSize: 20,             // Keep last 20 frames (more history)
  analysisFrames: 3,             // Use 3 frames for analysis
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  detectorUrl: process.env.DETECTOR_URL || 'https://traffic-detector-jzbg.onrender.com',
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

// =============================================
// VEHICLE DETECTOR SERVICE (YOLO + Geometry)
// =============================================
// Calls external Python service for deterministic lane-based detection
// Direction is computed by geometry, NOT language inference

async function detectVehicles(imageBase64, cameraView = 'bridge') {
  try {
    const response = await fetch(`${config.detectorUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageBase64,
        camera_view: cameraView
      }),
      timeout: 30000
    });
    
    if (!response.ok) {
      console.error(`❌ Detector service error: ${response.status}`);
      return null;
    }
    
    const result = await response.json();
    console.log(`🎯 Detector: SA→LS: ${result.SA_to_LS}, LS→SA: ${result.LS_to_SA}, Total: ${result.total}`);
    return result;
  } catch (error) {
    console.error('❌ Detector service failed:', error.message);
    return null;
  }
}

// Map camera view to angle type
const ANGLE_TO_VIEW = {
  'bridge': 'bridge',
  'processing': 'canopy',
  'wide': 'engen'
};

// =============================================
// TRAFFIC HISTORY TRACKER (Time-Series Analysis)
// =============================================
// Tracks vehicle counts over time to detect flow speed and trends
const trafficHistory = {
  readings: [],           // Array of { timestamp, bridgeCounts, canopyCounts }
  MAX_HISTORY: 10,        // Keep last 10 readings (~10-15 minutes)
  TREND_WINDOW: 5,        // Use last 5 readings for trend calculation
  
  // Add a new reading
  addReading(bridgeCounts, canopyCounts = null) {
    const reading = {
      timestamp: Date.now(),
      bridge: bridgeCounts ? {
        lsToSa: bridgeCounts.LS_to_SA || 0,
        saToLs: bridgeCounts.SA_to_LS || 0,
        total: bridgeCounts.total || 0
      } : null,
      canopy: canopyCounts ? {
        saToLsQueue: canopyCounts.SA_to_LS_queue || 0,
        lsToSaArea: canopyCounts.LS_to_SA_area || 0,
        total: canopyCounts.total || 0
      } : null
    };
    
    this.readings.push(reading);
    
    // Keep only recent readings
    if (this.readings.length > this.MAX_HISTORY) {
      this.readings = this.readings.slice(-this.MAX_HISTORY);
    }
    
    console.log(`📈 Traffic history: ${this.readings.length} readings`);
  },
  
  // Analyze trends over recent readings
  analyzeTrends() {
    if (this.readings.length < 2) {
      return { trend: 'unknown', confidence: 'low', message: 'Not enough data yet' };
    }
    
    const recentReadings = this.readings.slice(-this.TREND_WINDOW);
    const oldestReading = recentReadings[0];
    const newestReading = recentReadings[recentReadings.length - 1];
    const timeDiffMinutes = (newestReading.timestamp - oldestReading.timestamp) / 60000;
    
    // Calculate changes in bridge counts
    let trendInfo = {
      lsToSa: { trend: 'stable', change: 0 },
      saToLs: { trend: 'stable', change: 0 },
      overall: 'stable',
      flowSpeed: 'normal',
      confidence: this.readings.length >= 5 ? 'high' : 'medium',
      timePeriod: Math.round(timeDiffMinutes)
    };
    
    if (oldestReading.bridge && newestReading.bridge) {
      // LS→SA trend
      const lsToSaChange = newestReading.bridge.lsToSa - oldestReading.bridge.lsToSa;
      trendInfo.lsToSa.change = lsToSaChange;
      if (lsToSaChange > 2) trendInfo.lsToSa.trend = 'increasing';
      else if (lsToSaChange < -2) trendInfo.lsToSa.trend = 'decreasing';
      
      // SA→LS trend
      const saToLsChange = newestReading.bridge.saToLs - oldestReading.bridge.saToLs;
      trendInfo.saToLs.change = saToLsChange;
      if (saToLsChange > 2) trendInfo.saToLs.trend = 'increasing';
      else if (saToLsChange < -2) trendInfo.saToLs.trend = 'decreasing';
      
      // Overall trend
      const totalChange = lsToSaChange + saToLsChange;
      if (totalChange > 3) trendInfo.overall = 'building_up';
      else if (totalChange < -3) trendInfo.overall = 'clearing';
      
      // Flow speed estimation
      // If counts are consistently high, traffic is slow/stuck
      // If counts fluctuate, traffic is moving
      const avgTotal = recentReadings.reduce((sum, r) => sum + (r.bridge?.total || 0), 0) / recentReadings.length;
      const variance = recentReadings.reduce((sum, r) => {
        const diff = (r.bridge?.total || 0) - avgTotal;
        return sum + (diff * diff);
      }, 0) / recentReadings.length;
      
      if (avgTotal > 10 && variance < 2) {
        trendInfo.flowSpeed = 'slow';
      } else if (avgTotal > 15 && variance < 3) {
        trendInfo.flowSpeed = 'very_slow';
      } else if (variance > 5) {
        trendInfo.flowSpeed = 'moving_well';
      }
    }
    
    return trendInfo;
  },
  
  // Get human-readable trend summary
  getTrendSummary() {
    const trends = this.analyzeTrends();
    
    if (trends.trend === 'unknown') {
      return '';
    }
    
    let summary = [];
    
    // Flow speed
    if (trends.flowSpeed === 'slow') {
      summary.push('Traffic appears to be moving slowly');
    } else if (trends.flowSpeed === 'very_slow') {
      summary.push('Traffic appears stuck or very slow');
    } else if (trends.flowSpeed === 'moving_well') {
      summary.push('Traffic is flowing steadily');
    }
    
    // Direction-specific trends
    if (trends.lsToSa.trend === 'increasing') {
      summary.push('LS→SA queue is building up');
    } else if (trends.lsToSa.trend === 'decreasing') {
      summary.push('LS→SA queue is clearing');
    }
    
    if (trends.saToLs.trend === 'increasing') {
      summary.push('SA→LS queue is building up');
    } else if (trends.saToLs.trend === 'decreasing') {
      summary.push('SA→LS queue is clearing');
    }
    
    // Overall
    if (trends.overall === 'building_up' && summary.length === 0) {
      summary.push('Traffic is building up overall');
    } else if (trends.overall === 'clearing' && summary.length === 0) {
      summary.push('Traffic is clearing overall');
    }
    
    if (summary.length > 0 && trends.confidence === 'high') {
      return summary.join('. ') + ` (based on last ${trends.timePeriod} minutes)`;
    } else if (summary.length > 0) {
      return summary.join('. ');
    }
    
    return '';
  }
};

// Buffer to store multiple screenshots with timestamps and angle classification
let screenshotBuffer = [];
let latestAnalysis = null;
let lastAnalysisTime = 0;
let isCapturing = false;
let isClassifying = false;

// =============================================
// CAMERA STATUS TRACKING
// =============================================
// Detects: camera down, stuck on one angle
const cameraStatus = {
  consecutiveFailures: 0,
  angleHistory: [],              // Last N classifications
  lastSuccessfulCapture: null,
  status: 'operational',         // 'operational', 'stuck_on_angle', 'down'
  stuckAngle: null,
  
  // Thresholds
  FAILURE_THRESHOLD: 3,          // 3 failures = camera down
  STUCK_THRESHOLD: 10,           // 10 same angles in a row = stuck
  HISTORY_SIZE: 15,              // Track last 15 classifications
};

function updateCameraStatus() {
  // Check for camera down
  if (cameraStatus.consecutiveFailures >= cameraStatus.FAILURE_THRESHOLD) {
    cameraStatus.status = 'down';
    cameraStatus.stuckAngle = null;
    console.log('🔴 Camera status: DOWN');
    return;
  }
  
  // Check for stuck angle (only if we have enough history)
  if (cameraStatus.angleHistory.length >= cameraStatus.STUCK_THRESHOLD) {
    const recentAngles = cameraStatus.angleHistory.slice(-cameraStatus.STUCK_THRESHOLD);
    const uniqueAngles = [...new Set(recentAngles.filter(a => a !== 'useless'))];
    
    if (uniqueAngles.length === 1) {
      cameraStatus.status = 'stuck_on_angle';
      cameraStatus.stuckAngle = uniqueAngles[0];
      console.log(`📷 Camera status: STUCK on ${cameraStatus.stuckAngle}`);
      return;
    }
  }
  
  // Otherwise operational
  cameraStatus.status = 'operational';
  cameraStatus.stuckAngle = null;
}

function recordCaptureSuccess(angleType) {
  cameraStatus.consecutiveFailures = 0;
  cameraStatus.lastSuccessfulCapture = Date.now();
  
  // Add to angle history (skip useless frames for stuck detection)
  cameraStatus.angleHistory.push(angleType);
  if (cameraStatus.angleHistory.length > cameraStatus.HISTORY_SIZE) {
    cameraStatus.angleHistory.shift();
  }
  
  updateCameraStatus();
}

function recordCaptureFailure() {
  cameraStatus.consecutiveFailures++;
  console.log(`⚠️ Capture failure #${cameraStatus.consecutiveFailures}`);
  updateCameraStatus();
}

function getCameraStatusInfo() {
  const info = {
    status: cameraStatus.status,
    stuckAngle: cameraStatus.stuckAngle,
    lastSuccessfulCapture: cameraStatus.lastSuccessfulCapture,
    consecutiveFailures: cameraStatus.consecutiveFailures,
  };
  
  // Generate user-friendly message
  if (cameraStatus.status === 'down') {
    const downTime = cameraStatus.lastSuccessfulCapture 
      ? Math.round((Date.now() - cameraStatus.lastSuccessfulCapture) / 60000)
      : null;
    info.message = `🔴 Camera feed unavailable${downTime ? ` for ${downTime} minutes` : ''}. Please check back later or contact border control for current conditions.`;
  } else if (cameraStatus.status === 'stuck_on_angle') {
    const angleNames = {
      'bridge': 'bridge view',
      'processing': 'processing area',
      'wide': 'wide/Engen view'
    };
    const angleName = angleNames[cameraStatus.stuckAngle] || cameraStatus.stuckAngle;
    info.message = `📷 Camera currently showing ${angleName} only. Other areas may not be visible.`;
  } else {
    info.message = null; // No alert needed
  }
  
  return info;
}

// Maximum age for frames to be considered valid (10 minutes)
const MAX_FRAME_AGE_MS = 10 * 60 * 1000;

// Helper function to check if a frame is still fresh
function isFrameFresh(frame) {
  if (!frame || !frame.timestamp) return false;
  const frameAge = Date.now() - new Date(frame.timestamp).getTime();
  return frameAge <= MAX_FRAME_AGE_MS;
}

// =============================================
// RESPONSE CACHE SYSTEM
// =============================================
// Cache common question responses to serve instantly
const responseCache = {
  status: null,      // "how's traffic", "current status"
  good_time: null,   // "good time to cross", "should I go"
  queue: null,       // "how long is the queue"
  ls_to_sa: null,    // "going from LS to SA"
  sa_to_ls: null,    // "coming from SA to LS"
};

const CACHE_TTL = 120000; // 2 minutes in milliseconds

// Categorize a question to determine cache key
function categorizeQuestion(question) {
  const q = question.toLowerCase().trim();
  
  // Direction-specific questions
  if (q.match(/from\s*(ls|lesotho)|to\s*(sa|south\s*africa)|ls\s*(to|→)/i) && 
      !q.match(/from\s*(sa|south\s*africa)/i)) {
    return 'ls_to_sa';
  }
  if (q.match(/from\s*(sa|south\s*africa)|to\s*(ls|lesotho)|sa\s*(to|→)/i) && 
      !q.match(/from\s*(ls|lesotho)/i)) {
    return 'sa_to_ls';
  }
  
  // Good time questions
  if (q.match(/good\s*time|should\s*i\s*(go|cross)|best\s*time|right\s*time|okay\s*to\s*cross|safe\s*to\s*cross/i)) {
    return 'good_time';
  }
  
  // Queue questions
  if (q.match(/queue|line|wait|waiting|backed|backup|long/i) && 
      !q.match(/how.*(traffic|busy|status)/i)) {
    return 'queue';
  }
  
  // General status questions (most common)
  if (q.match(/status|traffic|busy|current|now|right\s*now|at\s*the\s*moment|how.*(is|are)|what.*(is|like)/i)) {
    return 'status';
  }
  
  // No cache for off-topic or unique questions
  return null;
}

// Check if cached response is still valid
function getCachedResponse(category) {
  if (!category || !responseCache[category]) return null;
  
  const cached = responseCache[category];
  const age = Date.now() - cached.timestamp;
  
  if (age < CACHE_TTL) {
    console.log(`✅ Cache HIT for "${category}" (${Math.round(age/1000)}s old)`);
    return cached;
  }
  
  console.log(`⏰ Cache EXPIRED for "${category}" (${Math.round(age/1000)}s old)`);
  return null;
}

// Store response in cache
function cacheResponse(category, response, frameTimestamp) {
  if (!category) return;
  
  responseCache[category] = {
    response: response,
    frameTimestamp: frameTimestamp,
    timestamp: Date.now()
  };
  
  console.log(`💾 Cached response for "${category}"`);
}

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
    
    console.log(`📤 Uploading ${angleType} frame to Supabase...`);
    
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
    
    console.log(`✅ Uploaded ${angleType} frame to Supabase: ${fileName}`);
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

// =============================================
// BLUR DETECTION
// =============================================
// Detect motion blur by checking image file size
// Blurry/motion-blur images compress much smaller than sharp images

function isImageBlurry(imageBuffer) {
  const sizeKB = imageBuffer.length / 1024;
  
  // Sharp 800px wide JPEGs from this camera are typically 50-120KB
  // Blurry/motion-blur frames are typically 20-35KB
  const BLUR_THRESHOLD_KB = 40;
  
  if (sizeKB < BLUR_THRESHOLD_KB) {
    console.log(`🌫️ Frame likely blurry (${sizeKB.toFixed(1)}KB < ${BLUR_THRESHOLD_KB}KB threshold) - SKIPPING`);
    return true;
  }
  
  return false;
}

// Classify frame angle using AI
async function classifyFrameAngle(imageBuffer) {
  if (isClassifying) return ANGLE_TYPES.USELESS;
  
  isClassifying = true;
  try {
    const imageBase64 = imageBuffer.toString('base64');
    
    // STEP 0: Check if this is USELESS (trees/vegetation) FIRST
    const uselessCheckResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: `Is this image MOSTLY showing TREES, BUSHES, GREEN VEGETATION, or HILLSIDE/MOUNTAIN with no road or vehicles visible?

Answer only YES or NO.`
          }
        ],
      }],
    });
    
    const uselessResult = uselessCheckResponse.content[0].text.trim().toUpperCase();
    console.log(`📷 USELESS check: ${uselessResult}`);
    
    if (uselessResult.includes('YES')) {
      console.log(`📷 Frame classified as: USELESS (vegetation)`);
      return ANGLE_TYPES.USELESS;
    }
    
    // STEP 1: Check if this is WIDE (Engen view) with a simple yes/no question
    const wideCheckResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: `Can you see a ROAD going FAR INTO THE DISTANCE with buildings/petrol station far away in the background?

Answer only YES or NO.`
          }
        ],
      }],
    });
    
    const wideResult = wideCheckResponse.content[0].text.trim().toUpperCase();
    console.log(`📷 WIDE check: ${wideResult}`);
    
    if (wideResult.includes('YES')) {
      console.log(`📷 Frame classified as: WIDE`);
      return ANGLE_TYPES.WIDE;
    }
    
    // STEP 2: If not USELESS or WIDE, classify between BRIDGE and PROCESSING
    const classifyResponse = await anthropic.messages.create({
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
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: `Classify this traffic camera image:

BRIDGE:
→ ORANGE/RED PILLAR visible on the right side
→ Bridge structure over a river
→ If YES → Answer: BRIDGE

PROCESSING:
→ GREEN METAL ROOF visible overhead
→ COVERED WALKWAY on the right side
→ Trucks/vehicles parked in the area
→ If YES → Answer: PROCESSING

If neither matches → Answer: USELESS

Answer with ONE word: BRIDGE, PROCESSING, or USELESS`
          }
        ],
      }],
    });
    
    const result = classifyResponse.content[0].text.trim().toUpperCase();
    console.log(`📷 Frame classified as: ${result}`);
    
    if (result.includes('BRIDGE')) return ANGLE_TYPES.BRIDGE;
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

// Compression with filter to skip SSE streams
app.use(compression({
  filter: (req, res) => {
    // Don't compress SSE streams
    if (req.path === '/api/chat/stream') {
      return false;
    }
    return compression.filter(req, res);
  }
}));

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
          
          // Check for motion blur BEFORE classification
          if (isImageBlurry(imageBuffer)) {
            // Skip blurry frames entirely - don't waste API call on classification
            console.log('⏭️ Skipping blurry frame');
            resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
            return;
          }
          
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
          
          // Record successful capture for camera status tracking
          recordCaptureSuccess(angleType);
          
          console.log(`✅ Frame captured (${angleType}), buffer: ${JSON.stringify(counts)}`);
          resolve(imageBuffer);
        } catch (err) {
          console.error('❌ Failed to read captured frame:', err.message);
          recordCaptureFailure();
          resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
        }
      } else {
        console.error(`❌ ffmpeg failed with code ${code}`);
        recordCaptureFailure();
        resolve(screenshotBuffer.length > 0 ? screenshotBuffer[screenshotBuffer.length - 1].screenshot : null);
      }
    });

    ffmpeg.on('error', (err) => {
      isCapturing = false;
      console.error('❌ ffmpeg error:', err.message);
      recordCaptureFailure();
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
      } else if (preservedFrames[angleType] && isFrameFresh(preservedFrames[angleType])) {
        // Use preserved frame as fallback ONLY if it's fresh
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

    // =============================================
    // STEP 1: Call YOLO detector for vehicle counts
    // =============================================
    // Direction is determined by GEOMETRY, not language inference
    let detectorCounts = null;
    let canopyDetectorCounts = null;
    
    // Find the bridge frame and call detector
    const bridgeFrame = framesToUse.find(f => f.angleType === ANGLE_TYPES.BRIDGE);
    if (bridgeFrame) {
      detectorCounts = await detectVehicles(
        bridgeFrame.screenshot.toString('base64'),
        'bridge'
      );
    }
    
    // Find the canopy/processing frame and call detector for SA→LS queue
    const canopyFrame = framesToUse.find(f => f.angleType === ANGLE_TYPES.PROCESSING);
    if (canopyFrame) {
      canopyDetectorCounts = await detectVehicles(
        canopyFrame.screenshot.toString('base64'),
        'canopy'
      );
      if (canopyDetectorCounts) {
        console.log(`🎯 Canopy Detector: SA→LS queue: ${canopyDetectorCounts.SA_to_LS || 0}, LS→SA area: ${canopyDetectorCounts.LS_to_SA || 0}`);
      }
    }
    
    // Add to traffic history for time-series analysis
    trafficHistory.addReading(detectorCounts, canopyDetectorCounts);
    
    // Get trend analysis
    const trendInfo = trafficHistory.analyzeTrends();
    const trendSummary = trafficHistory.getTrendSummary();
    
    // Determine traffic levels from detector counts
    let lsToSaStatus = 'LIGHT';
    let saToLsStatus = 'LIGHT';
    let lsToSaCount = 0;
    let saToLsCount = 0;
    let saToLsCanopyCount = 0;
    
    // Bridge counts
    if (detectorCounts && !detectorCounts.direction_uncertain) {
      lsToSaCount = detectorCounts.LS_to_SA;
      saToLsCount = detectorCounts.SA_to_LS;
    }
    
    // Add canopy counts for SA→LS (cars entering canopy)
    if (canopyDetectorCounts) {
      saToLsCanopyCount = canopyDetectorCounts.SA_to_LS || 0;
    }
    
    // Combined SA→LS count (bridge + canopy queue)
    const combinedSaToLs = saToLsCount + saToLsCanopyCount;
    
    if (detectorCounts && !detectorCounts.direction_uncertain) {
      // Determine status levels
      if (lsToSaCount <= 3) lsToSaStatus = 'LIGHT';
      else if (lsToSaCount <= 8) lsToSaStatus = 'MODERATE';
      else lsToSaStatus = 'HEAVY';
      
      // SA→LS uses COMBINED count (bridge + canopy)
      if (combinedSaToLs <= 3) saToLsStatus = 'LIGHT';
      else if (combinedSaToLs <= 8) saToLsStatus = 'MODERATE';
      else saToLsStatus = 'HEAVY';
      
      console.log(`📊 Traffic levels - LS→SA: ${lsToSaStatus} (${lsToSaCount}), SA→LS: ${saToLsStatus} (bridge: ${saToLsCount}, canopy: ${saToLsCanopyCount}, combined: ${combinedSaToLs})`);
      
      if (trendSummary) {
        console.log(`📈 Trend: ${trendSummary}`);
      }
    } else if (detectorCounts?.direction_uncertain) {
      console.log(`⚠️ Direction uncertain - too many unassigned vehicles`);
    }

    // =============================================
    // STEP 2: Build prompt with KNOWN counts
    // =============================================
    // Claude generates friendly text - it does NOT infer direction
    
    // Extract breakdown if available
    const breakdown = detectorCounts?.breakdown || {};
    const lsToSaBreakdown = breakdown.LS_to_SA || { cars: 0, trucks: 0, buses: 0 };
    const saToLsBreakdown = breakdown.SA_to_LS || { cars: 0, trucks: 0, buses: 0 };
    
    // Build trend info string
    const trendInfoString = trendSummary ? `
📈 TRAFFIC TREND (based on recent history):
${trendSummary}
` : '';
    
    const countsInfo = detectorCounts && !detectorCounts.direction_uncertain
      ? `
VEHICLE COUNTS (automated detection):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• LS→SA (Lesotho to South Africa): ${lsToSaCount} vehicles on bridge
  Breakdown: ${lsToSaBreakdown.cars} cars, ${lsToSaBreakdown.trucks} trucks, ${lsToSaBreakdown.buses} buses
  Status: ${lsToSaStatus}
  
• SA→LS (South Africa to Lesotho): COMBINED COUNT
  - Bridge: ${saToLsCount} vehicles
  - Canopy queue: ${saToLsCanopyCount} vehicles entering/waiting
  - TOTAL: ${combinedSaToLs} vehicles
  Breakdown: ${saToLsBreakdown.cars} cars, ${saToLsBreakdown.trucks} trucks, ${saToLsBreakdown.buses} buses
  Status: ${saToLsStatus}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${trendInfoString}
⚠️ IMPORTANT: The SA→LS count now COMBINES bridge + canopy vehicles.
Use these counts as your primary source. Also visually verify with the camera views.

🔺 UPGRADE RULES:
- If canopy shows cars in 2 ROWS = HEAVY for SA→LS
- If Engen/approach road is backed up = SEVERE for SA→LS
- NOTE: Stationary trucks do NOT cause delays - they process elsewhere
`
      : `
⚠️ Automated vehicle detection unavailable. Use your visual assessment of ALL camera views.
Check the bridge, processing/canopy area, and approach road for queues.
`;

    // Also add visual assessment reminder
    const visualAssessmentReminder = `
═══════════════════════════════════════════════════════════════
MASERU BORDER TRAFFIC FLOW GUIDE
═══════════════════════════════════════════════════════════════
Understanding the camera views and traffic flow:

📷 BRIDGE VIEW:
   • LS→SA traffic: Uses the lane AWAY from the orange pillar (far side)
   • SA→LS traffic: Uses the lane NEAR the orange pillar
   • Count vehicles in each lane to assess directional traffic

📷 CANOPY/PROCESSING VIEW:
   • SA→LS TRAFFIC: Cars ENTERING the canopy area, queue in 1 row normally,
     2 rows when traffic is heavy. Look for cars lined up coming INTO the shelter.
   • LS→SA TRAFFIC: Vehicles on the RIGHT SIDE of the canopy area, 
     these are heading toward South Africa.
   • TRUCKS: Trucks park in the canopy BUT they process at a DIFFERENT location.
     ⚠️ Trucks do NOT cause delays for cars UNLESS they are physically blocking 
     the car lanes. Don't count stationary trucks as traffic delays!

📷 WIDE/ENGEN VIEW:
   • Shows the approach road from Lesotho side
   • If cars are queued here, SA→LS traffic is severely backed up

═══════════════════════════════════════════════════════════════
CROSS-VIEW VALIDATION (use this to confirm traffic severity):
═══════════════════════════════════════════════════════════════
🔍 To confirm LS→SA traffic:
   1. Check bridge: vehicles on far side (away from orange pillar)
   2. Check canopy: vehicles on RIGHT side heading toward bridge
   3. If BOTH show queues → Confirmed LS→SA congestion

🔍 To confirm SA→LS traffic:
   1. Check bridge: vehicles on near side (by orange pillar)
   2. Check canopy: cars ENTERING/queuing in the canopy (1-2 rows)
   3. Check wide/Engen: if backed up here, SA→LS is SEVERE
   4. If bridge AND canopy show SA→LS queues → Confirmed congestion

═══════════════════════════════════════════════════════════════
`;

    // Generate camera status warning for prompt
    const cameraStatusWarning = (() => {
      const camStatus = getCameraStatusInfo();
      if (camStatus.status === 'down') {
        return `
🔴 CAMERA STATUS ALERT:
The camera feed is currently unavailable. Let the user know that you cannot provide real-time updates, but offer historical patterns or suggest they check back later.
`;
      } else if (camStatus.status === 'stuck_on_angle') {
        const angleDescriptions = {
          'bridge': 'the bridge approach',
          'processing': 'the processing area', 
          'wide': 'the wide Engen area view'
        };
        const desc = angleDescriptions[camStatus.stuckAngle] || camStatus.stuckAngle;
        return `
📷 CAMERA STATUS NOTE:
The camera is currently only showing ${desc}. Other views are not available. Mention this limitation if relevant to the user's question.
`;
      }
      return '';
    })();

    // Get queue reports from users
    const queueReportsPrompt = await formatQueueReportsForPrompt();

    const systemPrompt = `You are a friendly traffic assistant for Maseru Bridge border crossing between Lesotho and South Africa.

${visualAssessmentReminder}
${countsInfo}
${cameraStatusWarning}
${queueReportsPrompt}
═══════════════════════════════════════════════════════════════
TRAFFIC LEVELS (assess EACH direction separately):
═══════════════════════════════════════════════════════════════

For LS→SA (Lesotho to South Africa):
• LIGHT: 0-3 vehicles, no queue on bridge far lane or canopy right side
• MODERATE: 4-8 vehicles, some queue visible on bridge or canopy right
• HEAVY: 8+ vehicles, clear queue on bridge AND canopy right side
• SEVERE: Queue extends significantly, long waits expected

For SA→LS (South Africa to Lesotho):
• LIGHT: 0-3 vehicles, no cars entering canopy
• MODERATE: 4-8 vehicles, single row of cars queuing into canopy
• HEAVY: 8+ vehicles, cars in 2 ROWS entering canopy, bridge lane backed up
• SEVERE: Queue backs up to Engen/approach road (visible in WIDE view)

⚠️ IMPORTANT NOTES:
• Trucks in canopy area do NOT automatically mean delays - they process elsewhere
• Only count trucks as causing delays if they are blocking car lanes
• 2 rows of cars entering canopy = definite HEAVY traffic for SA→LS
• If Engen/approach road shows queue = SEVERE for SA→LS

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
- "automated detection", "detector", "YOLO"
- "user reports say" (just state the info naturally)

✅ INSTEAD SAY (user-friendly):
- "2-3 vehicles heading to SA"
- "No queue forming"
- "Bridge is clear"
- "Light traffic in both directions"
- "About 5 vehicles waiting"
- "Based on a recent report from X minutes ago..."

═══════════════════════════════════════════════════════════════
RESPONSE STYLES BY QUESTION TYPE:
═══════════════════════════════════════════════════════════════

**OFF-TOPIC QUESTIONS** (weather, jokes, news, general knowledge, greetings, etc.):
→ ⚠️ DO NOT use direction boxes [LS_TO_SA] or [SA_TO_LS] format!
→ Keep response to 1-2 sentences MAX
→ Be friendly, acknowledge their question briefly
→ Mention what you CAN see from camera if relevant
→ Include current status as just a word (LIGHT/MODERATE/HEAVY), not boxes
→ Examples (follow these exactly):
  - "Tell me a joke" → "I'm better at traffic updates than comedy! 😄 Traffic is LIGHT right now - great time to cross!"
  - "How's the weather?" → "Can't check forecasts, but I see wet roads in the camera. Traffic is LIGHT though!"
  - "Hi/Hello" → "Hi there! 👋 Traffic at Maseru Bridge is LIGHT right now. How can I help with your crossing?"
  - "Thanks/Bye" → "Safe travels! 🚗 Traffic is LIGHT if you're heading out now."
  - "Who are you?" → "I'm your Maseru Bridge traffic assistant! I monitor the border crossing 24/7. Traffic is LIGHT right now."

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
5. ALWAYS show both directions in standard format
6. For OFF-TOPIC questions: Be friendly, acknowledge the question, share what you CAN see from the camera if relevant, give current traffic status, and redirect to traffic helpfully`;


    // Detect question type for better responses
    const questionLower = userQuestion ? userQuestion.toLowerCase() : '';
    let questionType = 'general';
    
    // Check for off-topic questions first
    const offTopicKeywords = [
      'weather', 'rain', 'sunny', 'cold', 'hot', 'temperature',
      'joke', 'funny', 'laugh',
      'news', 'president', 'politics', 'election',
      'sport', 'soccer', 'football', 'rugby', 'cricket',
      'food', 'restaurant', 'eat',
      'movie', 'music', 'song',
      'hello', 'hi ', 'hey ', 'how are you', 'what\'s up', 'whats up',
      'who are you', 'your name', 'what can you do',
      'thank', 'thanks', 'bye', 'goodbye'
    ];
    
    const trafficKeywords = [
      'traffic', 'queue', 'border', 'crossing', 'bridge', 'vehicle', 'car', 'truck',
      'wait', 'busy', 'congestion', 'flow', 'backed', 'clear', 'status',
      'lesotho', 'south africa', 'maseru', 'ls', 'sa', 'ficksburg'
    ];
    
    const hasOffTopicWord = offTopicKeywords.some(word => questionLower.includes(word));
    const hasTrafficWord = trafficKeywords.some(word => questionLower.includes(word));
    
    // If has off-topic keywords but NO traffic keywords, it's off-topic
    if (hasOffTopicWord && !hasTrafficWord) {
      questionType = 'offtopic';
    } else if (questionLower.includes('from ls') || questionLower.includes('from lesotho') || 
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

    let userPrompt;
    if (!userQuestion) {
      userPrompt = `Analyze these camera snapshots from Maseru Bridge border crossing. Give a brief, structured assessment using the standard format with both direction boxes.`;
    } else if (questionType === 'offtopic') {
      userPrompt = `Question type: OFF-TOPIC
User's question: "${userQuestion}"

⚠️ IMPORTANT: This is an off-topic question. DO NOT use direction boxes [LS_TO_SA] or [SA_TO_LS].
Give a SHORT 1-2 sentence friendly response. Acknowledge their question, mention what you can see from the camera if relevant, and include current traffic status as just a word (LIGHT/MODERATE/HEAVY).
Example format: "I'm better at traffic than jokes! 😄 Traffic is LIGHT right now - great time to cross!"`;
    } else {
      userPrompt = `Question type: ${questionType.toUpperCase()}
User's question: "${userQuestion}"

Respond appropriately for this question type. Be helpful and conversational.`;
    }

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

    // Get camera status
    const camStatus = getCameraStatusInfo();

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
      frameTimestamp: latestFrame.timestamp,
      framesAnalyzed: framesToUse.length,
      cached: false,
      cameraStatus: camStatus.status,
      cameraAlert: camStatus.message,
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

// Camera status endpoint - Check if camera is operational
app.get('/api/camera-status', (req, res) => {
  const status = getCameraStatusInfo();
  res.json({
    success: true,
    ...status,
    angleHistory: cameraStatus.angleHistory.slice(-10), // Last 10 angles for debugging
    bufferSize: screenshotBuffer.length,
  });
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

// Streaming chat endpoint for faster perceived response
app.post('/api/chat/stream', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, message: 'Please provide a message' });
    }

    // Check cache for common questions
    const questionCategory = categorizeQuestion(message);
    const cached = getCachedResponse(questionCategory);
    
    if (cached) {
      // Return cached response as instant JSON (no streaming needed)
      return res.json({
        success: true,
        message: cached.response,
        frameTimestamp: cached.frameTimestamp,
        cached: true,
        cacheAge: Math.round((Date.now() - cached.timestamp) / 1000)
      });
    }

    // Capture frame first
    await captureFrame();
    
    // Check if we have frames
    if (screenshotBuffer.length === 0) {
      return res.json({
        success: false,
        message: "No camera feed available. Please try again in a moment."
      });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders(); // Send headers immediately to establish connection
    
    // Prepare frames (same logic as analyzeTraffic)
    const usefulFrames = screenshotBuffer.filter(f => f.angleType !== ANGLE_TYPES.USELESS);
    const framesByAngle = {};
    usefulFrames.forEach(frame => {
      if (!framesByAngle[frame.angleType]) {
        framesByAngle[frame.angleType] = [];
      }
      framesByAngle[frame.angleType].push(frame);
    });
    
    const framesToUse = [];
    const anglePriority = [ANGLE_TYPES.BRIDGE, ANGLE_TYPES.PROCESSING, ANGLE_TYPES.WIDE];
    
    for (const angleType of anglePriority) {
      if (framesByAngle[angleType] && framesByAngle[angleType].length > 0) {
        const frames = framesByAngle[angleType];
        framesToUse.push(frames[frames.length - 1]);
      } else if (preservedFrames[angleType] && isFrameFresh(preservedFrames[angleType])) {
        framesToUse.push(preservedFrames[angleType]);
      }
    }
    
    if (framesToUse.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'No camera view available' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Get camera status
    const camStatus = getCameraStatusInfo();

    // Send frame timestamp and camera status first
    const latestFrame = framesToUse[framesToUse.length - 1];
    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);
    res.write(`data: ${JSON.stringify({ 
      type: 'meta', 
      frameTimestamp: latestFrame.timestamp,
      cameraStatus: camStatus.status,
      cameraAlert: camStatus.message
    })}\n\n`);

    // =============================================
    // STEP 1: Call YOLO detector for vehicle counts
    // =============================================
    let detectorCounts = null;
    let canopyDetectorCounts = null;
    
    const bridgeFrame = framesToUse.find(f => f.angleType === ANGLE_TYPES.BRIDGE);
    if (bridgeFrame) {
      detectorCounts = await detectVehicles(
        bridgeFrame.screenshot.toString('base64'),
        'bridge'
      );
    }
    
    // Find the canopy/processing frame and call detector for SA→LS queue
    const canopyFrame = framesToUse.find(f => f.angleType === ANGLE_TYPES.PROCESSING);
    if (canopyFrame) {
      canopyDetectorCounts = await detectVehicles(
        canopyFrame.screenshot.toString('base64'),
        'canopy'
      );
    }
    
    // Add to traffic history for time-series analysis
    trafficHistory.addReading(detectorCounts, canopyDetectorCounts);
    
    // Get trend analysis
    const trendSummary = trafficHistory.getTrendSummary();
    
    // Determine traffic levels from detector counts
    let lsToSaStatus = 'LIGHT';
    let saToLsStatus = 'LIGHT';
    let lsToSaCount = 0;
    let saToLsCount = 0;
    let saToLsCanopyCount = 0;
    
    // Bridge counts
    if (detectorCounts && !detectorCounts.direction_uncertain) {
      lsToSaCount = detectorCounts.LS_to_SA;
      saToLsCount = detectorCounts.SA_to_LS;
    }
    
    // Add canopy counts for SA→LS
    if (canopyDetectorCounts) {
      saToLsCanopyCount = canopyDetectorCounts.SA_to_LS || 0;
    }
    
    // Combined SA→LS count (bridge + canopy queue)
    const combinedSaToLs = saToLsCount + saToLsCanopyCount;
    
    if (detectorCounts && !detectorCounts.direction_uncertain) {
      if (lsToSaCount <= 3) lsToSaStatus = 'LIGHT';
      else if (lsToSaCount <= 8) lsToSaStatus = 'MODERATE';
      else lsToSaStatus = 'HEAVY';
      
      // SA→LS uses COMBINED count
      if (combinedSaToLs <= 3) saToLsStatus = 'LIGHT';
      else if (combinedSaToLs <= 8) saToLsStatus = 'MODERATE';
      else saToLsStatus = 'HEAVY';
    }

    // Extract breakdown if available
    const breakdown = detectorCounts?.breakdown || {};
    const lsToSaBreakdown = breakdown.LS_to_SA || { cars: 0, trucks: 0, buses: 0 };
    const saToLsBreakdown = breakdown.SA_to_LS || { cars: 0, trucks: 0, buses: 0 };

    // Build trend info string
    const trendInfoString = trendSummary ? `
📈 TRAFFIC TREND: ${trendSummary}
` : '';

    // Build counts info for prompt
    const countsInfo = detectorCounts && !detectorCounts.direction_uncertain
      ? `
VEHICLE COUNTS (automated detection):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• LS→SA (Lesotho to South Africa): ${lsToSaCount} vehicles - ${lsToSaStatus}
  Breakdown: ${lsToSaBreakdown.cars} cars, ${lsToSaBreakdown.trucks} trucks, ${lsToSaBreakdown.buses} buses
  
• SA→LS (South Africa to Lesotho): COMBINED COUNT
  - Bridge: ${saToLsCount} vehicles
  - Canopy queue: ${saToLsCanopyCount} vehicles
  - TOTAL: ${combinedSaToLs} vehicles - ${saToLsStatus}
  Breakdown: ${saToLsBreakdown.cars} cars, ${saToLsBreakdown.trucks} trucks, ${saToLsBreakdown.buses} buses
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${trendInfoString}
⚠️ IMPORTANT: SA→LS count COMBINES bridge + canopy vehicles.

📌 TRUCK NOTE: Stationary trucks do NOT cause delays - they process elsewhere.
`
      : `
⚠️ Automated vehicle detection unavailable. Use your visual assessment.
`;

    // Generate camera status warning for prompt (streaming)
    const cameraStatusWarning = (() => {
      const camStatus = getCameraStatusInfo();
      if (camStatus.status === 'down') {
        return `
🔴 CAMERA STATUS ALERT:
The camera feed is currently unavailable. Let the user know that you cannot provide real-time updates.
`;
      } else if (camStatus.status === 'stuck_on_angle') {
        const angleDescriptions = {
          'bridge': 'the bridge approach',
          'processing': 'the processing area', 
          'wide': 'the wide Engen area view'
        };
        const desc = angleDescriptions[camStatus.stuckAngle] || camStatus.stuckAngle;
        return `
📷 CAMERA STATUS NOTE:
The camera is currently only showing ${desc}. Other views are not available.
`;
      }
      return '';
    })();

    // Get queue reports from users
    const queueReportsPrompt = await formatQueueReportsForPrompt();

    // Visual assessment reminder for multi-view analysis
    const visualAssessmentReminder = `
═══════════════════════════════════════════════════════════════
MASERU BORDER TRAFFIC FLOW GUIDE
═══════════════════════════════════════════════════════════════
Understanding the camera views and traffic flow:

📷 BRIDGE VIEW:
   • LS→SA traffic: Uses the lane AWAY from the orange pillar (far side)
   • SA→LS traffic: Uses the lane NEAR the orange pillar
   • Count vehicles in each lane to assess directional traffic

📷 CANOPY/PROCESSING VIEW:
   • SA→LS TRAFFIC: Cars ENTERING the canopy area, queue in 1 row normally,
     2 rows when traffic is heavy. Look for cars lined up coming INTO the shelter.
   • LS→SA TRAFFIC: Vehicles on the RIGHT SIDE of the canopy area, 
     these are heading toward South Africa.
   • TRUCKS: Trucks park in the canopy BUT they process at a DIFFERENT location.
     ⚠️ Trucks do NOT cause delays for cars UNLESS they are physically blocking 
     the car lanes. Don't count stationary trucks as traffic delays!

📷 WIDE/ENGEN VIEW:
   • Shows the approach road from Lesotho side
   • If cars are queued here, SA→LS traffic is severely backed up

═══════════════════════════════════════════════════════════════
CROSS-VIEW VALIDATION (use this to confirm traffic severity):
═══════════════════════════════════════════════════════════════
🔍 To confirm LS→SA traffic:
   1. Check bridge: vehicles on far side (away from orange pillar)
   2. Check canopy: vehicles on RIGHT side heading toward bridge
   3. If BOTH show queues → Confirmed LS→SA congestion

🔍 To confirm SA→LS traffic:
   1. Check bridge: vehicles on near side (by orange pillar)
   2. Check canopy: cars ENTERING/queuing in the canopy (1-2 rows)
   3. Check wide/Engen: if backed up here, SA→LS is SEVERE
   4. If bridge AND canopy show SA→LS queues → Confirmed congestion

═══════════════════════════════════════════════════════════════
`;

    // Build system prompt with detector counts
    const systemPrompt = `You are a friendly traffic assistant for Maseru Bridge border crossing between Lesotho and South Africa.

${visualAssessmentReminder}
${countsInfo}
${cameraStatusWarning}
${queueReportsPrompt}
═══════════════════════════════════════════════════════════════
TRAFFIC LEVELS (assess EACH direction separately):
═══════════════════════════════════════════════════════════════

For LS→SA (Lesotho to South Africa):
• LIGHT: 0-3 vehicles, no queue on bridge far lane or canopy right side
• MODERATE: 4-8 vehicles, some queue visible on bridge or canopy right
• HEAVY: 8+ vehicles, clear queue on bridge AND canopy right side
• SEVERE: Queue extends significantly, long waits expected

For SA→LS (South Africa to Lesotho):
• LIGHT: 0-3 vehicles, no cars entering canopy
• MODERATE: 4-8 vehicles, single row of cars queuing into canopy
• HEAVY: 8+ vehicles, cars in 2 ROWS entering canopy, bridge lane backed up
• SEVERE: Queue backs up to Engen/approach road (visible in WIDE view)

⚠️ IMPORTANT NOTES:
• Trucks in canopy area do NOT automatically mean delays - they process elsewhere
• Only count trucks as causing delays if they are blocking car lanes
• 2 rows of cars entering canopy = definite HEAVY traffic for SA→LS
• If Engen/approach road shows queue = SEVERE for SA→LS

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
- "automated detection", "detector", "YOLO"
- "user reports say" (just state the info naturally)

✅ INSTEAD SAY (user-friendly):
- "2-3 vehicles heading to SA"
- "No queue forming"
- "Bridge is clear"
- "Light traffic in both directions"
- "About 5 vehicles waiting"
- "Based on a recent report from X minutes ago..."

═══════════════════════════════════════════════════════════════
RESPONSE STYLES BY QUESTION TYPE:
═══════════════════════════════════════════════════════════════

**OFF-TOPIC QUESTIONS** (weather, jokes, news, general knowledge, greetings, etc.):
→ ⚠️ DO NOT use direction boxes [LS_TO_SA] or [SA_TO_LS] format!
→ Keep response to 1-2 sentences MAX
→ Be friendly, acknowledge their question briefly
→ Mention what you CAN see from camera if relevant
→ Include current status as just a word (LIGHT/MODERATE/HEAVY), not boxes

**DIRECTION-SPECIFIC** ("I'm going from LS to SA"):
→ Show both directions BUT personalize advice to THEIR direction

**YES/NO QUESTIONS** ("Is there a queue at Engen?"):
→ Answer directly, don't use direction boxes format

**VISUAL QUESTIONS** ("How does the bridge look?"):
→ Simple description, don't use direction boxes format

**TIME QUESTIONS** ("What time should I cross?"):
→ Current status + tips about best times

**GENERAL/DEFAULT** ("How's traffic?", "Current status?"):
→ Use standard format with BOTH direction boxes

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
5. ALWAYS show both directions in standard format
6. For OFF-TOPIC questions: Be friendly, acknowledge the question, share what you CAN see from the camera if relevant, give current traffic status, and redirect to traffic helpfully`;

    // Detect question type
    const questionLower = message.toLowerCase();
    let questionType = 'general';
    
    const offTopicKeywords = [
      'weather', 'rain', 'sunny', 'cold', 'hot', 'temperature',
      'joke', 'funny', 'laugh', 'news', 'president', 'politics',
      'hello', 'hi ', 'hey ', 'how are you', 'who are you',
      'thank', 'thanks', 'bye', 'goodbye'
    ];
    
    const trafficKeywords = [
      'traffic', 'queue', 'border', 'crossing', 'bridge', 'vehicle', 'car',
      'wait', 'busy', 'congestion', 'clear', 'status', 'lesotho', 'south africa'
    ];
    
    const hasOffTopicWord = offTopicKeywords.some(word => questionLower.includes(word));
    const hasTrafficWord = trafficKeywords.some(word => questionLower.includes(word));
    
    if (hasOffTopicWord && !hasTrafficWord) {
      questionType = 'offtopic';
    }

    // Build content array
    const content = [];
    framesToUse.forEach((frame) => {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: frame.screenshot.toString('base64'),
        },
      });
    });

    let userPrompt;
    if (questionType === 'offtopic') {
      userPrompt = `Question type: OFF-TOPIC
User's question: "${message}"

⚠️ IMPORTANT: This is an off-topic question. DO NOT use direction boxes [LS_TO_SA] or [SA_TO_LS].
Give a SHORT 1-2 sentence friendly response.`;
    } else {
      userPrompt = `User's question: "${message}"

Respond appropriately. Be helpful and conversational.`;
    }

    content.push({ type: 'text', text: userPrompt });

    // Stream the response
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: content }],
    });

    let fullText = '';
    
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text;
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: 'text', text: text })}\n\n`);
      }
    }

    // Send done signal
    res.write(`data: ${JSON.stringify({ type: 'done', fullText: fullText })}\n\n`);
    res.write('data: [DONE]\n\n');
    
    // Cache the response for future similar questions
    const latestFrameTimestamp = framesToUse[framesToUse.length - 1]?.timestamp;
    cacheResponse(questionCategory, fullText, latestFrameTimestamp);
    
    // Log to database (async, don't wait)
    logTrafficReading(
      { message: fullText },
      framesToUse.map(f => ({ angleType: f.angleType, timestamp: f.timestamp })),
      0
    );
    
    res.end();
    
  } catch (error) {
    console.error('Streaming error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process your question' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
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
    
    // Maximum age for "fresh" vs "stale" (for UI indicator)
    const FRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const MAX_PRESERVED_AGE_MS = 60 * 60 * 1000; // 1 hour - show preserved frames up to 1 hour old
    
    // Go through buffer in reverse to get most recent of each type
    for (let i = screenshotBuffer.length - 1; i >= 0; i--) {
      const frame = screenshotBuffer[i];
      const angleType = frame.angleType || 'unknown';
      
      // Skip useless frames and already captured angles
      if (angleType === 'useless' || framesByAngle[angleType]) continue;
      
      // Skip stale frames from buffer (only use fresh ones)
      if (!isFrameFresh(frame)) continue;
      
      const label = angleLabels[angleType];
      if (label) {
        framesByAngle[angleType] = {
          angleType: angleType,
          label: label,
          timestamp: frame.timestamp,
          image: frame.screenshot.toString('base64'),
          isStale: false
        };
      }
    }
    
    // Fill in any missing angles from preserved frames
    // IMPORTANT: Allow older preserved frames (up to 1 hour) for carousel display
    // This helps when camera is stuck on certain angles
    const order = ['bridge', 'processing', 'wide'];
    for (const angleType of order) {
      if (!framesByAngle[angleType] && preservedFrames[angleType]) {
        const frame = preservedFrames[angleType];
        const frameAge = Date.now() - new Date(frame.timestamp).getTime();
        
        // Allow preserved frames up to 1 hour old for display
        if (frameAge <= MAX_PRESERVED_AGE_MS) {
          const label = angleLabels[angleType];
          if (label) {
            framesByAngle[angleType] = {
              angleType: angleType,
              label: label,
              timestamp: frame.timestamp,
              image: frame.screenshot.toString('base64'),
              isStale: frameAge > FRESH_THRESHOLD_MS, // Mark as stale if older than 10 min
              ageMinutes: Math.round(frameAge / 60000)
            };
          }
        }
      }
    }
    
    // Convert to array and sort by preferred order: Bridge, Canopy, Engen
    const frames = order
      .filter(type => framesByAngle[type])
      .map(type => framesByAngle[type]);
    
    // Determine camera status based on fresh frames only
    const freshFrames = frames.filter(f => !f.isStale);
    const staleFrames = frames.filter(f => f.isStale);
    
    let cameraStatus = 'normal';
    let statusMessage = null;
    const availableAngles = freshFrames.map(f => f.label);
    
    if (freshFrames.length === 0) {
      // No fresh frames at all - camera may be offline
      if (frames.length > 0) {
        cameraStatus = 'stale';
        statusMessage = '⚠️ Camera feed delayed. Showing older images.';
      } else {
        cameraStatus = 'offline';
        statusMessage = '⚠️ Camera feed unavailable. Please try again later.';
      }
    } else if (freshFrames.length === 1) {
      // Only one fresh angle available - camera may be stuck
      cameraStatus = 'limited';
      statusMessage = `📹 Camera currently showing ${availableAngles[0]} view. Other views from earlier.`;
    } else if (freshFrames.length === 2) {
      // Two fresh angles available
      cameraStatus = 'limited';
      const missingFresh = order.filter(a => !freshFrames.find(f => f.angleType === a)).map(a => angleLabels[a]);
      if (staleFrames.length > 0) {
        statusMessage = `📹 ${missingFresh[0]} view is from ${staleFrames[0].ageMinutes}m ago.`;
      } else {
        statusMessage = `📹 ${missingFresh[0]} view unavailable.`;
      }
    }
    
    res.json({
      success: true,
      frames: frames,
      totalInBuffer: screenshotBuffer.length,
      cameraStatus: cameraStatus,
      statusMessage: statusMessage,
      availableAngles: availableAngles,
      freshCount: freshFrames.length,
      staleCount: staleFrames.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get frames' });
  }
});

app.get('/api/health', (req, res) => {
  // Count frames by type in buffer
  const bufferCounts = screenshotBuffer.reduce((acc, f) => {
    acc[f.angleType] = (acc[f.angleType] || 0) + 1;
    return acc;
  }, {});
  
  // Check preserved frames status
  const preservedStatus = {};
  for (const [angle, frame] of Object.entries(preservedFrames)) {
    if (frame) {
      const age = Date.now() - frame.timestamp;
      preservedStatus[angle] = {
        exists: true,
        ageMinutes: Math.round(age / 60000),
        isFresh: age <= MAX_FRAME_AGE_MS
      };
    } else {
      preservedStatus[angle] = { exists: false };
    }
  }
  
  res.json({
    status: 'ok',
    bufferSize: screenshotBuffer.length,
    bufferCounts: bufferCounts,
    preservedFrames: preservedStatus,
    lastCapture: screenshotBuffer.length > 0 ? new Date(screenshotBuffer[screenshotBuffer.length - 1].timestamp).toISOString() : 'none',
    uptime: process.uptime(),
  });
});

// Debug endpoint to test classification on current frame
app.get('/api/debug/classify', async (req, res) => {
  try {
    // Capture a fresh frame
    console.log('🔍 Debug: Capturing frame for classification test...');
    const imageBuffer = await captureFrame();
    
    if (!imageBuffer) {
      return res.json({ success: false, message: 'Failed to capture frame' });
    }
    
    // Get the last captured frame's classification
    const lastFrame = screenshotBuffer[screenshotBuffer.length - 1];
    
    res.json({
      success: true,
      classification: lastFrame?.angleType || 'unknown',
      timestamp: lastFrame?.timestamp ? new Date(lastFrame.timestamp).toISOString() : null,
      bufferCounts: screenshotBuffer.reduce((acc, f) => {
        acc[f.angleType] = (acc[f.angleType] || 0) + 1;
        return acc;
      }, {}),
      message: `Frame classified as: ${lastFrame?.angleType || 'unknown'}`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// =============================================
// ADMIN DASHBOARD ROUTES
// =============================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-in-production';
const adminSessions = new Set(); // Simple in-memory session store

// Generate a random session token
function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    const token = generateToken();
    adminSessions.add(token);
    
    // Auto-expire token after 24 hours
    setTimeout(() => adminSessions.delete(token), 24 * 60 * 60 * 1000);
    
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// Middleware to check admin auth
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// Admin stats endpoint
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ success: false, message: 'Database not connected' });
    }

    const period = req.query.period || 'today'; // today, week, month
    const now = new Date();
    
    // Calculate date ranges
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    let periodStart;
    switch (period) {
      case 'week': periodStart = weekAgo; break;
      case 'month': periodStart = monthAgo; break;
      default: periodStart = todayStart;
    }

    // Get readings for selected period
    const { data: periodData, count: periodCount } = await supabase
      .from('traffic_readings')
      .select('*', { count: 'exact' })
      .gte('timestamp', periodStart)
      .order('timestamp', { ascending: false });

    // Get counts for all periods (for summary cards)
    const { count: todayCount } = await supabase
      .from('traffic_readings')
      .select('*', { count: 'exact' })
      .gte('timestamp', todayStart);

    const { count: weekCount } = await supabase
      .from('traffic_readings')
      .select('*', { count: 'exact' })
      .gte('timestamp', weekAgo);

    const { count: monthCount } = await supabase
      .from('traffic_readings')
      .select('*', { count: 'exact' })
      .gte('timestamp', monthAgo);

    const { count: totalCount } = await supabase
      .from('traffic_readings')
      .select('*', { count: 'exact' });

    // Calculate traffic status distribution for selected period
    const statusDistribution = {
      lsToSa: { LIGHT: 0, MODERATE: 0, HEAVY: 0, SEVERE: 0 },
      saToLs: { LIGHT: 0, MODERATE: 0, HEAVY: 0, SEVERE: 0 }
    };
    
    if (periodData) {
      periodData.forEach(reading => {
        if (reading.ls_to_sa_status) {
          statusDistribution.lsToSa[reading.ls_to_sa_status] = 
            (statusDistribution.lsToSa[reading.ls_to_sa_status] || 0) + 1;
        }
        if (reading.sa_to_ls_status) {
          statusDistribution.saToLs[reading.sa_to_ls_status] = 
            (statusDistribution.saToLs[reading.sa_to_ls_status] || 0) + 1;
        }
      });
    }

    // Get hourly distribution for selected period
    const hourlyData = {};
    if (periodData) {
      periodData.forEach(reading => {
        const hour = new Date(reading.timestamp).getHours();
        hourlyData[hour] = (hourlyData[hour] || 0) + 1;
      });
    }

    // Get daily counts for chart
    const dailyData = {};
    if (periodData) {
      periodData.forEach(reading => {
        const date = new Date(reading.timestamp).toISOString().split('T')[0];
        dailyData[date] = (dailyData[date] || 0) + 1;
      });
    }

    // Calculate average response time for period
    let avgResponseTime = 0;
    if (periodData && periodData.length > 0) {
      const validTimes = periodData.filter(r => r.response_time_ms);
      if (validTimes.length > 0) {
        const sum = validTimes.reduce((acc, r) => acc + r.response_time_ms, 0);
        avgResponseTime = Math.round(sum / validTimes.length);
      }
    }

    // Analyze question patterns (from traffic_summary)
    const questionPatterns = {};
    if (periodData) {
      periodData.forEach(reading => {
        if (reading.traffic_summary) {
          // Categorize by keywords in summary
          const summary = reading.traffic_summary.toLowerCase();
          if (summary.includes('light')) questionPatterns['Status: Light'] = (questionPatterns['Status: Light'] || 0) + 1;
          else if (summary.includes('moderate')) questionPatterns['Status: Moderate'] = (questionPatterns['Status: Moderate'] || 0) + 1;
          else if (summary.includes('heavy')) questionPatterns['Status: Heavy'] = (questionPatterns['Status: Heavy'] || 0) + 1;
          else if (summary.includes('severe')) questionPatterns['Status: Severe'] = (questionPatterns['Status: Severe'] || 0) + 1;
          else questionPatterns['Other'] = (questionPatterns['Other'] || 0) + 1;
        }
      });
    }

    // Get feedback stats
    let feedbackStats = { total: 0, likes: {}, improvements: {} };
    const { data: feedbackData, count: feedbackCount } = await supabase
      .from('user_feedback')
      .select('*', { count: 'exact' });
    
    if (feedbackData) {
      feedbackStats.total = feedbackCount || 0;
      feedbackData.forEach(fb => {
        if (fb.likes) {
          fb.likes.forEach(like => {
            feedbackStats.likes[like] = (feedbackStats.likes[like] || 0) + 1;
          });
        }
        if (fb.improvements) {
          fb.improvements.forEach(imp => {
            feedbackStats.improvements[imp] = (feedbackStats.improvements[imp] || 0) + 1;
          });
        }
      });
    }

    // Get cache stats
    const cacheStats = {};
    for (const [category, cached] of Object.entries(responseCache)) {
      if (cached) {
        const age = Math.round((now - cached.timestamp) / 1000);
        cacheStats[category] = { ageSeconds: age, valid: age < (CACHE_TTL / 1000) };
      } else {
        cacheStats[category] = null;
      }
    }

    // Get unique days with activity (proxy for engagement)
    const uniqueDays = Object.keys(dailyData).length;

    res.json({
      success: true,
      period: period,
      stats: {
        questions: {
          today: todayCount || 0,
          thisWeek: weekCount || 0,
          thisMonth: monthCount || 0,
          total: totalCount || 0,
          selectedPeriod: periodCount || 0
        },
        statusDistribution: statusDistribution,
        hourlyDistribution: hourlyData,
        dailyDistribution: dailyData,
        questionPatterns: questionPatterns,
        avgResponseTimeMs: avgResponseTime,
        uniqueActiveDays: uniqueDays,
        feedback: feedbackStats,
        cache: cacheStats,
        server: {
          uptime: Math.round(process.uptime()),
          bufferSize: screenshotBuffer.length
        }
      }
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// Get recent questions (for admin)
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.json({ success: false, message: 'Database not connected' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const period = req.query.period || 'today';
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    let periodStart;
    switch (period) {
      case 'week': periodStart = weekAgo; break;
      case 'month': periodStart = monthAgo; break;
      default: periodStart = todayStart;
    }
    
    const { data, error } = await supabase
      .from('traffic_readings')
      .select('id, timestamp, traffic_summary, ls_to_sa_status, ls_to_sa_detail, sa_to_ls_status, sa_to_ls_detail, advice, response_time_ms')
      .gte('timestamp', periodStart)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ success: true, questions: data });
  } catch (error) {
    console.error('Admin questions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch questions' });
  }
});

app.get('/api/debug', (req, res) => {
  // Count frames by angle type
  const angleCounts = screenshotBuffer.reduce((acc, f) => {
    acc[f.angleType] = (acc[f.angleType] || 0) + 1;
    return acc;
  }, {});
  
  // Get cache status
  const now = Date.now();
  const cacheStatus = {};
  for (const [category, cached] of Object.entries(responseCache)) {
    if (cached) {
      const age = Math.round((now - cached.timestamp) / 1000);
      const isValid = age < (CACHE_TTL / 1000);
      cacheStatus[category] = {
        ageSeconds: age,
        valid: isValid,
        expiresIn: isValid ? Math.round((CACHE_TTL / 1000) - age) : 0
      };
    } else {
      cacheStatus[category] = null;
    }
  }
  
  res.json({
    streamUrl: config.streamUrl,
    bufferSize: screenshotBuffer.length,
    angleCounts: angleCounts,
    responseCache: cacheStatus,
    cameraStatus: getCameraStatusInfo(),
    angleHistory: cameraStatus.angleHistory.slice(-15),
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

// =============================================
// QUEUE REPORTS API (Crowdsourced)
// =============================================

// Helper: Get active queue reports
async function getActiveQueueReports() {
  if (!supabase) return [];
  
  try {
    const { data, error } = await supabase
      .from('queue_reports')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching queue reports:', error);
      return [];
    }
    
    // Get latest report for each checkpoint
    const latestByCheckpoint = {};
    for (const report of (data || [])) {
      if (!latestByCheckpoint[report.checkpoint]) {
        latestByCheckpoint[report.checkpoint] = report;
      }
    }
    
    return Object.values(latestByCheckpoint);
  } catch (err) {
    console.error('Error in getActiveQueueReports:', err);
    return [];
  }
}

// Helper: Format queue reports for Claude's prompt
async function formatQueueReportsForPrompt() {
  const reports = await getActiveQueueReports();
  
  if (reports.length === 0) {
    return '';
  }
  
  const checkpointNames = {
    'leaving_ls': '🇱🇸 Leaving Lesotho',
    'entering_sa': '🇿🇦 Entering South Africa',
    'leaving_sa': '🇿🇦 Leaving South Africa',
    'entering_ls': '🇱🇸 Entering Lesotho'
  };
  
  const queueLengthLabels = {
    'empty': 'Empty',
    'short': 'Short (1-10 people)',
    'medium': 'Medium (10-25 people)',
    'long': 'Long (25-50 people)',
    'very_long': 'Very Long (50+ people)'
  };
  
  const waitTimeLabels = {
    'less_than_5': '<5 min',
    '5_to_10': '5-10 min',
    '10_to_20': '10-20 min',
    '20_to_30': '20-30 min',
    '30_to_45': '30-45 min',
    '45_to_60': '45-60 min',
    'more_than_60': '>1 hour'
  };
  
  let promptText = `
═══════════════════════════════════════════════════════════════
USER REPORTS (crowdsourced from travelers in queues):
═══════════════════════════════════════════════════════════════
`;
  
  const allCheckpoints = ['leaving_ls', 'entering_sa', 'leaving_sa', 'entering_ls'];
  
  for (const checkpoint of allCheckpoints) {
    const report = reports.find(r => r.checkpoint === checkpoint);
    const name = checkpointNames[checkpoint];
    
    if (report) {
      const minutesAgo = Math.round((Date.now() - new Date(report.created_at).getTime()) / 60000);
      const queueLabel = queueLengthLabels[report.queue_length];
      const waitLabel = waitTimeLabels[report.wait_time];
      const speedLabel = report.processing_speed.replace('_', ' ');
      
      promptText += `• ${name} (${minutesAgo} min ago): ${queueLabel}, ${speedLabel} speed, ${report.windows_open} window${report.windows_open > 1 ? 's' : ''}, waited ${waitLabel}`;
      if (report.comment) {
        promptText += ` — "${report.comment}"`;
      }
      promptText += '\n';
    } else {
      promptText += `• ${name}: No recent report\n`;
    }
  }
  
  promptText += `
Use these reports to give travelers a complete picture. Always mention how old the report is.
Combine camera data (bridge/vehicle counts) with user reports (passport control queues) for best advice.
`;
  
  return promptText;
}

// GET /api/reports - Get active queue reports
app.get('/api/reports', async (req, res) => {
  try {
    const reports = await getActiveQueueReports();
    
    // Add minutes_ago to each report
    const reportsWithAge = reports.map(r => ({
      ...r,
      minutes_ago: Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000)
    }));
    
    res.json({
      success: true,
      reports: reportsWithAge,
      count: reportsWithAge.length
    });
  } catch (err) {
    res.json({ success: false, message: err.message, reports: [] });
  }
});

// POST /api/reports - Submit a queue report (requires login)
app.post('/api/reports', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Database not connected' });
  }
  
  // Check authentication
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Login required to submit reports' });
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
    // Verify custom token
    let tokenData;
    try {
      tokenData = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Invalid token format. Please login again.' });
    }
    
    // Check token expiration
    if (!tokenData.user_id || !tokenData.exp || Date.now() > tokenData.exp) {
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }
    
    // Verify user exists in database
    const { data: user, error: userError } = await supabase
      .from('traffic_users')
      .select('id')
      .eq('id', tokenData.user_id)
      .single();
    
    if (userError || !user) {
      return res.status(401).json({ success: false, message: 'User not found. Please login again.' });
    }
    
    const userId = tokenData.user_id;
    
    const { side, direction, queue_length, processing_speed, windows_open, wait_time, comment } = req.body;
    
    // Validate required fields
    if (!side || !direction || !queue_length || !processing_speed || !windows_open || !wait_time) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Validate values
    const validSides = ['lesotho', 'south_africa'];
    const validDirections = ['leaving', 'entering'];
    const validQueueLengths = ['empty', 'short', 'medium', 'long', 'very_long'];
    const validSpeeds = ['very_slow', 'slow', 'moderate', 'fast'];
    const validWaitTimes = ['less_than_5', '5_to_10', '10_to_20', '20_to_30', '30_to_45', '45_to_60', 'more_than_60'];
    
    if (!validSides.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side' });
    }
    if (!validDirections.includes(direction)) {
      return res.status(400).json({ success: false, message: 'Invalid direction' });
    }
    if (!validQueueLengths.includes(queue_length)) {
      return res.status(400).json({ success: false, message: 'Invalid queue length' });
    }
    if (!validSpeeds.includes(processing_speed)) {
      return res.status(400).json({ success: false, message: 'Invalid processing speed' });
    }
    if (!validWaitTimes.includes(wait_time)) {
      return res.status(400).json({ success: false, message: 'Invalid wait time' });
    }
    
    const windowsNum = parseInt(windows_open);
    if (isNaN(windowsNum) || windowsNum < 1 || windowsNum > 6) {
      return res.status(400).json({ success: false, message: 'Windows open must be 1-6' });
    }
    
    // Determine checkpoint
    const checkpoint = `${direction}_${side === 'lesotho' ? 'ls' : 'sa'}`;
    
    // Check rate limit (1 report per checkpoint per 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentReport } = await supabase
      .from('queue_reports')
      .select('created_at')
      .eq('user_id', userId)
      .eq('checkpoint', checkpoint)
      .gt('created_at', tenMinutesAgo)
      .limit(1);
    
    if (recentReport && recentReport.length > 0) {
      const lastReportTime = new Date(recentReport[0].created_at);
      const waitSeconds = Math.ceil((10 * 60 * 1000 - (Date.now() - lastReportTime.getTime())) / 1000);
      const waitMinutes = Math.ceil(waitSeconds / 60);
      return res.status(429).json({ 
        success: false, 
        message: `You reported on this checkpoint recently. Please wait ${waitMinutes} minute${waitMinutes > 1 ? 's' : ''} before submitting again.`
      });
    }
    
    // Insert report
    const { data: newReport, error: insertError } = await supabase
      .from('queue_reports')
      .insert({
        user_id: userId,
        side,
        direction,
        queue_length,
        processing_speed,
        windows_open: windowsNum,
        wait_time,
        comment: comment?.slice(0, 200) || null,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      })
      .select()
      .single();
    
    if (insertError) {
      console.error('Error inserting report:', insertError);
      return res.status(500).json({ success: false, message: 'Failed to submit report' });
    }
    
    console.log(`📊 New queue report: ${checkpoint} - ${queue_length}, ${processing_speed} speed, ${windowsNum} windows`);
    
    res.json({
      success: true,
      message: 'Report submitted successfully! Thank you for helping other travelers.',
      report: {
        ...newReport,
        minutes_ago: 0
      }
    });
  } catch (err) {
    console.error('Error submitting report:', err);
    res.status(500).json({ success: false, message: 'Failed to submit report' });
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

    // Generate a simple auth token
    const tokenData = {
      user_id: data.id,
      phone: data.phone_full,
      exp: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };
    const accessToken = Buffer.from(JSON.stringify(tokenData)).toString('base64');

    res.json({
      success: true,
      message: 'Registration successful',
      user: {
        id: data.id,
        phone: data.phone_full,
        country: data.country_residence,
        name: data.name,
        access_token: accessToken
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

    // Generate a simple auth token (user_id + timestamp + signature)
    const tokenData = {
      user_id: user.id,
      phone: user.phone_full,
      exp: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };
    const accessToken = Buffer.from(JSON.stringify(tokenData)).toString('base64');

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        phone: user.phone_full,
        country: user.country_residence,
        name: user.name,
        preferences: user.preferences,
        access_token: accessToken
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

// Admin dashboard page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Background capture
async function startBackgroundCapture() {
  console.log('🔄 Starting background capture with angle-change detection...');
  
  // Initial capture
  await captureFrame();
  
  // Rapid sampling every 20 seconds, but only save when angle changes
  setInterval(async () => {
    await smartCapture();
  }, 20000); // Check every 20 seconds
}

// Track last captured angle to detect camera movement
let lastCapturedAngle = null;
let lastAngleChangeTime = 0;
let consecutiveSameAngle = 0;

// Smart capture: Only save frame if camera angle changed OR it's been too long
async function smartCapture() {
  if (isCapturing) {
    console.log('⏳ Capture already in progress');
    return;
  }

  isCapturing = true;
  const outputPath = '/tmp/frame.jpg';

  return new Promise((resolve) => {
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
          
          // Check for motion blur BEFORE classification
          if (isImageBlurry(imageBuffer)) {
            // Skip blurry frames entirely - camera is probably still moving
            resolve(null);
            return;
          }
          
          // Classify the frame angle
          const angleType = await classifyFrameAngle(imageBuffer);
          
          const timeSinceLastChange = timestamp - lastAngleChangeTime;
          const isNewAngle = angleType !== lastCapturedAngle && angleType !== 'useless';
          const tooLongSameAngle = timeSinceLastChange > 180000; // 3 minutes without change
          
          // Decide whether to save this frame
          let shouldSave = false;
          let reason = '';
          
          if (isNewAngle) {
            // Camera moved to a new angle - SAVE!
            shouldSave = true;
            reason = 'angle changed';
            consecutiveSameAngle = 0;
            lastAngleChangeTime = timestamp;
          } else if (tooLongSameAngle && angleType !== 'useless') {
            // Been too long, save anyway to keep frame fresh
            shouldSave = true;
            reason = 'refresh (same angle)';
            consecutiveSameAngle++;
          } else if (angleType === 'useless') {
            // Useless frame - check but don't increment
            reason = 'useless (skipped)';
            shouldSave = false;
          } else {
            // Same angle, not time to refresh yet
            consecutiveSameAngle++;
            reason = `same angle (${consecutiveSameAngle}x)`;
            shouldSave = false;
          }
          
          if (shouldSave) {
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
            
            // Record successful capture for camera status tracking
            recordCaptureSuccess(angleType);
            
            // Count frames by type
            const counts = screenshotBuffer.reduce((acc, f) => {
              acc[f.angleType] = (acc[f.angleType] || 0) + 1;
              return acc;
            }, {});
            
            console.log(`✅ Frame SAVED (${angleType}) - ${reason}. Buffer: ${JSON.stringify(counts)}`);
          } else {
            console.log(`⏭️ Frame skipped (${angleType}) - ${reason}`);
          }
          
          // Update last captured angle (for non-useless frames)
          if (angleType !== 'useless') {
            lastCapturedAngle = angleType;
          }
          
          resolve(imageBuffer);
        } catch (err) {
          console.error('❌ Failed to read captured frame:', err.message);
          recordCaptureFailure();
          resolve(null);
        }
      } else {
        console.error(`❌ ffmpeg failed with code ${code}`);
        recordCaptureFailure();
        resolve(null);
      }
    });

    ffmpeg.on('error', (err) => {
      isCapturing = false;
      console.error('❌ ffmpeg error:', err.message);
      recordCaptureFailure();
      resolve(null);
    });

    setTimeout(() => {
      if (isCapturing) {
        ffmpeg.kill('SIGKILL');
        isCapturing = false;
        console.error('❌ ffmpeg timeout');
        resolve(null);
      }
    }, 25000);
  });
}

// Keep original captureFrame for on-demand captures (API calls)
// Burst capture removed - smartCapture handles angle detection now

// =============================================
// MESSAGE REACTIONS API
// =============================================

// Store reaction
app.post('/api/reactions', async (req, res) => {
  try {
    const { messageId, reaction, previousReaction, messageSnippet, userId, timestamp } = req.body;

    // Log reaction for analytics (in production, store in database)
    console.log(`📊 Reaction: ${reaction || 'removed'} | User: ${userId || 'anonymous'} | Snippet: ${messageSnippet?.substring(0, 50)}...`);

    // Store in Supabase if available
    if (supabase) {
      if (reaction) {
        // Insert or update reaction
        await supabase.from('message_reactions').upsert({
          message_id: messageId,
          user_id: userId,
          reaction: reaction,
          message_snippet: messageSnippet?.substring(0, 100),
          created_at: timestamp
        }, { onConflict: 'message_id,user_id' });
      } else if (previousReaction) {
        // Remove reaction
        await supabase.from('message_reactions')
          .delete()
          .match({ message_id: messageId, user_id: userId || 'anonymous' });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Reaction error:', err);
    res.json({ success: true }); // Don't fail silently
  }
});

// Get reaction stats (for admin dashboard)
app.get('/api/reactions/stats', async (req, res) => {
  if (!supabase) {
    return res.json({ success: false, message: 'Database not available' });
  }

  try {
    // Get reaction counts
    const { data: upCount } = await supabase
      .from('message_reactions')
      .select('id', { count: 'exact' })
      .eq('reaction', 'up');
    
    const { data: downCount } = await supabase
      .from('message_reactions')
      .select('id', { count: 'exact' })
      .eq('reaction', 'down');

    // Get recent reactions
    const { data: recent } = await supabase
      .from('message_reactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      success: true,
      stats: {
        thumbsUp: upCount?.length || 0,
        thumbsDown: downCount?.length || 0,
        recent: recent || []
      }
    });
  } catch (err) {
    console.error('Reaction stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================
// FEEDBACK API
// =============================================

// Store user feedback
app.post('/api/feedback', async (req, res) => {
  try {
    const { likes, improvements, comment, userId, timestamp } = req.body;

    // Log feedback
    console.log('📝 Feedback received:');
    console.log(`   Likes: ${likes.join(', ') || 'none'}`);
    console.log(`   Improvements: ${improvements.join(', ') || 'none'}`);
    console.log(`   Comment: ${comment || 'none'}`);
    console.log(`   User: ${userId || 'anonymous'}`);

    // Store in Supabase if available
    if (supabase) {
      await supabase.from('user_feedback').insert({
        user_id: userId,
        likes: likes,
        improvements: improvements,
        comment: comment,
        created_at: timestamp
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err);
    res.json({ success: true }); // Don't fail
  }
});

// Get feedback summary (for admin)
app.get('/api/feedback/stats', async (req, res) => {
  if (!supabase) {
    return res.json({ success: false, message: 'Database not available' });
  }

  try {
    const { data: feedback } = await supabase
      .from('user_feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    // Aggregate likes and improvements
    const likesCount = {};
    const improvementsCount = {};

    feedback?.forEach(f => {
      f.likes?.forEach(like => {
        likesCount[like] = (likesCount[like] || 0) + 1;
      });
      f.improvements?.forEach(imp => {
        improvementsCount[imp] = (improvementsCount[imp] || 0) + 1;
      });
    });

    res.json({
      success: true,
      stats: {
        totalResponses: feedback?.length || 0,
        likes: likesCount,
        improvements: improvementsCount,
        recentComments: feedback?.filter(f => f.comment).slice(0, 10) || []
      }
    });
  } catch (err) {
    console.error('Feedback stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =============================================
// USER ACTIVITY TRACKING API
// =============================================

// Track user activity
app.post('/api/activity/track', async (req, res) => {
  if (!supabase) {
    return res.json({ success: true }); // Silently succeed if no DB
  }

  try {
    const { userId, action, timestamp } = req.body;

    if (!userId) {
      return res.json({ success: true });
    }

    await supabase.from('user_activity').insert({
      user_id: userId,
      action: action,
      created_at: timestamp
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Activity tracking error:', err);
    res.json({ success: true }); // Don't fail
  }
});

// Get user stats
app.get('/api/activity/stats', async (req, res) => {
  if (!supabase) {
    return res.json({ success: false, message: 'Database not available' });
  }

  try {
    const { userId } = req.query;

    if (!userId) {
      return res.json({ success: false, message: 'User ID required' });
    }

    // Get this month's check count
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: monthlyData, count: monthlyChecks } = await supabase
      .from('user_activity')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('action', 'status_check')
      .gte('created_at', startOfMonth.toISOString());

    // Get activity by day of week
    const { data: activityData } = await supabase
      .from('user_activity')
      .select('created_at')
      .eq('user_id', userId)
      .eq('action', 'status_check');

    // Calculate favorite day and time
    let favoriteDay = '--';
    let favoriteTime = '--';
    let streak = 0;

    if (activityData && activityData.length > 0) {
      const dayCount = {};
      const hourCount = {};
      const uniqueDays = new Set();

      activityData.forEach(a => {
        const date = new Date(a.created_at);
        const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
        const hour = date.getHours();
        const dateStr = date.toDateString();

        dayCount[dayName] = (dayCount[dayName] || 0) + 1;
        hourCount[hour] = (hourCount[hour] || 0) + 1;
        uniqueDays.add(dateStr);
      });

      // Find favorite day
      const maxDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];
      if (maxDay) favoriteDay = maxDay[0];

      // Find favorite time (group into ranges)
      const maxHour = Object.entries(hourCount).sort((a, b) => b[1] - a[1])[0];
      if (maxHour) {
        const h = parseInt(maxHour[0]);
        if (h < 6) favoriteTime = 'Night';
        else if (h < 12) favoriteTime = 'Morning';
        else if (h < 17) favoriteTime = 'Afternoon';
        else favoriteTime = 'Evening';
      }

      // Calculate streak (consecutive days)
      const sortedDays = Array.from(uniqueDays)
        .map(d => new Date(d))
        .sort((a, b) => b - a);

      if (sortedDays.length > 0) {
        streak = 1;
        for (let i = 1; i < sortedDays.length; i++) {
          const diff = (sortedDays[i - 1] - sortedDays[i]) / (1000 * 60 * 60 * 24);
          if (diff <= 1) {
            streak++;
          } else {
            break;
          }
        }
      }
    }

    res.json({
      success: true,
      stats: {
        monthlyChecks: monthlyChecks || 0,
        favoriteDay,
        favoriteTime,
        streak
      }
    });
  } catch (err) {
    console.error('Activity stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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
