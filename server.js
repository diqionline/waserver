const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, delay, jidNormalizedUser } = require('@whiskeysockets/baileys');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

let logBuffer = [];
const addToBuffer = (msg) => {
  const timestamp = new Date().toLocaleTimeString();
  logBuffer.push(`[${timestamp}] ${msg}`);
  if (logBuffer.length > 50) logBuffer.shift();
};

// Store removed temporarily due to import issues
// const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });


const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 30036;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';
let WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://127.0.0.1/api/whatsapp_ai_webhook.php';

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (conf.webhook_url) {
        WEBHOOK_URL = conf.webhook_url;
        log.info({ WEBHOOK_URL }, 'Loaded webhook URL from config.json');
      }
    } catch (e) {
      log.error('Failed to read config.json');
    }
  }
}
loadConfig();

let sock = null;
let latestQrDataUrl = null;
let isConnected = false;
let lastError = null;
let lastDisconnect = null;
let profilePhotoUrl = null;
let profileName = null;
let conflictDisconnectCount = 0;
let profileId = null;

function clearAuthFiles() {
  const fs = require('fs');
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

async function refreshProfile() {
  if (!sock || !sock.user) return;
  let rawId = sock.user.id || '';
  let normId = rawId;
  try {
    normId = jidNormalizedUser(rawId);
  } catch (e) {}
  const justNum = normId.split('@')[0].replace(/\D/g, '');
  profileId = justNum || normId.split('@')[0];
  profileName = sock.user.name || null;
  try {
    profilePhotoUrl = await sock.profilePictureUrl(rawId, 'image');
  } catch (e) {
    profilePhotoUrl = null;
  }
}

async function startSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 2204, 13] }));

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: log,
      version
    });

    // store?.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      log.info({ update }, 'connection.update');
      const { qr, connection } = update;
      let shouldClearAuth = false;
      if (update.lastDisconnect) {
        lastDisconnect = update.lastDisconnect;
        try {
          if (update.lastDisconnect.error) {
            const err = update.lastDisconnect.error;
            lastError = err.output?.payload?.message || err.message || String(err);
            const statusCode = err.output?.statusCode || err.output?.payload?.statusCode;
            if (statusCode === 401) shouldClearAuth = true;
          }

          // Some stream errors (e.g. conflict/replaced) often require a fresh pairing.
          const errText = (lastError || '').toLowerCase();
          if (errText.includes('conflict') || errText.includes('replaced')) {
            conflictDisconnectCount += 1;
            if (conflictDisconnectCount >= 2) {
              shouldClearAuth = true;
            }
          }
        } catch (e) {
          lastError = 'unknown_disconnect_error';
        }
      }
      if (qr) {
        // generate a data URL PNG from raw QR string
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
          log.info('QR code generated and cached');
        } catch (e) {
          log.error({ err: e }, 'failed to generate QR image');
          latestQrDataUrl = null;
        }
      }

      if (connection === 'open') {
        isConnected = true;
        latestQrDataUrl = null;
        conflictDisconnectCount = 0;
        await refreshProfile();
        log.info('WhatsApp connected');
        addToBuffer('Successfully connected to WhatsApp!');
      } else if (connection === 'close') {
        isConnected = false;
        profilePhotoUrl = null;
        profileName = null;
        profileId = null;
        log.info('WhatsApp disconnected');
        addToBuffer('WhatsApp disconnected. Reconnecting...');
        setTimeout(() => {
          log.info('Attempting reconnect after close...');
          restartSocket({ clearAuth: shouldClearAuth });
        }, 1000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid;
        // Proceed even if fromMe, so webhook can detect @stop/@start from phone
        // if (msg.key.fromMe) continue;

        if (remoteJid === 'status@broadcast') {
          try {
            const response = await axios.post(WEBHOOK_URL, {
              type: 'status_broadcast',
              remoteJid,
              is_status: true
            });
            if (response.data?.action === 'read_status') {
              await sock.readMessages([msg.key]);
              log.info({ remoteJid }, 'Read status update');
            }
          } catch (err) {
            // Ignore webhook errors for status
          }
          continue;
        }

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
        if (!messageContent) continue;

        addToBuffer(`Received message from ${remoteJid}: ${messageContent.substring(0, 30)}${messageContent.length > 30 ? '...' : ''}`);

        const isGroup = remoteJid.endsWith('@g.us');

        const safeStr = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

        const normalizeJid = (jid) => {
          const raw = safeStr(jid).trim();
          if (!raw) return '';
          try {
            return jidNormalizedUser(raw);
          } catch (e) {
            // best-effort fallback
            const num = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (!num) return raw;
            return num + '@s.whatsapp.net';
          }
        };

        const looksLikePhoneJid = (jid) => {
          if (!jid) return false;
          const j = safeStr(jid).trim();
          if (!/@s\.whatsapp\.net$/i.test(j)) return false;
          const user = j.split('@')[0].split(':')[0];
          // We only accept real WA phone-style IDs for this project (Indonesia 62...)
          return /^62\d{7,18}$/.test(user);
        };

        const normalizePhoneDigits = (v) => safeStr(v).replace(/\D/g, '');

        const extractContextInfo = (messageObj) => {
          if (!messageObj || typeof messageObj !== 'object') return null;
          return (
            messageObj.extendedTextMessage?.contextInfo ||
            messageObj.imageMessage?.contextInfo ||
            messageObj.videoMessage?.contextInfo ||
            messageObj.documentMessage?.contextInfo ||
            messageObj.buttonsResponseMessage?.contextInfo ||
            messageObj.templateButtonReplyMessage?.contextInfo ||
            null
          );
        };

        const contextInfo = extractContextInfo(msg.message);

        // Raw candidates we can sometimes use to avoid @lid ids
        // Candidate JIDs/phone numbers for resolving LID -> phone
        // Baileys may include senderPn/participantPn even when remoteJid is @lid.
        const candidateJids = [
          msg?.key?.participant,
          msg?.participant,
          contextInfo?.participant,
          contextInfo?.remoteJid,
          contextInfo?.quotedMessage?.contextInfo?.participant
        ].map(safeStr).filter(Boolean);

        // Phone-number candidates from Baileys metadata (varies by version/event)
        const candidatePhones = [
          msg?.key?.senderPn,
          msg?.key?.participantPn,
          contextInfo?.senderPn,
          contextInfo?.participantPn
        ].map(safeStr).filter(Boolean);

        // Base sender jid: for some LID events Baileys may still provide key.participant
        const senderJidRaw = (msg?.key?.participant || remoteJid);
        const remoteJidRaw = safeStr(remoteJid);

        const normalizedCandidates = [senderJidRaw, remoteJidRaw, ...candidateJids]
          .map(normalizeJid)
          .filter(Boolean);

        // Convert candidate phone numbers to phone JIDs
        const phoneJidsFromPn = candidatePhones
          .map(normalizePhoneDigits)
          .filter(p => /^62\d{7,18}$/.test(p))
          .map(p => p + '@s.whatsapp.net');

        // Prefer a numeric @s.whatsapp.net jid if present anywhere
        const phoneJid = normalizedCandidates.find(looksLikePhoneJid) || phoneJidsFromPn.find(looksLikePhoneJid) || '';

        // What we use for routing & as conversation key sent to PHP
        // If we managed to find phoneJid, use it; otherwise fallback to normalized remote/sender
        // If phoneJid not found, DO NOT coerce LID digits into fake phone JIDs.
        // Keep the raw JIDs; PHP webhook will ignore until we can resolve a real 62... phone.
        let remoteJidNorm = isGroup ? remoteJidRaw : (phoneJid || remoteJidRaw);
        let senderJidNorm = isGroup ? senderJidRaw : (phoneJid || senderJidRaw);

        // Derive a plain phoneNumber for PHP (digits only) if we have a phone jid
        const phoneNumber = phoneJid ? phoneJid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';

        if (!isGroup && safeStr(remoteJidRaw).includes('@lid') && !phoneJid) {
          log.warn({
            remoteJidRaw,
            senderJidRaw: safeStr(senderJidRaw),
            senderPn: msg?.key?.senderPn,
            participantPn: msg?.key?.participantPn,
            ctxSenderPn: contextInfo?.senderPn,
            ctxParticipantPn: contextInfo?.participantPn,
            ctxParticipant: contextInfo?.participant
          }, 'LID message without resolved phoneJid');
        }

        const accountJidNorm = normalizeJid(sock?.user?.id || '');

        log.info({ remoteJid: remoteJidRaw, senderJid: senderJidRaw, messageContent, phoneJid, phoneNumber }, 'Received message');

        let accountJid = '';
        if (remoteJid.endsWith('@lid') || (msg.key.participant && msg.key.participant.endsWith('@lid'))) {
             try {
                 // Try to fetch contact info to get the real phone number (JID)
                 const lidJid = msg.key.participant || remoteJid;
                 const contact = await sock.onWhatsApp(lidJid);
                 if (contact && contact.length > 0) {
                     accountJid = contact[0].jid;
                     log.info({ lid: lidJid, resolved: accountJid }, 'Resolved LID to Phone JID via onWhatsApp');
                 }
             } catch (e) {
                 log.warn({ err: e }, 'Failed to resolve LID via onWhatsApp');
             }
        }

        const webhookPayload = {
          type: 'message',
          remoteJid: remoteJidNorm,
          senderJid: senderJidNorm,
          remoteJidRaw,
          senderJidRaw,
          phoneJid: phoneJid || null,
          phoneNumber: phoneNumber || null,
          accountJid: accountJid || null, // Send the resolved JID if found
          accountJidNorm,
          pushName: msg.pushName,
          message: messageContent,
          messageId: msg.key.id, // Send the unique message ID from WhatsApp
          fromMe: msg.key.fromMe,
          isGroup
        };
        log.info({ webhookPayload }, 'Sending Webhook Payload');

        try {
          const response = await axios.post(WEBHOOK_URL, webhookPayload);

          // Tambahkan log response webhook untuk audit
          log.info({ webhookResponse: response.data }, 'Webhook Response Data');

          const { reply, set_typing, mark_read, typing_delay } = response.data;

          if (mark_read) {
            await sock.readMessages([msg.key]);
          }

          if (set_typing) {
            // Send typing indicator
            await sock.sendPresenceUpdate('composing', remoteJidNorm);
            
            // Wait for calculated delay (typing_delay) or default 2 seconds
            const delay_ms = typing_delay || 2000;
            await delay(delay_ms);
            
            // Stop typing indicator
            await sock.sendPresenceUpdate('paused', remoteJidNorm);
          }

          // Send reply message (after typing indicator if enabled)
          if (reply) {
            // Pastikan remoteJidNorm adalah phoneJid (format 62...@s.whatsapp.net) untuk customer
            let targetJid = remoteJidNorm;
            if (phoneJid && /^62\d{7,18}@s\.whatsapp\.net$/.test(phoneJid)) {
              targetJid = phoneJid;
            }
            await sock.sendMessage(targetJid, { text: reply });
            log.info({ remoteJid: targetJid, reply }, 'Sent AI reply');
          }

        } catch (err) {
          log.error({ err: err.message }, 'Webhook forwarding failed');
        }
      }
    });
  } catch (err) {
    log.error({ err }, 'startSocket failed');
    lastError = err?.message || String(err);
  }
}

async function restartSocket({ clearAuth = false } = {}) {
  try {
    if (clearAuth) {
      if (sock && sock.logout) {
        try { await sock.logout(); } catch (e) { /* ignore */ }
      }
    } else {
      // Restart without logging out (preserve pairing)
      try {
        if (sock && typeof sock.end === 'function') {
          sock.end(new Error('restart'));
        } else if (sock && sock.ws && typeof sock.ws.close === 'function') {
          sock.ws.close();
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {}
  if (clearAuth) {
    try { clearAuthFiles(); } catch (e) {}
  }
  sock = null;
  latestQrDataUrl = null;
  isConnected = false;
  profilePhotoUrl = null;
  profileName = null;
  profileId = null;
  setTimeout(startSocket, 1000);
}

app.post('/send', async (req, res) => {
  try {
    const { phone, text, image } = req.body;
    if (!phone || (!text && !image)) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    if (!sock) {
      return res.status(503).json({ ok: false, error: 'service_unavailable' });
    }

    const jid = phone + '@s.whatsapp.net';
    
    // Validate JID if needed, but phone is usually already normalized by PHP
    
    if (image) {
      // Check if image is URL or Path
      // Since PHP sends absolute path, we can try to read it
      // But we should check if file exists
      if (fs.existsSync(image)) {
        const buffer = fs.readFileSync(image);
        await sock.sendMessage(jid, { image: buffer, caption: text });
      } else {
         // Assume it is URL
         await sock.sendMessage(jid, { image: { url: image }, caption: text });
      }
    } else {
      await sock.sendMessage(jid, { text: text });
    }

    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Send failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/status', async (req, res) => {
  res.json({ ok: true, server: true, paired: isConnected ? true : false, qr: latestQrDataUrl, lastError, lastDisconnect, profilePhotoUrl, profileName, profileId, webhookUrl: WEBHOOK_URL });
});

// Alias for hosting with /wa-server prefix
app.get('/wa-server/status', async (req, res) => {
  res.json({ ok: true, server: true, paired: isConnected ? true : false, qr: latestQrDataUrl, lastError, lastDisconnect, profilePhotoUrl, profileName, profileId, webhookUrl: WEBHOOK_URL });
});

app.get('/wa-server/logs', (req, res) => {
  res.json({ ok: true, logs: logBuffer });
});

app.get('/wa-server/', (req, res) => {
  res.json({ ok: true, message: 'Modular WA Gateway is running (via prefix)', port: PORT });
});

app.post('/logout', async (req, res) => {
  try {
    if (sock && sock.logout) {
      await sock.logout();
    }
    clearAuthFiles();
    latestQrDataUrl = null;
    isConnected = false;
    profilePhotoUrl = null;
    profileName = null;
    profileId = null;
    setTimeout(() => startSocket(), 500);
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'logout failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/restart', async (req, res) => {
  try {
    loadConfig();
    latestQrDataUrl = null;
    isConnected = false;
    const clearAuth = !!(req.body && (req.body.clearAuth === true || req.body.clearAuth === 1 || req.body.clearAuth === '1'));
    await restartSocket({ clearAuth });
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'restart failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/logs', (req, res) => {
  res.json({ ok: true, logs: logBuffer });
});

// Root route for testing connection
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Modular WA Gateway is running', port: PORT });
});

app.listen(PORT, async () => {
  log.info(`Baileys WA server listening on port ${PORT}`);
  addToBuffer(`Baileys WA server started on port ${PORT}`);
  await startSocket();
});
