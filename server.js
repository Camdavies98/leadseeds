require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const Stripe = require('stripe');

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
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
            unit_amount: 6000,  // £60.00
            recurring: { interval: 'month' },
            product_data: { name: 'LeadSeeds — 20 Verified Leads/Month' },
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
