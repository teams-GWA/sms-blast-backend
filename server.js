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
  `);
  console.log('DB ready');
}

initDB().catch(console.error);

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

app.post('/api/messages/outbound', async (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name } = req.body;
    await pool.query('INSERT INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guid) DO NOTHING', [guid || ('out_' + Date.now()), from_did, to_did, message, 'outbound', 'SENT', campaign_name || '']);
    await pool.query('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES ($1,$2,$3,NOW(),0) ON CONFLICT (cnum,onum) DO UPDATE SET lastmsg=$3,lastts=NOW()', [to_did, from_did, message]);
    res.json({ ok: true });
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
