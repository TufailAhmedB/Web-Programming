'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'smart-queue-local-demo-change-this-secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const db = new sqlite3.Database(path.join(__dirname, 'queue.db'));
const SERVICES = [
  'General Enquiry', 'Fees and Accounts', 'Certificate Request',
  'Bonafide / ID Card', 'Examination Section', 'Admissions', 'Document Verification', 'Other Services'
];
const STATUSES = ['waiting', 'serving', 'completed', 'skipped'];
let mutationTail = Promise.resolve();
function withMutationLock(task) {
  const result = mutationTail.then(task, task);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'smartqueue.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 2 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function run(sql, params) {
  return new Promise((resolve, reject) => db.run(sql, params || [], function (err) {
    if (err) return reject(err);
    resolve({ lastID: this.lastID, changes: this.changes });
  }));
}
function get(sql, params) {
  return new Promise((resolve, reject) => db.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row)));
}
function all(sql, params) {
  return new Promise((resolve, reject) => db.all(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows)));
}
function todaySql() { return "date('now', 'localtime')"; }
function tokenLabel(n) { return 'A' + String(n).padStart(3, '0'); }
function validId(id) { return /^\d+$/.test(String(id)) && Number(id) > 0; }
function cleanString(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
}
function apiError(res, status, message) { return res.status(status).json({ error: message }); }
function requireStaff(req, res, next) {
  if (req.session && req.session.staff && req.session.staff.role === 'admin') return next();
  return apiError(res, 401, 'Staff login is required to perform this action.');
}

async function initDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_number INTEGER NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','serving','completed','skipped')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const columns = await all('PRAGMA table_info(tokens)');
  const existing = columns.map(c => c.name);
  const migrations = [
    ['register_number', "ALTER TABLE tokens ADD COLUMN register_number TEXT NOT NULL DEFAULT ''"],
    ['department', "ALTER TABLE tokens ADD COLUMN department TEXT NOT NULL DEFAULT ''"],
    ['description', "ALTER TABLE tokens ADD COLUMN description TEXT NOT NULL DEFAULT ''"],
    ['updated_at', "ALTER TABLE tokens ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"],
    ['serving_started_at', "ALTER TABLE tokens ADD COLUMN serving_started_at TEXT NOT NULL DEFAULT ''"],
    ['completed_at', "ALTER TABLE tokens ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''"],
    ['queue_entered_at', "ALTER TABLE tokens ADD COLUMN queue_entered_at TEXT NOT NULL DEFAULT ''"]
  ];
  for (const migration of migrations) if (!existing.includes(migration[0])) await run(migration[1]);
  await run("UPDATE tokens SET updated_at = created_at WHERE updated_at = ''");
  await run("UPDATE tokens SET queue_entered_at = created_at WHERE queue_entered_at = ''");
  await run(`CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS staff_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const serviceColumns = await all('PRAGMA table_info(services)');
  if (!serviceColumns.some(c => c.name === 'paused')) await run('ALTER TABLE services ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  for (const service of SERVICES) await run('INSERT OR IGNORE INTO services (name) VALUES (?)', [service]);
  const existingAdmin = await get('SELECT id FROM staff_users WHERE username = ?', [ADMIN_USERNAME]);
  if (!existingAdmin) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await run('INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)', [ADMIN_USERNAME, hash, 'admin']);
    console.log('Initial staff account created for username:', ADMIN_USERNAME);
  }
  await run('CREATE INDEX IF NOT EXISTS idx_tokens_status_number ON tokens(status, token_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at)');
}

async function logAction(tokenId, action, details) {
  await run('INSERT INTO activity_logs (token_id, action, details) VALUES (?, ?, ?)', [tokenId || null, action, details || '']);
}
async function getQueue(serviceName) {
  const today = todaySql();
  const services = await all('SELECT name, paused FROM services WHERE active = 1 ORDER BY name');
  const selectedService = services.some(s => s.name === serviceName) ? serviceName : (services[0] ? services[0].name : '');
  const selectedMeta = services.find(s => s.name === selectedService);
  const current = selectedService ? await get("SELECT * FROM tokens WHERE status = 'serving' AND purpose = ? ORDER BY token_number ASC LIMIT 1", [selectedService]) : null;
  const recallLog = current ? await get("SELECT created_at FROM activity_logs WHERE token_id = ? AND action = 'recalled' AND created_at >= ? ORDER BY id DESC LIMIT 1", [current.id, current.serving_started_at || current.created_at]) : null;
  const queue = selectedService ? await all("SELECT * FROM tokens WHERE status = 'waiting' AND purpose = ? ORDER BY queue_entered_at ASC, token_number ASC", [selectedService]) : [];
  const counts = selectedService ? await get(`SELECT
    SUM(CASE WHEN status = 'waiting' AND purpose = ? THEN 1 ELSE 0 END) AS waiting,
    SUM(CASE WHEN status = 'completed' AND purpose = ? AND date(updated_at, 'localtime') = ${today} THEN 1 ELSE 0 END) AS completedToday,
    SUM(CASE WHEN status = 'skipped' AND purpose = ? AND date(updated_at, 'localtime') = ${today} THEN 1 ELSE 0 END) AS skippedToday,
    SUM(CASE WHEN purpose = ? AND date(created_at, 'localtime') = ${today} THEN 1 ELSE 0 END) AS issuedToday,
    COALESCE(MAX(CASE WHEN purpose = ? THEN token_number END), 0) AS lastToken,
    COALESCE(AVG(CASE WHEN status = 'completed' AND purpose = ? AND serving_started_at <> '' AND completed_at <> '' THEN (julianday(completed_at) - julianday(serving_started_at)) * 1440 END), 5) AS averageServiceMinutes
    FROM tokens`, [selectedService, selectedService, selectedService, selectedService, selectedService, selectedService]) : { waiting: 0, completedToday: 0, skippedToday: 0, issuedToday: 0, lastToken: 0, averageServiceMinutes: 5 };
  const averageServiceMinutes = Math.max(1, Math.min(120, Math.round(Number(counts.averageServiceMinutes) || 5)));
  const queueWithPosition = queue.map((token, index) => { const estimate = (index + 1) * averageServiceMinutes; return { ...token, position: index + 1, estimated_wait_minutes: estimate, estimated_wait_min: Math.max(1, Math.floor(estimate * 0.8)), estimated_wait_max: Math.max(1, Math.ceil(estimate * 1.3)) }; });
  return {
    selectedService, paused: Boolean(selectedMeta && selectedMeta.paused),
    current: current ? { ...current, token_label: tokenLabel(current.token_number) } : null,
    recallAnnouncement: current && recallLog ? 'Token ' + tokenLabel(current.token_number) + ' is being recalled for ' + selectedService + '. Please proceed to the service desk.' : null,
    queue: queueWithPosition.map(t => ({ ...t, token_label: tokenLabel(t.token_number) })),
    waiting: Number(counts.waiting) || 0, completed: Number(counts.completedToday) || 0, skipped: Number(counts.skippedToday) || 0,
    issuedToday: Number(counts.issuedToday) || 0, lastToken: Number(counts.lastToken) || 0,
    averageServiceMinutes, services
  };
}
function publicQueue(queue) {
  return {
    selectedService: queue.selectedService, paused: queue.paused,
    current: queue.current ? { token_label: queue.current.token_label, purpose: queue.current.purpose } : null,
    recallAnnouncement: queue.recallAnnouncement,
    waiting: queue.waiting,
    lastToken: queue.lastToken,
    averageServiceMinutes: queue.averageServiceMinutes,
    queue: queue.queue.map(t => ({ token_label: t.token_label, purpose: t.purpose, position: t.position, estimated_wait_minutes: t.estimated_wait_minutes, estimated_wait_min: t.estimated_wait_min, estimated_wait_max: t.estimated_wait_max })),
    services: queue.services
  };
}
function requestedService(req) { return cleanString(req.query && req.query.service, 80); }
async function resolveService(name) {
  if (name) {
    const found = await get('SELECT name FROM services WHERE name = ? AND active = 1', [name]);
    if (!found) { const error = new Error('Choose a valid active service.'); error.status = 400; throw error; }
    return found.name;
  }
  const first = await get('SELECT name FROM services WHERE active = 1 ORDER BY name LIMIT 1');
  return first ? first.name : '';
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Smart Queue' }));
app.get('/api/auth/me', (req, res) => res.json({ authenticated: !!(req.session && req.session.staff), staff: req.session && req.session.staff ? req.session.staff : null }));
app.post('/api/auth/login', async (req, res) => {
  const username = cleanString(req.body && req.body.username, 80);
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password || password.length > 200) return apiError(res, 400, 'Enter your staff username and password.');
  try {
    const user = await get('SELECT id, username, password_hash, role FROM staff_users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return apiError(res, 401, 'Incorrect username or password.');
    req.session.regenerate(err => {
      if (err) return apiError(res, 500, 'Unable to start a secure staff session.');
      req.session.staff = { id: user.id, username: user.username, role: user.role };
      req.session.save(saveErr => {
        if (saveErr) return apiError(res, 500, 'Unable to save the staff session.');
        res.json({ message: 'Login successful.', staff: req.session.staff });
      });
    });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to sign in right now.'); }
});
app.post('/api/auth/logout', (req, res) => {
  if (!req.session) return res.json({ message: 'Signed out.' });
  req.session.destroy(err => {
    if (err) return apiError(res, 500, 'Unable to sign out.');
    res.clearCookie('smartqueue.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
    res.json({ message: 'Signed out.' });
  });
});

app.get('/api/services', async (req, res) => {
  try { res.json({ services: await all('SELECT name, paused FROM services WHERE active = 1 ORDER BY name') }); }
  catch (err) { console.error(err.message); apiError(res, 500, 'Unable to load services.'); }
});
app.get('/api/queue', async (req, res) => {
  try { const service = await resolveService(requestedService(req)); res.json(publicQueue(await getQueue(service))); }
  catch (err) { if (err.status) return apiError(res, err.status, err.message); console.error(err.message); apiError(res, 500, 'Unable to load the public queue.'); }
});
app.get('/api/admin/queue', requireStaff, async (req, res) => {
  try { const service = await resolveService(requestedService(req)); res.json(await getQueue(service)); }
  catch (err) { if (err.status) return apiError(res, err.status, err.message); console.error(err.message); apiError(res, 500, 'Unable to load the staff queue.'); }
});
app.post('/api/admin/services/pause', requireStaff, async (req, res) => {
  const service = cleanString(req.body && req.body.service, 80);
  const paused = req.body && req.body.paused;
  if (typeof paused !== 'boolean') return apiError(res, 400, 'Choose whether to pause or resume the service.');
  try {
    const result = await run('UPDATE services SET paused = ? WHERE name = ? AND active = 1', [paused ? 1 : 0, service]);
    if (!result.changes) return apiError(res, 404, 'Service was not found.');
    await logAction(null, paused ? 'service_paused' : 'service_resumed', service);
    res.json({ message: service + (paused ? ' is now paused. New student tokens are disabled.' : ' has resumed and can accept new tokens.'), ...(await getQueue(service)) });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to update service availability.'); }
});

app.get('/api/admin/tokens', requireStaff, async (req, res) => {
  const search = cleanString(req.query.search, 80);
  const service = cleanString(req.query.service, 80);
  const status = cleanString(req.query.status, 20).toLowerCase();
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  const where = [], params = [];
  if (search) {
    where.push("(CAST(token_number AS TEXT) LIKE ? OR student_name LIKE ? OR register_number LIKE ? OR ('A' || printf('%03d', token_number)) LIKE ?)");
    const pattern = '%' + search + '%'; params.push(pattern, pattern, pattern, pattern);
  }
  if (service) { where.push('purpose = ?'); params.push(service); }
  if (STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const rows = await all(`SELECT id, token_number, student_name, register_number, department, purpose, description, status, created_at, updated_at FROM tokens ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const count = await get(`SELECT COUNT(*) AS total FROM tokens ${clause}`, params);
    res.json({ tokens: rows.map(t => ({ ...t, token_label: tokenLabel(t.token_number) })), total: count.total, page, limit });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to search token records.'); }
});

app.post('/api/tokens', async (req, res) => {
  const studentName = cleanString(req.body && req.body.studentName, 80);
  const registerNumber = cleanString(req.body && req.body.registerNumber, 30).toUpperCase();
  const department = cleanString(req.body && req.body.department, 80);
  const purpose = cleanString(req.body && req.body.purpose, 80);
  const description = cleanString(req.body && req.body.description, 240);
  if (!studentName || !registerNumber || !purpose) return apiError(res, 400, 'Enter the student name, register number, and select a service.');
  if (!/^[A-Z0-9][A-Z0-9/-]{2,29}$/.test(registerNumber)) return apiError(res, 400, 'Enter a valid register number using letters, numbers, hyphens, or slashes.');
  if (!/^[\p{L}\p{M} .'-]+$/u.test(studentName)) return apiError(res, 400, 'Use letters, spaces, apostrophes, dots, or hyphens in the student name.');
  try {
    const token = await withMutationLock(async () => {
      const serviceExists = await get('SELECT id, paused FROM services WHERE name = ? AND active = 1', [purpose]);
      if (!serviceExists) { const error = new Error('Choose a valid service from the list.'); error.status = 400; throw error; }
      if (serviceExists.paused) { const error = new Error('This service is temporarily unavailable. Please choose another service or check again later.'); error.status = 409; throw error; }
      const duplicate = await get("SELECT id FROM tokens WHERE register_number = ? AND status IN ('waiting','serving')", [registerNumber]);
      if (duplicate) { const error = new Error('This register number already has an active token.'); error.status = 409; throw error; }
      await run('BEGIN IMMEDIATE TRANSACTION');
      try {
        const next = await get('SELECT COALESCE(MAX(token_number), 0) + 1 AS n FROM tokens');
        const inserted = await run(`INSERT INTO tokens (token_number, student_name, register_number, department, purpose, description, status, queue_entered_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', strftime('%Y-%m-%d %H:%M:%f','now'))`, [next.n, studentName, registerNumber, department, purpose, description]);
        await run('COMMIT');
        await logAction(inserted.lastID, 'issued', tokenLabel(next.n));
        return { id: inserted.lastID, token_number: next.n, token_label: tokenLabel(next.n), student_name: studentName, register_number: registerNumber, department, purpose, description, status: 'waiting' };
      } catch (err) { try { await run('ROLLBACK'); } catch (_) {} throw err; }
    });
    res.status(201).json({ message: 'Token generated successfully.', token });
  } catch (err) {
    if (err.status) return apiError(res, err.status, err.message);
    console.error(err.message); apiError(res, 500, 'Unable to save the token. Please try again.');
  }
});

app.get('/api/lookup', async (req, res) => {
  const tokenText = cleanString(req.query.token, 12).toUpperCase();
  const registerNumber = cleanString(req.query.registerNumber, 30).toUpperCase();
  const match = tokenText.match(/^A?(\d{1,9})$/);
  if (!match || !registerNumber) return apiError(res, 400, 'Enter both your token number and register number.');
  try {
    const token = await get('SELECT token_number, student_name, purpose, department, status, created_at, queue_entered_at FROM tokens WHERE token_number = ? AND UPPER(register_number) = ?', [Number(match[1]), registerNumber]);
    if (!token) return apiError(res, 404, 'No matching token was found. Check both details and try again.');
    const position = token.status === 'waiting' ? (await get("SELECT COUNT(*) AS n FROM tokens WHERE status = 'waiting' AND purpose = ? AND (queue_entered_at < ? OR (queue_entered_at = ? AND token_number < ?))", [token.purpose, token.queue_entered_at, token.queue_entered_at, token.token_number])).n + 1 : null;
    const queueStats = await getQueue(token.purpose);
    const estimate = position ? position * queueStats.averageServiceMinutes : 0;
    res.json({ token: { ...token, token_label: tokenLabel(token.token_number), position, estimated_wait_minutes: estimate, estimated_wait_min: position ? Math.max(1, Math.floor(estimate * 0.8)) : 0, estimated_wait_max: position ? Math.max(1, Math.ceil(estimate * 1.3)) : 0 } });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to look up this token.'); }
});

app.post('/api/admin/next', requireStaff, async (req, res) => {
  try {
    const service = await resolveService(cleanString(req.body && req.body.service, 80));
    const called = await withMutationLock(async () => {
      await run('BEGIN IMMEDIATE TRANSACTION');
      try {
        const next = await get("SELECT * FROM tokens WHERE status = 'waiting' AND purpose = ? ORDER BY queue_entered_at ASC, token_number ASC LIMIT 1", [service]);
        if (!next) { const error = new Error('There are no waiting tokens.'); error.status = 400; throw error; }
        await run("UPDATE tokens SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE status = 'serving' AND purpose = ?", [service]);
        await run("UPDATE tokens SET status = 'serving', serving_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'waiting'", [next.id]);
        await run('COMMIT');
        await logAction(next.id, 'called', tokenLabel(next.token_number));
        return next;
      } catch (err) { try { await run('ROLLBACK'); } catch (_) {} throw err; }
    });
    res.json({ message: 'Now serving ' + tokenLabel(called.token_number) + ' for ' + service + '.', ...(await getQueue(service)) });
  } catch (err) { if (err.status) return apiError(res, err.status, err.message); console.error(err.message); apiError(res, 500, 'Unable to call the next token.'); }
});
app.post('/api/admin/tokens/:id/complete', requireStaff, async (req, res) => {
  if (!validId(req.params.id)) return apiError(res, 400, 'Invalid token ID.');
  try {
    const result = await withMutationLock(async () => {
      const update = await run("UPDATE tokens SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'serving'", [Number(req.params.id)]);
      if (update.changes) await logAction(Number(req.params.id), 'completed', 'Service completed');
      return update;
    });
    if (!result.changes) return apiError(res, 409, 'This token is not currently being served.');
    const token = await get('SELECT purpose FROM tokens WHERE id = ?', [Number(req.params.id)]);
    res.json({ message: 'Service marked as completed.', ...(await getQueue(token && token.purpose)) });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to complete this token.'); }
});
app.post('/api/admin/tokens/:id/skip', requireStaff, async (req, res) => {
  if (!validId(req.params.id)) return apiError(res, 400, 'Invalid token ID.');
  try {
    const result = await withMutationLock(async () => {
      const update = await run("UPDATE tokens SET status = 'skipped', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('waiting','serving')", [Number(req.params.id)]);
      if (update.changes) await logAction(Number(req.params.id), 'skipped', 'Token skipped');
      return update;
    });
    if (!result.changes) return apiError(res, 409, 'This token cannot be skipped.');
    const token = await get('SELECT purpose FROM tokens WHERE id = ?', [Number(req.params.id)]);
    res.json({ message: 'Token skipped.', ...(await getQueue(token && token.purpose)) });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to skip this token.'); }
});
app.post('/api/admin/recall', requireStaff, async (req, res) => {
  try {
    const service = await resolveService(cleanString(req.body && req.body.service, 80));
    const current = await get("SELECT * FROM tokens WHERE status = 'serving' AND purpose = ? ORDER BY token_number ASC LIMIT 1", [service]);
    if (!current) return apiError(res, 400, 'There is no token currently being served.');
    await logAction(current.id, 'recalled', 'Current token recalled');
    res.json({ message: 'Recalled ' + tokenLabel(current.token_number) + ' for ' + service + '.', ...(await getQueue(service)) });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to recall the current token.'); }
});
app.post('/api/admin/tokens/:id/requeue', requireStaff, async (req, res) => {
  if (!validId(req.params.id)) return apiError(res, 400, 'Invalid token ID.');
  try {
    const result = await withMutationLock(async () => {
      const token = await get("SELECT id, purpose, token_number FROM tokens WHERE id = ? AND status = 'skipped'", [Number(req.params.id)]);
      if (!token) return null;
      const update = await run("UPDATE tokens SET status = 'waiting', queue_entered_at = strftime('%Y-%m-%d %H:%M:%f','now'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'skipped'", [token.id]);
      if (update.changes) await logAction(token.id, 'requeued', 'Returned to the end of the service queue');
      return update.changes ? token : null;
    });
    if (!result) return apiError(res, 409, 'Only skipped tokens can be returned to the queue.');
    res.json({ message: tokenLabel(result.token_number) + ' returned to the ' + result.purpose + ' queue.', ...(await getQueue(result.purpose)) });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to requeue this token.'); }
});

app.post('/api/admin/reset', requireStaff, async (req, res) => {
  if (!req.body || req.body.confirm !== 'RESET') return apiError(res, 400, 'Confirmation is required to reset the queue.');
  try {
    await withMutationLock(async () => {
      await run('BEGIN IMMEDIATE TRANSACTION');
      try { await run('DELETE FROM tokens'); await run('DELETE FROM activity_logs'); await run("DELETE FROM sqlite_sequence WHERE name IN ('tokens','activity_logs')"); await run('COMMIT'); }
      catch (err) { try { await run('ROLLBACK'); } catch (_) {} throw err; }
    });
    res.json({ message: 'Queue has been reset.' });
  } catch (err) { console.error(err.message); apiError(res, 500, 'Unable to reset the queue.'); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log('Smart Queue is running on port ' + PORT));
}).catch(err => {
  console.error('Database initialization failed:', err.message);
  process.exit(1);
});
