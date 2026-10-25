// App start-up. The goal is "chats on screen as fast as possible":
//   1. read the session from local storage (no network),
//   2. paint the chat list from the last-session cache immediately,
//   3. fetch fresh data in parallel and repaint,
//   4. start realtime, calls and everything else in the background.
import { sb, migrateLegacySession, initialUrl } from '../lib/supabase.js';
import { hydrateIcons } from '../lib/icons.js';
import { toast, isNarrow } from '../lib/dom.js';
import { state, on, applyTheme } from './state.js';
import { loadMe, loadUsers, loadChatList, touchPresence, markOfflineOnExit, logSession, loadOrgs, loadOrgMembers } from './data.js';
import { startRealtime, resync, refreshUsers, ensureRealtime } from './realtime.js';
import { initJobs } from './jobs.js';
import { showOnboarding, handleInviteLink, pendingInvite, INVITE_KEY } from './org.js';
import { ensurePushSubscription } from './push.js';
import { startRouter } from './router.js';
import { initChatList } from './chatList.js';
import { initConversation, openChat, closeChat } from './conversation.js';
import { initCalls } from './calls.js';
import { initSettings, openChangePassword } from './settings.js';
import { initMap } from './map.js';
import { updateBadge } from './notify.js';
import { avatarHtml, hasOpenSheet, closeTopSheet, consumeSheetPop } from './ui.js';

const $ = id => document.getElementById(id);
const CACHE_VERSION = 3;

function bootMessage(text, { retry = false } = {}) {
  $('bootText').textContent = text;
  if (retry && !$('bootRetry')) {
    $('boot').querySelector('.spinner')?.remove();
    const b = document.createElement('button');
    b.id = 'bootRetry';
    b.className = 'btn primary';
    b.textContent = 'Try again';
    b.addEventListener('click', () => location.reload());
    $('boot').appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Last-session cache: lets the chat list appear before the network answers.
// ---------------------------------------------------------------------------
function cacheKey(uid) {
  return `wazambi-cache:${uid}`;
}
function readCache(uid) {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
    return c?.v === CACHE_VERSION ? c : null;
  } catch {
    return null;
  }
}
function writeCache() {
  if (!state.me) return;
  try {
    localStorage.setItem(cacheKey(state.me.id), JSON.stringify({
      v: CACHE_VERSION,
      me: state.me,
      users: [...state.users.values()],
      direct: [...state.direct.values()],
      groups: [...state.groups.values()],
      orgs: state.orgs,
      org: state.org?.id || null
    }));
  } catch {
    /* storage full or blocked: no cache, just slower start */
  }
}

// ---------------------------------------------------------------------------
// Layout for the current route
// ---------------------------------------------------------------------------
function applyRoute(route) {
  const app = $('app');
  document.querySelectorAll('.rail-tab').forEach(tab => {
    if (tab.dataset.tab === route.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== route.tab; });

  const inChat = !!route.chat;
  const onMap = route.tab === 'map' && !inChat;
  const inJob = route.tab === 'jobs' && !!route.jobId;
  app.classList.toggle('show-main', inChat || onMap || inJob);
  app.classList.toggle('in-chat', inChat || inJob);
  $('mapView').hidden = !onMap;
  $('jobView').hidden = !inJob;
  $('welcome').hidden = inChat || onMap || inJob;
  if (route.join) handleInviteLink(route.join);

  if (inChat) {
    // A chat with yourself or someone unknown isn't valid.
    if (route.chat.type === 'direct' && (route.chat.id === state.me.id)) {
      location.replace('#/chats');
      return;
    }
    openChat(route.chat);
  } else {
    closeChat();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  migrateLegacySession();
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  hydrateIcons();

  // Failed magic link / OAuth: show the error on the sign-in page.
  const hashParams = new URLSearchParams(initialUrl.hash.slice(1));
  if (hashParams.get('error_description') || initialUrl.searchParams.get('error_description')) {
    location.replace(`/${initialUrl.search}${initialUrl.hash}`);
    return;
  }
  const isRecovery = hashParams.get('type') === 'recovery';
  // An invite link (/join/CODE → /app#/join/CODE): remember it across sign-in / sign-up.
  const invite = initialUrl.hash.match(/^#\/join\/([0-9A-Za-z]{6,20})/);
  if (invite) {
    try { localStorage.setItem(INVITE_KEY, invite[1].toUpperCase()); } catch { /* ignore */ }
  }

  // getSession() also finishes magic-link / OAuth sign-ins present in the URL.
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.replace('/');
    return;
  }
  state.session = session;
  // A password-reset link that landed on the app (older emails, or a Site URL
  // pointing here): send it to the sign-in page's "Set a new password" screen.
  if (isRecovery || initialUrl.searchParams.get('type') === 'recovery') {
    location.replace('/?mode=reset-password');
    return;
  }
  if (/access_token=|refresh_token=/.test(location.hash)) {
    history.replaceState(null, '', '#/chats');
  }

  // Paint from cache straight away when we have one.
  const cached = readCache(session.user.id);
  if (cached) {
    state.me = cached.me;
    cached.users.forEach(u => state.users.set(u.id, u));
    cached.direct.forEach(c => state.direct.set(c.partner_id, c));
    cached.groups.forEach(g => state.groups.set(g.id, g));
    state.orgs = cached.orgs || [];
    state.org = state.orgs.find(o => o.id === cached.org) || state.orgs[0] || null;
    state.role = state.org?.role || null;
    state.chatListLoaded = true;
    if (state.org) showApp();
  } else {
    bootMessage('Opening your chats…');
  }

  try {
    await loadMe(session.user);
    await Promise.all([loadOrgs(), loadUsers(), loadChatList()]);
  } catch (err) {
    console.error('Initial load failed', err);
    if (/JWT|token|session|not authenticated/i.test(String(err?.message))) {
      await sb.auth.signOut({ scope: 'local' });
      location.replace('/');
      return;
    }
    if (!cached || !state.org) {
      bootMessage(navigator.onLine ? 'We couldn’t reach the server. It may be waking up; try again in a few seconds.' : 'You’re offline. Connect to the internet to open your chats.', { retry: true });
      return;
    }
    toast('Showing saved chats. Reconnecting…');
  }
  // No company yet: set one up (or join with an invite) before the app opens.
  if (!state.org) {
    $('boot').hidden = true;
    await showOnboarding();
    $('boot').hidden = false;
  } else if (pendingInvite() && !state.orgs.some(o => o.invite_code === pendingInvite())) {
    setTimeout(() => handleInviteLink(pendingInvite()), 600);
  }
  loadOrgMembers().catch(() => {});
  if (!shown) showApp();
  writeCache();
  afterLoad();
}

let shown = false;
function showApp() {
  if (shown) return;
  shown = true;
  initChatList();
  initConversation();
  initCalls();
  initJobs();
  initSettings();
  initMap();
  renderRailMe();
  on('me', renderRailMe);
  $('app').hidden = false;
  $('boot').remove();
  updateBadge();
  startRouter(applyRoute);
}

function renderRailMe() {
  if (!state.me) return;
  const btn = $('railMe');
  btn.innerHTML = avatarHtml(state.me, { size: 40 }).value;
  btn.onclick = async () => {
    const { openProfile } = await import('./profile.js');
    openProfile(state.me.id);
  };
}

function afterLoad() {
  startRealtime();
  touchPresence('online').catch(() => {});
  logSession().catch(() => {});
  registerServiceWorker();

  on('chatlist', debounceCache);
  on('org', debounceCache);
  on('users', debounceCache);
  on('me', debounceCache);

  // presence heartbeat for "last seen" while the app is open
  setInterval(() => {
    if (document.visibilityState === 'visible') touchPresence('online').catch(() => {});
  }, 120000);

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      touchPresence('offline').catch(() => {});
    } else {
      touchPresence('online').catch(() => {});
      // Phones freeze background tabs; catch up on anything we missed.
      if (Date.now() - hiddenAt > 20000) resync();
      refreshUsers();
    }
  });
  window.addEventListener('pagehide', markOfflineOnExit);

  const banner = $('netBanner');
  const setOnline = () => { banner.hidden = navigator.onLine; };
  window.addEventListener('online', () => {
    setOnline();
    resync();
  });
  window.addEventListener('offline', setOnline);
  setOnline();

  // Android back button / browser back closes the top sheet first.
  window.addEventListener('popstate', () => {
    if (consumeSheetPop()) return;
    if (hasOpenSheet()) closeTopSheet(true);
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      location.replace('/');
      return;
    }
    if (session) state.session = session;
    if (event === 'PASSWORD_RECOVERY') openChangePassword({ recovery: true });
  });

  // Service worker relays notification clicks and pushes that arrive while open.
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'open' && e.data.url) {
      const hash = e.data.url.split('#')[1];
      if (hash) location.hash = hash;
    }
    if (e.data?.type === 'push') {
      // A push reached us, so our live connection may have missed it.
      const d = e.data.data || {};
      if (d.callId) import('./state.js').then(m => m.emit('call:nudge', d.callId));
      ensureRealtime('push', { resyncAfter: true });
    }
  });

  // On first load on a phone, land on the chat list rather than a stale deep link.
  if (isNarrow() && !location.hash) history.replaceState(null, '', '#/chats');
}

let cacheTimer = null;
function debounceCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(writeCache, 1500);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Background calls/messages: (re)register this device for push when allowed.
    navigator.serviceWorker.ready.then(() => ensurePushSubscription()).catch(() => {});
    // A new version was deployed. The new worker takes over straight away;
    // offer a refresh (rather than forcing one mid-chat) so the page picks up the new code.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return; // first install, nothing to refresh
      }
      toast('A new version of WAZAMBI is ready.', { action: 'Refresh', duration: 20000, onAction: () => location.reload() });
    });
    reg.update().catch(() => {});
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

boot().catch(err => {
  console.error(err);
  bootMessage('Something went wrong while opening WAZAMBI.', { retry: true });
});

