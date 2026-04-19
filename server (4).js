const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = new Database('/tmp/rsbrm.db');

db.exec('CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, frm TEXT, tod TEXT, msg TEXT, dir TEXT, stat TEXT, cname TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP)');
db.exec('CREATE TABLE IF NOT EXISTS convos (id INTEGER PRIMARY KEY AUTOINCREMENT, cnum TEXT, onum TEXT, lastmsg TEXT, lastts DATETIME, unread INTEGER DEFAULT 0, UNIQUE(cnum,onum))');

console.log('DB ready');

app.post('/webhook/dlr', (req, res) => {
  try {
    let b; try { b = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { b = {}; }
    const guid = b.guid || b.sms_guid;
    const sc = String(b.status || b.send_status || '').toUpperCase();
    let stat = 'SENT';
    if (sc.includes('DELIVER')) stat = 'DELIVERED';
    else if (sc.includes('FAIL')) stat = 'FAILED';
    if (guid) db.prepare('UPDATE msgs SET stat=? WHERE guid=?').run(stat, guid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook/inbound', (req, res) => {
  try {
    let b; try { b = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body; } catch(e) { b = {}; }
    console.log('Inbound:', JSON.stringify(b));
    const frm = String(b.from || b.from_did || '').replace(/\D/g, '').slice(-10);
    const tod = String(b.to || b.to_did || '').replace(/\D/g, '').slice(-10);
    const msg = b.message || b.text || '';
    const guid = b.guid || ('in_' + Date.now());
    const dir = 'inbound';
    const stat = 'DELIVERED';
    if (!frm || !tod) return res.json({ ok: true });
    db.prepare('INSERT OR IGNORE INTO msgs (guid,frm,tod,msg,dir,stat) VALUES (?,?,?,?,?,?)').run(guid, frm, tod, msg, dir, stat);
    db.prepare('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES (?,?,?,CURRENT_TIMESTAMP,1) ON CONFLICT(cnum,onum) DO UPDATE SET lastmsg=excluded.lastmsg,lastts=CURRENT_TIMESTAMP,unread=unread+1').run(frm, tod, msg);
    console.log('Saved inbound from', frm, 'to', tod, ':', msg);
    res.json({ ok: true });
  } catch(e) { console.error('Inbound error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/outbound', (req, res) => {
  try {
    const { guid, from_did, to_did, message, campaign_name } = req.body;
    const dir = 'outbound';
    const stat = 'SENT';
    db.prepare('INSERT OR IGNORE INTO msgs (guid,frm,tod,msg,dir,stat,cname) VALUES (?,?,?,?,?,?,?)').run(guid || ('out_' + Date.now()), from_did, to_did, message, dir, stat, campaign_name || '');
    db.prepare('INSERT INTO convos (cnum,onum,lastmsg,lastts,unread) VALUES (?,?,?,CURRENT_TIMESTAMP,0) ON CONFLICT(cnum,onum) DO UPDATE SET lastmsg=excluded.lastmsg,lastts=CURRENT_TIMESTAMP').run(to_did, from_did, message);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations', (req, res) => {
  try {
    const rows = db.prepare('SELECT cnum as contact_number, onum as our_number, lastmsg as last_message, lastts as last_message_at, unread as unread_count FROM convos ORDER BY lastts DESC LIMIT 200').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conversations/:contact/:our', (req, res) => {
  try {
    const { contact, our } = req.params;
    const msgs = db.prepare('SELECT guid, frm as from_did, tod as to_did, msg as message, dir as direction, stat as status, ts as created_at FROM msgs WHERE (frm=? AND tod=?) OR (frm=? AND tod=?) ORDER BY ts ASC LIMIT 500').all(contact, our, our, contact);
    db.prepare('UPDATE convos SET unread=0 WHERE cnum=? AND onum=?').run(contact, our);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  try {
    res.json({
      total: db.prepare('SELECT COUNT(*) as n FROM msgs WHERE dir=?').get('outbound').n,
      delivered: db.prepare('SELECT COUNT(*) as n FROM msgs WHERE stat=?').get('DELIVERED').n,
      failed: db.prepare('SELECT COUNT(*) as n FROM msgs WHERE stat=?').get('FAILED').n,
      inbound: db.prepare('SELECT COUNT(*) as n FROM msgs WHERE dir=?').get('inbound').n,
      unread: db.prepare('SELECT SUM(unread) as n FROM convos').get().n || 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM msgs ORDER BY ts DESC LIMIT 20').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log('Rsbrm running on port ' + PORT));
