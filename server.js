const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic();

const TRAFFIC_ANALYSIS_PROMPT = `You are a traffic analyst for the Maseru Bridge border crossing between Lesotho and South Africa. Analyze the camera images to report on current traffic conditions.

LANDMARK-BASED DIRECTION IDENTIFICATION:

**Bridge View:**
- ORANGE POLE side = SA → LS (traffic entering Lesotho from South Africa)
- ENGEN side (away from orange pole) = LS → SA (traffic entering South Africa / Lesotho Emigration Area)

**Canopy View:**
- LEFT SHADE = SA → LS (traffic entering Lesotho)
- RIGHT SHADE = LS → SA (traffic entering South Africa)

CROSS-REFERENCE BOTH VIEWS FOR ACCURACY:
Assess each direction by checking BOTH camera views:

**To assess SA → LS traffic:**
1. Look at the ORANGE POLE side in Bridge view
2. Look at the LEFT SHADE area in Canopy view
3. Combine observations for confidence

**To assess LS → SA traffic:**
1. Look at the ENGEN side in Bridge view
2. Look at the RIGHT SHADE area in Canopy view
3. Combine observations for confidence

Both directions can have heavy traffic simultaneously!

NIGHTTIME ANALYSIS (when image is dark/night):
- Count HEADLIGHTS as vehicles - each pair of headlights = 1 vehicle
- A ROW of headlights = a QUEUE (likely HEAVY traffic)
- Multiple red taillights in a line = vehicles waiting in queue
- Don't underestimate just because it's dark - if you see many lights, it's busy
- At night, err on the side of reporting MORE traffic rather than less

TRAFFIC LEVELS:
- LIGHT: Few or no vehicles, no visible queue, immediate crossing likely
- MODERATE: Some vehicles present, short queue, 10-20 minute wait expected
- HEAVY: Long queue visible, vehicles backed up, 30+ minute wait expected

CRITICAL RULES:
1. NEVER mention "first image", "second image", "Image 1", etc.
2. NEVER mention "Bridge View", "Canopy View", or "VIEW 1/2/3" in your response
3. Synthesize ALL frames into ONE unified analysis
4. If you see traffic backed up to Engen petrol station, specifically mention "traffic backed up to Engen"
5. Keep response concise - no technical explanations about camera angles or landmarks
6. Use landmarks internally to determine direction, but don't explain them to users
7. AT NIGHT: Multiple headlights in a row = queue = HEAVY. Don't under-report nighttime traffic!
8. Only report what you actually SEE, not assumptions

RESPONSE FORMAT:
Keep your response brief and conversational. Structure it as:

🚗 **Traffic:** [Overall summary - one sentence]

**Conditions:**
• Lesotho → SA: [LIGHT/MODERATE/HEAVY] – [brief observation]
• SA → Lesotho: [LIGHT/MODERATE/HEAVY] – [brief observation]

**Advice:** [One practical recommendation]

⚠️ AI estimate from camera snapshots. Conditions change quickly.`;

app.post('/api/analyze', async (req, res) => {
  try {
    const { images } = req.body;
    
    if (!images || images.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    const imageContent = images.map(img => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType || 'image/jpeg',
        data: img.data
      }
    }));

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: 'Analyze the current traffic conditions at Maseru Bridge based on these camera frames. Remember to cross-reference both views to accurately assess each direction.'
            }
          ]
        }
      ],
      system: TRAFFIC_ANALYSIS_PROMPT
    });

    const analysis = response.content[0].text;
    res.json({ 
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze traffic' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Maseru Bridge Traffic Server running on port ${PORT}`);
});
