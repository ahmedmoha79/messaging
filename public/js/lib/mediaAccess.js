// Getting the microphone and camera, and explaining clearly why it failed.
//
// The browser reports most failures as "NotAllowedError", which covers very
// different situations. The site permission can say "allowed" while the
// operating system still blocks the browser (Android app permissions, macOS
// Privacy & Security, Windows privacy settings). We tell those apart with
// the Permissions API so people get the fix that actually applies to them.

const ua = navigator.userAgent;
export const platform = /Android/i.test(ua) ? 'android'
  : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios'
  : /Mac OS X/.test(ua) ? 'mac'
  : /Windows/.test(ua) ? 'windows'
  : 'other';
const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera'
  : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'your browser';

/** In-app browsers (Facebook, Instagram, WhatsApp links, etc.) usually can't use the mic at all. */
export function inAppBrowser() {
  return /FBAN|FBAV|Instagram|Line\/|; wv\)|WhatsApp|Snapchat|TikTok|MicroMessenger/i.test(ua);
}

async function permissionState(name) {
  try {
    const status = await navigator.permissions?.query({ name });
    return status?.state || 'unknown';
  } catch {
    return 'unknown'; // Firefox/Safari don't support querying camera/microphone everywhere
  }
}

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

export class MediaAccessError extends Error {
  constructor(message, { device, reason, original }) {
    super(message);
    this.name = 'MediaAccessError';
    this.device = device; // 'microphone' | 'camera'
    this.reason = reason; // 'site-blocked' | 'system-blocked' | 'in-use' | 'missing' | 'in-app' | 'insecure' | 'unknown'
    this.original = original;
  }
}

function systemSettingsHint(device) {
  const thing = device === 'camera' ? 'Camera' : 'Microphone';
  switch (platform) {
    case 'android':
      return `Open your phone's Settings → Apps → ${browser} → Permissions → ${thing}, choose "Allow", then try again.`;
    case 'ios':
      return `Open Settings → ${browser === 'your browser' ? 'Safari' : browser} → ${thing}, choose "Allow", then try again.`;
    case 'mac':
      return `Open System Settings → Privacy & Security → ${thing}, switch on ${browser}, then restart ${browser}.`;
    case 'windows':
      return `Open Windows Settings → Privacy & security → ${thing}, turn on "Let desktop apps access your ${thing.toLowerCase()}", then try again.`;
    default:
      return `Check that your device allows ${browser} to use the ${device}.`;
  }
}

function siteSettingsHint(device) {
  if (platform === 'ios') return `Tap "aA" in the address bar → Website Settings → ${device === 'camera' ? 'Camera' : 'Microphone'} → Allow, then reload.`;
  return `Tap the icon to the left of the web address → Permissions (or Site settings) → ${device === 'camera' ? 'Camera' : 'Microphone'} → Allow, then reload the page.`;
}

/** Turns a getUserMedia failure into a specific, actionable message. */
async function explain(err, device) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  if (!window.isSecureContext) {
    return new MediaAccessError('Calls and voice notes need a secure (https://) connection. Open the app from its https:// address.', { device, reason: 'insecure', original: err });
  }
  if (inAppBrowser()) {
    return new MediaAccessError(`This in-app browser can't use your ${device}. Open WAZAMBI in Chrome or Safari instead (menu → "Open in browser").`, { device, reason: 'in-app', original: err });
  }
  if (/NotAllowed|Permission|Security/i.test(name)) {
    const state = await permissionState(device);
    // Granted for the site but still refused (or Chrome's own wording) → the operating system blocks the browser.
    if (state === 'granted' || /system/i.test(msg)) {
      return new MediaAccessError(`Your device is blocking ${browser} from using the ${device}. ${systemSettingsHint(device)}`, { device, reason: 'system-blocked', original: err });
    }
    if (state === 'denied') {
      return new MediaAccessError(`The ${device} is blocked for this site. ${siteSettingsHint(device)}`, { device, reason: 'site-blocked', original: err });
    }
    // 'prompt' / unknown: the person dismissed the prompt or the browser auto-blocked it
    return new MediaAccessError(`WAZAMBI needs your ${device}. When your browser asks, choose "Allow". If it doesn't ask: ${siteSettingsHint(device)}`, { device, reason: 'site-blocked', original: err });
  }
  if (/NotReadable|TrackStart|Abort/i.test(name)) {
    return new MediaAccessError(`Your ${device} is busy. Close other apps or tabs using it (another call, a recorder), then try again.`, { device, reason: 'in-use', original: err });
  }
  if (/NotFound|DevicesNotFound|Overconstrained/i.test(name)) {
    return new MediaAccessError(`No ${device} was found. Plug one in or check that it's switched on.`, { device, reason: 'missing', original: err });
  }
  return new MediaAccessError(`Couldn't start your ${device} (${name || 'unknown error'}). Reload the page and try again.`, { device, reason: 'unknown', original: err });
}

/**
 * Microphone only. Throws MediaAccessError with a human explanation.
 */
export async function getMicrophone(extra = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MediaAccessError(window.isSecureContext
      ? `${browser} can't record audio here. Update it, or use Chrome or Safari.`
      : 'Calls and voice notes need a secure (https://) connection.', { device: 'microphone', reason: 'insecure' });
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, ...extra }, video: false });
  } catch (err) {
    // Some devices reject the processing options; retry with plain audio before giving up.
    if (/Overconstrained|NotSupported|TypeError/i.test(err?.name || '')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err2) {
        throw await explain(err2, 'microphone');
      }
    }
    throw await explain(err, 'microphone');
  }
}

/**
 * For calls. Video calls ask for the camera separately from the microphone,
 * so a blocked or busy camera doesn't stop the call: it continues as voice
 * and `cameraProblem` says why.
 * Returns { stream, cameraProblem }.
 */
export async function getCallMedia(kind) {
  const stream = await getMicrophone();
  if (kind !== 'video') return { stream, cameraProblem: null };
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
    cam.getVideoTracks().forEach(t => stream.addTrack(t));
    return { stream, cameraProblem: null };
  } catch (err) {
    return { stream, cameraProblem: await explain(err, 'camera') };
  }
}

/** Runs a full check for Settings → "Check microphone and camera". */
export async function diagnose() {
  const out = { secure: window.isSecureContext, inApp: inAppBrowser(), microphone: null, camera: null, micPermission: await permissionState('microphone'), cameraPermission: await permissionState('camera') };
  try {
    const s = await getMicrophone();
    out.microphone = { ok: true, label: s.getAudioTracks()[0]?.label || 'Microphone' };
    s.getTracks().forEach(t => t.stop());
  } catch (err) {
    out.microphone = { ok: false, message: err.message };
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    out.camera = { ok: true, label: s.getVideoTracks()[0]?.label || 'Camera' };
    s.getTracks().forEach(t => t.stop());
  } catch (err) {
    out.camera = { ok: false, message: (await explain(err, 'camera')).message };
  }
  return out;
}
