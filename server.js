require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Set JWT_SECRET to a random value at least 32 characters long in .env');
  process.exit(1);
}
if (!ADMIN_KEY || ADMIN_KEY.length < 24) {
  console.error('Set ADMIN_KEY to a random value at least 24 characters long in .env');
  process.exit(1);
}

const dbFile = process.env.DATABASE_FILE || './data/earnhub.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE,
 phone TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 referral_code TEXT NOT NULL UNIQUE,
 referred_by INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS packages (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, fee INTEGER NOT NULL,
 advertised_value INTEGER NOT NULL, description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_packages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 package_id TEXT NOT NULL REFERENCES packages(id), status TEXT NOT NULL DEFAULT 'pending',
 payment_reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL,
 description TEXT NOT NULL, reward INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1, funded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 task_id INTEGER NOT NULL REFERENCES tasks(id), status TEXT NOT NULL DEFAULT 'pending',
 proof TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(user_id, task_id)
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 type TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
 description TEXT NOT NULL, reference TEXT UNIQUE,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS withdrawals (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 phone TEXT NOT NULL, amount INTEGER NOT NULL, fee INTEGER NOT NULL,
 payout_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
const packages = [
 ['bronze','Bronze',50,150,'Unlock eligible games and surveys in the Bronze tier.'],
 ['silver','Silver',100,250,'Unlock eligible games and surveys in the Silver tier.'],
 ['gold','Gold',150,350,'Unlock eligible games and surveys in the Gold tier.'],
 ['platinum','Platinum',200,500,'Unlock eligible games and surveys in the Platinum tier.']
];
const insertPackage = db.prepare('INSERT OR IGNORE INTO packages (id,name,fee,advertised_value,description) VALUES (?,?,?,?,?)');
packages.forEach(p => insertPackage.run(...p));
const countTasks = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
if (!countTasks) {
  const insertTask = db.prepare('INSERT INTO tasks(title,kind,description,reward,active,funded) VALUES(?,?,?,?,1,0)');
  insertTask.run('Daily knowledge quiz','game','Answer a short quiz. Reward is credited only after an admin verifies the result and confirms funding.',10);
  insertTask.run('Partner survey (demo)','survey','Demo listing only. No external survey provider is connected yet. Do not submit personal data to an unverified provider.',20);
  insertTask.run('Daily challenge','game','Complete the challenge and submit a short proof for review.',15);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));

function auth(req,res,next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    if (!token) throw new Error('missing');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function admin(req,res,next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({error:'Admin access denied.'});
  next();
}
function cleanText(v, max=200) { return String(v || '').trim().slice(0,max); }
function userById(id) { return db.prepare('SELECT id,name,email,phone,referral_code,created_at FROM users WHERE id=?').get(id); }
function balance(id) {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) AS total FROM wallet_transactions WHERE user_id=?`).get(id);
  const pending = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions WHERE user_id=? AND type='withdrawal_hold' AND status='pending'`).get(id);
  return Math.max(0, row.total - pending.total);
}
function activePackage(id) {
  return db.prepare(`SELECT p.id,p.name,p.fee,p.advertised_value,up.status,up.created_at
    FROM user_packages up JOIN packages p ON p.id=up.package_id
    WHERE up.user_id=? AND up.status='active' ORDER BY up.id DESC LIMIT 1`).get(id) || null;
}
app.get('/api/health', (req,res) => res.json({ok:true, service:'EA EarnHub', mode:'MVP'}));
app.get('/api/packages', (req,res) => res.json({packages: db.prepare('SELECT id,name,fee,advertised_value,description FROM packages').all()}));
app.get('/api/tasks', (req,res) => res.json({tasks: db.prepare('SELECT id,title,kind,description,reward FROM tasks WHERE active=1 ORDER BY id').all()}));

app.post('/api/register', async (req,res) => {
  const name = cleanText(req.body.name,80);
  const email = cleanText(req.body.email,160).toLowerCase();
  const phone = cleanText(req.body.phone,20).replace(/\s/g,'');
  const password = String(req.body.password || '');
  const referral = cleanText(req.body.referralCode,24).toUpperCase();
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^(?:\+?254|0)7\d{8}$/.test(phone) || password.length < 10) {
    return res.status(400).json({error:'Enter a name, valid email, Kenyan mobile number, and password of at least 10 characters.'});
  }
  try {
    const referrer = referral ? db.prepare('SELECT id FROM users WHERE referral_code=?').get(referral) : null;
    if (referral && !referrer) return res.status(400).json({error:'Referral code was not found.'});
    const hash = await bcrypt.hash(password,12);
    const code = 'EA' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
    const result = db.prepare('INSERT INTO users(name,email,phone,password_hash,referral_code,referred_by) VALUES(?,?,?,?,?,?)')
      .run(name,email,phone,hash,code,referrer ? referrer.id : null);
    const token = jwt.sign({id:Number(result.lastInsertRowid)}, JWT_SECRET, {expiresIn:'7d'});
    res.status(201).json({token,user:userById(result.lastInsertRowid)});
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({error:'That email is already registered.'});
    res.status(500).json({error:'Could not create account.'});
  }
});
app.post('/api/login', async (req,res) => {
  const email = cleanText(req.body.email,160).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
  const token = jwt.sign({id:user.id}, JWT_SECRET, {expiresIn:'7d'});
  res.json({token,user:userById(user.id)});
});
app.get('/api/me', auth, (req,res) => {
  const user = userById(req.user.id);
  const tx = db.prepare('SELECT type,amount,status,description,created_at FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 10').all(req.user.id);
  const pendingWithdrawals = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE user_id=? AND status IN ('pending','processing')").get(req.user.id).total;
  res.json({user,balance:balance(req.user.id),availableBalance:Math.max(0,balance(req.user.id)-pendingWithdrawals),activePackage:activePackage(req.user.id),transactions:tx});
});

// Payment is recorded as pending. Never activate a paid package based only on a browser claim.
app.post('/api/packages/:id/purchase', auth, (req,res) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(req.params.id);
  if (!pkg) return res.status(404).json({error:'Package not found.'});
  const existing = db.prepare("SELECT id FROM user_packages WHERE user_id=? AND status IN ('pending','active')").get(req.user.id);
  if (existing) return res.status(409).json({error:'You already have a pending or active package.'});
  const result = db.prepare("INSERT INTO user_packages(user_id,package_id,status) VALUES(?,?,'pending')").run(req.user.id,pkg.id);
  res.status(201).json({message:'Package request created. It stays pending until payment is verified securely.',purchaseId:Number(result.lastInsertRowid),status:'pending',fee:pkg.fee});
});

// User submits completion for review. Credit is never created from client-side values.
app.post('/api/tasks/:id/submit', auth, (req,res) => {
  if (!activePackage(req.user.id)) return res.status(403).json({error:'Choose a premium package and complete payment verification to unlock tasks.'});
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND active=1').get(Number(req.params.id));
  if (!task) return res.status(404).json({error:'Task not found.'});
  const proof = cleanText(req.body.proof,1000);
  try {
    const result = db.prepare("INSERT INTO task_submissions(user_id,task_id,proof) VALUES(?,?,?)").run(req.user.id,task.id,proof);
    res.status(201).json({message:'Submission received for review.',submissionId:Number(result.lastInsertRowid)});
  } catch { res.status(409).json({error:'You have already submitted this task.'}); }
});

app.post('/api/withdrawals', auth, (req,res) => {
  const amount = Number(req.body.amount);
  const phone = cleanText(req.body.phone || userById(req.user.id).phone,20).replace(/\s/g,'');
  if (!Number.isInteger(amount) || amount < 100 || amount > 1000) return res.status(400).json({error:'Withdrawals must be between KSh 100 and KSh 1,000 per request.'});
  if (!/^(?:\+?254|0)7\d{8}$/.test(phone)) return res.status(400).json({error:'Enter a valid Kenyan mobile number.'});
  const daily = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE user_id=? AND date(created_at)=date('now','localtime') AND status IN ('pending','processing','paid')").get(req.user.id).total;
  if (daily + amount > 1000) return res.status(400).json({error:'Your daily withdrawal limit is KSh 1,000.'});
  const pending = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM withdrawals WHERE user_id=? AND status IN ('pending','processing')").get(req.user.id).total;
  if (amount > balance(req.user.id)-pending) return res.status(400).json({error:'Insufficient available balance.'});
  const fee = Math.round(amount * 0.06);
  const result = db.prepare('INSERT INTO withdrawals(user_id,phone,amount,fee,payout_amount) VALUES(?,?,?,?,?)').run(req.user.id,phone,amount,fee,amount-fee);
  db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,description,reference) VALUES(?,?,?,?,?,?)")
    .run(req.user.id,'withdrawal_hold',amount,'pending','Withdrawal request hold','WDH-'+result.lastInsertRowid);
  res.status(201).json({message:'Withdrawal request submitted for review. This MVP does not send real M-Pesa payments.',withdrawalId:Number(result.lastInsertRowid),requested:amount,fee,payout:amount-fee,status:'pending'});
});

// Admin endpoints: use from a secure admin-only tool, not from public browser code.
app.get('/api/admin/overview', admin, (req,res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    pendingPackages: db.prepare("SELECT COUNT(*) n FROM user_packages WHERE status='pending'").get().n,
    pendingSubmissions: db.prepare("SELECT COUNT(*) n FROM task_submissions WHERE status='pending'").get().n,
    pendingWithdrawals: db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE status='pending'").get().n
  });
});
app.get('/api/admin/pending', admin, (req,res) => {
  res.json({
    packages: db.prepare("SELECT up.id,up.user_id,u.name,u.phone,p.name package,p.fee,up.created_at FROM user_packages up JOIN users u ON u.id=up.user_id JOIN packages p ON p.id=up.package_id WHERE up.status='pending'").all(),
    submissions: db.prepare("SELECT s.id,s.user_id,u.name,t.title,t.reward,s.proof,s.created_at FROM task_submissions s JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id=s.task_id WHERE s.status='pending'").all(),
    withdrawals: db.prepare("SELECT w.id,w.user_id,u.name,w.phone,w.amount,w.fee,w.payout_amount,w.created_at FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status='pending'").all()
  });
});
app.post('/api/admin/packages/:id/verify', admin, (req,res) => {
  const id = Number(req.params.id);
  const status = req.body.approve === true ? 'active' : 'rejected';
  const row = db.prepare("SELECT * FROM user_packages WHERE id=? AND status='pending'").get(id);
  if (!row) return res.status(404).json({error:'Pending package request not found.'});
  db.prepare('UPDATE user_packages SET status=? WHERE id=?').run(status,id);
  if (status === 'active') db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,description,reference) VALUES(?,?,?,?,?,?)")
    .run(row.user_id,'package_payment',0,'approved','Package payment verified by admin','PKG-'+id);
  res.json({status});
});
app.post('/api/admin/submissions/:id/review', admin, (req,res) => {
  const id = Number(req.params.id);
  const approve = req.body.approve === true;
  const row = db.prepare("SELECT s.*,t.reward,t.funded,t.title FROM task_submissions s JOIN tasks t ON t.id=s.task_id WHERE s.id=? AND s.status='pending'").get(id);
  if (!row) return res.status(404).json({error:'Pending submission not found.'});
  if (approve && !row.funded) return res.status(400).json({error:'This task is not marked as funded. Fund the task before approving a reward.'});
  const tx = db.transaction(() => {
    db.prepare('UPDATE task_submissions SET status=? WHERE id=?').run(approve?'approved':'rejected',id);
    if (approve) db.prepare('INSERT INTO wallet_transactions(user_id,type,amount,status,description,reference) VALUES(?,?,?,?,?,?)')
      .run(row.user_id,'task_reward',row.reward,'approved','Verified task reward: '+row.title,'TASK-'+id);
  });
  tx();
  res.json({status:approve?'approved':'rejected'});
});
app.post('/api/admin/tasks/:id/funding', admin, (req,res) => {
  db.prepare('UPDATE tasks SET funded=? WHERE id=?').run(req.body.funded===true?1:0,Number(req.params.id));
  res.json({ok:true});
});
app.post('/api/admin/withdrawals/:id/review', admin, (req,res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM withdrawals WHERE id=? AND status='pending'").get(id);
  if (!row) return res.status(404).json({error:'Pending withdrawal not found.'});
  const status = req.body.status === 'paid' ? 'paid' : 'rejected';
  const tx = db.transaction(() => {
    db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(status,id);
    db.prepare("UPDATE wallet_transactions SET status=? WHERE reference=?").run(status==='paid'?'approved':'rejected','WDH-'+id);
    if (status==='rejected') db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,status,description,reference) VALUES(?,?,?,?,?,?)")
      .run(row.user_id,'withdrawal_refund',row.amount,'approved','Refund for rejected withdrawal','WDR-'+id);
  });
  tx();
  res.json({status, payout:row.payout_amount, note:status==='paid'?'Mark paid only after the M-Pesa payout has actually succeeded.':'Withdrawal rejected and funds released.'});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`EA EarnHub running at http://localhost:${PORT}`));
// --- LIVE MPESA INTEGRATION GATEWAY ---
const axios = require('axios');

// Safaricom Credentials (Using Sandbox details for testing)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || "vA7GfGGrGAdG7G7A7GfGGrGAdG7G7A7G";
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || "A7GfGGrGAdG7G7A7";
const MPESA_SHORTCODE = "174379"; // Lipa Na M-Pesa Online Sandbox Shortcode
const MPESA_PASSKEY = "bfb27272bfb3c107e711487f5d47e33e2342440778a2214315d5434e7655a914";

// Middleware to generate M-Pesa Access Token
async function getMpesaToken(req, res, next) {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get('https://safaricom.co.ke', {
            headers: { Authorization: `Basic ${auth}` }
        });
        req.mpesaToken = response.data.access_token;
        next();
    } catch (error) {
        console.error("M-Pesa Token Error:", error.message);
        res.status(500).json({ error: "Failed to generate payment token" });
    }
}

// Route to Trigger the STK Push PIN Popup
app.post('/api/stkpush', getMpesaToken, async (req, res) => {
    const { phone, amount, accountId } = req.body;
    
    // Format phone to 2547XXXXXXXX
    let formattedPhone = phone.trim().replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    }

    const date = new Date();
    const timestamp = date.getFullYear() +
        ("0" + (date.getMonth() + 1)).slice(-2) +
        ("0" + date.getDate()).slice(-2) +
        ("0" + date.getHours()).slice(-2) +
        ("0" + date.getMinutes()).slice(-2) +
        ("0" + date.getSeconds()).slice(-2);

    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const callbackUrl = `https://${req.get('host')}/api/mpesa-callback`;

    const stkData = {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: formattedPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `Account_${accountId}`,
        TransactionDesc: "Premium Activation"
    };

    try {
        const response = await axios.post('https://safaricom.co.ke', stkData, {
            headers: { Authorization: `Bearer ${req.mpesaToken}` }
        });
        res.json({ success: true, message: "STK Push sent successfully!", data: response.data });
    } catch (error) {
        console.error("STK Push Execution Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Payment dispatch failed" });
    }
});

// Callback Route: Listens for Safaricom's Success Message
app.post('/api/mpesa-callback', (req, res) => {
    const callbackData = req.body.Body.stkCallback;
    console.log("M-Pesa Callback Received:", JSON.stringify(callbackData));

    if (callbackData.ResultCode === 0) {
        // Payment was successful!
        const accountRef = callbackData.CallbackMetadata.Item.find(item => item.Name === "AccountReference")?.Value;
        const amountPaid = callbackData.CallbackMetadata.Item.find(item => item.Name === "Amount")?.Value;
        const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber")?.Value;

        console.log(`💰 SUCCESS: Payout verified for ${accountRef}. Amount: KSh ${amountPaid}. Receipt: ${mpesaReceipt}`);
        
        // Here, the backend database dynamically upgrades the user's active license flags
    } else {
        console.log(`❌ CANCELLED: User cancelled or failed payment with code ${callbackData.ResultCode}`);
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted Successfully" });
});
