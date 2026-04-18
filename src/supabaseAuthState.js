// Baileys auth state stored in Supabase (no disk volume needed)
import { initAuthCreds, BufferJSON, proto } from 'baileys';

export async function useSupabaseAuthState(supabase, userId) {
  const table = 'wa_auth_state';

  const readRow = async (key) => {
    const { data } = await supabase
      .from(table)
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (!data) return null;
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  };

  const writeRow = async (key, value) => {
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await supabase.from(table).upsert(
      { user_id: userId, key, value: serialized },
      { onConflict: 'user_id,key' }
    );
  };

  const removeRow = async (key) => {
    await supabase.from(table).delete().eq('user_id', userId).eq('key', key);
  };

  const creds = (await readRow('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readRow(`${type}-${id}`);
              if (value) {
                if (type === 'app-state-sync-key') {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                result[id] = value;
              }
            })
          );
          return result;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeRow(key, value) : removeRow(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeRow('creds', creds),
    clearAll: async () => {
      await supabase.from(table).delete().eq('user_id', userId);
    },
  };
}
