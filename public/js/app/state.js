// Central app state plus a tiny event bus. Views subscribe to events instead
// of reaching into each other, which keeps every module independent.

export const state = {
  session: null,
  me: null, // row from public.users
  users: new Map(), // id -> user row
  online: new Set(), // user ids currently connected
  direct: new Map(), // partner id -> { partner_id, last, unread }
  groups: new Map(), // group id -> { id, name, avatar_url, member_count, last, last_at, unread, muted }
  active: null, // { type: 'direct' | 'group', id }
  typing: new Map(), // chat key -> Map(userId -> expiry ms)
  chatListLoaded: false,
  orgs: [], // companies I belong to: { id, name, invite_code, plan, role }
  org: null, // the active company
  role: null, // my role in it: owner | admin | dispatcher | driver
  members: new Map() // user id -> role, in the active company
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  listeners.get(event)?.forEach(fn => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`Listener for "${event}" failed`, err);
    }
  });
}

export const chatKey = (type, id) => `${type}:${id}`;
export const isActive = (type, id) => state.active?.type === type && state.active?.id === id;

export function userName(id) {
  if (id && id === state.me?.id) return 'You';
  return state.users.get(id)?.name || 'Unknown';
}

// ---------------------------------------------------------------------------
// Per-device settings
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'wazambi-settings';
const DEFAULTS = {
  theme: 'system', // system | light | dark
  sound: true,
  desktopNotifications: true,
  enterToSend: !matchMedia('(hover: none) and (pointer: coarse)').matches,
  shareLocation: false,
  mapLayer: 'streets'
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export const settings = loadSettings();
export function saveSetting(key, value) {
  settings[key] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: the setting still applies for this visit */
  }
  emit('settings', { key, value });
}

export function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.theme;
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#15201c' : '#0b8a5f');
}

/** Total unread across chats, used for the tab title and app badge. */
export function totalUnread() {
  let n = 0;
  state.direct.forEach(c => (n += c.unread || 0));
  state.groups.forEach(g => (n += g.muted ? 0 : g.unread || 0));
  return n;
}
