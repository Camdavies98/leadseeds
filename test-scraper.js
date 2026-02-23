// Quick test — bypasses prompts, scrapes just 3 leads, prints results.
// Run: node test-scraper.js

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const BUSINESS_TYPE = 'plumber';
const LOCATION      = 'Manchester';
const TARGET        = 3; // small number so the test finishes quickly

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const jitter = ms => sleep(ms + rand(200, 600));

async function findEmail(context, websiteUrl) {
  const page = await context.newPage();
  try {
    await page.goto(websiteUrl, { timeout: 10000, waitUntil: 'domcontentloaded' });
    const mailtos = await page.$$eval('a[href^="mailto:"]', els =>
      els.map(el => el.href.replace('mailto:', '').split('?')[0].trim())
         .filter(e => e.includes('@'))
    );
    if (mailtos[0]) return mailtos[0];
    const text  = await page.evaluate(() => document.body.innerText);
    const match = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (match) return match[0];
  } catch { /* unreachable */ }
  finally { await page.close(); }
  return '';
}

async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🌱  LeadSeeds — Scraper Test');
  console.log(`  Searching: "${BUSINESS_TYPE}" in "${LOCATION}" (${TARGET} leads)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
  });
  const page  = await context.newPage();
  const leads = [];

  try {
    // ── Step 1: Navigate ──────────────────────────────────────────────────
    const query = `${BUSINESS_TYPE} in ${LOCATION}`;
    console.log(`[1/4] Navigating to Google Maps...`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });
    await jitter(3000);
    console.log(`      ✅ Page loaded — URL: ${page.url().slice(0, 80)}`);

    // ── Step 2: Dismiss cookies ───────────────────────────────────────────
    try {
      await page.locator('button:has-text("Accept all")').click({ timeout: 4000 });
      console.log(`      ✅ Cookie banner dismissed`);
      await sleep(1500);
    } catch { console.log(`      ℹ️  No cookie banner`); }

    // ── Step 3: Find results feed ─────────────────────────────────────────
    console.log(`\n[2/4] Looking for results feed...`);
    let feed = null;
    for (const sel of ['div[role="feed"]', 'div[aria-label*="Results for"]', 'div[aria-label*="result" i]']) {
      try {
        await page.locator(sel).waitFor({ state: 'visible', timeout: 15000 });
        feed = page.locator(sel).first();
        console.log(`      ✅ Feed found with selector: ${sel}`);
        break;
      } catch { console.log(`      ✗  Not found: ${sel}`); }
    }

    // ── Step 4: Collect place URLs ────────────────────────────────────────
    console.log(`\n[3/4] Collecting listing URLs...`);
    const placeUrls = new Set();

    if (feed) {
      for (let i = 0; i < 5 && placeUrls.size < TARGET + 2; i++) {
        const links = await page.$$eval('a[href*="/maps/place/"]',
          els => [...new Set(els.map(el => el.href.split('?')[0]))]
        );
        links.forEach(l => placeUrls.add(l));
        await feed.evaluate(el => el.scrollBy(0, 600));
        await jitter(1200);
      }
    } else {
      const links = await page.$$eval('a[href*="/maps/place/"]',
        els => [...new Set(els.map(el => el.href.split('?')[0]))]
      );
      links.forEach(l => placeUrls.add(l));
    }
    console.log(`      ✅ Collected ${placeUrls.size} URLs`);

    if (placeUrls.size === 0) {
      console.log('\n❌  No place URLs found. Google Maps may have blocked the request.');
      console.log('    Check the browser window for a CAPTCHA or consent screen.');
      return;
    }

    // ── Step 5: Extract details ───────────────────────────────────────────
    console.log(`\n[4/4] Extracting details from first ${TARGET} listings...\n`);

    for (const url of [...placeUrls].slice(0, TARGET)) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await jitter(rand(1200, 2000));

        const name = (await page.locator('h1').first().textContent({ timeout: 6000 }).catch(() => '')).trim();
        if (!name) { console.log('  ⚠️  No name found, skipping'); continue; }

        let phone = '';
        for (const sel of ['[data-item-id*="phone:tel:"]', '[aria-label*="Phone:"]']) {
          try {
            const el = page.locator(sel).first();
            const di = await el.getAttribute('data-item-id', { timeout: 2000 });
            const ar = await el.getAttribute('aria-label',   { timeout: 2000 });
            phone = (di?.replace(/phone:tel:/i, '') ?? ar?.replace(/phone:\s*/i, '') ?? '').trim();
            if (phone) break;
          } catch {}
        }

        let website = '';
        for (const sel of ['a[data-item-id="authority"]', 'a[aria-label*="website" i]']) {
          try {
            const href = await page.locator(sel).first().getAttribute('href', { timeout: 2000 });
            if (href?.startsWith('http')) { website = href; break; }
          } catch {}
        }

        let email = '';
        if (website) {
          process.stdout.write(`  Checking ${name} for email...`);
          email = await findEmail(context, website);
          console.log(email ? ` ✉  ${email}` : ' not found');
        }

        leads.push({ name, phone, email, website });
        console.log(`  ✅ [${leads.length}/${TARGET}] ${name}`);
        console.log(`         Phone:   ${phone   || '—'}`);
        console.log(`         Email:   ${email   || '—'}`);
        console.log(`         Website: ${website || '—'}\n`);

      } catch (err) {
        console.log(`  ⚠️  Skipped: ${err.message.split('\n')[0]}`);
      }
    }

  } finally {
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (leads.length > 0) {
    console.log(`  ✅  Test passed — extracted ${leads.length}/${TARGET} leads`);
    const withPhone   = leads.filter(l => l.phone).length;
    const withEmail   = leads.filter(l => l.email).length;
    const withWebsite = leads.filter(l => l.website).length;
    console.log(`  📞  Phone found:   ${withPhone}/${leads.length}`);
    console.log(`  ✉️   Email found:   ${withEmail}/${leads.length}`);
    console.log(`  🌐  Website found: ${withWebsite}/${leads.length}`);
  } else {
    console.log(`  ❌  Test failed — 0 leads extracted`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

run().catch(err => { console.error('\n💥 Fatal:', err.message); process.exit(1); });
