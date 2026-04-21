import pg from "pg";

const { Pool } = pg;

let url = process.env.DATABASE_URL || "";
// Silence the pg deprecation warning by upgrading legacy modes to verify-full
url = url.replace(/sslmode=(prefer|require|verify-ca)/i, "sslmode=verify-full");

export const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'disconnected',
      qr TEXT,
      phone TEXT,
      pairing_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS gateway_auth (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );
  `);
}

export async function setSession(userId, patch) {
  const fields = [];
  const values = [userId];
  let i = 2;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  fields.push(`updated_at = now()`);
  await pool.query(
    `INSERT INTO gateway_sessions (user_id, ${Object.keys(patch).join(",")})
     VALUES ($1, ${Object.keys(patch).map((_, idx) => `$${idx + 2}`).join(",")})
     ON CONFLICT (user_id) DO UPDATE SET ${fields.join(", ")}`,
    values
  );
}

export async function getSession(userId) {
  const { rows } = await pool.query(
    `SELECT status, qr, phone, pairing_code FROM gateway_sessions WHERE user_id=$1`,
    [userId]
  );
  return rows[0] || { status: "disconnected", qr: null, phone: null, pairing_code: null };
}
