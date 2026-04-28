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
    const MAX_CONTACTS = 25;

    if (validRecords.length === 0) {
      res.write(`data: ${JSON.stringify({ error: 'No valid records found. Required: first_name, company, domain' })}\n\n`);
      res.end();
      return;
    }

    if (validRecords.length > MAX_CONTACTS) {
      res.write(`data: ${JSON.stringify({ error: `Too many contacts (${validRecords.length}). Maximum ${MAX_CONTACTS} per batch to ensure reliable processing.` })}\n\n`);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ total: validRecords.length, type: 'init' })}\n\n`);

    // Process each contact with spacing to avoid API overload
    for (let i = 0; i < validRecords.length; i++) {
      const contact = validRecords[i];

      // Add delay between requests (skip first one)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

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

  // Check if this is the Foundation session
  const isFoundationSession = fierceFriday && fierceFriday.topic && fierceFriday.topic.toLowerCase().includes('foundation');

  const foundationContext = isFoundationSession ? `
SESSION CONTEXT - FIERCE FOUNDATIONS:
This is the launch of a NEW series of short, high-impact learning bursts. Use this context to craft compelling outreach:

THE WHY: In a world moving faster than ever with AI disruption, shifting expectations, and constant change, organizations are rediscovering that human connection is still the ultimate competitive advantage. Fierce has championed this truth for more than two decades.

WHAT THEY'LL EXPERIENCE IN 30 MINUTES:
- The essential principles behind Fierce Conversations
- Why most change efforts fail and how conversation transforms execution
- Practical tools they can use immediately with their teams
- A modern lens on leadership rooted in clarity, courage, and connection

WHO IT'S FOR: Whether they have partnered with Fierce for years or are meeting us for the first time, this session gives a powerful introduction to what makes Fierce different and why organizations around the world rely on us to build stronger leaders and healthier cultures.

KEY MESSAGE: "Let us redefine what is possible, one conversation at a time."

Use these themes naturally in your outreach - don't copy verbatim, but weave in the relevant points based on their industry and situation.` : '';

  const fierceFridaySection = fierceFriday ? `
FIERCE LEARNING SERIES SESSION (PRIMARY CTA):
This is the main goal of your outreach. You are EXCLUSIVELY inviting them to a free 30-minute virtual session.
- Topic: ${fierceFriday.topic}
- Date: ${fierceFriday.date}
- Description: ${fierceFriday.description}
- Registration Link: ${fierceFriday.link}
${foundationContext}

THE ASK: Every email and LinkedIn DM should drive toward getting them to register for this session.
- Lead with a personalized hook based on their context, industry, and notes
- Close with an EXCLUSIVE, personal invitation to the session
- Use language like "I wanted to exclusively invite you" or "You're one of a small group I'm personally reaching out to"
- Emphasize: it's FREE, only 30 minutes, no commitment, no pitch - just valuable content
- The email MUST include the registration link as a clickable hyperlink
- Make it feel like a personal invite from a real person, not a marketing blast
- Connect WHY this session is relevant to THEIR specific situation
- Frame it as "on the house" - a gift, not a sales tactic

REP HANDOFF HANDLING:
- If the notes mention another person's name who previously worked with this contact (e.g., "spoke with Greg", "had calls with Tony", "worked with Sarah"), acknowledge that relationship
- Example: "I know you connected with Tony a while back - he's moved on, but I wanted to personally reach out..."
- This shows continuity and respect for the previous relationship
- Then transition smoothly into the exclusive session invitation` : '';

  const noFierceFridayInstructions = !fierceFriday ? `
GOAL: Reconnect and start a conversation about their leadership development needs.` : '';

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
${noFierceFridayInstructions}

=== EMAIL STRUCTURE: HOOK → RELEVANCY → CTA ===

Every email MUST follow this proven structure:

1. HOOK (First 1-2 sentences - THIS IS CRITICAL)
   The hook must grab attention immediately and feel personally relevant. It should NOT be about you or Fierce.

   HOOK PRIORITY ORDER (use the first one that applies):
   a) NOTES-BASED: If the notes field contains specific context (challenges, goals, past conversations), craft a hook directly tied to that
   b) TITLE-BASED: Reference a challenge specific to their role (VP of People, CHRO, Director of L&D, etc.)
   c) INDUSTRY-BASED: Reference a current trend or challenge in their specific industry
   d) GENERAL LEADERSHIP TREND: Use a compelling question about a universal leadership challenge

   HOOK FORMULAS THAT WORK:
   - Provocative question: "Is AI giving your managers better feedback than their leaders are?"
   - Pattern interrupt: "Most leadership training fails within 90 days. The reason isn't what you'd expect."
   - Stat + implication: "71% of managers report burnout. For [Company], that's not just a wellness issue."
   - Observation + insight: "Noticed [Company] is scaling fast - usually when communication breaks down."
   - Trend + question: "With AI handling more tasks, your managers' human skills matter more than ever - are they ready?"

   2026 LEADERSHIP TRENDS TO WEAVE INTO HOOKS:
   - AI is changing how feedback is delivered - but human conversation skills matter more than ever
   - Middle managers are burned out (71% report high stress) and influence 70% of employee engagement
   - Only 10% of employees believe their feedback leads to action (the listening-to-action gap)
   - Human skills (empathy, clarity, courage) are becoming the differentiator as AI handles technical tasks
   - 47% of leaders struggle managing multigenerational workforces
   - Half of employees want more training but aren't getting support

   BAD HOOKS (NEVER USE):
   - "I hope this email finds you well"
   - "My name is X and I work at Fierce"
   - "I wanted to reach out because..."
   - "I noticed you work at [Company]" (too generic)
   - Any opener that sounds like a template or mass email

2. RELEVANCY (2-3 sentences)
   Connect Fierce's solution to THEIR specific situation. Reference:
   - Their industry challenges
   - Their likely pain points based on title
   - The context from notes
   - Why THIS matters to THEM right now

3. CTA (1 sentence - clear and low-friction)
   Make it easy to say yes. Examples:
   - "Worth 30 minutes to explore?"
   - "Open to a quick conversation?"
   - For Fierce Learning Series: "Grab a spot here: [link]"

INSTRUCTIONS:
1. Use the company domain to research/infer what the company does
2. If industry is provided, reference real current trends and pain points in that industry
3. If industry is blank, use the domain and any context to craft a strong message
4. Read the notes field carefully - look for names of previous reps who worked this contact and acknowledge them by name
5. If a previous rep is mentioned, open with something like "You spoke with [Name] a while back..." then transition to the invite
6. Write as ${repName} - first person, authentic voice
7. Keep email under 120 words
8. Keep LinkedIn DM under 60 words
9. NEVER use "I hope this finds you well" or any generic opener
9. NEVER use em dashes (—)
10. Sound like a real person who did real research
${fierceFriday ? `11. The email body MUST include the registration link (${fierceFriday.link}) as a clickable hyperlink
12. The LinkedIn DM MUST also include the registration link (${fierceFriday.link}) - keep the DM under 60 words but always include the link` : ''}

Return a JSON object with exactly these fields:
{
  "email_subject": "compelling subject line under 7 words",
  "email_body": "the full email body following HOOK → RELEVANCY → CTA structure",
  "linkedin_dm": "the LinkedIn direct message",
  "industry_pain_points": ["pain point 1", "pain point 2", "pain point 3"],
  "recommended_module": "which Fierce program would help most (e.g., Fierce Conversations, Fierce Feedback, Fierce Accountability, Fierce Coaching, Team Fierce)",
  "module_rationale": "why this module fits their situation",
  "research_notes": "what you inferred about the company and contact",
  "hook_type": "notes-based OR title-based OR industry-based OR trend-based",
  "hook_used": "the exact opening hook sentence(s) you used",
  "hook_rationale": "why this hook was chosen for this specific contact"
}

Respond with ONLY the JSON object, no other text.`;

  // Retry logic for API overload errors
  let message;
  let retries = 5;
  let delay = 5000; // Start with 5 second delay

  while (retries > 0) {
    try {
      message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });
      break; // Success, exit loop
    } catch (err) {
      if (err.status === 529 && retries > 1) {
        // Overloaded, wait and retry
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
        retries--;
      } else {
        throw err; // Other error or out of retries
      }
    }
  }

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
