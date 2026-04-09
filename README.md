# Fierce SDR Outreach Generator

AI-powered sales outreach tool for Fierce, Inc.'s sales team. Generate personalized emails and LinkedIn DMs with industry intelligence.

## Setup

### 1. Install Node.js

Download and install Node.js (v18 or higher) from https://nodejs.org

### 2. Install Dependencies

```bash
cd fierce-sdr-generator
npm install
```

### 3. Create Environment File

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
APP_PASSWORD=your_team_password
PORT=3000
```

### 4. Start the Server

```bash
npm start
```

### 5. Open the App

Navigate to http://localhost:3000 in your browser.

## CSV Format

Upload a CSV with the following columns:

| Column | Required | Description |
|--------|----------|-------------|
| first_name | Yes | Contact's first name |
| last_name | No | Contact's last name |
| company | Yes | Company name |
| industry | No | Industry (helps with pain points) |
| domain | Yes | Company website domain |
| title | No | Contact's job title |
| notes | No | Previous interactions, context |
| previous_stage | No | Where they are in the funnel |
| last_contact_date | No | Last time you reached out |
| linkedin_url | No | Their LinkedIn profile URL |
| location | No | Contact's location |

## Features

- Personalized email generation (under 120 words)
- LinkedIn DM generation (under 60 words)
- Industry pain point analysis
- Fierce module recommendations
- Real-time streaming results
- One-click copy to clipboard
- Fierce Friday promotion integration
