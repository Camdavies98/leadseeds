# LeadSeeds

A lead generation SaaS that scrapes Google Maps for high-quality local business leads — complete with owner name, email, phone, LinkedIn, and a branded Excel report. Delivered to clients within 5 hours for £60/month.

**Live:** https://leadseeds.onrender.com | **Domain:** leadseeds.co.uk

---

## What It Does

1. Accepts a natural-language search (e.g. `"plumbers in Chester"`)
2. Scrapes Google Maps for matching businesses
3. For each listing, enriches the data:
   - **Email** — scraped from the business website (mailto links + contact pages)
   - **Owner name** — found via schema.org markup and common text patterns
   - **LinkedIn** — searched via Bing (`site:linkedin.com/in`)
   - **Companies House** — fetches incorporation date and company number (optional)
4. Scores each lead out of 10 based on data completeness
5. Filters out big brands and low-scoring results
6. Exports a branded `.xlsx` report and a `.csv` file to the `leads/` folder

---

## Lead Scoring

| Signal | Points |
|---|---|
| Phone number found | +2 |
| Email found | +2 |
| Owner name found | +2 |
| LinkedIn found | +2 |
| Website found | +1 |
| Registered within last 5 years | +1 |

- **Hot** (8–10): Personalised outreach possible
- **Warm** (5–7): Good contact data, less personalisation
- **Cold** (<5): Skipped or deprioritised

---

## Stack

- **Runtime:** Node.js
- **Scraper:** Playwright (Chromium, headless off) — runs locally only
- **Server:** Plain Node.js HTTP server (`server.js`) on port 10000
- **Excel output:** ExcelJS — branded two-sheet workbook
- **Email:** Nodemailer (for client delivery)
- **Client data:** `leadseed_clients.csv`

---

## Getting Started

### Prerequisites

- Node.js 18+
- Playwright browsers installed

### Install

```bash
cd leadseeds
npm install
npx playwright install chromium
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Optional — enables Companies House registration date lookup
COMPANIES_HOUSE_API_KEY=your_key_here
```

Get a free key at [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk)

---

## Usage

### Run the scraper (local only)

```bash
npm run scrape
```

You'll be prompted to enter a search in plain English:

```
What are you looking for? plumbers in Chester
```

Or more natural:

```
What are you looking for? I need to find new trade businesses near Manchester
```

Outputs are saved to `leads/`:
- `LeadSeeds_<type>_<location>_<date>.xlsx` — branded Excel report
- `leads_<type>_<location>_<date>.csv` — raw CSV

### Run the web server

```bash
npm start
```

Serves `index.html` on port 10000 (or `$PORT` if set).

---

## Project Structure

```
leadseeds/
├── server.js             # HTTP server — serves the landing page
├── scraper.js            # Google Maps scraper, enrichment, scoring, Excel export
├── index.html            # Landing page
├── leadseed_clients.csv  # Client signup records
├── leads/                # Output folder (CSV + Excel files)
├── Procfile              # Render deployment config
└── package.json
```

---

## Deployment

Hosted on **Render** (free tier). The `Procfile` runs `node server.js`.

> The Playwright scraper does **not** run on Render — it is for local use only. Leads are generated locally and delivered to clients manually or via email.

---

## Business Model

- £60/month per client
- Scrape leads on demand per client brief
- Deliver the branded Excel report within 5 hours
