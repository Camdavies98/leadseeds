require('dotenv').config();
const { chromium } = require('playwright');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const readline = require('readline');
const ExcelJS = require('exceljs');

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const rand   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const jitter = ms => sleep(ms + rand(200, 800));

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── Find email from website ──────────────────────────────────────────────────

async function findEmail(context, websiteUrl) {
  const page = await context.newPage();
  try {
    await page.goto(websiteUrl, { timeout: 12000, waitUntil: 'domcontentloaded' });

    const mailtos = await page.$$eval('a[href^="mailto:"]', els =>
      els.map(el => el.href.replace('mailto:', '').split('?')[0].trim())
         .filter(e => e.includes('@') && !e.includes('example'))
    );
    if (mailtos[0]) return mailtos[0];

    const bodyText = await page.evaluate(() => document.body.innerText);
    const hit = bodyText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (hit) return hit[0];

    const base = new URL(websiteUrl).origin;
    for (const slug of ['/contact', '/contact-us', '/get-in-touch', '/about']) {
      try {
        await page.goto(base + slug, { timeout: 8000, waitUntil: 'domcontentloaded' });
        const cMailtos = await page.$$eval('a[href^="mailto:"]', els =>
          els.map(el => el.href.replace('mailto:', '').split('?')[0].trim())
        );
        if (cMailtos[0]) return cMailtos[0];
        const cText = await page.evaluate(() => document.body.innerText);
        const cHit  = cText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
        if (cHit) return cHit[0];
      } catch { /* page not found */ }
    }
  } catch { /* site unreachable */ }
  finally { await page.close(); }
  return '';
}

// ── Find owner name from website ─────────────────────────────────────────────
// Checks About/Team pages for patterns like "Owner: Jane Smith" or schema.org markup.

async function findOwnerName(context, websiteUrl, businessName) {
  const page = await context.newPage();
  try {
    const base  = new URL(websiteUrl).origin;
    const pages = [
      websiteUrl,
      `${base}/about`, `${base}/about-us`,
      `${base}/team`,  `${base}/our-team`, `${base}/meet-the-team`,
    ];

    for (const url of pages) {
      try {
        await page.goto(url, { timeout: 8000, waitUntil: 'domcontentloaded' });

        // 1. Schema.org Person markup
        const schemaName = await page.evaluate(() => {
          const el = document.querySelector('[itemtype*="Person"] [itemprop="name"]');
          return el?.textContent?.trim() || '';
        });
        if (schemaName && schemaName.split(' ').length >= 2) return schemaName;

        // 2. Common text patterns
        const text = await page.evaluate(() => document.body.innerText);
        const patterns = [
          /(?:owner|director|founder|proprietor|managing director|principal|md)[:\s–-]+([A-Z][a-z]+ [A-Z][a-z]+)/i,
          /([A-Z][a-z]+ [A-Z][a-z]+)\s*[,–-]\s*(?:owner|director|founder|proprietor|principal)/i,
          /(?:hi,?\s+i'?m|hello,?\s+i'?m|my name is)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i,
          /©\s*(?:\d{4}[\s–-]*\d{0,4}\s+)?([A-Z][a-z]+ [A-Z][a-z]+)\b/,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m?.[1]) {
            const candidate = m[1].trim();
            // Reject if it's basically the business name
            const bizFirst = businessName.toLowerCase().split(/\s+/)[0];
            if (!candidate.toLowerCase().includes(bizFirst)) return candidate;
          }
        }
      } catch { /* page not found, skip */ }
    }
  } catch { /* site unreachable */ }
  finally { await page.close(); }
  return '';
}

// ── Find LinkedIn profile via Bing search ────────────────────────────────────
// Searches Bing for "site:linkedin.com/in 'owner name' 'location'" and returns
// the first matching LinkedIn URL. Uses Bing to avoid Google CAPTCHA friction.

async function findLinkedIn(context, businessName, ownerName, location) {
  const page = await context.newPage();
  try {
    const query = ownerName
      ? `site:linkedin.com/in "${ownerName}" "${location}"`
      : `site:linkedin.com/company "${businessName}"`;

    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout:   15000,
    });
    await sleep(rand(800, 1500));

    const url = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (href.includes('linkedin.com/in/') || href.includes('linkedin.com/company/')) {
          try { return href.split('?')[0].replace(/\/$/, ''); } catch {}
        }
      }
      return '';
    });

    return url;
  } catch { /* search failed */ }
  finally { await page.close(); }
  return '';
}

// ── Companies House API ───────────────────────────────────────────────────────
// Returns { incorporationDate, companyNumber, status } or null.
// Requires a free API key from developer.company-information.service.gov.uk

function getCompaniesHouseInfo(businessName, apiKey) {
  if (!apiKey) return Promise.resolve(null);

  return new Promise(resolve => {
    const options = {
      hostname: 'api.company-information.service.gov.uk',
      path:     `/search/companies?q=${encodeURIComponent(businessName)}&items_per_page=5`,
      method:   'GET',
      headers:  { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` },
      timeout:  8000,
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json    = JSON.parse(data);
          const bizFirst = businessName.toLowerCase().split(/\s+/)[0];
          // Find best-matching result
          const company = json.items?.find(c =>
            c.title?.toLowerCase().includes(bizFirst)
          ) || json.items?.[0];
          if (!company) return resolve(null);
          resolve({
            incorporationDate: company.date_of_creation || '',
            companyNumber:     company.company_number   || '',
            status:            company.company_status   || '',
          });
        } catch { resolve(null); }
      });
    });
    req.on('error',   ()  => resolve(null));
    req.on('timeout', ()  => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Big brand filter ─────────────────────────────────────────────────────────

const BIG_BRAND_KEYWORDS = [
  // National chains & franchises
  'british gas', 'homeserve', 'dyno', 'pimlico', 'checkatrade', 'rated people',
  'bark.com', 'trustatrader', 'myjobquote', 'checkatrade',
  'travis perkins', 'jewson', 'wickes', 'b&q', 'screwfix', 'toolstation',
  'corgi', 'gas safe', 'national grid',
  // Big property/facilities
  'savills', 'knight frank', 'jll', 'cbre', 'cushman', 'colliers',
  'countrywide', 'purplebricks', 'rightmove', 'zoopla',
  // Big cleaning/FM
  'iss ', 'sodexo', 'mitie', 'ocs group', 'initial ', 'rentokil', 'servest',
  // Big construction
  'barratt', 'persimmon', 'bellway', 'taylor wimpey', 'redrow', 'bovis',
  'kier ', 'amey ', 'carillion', 'galliford',
  // Big retail / general
  'tesco', 'asda', 'sainsbury', 'morrison', 'lidl', 'aldi', 'costa ',
  'mcdonald', 'subway', 'greggs', 'domino', 'pizza hut', 'kfc',
  'specsavers', 'vision express', 'specsaver',
  // Indicators of large corporate structure
  ' plc', ' holdings', ' group ltd', ' group plc',
];

function isBigBrand(name) {
  const lower = name.toLowerCase();
  return BIG_BRAND_KEYWORDS.some(k => lower.includes(k));
}

// ── Score a lead out of 10 ───────────────────────────────────────────────────

function scoreLead(lead) {
  let score = 0;
  if (lead.phone)     score += 2;   // verified contact
  if (lead.email)     score += 2;   // direct outreach
  if (lead.website)   score += 1;   // has online presence
  if (lead.ownerName) score += 2;   // personalised outreach possible
  if (lead.linkedin)  score += 2;   // additional contact channel
  if (lead.registrationDate) {
    const years = (Date.now() - new Date(lead.registrationDate)) / (1000 * 60 * 60 * 24 * 365);
    if (years <= 5) score += 1;     // newer business = more likely looking to grow
  }
  return Math.min(score, 10);
}

// ── Google Maps scraper ──────────────────────────────────────────────────────

async function scrapeGoogleMaps(businessType, location, targetCount = 20) {
  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
  });

  const page  = await context.newPage();
  let   leads = [];

  try {
    const query = `${businessType} in ${location}`;
    console.log(`\n🔍  Searching: "${query}"\n`);

    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });
    await jitter(3000);

    try {
      await page.locator('button:has-text("Accept all")').click({ timeout: 5000 });
      await sleep(1500);
    } catch { /* no cookie banner */ }

    // ── Collect place URLs ─────────────────────────────────────────────────
    console.log('📋  Collecting listings...');
    let feed = null;

    for (const sel of ['div[role="feed"]', 'div[aria-label*="Results for"]', 'div[aria-label*="result" i]']) {
      try {
        await page.locator(sel).waitFor({ state: 'visible', timeout: 15000 });
        feed = page.locator(sel).first();
        console.log(`   Feed found (${sel})`);
        break;
      } catch { /* try next */ }
    }

    const placeUrls = new Set();
    let prevSize = 0, stuckTicks = 0;

    if (feed) {
      while (placeUrls.size < targetCount + 10 && stuckTicks < 5) {
        const links = await page.$$eval('a[href*="/maps/place/"]',
          els => [...new Set(els.map(el => el.href.split('?')[0]))]
        );
        links.forEach(l => placeUrls.add(l));
        try { await feed.evaluate(el => el.scrollBy(0, 900)); } catch { break; }
        await jitter(1500);
        if (placeUrls.size === prevSize) stuckTicks++;
        else { stuckTicks = 0; prevSize = placeUrls.size; }
      }
    } else {
      const links = await page.$$eval('a[href*="/maps/place/"]',
        els => [...new Set(els.map(el => el.href.split('?')[0]))]
      );
      links.forEach(l => placeUrls.add(l));
    }

    if (placeUrls.size === 0) throw new Error('No listings found — check browser for CAPTCHA');
    console.log(`   Found ${placeUrls.size} listings.\n`);

    leads = await extractLeads(page, context, placeUrls, targetCount, location);

  } catch (err) {
    console.error(`\n❌  ${err.message}`);
  } finally {
    await browser.close();
  }

  return leads;
}

// ── Extract full details from each place URL ─────────────────────────────────

async function extractLeads(page, context, placeUrls, targetCount, location) {
  const leads     = [];
  const chKey     = process.env.COMPANIES_HOUSE_API_KEY || '';
  const hasChKey  = chKey.length > 0;

  if (!hasChKey) {
    console.log('  ℹ️  No COMPANIES_HOUSE_API_KEY set — registration dates will be skipped.\n');
  }

  const hotTarget  = 1;                       // leads with score ≥ 8
  const warmTarget = targetCount - hotTarget;  // rest with score ≥ 5

  for (const url of [...placeUrls]) {
    const hotCount  = leads.filter(l => l.score >= 8).length;
    const warmCount = leads.filter(l => l.score >= 5 && l.score < 8).length;
    if (hotCount >= hotTarget && warmCount >= warmTarget) break;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await jitter(rand(1500, 2500));

      // ── Business name ────────────────────────────────────────────────────
      const name = (await page.locator('h1').first().textContent({ timeout: 8000 }).catch(() => '')).trim();
      if (!name) continue;

      if (isBigBrand(name)) {
        console.log(`\n  ⏭️  Skipped (big brand): ${name}`);
        continue;
      }

      console.log(`\n  [${leads.length + 1}/${targetCount}] ${name}`);

      // ── Phone ────────────────────────────────────────────────────────────
      let phone = '';
      for (const sel of ['[data-item-id*="phone:tel:"]', '[aria-label*="Phone:"]', 'button[data-tooltip*="phone" i]']) {
        try {
          const el = page.locator(sel).first();
          const di = await el.getAttribute('data-item-id', { timeout: 2000 });
          const ar = await el.getAttribute('aria-label',   { timeout: 2000 });
          phone = (di?.replace(/phone:tel:/i, '') ?? ar?.replace(/phone:\s*/i, '') ?? '').trim();
          if (phone) break;
        } catch { /* try next */ }
      }

      // ── Website ──────────────────────────────────────────────────────────
      let website = '';
      for (const sel of ['a[data-item-id="authority"]', 'a[aria-label*="website" i]', 'a[href*="http"][data-item-id]']) {
        try {
          const href = await page.locator(sel).first().getAttribute('href', { timeout: 2000 });
          if (href?.startsWith('http')) { website = href; break; }
        } catch { /* try next */ }
      }

      // ── Email (from website) ─────────────────────────────────────────────
      let email = '';
      if (website) {
        process.stdout.write(`       📧 Finding email...`);
        email = await findEmail(context, website);
        console.log(email ? ` ${email}` : ' not found');
      }

      // ── Owner name (from website) ────────────────────────────────────────
      let ownerName = '';
      if (website) {
        process.stdout.write(`       👤 Finding owner name...`);
        ownerName = await findOwnerName(context, website, name);
        console.log(ownerName ? ` ${ownerName}` : ' not found');
      }

      // ── LinkedIn profile (via Bing) ──────────────────────────────────────
      process.stdout.write(`       🔗 Searching LinkedIn...`);
      const linkedin = await findLinkedIn(context, name, ownerName, location);
      console.log(linkedin ? ` ${linkedin}` : ' not found');

      // ── Companies House (registration date) ─────────────────────────────
      let registrationDate = '';
      let companyNumber    = '';
      if (hasChKey) {
        process.stdout.write(`       🏛️  Checking Companies House...`);
        const chInfo = await getCompaniesHouseInfo(name, chKey);
        if (chInfo) {
          registrationDate = chInfo.incorporationDate;
          companyNumber    = chInfo.companyNumber;
          console.log(registrationDate ? ` Registered ${registrationDate}` : ' not found');
        } else {
          console.log(' not found');
        }
      }

      // ── Score ────────────────────────────────────────────────────────────
      const lead = { name, phone, email, website, ownerName, linkedin, registrationDate, companyNumber };
      lead.score = scoreLead(lead);

      console.log(`       ⭐ Score: ${lead.score}/10`);
      const hotCount  = leads.filter(l => l.score >= 8).length;
      const warmCount = leads.filter(l => l.score >= 5 && l.score < 8).length;
      if (lead.score >= 8 && hotCount < hotTarget) {
        leads.push(lead);
      } else if (lead.score >= 5 && lead.score < 8 && warmCount < warmTarget) {
        leads.push(lead);
      } else {
        console.log(`       ↩️  Skipped — score too low or bucket full`);
        continue;
      }

    } catch (err) {
      console.log(`\n  ⚠️  Skipped a listing: ${err.message.split('\n')[0]}`);
    }
  }

  return leads.slice(0, targetCount);
}

// ── Save CSV ─────────────────────────────────────────────────────────────────

function saveCSV(leads, businessType, location) {
  const leadsDir = path.join(__dirname, 'leads');
  if (!fs.existsSync(leadsDir)) fs.mkdirSync(leadsDir);

  const date     = new Date().toISOString().slice(0, 10);
  const slug     = `${businessType}_${location}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const filepath = path.join(leadsDir, `leads_${slug}_${date}.csv`);

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'Business Name,Owner Name,Phone,Email,Website,LinkedIn,Registered,Score\n';
  const rows   = leads.map(l =>
    [esc(l.name), esc(l.ownerName), esc(l.phone), esc(l.email),
     esc(l.website), esc(l.linkedin), esc(l.registrationDate), esc(l.score)].join(',')
  ).join('\n');

  fs.writeFileSync(filepath, header + rows, 'utf8');
  return filepath;
}

// ── Save Excel ───────────────────────────────────────────────────────────────

async function saveExcel(leads, businessType, location) {
  const leadsDir = path.join(__dirname, 'leads');
  if (!fs.existsSync(leadsDir)) fs.mkdirSync(leadsDir);

  const date     = new Date();
  const dateStr  = date.toISOString().slice(0, 10);
  const slug     = `${businessType}_${location}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const filepath = path.join(leadsDir, `LeadSeeds_${slug}_${dateStr}.xlsx`);

  // ── Palette ───────────────────────────────────────────────────────────────
  const C = {
    black:      'FF0A0F0A',
    headerBg:   'FF134E22',   // deep forest green
    headerBg2:  'FF0F3D1A',   // slightly darker for second header row
    rowEven:    'FFF7FBF7',   // near-white with green tint
    rowOdd:     'FFECF5EC',   // very light green
    accent:     'FF16A34A',   // bright green
    accentDark: 'FF134E22',   // dark green
    accentLight:'FF4ADE80',   // light green
    text:       'FF111827',   // near black
    textMid:    'FF374151',   // medium grey
    textMuted:  'FF6B7280',   // muted grey
    white:      'FFFFFFFF',
    hotBg:      'FFECFDF5',   // light green tint — hot lead
    hotText:    'FF065F46',
    warmBg:     'FFFEFCE8',   // light amber tint — warm lead
    warmText:   'FF92400E',
    coldBg:     'FFFFF1F2',   // light red tint — cold lead
    coldText:   'FF9F1239',
    borderOuter:'FF16A34A',
    borderInner:'FFD1FAE5',
  };

  function scoreLabel(s) {
    if (s >= 8) return 'Hot';
    if (s >= 5) return 'Warm';
    return 'Cold';
  }
  function scoreBg(s)   { return s >= 8 ? C.hotBg   : s >= 5 ? C.warmBg   : C.coldBg;   }
  function scoreText(s) { return s >= 8 ? C.hotText  : s >= 5 ? C.warmText  : C.coldText;  }
  function scoreDot(s)  {
    const filled = Math.round(s / 2);
    return '●'.repeat(filled) + '○'.repeat(5 - filled);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'LeadSeeds';
  wb.created  = date;
  wb.modified = date;

  // ════════════════════════════════════════════════════════════════════════════
  // Sheet 1 — Leads
  // ════════════════════════════════════════════════════════════════════════════
  const ws = wb.addWorksheet('Leads', {
    properties: { tabColor: { argb: C.accent } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 8, activeCell: 'A9' }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { key: 'num',      width: 5  },
    { key: 'name',     width: 30 },
    { key: 'owner',    width: 22 },
    { key: 'phone',    width: 17 },
    { key: 'email',    width: 32 },
    { key: 'website',  width: 28 },
    { key: 'linkedin', width: 16 },
    { key: 'regdate',  width: 13 },
    { key: 'status',   width: 8  },
    { key: 'score',    width: 14 },
  ];

  // helper to fill a merged row
  const mergedRow = (ref, value, fontOpts, fillColor, height, alignOpts = {}) => {
    ws.mergeCells(ref);
    const cell = ws.getCell(ref.split(':')[0]);
    cell.value     = value;
    cell.font      = { name: 'Calibri', ...fontOpts };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
    cell.alignment = { vertical: 'middle', wrapText: false, ...alignOpts };
    const rowNum   = parseInt(ref.match(/\d+/)[0]);
    ws.getRow(rowNum).height = height;
  };

  // ── Row 1: Brand banner ───────────────────────────────────────────────────
  mergedRow('A1:J1', 'LEADSEEDS',
    { bold: true, size: 26, color: { argb: C.white }, charset: 1 },
    C.accentDark, 48,
    { horizontal: 'center' }
  );

  // ── Row 2: Report title ───────────────────────────────────────────────────
  mergedRow('A2:J2',
    `Verified Lead Report  |  ${businessType.toUpperCase()}  |  ${location.toUpperCase()}`,
    { size: 11, bold: false, color: { argb: C.accentLight }, italic: true },
    C.headerBg, 22,
    { horizontal: 'center' }
  );

  // ── Row 3: Stats bar (4 cells) ────────────────────────────────────────────
  ws.getRow(3).height = 28;
  const withPhone   = leads.filter(l => l.phone).length;
  const withEmail   = leads.filter(l => l.email).length;
  const withOwner   = leads.filter(l => l.ownerName).length;
  const withLinkedIn= leads.filter(l => l.linkedin).length;
  const avgScore    = leads.length ? (leads.reduce((s,l) => s + l.score, 0) / leads.length).toFixed(1) : 0;
  const hotCount    = leads.filter(l => l.score >= 8).length;

  const stats = [
    [`${leads.length} Leads`, 'A3:B3'],
    [`${hotCount} Hot  |  Avg Score ${avgScore}/10`, 'C3:E3'],
    [`${withPhone} Phone  |  ${withEmail} Email  |  ${withOwner} Owner  |  ${withLinkedIn} LinkedIn`, 'F3:H3'],
    [`Generated ${date.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })}`, 'I3:J3'],
  ];
  stats.forEach(([val, ref]) => {
    ws.mergeCells(ref);
    const cell = ws.getCell(ref.split(':')[0]);
    cell.value     = val;
    cell.font      = { name: 'Calibri', size: 10, bold: true, color: { argb: C.accentLight } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg2 } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // ── Row 4: thin divider ───────────────────────────────────────────────────
  ws.mergeCells('A4:J4');
  ws.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.accent } };
  ws.getRow(4).height   = 3;

  // ── Rows 5–7: empty padding with header bg ────────────────────────────────
  [5, 6, 7].forEach(r => {
    ws.mergeCells(`A${r}:J${r}`);
    ws.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.rowEven } };
    ws.getRow(r).height = 6;
  });

  // ── Row 8: Column headers ─────────────────────────────────────────────────
  const COLS = ['#', 'Business Name', 'Owner Name', 'Phone', 'Email', 'Website', 'LinkedIn', 'Reg. Date', 'Status', 'Score'];
  const hdrRow = ws.addRow(COLS);  // row 8
  hdrRow.height = 30;

  hdrRow.eachCell((cell, col) => {
    cell.font      = { name: 'Calibri', bold: true, size: 10, color: { argb: C.white } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.accentDark } };
    cell.alignment = {
      vertical:   'middle',
      horizontal: col === 1 || col >= 9 ? 'center' : 'left',
      indent:     col === 1 || col >= 9 ? 0 : 1,
    };
    cell.border = {
      bottom: { style: 'medium', color: { argb: C.accent } },
      top:    { style: 'thin',   color: { argb: C.accentDark } },
    };
  });

  // Enable auto-filter on the header row
  ws.autoFilter = { from: 'A8', to: 'J8' };

  // ── Data rows (start at row 9) ────────────────────────────────────────────
  leads.forEach((lead, i) => {
    const bg       = i % 2 === 0 ? C.rowEven : C.rowOdd;
    const status   = scoreLabel(lead.score);
    const sBg      = scoreBg(lead.score);
    const sText    = scoreText(lead.score);
    const dots     = scoreDot(lead.score);

    const row = ws.addRow([
      i + 1,
      lead.name             || '',
      lead.ownerName        || '',
      lead.phone            || '',
      lead.email            || '',
      lead.website          || '',
      lead.linkedin         ? 'View Profile' : '',
      lead.registrationDate || '',
      status,
      `${dots}  ${lead.score}/10`,
    ]);
    row.height = 24;

    const innerBorder = { style: 'hair', color: { argb: C.borderInner } };
    const B = { top: innerBorder, bottom: innerBorder, left: innerBorder, right: innerBorder };

    // Apply base bg + border to all cells first
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = B;
    });

    // # — row number
    Object.assign(row.getCell(1), {
      font:      { name: 'Calibri', size: 9, color: { argb: C.textMuted }, bold: true },
      alignment: { vertical: 'middle', horizontal: 'center' },
    });

    // Business name — bold, prominent
    Object.assign(row.getCell(2), {
      font:      { name: 'Calibri', size: 11, bold: true, color: { argb: C.text } },
      alignment: { vertical: 'middle', indent: 1 },
    });

    // Owner name — medium weight
    Object.assign(row.getCell(3), {
      font:      { name: 'Calibri', size: 10, color: { argb: C.textMid } },
      alignment: { vertical: 'middle', indent: 1 },
    });

    // Phone
    Object.assign(row.getCell(4), {
      font:      { name: 'Calibri', size: 10, color: { argb: C.textMid } },
      alignment: { vertical: 'middle', indent: 1 },
    });

    // Email
    Object.assign(row.getCell(5), {
      font:      { name: 'Calibri', size: 10, color: { argb: C.textMid } },
      alignment: { vertical: 'middle', indent: 1 },
    });

    // Website — hyperlink
    if (lead.website) {
      row.getCell(6).value     = { text: new URL(lead.website).hostname.replace('www.',''), hyperlink: lead.website };
      row.getCell(6).font      = { name: 'Calibri', size: 10, color: { argb: C.accent }, underline: true };
      row.getCell(6).alignment = { vertical: 'middle', indent: 1 };
    }

    // LinkedIn — hyperlink
    if (lead.linkedin) {
      row.getCell(7).value     = { text: 'View Profile', hyperlink: lead.linkedin };
      row.getCell(7).font      = { name: 'Calibri', size: 10, color: { argb: C.accent }, underline: true };
      row.getCell(7).alignment = { vertical: 'middle', horizontal: 'center' };
    }

    // Reg. date
    Object.assign(row.getCell(8), {
      font:      { name: 'Calibri', size: 10, color: { argb: C.textMuted } },
      alignment: { vertical: 'middle', horizontal: 'center' },
    });

    // Status badge — coloured cell
    Object.assign(row.getCell(9), {
      font:      { name: 'Calibri', size: 10, bold: true, color: { argb: sText } },
      fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: sBg } },
      alignment: { vertical: 'middle', horizontal: 'center' },
      border:    B,
    });

    // Score with dot bar
    Object.assign(row.getCell(10), {
      font:      { name: 'Calibri', size: 9, bold: true, color: { argb: sText } },
      fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: sBg } },
      alignment: { vertical: 'middle', horizontal: 'center' },
      border:    B,
    });
  });

  // ── Outer border around the full table ────────────────────────────────────
  const firstDataRow = 8;
  const lastDataRow  = 8 + leads.length;
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    const row = ws.getRow(r);
    const setEdge = (col, side) => {
      const cell = row.getCell(col);
      cell.border = { ...(cell.border || {}), [side]: { style: 'medium', color: { argb: C.borderOuter } } };
    };
    setEdge(1,  'left');
    setEdge(10, 'right');
    if (r === firstDataRow)  { for (let c = 1; c <= 10; c++) { const cell = row.getCell(c); cell.border = { ...(cell.border||{}), top: { style: 'medium', color: { argb: C.borderOuter } } }; } }
    if (r === lastDataRow)   { for (let c = 1; c <= 10; c++) { const cell = row.getCell(c); cell.border = { ...(cell.border||{}), bottom: { style: 'medium', color: { argb: C.borderOuter } } }; } }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  ws.addRow([]);
  const footerRow = ws.addRow(['', 'LeadSeeds — We find your first customers so you can focus on your business  |  Delivered within 5 hours']);
  ws.mergeCells(`B${footerRow.number}:J${footerRow.number}`);
  footerRow.height = 20;
  Object.assign(footerRow.getCell(2), {
    font:      { name: 'Calibri', size: 9, italic: true, color: { argb: C.textMuted } },
    alignment: { vertical: 'middle' },
  });
  footerRow.eachCell({ includeEmpty: true }, cell => {
    if (!cell.fill || cell.fill.fgColor?.argb !== C.rowEven)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.rowEven } };
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Sheet 2 — Summary
  // ════════════════════════════════════════════════════════════════════════════
  const ws2 = wb.addWorksheet('Summary', {
    properties: { tabColor: { argb: C.accentDark } },
  });
  ws2.columns = [{ width: 28 }, { width: 20 }];

  ws2.mergeCells('A1:B1');
  const s1 = ws2.getCell('A1');
  s1.value = 'LEADSEEDS — SUMMARY'; s1.font = { name: 'Calibri', bold: true, size: 14, color: { argb: C.white } };
  s1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.accentDark } };
  s1.alignment = { vertical: 'middle', horizontal: 'center' }; ws2.getRow(1).height = 36;

  const summaryData = [
    ['Report', ''],
    ['Business Type', businessType],
    ['Location', location],
    ['Generated', date.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })],
    ['', ''],
    ['Lead Stats', ''],
    ['Total Leads', leads.length],
    ['Warm Leads (5-7)', leads.filter(l => l.score >= 5 && l.score < 8).length],
    ['Cold Leads (1-4)', leads.filter(l => l.score < 5).length],
    ['', ''],
    ['Data Coverage', ''],
    ['With Phone',      `${withPhone} / ${leads.length}`],
    ['With Email',      `${withEmail} / ${leads.length}`],
    ['With Owner Name', `${withOwner} / ${leads.length}`],
    ['With LinkedIn',   `${withLinkedIn} / ${leads.length}`],
  ];

  summaryData.forEach(([ label, value ], i) => {
    const r = ws2.addRow([label, value]);
    r.height = 22;
    const isHeader = value === '' && label !== '';
    r.getCell(1).font = { name: 'Calibri', size: 10, bold: isHeader, color: { argb: isHeader ? C.accentDark : C.textMid } };
    r.getCell(2).font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.text } };
    const bg = isHeader ? C.headerBg : (i % 2 === 0 ? C.rowEven : C.rowOdd);
    r.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      if (isHeader) cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } };
    });
  });

  await wb.xlsx.writeFile(filepath);
  return filepath;
}

// ── Entry point ──────────────────────────────────────────────────────────────

// ── Natural language input parser ────────────────────────────────────────────
// Handles inputs like:
//   "plumbers in Chester"
//   "I need to find new trade businesses in Chester"
//   "find me accountants near Manchester"

function parseSearchInput(raw) {
  let text = raw.trim();

  // Strip leading filler phrases
  const fillerPhrases = [
    /^i need to find( new| local| some)?\s*/i,
    /^find( me| new| local| some)?\s*/i,
    /^looking for( new| local| some)?\s*/i,
    /^search for( new| local| some)?\s*/i,
    /^get me( new| local| some)?\s*/i,
    /^show me( new| local| some)?\s*/i,
    /^i want( to find)?\s*/i,
    /^can you find( me)?\s*/i,
  ];
  for (const re of fillerPhrases) text = text.replace(re, '');

  // Extract location after "in", "near", "around", "at", "within"
  const locationMatch = text.match(/\b(?:in|near|around|at|within)\s+([A-Za-z\s]+?)(?:\s*$)/i);
  const location = locationMatch ? locationMatch[1].trim() : '';

  // Remove the location part from the remaining text to get business type
  let businessType = text;
  if (locationMatch) {
    businessType = text.slice(0, locationMatch.index).trim();
  }

  // Strip generic noise words — but NOT trade/service descriptors like "trade", "cleaning"
  const raw2 = businessType;
  businessType = businessType
    .replace(/\b(new|local|small|independent|nearby|businesses?|companies|tradespeople|tradespersons?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If stripping left nothing, fall back to the pre-stripped value
  if (!businessType) businessType = raw2.trim();

  // Last resort: if still no location, check if the final word looks like a place name
  // e.g. "electrician Chester" → type: electrician, location: Chester
  if (!location) {
    const words = businessType.split(/\s+/);
    if (words.length >= 2) {
      const lastWord = words[words.length - 1];
      if (/^[A-Z]/.test(lastWord)) {
        return { businessType: words.slice(0, -1).join(' '), location: lastWord };
      }
    }
  }

  return { businessType, location };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🌱  LeadSeeds — Google Maps Lead Scraper v2');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('  You can type naturally, e.g.:');
  console.log('    "plumbers in Chester"');
  console.log('    "I need to find new trade businesses in Chester"');
  console.log('    "accountants near Manchester"\n');

  const raw = await prompt('What are you looking for? ');
  if (!raw) { console.log('\n❌  Please enter a search.'); process.exit(1); }

  let { businessType, location } = parseSearchInput(raw);

  // If we couldn't extract location, ask for it separately
  if (!location) {
    console.log(`  Detected business type: "${businessType || raw}"`);
    location = await prompt('  Which town or city? ');
  }

  // If business type is still empty, fall back to the raw input
  if (!businessType) businessType = raw.replace(/\bin\s+.+$/i, '').trim() || raw;

  // Confirm what we're searching for
  console.log(`\n  Searching for: "${businessType}" in "${location}"\n`);

  if (!location) {
    console.log('\n❌  Could not determine a location. Please try again.');
    process.exit(1);
  }

  const leads = await scrapeGoogleMaps(businessType, location, 20);

  if (leads.length === 0) {
    console.log('\n❌  No leads extracted. Try a broader search term or different location.');
    return;
  }

  const csvPath   = saveCSV(leads, businessType, location);
  const excelPath = await saveExcel(leads, businessType, location);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅  ${leads.length} leads saved:`);
  console.log(`  📊  Excel → ${excelPath}`);
  console.log(`  📄  CSV   → ${csvPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Print summary table
  const w   = [24, 18, 14, 28, 6];
  const row = cols => cols.map((c, i) => String(c ?? '').slice(0, w[i]).padEnd(w[i])).join('  ');
  console.log(row(['Business', 'Owner', 'Phone', 'Email', 'Score']));
  console.log('─'.repeat(96));
  leads.forEach(l => console.log(row([
    l.name, l.ownerName || '—', l.phone || '—', l.email || '—', `${l.score}/10`
  ])));
  console.log('');

  const avg = (leads.reduce((s, l) => s + l.score, 0) / leads.length).toFixed(1);
  console.log(`  Average lead score: ${avg}/10`);
  console.log(`  Leads with owner name: ${leads.filter(l => l.ownerName).length}/${leads.length}`);
  console.log(`  Leads with LinkedIn:   ${leads.filter(l => l.linkedin).length}/${leads.length}`);
  console.log(`  Leads with email:      ${leads.filter(l => l.email).length}/${leads.length}\n`);
}

main().catch(err => { console.error('\n💥  Fatal error:', err.message); process.exit(1); });
