// Inline SVG icon set (24x24, stroked). Replaces the 100 KB Font Awesome download.
const PATHS = {
  chat: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16a2.5 2.5 0 0 1-.5-1.5z"/>',
  phone: '<path d="M6.6 3.5h2.2c.5 0 .9.3 1 .8l.8 3.4c.1.4 0 .8-.3 1.1l-1.6 1.5a13 13 0 0 0 5 5l1.5-1.6c.3-.3.7-.4 1.1-.3l3.4.8c.5.1.8.5.8 1v2.2c0 1.1-.9 2-2 2A16.5 16.5 0 0 1 4.6 5.5c0-1.1.9-2 2-2z"/>',
  video: '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 10.5 4.6-2.8c.4-.2.9.1.9.5v7.6c0 .4-.5.7-.9.5l-4.6-2.8"/>',
  map: '<path d="M9 4 3.8 6a1.2 1.2 0 0 0-.8 1.1v11.2c0 .6.6 1 1.2.8L9 17l6 3 5.2-2a1.2 1.2 0 0 0 .8-1.1V5.7c0-.6-.6-1-1.2-.8L15 7 9 4z"/><path d="M9 4v13M15 7v13"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  send: '<path d="M4.4 4.6 20 12 4.4 19.4c-.5.2-1-.3-.8-.8L6 12 3.6 5.4c-.2-.5.3-1 .8-.8z"/><path d="M6 12h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  micOff: '<path d="m3 3 18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M18.5 11a6.5 6.5 0 0 1-1.1 3.6M5.5 11a6.5 6.5 0 0 0 10 5.5M12 17.5V21"/>',
  clip: '<path d="m20 11.5-7.9 7.9a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5 20"/>',
  file: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checks: '<path d="m2.5 12.5 4.5 4.5L16.5 7.5"/><path d="m11.5 16.2.8.8 9.5-9.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  more: '<circle cx="12" cy="5.5" r="1.4" class="dot"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  userPlus: '<circle cx="10" cy="8" r="3.8"/><path d="M3 20a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.8h.01M15 9.8h.01"/>',
  reply: '<path d="M10 8 5 12.5l5 4.5"/><path d="M5.5 12.5H14a5 5 0 0 1 5 5V19"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6.5 7l.8 11.3A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.7L17.5 7"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
  play: '<path d="M8 5.6v12.8c0 .8.9 1.3 1.5.8l9.5-6.4c.6-.4.6-1.2 0-1.6L9.5 4.8C8.9 4.3 8 4.8 8 5.6z" class="solid"/>',
  pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2" class="solid"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2" class="solid"/>',
  hangup: '<path d="M3.2 14.6c-.5-.5-.6-1.3-.1-1.9a12.8 12.8 0 0 1 17.8 0c.5.6.4 1.4-.1 1.9l-1.6 1.6c-.4.4-1 .4-1.4.1l-2.3-1.7c-.3-.2-.5-.6-.4-1l.3-1.8a10.6 10.6 0 0 0-6.8 0l.3 1.8c.1.4-.1.8-.4 1l-2.3 1.7c-.4.3-1 .3-1.4-.1z" class="solid"/>',
  videoOff: '<path d="m3 3 18 18"/><path d="M15.5 12V8.5A2.5 2.5 0 0 0 13 6H9.5M5.2 6.3A2.5 2.5 0 0 0 3 8.5v7A2.5 2.5 0 0 0 5.5 18H13a2.5 2.5 0 0 0 2.3-1.5"/><path d="m15.5 10.5 4.6-2.8c.4-.2.9.1.9.5v7.6"/>',
  flip: '<path d="M4 9a8 8 0 0 1 14.3-3.6L20 7.5M20 3.5v4h-4"/><path d="M20 15a8 8 0 0 1-14.3 3.6L4 16.5M4 20.5v-4h4"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.5"/>',
  layers: '<path d="m12 3.5 9 4.5-9 4.5L3 8z"/><path d="m3 12.5 9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  logout: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2.3 2.3 0 0 0 4 0"/>',
  bellOff: '<path d="m3 3 18 18"/><path d="M8.2 5.9A6 6 0 0 1 18 11v4M6 11v5.5l-1.5 2H17"/><path d="M10 20.5a2.3 2.3 0 0 0 4 0"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18"/><path d="M10.6 5.6A8.8 8.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.3 6.8A15.7 15.7 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 15.5M20 20v-4.5h-4.5"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  incoming: '<path d="M6.6 3.5h2.2c.5 0 .9.3 1 .8l.8 3.4c.1.4 0 .8-.3 1.1l-1.6 1.5a13 13 0 0 0 5 5l1.5-1.6c.3-.3.7-.4 1.1-.3l3.4.8c.5.1.8.5.8 1v2.2c0 1.1-.9 2-2 2A16.5 16.5 0 0 1 4.6 5.5c0-1.1.9-2 2-2z"/><path d="M20 4l-5 5M15 5v4h4"/>',
  outgoing: '<path d="M6.6 3.5h2.2c.5 0 .9.3 1 .8l.8 3.4c.1.4 0 .8-.3 1.1l-1.6 1.5a13 13 0 0 0 5 5l1.5-1.6c.3-.3.7-.4 1.1-.3l3.4.8c.5.1.8.5.8 1v2.2c0 1.1-.9 2-2 2A16.5 16.5 0 0 1 4.6 5.5c0-1.1.9-2 2-2z"/><path d="M15 9l5-5M16 4h4v4"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/><path d="M5.5 10v4" class="lvl"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.7-1.2A4.6 4.6 0 0 0 7 18.5z"/>',
  forward: '<path d="M14 8l5 4.5-5 4.5"/><path d="M18.5 12.5H10a5 5 0 0 0-5 5V19"/>',
  truck: '<path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h9.5A1.5 1.5 0 0 1 15 6.5V16H2.5z"/><path d="M15 9h3.6a1.5 1.5 0 0 1 1.3.8l1.6 3V16H15"/><circle cx="7" cy="17.5" r="1.9"/><circle cx="17.5" cy="17.5" r="1.9"/>',
  package: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/>',
  pen: '<path d="M3 21c3-1 5.5-3.5 7-6.5L17.5 7a2.1 2.1 0 0 0-3-3L7 11.5C4 13 3 15 3 21z"/><path d="M14 21h7"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/>',
  building: '<rect x="4" y="3.5" width="12" height="17" rx="1.5"/><path d="M16 9h3a1 1 0 0 1 1 1v10.5H16M8 7.5h4M8 11h4M8 14.5h4M9.5 20.5V18h1v2.5"/>',
  wifiOff: '<path d="m3 3 18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.8a10 10 0 0 1 4.2-2.5M14.8 10.3A10 10 0 0 1 19 12.8M2 9.3a15 15 0 0 1 4.3-2.8M11 5.6a15 15 0 0 1 11 3.7"/><path d="M12 20h.01"/>'
};

const GOOGLE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" stroke="none" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" stroke="none" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.2v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" stroke="none" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.2a11 11 0 0 0 0 9.9z"/><path fill="#EA4335" stroke="none" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.2 7.1l3.6 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>';

/** Returns an SVG string. Every icon is decorative; buttons carry their own aria-label. */
export function icon(name, size = '') {
  if (name === 'google') return GOOGLE;
  const body = PATHS[name] || PATHS.info;
  const solid = /class="solid"/.test(body);
  return `<svg class="icon ${size}${solid ? ' fill' : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Inserts icons into any element with data-icon="name" (used by the static HTML). */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, el.dataset.iconSize || ''));
    el.removeAttribute('data-icon');
  });
}
