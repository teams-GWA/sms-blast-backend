const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database setup
const db = new Database(path.join(__dirname, 'messages.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    from_did TEXT NOT NULL,
    to_did TEXT NOT NULL,
    message TEXT,
    direction TEXT DEFAULT 'outbound',
    status TEXT DEFAULT 'SENT',
    status_code TEXT,
    carrier TEXT,
    campaign_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_number TEXT NOT NULL,
    our_number TEXT NOT NULL,
    contact_name TEXT,
    last_message TEXT,
    last_message_at DATETIME,
    unread_count INTEGER DEFAULT 0,
    UNIQUE(contact_number, our_number)
  );
`);

// ─── WEBHOOKS FROM COMMIO ───────────────────────────────────────────

// Delivery Receipt (DLR) — Commio POSTs status updates here
app.post('/webhook/dlr', (req, res) => {
  try {
    const body = req.body;
    console.log('DLR received:', JSON.stringify(body));

    const guid = body.guid || body.sms_guid || body.message_id;
    const statusCode = body.status || body.delivery_status || '';
    
    // Map Commio status codes to readable labels
    let status = 'SENT';
    const code = String(statusCode).toUpperCase();
    if (code === '200' || code === 'DELIVERED' || code.includes('DELIVERED')) status = 'DELIVERED';
    else if (code === 'FAILED' || code.includes('FAIL') || code === '400' || code === '500') status = 'FAILED';
    else if (code === 'UNDELIVERED' || code.includes('UNDELIVER')) status = 'UNDELIVERED';
    else if (code === '100' || code === 'SENT') status = 'SENT';

    if (guid) {
      db.prepare(`
        UPDATE messages SET status = ?, status_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE guid = ?
      `).run(status, statusCode, guid);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('DLR error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Inbound Message — Commio POSTs incoming SMS here
app.post('/webhook/inbound', (req, res) => {
  try {
    const body = req.body;
    console.log('Inbound received:', JSON.stringify(body));

    const fromDid = String(body.from_did || body.from || '').replace(/\D/g, '').slice(-10);
    const toDid = String(body.to_did || body.to || '').replace(/\D/g, '').slice(-10);
    const message = body.message || body.text || body.content || '';
    const guid = body.guid || body.sms_guid || `inbound_${Date.now()}`;

    if (!fromDid || !toDid) {
      return res.json({ ok: true });
    }

    // Save inbound message
    db.prepare(`
      INSERT OR IGNORE INTO messages (guid, from_did, to_did, message, direction, status, created_at)
      VALUES (?, ?, ?, ?, 'inbound', 'DELIVERED', CURRENT_TIMESTAMP)
    `).run(guid, fromDid, toDid, message);

    // Update or create conversation
    db.prepare(`
      INSERT INTO conversations (contact_number, our_number, last_message, last_message_at, unread_count)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT(contact_number, our_number) DO UPDATE SET
        last_message = excluded.last_message,
        last_message_at = CURRENT_TIMESTAMP,
        unread_count = unread_count + 1
    `).run(fromDid, toDid, message);

    res.json({ ok: true });
  } catch (e) {
    console.error('Inbound error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── REST API FOR THE BLAST APP ─────────────────────────────────────

// Log an outbound message (called by blast app after each send)
app.post('/api/messages/outbound', (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name } = req.body;
    
    db.prepare(`
      INSERT OR IGNORE INTO messages (guid, from_did, to_did, message, direction, status, campaign_name)
      VALUES (?, ?, ?, ?, 'outbound', 'SENT', ?)
    `).run(guid || `out_${Date.now()}_${Math.random()}`, from_did, to_did, message, campaign_name || '');

    // Update conversation
    db.prepare(`
      INSERT INTO conversations (contact_number, our_number, last_message, last_message_at, unread_count)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
      ON CONFLICT(contact_number, our_number) DO UPDATE SET
        last_message = excluded.last_message,
        last_message_at = CURRENT_TIMESTAMP
    `).run(to_did, from_did, message);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all conversations
app.get('/api/conversations', (req, res) => {
  try {
    const convos = db.prepare(`
      SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 200
    `).all();
    res.json(convos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get messages for a conversation
app.get('/api/conversations/:contact/:our', (req, res) => {
  try {
    const { contact, our } = req.params;
    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE (from_did = ? AND to_did = ?) OR (from_did = ? AND to_did = ?)
      ORDER BY created_at ASC LIMIT 500
    `).all(contact, our, our, contact);

    // Mark as read
    db.prepare(`
      UPDATE conversations SET unread_count = 0
      WHERE contact_number = ? AND our_number = ?
    `).run(contact, our);

    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get message status by guid
app.get('/api/messages/:guid/status', (req, res) => {
  try {
    const msg = db.prepare('SELECT status, status_code FROM messages WHERE guid = ?').get(req.params.guid);
    res.json(msg || { status: 'UNKNOWN' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all messages with status (for campaign view)
app.get('/api/messages', (req, res) => {
  try {
    const { campaign, limit = 100, offset = 0 } = req.query;
    let query = 'SELECT * FROM messages WHERE direction = "outbound"';
    const params = [];
    if (campaign) { query += ' AND campaign_name = ?'; params.push(campaign); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const messages = db.prepare(query).all(...params);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as n FROM messages WHERE direction="outbound"').get().n;
    const delivered = db.prepare('SELECT COUNT(*) as n FROM messages WHERE status="DELIVERED"').get().n;
    const failed = db.prepare('SELECT COUNT(*) as n FROM messages WHERE status="FAILED"').get().n;
    const inbound = db.prepare('SELECT COUNT(*) as n FROM messages WHERE direction="inbound"').get().n;
    const unread = db.prepare('SELECT SUM(unread_count) as n FROM conversations').get().n || 0;
    res.json({ total, delivered, failed, inbound, unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ SMS Blast Backend running on port ' + PORT);
  console.log('');
  console.log('  Webhook URLs to set in Commio:');
  console.log('  Inbound:  https://YOUR-RAILWAY-URL/webhook/inbound');
  console.log('  DLR:      https://YOUR-RAILWAY-URL/webhook/dlr');
  console.log('');
});
