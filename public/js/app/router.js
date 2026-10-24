// Hash routes:
//   #/chats  #/chat/u/<userId>  #/chat/g/<groupId>  #/calls  #/map  #/settings[/password]
import { emit } from './state.js';

const UUID = /^[0-9a-f-]{36}$/i;

export function parseRoute(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [head, a, b] = parts;
  if (head === 'chat' && (a === 'u' || a === 'g') && UUID.test(b || '')) {
    return { tab: 'chats', chat: { type: a === 'g' ? 'group' : 'direct', id: b.toLowerCase() } };
  }
  if (head === 'calls') return { tab: 'calls', chat: null };
  if (head === 'map') return { tab: 'map', chat: null };
  if (head === 'settings') return { tab: 'settings', chat: null, sub: a || null };
  return { tab: 'chats', chat: null };
}

let current = null;
export function currentRoute() {
  return current;
}

export function startRouter(apply) {
  const run = () => {
    current = parseRoute();
    apply(current);
    emit('route', current);
  };
  window.addEventListener('hashchange', run);
  run();
}

export function go(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(history.state, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}
