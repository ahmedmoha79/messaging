// Sounds, system notifications and the unread badge.
import { state, settings, totalUnread, userName } from './state.js';

let messageSound = null;
let audioCtx = null;
let unlocked = false;

// Browsers only allow audio after a user gesture; warm up on the first one.
function unlock() {
  if (unlocked) return;
  unlocked = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
  messageSound = new Audio('/sounds/notification.mp3');
  messageSound.preload = 'auto';
  messageSound.volume = 0.6;
}
['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
  window.addEventListener(evt, unlock, { once: true, passive: true, capture: true }));

export function playMessageSound() {
  if (!settings.sound || !messageSound) return;
  try {
    messageSound.currentTime = 0;
    messageSound.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

/**
 * Synthesised ring patterns (no audio files to download).
 * 'incoming' is a two-tone ring; 'outgoing' is the softer ringback tone.
 */
let ringTimer = null;
let ringNodes = [];
export function startRing(kind = 'incoming') {
  stopRing();
  if (!audioCtx) unlock();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  const burst = () => {
    const t = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    const freqs = kind === 'incoming' ? [880, 660] : [440, 480];
    const peak = kind === 'incoming' ? 0.18 : 0.07;
    const len = kind === 'incoming' ? 0.9 : 1.6;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.03);
    gain.gain.setValueAtTime(peak, t + len - 0.08);
    gain.gain.linearRampToValueAtTime(0, t + len);
    freqs.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      if (kind === 'incoming') {
        // alternate the two tones for a recognisable "brrring"
        osc.frequency.setValueAtTime(freqs[i], t);
        osc.frequency.setValueAtTime(freqs[1 - i], t + len / 2);
      }
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + len);
      ringNodes.push(osc);
    });
    if (kind === 'incoming' && navigator.vibrate) navigator.vibrate([400, 200, 400]);
  };
  burst();
  ringTimer = setInterval(burst, kind === 'incoming' ? 2200 : 4000);
}

export function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  ringNodes.forEach(n => { try { n.stop(); } catch { /* already stopped */ } });
  ringNodes = [];
  if (navigator.vibrate) navigator.vibrate(0);
}

export function beep(kind = 'end') {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const g = audioCtx.createGain();
  g.connect(audioCtx.destination);
  const o = audioCtx.createOscillator();
  o.frequency.value = kind === 'end' ? 420 : 620;
  o.connect(g);
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  o.start(t);
  o.stop(t + 0.36);
}

// ---------------------------------------------------------------------------
// System notifications (shown through the service worker so they work on
// Android too, and clicking one focuses the right chat).
// ---------------------------------------------------------------------------
export const notificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;
export const notificationPermission = () => (notificationsSupported() ? Notification.permission : 'denied');

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function systemNotify({ title, body, tag, url, icon, requireInteraction = false, actions }) {
  if (!settings.desktopNotifications || notificationPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: icon || '/icons/icon-192.png',
      badge: '/icons/notification.png',
      data: { url },
      requireInteraction,
      actions
    });
  } catch {
    try {
      const n = new Notification(title, { body, tag, icon: icon || '/icons/icon-192.png' });
      n.onclick = () => {
        window.focus();
        location.hash = url?.split('#')[1] || '';
        n.close();
      };
    } catch {
      /* not supported here */
    }
  }
}

export function closeNotifications(tag) {
  navigator.serviceWorker?.ready.then(reg => reg.getNotifications({ tag })).then(list => list?.forEach(n => n.close())).catch(() => {});
}

export function messagePreviewText(m) {
  switch (m.message_type) {
    case 'audio': return 'Voice message';
    case 'image': return m.content && m.content !== 'Photo' ? `Photo: ${m.content}` : 'Photo';
    case 'video': return 'Video';
    case 'file': return m.attachment_name || 'File';
    default: return m.content || '';
  }
}

export function notifyMessage(message, chat) {
  if (document.visibilityState === 'visible') {
    playMessageSound();
    return;
  }
  const sender = state.users.get(message.sender_id);
  const group = chat.type === 'group' ? state.groups.get(chat.id) : null;
  const title = group ? group.name : sender?.name || 'New message';
  const body = (group ? `${userName(message.sender_id)}: ` : '') + messagePreviewText(message);
  systemNotify({
    title,
    body: body.slice(0, 180),
    tag: `chat-${chat.type}-${chat.id}`,
    url: `/app#/chat/${chat.type === 'group' ? 'g' : 'u'}/${chat.id}`,
    icon: group ? undefined : sender?.avatar_url || undefined
  });
}

export function updateBadge() {
  const n = totalUnread();
  document.title = n ? `(${n}) WAZAMBI` : 'WAZAMBI';
  try {
    if (n && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {
    /* not supported */
  }
  const badge = document.getElementById('chatsBadge');
  if (badge) {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
}
