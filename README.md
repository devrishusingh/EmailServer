# @rishurajput.com Email Server

A lightweight, **no-database** SMTP server that receives all email for `@rishurajput.com` — like a temp-mail service you own.

---

## Quick Start (on your EC2 instance)

```bash
# 1. Upload project files, then:
cd ~/EmailServer
npm install
sudo node server.js          # port 25 requires root (or use authbind)
```

---

## DNS Record You Must Add

In your domain registrar (the DNS panel shown in your screenshot), add:

| Type | Name | Priority | Content              | TTL   |
|------|------|----------|----------------------|-------|
| MX   | @    | 10       | mail.rishurajput.com | 300   |

> Your `mail` A record (→ 54.66.30.96) is already set ✅

---

## AWS Security Group — Ports Needed

| Port | Protocol | Purpose                |
|------|----------|------------------------|
| 25   | TCP      | SMTP inbound ✅ already open |
| 587  | TCP      | SMTP submission (open this too) |
| 3000 | TCP      | Web dashboard          |
| 80   | TCP      | HTTP ✅ already open   |

**Add port 587 and 3000 to your inbound rules.**

---

## Running as a Background Service (PM2)

```bash
npm install -g pm2
sudo pm2 start server.js --name email-server
sudo pm2 startup        # auto-start on reboot
sudo pm2 save
```

---

## How It Works

```
Sender's mail server
      │  SMTP (port 25)
      ▼
Your EC2 (54.66.30.96)
  smtp-server (Node.js)
      │  parses with mailparser
      ▼
  /emails/*.json  ← flat-file storage (no DB)
      │
      ▼
  Express dashboard :3000
  + WebSocket live push
```

- **Any address** `anything@rishurajput.com` is accepted — no signup needed
- Emails auto-delete after **24 hours**
- Max **500 emails** kept in memory at once
- Dashboard at `http://YOUR_EC2_IP:3000`

---

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/inbox/:address` | List emails for an address |
| GET | `/api/email/:id` | Get one email by ID |
| DELETE | `/api/email/:id` | Delete an email |
| GET | `/api/stats` | Server stats |
| WS | `/ws` | Live new-email push |

---

## Troubleshooting

**Port 25 permission denied:**
```bash
sudo node server.js
# or use authbind:
sudo apt install authbind
sudo touch /etc/authbind/byport/25
sudo chmod 777 /etc/authbind/byport/25
authbind --deep node server.js
```

**Test locally:**
```bash
# Send a test email to yourself
curl -s telnet://localhost:25
# or use swaks:
swaks --to test@rishurajput.com --server localhost
```
