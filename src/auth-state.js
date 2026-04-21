import { pool } from "./db.js";
import pkg from "@whiskeysockets/baileys";
const { initAuthCreds, BufferJSON, proto } = pkg.default || pkg;

/** Postgres-backed auth state for Baileys (multi-tenant by userId) */
export async function usePostgresAuthState(userId) {
  async function readKey(key) {
    const { rows } = await pool.query(
      `SELECT value FROM gateway_auth WHERE user_id=$1 AND key=$2`,
      [userId, key]
    );
    if (!rows[0]) return null;
    return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
  }
  async function writeKey(key, value) {
    const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO gateway_auth (user_id, key, value, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [userId, key, json]
    );
  }
  async function removeKey(key) {
    await pool.query(`DELETE FROM gateway_auth WHERE user_id=$1 AND key=$2`, [userId, key]);
  }

  const creds = (await readKey("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readKey(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeKey(key, value) : removeKey(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeKey("creds", creds),
    clearAll: async () => {
      await pool.query(`DELETE FROM gateway_auth WHERE user_id=$1`, [userId]);
    },
  };
}
