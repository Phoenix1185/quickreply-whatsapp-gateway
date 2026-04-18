// QuickReply WhatsApp Gateway
// Baileys-based multi-tenant WhatsApp Web gateway.
// Each tenant (Lovable user) gets an isolated session under ./auth/{userId}.
// Incoming messages are forwarded to WEBHOOK_URL with HMAC signature.

import express from "express";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GATEWAY_API_KEY; // shared with Lovable app
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://yourapp.lovable.app/api/webhook
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // HMAC secret
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

if (!API_KEY) {
  console.error("FATAL: GATEWAY_API_KEY env var is required");
  process.exit(1);
}
if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.warn("WARN: WEBHOOK_URL or WEBHOOK_SECRET not set — incoming messages will not be forwarded");
}

fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// In-memory session registry: userId -> { sock, qr, status, lastError }
const sessions = new Map();

function getSessionDir(userId) {
  // sanitize: only allow alphanumerics, dashes, underscores
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("Invalid userId");
  return path.join(AUTH_DIR, safe);
}

async function startSession(userId) {
  const existing = sessions.get(userId);
  if (existing && existing.status === "connected") {
    return existing;
  }

  const dir = getSessionDir(userId);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["QuickReply", "Chrome", "1.0.0"],
  });

  const session = {
    sock,
    qr: null,
    qrDataUrl: null,
    status: "connecting", // connecting | qr | connected | disconnected
    lastError: null,
    userId,
  };
  sessions.set(userId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.qrDataUrl = await QRCode.toDataURL(qr);
      session.status = "qr";
      logger.info({ userId }, "QR code generated");
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.qrDataUrl = null;
      logger.info({ userId }, "WhatsApp connected");
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      session.status = loggedOut ? "logged_out" : "disconnected";
      session.lastError = lastDisconnect?.error?.message || null;
      logger.warn({ userId, code, loggedOut }, "Connection closed");

      sessions.delete(userId);

      if (loggedOut) {
        // wipe auth so next start gets a fresh QR
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      } else {
        // auto-reconnect
        setTimeout(() => startSession(userId).catch((e) => logger.error(e, "reconnect failed")), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      // skip groups & broadcasts
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      if (!text) continue;

      const phone = remoteJid.split("@")[0];
      await forwardToWebhook({
        userId,
        from: phone,
        text,
        messageId: msg.key.id,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || null,
      });
    }
  });

  return session;
}

async function forwardToWebhook(payload) {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) return;
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Signature": signature,
      },
      body,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, "Webhook returned non-OK");
    }
  } catch (e) {
    logger.error(e, "Failed to forward to webhook");
  }
}

// -------- HTTP API --------
const app = express();
app.use(express.json({ limit: "1mb" }));

// API key middleware (skip for /health)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sessions.size }));

// Start a session (returns immediately, QR appears via /status)
app.post("/session/:userId/start", async (req, res) => {
  try {
    const { userId } = req.params;
    const s = await startSession(userId);
    res.json({ status: s.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current session status + QR (if pending)
app.get("/session/:userId/status", (req, res) => {
  const { userId } = req.params;
  const s = sessions.get(userId);
  if (!s) {
    // also check if auth dir exists (returning user)
    try {
      const dir = getSessionDir(userId);
      const exists = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
      return res.json({ status: exists ? "idle_has_session" : "idle", qr: null });
    } catch {
      return res.json({ status: "idle", qr: null });
    }
  }
  res.json({
    status: s.status,
    qr: s.qrDataUrl,
    error: s.lastError,
  });
});

// Send a text message
app.post("/session/:userId/send", async (req, res) => {
  try {
    const { userId } = req.params;
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to and text are required" });

    const s = sessions.get(userId);
    if (!s || s.status !== "connected") {
      return res.status(409).json({ error: "Session not connected", status: s?.status || "idle" });
    }

    // normalize phone -> jid
    const cleaned = String(to).replace(/[^0-9]/g, "");
    const jid = `${cleaned}@s.whatsapp.net`;

    await s.sock.sendMessage(jid, { text: String(text) });
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "send failed");
    res.status(500).json({ error: e.message });
  }
});

// Logout / disconnect
app.post("/session/:userId/logout", async (req, res) => {
  try {
    const { userId } = req.params;
    const s = sessions.get(userId);
    if (s) {
      try { await s.sock.logout(); } catch {}
      sessions.delete(userId);
    }
    try { fs.rmSync(getSessionDir(userId), { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// On boot: auto-restore sessions that have saved auth
async function restoreSessions() {
  try {
    const userIds = fs.readdirSync(AUTH_DIR);
    for (const userId of userIds) {
      const dir = path.join(AUTH_DIR, userId);
      if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0) {
        logger.info({ userId }, "Restoring session");
        startSession(userId).catch((e) => logger.error(e, "restore failed"));
      }
    }
  } catch (e) {
    logger.error(e, "restoreSessions failed");
  }
}

app.listen(PORT, () => {
  logger.info(`QuickReply gateway listening on :${PORT}`);
  restoreSessions();
});
