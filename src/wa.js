import pkg from "@whiskeysockets/baileys";
const makeWASocket = pkg.default || pkg;
const DisconnectReason = pkg.DisconnectReason || (pkg.default && pkg.default.DisconnectReason);
const fetchLatestBaileysVersion = pkg.fetchLatestBaileysVersion || (pkg.default && pkg.default.fetchLatestBaileysVersion);

import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import crypto from "crypto";
import { usePostgresAuthState } from "./auth-state.js";
import { setSession, getSession } from "./db.js";

const logger = pino({ level: "warn" });
const sockets = new Map(); // userId -> sock
const pendingPair = new Map(); // userId -> phoneNumber

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

function sign(body) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function postWebhook(userId, event, data) {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) return;
  const body = JSON.stringify({ userId, event, data });
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-signature": sign(body) },
      body,
    });
  } catch (e) {
    console.error("webhook error", e?.message);
  }
}

export async function startSession(userId, opts = {}) {
  if (sockets.has(userId)) {
    const existing = sockets.get(userId);
    // already running — just return current status (caller can also pair)
    if (opts.phoneNumber && !existing.authState.creds.registered) {
      try {
        const code = await existing.requestPairingCode(opts.phoneNumber.replace(/[^0-9]/g, ""));
        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        await setSession(userId, { status: "pairing", pairing_code: formatted });
        return { status: "pairing", code: formatted };
      } catch (e) {
        console.error("pair error", e?.message);
      }
    }
    const s = await getSession(userId);
    return { status: s.status, qr: s.qr, code: s.pairing_code };
  }

  const auth = await usePostgresAuthState(userId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: auth.state,
    logger,
    printQRInTerminal: false,
    browser: ["QuickReply", "Chrome", "6.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  sockets.set(userId, sock);

  // Pairing-code flow (no QR): only if not yet registered
  if (opts.phoneNumber && !sock.authState.creds.registered) {
    pendingPair.set(userId, opts.phoneNumber);
    setTimeout(async () => {
      try {
        const phone = (pendingPair.get(userId) || "").replace(/[^0-9]/g, "");
        if (!phone) return;
        const code = await sock.requestPairingCode(phone);
        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        await setSession(userId, { status: "pairing", pairing_code: formatted });
      } catch (e) {
        console.error("requestPairingCode failed", e?.message);
      }
    }, 1500);
  }

  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !opts.phoneNumber) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        await setSession(userId, { status: "qr", qr: dataUrl });
      } catch (e) {
        console.error("qr encode failed", e?.message);
      }
    }

    if (connection === "open") {
      const phone = (sock.user?.id || "").split(":")[0].split("@")[0] || null;
      await setSession(userId, { status: "connected", qr: null, pairing_code: null, phone });
      pendingPair.delete(userId);
      postWebhook(userId, "connection.update", { status: "connected", phone });
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      sockets.delete(userId);

      if (loggedOut) {
        await auth.clearAll();
        await setSession(userId, { status: "disconnected", qr: null, pairing_code: null, phone: null });
        postWebhook(userId, "connection.update", { status: "disconnected" });
      } else {
        // Auto-reconnect on transient errors (Timed Out, stream:error, 515 restart-required, etc.)
        await setSession(userId, { status: "connecting" });
        setTimeout(() => {
          startSession(userId, opts).catch((e) => console.error("reconnect failed", e?.message));
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue;
        const jid = m.key.remoteJid || "";
        if (!jid.endsWith("@s.whatsapp.net")) continue; // ignore groups/status
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          "";
        if (!text) continue;
        const from = jid.split("@")[0];
        await postWebhook(userId, "messages.upsert", { from, text });
      } catch (e) {
        // Ignore decrypt / session errors — they are common and harmless
        const msg = String(e?.message || "");
        if (msg.includes("decrypt") || msg.includes("No session")) continue;
        console.error("msg handler error", msg);
      }
    }
  });

  await setSession(userId, { status: opts.phoneNumber ? "pairing" : "connecting" });
  return { status: opts.phoneNumber ? "pairing" : "connecting" };
}

export async function sendMessage(userId, to, text) {
  const sock = sockets.get(userId);
  if (!sock) throw new Error("Session not connected");
  const jid = to.includes("@") ? to : `${to.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function logoutSession(userId) {
  const sock = sockets.get(userId);
  if (sock) {
    try { await sock.logout(); } catch {}
    sockets.delete(userId);
  }
  const auth = await usePostgresAuthState(userId);
  await auth.clearAll();
  await setSession(userId, { status: "disconnected", qr: null, pairing_code: null, phone: null });
}

export async function getStatus(userId) {
  const s = await getSession(userId);
  return { status: s.status, qr: s.qr, phone: s.phone, code: s.pairing_code };
}
