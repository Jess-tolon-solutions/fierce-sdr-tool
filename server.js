require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { parse } = require('csv-parse');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

// Session store (simple in-memory for local demo)
const sessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Auth middleware
function requireAuth(req, res, next) {
  const sessionId = req.cookies.session;
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(sessionId);
  if (Date.now() > session.expires) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: 'Session expired' });
  }
  next();
}

// Login endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, { expires: Date.now() + SESSION_DURATION });
    res.cookie('session', sessionId, {
      httpOnly: true,
      maxAge: SESSION_DURATION,
      sameSite: 'strict'
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Check auth status
app.get('/api/auth-check', (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (Date.now() <= session.expires) {
      return res.json({ authenticated: true });
    }
    sessions.delete(sessionId);
  }
  res.json({ authenticated: false });
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const sessionId = req.cookies.session;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// CSV upload and processing endpoint
app.post('/api/process-csv', requireAuth, upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  const { repName, tone, styleNotes, ffTopic, ffDate, ffDescription, ffLink } = req.body;

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Parse CSV
    const records = await new Promise((resolve, reject) => {
      const results = [];
      const parser = parse(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
      parser.on('data', (data) => results.push(data));
      parser.on('error', reject);
      parser.on('end', () => resolve(results));
    });

    // Validate required fields
    const validRecords = records.filter(r => r.first_name && r.company && r.domain);

    if (validRecords.length === 0) {
      res.write(`data: ${JSON.stringify({ error: 'No valid records found. Required: first_name, company, domain' })}\n\n`);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ total: validRecords.length, type: 'init' })}\n\n`);

    // Process each contact
    for (let i = 0; i < validRecords.length; i++) {
      const contact = validRecords[i];
      try {
        const result = await generateOutreach(contact, {
          repName,
          tone,
          styleNotes,
          fierceFriday: ffTopic ? { topic: ffTopic, date: ffDate, description: ffDescription, link: ffLink } : null
        });

        res.write(`data: ${JSON.stringify({
          type: 'result',
          index: i,
          contact: {
            first_name: contact.first_name,
            last_name: contact.last_name || '',
            company: contact.company,
            title: contact.title || '',
            linkedin_url: contact.linkedin_url || ''
          },
          result
        })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          index: i,
          contact: { first_name: contact.first_name, company: contact.company },
          error: err.message
        })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: 'Failed to process CSV: ' + err.message })}\n\n`);
    res.end();
  }
});

async function generateOutreach(contact, options) {
  const client = new Anthropic();
  const { repName, tone, styleNotes, fierceFriday } = options;

  const toneDescriptions = {
    'Warm': 'friendly, personable, and relationship-focused. Use conversational language that feels genuine and caring.',
    'Direct': 'straightforward, concise, and action-oriented. Get to the point quickly while remaining professional.',
    'Consultative': 'thoughtful, advisory, and insight-driven. Position yourself as a helpful expert sharing valuable perspective.',
    'Energetic': 'enthusiastic, dynamic, and engaging. Bring positive energy while remaining professional and credible.'
  };

  const fierceFridaySection = fierceFriday ? `
FIERCE FRIDAY PROMOTION:
Include a natural mention of the upcoming Fierce Friday session if it fits the context.
- Topic: ${fierceFriday.topic}
- Date: ${fierceFriday.date}
- Description: ${fierceFriday.description}
- Registration Link: ${fierceFriday.link}
Only include this if it genuinely adds value to the outreach. Don't force it.` : '';

  const prompt = `You are writing sales outreach on behalf of ${repName}, a sales representative at Fierce, Inc. Fierce provides conversation-based leadership development programs that help organizations build accountable cultures through better conversations.

CONTACT INFORMATION:
- First Name: ${contact.first_name}
- Last Name: ${contact.last_name || 'Not provided'}
- Company: ${contact.company}
- Domain: ${contact.domain}
- Industry: ${contact.industry || 'Not specified'}
- Title: ${contact.title || 'Not provided'}
- Location: ${contact.location || 'Not provided'}
- Notes/Context: ${contact.notes || 'None'}
- Previous Stage: ${contact.previous_stage || 'New contact'}
- Last Contact Date: ${contact.last_contact_date || 'Never contacted'}
- LinkedIn: ${contact.linkedin_url || 'Not provided'}

TONE: ${tone} - Be ${toneDescriptions[tone]}

${styleNotes ? `ADDITIONAL STYLE NOTES FROM REP:\n${styleNotes}\n` : ''}
${fierceFridaySection}

INSTRUCTIONS:
1. Use the company domain to research/infer what the company does
2. If industry is provided, reference real current trends and pain points in that industry
3. If industry is blank, use the domain and any context to craft a strong message
4. Read the notes field carefully and build off any prior relationship context
5. Write as ${repName} - first person, authentic voice
6. Keep email under 120 words
7. Keep LinkedIn DM under 60 words
8. NEVER use "I hope this finds you well" or any generic opener
9. NEVER use em dashes (—)
10. Sound like a real person who did real research

Return a JSON object with exactly these fields:
{
  "email_subject": "compelling subject line",
  "email_body": "the full email body",
  "linkedin_dm": "the LinkedIn direct message",
  "industry_pain_points": ["pain point 1", "pain point 2", "pain point 3"],
  "recommended_module": "which Fierce program would help most (e.g., Fierce Conversations, Fierce Feedback, Fierce Accountability, Fierce Coaching, Team Fierce)",
  "module_rationale": "why this module fits their situation",
  "research_notes": "what you inferred about the company and contact",
  "hook_used": "the specific hook or angle you led with"
}

Respond with ONLY the JSON object, no other text.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const responseText = message.content[0].text;

  // Parse JSON from response
  try {
    return JSON.parse(responseText);
  } catch {
    // Try to extract JSON if there's extra text
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse AI response');
  }
}

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Fierce SDR Generator running at http://localhost:${PORT}`);
});
