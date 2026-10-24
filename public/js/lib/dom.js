// Small DOM helpers. Anything that touches user-provided text goes through
// escapeHtml or textContent, never raw innerHTML.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch]);
}

/** Tagged template that escapes interpolated values. Use raw() to opt out for trusted markup. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v && v.__raw) out += v.value;
      else if (Array.isArray(v)) out += v.map(x => (x && x.__raw ? x.value : escapeHtml(x))).join('');
      else out += escapeHtml(v);
    }
  });
  return { __raw: true, value: out };
}
export const raw = value => ({ __raw: true, value: String(value ?? '') });

/** Creates an element from an html`` result. */
export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = (markup && markup.__raw ? markup.value : String(markup)).trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Turns URLs in already-escaped text into safe links. */
export function linkify(escaped) {
  return escaped.replace(/\b(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/gi, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`);
}

/** True when a string is only 1-3 emoji, so we can show it large like other messengers. */
export function isEmojiOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 24) return false;
  try {
    const stripped = t.replace(/\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s/gu, '');
    const count = [...t.matchAll(/\p{Extended_Pictographic}/gu)].length;
    return stripped.length === 0 && count > 0 && count <= 3;
  } catch {
    return false;
  }
}

let toastHost;
export function toast(message, { type = 'info', action, onAction, duration = 3500 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  node.appendChild(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action;
    b.addEventListener('click', () => { node.remove(); onAction?.(); });
    node.appendChild(b);
  }
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), duration);
  return node;
}

/** Debounce helper. */
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Throttle helper (leading + trailing). */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) {
      last = now;
      fn(...args);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
export const isNarrow = () => matchMedia('(max-width: 859px)').matches;
