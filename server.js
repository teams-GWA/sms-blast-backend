const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const https = require('https');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const COMMIO_USER = process.env.COMMIO_USER || 'mstralberg';
const COMMIO_TOKEN = process.env.COMMIO_TOKEN || '1260793d65dc3ac702a712eb195eb265d8d9efd0';
const COMMIO_ACCT = process.env.COMMIO_ACCT || '22978';

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS msgs (
      id SERIAL PRIMARY KEY,
      guid TEXT UNIQUE,
      frm TEXT,
      tod TEXT,
      msg TEXT,
      dir TEXT,
      stat TEXT,
      cname TEXT,
      ts TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS convos (
      id SERIAL PRIMARY KEY,
      cnum TEXT,
      onum TEXT,
      lastmsg TEXT,
      lastts TIMESTAMP DEFAULT NOW(),
      unread INTEGER DEFAULT 0,
      UNIQUE(cnum, onum)
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT,
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      msg TEXT,
      ts TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dnc (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      reason TEXT DEFAULT 'manual',
      added_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS dnc_phone_idx ON dnc(phone);
    CREATE TABLE IF NOT EXISTS scheduled_blasts (
      id SERIAL PRIMARY KEY,
      name TEXT,
      fire_at TIMESTAMP,
      dids JSONB,
      csv_data TEXT,
      phone_col TEXT DEFAULT 'Phone1',
      msg TEXT,
      concur INTEGER DEFAULT 50,
      batch_delay INTEGER DEFAULT 50,
      status TEXT DEFAULT 'pending',
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Migrate existing tables
  await pool.query('ALTER TABLE scheduled_blasts ADD COLUMN IF NOT EXISTS csv_data TEXT');
  await pool.query("ALTER TABLE scheduled_blasts ADD COLUMN IF NOT EXISTS phone_col TEXT DEFAULT 'Phone1'");
  await pool.query('ALTER TABLE scheduled_blasts ADD COLUMN IF NOT EXISTS sent INTEGER DEFAULT 0');
  await pool.query('ALTER TABLE scheduled_blasts ADD COLUMN IF NOT EXISTS failed INTEGER DEFAULT 0');
  console.log('DB ready');
}
initDB().catch(console.error);

// ─── SCHEDULER ──────────────────────────────────────────────────────
setInterval(checkScheduledBlasts, 60 * 1000);

async function checkScheduledBlasts() {
  try {
    const r = await pool.query("SELECT * FROM scheduled_blasts WHERE status='pending' AND fire_at <= NOW()");
    for (const blast of r.rows) {
      console.log('Firing scheduled blast:', blast.name);
      await pool.query("UPDATE scheduled_blasts SET status='firing' WHERE id=$1", [blast.id]);
      fireBlast(blast).then(async ({sent, failed}) => {
        await pool.query("UPDATE scheduled_blasts SET status='sent',sent=$1,failed=$2 WHERE id=$3", [sent, failed, blast.id]);
        await pool.query('INSERT INTO campaigns (name,total,sent,failed,msg) VALUES ($1,$2,$3,$4,$5)',
          [blast.name, sent+failed, sent, failed, blast.msg]).catch(()=>{});
        console.log('Blast done:', blast.name, sent, 'sent', failed, 'failed');
      }).catch(async (e) => {
        console.error('Blast error:', e.message);
        await pool.query("UPDATE scheduled_blasts SET status='failed' WHERE id=$1", [blast.id]);
      });
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function parseCSV(csvText, phoneCol) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line).map(v => v.replace(/"/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  }).filter(r => {
    const ph = String(r[phoneCol] || r['Phone Number'] || r['phone'] || Object.values(r)[1] || '').replace(/\D/g, '');
    return ph.length >= 10;
  });
}

function personalize(t, c) {
  return t.replace(/\{([\w ]+)\}/g, (_, k) => c[k.trim()] || '');
}

async function sendSMS(fromDID, toDID, message) {
  const auth = Buffer.from(COMMIO_USER + ':' + COMMIO_TOKEN).toString('base64');
  const body = JSON.stringify({ from_did: fromDID, to_did: toDID, message });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.thinq.com',
      path: '/account/' + COMMIO_ACCT + '/product/origination/sms/send',
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 500, body: '{}' }));
    req.write(body);
    req.end();
  });
}

async function getDNCSet() {
  try {
    const r = await pool.query('SELECT phone FROM dnc');
    return new Set(r.rows.map(row => row.phone));
  } catch(e) { return new Set(); }
}

async function fireBlast(blast) {
  const contacts = parseCSV(blast.csv_data, blast.phone_col || 'Phone1');
  const dncSet = await getDNCSet();
  const dids = blast.dids;
  const concur = blast.concur || 50;
  const batchDelay = blast.batch_delay || 50;
  let sent = 0, failed = 0;

  async function sendOne(contact, idx) {
    let fromDID = dids[idx % dids.length].replace(/\D/g, '');
    if (fromDID.length === 11 && fromDID[0] === '1') fromDID = fromDID.slice(1);
    const toRaw = contact[blast.phone_col || 'Phone1'] || contact['Phone Number'] || Object.values(contact)[1] || '';
    let toDID = String(toRaw).replace(/\D/g, '');
    if (toDID.length === 11 && toDID[0] === '1') toDID = toDID.slice(1);
    if (!toDID || toDID.length < 10) { failed++; return; }
    if (dncSet.has(toDID)) { failed++; return; } // Skip DNC numbers
    const msg = personalize(blast.msg, contact);
    const r = await sendSMS(fromDID, toDID, msg);
    if (r.status === 200) {
      sent++;
      try {
        const d = JSON.parse(r.body);
        await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING',
          [d.guid || ('out_' + Date.now() + '_' + Math.random()), fromDID, toDID, msg, 'outbound', 'SENT', blast.name]);
      } catch(e) {}
    } else { failed++; }
  }

  for (let i = 0; i < contacts.length; i += concur) {
    // Check if blast was stopped
    const check = await pool.query("SELECT status FROM scheduled_blasts WHERE id=$1", [blast.id]);
    if (check.rows[0] && check.rows[0].status === 'stopped') {
      console.log('Blast stopped by user:', blast.name, 'at', i, 'messages');
      break;
    }
    await Promise.all(contacts.slice(i, i + concur).map((c, j) => sendOne(c, i + j)));
    if (batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));
    if (i % 10000 === 0 && i > 0) {
      await pool.query("UPDATE scheduled_blasts SET sent=$1,failed=$2 WHERE id=$3", [sent, failed, blast.id]);
    }
  }
  return { sent, failed };
}

// ─── CSV UPLOAD ──────────────────────────────────────────────────────
app.post('/api/upload-csv', upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const csvText = req.file.buffer.toString('utf-8');
    const lines = csvText.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const rowCount = lines.length - 1;
    // Store CSV in session (return it back to client for browser use, and store upload ID)
    const uploadId = 'csv_' + Date.now();
    res.json({ ok: true, uploadId, headers, rowCount, csvText });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SCHEDULING ──────────────────────────────────────────────────────
app.post('/api/schedule', async (req, res) => {
  try {
    const { name, fire_at, dids, csv_data, phone_col, msg, concur, batch_delay } = req.body;
    if (!fire_at || !dids || !csv_data || !msg) return res.status(400).json({ error: 'Missing fields' });
    const r = await pool.query(
      'INSERT INTO scheduled_blasts (name,fire_at,dids,csv_data,phone_col,msg,concur,batch_delay) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name || 'Scheduled Blast', new Date(fire_at).toISOString(), JSON.stringify(dids), csv_data, phone_col || 'Phone1', msg, concur || 50, batch_delay || 50]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Stop a firing blast
app.post('/api/schedule/:id/stop', async (req, res) => {
  try {
    await pool.query("UPDATE scheduled_blasts SET status='stopped' WHERE id=$1 AND status IN ('pending','firing')", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/schedule', async (req, res) => {
  try {
    const r = await pool.query("SELECT id,name,fire_at,status,sent,failed,created_at FROM scheduled_blasts ORDER BY fire_at DESC LIMIT 50");
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedule/:id', async (req, res) => {
  try {
    await pool.query("DELETE FROM scheduled_blasts WHERE id=$1 AND status='pending'", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─── DNC LIST ────────────────────────────────────────────────────────

// Get DNC count
app.get('/api/dnc/count', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as n FROM dnc');
    res.json({ count: +r.rows[0].n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get DNC list (paginated)
app.get('/api/dnc', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const r = await pool.query('SELECT phone, reason, added_at FROM dnc ORDER BY added_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    const count = await pool.query('SELECT COUNT(*) as n FROM dnc');
    res.json({ rows: r.rows, total: +count.rows[0].n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upload DNC list (CSV text)
app.post('/api/dnc/upload', async (req, res) => {
  try {
    const { csv_text, reason = 'uploaded' } = req.body;
    if (!csv_text) return res.status(400).json({ error: 'No CSV text provided' });
    const lines = csv_text.split('\n').filter(l => l.trim());
    let added = 0, skipped = 0;
    // Process in batches of 1000
    for (let i = 0; i < lines.length; i += 1000) {
      const batch = lines.slice(i, i + 1000);
      const values = [];
      const params = [];
      let paramIdx = 1;
      for (const line of batch) {
        // Extract phone number from line (handle CSV with headers)
        const parts = line.split(',');
        let phone = parts[0].replace(/\D/g, '').trim();
        if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
        if (phone.length !== 10) { skipped++; continue; }
        values.push(`($${paramIdx}, $${paramIdx+1})`);
        params.push(phone, reason);
        paramIdx += 2;
        added++;
      }
      if (values.length > 0) {
        await pool.query(
          `INSERT INTO dnc (phone, reason) VALUES ${values.join(',')} ON CONFLICT (phone) DO NOTHING`,
          params
        );
      }
    }
    res.json({ ok: true, added, skipped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add single number to DNC
app.post('/api/dnc', async (req, res) => {
  try {
    const { phone, reason = 'manual' } = req.body;
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length === 11 && clean[0] === '1') clean = clean.slice(1);
    if (clean.length !== 10) return res.status(400).json({ error: 'Invalid phone number' });
    await pool.query('INSERT INTO dnc (phone,reason) VALUES ($1,$2) ON CONFLICT (phone) DO NOTHING', [clean, reason]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check if number is on DNC
app.get('/api/dnc/:phone', async (req, res) => {
  try {
    let phone = req.params.phone.replace(/\D/g, '');
    if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
    const r = await pool.query('SELECT phone FROM dnc WHERE phone=$1', [phone]);
    if (r.rows.length > 0) res.json({ phone, onDNC: true });
    else res.status(404).json({ onDNC: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remove number from DNC
app.delete('/api/dnc/:phone', async (req, res) => {
  try {
    await pool.query('DELETE FROM dnc WHERE phone=$1', [req.params.phone]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear entire DNC list
app.delete('/api/dnc', async (req, res) => {
  try {
    await pool.query('DELETE FROM dnc');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SMS SEND ────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { from_did, to_did, message, campaign_name } = req.body;
    if (!from_did || !to_did || !message) return res.status(400).json({ error: 'Missing fields' });
    const r = await sendSMS(from_did, to_did, message);
    const data = JSON.parse(r.body);
    if (r.status === 200) {
      await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING',
        [data.guid || ('out_' + Date.now()), from_did, to_did, message, 'outbound', 'SENT', campaign_name || '']);
      await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),0) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW()', [to_did, from_did, message]);
    }
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── WEBHOOKS ────────────────────────────────────────────────────────
app.post('/webhook/dlr', async (req, res) => {
  try {
    let b; try { b = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { b = {}; }
    const guid = b.guid || b.sms_guid;
    const sc = String(b.status || b.send_status || '').toUpperCase();
    let stat = 'SENT';
    if (sc.includes('DELIVER')) stat = 'DELIVERED';
    else if (sc.includes('FAIL')) stat = 'FAILED';
    if (guid) await pool.query('UPDATE msgs SET stat=$1 WHERE guid=$2', [stat, guid]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/inbound', async (req, res) => {
  try {
    let b; try { b = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { b = {}; }
    console.log('Inbound:', JSON.stringify(b));
    const frm = String(b.from || b.from_did || '').replace(/\D/g, '').slice(-10);
    const tod = String(b.to || b.to_did || '').replace(/\D/g, '').slice(-10);
    const msg = b.message || b.text || '';
    const guid = b.guid || ('in_' + Date.now());
    if (!frm || !tod) return res.json({ ok: true });
    await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (guid) DO NOTHING', [guid, frm, tod, msg, 'inbound', 'DELIVERED']);
    await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),1) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW(),unread=convos.unread+1', [frm, tod, msg]);
    // Auto-add to DNC if STOP/CANCEL/UNSUBSCRIBE/END/QUIT
    const stopWords = ['stop','cancel','unsubscribe','end','quit','optout','opt out','opt-out'];
    if (stopWords.some(w => msg.toLowerCase().trim().includes(w))) {
      await pool.query('INSERT INTO dnc (phone,reason) VALUES ($1,$2) ON CONFLICT (phone) DO NOTHING', [frm, 'STOP reply']);
      console.log('Added to DNC:', frm, '- reason: STOP reply');
    }
    console.log('Saved inbound from', frm, 'to', tod);
    res.json({ ok: true });
  } catch(e) { console.error('Inbound error:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── CONFIG ──────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM config');
    const config = {};
    r.rows.forEach(row => { try { config[row.key] = JSON.parse(row.value); } catch(e) { config[row.key] = row.value; } });
    res.json(config);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    await pool.query('INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()', [key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config/bulk', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool.query('INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()', [key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DATA APIs ───────────────────────────────────────────────────────
app.post('/api/messages/outbound', async (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name, status } = req.body;
    await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING',
      [guid || ('out_' + Date.now()), from_did, to_did, message, 'outbound', status || 'SENT', campaign_name || '']);
    await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),0) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW()', [to_did, from_did, message]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, total, sent, failed, msg } = req.body;
    await pool.query('INSERT INTO campaigns (name,total,sent,failed,msg) VALUES ($1,$2,$3,$4,$5)', [name, total, sent, failed, msg]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/campaigns', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM campaigns ORDER BY ts DESC LIMIT 100');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export', async (req, res) => {
  try {
    const { campaign } = req.query;
    let q = "SELECT frm as from_number, tod as to_number, msg as message, stat as status, cname as campaign, ts as timestamp FROM msgs WHERE dir='outbound'";
    const params = [];
    if (campaign) { q += ' AND cname=$1'; params.push(campaign); }
    q += ' ORDER BY ts DESC';
    const r = await pool.query(q, params);
    const csv = ['From,To,Message,Status,Campaign,Timestamp',
      ...r.rows.map(row => `${row.from_number},${row.to_number},"${(row.message||'').replace(/"/g,'""')}",${row.status},${row.campaign||''},${row.timestamp}`)
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="messages.csv"');
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const r = await pool.query('SELECT cnum as contact_number, onum as our_number, lastmsg as last_message, lastts as last_message_at, unread as unread_count FROM convos ORDER BY lastts DESC LIMIT 200');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations/:contact/:our', async (req, res) => {
  try {
    const { contact, our } = req.params;
    const r = await pool.query('SELECT guid, frm as from_did, tod as to_did, msg as message, dir as direction, stat as status, ts as created_at FROM msgs WHERE (frm=$1 AND tod=$2) OR (frm=$2 AND tod=$1) ORDER BY ts ASC LIMIT 500', [contact, our]);
    await pool.query('UPDATE convos SET unread=0 WHERE cnum=$1 AND onum=$2', [contact, our]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [total, delivered, failed, inbound, unread] = await Promise.all([
      pool.query("SELECT COUNT(*) as n FROM msgs WHERE dir='outbound'"),
      pool.query("SELECT COUNT(*) as n FROM msgs WHERE stat='DELIVERED'"),
      pool.query("SELECT COUNT(*) as n FROM msgs WHERE stat='FAILED'"),
      pool.query("SELECT COUNT(*) as n FROM msgs WHERE dir='inbound'"),
      pool.query('SELECT SUM(unread) as n FROM convos')
    ]);
    res.json({ total: +total.rows[0].n, delivered: +delivered.rows[0].n, failed: +failed.rows[0].n, inbound: +inbound.rows[0].n, unread: +(unread.rows[0].n||0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM msgs ORDER BY ts DESC LIMIT 20');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function cleanup() {
  try {
    const r = await pool.query("DELETE FROM msgs WHERE dir='outbound' AND ts < NOW() - INTERVAL '24 hours'");
    if (r.rowCount > 0) console.log('Cleaned up', r.rowCount, 'old messages');
    // Clean up old sent/failed scheduled blasts after 7 days
    await pool.query("DELETE FROM scheduled_blasts WHERE status IN ('sent','failed') AND created_at < NOW() - INTERVAL '7 days'");
  } catch(e) { console.error('Cleanup error:', e.message); }
}
setInterval(cleanup, 60 * 60 * 1000);


// Clear inbox conversations and inbound messages
app.delete('/api/inbox/clear', async (req, res) => {
  try {
    await pool.query("DELETE FROM msgs WHERE dir='inbound'");
    await pool.query("DELETE FROM convos");
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('Rsbrm running on port ' + PORT));
