// Shared UI pieces: avatars, sheets (bottom sheet on phones, dialog on
// desktop), confirm prompts and popover menus.
import { html, raw, el, escapeHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { initials, colorFor } from '../lib/format.js';
import { state } from './state.js';

export function avatarHtml(user, { size = 44, presence = false, group = false } = {}) {
  const name = user?.name || '?';
  const seed = user?.id || name;
  const online = presence && user?.id && state.online.has(user.id);
  const img = user?.avatar_url
    ? html`<img src="${user.avatar_url}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : raw(escapeHtml(initials(name)));
  return html`<span class="avatar${group ? ' group' : ''}" style="--size:${size}px;--avatar-bg:${colorFor(seed)}" aria-hidden="true">${img}${online ? raw('<span class="presence"></span>') : ''}</span>`;
}

export function groupAvatarHtml(group, size = 44) {
  return avatarHtml({ id: group.id, name: group.name, avatar_url: group.avatar_url }, { size, group: true });
}

// Broken avatar URLs fall back to initials instead of a broken-image icon.
document.addEventListener('error', e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.parentElement?.classList.contains('avatar')) {
    const holder = img.parentElement;
    img.remove();
    holder.insertAdjacentText('afterbegin', '?');
  }
}, true);

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------
const openSheets = [];
// popstate events we caused ourselves by closing a sheet (so the router ignores them)
let ignoreNextPop = 0;
export function consumeSheetPop() {
  if (ignoreNextPop > 0) {
    ignoreNextPop -= 1;
    return true;
  }
  return false;
}

/**
 * Opens a sheet. `content` is an element; returns { root, body, close }.
 * Sheets close on Escape, scrim click and the browser back button.
 */
export function openSheet({ title, content, wide = false, onClose, actions = null, className = '' }) {
  const root = el(html`
    <div class="sheet-layer ${className}" role="presentation">
      <div class="sheet-scrim"></div>
      <section class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
        <header class="sheet-head">
          <h2>${title}</h2>
          <span class="sheet-actions"></span>
          <button type="button" class="icon-btn sheet-close" aria-label="Close">${raw(icon('x'))}</button>
        </header>
        <div class="sheet-body"></div>
      </section>
    </div>`);
  const body = root.querySelector('.sheet-body');
  body.appendChild(content);
  if (actions) root.querySelector('.sheet-actions').appendChild(actions);
  document.body.appendChild(root);
  const previouslyFocused = document.activeElement;

  let closed = false;
  /**
   * Closes the sheet. Returns a promise that resolves once the history entry
   * the sheet added has been popped, so callers can safely navigate after it.
   */
  const close = (fromHistory = false) => {
    if (closed) return Promise.resolve();
    closed = true;
    root.classList.add('closing');
    const idx = openSheets.indexOf(api);
    if (idx >= 0) openSheets.splice(idx, 1);
    setTimeout(() => root.remove(), 180);
    previouslyFocused?.focus?.({ preventScroll: true });
    onClose?.();
    if (fromHistory !== true && history.state?.sheet) {
      return new Promise(resolve => {
        const done = () => {
          window.removeEventListener('popstate', done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 400);
        window.addEventListener('popstate', done);
        ignoreNextPop += 1;
        history.back();
      });
    }
    return Promise.resolve();
  };
  const api = { root, body, close };
  openSheets.push(api);

  root.querySelector('.sheet-scrim').addEventListener('click', () => close());
  root.querySelector('.sheet-close').addEventListener('click', () => close());
  history.pushState({ ...(history.state || {}), sheet: true }, '');

  requestAnimationFrame(() => {
    root.classList.add('open');
    const focusable = body.querySelector('input, textarea, select, button:not([disabled])');
    if (focusable && !matchMedia('(hover: none)').matches) focusable.focus({ preventScroll: true });
    else root.querySelector('.sheet').focus?.();
  });
  return api;
}

export function closeTopSheet(fromHistory = false) {
  const top = openSheets[openSheets.length - 1];
  if (top) {
    top.close(fromHistory);
    return true;
  }
  return false;
}
export const hasOpenSheet = () => openSheets.length > 0;

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openSheets.length) {
    e.preventDefault();
    closeTopSheet();
  }
});

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const content = el(html`
      <div class="confirm">
        <p>${message}</p>
        <div class="confirm-actions">
          <button type="button" class="btn outline" data-act="cancel">Cancel</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${confirm}</button>
        </div>
      </div>`);
    let answered = false;
    const sheet = openSheet({ title, content, className: 'compact', onClose: () => !answered && resolve(false) });
    content.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      answered = true;
      resolve(act === 'ok');
      sheet.close();
    });
    content.querySelector('[data-act="ok"]').focus();
  });
}

// ---------------------------------------------------------------------------
// Popover menu anchored to a point or element
// ---------------------------------------------------------------------------
let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * items: [{ label, icon, onSelect, danger }] or a custom element via { element }.
 */
export function showMenu({ x, y, anchor, items = [], header = null }) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  if (header) menu.appendChild(header);
  items.forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.className = `menu-item${item.danger ? ' danger' : ''}`;
    b.innerHTML = `${item.icon ? icon(item.icon, 'sm') : ''}<span>${escapeHtml(item.label)}</span>`;
    b.addEventListener('click', () => {
      closeMenu();
      item.onSelect?.();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const rect = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - mw - 8);
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
  left = Math.max(8, left);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenu = menu;
  menu.querySelector('button')?.focus({ preventScroll: true });
  return menu;
}

document.addEventListener('pointerdown', e => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openMenu) closeMenu();
});
window.addEventListener('resize', closeMenu);

export function emptyState({ iconName, title, text, action = null }) {
  return html`
    <div class="empty">
      <span class="empty-icon">${raw(icon(iconName, 'lg'))}</span>
      <h3>${title}</h3>
      ${text ? html`<p>${text}</p>` : ''}
      ${action ? raw(action) : ''}
    </div>`;
}

/**
 * Explains a microphone/camera problem with the exact fix and a retry button.
 * Resolves true when the person taps "Try again".
 */
export function mediaHelpDialog(err, { action = 'Try again' } = {}) {
  const device = err?.device === 'camera' ? 'Camera' : 'Microphone';
  const titles = {
    'system-blocked': `${device} blocked by your device`,
    'site-blocked': `${device} not allowed`,
    'in-use': `${device} is busy`,
    missing: `No ${device.toLowerCase()} found`,
    'in-app': 'Open in your browser',
    insecure: 'Secure connection needed'
  };
  return new Promise(resolve => {
    const content = el(html`
      <div class="confirm">
        <p>${err?.message || 'Something went wrong with your microphone.'}</p>
        <div class="confirm-actions">
          <button type="button" class="btn outline" data-act="cancel">Close</button>
          <button type="button" class="btn primary" data-act="ok">${action}</button>
        </div>
      </div>`);
    let answered = false;
    const sheet = openSheet({ title: titles[err?.reason] || `${device} problem`, content, className: 'compact', onClose: () => !answered && resolve(false) });
    content.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      answered = true;
      sheet.close().then(() => resolve(act === 'ok'));
    });
  });
}
