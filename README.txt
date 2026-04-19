SMS Blast Pro — Backend Setup
==============================

DEPLOY TO RAILWAY (5 minutes)
------------------------------
1. Go to https://railway.app and sign up (free)
2. Click "New Project" → "Deploy from GitHub repo"
   OR click "New Project" → "Empty Project" → "Add Service" → "GitHub Repo"
3. Upload these files to a GitHub repo first:
   - server.js
   - package.json
   - railway.toml
4. Railway auto-deploys and gives you a URL like:
   https://sms-blast-backend-production.up.railway.app

AFTER DEPLOYING
---------------
1. Copy your Railway URL
2. Go to commio.io → Messaging → Message Settings
3. Set Inbound Message URL to:
   https://YOUR-RAILWAY-URL/webhook/inbound
4. Set Delivery Notification URL to:
   https://YOUR-RAILWAY-URL/webhook/dlr
5. Open your Netlify blast app → Settings → paste your Railway URL

That's it! The inbox will now show all conversations and delivery statuses.

WEBHOOK URLS
------------
Inbound messages:  POST /webhook/inbound
Delivery receipts: POST /webhook/dlr

API ENDPOINTS
-------------
GET  /api/conversations          — all conversations
GET  /api/conversations/:c/:o    — messages in a conversation
GET  /api/messages               — all outbound messages
GET  /api/stats                  — delivery stats
POST /api/messages/outbound      — log an outbound message
GET  /health                     — health check
