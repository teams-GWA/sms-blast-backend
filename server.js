const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = new Database(path.join(__dirname, 'messages.db'));

db.exec(`
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS conversations;
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    from_did TEXT NOT NULL,
    to_did TEXT NOT NULL,
    message TEXT,
    direction TEXT DEFAULT 'outbound',
    status TEXT DEFAULT 'SENT',
    status_code TEXT,
    campaign_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_number TEXT NOT NULL,
    our_number TEXT NOT NULL,
    last_message TEXT,
    last_message_at DATETIME,
    unread_count INTEGER DEFAULT 0,
    UNIQUE(contact_number, our_number)
  );
`);

app.post('/webhook/dlr', (req, res) => {
  try {
    let body;
    try { body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { body = {}; }
    const guid = body.guid || body.sms_guid;
    const statusCode = String(body.status || body.send_status || '');
    let status = 'SENT';
    const code = statusCode.toUpperCase();
    if (code.includes('DELIVER')) status = 'DELIVERED';
    else if (code.includes('FAIL')) status = 'FAILED';
    else if (code.includes('UNDELIVER')) status = 'UNDELIVERED';
    if (guid) db.prepare('UPDATE messages SET status=?,status_code=?,updated_at=CURRENT_TIMESTAMP WHERE guid=?').run(status, statusCode, guid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/inbound', (req, res) => {
  try {
    let body;
    try { body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { body = {}; }
    console.log('Inbound:', JSON.stringify(body));
    const from = String(body.from || body.from_did || '').replace(/\D/g, '').slice(-10);
    const to = String(body.to || body.to_did || '').replace(/\D/g, '').slice(-10);
    const message = body.message || body.text || '';
    const guid = body.guid || ('inbound_' + Date.now());
    if (!from || !to) return res.json({ ok: true });
    db.prepare('INSERT OR IGNORE INTO messages (guid,from_did,to_did,message,direction,status,created_at) VALUES (?,?,?,?,"inbound","DELIVERED",CURRENT_TIMESTAMP)').run(guid, from, to, message);
    db.prepare('INSERT INTO conversations (contact_number,our_number,last_message,last_message_at,unread_count) VALUES (?,?,?,CURRENT_TIMESTAMP,1) ON CONFLICT(contact_number,our_number) DO UPDATE SET last_message=excluded.last_message,last_message_at=CURRENT_TIMESTAMP,unread_count=unread_count+1').run(from, to, message);
    console.log('Saved inbound from', from, 'to', to);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/outbound', (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name } = req.body;
    db.prepare('INSERT OR IGNORE INTO messages (guid,from_did,to_did,message,direction,status,campaign_name) VALUES (?,?,?,?,"outbound","SENT",?)').run(guid || ('out_' + Date.now()), from_did, to_did, message, campaign_name || '');
    db.prepare('INSERT INTO conversations (contact_number,our_number,last_message,last_message_at,unread_count) VALUES (?,?,?,CURRENT_TIMESTAMP,0) ON CONFLICT(contact_number,our_number) DO UPDATE SET last_message=excluded.last_message,last_message_at=CURRENT_TIMESTAMP').run(to_did, from_did, message);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 200').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations/:contact/:our', (req, res) => {
  try {
    const { contact, our } = req.params;
    const msgs = db.prepare('SELECT * FROM messages WHERE (from_did=? AND to_did=?) OR (from_did=? AND to_did=?) ORDER BY created_at ASC LIMIT 500').all(contact, our, our, contact);
    db.prepare('UPDATE conversations SET unread_count=0 WHERE contact_number=? AND our_number=?').run(contact, our);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  try {
    res.json({
      total: db.prepare('SELECT COUNT(*) as n FROM messages WHERE direction="outbound"').get().n,
      delivered: db.prepare('SELECT COUNT(*) as n FROM messages WHERE status="DELIVERED"').get().n,
      failed: db.prepare('SELECT COUNT(*) as n FROM messages WHERE status="FAILED"').get().n,
      inbound: db.prepare('SELECT COUNT(*) as n FROM messages WHERE direction="inbound"').get().n,
      unread: db.prepare('SELECT SUM(unread_count) as n FROM conversations').get().n || 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 20').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('Rsbrm Backend running on port ' + PORT));
