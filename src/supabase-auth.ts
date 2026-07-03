import { initAuthCreds, BufferJSON, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { SupabaseClient } from '@supabase/supabase-js';

export const useSupabaseAuthState = async (
  supabase: SupabaseClient,
  sessionName: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const writeData = async (data: any, key: string) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    const { error } = await supabase
      .from('baileys_auth')
      .upsert({ session_name: sessionName, key, value }, { onConflict: 'session_name, key' });
    if (error) console.error('Error saving baileys_auth:', error);
  };

  const readData = async (key: string) => {
    const { data, error } = await supabase
      .from('baileys_auth')
      .select('value')
      .eq('session_name', sessionName)
      .eq('key', key)
      .maybeSingle();
    
    if (error) console.error('Error reading baileys_auth:', error);
    if (!data) return null;
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  };

  const removeData = async (key: string) => {
    await supabase.from('baileys_auth').delete().eq('session_name', sessionName).eq('key', key);
  };

  const creds = await readData('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: any = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = importSyncKey(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              try {
                  if (value) {
                      await writeData(value, key);
                  } else {
                      await removeData(key);
                  }
              } catch(e) {
                  console.error('Error saving auth data for key', key, e);
              }
            }
          }
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
};

function importSyncKey(data: any) {
    if (typeof data === 'object' && data !== null && 'macKey' in data) {
        return {
            ...data,
            macKey: Buffer.from(data.macKey, 'base64')
        };
    }
    return data;
}
