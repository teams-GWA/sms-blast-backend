const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
  `);
  console.log('DB ready');
}

initDB().catch(console.error);

// Auto-delete messages older than 24 hours (keep convos for inbox)
async function cleanup() {
  try {
    const r = await pool.query("DELETE FROM msgs WHERE dir='outbound' AND ts < NOW() - INTERVAL '24 hours'");
    if (r.rowCount > 0) console.log('Cleaned up', r.rowCount, 'old outbound messages');
  } catch(e) { console.error('Cleanup error:', e.message); }
}
setInterval(cleanup, 60 * 60 * 1000); // run every hour


// Send SMS — proxied through backend so Commio credentials never exposed
app.post('/api/send', async (req, res) => {
  try {
    const { from_did, to_did, message, campaign_name } = req.body;
    if (!from_did || !to_did || !message) return res.status(400).json({ error: 'Missing fields' });

    const https = require('https');
    const COMMIO_USER = process.env.COMMIO_USER || 'mstralberg';
    const COMMIO_TOKEN = process.env.COMMIO_TOKEN || '1260793d65dc3ac702a712eb195eb265d8d9efd0';
    const COMMIO_ACCT = process.env.COMMIO_ACCT || '22978';
    const auth = Buffer.from(COMMIO_USER + ':' + COMMIO_TOKEN).toString('base64');
    const body = JSON.stringify({ from_did, to_did, message });

    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.thinq.com',
        path: '/account/' + COMMIO_ACCT + '/product/origination/sms/send',
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const r = https.request(options, (res2) => {
        let data = '';
        res2.on('data', chunk => data += chunk);
        res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    const data = JSON.parse(response.body);
    if (response.status === 200) {
      // Log outbound message
      await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING',
        [data.guid || ('out_' + Date.now()), from_did, to_did, message, 'outbound', 'SENT', campaign_name || '']);
      await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),0) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW()', [to_did, from_did, message]);
    }
    res.status(response.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Config storage — persists credentials and DIDs server-side
async function initConfig() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initConfig().catch(console.error);

// Get all config
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM config');
    const config = {};
    r.rows.forEach(row => { try { config[row.key] = JSON.parse(row.value); } catch(e) { config[row.key] = row.value; } });
    res.json(config);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save config value
app.post('/api/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    await pool.query('INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()', [key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save multiple config values at once
app.post('/api/config/bulk', async (req, res) => {
  try {
    const configs = req.body;
    for (const [key, value] of Object.entries(configs)) {
      await pool.query('INSERT INTO config (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()', [key, JSON.stringify(value)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
    console.log('Saved inbound from', frm, 'to', tod);
    res.json({ ok: true });
  } catch(e) { console.error('Inbound error:', e.message); res.status(500).json({ error: e.message }); }
});

// Log outbound message
app.post('/api/messages/outbound', async (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name, status } = req.body;
    await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING',
      [guid || ('out_' + Date.now()), from_did, to_did, message, 'outbound', status || 'SENT', campaign_name || '']);
    await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),0) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW()', [to_did, from_did, message]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save campaign summary
app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, total, sent, failed, msg } = req.body;
    await pool.query('INSERT INTO campaigns (name,total,sent,failed,msg) VALUES ($1,$2,$3,$4,$5)', [name, total, sent, failed, msg]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get campaigns
app.get('/api/campaigns', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM campaigns ORDER BY ts DESC LIMIT 100');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Export outbound messages as CSV
app.get('/api/export', async (req, res) => {
  try {
    const { campaign } = req.query;
    let q = "SELECT frm as from_number, tod as to_number, msg as message, stat as status, cname as campaign, ts as timestamp FROM msgs WHERE dir='outbound'";
    const params = [];
    if (campaign) { q += ' AND cname=$1'; params.push(campaign); }
    q += ' ORDER BY ts DESC';
    const r = await pool.query(q, params);
    const rows = r.rows;
    const csv = ['From,To,Message,Status,Campaign,Timestamp',
      ...rows.map(r => `${r.from_number},${r.to_number},"${(r.message||'').replace(/"/g,'""')}",${r.status},${r.campaign||''},${r.timestamp}`)
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

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('Rsbrm running on port ' + PORT));
