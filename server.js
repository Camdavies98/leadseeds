require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendNotification(data) {
  const { name, email, businessType, idealCustomer, location, timestamp } = data;

  await transporter.sendMail({
    from: `"LeadSeeds" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: `🌱 New LeadSeeds signup — ${name}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f1a0f;color:#f1f5f9;border-radius:12px;overflow:hidden;">
        <div style="background:#16a34a;padding:24px 32px;">
          <h1 style="margin:0;font-size:22px;color:#fff;">🌱 New LeadSeeds Signup</h1>
          <p style="margin:4px 0 0;color:#bbf7d0;font-size:14px;">${timestamp}</p>
        </div>
        <div style="padding:28px 32px;">
          <table style="width:100%;border-collapse:collapse;font-size:15px;">
            <tr><td style="padding:10px 0;color:#86efac;font-weight:600;width:160px;">Full Name</td><td style="padding:10px 0;color:#f1f5f9;">${name}</td></tr>
            <tr><td style="padding:10px 0;color:#86efac;font-weight:600;">Email</td><td style="padding:10px 0;color:#f1f5f9;">${email}</td></tr>
            <tr><td style="padding:10px 0;color:#86efac;font-weight:600;">Business Type</td><td style="padding:10px 0;color:#f1f5f9;">${businessType}</td></tr>
            <tr><td style="padding:10px 0;color:#86efac;font-weight:600;">Ideal Customer</td><td style="padding:10px 0;color:#f1f5f9;">${idealCustomer}</td></tr>
            <tr><td style="padding:10px 0;color:#86efac;font-weight:600;">Target Location</td><td style="padding:10px 0;color:#f1f5f9;">${location}</td></tr>
          </table>
        </div>
        <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.08);font-size:13px;color:#4b7a4b;">
          LeadSeeds — 20 verified leads/month
        </div>
      </div>
    `,
  });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Landing page
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }

  // Static files
  if (req.method === 'GET') {
    const filePath = path.join(__dirname, decodeURIComponent(req.url));
    const ext = path.extname(filePath).toLowerCase();
    if (MIME_TYPES[ext] && fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // Signup form submission
  if (req.method === 'POST' && req.url === '/signup') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { name, email, businessType, idealCustomer, location } = JSON.parse(body);

        const timestamp = new Date().toLocaleString('en-GB', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false,
        });

        await sendNotification({ name, email, businessType, idealCustomer, location, timestamp });
        console.log(`✅ New signup emailed: ${name} <${email}>`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Error processing signup:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`🌱 LeadSeeds running at http://localhost:${PORT}`);
});
