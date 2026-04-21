import express from "express";
import { initDb } from "./db.js";
import { startSession, sendMessage, logoutSession, getStatus } from "./wa.js";

// Never crash on background errors (Bad MAC, decrypt, stream errors, etc.)
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e?.message);
});
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", e?.message || e);
});

const app = express();
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.GATEWAY_API_KEY;

function auth(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "Gateway misconfigured" });
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, name: "quickreply-gateway", version: "6.0.0" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/sessions/:userId/start", auth, async (req, res) => {
  try {
    const out = await startSession(req.params.userId);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/sessions/:userId/pair", auth, async (req, res) => {
  try {
    const phoneNumber = String(req.body?.phoneNumber || "").trim();
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });
    const out = await startSession(req.params.userId, { phoneNumber });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/sessions/:userId/status", auth, async (req, res) => {
  res.json(await getStatus(req.params.userId));
});

app.post("/sessions/:userId/send", auth, async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to and text required" });
    await sendMessage(req.params.userId, to, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/sessions/:userId/logout", auth, async (req, res) => {
  try {
    await logoutSession(req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(JSON.stringify({ msg: "gateway_started", port: String(PORT), version: "6.0.0" }));
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e?.message);
    process.exit(1);
  });
