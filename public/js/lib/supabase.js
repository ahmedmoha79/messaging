// One Supabase client for the whole app. Config comes from /config.js (served
// by our server), and the library from /vendor/supabase.js, both loaded before
// any module runs.
const config = window.APP_CONFIG;
if (!config || !window.supabase) {
  throw new Error('App configuration failed to load. Check your connection and refresh.');
}

export const sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'wazambi-auth'
  },
  realtime: { params: { eventsPerSecond: 20 } },
  global: { headers: { 'x-client-info': 'wazambi-web/' + config.version } }
});

export { config };

/**
 * Migrates a session saved by the old app (default Supabase storage key) so
 * existing users are not signed out by the upgrade.
 */
export function migrateLegacySession() {
  try {
    if (localStorage.getItem('wazambi-auth')) return;
    const ref = new URL(config.supabaseUrl).hostname.split('.')[0];
    const legacy = localStorage.getItem(`sb-${ref}-auth-token`);
    if (legacy) localStorage.setItem('wazambi-auth', legacy);
  } catch {
    /* storage may be blocked; the user just signs in again */
  }
}

/** Reads the cached session from storage without a network round trip. */
export async function getSession() {
  const { data } = await sb.auth.getSession();
  return data.session;
}
