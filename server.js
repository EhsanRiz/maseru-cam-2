import express from 'express';
import puppeteer from 'puppeteer';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 3000,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  cameraUrl: 'https://webcast.etl.co.ls/m/SEHq7e82/maseru-bridge?list=NOdbTdaJ',
  captureInterval: 60000,
  cacheTimeout: 30000,
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
});

let browser = null;
let page = null;
let latestScreenshot = null;
let latestAnalysis = null;
let lastAnalysisTime = 0;
let isCapturing = false;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initBrowser() {
  console.log('🚀 Launching browser...');
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1920,1080',
        '--start-maximized',
      ],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('📷 Navigating to camera feed...');
    
    await page.goto(config.cameraUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    
    // Wait for page to render
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Log page title and URL
    const title = await page.title();
    const url = page.url();
    console.log(`📄 Page loaded: ${title} - ${url}`);
    
    // Log what elements exist
    const pageInfo = await page.evaluate(() => {
      return {
        videos: document.querySelectorAll('video').length,
        iframes: document.querySelectorAll('iframe').length,
        images: document.querySelectorAll('img').length,
        buttons: document.querySelectorAll('button').length,
        divs: document.querySelectorAll('div').length,
        bodyText: document.body.innerText.substring(0, 200),
      };
    });
    console.log('📊 Page elements:', JSON.stringify(pageInfo));
    
    // Click on the first video tile (Border Post, Maseru)
    console.log('🎬 Attempting to click on Border Post, Maseru video...');
    
    // Try to find and click on the video container
    try {
      // Wait for any clickable element in the video area
      await page.waitForSelector('div', { timeout: 5000 });
      
      // Click at different positions to find the play button
      const clickPositions = [
        { x: 270, y: 230 },  // Center of first video tile
        { x: 270, y: 200 },  // Slightly higher
        { x: 300, y: 250 },  // Slightly right
        { x: 250, y: 220 },  // Slightly left
      ];
      
      for (const pos of clickPositions) {
        console.log(`🖱️ Clicking at (${pos.x}, ${pos.y})`);
        await page.mouse.click(pos.x, pos.y);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      
    } catch (e) {
      console.log('⚠️ Click attempt error:', e.message);
    }
    
    // Wait for video to potentially start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if video is now playing
    const afterClick = await page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      return {
        videoCount: videos.length,
        playing: Array.from(videos).map(v => !v.paused),
      };
    });
    console.log('📊 After click:', JSON.stringify(afterClick));
    
    console.log('✅ Browser initialized');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize:', error.message);
    return false;
  }
}

async function captureScreenshot() {
  if (!page || isCapturing) {
    return latestScreenshot;
  }

  isCapturing = true;
  
  try {
    // Reload page
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for page to render
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // Log current page state
    const beforeClick = await page.evaluate(() => {
      return document.body.innerHTML.length;
    });
    console.log(`📄 Page HTML length: ${beforeClick}`);
    
    // Click on first video tile multiple times
    console.log('🎬 Clicking to start video...');
    await page.mouse.click(270, 230);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.mouse.click(270, 230);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.mouse.click(270, 230);
    
    // Wait for video
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Take FULL page screenshot to see what's actually there
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,  // Just viewport, not full scroll
    });
    
    latestScreenshot = screenshot;
    console.log(`📸 Screenshot captured at ${new Date().toISOString()}, size: ${screenshot.length} bytes`);
    
    return screenshot;
  } catch (error) {
    console.error('❌ Screenshot capture failed:', error.message);
    
    try {
      await browser?.close();
      await initBrowser();
    } catch (reinitError) {
      console.error('❌ Browser reinitialization failed:', reinitError.message);
    }
    
    return latestScreenshot;
  } finally {
    isCapturing = false;
  }
}

async function analyzeTraffic(screenshot, userQuestion = null) {
  if (!screenshot) {
    return {
      success: false,
      message: "No camera feed available. Please try again in a moment.",
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
                media_type: 'image/png',
                data: base64Image,
              },
            },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    });

    const analysis = {
      success: true,
      message: response.content[0].text,
      timestamp: new Date().toISOString(),
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

app.get('/api/status', async (req, res) => {
  try {
    const screenshot = await captureScreenshot();
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

    const screenshot = await captureScreenshot();
    const analysis = await analyzeTraffic(screenshot, message);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to process your question' });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const screenshot = await captureScreenshot();
    
    if (!screenshot) {
      return res.status(503).json({ success: false, message: 'No screenshot available' });
    }

    res.set('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get screenshot' });
  }
});

// Debug endpoint to see what Puppeteer sees
app.get('/api/debug', async (req, res) => {
  try {
    if (!page) {
      return res.json({ error: 'No page available' });
    }
    
    const debugInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyLength: document.body.innerHTML.length,
        videos: document.querySelectorAll('video').length,
        iframes: document.querySelectorAll('iframe').length,
        canvas: document.querySelectorAll('canvas').length,
        visibleText: document.body.innerText.substring(0, 500),
        firstDivClasses: Array.from(document.querySelectorAll('div')).slice(0, 10).map(d => d.className),
      };
    });
    
    res.json(debugInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    browserConnected: !!browser?.isConnected(),
    lastCapture: latestScreenshot ? 'available' : 'none',
    uptime: process.uptime(),
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  console.log('🌉 Maseru Bridge Traffic Bot');
  console.log('============================');
  
  if (!config.anthropicApiKey) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const browserReady = await initBrowser();
  
  if (!browserReady) {
    console.log('⚠️  Browser failed to load camera feed. Will retry on requests.');
  }

  setInterval(async () => {
    if (browser?.isConnected()) {
      await captureScreenshot();
    }
  }, config.captureInterval);

  app.listen(config.port, () => {
    console.log(`🚀 Server running on port ${config.port}`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  await browser?.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await browser?.close();
  process.exit(0);
});

start();
