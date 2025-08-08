require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

const {
  getLatestMembership,
  isMembershipActive,
  getPhotoUrl,
  findOpenLog,
  createCheckIn,
  closeCheckOut,
  createMonthlyMembership,
  createDailyPass,
  createAuthUserWithPhoto,
} = require('./src/appwrite');

const app = express();

// ---- Middleware ----
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      httpOnly: true,
      sameSite: 'lax',
      secure: false // set true after you deploy behind HTTPS
    }
  })
);

// ---- Auth guard ----
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect('/login');
}

// ---- Pages ----
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', (req, res, next) => {
  const { email, password } = req.body || {};
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).sendFile(path.join(__dirname, 'views', 'login.html'));
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.admin = { email };
    req.session.save(err2 => (err2 ? next(err2) : res.redirect('/dashboard')));
  });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', (_req, res) => res.redirect('/login'));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/create-user', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'create_user.html')));
app.get('/create-membership', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'create_membership.html')));

// ---- API: QR scan flow ----
app.post('/api/scan/check-in', requireAuth, async (req, res) => {
  try {
    const user_id = String((req.body || {}).payload || '').trim();
    if (!/^\d{6}$/.test(user_id)) {
      return res.status(400).json({ ok: false, status: 'invalid', message: 'QR must be a 6-digit code.' });
    }

    const membership = await getLatestMembership(user_id);
    if (!membership) return res.json({ ok: true, status: 'no_membership', message: `No membership for ${user_id}.` });

    if (!isMembershipActive(membership)) {
      return res.json({
        ok: true,
        status: 'expired',
        message: `Membership expired on ${new Date(membership.endAt).toLocaleString()}.`,
        membership
      });
    }

    let photoUrl = null;
    try {
      const resp = await getPhotoUrl(user_id);
      photoUrl = resp.href || resp;
    } catch (_) {}

    const openLog = await findOpenLog(user_id);
    const actionResult = openLog ? await closeCheckOut(openLog) : await createCheckIn(user_id);

    return res.json({
      ok: true,
      status: 'active',
      action: actionResult.action,
      message:
        actionResult.action === 'checkin'
          ? `Check-in recorded for ${user_id}.`
          : `Checked out. Worked ${actionResult.doc.workedMinutes} min.`,
      membership,
      photoUrl,
      log: actionResult.doc
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Server error.' });
  }
});

// ---- API: create monthly membership ----
app.post('/api/memberships/monthly', requireAuth, async (req, res) => {
  try {
    const { user_id, months } = req.body || {};
    if (!/^\d{6}$/.test(String(user_id || ''))) {
      return res.status(400).json({ ok: false, message: 'user_id must be 6 digits.' });
    }
    const doc = await createMonthlyMembership({ user_id: String(user_id), months: Number(months || 1) });
    res.json({ ok: true, membership: doc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Failed to create monthly membership.' });
  }
});

// ---- API: create daily pass ----
app.post('/api/passes/daily', requireAuth, async (req, res) => {
  try {
    const { user_id } = req.body || {};
    if (!/^\d{6}$/.test(String(user_id || ''))) {
      return res.status(400).json({ ok: false, message: 'user_id must be 6 digits.' });
    }
    const doc = await createDailyPass({ user_id: String(user_id) });
    res.json({ ok: true, membership: doc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Failed to create daily pass.' });
  }
});

// ---- API: create user (photo + password) ----
app.post('/api/admin/create-user', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const { password, name } = req.body || {};
    if (!password) return res.status(400).json({ ok: false, message: 'password is required' });
    if (!req.file) return res.status(400).json({ ok: false, message: 'photo is required' });

    const result = await createAuthUserWithPhoto({
      password,
      name,
      photoBuffer: req.file.buffer,
      photoFilename: req.file.originalname
    });

    return res.json({
      ok: true,
      email: result.email,
      number: result.number,
      userId: result.user.$id
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Failed to create user.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
