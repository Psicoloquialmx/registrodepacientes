const crypto = require('crypto');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

function getLegacyCalendarConfig() {
  try {
    const cfg = functions.config();
    return (cfg && cfg.calendar) || {};
  } catch (_err) {
    return {};
  }
}

const LEGACY_CALENDAR_CONFIG = getLegacyCalendarConfig();

// Config values - use environment variables or defaults
const CALENDAR_CONFIG = {
  client_id: process.env.GOOGLE_CLIENT_ID || LEGACY_CALENDAR_CONFIG.client_id || '327033644024-dcqvtbaa08ki2he4m4jlmfgt6pf8ma8h.apps.googleusercontent.com',
  client_secret: process.env.GOOGLE_CLIENT_SECRET || LEGACY_CALENDAR_CONFIG.client_secret || '',
  redirect_uri: process.env.GOOGLE_REDIRECT_URI || LEGACY_CALENDAR_CONFIG.redirect_uri || 'https://registropx.netlify.app/api/google-calendar/callback',
  app_url: process.env.APP_URL || LEGACY_CALENDAR_CONFIG.app_url || 'https://registropx.netlify.app',
  encrypt_secret: process.env.ENCRYPT_SECRET || LEGACY_CALENDAR_CONFIG.encrypt_secret || 'axolotl_therapy_calendar_256'
};

function getOAuthClient() {
  if (!CALENDAR_CONFIG.client_secret) {
    throw new Error('Missing GOOGLE_CLIENT_SECRET environment variable.');
  }
  return new google.auth.OAuth2(CALENDAR_CONFIG.client_id, CALENDAR_CONFIG.client_secret, CALENDAR_CONFIG.redirect_uri);
}

function encryptText(plainText) {
  const key = crypto.createHash('sha256').update(String(CALENDAR_CONFIG.encrypt_secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

function decodeBearerToken(req) {
  const authHeader = req.get('x-firebase-auth') || req.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

async function verifyRequestUser(req) {
  const token = decodeBearerToken(req);
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_err) {
    return null;
  }
}

function setCors(req, res) {
  res.set('Access-Control-Allow-Origin', CALENDAR_CONFIG.app_url);
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Firebase-Auth');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

async function createOAuthState(uid) {
  const nonce = crypto.randomBytes(20).toString('hex');
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
  await db.collection('oauthStates').doc(nonce).set({
    uid,
    provider: 'google_calendar',
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return nonce;
}

async function consumeOAuthState(state) {
  if (!state) return null;
  const ref = db.collection('oauthStates').doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  if (!data || data.provider !== 'google_calendar') return null;
  if (!data.expiresAt || data.expiresAt.toMillis() < Date.now()) return null;
  return data.uid;
}

exports.googleCalendarConnect = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded?.uid) return res.status(401).json({ error: 'Unauthorized' });

    const state = await createOAuthState(decoded.uid);
    const oauth2Client = getOAuthClient();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      state,
    });

    return res.status(200).json({ authUrl });
  } catch (err) {
    console.error('googleCalendarConnect error', err);
    return res.status(500).json({
      error: 'Failed to start Google Calendar OAuth',
      detail: String(err && err.message ? err.message : err),
    });
  }
});

exports.googleCalendarCallback = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');

    const code = req.query.code;
    const state = req.query.state;
    const error = req.query.error;

    if (error) {
      return res.redirect(`${CALENDAR_CONFIG.app_url}?calendar=error&reason=${encodeURIComponent(String(error))}`);
    }

    if (!code || !state) {
      return res.redirect(`${CALENDAR_CONFIG.app_url}?calendar=error&reason=missing_code_or_state`);
    }

    const uid = await consumeOAuthState(String(state));
    if (!uid) {
      return res.redirect(`${CALENDAR_CONFIG.app_url}?calendar=error&reason=invalid_state`);
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    let primary = null;
    try {
      const calendars = await calendar.calendarList.list({ maxResults: 50 });
      primary = (calendars.data.items || []).find((c) => c.primary) || (calendars.data.items || [])[0] || null;
    } catch (_err) {
      // Some scopes may not allow listing calendars; fallback to default primary calendar.
      primary = null;
    }
    const calendarId = primary?.id || 'primary';

    const integrationRef = db
      .collection('users')
      .doc(uid)
      .collection('private')
      .doc('googleCalendarIntegration');

    const prevSnap = await integrationRef.get();
    const prev = prevSnap.exists ? prevSnap.data() : {};

    const payload = {
      connected: true,
      calendarId,
      email: primary?.summary || '',
      scope: tokens.scope || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (tokens.refresh_token) {
      payload.refreshTokenEncrypted = encryptText(tokens.refresh_token);
    } else if (prev?.refreshTokenEncrypted) {
      payload.refreshTokenEncrypted = prev.refreshTokenEncrypted;
    }

    if (tokens.access_token) {
      payload.accessTokenEncrypted = encryptText(tokens.access_token);
    }

    await integrationRef.set(payload, { merge: true });

    return res.redirect(`${CALENDAR_CONFIG.app_url}?calendar=connected`);
  } catch (err) {
    console.error('googleCalendarCallback error', err);
    return res.redirect(`${CALENDAR_CONFIG.app_url}?calendar=error&reason=callback_failed`);
  }
});

exports.googleCalendarStatus = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded?.uid) return res.status(401).json({ error: 'Unauthorized' });

    const integrationRef = db
      .collection('users')
      .doc(decoded.uid)
      .collection('private')
      .doc('googleCalendarIntegration');

    const snap = await integrationRef.get();
    if (!snap.exists) {
      return res.status(200).json({ connected: false });
    }

    const data = snap.data() || {};
    return res.status(200).json({
      connected: !!data.connected,
      calendarId: data.calendarId || 'primary',
      email: data.email || '',
      updatedAt: data.updatedAt ? data.updatedAt.toMillis() : null,
    });
  } catch (err) {
    console.error('googleCalendarStatus error', err);
    return res.status(500).json({
      error: 'Failed to read Google Calendar status',
      detail: String(err && err.message ? err.message : err),
    });
  }
});
