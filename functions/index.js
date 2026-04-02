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

const GOOGLE_CALENDAR_REQUIRED_SCOPES = [
  // Required to create/list secondary calendars (e.g., "Agenda de Pacientes").
  'https://www.googleapis.com/auth/calendar',
  // Required for event CRUD in the selected calendar.
  'https://www.googleapis.com/auth/calendar.events',
];

const AGENDA_CALENDAR_NAME = 'Agenda de Pacientes';

/**
 * Finds the 'Agenda de Pacientes' secondary calendar in the user's account,
 * or creates it if it doesn't exist yet.
 */
async function findOrCreateAgendaCalendar(calendarClient) {
  // Try to find an existing calendar with the exact name
  try {
    const list = await calendarClient.calendarList.list({ maxResults: 250 });
    const existing = (list.data.items || []).find((c) => c.summary === AGENDA_CALENDAR_NAME);
    if (existing) return existing.id;
  } catch (_err) {
    // If listing fails, fall through and attempt creation
  }

  // Create the secondary calendar
  const created = await calendarClient.calendars.insert({
    requestBody: {
      summary: AGENDA_CALENDAR_NAME,
      description: 'Sesiones de pacientes — RegistroPX',
      timeZone: 'America/Mexico_City',
    },
  });

  // Apply a teal/sage color to make it visually distinct
  try {
    await calendarClient.calendarList.patch({
      calendarId: created.data.id,
      requestBody: { colorId: '8' }, // graphite/blue-ish; options: 1-11
    });
  } catch (_err) {
    // Color is cosmetic — ignore if it fails
  }

  return created.data.id;
}

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

function decryptText(cipherText) {
  const key = crypto.createHash('sha256').update(String(CALENDAR_CONFIG.encrypt_secret)).digest();
  const [ivHex, tagHex, encHex] = String(cipherText || '').split('.');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function buildSessionKey(uid, patientId, sessionId) {
  return `${uid}_${String(patientId)}_${String(sessionId)}`.replace(/[^\w-]/g, '_');
}

async function deleteEventsBySessionKey(calendar, calendarIds, sessionKey) {
  let deletedCount = 0;
  const ids = Array.from(new Set((Array.isArray(calendarIds) ? calendarIds : []).filter(Boolean)));

  for (const calendarId of ids) {
    try {
      const listResp = await calendar.events.list({
        calendarId,
        privateExtendedProperty: `sessionKey=${sessionKey}`,
        maxResults: 20,
        showDeleted: false,
      });

      const items = listResp.data.items || [];
      for (const item of items) {
        if (!item || !item.id) continue;
        try {
          await calendar.events.delete({ calendarId, eventId: item.id });
          deletedCount++;
        } catch (deleteErr) {
          const status = deleteErr && deleteErr.code ? Number(deleteErr.code) : 0;
          if (status !== 404 && status !== 410) throw deleteErr;
        }
      }
    } catch (listErr) {
      const status = listErr && listErr.code ? Number(listErr.code) : 0;
      if (status !== 404) throw listErr;
    }
  }

  return deletedCount;
}

async function getGoogleIntegration(uid) {
  const ref = db
    .collection('users')
    .doc(uid)
    .collection('private')
    .doc('googleCalendarIntegration');

  const snap = await ref.get();
  if (!snap.exists) throw new Error('Google Calendar is not connected');
  const data = snap.data() || {};
  if (!data.connected) throw new Error('Google Calendar is not connected');
  if (!data.refreshTokenEncrypted) throw new Error('Missing refresh token');

  return {
    ref,
    calendarId: data.calendarId || 'primary',
    refreshToken: decryptText(data.refreshTokenEncrypted),
  };
}

async function getCalendarClientForUser(uid) {
  const integration = await getGoogleIntegration(uid);
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: integration.refreshToken });
  const calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });

  let calendarId = integration.calendarId;

  // Migrate users who were connected before the dedicated calendar feature:
  // if their stored calendarId is still 'primary', find/create the sub-calendar.
  if (!calendarId || calendarId === 'primary') {
    try {
      calendarId = await findOrCreateAgendaCalendar(calendarClient);
      await integration.ref.update({ calendarId });
    } catch (_err) {
      console.warn('Could not migrate to dedicated calendar, falling back to primary', _err && _err.message);
      calendarId = 'primary';
    }
  }

  return {
    oauth2Client,
    calendar: calendarClient,
    calendarId,
  };
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
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
      scope: GOOGLE_CALENDAR_REQUIRED_SCOPES,
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

    // Get the user's primary email for display purposes
    let primaryEmail = '';
    try {
      const calendars = await calendar.calendarList.list({ maxResults: 50 });
      const primary = (calendars.data.items || []).find((c) => c.primary) || null;
      primaryEmail = primary?.id || ''; // primary calendar id is the user's email
    } catch (_err) {
      // Non-blocking
    }

    // Find or create the dedicated 'Agenda de Pacientes' sub-calendar
    let calendarId = 'primary'; // safe fallback
    try {
      calendarId = await findOrCreateAgendaCalendar(calendar);
    } catch (_err) {
      console.warn('Could not find/create Agenda de Pacientes calendar, falling back to primary', _err && _err.message);
    }

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
      email: primaryEmail,
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

exports.googleCalendarUpsertSession = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const patientId = body.patientId;
    const sessionId = body.sessionId;
    const title = body.title || 'Sesion';
    const description = body.description || '';
    const colorId = body.colorId;
    const startIso = body.startIso;
    const endIso = body.endIso;

    if (!patientId || !sessionId || !startIso || !endIso) {
      return res.status(400).json({ error: 'Missing required fields: patientId, sessionId, startIso, endIso' });
    }

    const uid = decoded.uid;
    const sessionKey = buildSessionKey(uid, patientId, sessionId);
    const mapDocId = `googleCalendarSessionMap_${sessionKey}`;
    const mapRef = db.collection('users').doc(uid).collection('private').doc(mapDocId);
    const mapSnap = await mapRef.get();
    const mapData = mapSnap.exists ? (mapSnap.data() || {}) : {};

    const { calendar, calendarId } = await getCalendarClientForUser(uid);

    const eventPayload = {
      summary: title,
      description,
      start: { dateTime: startIso, timeZone: 'America/Mexico_City' },
      end: { dateTime: endIso, timeZone: 'America/Mexico_City' },
      extendedProperties: {
        private: {
          source: 'registropx',
          sessionKey,
          patientId: String(patientId),
          sessionId: String(sessionId),
        },
      },
    };

    if (/^(?:[1-9]|10|11)$/.test(String(colorId || ''))) {
      eventPayload.colorId = String(colorId);
    }

    const previousCalendarId = mapData.calendarId || null;
    const previousEventId = mapData.eventId || null;
    let eventId = previousEventId;

    if (eventId) {
      try {
        await calendar.events.update({
          calendarId,
          eventId,
          requestBody: eventPayload,
        });
      } catch (e) {
        const status = e && e.code ? Number(e.code) : 0;
        if (status === 404) {
          const created = await calendar.events.insert({
            calendarId,
            requestBody: eventPayload,
          });
          eventId = created.data.id;
        } else {
          throw e;
        }
      }
    } else {
      const created = await calendar.events.insert({
        calendarId,
        requestBody: eventPayload,
      });
      eventId = created.data.id;
    }

    // If this session used to be linked to another calendar (typically 'primary'),
    // remove the legacy event there so the session appears only once.
    if (
      previousCalendarId &&
      previousEventId &&
      previousCalendarId !== calendarId
    ) {
      try {
        await calendar.events.delete({
          calendarId: previousCalendarId,
          eventId: previousEventId,
        });
      } catch (legacyDeleteErr) {
        const status = legacyDeleteErr && legacyDeleteErr.code ? Number(legacyDeleteErr.code) : 0;
        // Ignore not found; it may have already been removed manually.
        if (status !== 404) {
          console.warn('Could not delete legacy event from previous calendar', {
            previousCalendarId,
            previousEventId,
            status,
            message: String(legacyDeleteErr && legacyDeleteErr.message ? legacyDeleteErr.message : legacyDeleteErr),
          });
        }
      }
    }

    await mapRef.set(
      {
        sessionKey,
        patientId: String(patientId),
        sessionId: String(sessionId),
        eventId,
        calendarId,
        status: 'linked',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, sessionKey, eventId, calendarId });
  } catch (err) {
    console.error('googleCalendarUpsertSession error', err);
    return res.status(500).json({
      error: 'Failed to upsert calendar session',
      detail: String(err && err.message ? err.message : err),
    });
  }
});

exports.googleCalendarDeleteSession = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const patientId = body.patientId;
    const sessionId = body.sessionId;

    if (!patientId || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields: patientId, sessionId' });
    }

    const uid = decoded.uid;
    const sessionKey = buildSessionKey(uid, patientId, sessionId);
    const mapDocId = `googleCalendarSessionMap_${sessionKey}`;
    const mapRef = db.collection('users').doc(uid).collection('private').doc(mapDocId);
    const mapSnap = await mapRef.get();
    const { calendar, calendarId: activeCalendarId } = await getCalendarClientForUser(uid);

    let deletedCount = 0;

    if (mapSnap.exists) {
      const mapData = mapSnap.data() || {};
      const eventId = mapData.eventId || null;
      const mappedCalendarId = mapData.calendarId || activeCalendarId || 'primary';

      if (eventId) {
        try {
          await calendar.events.delete({ calendarId: mappedCalendarId, eventId });
          deletedCount++;
        } catch (e) {
          const status = e && e.code ? Number(e.code) : 0;
          if (status !== 404 && status !== 410) throw e;
        }
      }
    }

    // Fallback cleanup: if mapping is missing/stale, search by sessionKey in both
    // the active agenda calendar and the legacy primary calendar.
    deletedCount += await deleteEventsBySessionKey(calendar, [activeCalendarId, 'primary'], sessionKey);

    await mapRef.set(
      {
        status: 'deleted',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, deleted: deletedCount > 0, deletedCount, sessionKey });
  } catch (err) {
    console.error('googleCalendarDeleteSession error', err);
    return res.status(500).json({
      error: 'Failed to delete calendar session',
      detail: String(err && err.message ? err.message : err),
    });
  }
});

/**
 * One-time cleanup: deletes all events tagged source=registropx from the
 * user's primary Google Calendar, leaving only the Agenda de Pacientes ones.
 * Safe to run multiple times (already-deleted events return 404 and are ignored).
 */
exports.googleCalendarPurgeRemnants = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const maxDeletesRaw = parseInt(body.maxDeletes, 10);
    const maxDeletes = Math.max(10, Math.min(150, Number.isFinite(maxDeletesRaw) ? maxDeletesRaw : 50));

    const uid = decoded.uid;
    const { calendar } = await getCalendarClientForUser(uid);

    let deleted = 0;
    let processed = 0;
    let pageToken = undefined;
    let hasMore = false;

    do {
      const listResp = await calendar.events.list({
        calendarId: 'primary',
        privateExtendedProperty: 'source=registropx',
        maxResults: 100,
        pageToken,
        showDeleted: false,
      });

      const events = (listResp.data.items || []);
      pageToken = listResp.data.nextPageToken;

      for (const evt of events) {
        if (processed >= maxDeletes) {
          hasMore = true;
          break;
        }
        if (!evt.id) continue;
        processed++;
        try {
          await calendar.events.delete({ calendarId: 'primary', eventId: evt.id });
          deleted++;
        } catch (delErr) {
          const status = delErr && delErr.code ? Number(delErr.code) : 0;
          if (status !== 404 && status !== 410) {
            console.warn('purgeRemnants: could not delete event', evt.id, String(delErr && delErr.message ? delErr.message : delErr));
          }
        }
      }

      if (processed >= maxDeletes) {
        hasMore = true;
        break;
      }
    } while (pageToken);

    console.info('googleCalendarPurgeRemnants finished', { uid, deleted, processed, hasMore, maxDeletes });
    return res.status(200).json({ ok: true, deleted, processed, hasMore, maxDeletes });
  } catch (err) {
    console.error('googleCalendarPurgeRemnants error', err);
    return res.status(500).json({
      error: 'Failed to purge remnant events',
      detail: String(err && err.message ? err.message : err),
    });
  }
});

/**
 * Migrates app events from primary calendar to the dedicated Agenda calendar.
 * For each source-tagged event in primary, ensures a matching event exists in
 * Agenda (by sessionKey when available), then deletes the primary copy.
 */
exports.googleCalendarMigratePrimaryToAgenda = functions.https.onRequest(async (req, res) => {
  try {
    if (setCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const decoded = await verifyRequestUser(req);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const maxOpsRaw = parseInt(body.maxOps, 10);
    const maxOps = Math.max(5, Math.min(80, Number.isFinite(maxOpsRaw) ? maxOpsRaw : 20));

    const uid = decoded.uid;
    const { calendar, calendarId } = await getCalendarClientForUser(uid);

    let processed = 0;
    let moved = 0;
    let alreadyInAgenda = 0;
    let primaryDeleted = 0;
    let agendaDuplicatesDeleted = 0;
    let hasMore = false;
    let pageToken = undefined;

    do {
      const listResp = await calendar.events.list({
        calendarId: 'primary',
        privateExtendedProperty: 'source=registropx',
        maxResults: 100,
        pageToken,
        showDeleted: false,
      });

      const events = listResp.data.items || [];
      pageToken = listResp.data.nextPageToken;

      for (let i = 0; i < events.length; i++) {
        if (processed >= maxOps) {
          hasMore = true;
          break;
        }

        const primaryEvent = events[i] || {};
        const primaryEventId = primaryEvent.id;
        if (!primaryEventId) continue;

        processed++;

        const extPrivate = (primaryEvent.extendedProperties && primaryEvent.extendedProperties.private) || {};
        const sessionKey = extPrivate.sessionKey || '';

        let agendaEventId = null;
        let agendaMatches = [];

        if (sessionKey) {
          const matchResp = await calendar.events.list({
            calendarId,
            privateExtendedProperty: `sessionKey=${sessionKey}`,
            maxResults: 10,
            showDeleted: false,
          });
          agendaMatches = matchResp.data.items || [];
        }

        if (agendaMatches.length > 0) {
          agendaEventId = agendaMatches[0].id || null;
          alreadyInAgenda++;

          // Keep one copy in agenda and delete extra duplicates for this session.
          if (agendaMatches.length > 1) {
            for (let j = 1; j < agendaMatches.length; j++) {
              const dupId = agendaMatches[j] && agendaMatches[j].id;
              if (!dupId) continue;
              try {
                await calendar.events.delete({ calendarId, eventId: dupId });
                agendaDuplicatesDeleted++;
              } catch (dupErr) {
                const status = dupErr && dupErr.code ? Number(dupErr.code) : 0;
                if (status !== 404 && status !== 410) {
                  console.warn('migratePrimaryToAgenda: could not delete duplicate agenda event', dupId, String(dupErr && dupErr.message ? dupErr.message : dupErr));
                }
              }
            }
          }
        } else {
          const created = await calendar.events.insert({
            calendarId,
            requestBody: {
              summary: primaryEvent.summary || 'Sesion',
              description: primaryEvent.description || '',
              start: primaryEvent.start,
              end: primaryEvent.end,
              colorId: primaryEvent.colorId,
              extendedProperties: primaryEvent.extendedProperties,
            },
          });
          agendaEventId = created.data && created.data.id ? created.data.id : null;
          moved++;
        }

        try {
          await calendar.events.delete({ calendarId: 'primary', eventId: primaryEventId });
          primaryDeleted++;
        } catch (delErr) {
          const status = delErr && delErr.code ? Number(delErr.code) : 0;
          if (status !== 404 && status !== 410) throw delErr;
        }

        const patientId = extPrivate.patientId || '';
        const sessionId = extPrivate.sessionId || '';
        if (sessionKey && patientId && sessionId && agendaEventId) {
          const mapDocId = `googleCalendarSessionMap_${sessionKey}`;
          const mapRef = db.collection('users').doc(uid).collection('private').doc(mapDocId);
          await mapRef.set(
            {
              sessionKey,
              patientId: String(patientId),
              sessionId: String(sessionId),
              eventId: String(agendaEventId),
              calendarId,
              status: 'linked',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
      }

      if (processed >= maxOps) {
        hasMore = true;
        break;
      }
    } while (pageToken);

    return res.status(200).json({
      ok: true,
      processed,
      moved,
      alreadyInAgenda,
      primaryDeleted,
      agendaDuplicatesDeleted,
      hasMore,
      maxOps,
      agendaCalendarId: calendarId,
    });
  } catch (err) {
    console.error('googleCalendarMigratePrimaryToAgenda error', err);
    return res.status(500).json({
      error: 'Failed to migrate events from primary to agenda',
      detail: String(err && err.message ? err.message : err),
    });
  }
});
