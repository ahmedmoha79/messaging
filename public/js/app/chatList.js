// Left-hand chat list: direct chats and groups sorted by latest activity,
// with search across chats and people, filters, typing and unread state.
import { html, raw, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { listStamp } from '../lib/format.js';
import { state, on, isActive, userName } from './state.js';
import { avatarHtml, groupAvatarHtml, emptyState } from './ui.js';
import { typingNames } from './realtime.js';
import { messagePreviewText, notificationPermission, notificationsSupported, requestNotificationPermission } from './notify.js';
import { openNewChat, openNewGroup } from './groups.js';

const listEl = document.getElementById('chatList');
const searchEl = document.getElementById('chatSearch');
let filter = 'all';
let query = '';
let scheduled = false;

export function initChatList() {
  ['chatlist', 'presence', 'typing', 'users', 'route', 'me'].forEach(evt => on(evt, scheduleRender));
  searchEl.addEventListener('input', debounce(() => {
    query = searchEl.value.trim().toLowerCase();
    render();
  }, 80));
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') listEl.querySelector('.row')?.click();
    if (e.key === 'Escape') {
      searchEl.value = '';
      query = '';
      render();
    }
  });
  document.querySelectorAll('.filter-row .chip').forEach(chip => chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    document.querySelectorAll('.filter-row .chip').forEach(c => c.setAttribute('aria-selected', String(c === chip)));
    render();
  }));
  document.getElementById('newChatBtn').addEventListener('click', openNewChat);
  document.getElementById('newGroupBtn').addEventListener('click', openNewGroup);
  document.getElementById('welcomeNewChat').addEventListener('click', openNewChat);
  listEl.addEventListener('click', e => {
    const b = e.target.closest('[data-action="enable-notifications"]');
    if (b) {
      requestNotificationPermission().then(render);
      return;
    }
    if (e.target.closest('[data-action="dismiss-notifications"]')) {
      localStorage.setItem('wazambi-notif-dismissed', '1');
      render();
    }
  });

  // Keyboard shortcut: Ctrl/Cmd+K focuses search
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      location.hash = '#/chats';
      searchEl.focus();
    }
  });
  render();
}

function scheduleRender() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
}

function entries() {
  const items = [];
  state.direct.forEach(c => {
    const user = state.users.get(c.partner_id);
    if (!user) return;
    items.push({ type: 'direct', id: c.partner_id, name: user.name, user, last: c.last, at: c.last?.created_at, unread: c.unread || 0 });
  });
  state.groups.forEach(g => {
    items.push({ type: 'group', id: g.id, name: g.name, group: g, last: g.last, at: g.last_at || g.last?.created_at, unread: g.unread || 0, muted: g.muted });
  });
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return items;
}

function previewHtml(item) {
  const typers = typingNames(item.type, item.id);
  if (typers.length) {
    const who = item.type === 'group' ? `${typers[0]} is typing…` : 'typing…';
    return html`<span class="typing">${who}</span>`;
  }
  const m = item.last;
  if (!m) return html`<span>${item.type === 'group' ? `${item.group.member_count} members` : 'Say hello 👋'}</span>`;
  const mine = m.sender_id === state.me.id;
  let tick = '';
  if (mine && item.type === 'direct') {
    const read = m.status === 'read' || m.is_read;
    tick = raw(`<span class="tick${read ? ' read' : ''}">${icon(read || m.status === 'delivered' ? 'checks' : 'check', 'xs')}</span>`);
  }
  const kindIcon = { audio: 'mic', image: 'image', video: 'video', file: 'file' }[m.message_type];
  const prefix = mine ? 'You: ' : item.type === 'group' ? `${userName(m.sender_id).split(' ')[0]}: ` : '';
  return html`${tick}${kindIcon ? raw(icon(kindIcon, 'xs')) : ''}<span>${prefix}${messagePreviewText(m)}</span>`;
}

function rowHtml(item) {
  const current = isActive(item.type, item.id);
  const href = `#/chat/${item.type === 'group' ? 'g' : 'u'}/${item.id}`;
  const avatar = item.type === 'group' ? groupAvatarHtml(item.group, 50) : avatarHtml(item.user, { size: 50, presence: true });
  const unread = item.unread > 0 && !current;
  return html`
    <a class="row${unread ? ' unread' : ''}" role="listitem" href="${href}" aria-current="${current}" data-key="${item.type}:${item.id}">
      ${avatar}
      <span class="row-main">
        <span class="row-top">
          <span class="row-name">${item.name}</span>
          <span class="row-time">${item.at ? listStamp(item.at) : ''}</span>
        </span>
        <span class="row-bottom">
          <span class="row-preview">${previewHtml(item)}</span>
          ${item.muted ? raw(`<span class="muted-icon">${icon('bellOff', 'xs')}</span>`) : ''}
          ${unread ? html`<span class="badge" aria-label="${item.unread} unread">${item.unread > 99 ? '99+' : item.unread}</span>` : ''}
        </span>
      </span>
    </a>`;
}

function personRowHtml(user) {
  return html`
    <a class="row" role="listitem" href="#/chat/u/${user.id}">
      ${avatarHtml(user, { size: 50, presence: true })}
      <span class="row-main">
        <span class="row-name">${user.name}</span>
        <span class="row-sub">${state.online.has(user.id) ? 'Online' : user.email || ''}</span>
      </span>
    </a>`;
}

function notificationCard() {
  if (!notificationsSupported() || notificationPermission() !== 'default') return '';
  if (localStorage.getItem('wazambi-notif-dismissed')) return '';
  return html`
    <div class="row notif-card" role="listitem">
      <span class="notif-icon">${raw(icon('bell', 'sm'))}</span>
      <span class="row-main">
        <span class="row-name">Get notified about new messages and calls</span>
        <span class="notif-actions">
          <button type="button" class="btn small primary" data-action="enable-notifications">Turn on</button>
          <button type="button" class="btn small outline" data-action="dismiss-notifications">Not now</button>
        </span>
      </span>
    </div>`;
}

export function render() {
  if (!state.me) return;
  const items = entries().filter(item => {
    if (filter === 'unread' && !(item.unread > 0)) return false;
    if (filter === 'groups' && item.type !== 'group') return false;
    if (query && !item.name.toLowerCase().includes(query)) return false;
    return true;
  });

  let out = '';
  if (!query && filter === 'all') out += notificationCard().value || '';

  if (items.length) {
    out += items.map(i => rowHtml(i).value).join('');
  }

  // When searching, also offer people you haven't chatted with yet.
  if (query) {
    const chatted = new Set(state.direct.keys());
    const people = [...state.users.values()].filter(u =>
      u.id !== state.me.id && !chatted.has(u.id) &&
      ((u.name || '').toLowerCase().includes(query) || (u.email || '').toLowerCase().includes(query)));
    if (people.length) {
      out += html`<div class="list-section">People</div>`.value + people.slice(0, 30).map(u => personRowHtml(u).value).join('');
    }
    if (!items.length && !people.length) {
      out += emptyState({ iconName: 'search', title: 'No matches', text: `Nothing matches “${searchEl.value.trim()}”. Check the spelling or search by email.` }).value;
    }
  } else if (!items.length) {
    if (!state.chatListLoaded) {
      out += '<div class="empty"><span class="spinner"></span></div>';
    } else if (filter === 'unread') {
      out += emptyState({ iconName: 'checks', title: "You're all caught up", text: 'No unread messages.' }).value;
    } else if (filter === 'groups') {
      out += emptyState({ iconName: 'users', title: 'No groups yet', text: 'Create a group to talk with several teammates at once.', action: '<button type="button" class="btn primary" id="emptyNewGroup">New group</button>' }).value;
    } else {
      out += emptyState({ iconName: 'chat', title: 'No chats yet', text: 'Start a conversation with someone on your team.', action: '<button type="button" class="btn primary" id="emptyNewChat">Start a chat</button>' }).value;
    }
  }

  listEl.innerHTML = out;
  listEl.querySelector('#emptyNewChat')?.addEventListener('click', openNewChat);
  listEl.querySelector('#emptyNewGroup')?.addEventListener('click', openNewGroup);
}

