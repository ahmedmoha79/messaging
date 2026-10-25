// Push notifications: lets this device ring for calls and show messages
// even when WAZAMBI is closed or the phone is locked.
//
// The browser gives us a subscription (an address at Google/Apple/Mozilla's
// push service plus encryption keys). We store it; the database's push
// function encrypts each notification with those keys and sends it there.
import { state, settings } from './state.js';
import { vapidPublicKey, savePushSubscription, deletePushSubscription } from './data.js';
import { b64ToBytes } from '../lib/bytes.js';

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

/** iPhone/iPad only allow web push for apps added to the Home Screen. */
export function needsHomeScreenInstall() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return ios && !standalone;
}

function sameKey(sub, key) {
  try {
    const current = new Uint8Array(sub.options.applicationServerKey || []);
    const wanted = b64ToBytes(key);
    return current.length === wanted.length && current.every((b, i) => b === wanted[i]);
  } catch {
    return false;
  }
}

/**
 * Subscribes this device (when notifications are allowed) and saves the
 * subscription. Safe to call often: it only talks to the server when
 * something changed. Returns 'subscribed' | 'denied' | 'unsupported' | 'off' | 'error'.
 */
export async function ensurePushSubscription({ force = false } = {}) {
  if (!pushSupported() || !state.me) return 'unsupported';
  if (Notification.permission !== 'granted') return Notification.permission === 'denied' ? 'denied' : 'off';
  if (!settings.desktopNotifications) return 'off';
  try {
    const reg = await navigator.serviceWorker.ready;
    const key = await vapidPublicKey();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      force = true;
    }
    const marker = `wazambi-push:${state.me.id}`;
    const saved = localStorage.getItem(marker);
    if (force || saved !== sub.endpoint) {
      await savePushSubscription(sub);
      localStorage.setItem(marker, sub.endpoint);
    }
    return 'subscribed';
  } catch (err) {
    console.warn('Push subscription failed', err);
    return 'error';
  }
}

/** Stops push on this device (sign-out, or notifications switched off). */
export async function removePushSubscription() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await deletePushSubscription(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    if (state.me) localStorage.removeItem(`wazambi-push:${state.me.id}`);
  } catch {
    /* ignore */
  }
}
