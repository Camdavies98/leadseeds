# LeadSeeds — Project Context

## What It Is
A lead generation SaaS business charging £60/month. Scrapes Google Maps for high-quality business leads with owner name, email, LinkedIn, and branded Excel output.

## Stack
- **Runtime:** Node.js
- **Server:** server.js on port 10000
- **Scraper:** scraper.js — Playwright (local only), Google Maps, lead scoring 8/10+
- **Email:** Nodemailer
- **Client data:** leadseed_clients.csv

## Key Files
- `index.html` — landing page
- `server.js` — Node.js backend
- `scraper.js` — Google Maps scraper with lead scoring, owner name, email, LinkedIn, branded Excel output
- `leadseed_clients.csv` — client signups

## Deployment
- **Live:** https://leadseeds.onrender.com
- **GitHub:** https://github.com/Camdavies98/leadseeds
- **Domain:** leadseeds.co.uk (pointing to Render)

## Business Model
- £60/month per client
- Deliver scraped, scored leads to clients

## Notes
- Playwright scraper runs locally only (not on Render)
- Lead scoring threshold: 8/10+
