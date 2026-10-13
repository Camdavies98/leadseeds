require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const Stripe = require('stripe');
const { Resend } = require('resend');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('ERROR: STRIPE_SECRET_KEY environment variable is not set.');
  process.exit(1);
}

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Save signup to CSV ────────────────────────────────────────────────────────

function saveSignup(data) {
  const csvPath = path.join(__dirname, 'leadseed_clients.csv');
  const exists  = fs.existsSync(csvPath);
  const esc     = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  if (!exists) {
    fs.writeFileSync(csvPath, 'Name,Email,BusinessType,IdealCustomer,Location,SignedUpAt\n', 'utf8');
  }
  const row = [
    esc(data.name), esc(data.email), esc(data.businessType),
    esc(data.idealCustomer), esc(data.location),
    esc(new Date().toISOString()),
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, row, 'utf8');
}

// ── Read raw body (for Stripe webhook signature verification) ─────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Parse JSON body ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {

  // POST /webhook — Stripe event listener
  if (req.method === 'POST' && req.url === '/webhook') {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      const rawBody = await readRawBody(req);
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      res.writeHead(400);
      res.end(`Webhook Error: ${err.message}`);
      return;
    }

    if (event.type === 'checkout.session.completed') {
      const session  = event.data.object;
      const name     = session.metadata?.name         || 'Unknown';
      const email    = session.customer_email          || 'Unknown';
      const bizType  = session.metadata?.businessType || 'Unknown';
      const location = session.metadata?.location     || 'Unknown';

      try {
        await resend.emails.send({
          from:    'onboarding@resend.dev',
          to:      'camdavies000@gmail.com',
          subject: `New LeadSeeds client: ${name}`,
          text:    `New paying client!\n\nName: ${name}\nEmail: ${email}\nBusiness type: ${bizType}\nLocation: ${location}\n\nRun the scraper and send their first batch.`,
        });
      } catch (err) {
        console.error('Failed to send notification email:', err.message);
      }
    }

    res.writeHead(200);
    res.end();
    return;
  }

  // POST /signup — save client details + redirect to Stripe Checkout
  if (req.method === 'POST' && req.url === '/signup') {
    try {
      const data = await readBody(req);
      saveSignup(data);

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{
          price_data: {
            currency: 'gbp',
            unit_amount: 5000,  // £50.00
            recurring: { interval: 'month' },
            product_data: { name: 'LeadSeeds — 20 Verified Leads Per Week' },
          },
          quantity: 1,
        }],
        customer_email: data.email,
        success_url: `${BASE_URL}/success`,
        cancel_url:  `${BASE_URL}/#signup`,
        metadata: {
          name:         data.name,
          businessType: data.businessType,
          location:     data.location,
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: session.url }));
    } catch (err) {
      console.error('Signup error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Something went wrong' }));
    }
    return;
  }

  // GET /checkout — direct to Stripe Checkout (used by Get Started buttons)
  if (req.method === 'GET' && req.url === '/checkout') {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{
          price_data: {
            currency: 'gbp',
            unit_amount: 5000,
            recurring: { interval: 'month' },
            product_data: { name: 'LeadSeeds — 20 Verified Leads Per Week' },
          },
          quantity: 1,
        }],
        success_url: `${BASE_URL}/success`,
        cancel_url:  `${BASE_URL}/`,
      });
      res.writeHead(302, { Location: session.url });
      res.end();
    } catch (err) {
      console.error('Checkout error:', err.message);
      res.writeHead(500);
      res.end('Something went wrong');
    }
    return;
  }

  // GET /success — post-payment confirmation page
  if (req.method === 'GET' && req.url === '/success') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'success.html')));
    return;
  }

  // Default — serve landing page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
});

server.listen(PORT, () => {
  console.log(`LeadSeeds running on port ${PORT}`);
});
