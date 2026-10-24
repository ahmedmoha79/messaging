// Media helpers: what kind of file is this, shrink photos before upload,
// play voice notes, and a full-screen photo viewer.
import { icon } from '../lib/icons.js';
import { duration } from '../lib/format.js';
import { mediaUrl } from './data.js';
import { toast } from '../lib/dom.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('image/') && !/svg/.test(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio-file';
  return 'file';
}

/**
 * Photos from phones are often 4-12 MB. Re-encoding to max 1600px at ~0.82
 * quality brings them to ~200-400 KB: faster to send and to load on mobile data.
 * GIFs keep their animation, and anything already small is left alone.
 */
export async function compressImage(file, { maxSide = 1600, quality = 0.82 } = {}) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || file.size < 300 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const type = file.type === 'image/png' && file.size < 1.5 * 1024 * 1024 ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(res => canvas.toBlob(res, type, quality));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + (type === 'image/png' ? '.png' : '.jpg');
    return new File([blob], name, { type });
  } catch {
    return file; // e.g. HEIC on browsers that can't decode it: upload as-is
  }
}

/** Image dimensions so bubbles can reserve space and not jump while loading. */
export function imageSize(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** Resamples a waveform of any length to `bars` values between 0.08 and 1. */
export function resampleWave(wave, bars = 36) {
  const src = Array.isArray(wave) && wave.length ? wave.map(Number).filter(Number.isFinite) : [];
  if (!src.length) return Array.from({ length: bars }, (_, i) => 0.3 + 0.25 * Math.sin(i * 0.9) ** 2);
  const max = Math.max(...src, 0.0001);
  return Array.from({ length: bars }, (_, i) => {
    const start = Math.floor((i * src.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * src.length) / bars));
    const slice = src.slice(start, end);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return Math.max(0.08, Math.min(1, avg / max));
  });
}

// ---------------------------------------------------------------------------
// Voice note playback: one shared <audio>, so starting one pauses the other.
// ---------------------------------------------------------------------------
const player = new Audio();
player.preload = 'none';
let current = null; // { root, totalSeconds }

function paint(root, fraction, seconds) {
  const bars = root.querySelectorAll('.voice-wave i');
  const played = Math.round(fraction * bars.length);
  bars.forEach((b, i) => b.classList.toggle('played', i < played));
  const t = root.querySelector('.voice-time');
  if (t) t.textContent = duration(seconds);
}

function setPlaying(root, playing) {
  const btn = root.querySelector('.voice-play');
  btn.innerHTML = icon(playing ? 'pause' : 'play');
  btn.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message');
}

player.addEventListener('timeupdate', () => {
  if (!current) return;
  const total = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : current.totalSeconds;
  paint(current.root, total ? player.currentTime / total : 0, player.currentTime);
});
player.addEventListener('ended', () => {
  if (!current) return;
  setPlaying(current.root, false);
  paint(current.root, 0, current.totalSeconds);
  current = null;
});
player.addEventListener('pause', () => current && setPlaying(current.root, false));
player.addEventListener('play', () => current && setPlaying(current.root, true));

export async function toggleVoice(root, seekFraction = null) {
  const path = root.dataset.src;
  const totalSeconds = Number(root.dataset.duration) || 0;
  if (current?.root === root && seekFraction === null) {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    return;
  }
  if (current && current.root !== root) {
    player.pause();
    setPlaying(current.root, false);
    paint(current.root, 0, current.totalSeconds);
  }
  const url = root.dataset.localUrl || (await mediaUrl(path));
  if (!url) {
    toast('This voice message is no longer available.', { type: 'error' });
    return;
  }
  if (current?.root !== root) {
    current = { root, totalSeconds };
    player.src = url;
  }
  if (seekFraction !== null) {
    const total = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : totalSeconds;
    const seek = () => { player.currentTime = Math.max(0, Math.min(total, seekFraction * total)); };
    if (player.readyState >= 1) seek();
    else player.addEventListener('loadedmetadata', seek, { once: true });
  }
  player.play().catch(() => toast('Could not play this voice message.', { type: 'error' }));
}

export function stopVoice() {
  player.pause();
}

// ---------------------------------------------------------------------------
// Photo viewer
// ---------------------------------------------------------------------------
export async function openLightbox({ path, localUrl, name = 'photo' }) {
  const url = localUrl || (await mediaUrl(path));
  if (!url) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `
    <div class="lightbox-bar">
      <a class="icon-btn" target="_blank" rel="noopener" aria-label="Download">${icon('download')}</a>
      <button type="button" class="icon-btn" aria-label="Close">${icon('x')}</button>
    </div>
    <div class="lightbox-body"><img alt=""></div>`;
  box.querySelector('img').src = url;
  const link = box.querySelector('a');
  link.href = url;
  link.download = name;
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
    if (history.state?.lightbox) history.back();
  };
  const onKey = e => e.key === 'Escape' && close();
  box.querySelector('button').addEventListener('click', close);
  box.querySelector('.lightbox-body').addEventListener('click', e => e.target === e.currentTarget && close());
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', () => box.isConnected && (box.remove(), document.removeEventListener('keydown', onKey)), { once: true });
  history.pushState({ ...(history.state || {}), lightbox: true }, '');
  document.body.appendChild(box);
  box.querySelector('button').focus();
}
