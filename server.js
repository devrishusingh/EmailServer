'use strict';

const { SMTPServer }   = require('smtp-server');
const { simpleParser } = require('mailparser');
const express          = require('express');
const expressWs        = require('express-ws');
const cron             = require('node-cron');
const fs               = require('fs');
const path             = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const DOMAIN          = 'rishurajput.com';
const SMTP_PORT       = 25;          // standard incoming SMTP
const SMTP_PORT_ALT   = 587;         // submission fallback
const WEB_PORT        = 3000;        // dashboard
const EMAIL_DIR       = path.join(__dirname, 'emails');  // flat-file store
const MAX_EMAIL_AGE_H = 24;          // auto-delete after N hours
const MAX_EMAILS      = 500;         // cap in memory

// ─── Storage (in-memory + flat JSON files, no DB) ────────────────────────────
if (!fs.existsSync(EMAIL_DIR)) fs.mkdirSync(EMAIL_DIR, { recursive: true });

/** Load all saved emails from disk into memory on startup */
function loadEmails() {
  const files = fs.readdirSync(EMAIL_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(EMAIL_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => b.receivedAt - a.receivedAt);
}

let emailStore = loadEmails();   // { id, to, from, subject, text, html, attachments, receivedAt }
const wsClients = new Set();    // connected dashboard browser tabs

function saveEmail(email) {
  const filePath = path.join(EMAIL_DIR, `${email.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(email, null, 2), 'utf8');
}

function broadcastNew(email) {
  const payload = JSON.stringify({ type: 'NEW_EMAIL', email });
  wsClients.forEach(ws => { try { ws.send(payload); } catch {} });
}

// ─── SMTP Server ─────────────────────────────────────────────────────────────
function createSMTP(port) {
  const server = new SMTPServer({
    name: `mail.${DOMAIN}`,
    banner: `${DOMAIN} mail server ready`,

    // Accept any sender / no auth required (open relay for OUR domain only)
    authOptional: true,
    disabledCommands: ['AUTH'],    // no auth needed for inbound MX

    // Only accept mail addressed TO @rishurajput.com
    onRcptTo(address, session, cb) {
      const dest = (address.address || '').toLowerCase();
      if (dest.endsWith(`@${DOMAIN}`)) {
        return cb();  // accept
      }
      return cb(new Error(`Only @${DOMAIN} addresses accepted`));
    },

    // Parse and store each incoming message
    onData(stream, session, cb) {
      const rcptTo  = session.envelope.rcptTo.map(r => r.address);
      const mailFrom = session.envelope.mailFrom?.address || 'unknown';
      const chunks  = [];

      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        try {
          const parsed = await simpleParser(raw);
          const email = {
            id:          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            to:          rcptTo,
            from:        mailFrom,
            fromName:    parsed.from?.text || mailFrom,
            subject:     parsed.subject   || '(no subject)',
            text:        parsed.text      || '',
            html:        parsed.html      || '',
            attachments: (parsed.attachments || []).map(a => ({
              filename:    a.filename,
              contentType: a.contentType,
              size:        a.size,
            })),
            headers:     Object.fromEntries(
              [...(parsed.headers || new Map()).entries()].slice(0, 20)
            ),
            receivedAt:  Date.now(),
          };

          // Store
          emailStore.unshift(email);
          if (emailStore.length > MAX_EMAILS) emailStore.pop();
          saveEmail(email);
          broadcastNew(email);

          console.log(`[SMTP:${port}] ✉  ${mailFrom} → ${rcptTo.join(', ')} | "${email.subject}"`);
          cb();
        } catch (err) {
          console.error('[SMTP] Parse error:', err.message);
          cb(err);
        }
      });
      stream.on('error', cb);
    },

    // Lenient TLS – no cert needed for plain SMTP on port 25
    secure: false,
    logger: false,
  });

  server.on('error', err => console.error(`[SMTP:${port}] Error:`, err.message));

  server.listen(port, '0.0.0.0', () =>
    console.log(`[SMTP] Listening on 0.0.0.0:${port} for @${DOMAIN}`)
  );

  return server;
}

// ─── Auto-cleanup (runs every hour) ──────────────────────────────────────────
cron.schedule('0 * * * *', () => {
  const cutoff = Date.now() - MAX_EMAIL_AGE_H * 3600 * 1000;
  const before = emailStore.length;
  emailStore = emailStore.filter(e => {
    if (e.receivedAt < cutoff) {
      try { fs.unlinkSync(path.join(EMAIL_DIR, `${e.id}.json`)); } catch {}
      return false;
    }
    return true;
  });
  const removed = before - emailStore.length;
  if (removed > 0) console.log(`[CRON] Cleaned ${removed} email(s) older than ${MAX_EMAIL_AGE_H}h`);
});

// ─── Web Dashboard ────────────────────────────────────────────────────────────
const app = express();
expressWs(app);
app.use(express.json());

// WebSocket – live push
app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

// API: list emails for an address  GET /api/inbox/:address
app.get('/api/inbox/:address', (req, res) => {
  const addr = req.params.address.toLowerCase();
  const full  = addr.includes('@') ? addr : `${addr}@${DOMAIN}`;
  const mails = emailStore.filter(e =>
    e.to.some(t => t.toLowerCase() === full)
  );
  res.json(mails);
});

// API: single email  GET /api/email/:id
app.get('/api/email/:id', (req, res) => {
  const email = emailStore.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(email);
});

// API: delete email  DELETE /api/email/:id
app.delete('/api/email/:id', (req, res) => {
  const idx = emailStore.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [email] = emailStore.splice(idx, 1);
  try { fs.unlinkSync(path.join(EMAIL_DIR, `${email.id}.json`)); } catch {}
  res.json({ ok: true });
});

// API: stats
app.get('/api/stats', (_req, res) => {
  res.json({
    total:    emailStore.length,
    domain:   DOMAIN,
    uptime:   process.uptime(),
  });
});

// Dashboard HTML (single-page, zero build-step)
app.get('/', (_req, res) => {
  res.send(DASHBOARD_HTML);
});

app.listen(WEB_PORT, '0.0.0.0', () =>
  console.log(`[WEB]  Dashboard → http://0.0.0.0:${WEB_PORT}`)
);

// ─── Start SMTP servers ───────────────────────────────────────────────────────
createSMTP(SMTP_PORT);
createSMTP(SMTP_PORT_ALT);

console.log(`\n🚀  ${DOMAIN} email server started`);
console.log(`    Receiving mail for *@${DOMAIN}`);
console.log(`    Dashboard: http://localhost:${WEB_PORT}`);
console.log(`    Emails saved to: ${EMAIL_DIR}\n`);

// ─── Embedded Dashboard HTML ─────────────────────────────────────────────────
const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${DOMAIN} Temp Mail</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
  header{background:#1e293b;padding:16px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #334155}
  header h1{font-size:1.3rem;font-weight:700;color:#38bdf8}
  header span{font-size:.8rem;color:#64748b;margin-left:auto}
  .live-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .container{display:flex;height:calc(100vh - 57px)}
  .sidebar{width:340px;border-right:1px solid #1e293b;display:flex;flex-direction:column;background:#0f172a}
  .search-box{padding:12px}
  .search-box input{width:100%;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 12px;color:#e2e8f0;font-size:.85rem;outline:none}
  .search-box input:focus{border-color:#38bdf8}
  .inbox-list{flex:1;overflow-y:auto;padding:0 8px 8px}
  .email-card{background:#1e293b;border-radius:8px;padding:12px;margin-bottom:6px;cursor:pointer;border:2px solid transparent;transition:border .15s}
  .email-card:hover{border-color:#334155}
  .email-card.active{border-color:#38bdf8}
  .email-card .to{font-size:.7rem;color:#38bdf8;font-weight:600;margin-bottom:2px}
  .email-card .subject{font-size:.85rem;font-weight:600;color:#f1f5f9;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .email-card .from{font-size:.75rem;color:#94a3b8}
  .email-card .time{font-size:.7rem;color:#475569;float:right}
  .email-card .snippet{font-size:.75rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
  .main{flex:1;overflow-y:auto;background:#111827}
  .address-bar{padding:16px 24px;border-bottom:1px solid #1e293b;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .address-bar input{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 12px;color:#e2e8f0;font-size:.9rem;flex:1;outline:none;min-width:200px}
  .address-bar input:focus{border-color:#38bdf8}
  .address-bar button{background:#38bdf8;color:#0f172a;border:none;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer;font-size:.85rem}
  .address-bar .domain{color:#64748b;font-size:.9rem;white-space:nowrap}
  .viewer{padding:24px;max-width:900px}
  .viewer h2{font-size:1.1rem;font-weight:700;margin-bottom:12px;color:#f1f5f9}
  .meta{background:#1e293b;border-radius:8px;padding:14px;margin-bottom:16px;font-size:.82rem;color:#94a3b8}
  .meta div{margin-bottom:5px} .meta strong{color:#cbd5e1;min-width:70px;display:inline-block}
  .body-frame{background:#fff;border-radius:8px;overflow:hidden;min-height:300px}
  .body-plain{background:#1e293b;border-radius:8px;padding:16px;font-size:.85rem;color:#cbd5e1;white-space:pre-wrap;line-height:1.6}
  .tabs{display:flex;gap:4px;margin-bottom:12px}
  .tabs button{background:#1e293b;border:none;color:#94a3b8;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.82rem}
  .tabs button.active{background:#38bdf8;color:#0f172a;font-weight:700}
  .del-btn{float:right;background:#ef4444;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:.78rem;margin-top:-2px}
  .empty{color:#475569;text-align:center;padding:60px 20px;font-size:.9rem}
  .badge{background:#38bdf8;color:#0f172a;border-radius:999px;font-size:.65rem;font-weight:700;padding:1px 6px;margin-left:6px}
</style>
</head>
<body>
<header>
  <div class="live-dot"></div>
  <h1>📬 ${DOMAIN} — Temp Mail</h1>
  <span id="stats"></span>
</header>
<div class="container">
  <div class="sidebar">
    <div class="search-box">
      <input id="filterInput" placeholder="Filter inbox…" oninput="renderList()"/>
    </div>
    <div class="inbox-list" id="inboxList">
      <div class="empty">Enter an address above<br>to view its inbox</div>
    </div>
  </div>
  <div class="main">
    <div class="address-bar">
      <input id="addrInput" placeholder="username" onkeydown="if(event.key==='Enter')fetchInbox()"/>
      <span class="domain">@${DOMAIN}</span>
      <button onclick="fetchInbox()">Check Inbox</button>
    </div>
    <div class="viewer" id="viewer">
      <div class="empty" style="padding-top:80px">
        👆 Enter any username and click <strong>Check Inbox</strong><br><br>
        Any email sent to <strong>anything@${DOMAIN}</strong><br>will appear here in real-time.
      </div>
    </div>
  </div>
</div>
<script>
let allEmails = [];
let currentAddr = '';
let currentId = null;

// ── WebSocket live push ──────────────────────────────────────────────────────
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(proto + '://' + location.host + '/ws');
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'NEW_EMAIL') {
    const em = msg.email;
    if (currentAddr && em.to.some(t => t.toLowerCase() === currentAddr)) {
      allEmails.unshift(em);
      renderList();
      showNotification(em);
    }
  }
};

// ── Fetch inbox ───────────────────────────────────────────────────────────────
async function fetchInbox() {
  const username = document.getElementById('addrInput').value.trim();
  if (!username) return;
  currentAddr = username.toLowerCase() + '@${DOMAIN}';
  const res = await fetch('/api/inbox/' + encodeURIComponent(currentAddr));
  allEmails = await res.json();
  renderList();
  document.getElementById('viewer').innerHTML =
    '<div class="empty" style="padding-top:80px">Select an email to read it</div>';
}

// ── Render sidebar list ───────────────────────────────────────────────────────
function renderList() {
  const filter = document.getElementById('filterInput').value.toLowerCase();
  const list = document.getElementById('inboxList');
  const emails = allEmails.filter(e =>
    !filter ||
    e.subject.toLowerCase().includes(filter) ||
    e.from.toLowerCase().includes(filter)
  );
  if (!emails.length) {
    list.innerHTML = '<div class="empty">No emails yet.<br>Waiting for messages…</div>';
    return;
  }
  list.innerHTML = emails.map(e => \`
    <div class="email-card \${e.id === currentId ? 'active' : ''}" onclick="openEmail('\${e.id}')">
      <div class="time">\${timeAgo(e.receivedAt)}</div>
      <div class="to">\${e.to.join(', ')}</div>
      <div class="subject">\${esc(e.subject)}</div>
      <div class="from">From: \${esc(e.fromName || e.from)}</div>
      <div class="snippet">\${esc((e.text||'').slice(0,80))}</div>
    </div>
  \`).join('');
}

// ── Open single email ─────────────────────────────────────────────────────────
async function openEmail(id) {
  currentId = id;
  renderList();
  const res = await fetch('/api/email/' + id);
  if (!res.ok) return;
  const e = await res.json();
  const hasHtml = !!e.html;
  document.getElementById('viewer').innerHTML = \`
    <div class="viewer">
      <h2>\${esc(e.subject)} <button class="del-btn" onclick="deleteEmail('\${e.id}')">🗑 Delete</button></h2>
      <div class="meta">
        <div><strong>From:</strong> \${esc(e.fromName)} &lt;\${esc(e.from)}&gt;</div>
        <div><strong>To:</strong> \${esc(e.to.join(', '))}</div>
        <div><strong>Received:</strong> \${new Date(e.receivedAt).toLocaleString()}</div>
        \${e.attachments.length ? '<div><strong>Attach:</strong> ' + e.attachments.map(a => esc(a.filename)).join(', ') + '</div>' : ''}
      </div>
      \${hasHtml ? \`
      <div class="tabs">
        <button class="active" id="tabHtml" onclick="switchTab('html')">HTML</button>
        <button id="tabText" onclick="switchTab('text')">Plain Text</button>
        <button id="tabRaw"  onclick="switchTab('raw')">Headers</button>
      </div>
      <div id="tabContent">
        <div class="body-frame">
          <iframe id="htmlFrame" srcdoc="\${esc(e.html)}" style="width:100%;height:500px;border:none"></iframe>
        </div>
      </div>
      \` : \`
      <div class="tabs">
        <button class="active" id="tabText" onclick="switchTab('text')">Plain Text</button>
        <button id="tabRaw" onclick="switchTab('raw')">Headers</button>
      </div>
      <div id="tabContent"><div class="body-plain">\${esc(e.text||'(empty)')}</div></div>
      \`}
    </div>
  \`;
  window._currentEmail = e;
}

function switchTab(tab) {
  const e = window._currentEmail;
  if (!e) return;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1))?.classList.add('active');
  const content = document.getElementById('tabContent');
  if (tab === 'html')
    content.innerHTML = '<div class="body-frame"><iframe srcdoc="' + esc(e.html) + '" style="width:100%;height:500px;border:none"></iframe></div>';
  else if (tab === 'text')
    content.innerHTML = '<div class="body-plain">' + esc(e.text||'(empty)') + '</div>';
  else
    content.innerHTML = '<div class="body-plain">' + esc(JSON.stringify(e.headers, null, 2)) + '</div>';
}

async function deleteEmail(id) {
  await fetch('/api/email/' + id, { method: 'DELETE' });
  allEmails = allEmails.filter(e => e.id !== id);
  currentId = null;
  renderList();
  document.getElementById('viewer').innerHTML = '<div class="empty" style="padding-top:80px">Email deleted.</div>';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function showNotification(e) {
  if (Notification.permission === 'granted')
    new Notification('New email → ' + e.to[0], { body: e.subject });
}

// ── Stats refresh ─────────────────────────────────────────────────────────────
async function refreshStats() {
  const res = await fetch('/api/stats');
  const s = await res.json();
  document.getElementById('stats').textContent =
    s.total + ' email' + (s.total===1?'':'s') + ' stored | uptime ' + Math.floor(s.uptime/60) + 'm';
}
setInterval(refreshStats, 10000);
refreshStats();
if (Notification.permission === 'default') Notification.requestPermission();
</script>
</body>
</html>`;
