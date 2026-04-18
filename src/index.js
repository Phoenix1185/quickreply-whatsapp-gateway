import express from 'express';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from 'baileys';
import QRCode from 'qrcode';
import crypto from 'crypto';
import pino from 'pino';
import { useSupabaseAuthState } from './supabaseAuthState.js';

const {
  PORT = 3000,
  GATEWAY_API_KEY,
  WEBHOOK_URL,
  WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!GATEWAY_API_KEY || !WEBHOOK_URL || !WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required env vars. See .env.example');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const logger = pino({ level: 'warn' });
const app = express();
app.use(express.json({ limit: '2mb' }));

// API key auth
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.headers['x-api-key'] !== GATEWAY_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const sessions = new Map(); // userId -> { sock, qr, status, phone }

async function startSession(userId) {
  if (sessions.get(userId)?.status === 'connected') {
    return sessions.get(userId);
  }

  const { state, saveCreds, clearAll } = await useSupabaseAuthState(supabase, userId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['QuickReply', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  const session = { sock, qr: null, status: 'connecting', phone: null, clearAll };
  sessions.set(userId, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = await QRCode.toDataURL(qr);
      session.status = 'qr';
    }

    if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      await supabase
        .from('profiles')
        .update({ whatsapp_connected: true, phone_number: session.phone })
        .eq('user_id', userId);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      session.status = loggedOut ? 'logged_out' : 'disconnected';
      sessions.delete(userId);

      if (loggedOut) {
        await clearAll();
        await supabase
          .from('profiles')
          .update({ whatsapp_connected: false })
          .eq('user_id', userId);
      } else {
        // auto-reconnect
        setTimeout(() => startSession(userId).catch(() => {}), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text) continue;

      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
      if (msg.key.remoteJid?.endsWith('@g.us')) continue; // skip groups

      const payload = JSON.stringify({ userId, from, text, timestamp: Date.now() });
      const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

      try {
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Signature': signature,
          },
          body: payload,
        });
        const data = await res.json().catch(() => ({}));
        if (data.reply) {
          await sock.sendMessage(msg.key.remoteJid, { text: data.reply });
        }
      } catch (e) {
        console.error('webhook error:', e.message);
      }
    }
  });

  return session;
}

// Start session / get QR
app.post('/session/:userId/start', async (req, res) => {
  try {
    await startSession(req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status + QR
app.get('/session/:userId/status', (req, res) => {
  const s = sessions.get(req.params.userId);
  if (!s) return res.json({ status: 'disconnected', qr: null });
  res.json({ status: s.status, qr: s.qr, phone: s.phone });
});

// Send message
app.post('/session/:userId/send', async (req, res) => {
  const s = sessions.get(req.params.userId);
  if (!s || s.status !== 'connected') {
    return res.status(400).json({ error: 'not connected' });
  }
  const { to, text } = req.body;
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  await s.sock.sendMessage(jid, { text });
  res.json({ ok: true });
});

// Logout
app.post('/session/:userId/logout', async (req, res) => {
  const s = sessions.get(req.params.userId);
  if (s) {
    try { await s.sock.logout(); } catch {}
    await s.clearAll();
    sessions.delete(req.params.userId);
  }
  await supabase
    .from('profiles')
    .update({ whatsapp_connected: false })
    .eq('user_id', req.params.userId);
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ ok: true, sessions: sessions.size }));

app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT}`);
});

// Auto-restore connected sessions on boot
(async () => {
  const { data } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('whatsapp_connected', true);
  for (const row of data || []) {
    startSession(row.user_id).catch((e) => console.error('restore failed', row.user_id, e.message));
  }
})();
