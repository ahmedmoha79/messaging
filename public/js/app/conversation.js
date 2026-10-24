// The open conversation: message history with paging, live updates,
// optimistic sending with an offline outbox, replies, reactions, photos,
// files, voice notes, read receipts and typing indicators.
import { html, raw, escapeHtml, linkify, isEmojiOnly, toast, uuid, debounce, isTouch } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { time, dayLabel, sameDay, lastSeen, bytes, duration, colorFor } from '../lib/format.js';
import { state, on, emit, chatKey, isActive, userName, settings } from './state.js';
import {
  fetchMessages, fetchReactions, fetchMessagesByIds, insertMessage, deleteMessage, setReaction,
  markDirectRead, markGroupRead, signPaths, cachedMediaUrl, mediaUrl, uploadMedia, loadGroup, PAGE_SIZE
} from './data.js';
import { avatarHtml, groupAvatarHtml, showMenu, confirmDialog, openSheet, closeMenu, mediaHelpDialog } from './ui.js';
import { bumpChat, sendTyping, typingNames } from './realtime.js';
import { updateBadge, closeNotifications, messagePreviewText } from './notify.js';
import { kindOf, compressImage, imageSize, resampleWave, toggleVoice, stopVoice, openLightbox, MAX_UPLOAD_BYTES } from './media.js';
import { VoiceRecorder, voiceSupported, MAX_VOICE_SECONDS } from './voice.js';
import { startCall } from './calls.js';
import { openProfile } from './profile.js';
import { openGroupInfo, toggleGroupMute, leaveGroup } from './groups.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const GROUP_GAP_MS = 5 * 60 * 1000;
const root = document.getElementById('conversation');

// chat key -> { list, byId, byClient, reactions, reactionIndex, hasMore, loaded, members }
const chats = new Map();
let active = null; // { chat, key, data }
let replyTo = null; // message being replied to
let recorder = null;
let unseenBelow = 0;
let els = {};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function initConversation() {
  root.innerHTML = `
    <header class="convo-head">
      <a class="icon-btn back" href="#/chats" aria-label="Back to chats">${icon('back')}</a>
      <button type="button" class="convo-who" data-act="info">
        <span class="convo-avatar"></span>
        <span class="convo-who-text"><span class="convo-name"></span><span class="convo-status"></span></span>
      </button>
      <button type="button" class="icon-btn" data-act="voice" aria-label="Voice call">${icon('phone')}</button>
      <button type="button" class="icon-btn" data-act="video" aria-label="Video call">${icon('video')}</button>
      <button type="button" class="icon-btn" data-act="more" aria-label="More options">${icon('more')}</button>
    </header>
    <div class="messages" tabindex="-1">
      <div class="messages-inner" role="log" aria-live="polite" aria-relevant="additions"></div>
    </div>
    <button type="button" class="jump-down" hidden aria-label="Jump to latest messages">${icon('arrowDown')}<span class="badge" hidden></span></button>
    <div class="drop-overlay" hidden>Drop to send</div>
    <footer class="composer">
      <div class="composer-reply" hidden>
        <div class="quote"></div>
        <button type="button" class="icon-btn" data-act="cancel-reply" aria-label="Cancel reply">${icon('x', 'sm')}</button>
      </div>
      <div class="composer-row">
        <button type="button" class="icon-btn" data-act="attach" aria-label="Attach photo or file">${icon('clip')}</button>
        <textarea class="composer-input" rows="1" placeholder="Message" aria-label="Message" enterkeyhint="send" maxlength="8000"></textarea>
        <div class="recorder" hidden>
          <button type="button" class="icon-btn" data-act="rec-cancel" aria-label="Discard voice message">${icon('trash')}</button>
          <span class="rec-dot" aria-hidden="true"></span>
          <span class="rec-time">0:00</span>
          <span class="rec-wave" aria-hidden="true"></span>
        </div>
        <button type="button" class="send-btn" data-act="primary" aria-label="Record voice message">${icon('mic')}</button>
      </div>
      <input type="file" class="file-input" multiple hidden
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,.7z,.odt,.ods">
    </footer>`;

  els = {
    head: root.querySelector('.convo-head'),
    avatar: root.querySelector('.convo-avatar'),
    name: root.querySelector('.convo-name'),
    status: root.querySelector('.convo-status'),
    voiceBtn: root.querySelector('[data-act="voice"]'),
    videoBtn: root.querySelector('[data-act="video"]'),
    scroller: root.querySelector('.messages'),
    inner: root.querySelector('.messages-inner'),
    jump: root.querySelector('.jump-down'),
    jumpBadge: root.querySelector('.jump-down .badge'),
    drop: root.querySelector('.drop-overlay'),
    replyBox: root.querySelector('.composer-reply'),
    replyQuote: root.querySelector('.composer-reply .quote'),
    input: root.querySelector('.composer-input'),
    recorderBox: root.querySelector('.recorder'),
    recTime: root.querySelector('.rec-time'),
    recWave: root.querySelector('.rec-wave'),
    primary: root.querySelector('[data-act="primary"]'),
    file: root.querySelector('.file-input')
  };

  root.style.position = 'relative';
  bindHeader();
  bindComposer();
  bindMessages();
  bindDragDrop();

  on('message:new', onRealtimeMessage);
  on('message:update', onRealtimeUpdate);
  on('message:delete', onRealtimeDelete);
  on('reaction', onRealtimeReaction);
  on('presence', renderHeaderStatus);
  on('users', () => active && renderHeader());
  on('me', () => active && renderHeader());
  on('chatlist', () => active?.chat.type === 'group' && renderHeader());
  on('group', id => active?.chat.type === 'group' && active.chat.id === id && renderHeader());
  on('members', id => {
    if (active?.chat.type === 'group' && active.chat.id === id) loadMembers(true);
  });
  on('typing', key => {
    if (active && key === active.key) {
      renderHeaderStatus();
      renderTypingRow();
    }
  });
  on('resync', () => active && refresh());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) markReadSoon();
  });
  window.addEventListener('online', flushOutbox);
  flushOutbox();
  setInterval(renderHeaderStatus, 30000);
}

function getData(key) {
  if (!chats.has(key)) {
    chats.set(key, {
      list: [],
      byId: new Map(),
      byClient: new Map(),
      reactions: new Map(), // messageId -> Map(userId -> { id, emoji })
      reactionIndex: new Map(), // reactionId -> { messageId, userId }
      replies: new Map(), // id -> message (targets outside the loaded page)
      hasMore: true,
      loaded: false,
      members: null
    });
  }
  return chats.get(key);
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------
export async function openChat(chat) {
  if (active && active.key === chatKey(chat.type, chat.id)) {
    markReadSoon();
    return;
  }
  saveDraft();
  cancelRecording();
  stopVoice();
  const key = chatKey(chat.type, chat.id);
  const data = getData(key);
  active = { chat, key, data };
  state.active = chat;
  replyTo = null;
  unseenBelow = 0;
  els.replyBox.hidden = true;
  els.jump.hidden = true;
  root.hidden = false;

  renderHeader();
  els.input.value = loadDraft(key);
  autosize();
  updatePrimaryButton();

  if (data.loaded) {
    renderAll();
    scrollToBottom(false);
    refresh();
  } else {
    els.inner.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    await refresh();
    if (active?.key === key) scrollToBottom(false);
  }
  if (chat.type === 'group') loadMembers();
  markReadSoon();
  if (!isTouch()) els.input.focus({ preventScroll: true });
  emit('chatlist');
}

export function closeChat() {
  if (!active) return;
  saveDraft();
  sendTyping(active.chat, true);
  cancelRecording();
  stopVoice();
  active = null;
  state.active = null;
  root.hidden = true;
  emit('chatlist');
}

async function refresh() {
  const current = active;
  if (!current) return;
  const { chat, data, key } = current;
  try {
    const rows = await fetchMessages(chat);
    if (active?.key !== key) return;
    const firstAt = rows[0]?.created_at;
    const older = firstAt ? data.list.filter(m => !m.local && m.created_at < firstAt) : [];
    const pending = data.list.filter(m => m.local && !rows.some(r => r.client_id && r.client_id === m.client_id));
    const merged = [...older, ...rows, ...pending];
    const changed = !data.loaded || merged.length !== data.list.length || merged.some((m, i) => data.list[i] !== m && keyOf(data.list[i] || {}) !== keyOf(m)) || rows.some(r => (data.byId.get(String(r.id))?.status) !== r.status);
    data.list = merged;
    data.byId = new Map(merged.filter(m => !m.local).map(m => [String(m.id), m]));
    if (!data.loaded) data.hasMore = rows.length === PAGE_SIZE;
    data.loaded = true;
    await hydrate(data, rows);
    if (active?.key !== key) return;
    if (changed) {
      const atBottom = isNearBottom();
      renderAll();
      if (atBottom) scrollToBottom(false);
    }
    markReadSoon();
  } catch (err) {
    console.error(err);
    if (!data.loaded && active?.key === key) {
      els.inner.innerHTML = html`<div class="empty"><span class="empty-icon">${raw(icon('alert', 'lg'))}</span><h3>Couldn’t load messages</h3><p>Check your connection.</p><button type="button" class="btn primary" data-act="retry-load">Try again</button></div>`.value;
    }
  }
}

/** Fetches what a batch of messages needs: signed media links, reactions, reply targets. */
async function hydrate(data, rows) {
  const ids = rows.map(m => m.id);
  const paths = rows.flatMap(m => [m.attachment_path, m.audio_url]).filter(Boolean);
  const missingReplies = [...new Set(rows.map(m => m.reply_to).filter(id => id && !data.byId.has(String(id)) && !data.replies.has(String(id))))];
  const [reactions, replies] = await Promise.all([
    fetchReactions(ids).catch(() => []),
    fetchMessagesByIds(missingReplies).catch(() => []),
    signPaths(paths).catch(() => {})
  ]);
  ids.forEach(id => data.reactions.delete(String(id)));
  reactions.forEach(r => addReactionRow(data, r));
  replies.forEach(r => data.replies.set(String(r.id), r));
}

async function loadOlder() {
  const current = active;
  if (!current || current.loadingOlder || !current.data.hasMore) return;
  const { data, chat, key } = current;
  const oldest = data.list.find(m => !m.local);
  if (!oldest) return;
  current.loadingOlder = true;
  try {
    const rows = await fetchMessages(chat, { before: oldest.created_at });
    await hydrate(data, rows);
    if (active?.key !== key) return;
    data.hasMore = rows.length === PAGE_SIZE;
    const fresh = rows.filter(r => !data.byId.has(String(r.id)));
    fresh.forEach(r => data.byId.set(String(r.id), r));
    data.list = [...fresh, ...data.list];
    const before = els.scroller.scrollHeight;
    const top = els.scroller.scrollTop;
    renderAll();
    els.scroller.scrollTop = top + (els.scroller.scrollHeight - before);
  } catch {
    toast('Couldn’t load older messages.', { type: 'error' });
  } finally {
    current.loadingOlder = false;
  }
}

async function loadMembers(force = false) {
  if (!active || active.chat.type !== 'group') return;
  const { data, chat, key } = active;
  if (data.members && !force) return;
  try {
    const { members } = await loadGroup(chat.id);
    data.members = members;
    if (active?.key === key) renderHeaderStatus();
  } catch {
    /* header falls back to the member count */
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderHeader() {
  if (!active) return;
  const { chat } = active;
  if (chat.type === 'group') {
    const g = state.groups.get(chat.id) || { id: chat.id, name: 'Group' };
    els.avatar.innerHTML = groupAvatarHtml(g, 42).value;
    els.name.textContent = g.name;
    els.voiceBtn.hidden = true;
    els.videoBtn.hidden = true;
  } else {
    const u = state.users.get(chat.id) || { id: chat.id, name: 'Unknown' };
    els.avatar.innerHTML = avatarHtml(u, { size: 42, presence: true }).value;
    els.name.textContent = u.name;
    els.voiceBtn.hidden = false;
    els.videoBtn.hidden = false;
  }
  renderHeaderStatus();
}

function renderHeaderStatus() {
  if (!active) return;
  const { chat, data } = active;
  const typers = typingNames(chat.type, chat.id);
  els.status.className = 'convo-status';
  if (typers.length) {
    els.status.textContent = chat.type === 'group'
      ? `${typers.slice(0, 2).join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…`
      : 'typing…';
    els.status.classList.add('typing');
    return;
  }
  if (chat.type === 'group') {
    if (data.members) {
      const names = data.members
        .map(m => (m.user_id === state.me.id ? 'You' : state.users.get(m.user_id)?.name?.split(' ')[0]))
        .filter(Boolean);
      els.status.textContent = names.join(', ');
    } else {
      const g = state.groups.get(chat.id);
      els.status.textContent = g ? `${g.member_count} members` : '';
    }
    return;
  }
  if (state.online.has(chat.id)) {
    els.status.textContent = 'Online';
    els.status.classList.add('online');
  } else {
    els.status.textContent = lastSeen(state.users.get(chat.id)?.lastonline);
  }
  // keep the presence dot on the avatar current
  const u = state.users.get(chat.id);
  if (u) els.avatar.innerHTML = avatarHtml(u, { size: 42, presence: true }).value;
}

function bindHeader() {
  els.head.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !active) return;
    const { chat } = active;
    if (act === 'info') {
      if (chat.type === 'group') openGroupInfo(chat.id);
      else openProfile(chat.id);
    } else if (act === 'voice') startCall(chat.id, 'audio');
    else if (act === 'video') startCall(chat.id, 'video');
    else if (act === 'more') {
      const items = chat.type === 'group'
        ? [
            { label: 'Group info', icon: 'info', onSelect: () => openGroupInfo(chat.id) },
            { label: state.groups.get(chat.id)?.muted ? 'Unmute notifications' : 'Mute notifications', icon: 'bellOff', onSelect: () => toggleGroupMute(chat.id) },
            { label: 'Leave group', icon: 'logout', danger: true, onSelect: () => leaveGroup(chat.id) }
          ]
        : [
            { label: 'View profile', icon: 'info', onSelect: () => openProfile(chat.id) },
            { label: 'Voice call', icon: 'phone', onSelect: () => startCall(chat.id, 'audio') },
            { label: 'Video call', icon: 'video', onSelect: () => startCall(chat.id, 'video') }
          ];
      showMenu({ anchor: e.target.closest('[data-act]'), items });
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering messages
// ---------------------------------------------------------------------------
const keyOf = m => (m.local ? `c-${m.client_id}` : String(m.id));

function isFirstInRun(m, prev) {
  if (!prev) return true;
  if (prev.sender_id !== m.sender_id) return true;
  if (!sameDay(prev.created_at, m.created_at)) return true;
  return new Date(m.created_at) - new Date(prev.created_at) > GROUP_GAP_MS;
}

function tickHtml(m) {
  if (m.sender_id !== state.me.id) return '';
  if (m.local) {
    if (m.status === 'failed') return `<span class="failed" title="Not sent">${icon('alert', 'xs')}</span>`;
    return `<span title="${m.status === 'queued' ? 'Waiting for connection' : 'Sending'}">${icon('clock', 'xs')}</span>`;
  }
  if (m.group_id) return `<span title="Sent">${icon('check', 'xs')}</span>`;
  if (m.status === 'read' || m.is_read) return `<span class="read" title="Read">${icon('checks', 'xs')}</span>`;
  if (m.status === 'delivered') return `<span title="Delivered">${icon('checks', 'xs')}</span>`;
  return `<span title="Sent">${icon('check', 'xs')}</span>`;
}

function quoteHtml(target, { clickable = true } = {}) {
  if (!target) return html`<span class="quote"><span class="quote-text">Original message unavailable</span></span>`;
  const tag = clickable ? 'button' : 'span';
  return html`<${raw(tag)} ${raw(clickable ? 'type="button"' : '')} class="quote" data-jump="${target.id ?? ''}">
      <span class="quote-name">${userName(target.sender_id)}</span>
      <span class="quote-text">${messagePreviewText(target) || 'Message'}</span>
    </${raw(tag)}>`;
}

function reactionsHtml(data, m) {
  const map = data.reactions.get(String(m.id));
  if (!map || !map.size) return '';
  const counts = new Map();
  let mine = null;
  map.forEach((r, uid) => {
    counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
    if (uid === state.me.id) mine = r.emoji;
  });
  const chips = [...counts.entries()].map(([emoji, n]) =>
    `<button type="button" class="reaction${emoji === mine ? ' mine' : ''}" data-react="${escapeHtml(emoji)}" aria-label="${escapeHtml(emoji)} ${n}">${escapeHtml(emoji)}${n > 1 ? `<b>${n}</b>` : ''}</button>`).join('');
  return `<div class="reactions">${chips}</div>`;
}

function bodyHtml(m) {
  const type = m.message_type || 'text';
  const caption = m.content && !['Photo', 'Video', 'Audio message', 'Voice message', 'File'].includes(m.content) ? m.content : '';
  const progress = m.local && m.progress != null && m.status !== 'failed'
    ? `<div class="upload-progress"><i style="width:${Math.round(m.progress * 100)}%"></i></div>` : '';

  if (type === 'image') {
    const src = m.localUrl || cachedMediaUrl(m.attachment_path);
    const w = m.metadata?.width;
    const h = m.metadata?.height;
    const ratio = w && h ? `aspect-ratio:${w}/${h};` : '';
    return `<button type="button" class="media-img${src ? '' : ' loading'}" data-photo="${escapeHtml(m.attachment_path || '')}" style="${ratio}" aria-label="Open photo">
        ${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(caption || 'Photo')}" loading="lazy" decoding="async">` : '<span class="spinner"></span>'}
      </button>${progress}${caption ? `<span class="bubble-text">${linkify(escapeHtml(caption))}</span>` : ''}`;
  }
  if (type === 'video') {
    const src = m.localUrl || cachedMediaUrl(m.attachment_path);
    return `${src ? `<video class="media-video" src="${escapeHtml(src)}" controls preload="metadata" playsinline></video>` : '<div class="media-img loading"><span class="spinner"></span></div>'}${progress}${caption ? `<span class="bubble-text">${linkify(escapeHtml(caption))}</span>` : ''}`;
  }
  if (type === 'audio') {
    const bars = resampleWave(m.audio_waveform, 36).map(v => `<i style="height:${Math.round(v * 100)}%"></i>`).join('');
    const path = m.audio_url || '';
    return `<div class="voice" data-src="${escapeHtml(path)}" data-duration="${Number(m.audio_duration) || 0}" ${m.localUrl ? `data-local-url="${escapeHtml(m.localUrl)}"` : ''}>
        <button type="button" class="voice-play" aria-label="Play voice message">${icon('play')}</button>
        <span class="voice-wave" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">${bars}</span>
        <span class="voice-time">${duration(m.audio_duration)}</span>
      </div>${progress}`;
  }
  if (type === 'file' || type === 'audio-file') {
    const href = cachedMediaUrl(m.attachment_path);
    const name = m.attachment_name || 'File';
    return `<a class="file-card" ${href ? `href="${escapeHtml(href)}" download="${escapeHtml(name)}"` : ''} data-file="${escapeHtml(m.attachment_path || '')}" target="_blank" rel="noopener">
        <span class="file-icon">${icon('file')}</span>
        <span class="file-info"><span class="file-name">${escapeHtml(name)}</span><span class="file-size">${bytes(m.attachment_size)}${m.attachment_mime ? ` · ${escapeHtml((m.attachment_mime.split('/')[1] || '').toUpperCase().slice(0, 8))}` : ''}</span></span>
      </a>${progress}${caption && caption !== name ? `<span class="bubble-text">${linkify(escapeHtml(caption))}</span>` : ''}`;
  }
  return `<span class="bubble-text">${linkify(escapeHtml(m.content || ''))}</span>`;
}

function msgHtml(data, m, prev) {
  const out = m.sender_id === state.me.id;
  const first = isFirstInRun(m, prev);
  const emoji = (m.message_type || 'text') === 'text' && !m.reply_to && isEmojiOnly(m.content);
  const showSender = !out && first && active?.chat.type === 'group';
  const target = m.reply_to ? data.byId.get(String(m.reply_to)) || data.replies.get(String(m.reply_to)) : null;
  return `
    <div class="msg ${out ? 'out' : 'in'}${first ? ' first' : ''}" data-key="${escapeHtml(keyOf(m))}">
      ${showSender ? `<span class="msg-sender" style="color:${colorFor(m.sender_id)}">${escapeHtml(userName(m.sender_id))}</span>` : ''}
      <div class="bubble${emoji ? ' emoji' : ''}">
        ${m.reply_to ? quoteHtml(target).value : ''}
        ${bodyHtml(m)}
        <span class="meta">${time(m.created_at)}${tickHtml(m)}</span>
        ${!isTouch() && !m.local ? `<button type="button" class="msg-actions-btn" data-act="msg-menu" aria-label="Message options">${icon('more', 'xs')}</button>` : ''}
      </div>
      ${m.local ? '' : reactionsHtml(data, m)}
      ${m.status === 'failed' ? `<button type="button" class="retry-btn" data-act="retry">Not sent. Tap to retry</button>` : ''}
    </div>`;
}

function renderAll() {
  if (!active) return;
  const { data } = active;
  let out = '';
  if (data.hasMore) out += '<div class="load-older" data-sentinel><span class="spinner"></span></div>';
  else if (data.list.length) out += '<div class="history-start">This is the start of your conversation</div>';
  let prev = null;
  for (const m of data.list) {
    if (!prev || !sameDay(prev.created_at, m.created_at)) out += `<div class="day">${escapeHtml(dayLabel(m.created_at))}</div>`;
    out += msgHtml(data, m, prev);
    prev = m;
  }
  if (!data.list.length) {
    const name = active.chat.type === 'group' ? state.groups.get(active.chat.id)?.name : state.users.get(active.chat.id)?.name;
    out += html`<div class="empty"><span class="empty-icon">${raw(icon('chat', 'lg'))}</span><h3>No messages yet</h3><p>Send ${name ? `${name.split(' ')[0]} ` : ''}a message, a photo or a voice note to get started.</p></div>`.value;
  }
  els.inner.innerHTML = out;
  renderTypingRow();
  observeSentinel();
}

function elFor(m) {
  return els.inner.querySelector(`.msg[data-key="${CSS.escape(keyOf(m))}"]`);
}

/** Re-renders one message (and its neighbour's run grouping) in place. */
function rerender(m) {
  if (!active) return;
  const { data } = active;
  const idx = data.list.indexOf(m);
  const node = elFor(m);
  if (idx < 0 || !node) return;
  node.outerHTML = msgHtml(data, m, data.list[idx - 1] || null);
}

function appendMessage(m) {
  const { data } = active;
  const prev = data.list[data.list.length - 2] || null;
  els.inner.querySelector('.empty')?.remove();
  const typingRow = els.inner.querySelector('.typing-row');
  let markup = '';
  if (!prev || !sameDay(prev.created_at, m.created_at)) markup += `<div class="day">${escapeHtml(dayLabel(m.created_at))}</div>`;
  markup += msgHtml(data, m, prev);
  if (typingRow) typingRow.insertAdjacentHTML('beforebegin', markup);
  else els.inner.insertAdjacentHTML('beforeend', markup);
}

function renderTypingRow() {
  if (!active) return;
  const typers = typingNames(active.chat.type, active.chat.id);
  let row = els.inner.querySelector('.typing-row');
  if (!typers.length) {
    row?.remove();
    return;
  }
  if (!row) {
    const atBottom = isNearBottom();
    els.inner.insertAdjacentHTML('beforeend', '<div class="typing-row" aria-label="Typing"><span class="typing-dots"><i></i><i></i><i></i></span></div>');
    if (atBottom) scrollToBottom(true);
  }
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------
function isNearBottom() {
  const s = els.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}

function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
  unseenBelow = 0;
  els.jump.hidden = true;
}

let sentinelObserver = null;
function observeSentinel() {
  sentinelObserver?.disconnect();
  const sentinel = els.inner.querySelector('[data-sentinel]');
  if (!sentinel) return;
  sentinelObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadOlder();
  }, { root: els.scroller, rootMargin: '300px 0px 0px 0px' });
  sentinelObserver.observe(sentinel);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const markReadSoon = debounce(async () => {
  if (!active || document.visibilityState !== 'visible') return;
  const { chat } = active;
  if (chat.type === 'direct') {
    const entry = state.direct.get(chat.id);
    const hasUnread = (entry?.unread || 0) > 0 || active.data.list.some(m => m.sender_id === chat.id && !m.is_read);
    if (!hasUnread) return;
    if (entry) entry.unread = 0;
    active.data.list.forEach(m => {
      if (m.sender_id === chat.id) {
        m.is_read = true;
        m.status = 'read';
      }
    });
    await markDirectRead(chat.id).catch(() => {});
  } else {
    const g = state.groups.get(chat.id);
    if (g) g.unread = 0;
    await markGroupRead(chat.id).catch(() => {});
  }
  closeNotifications(`chat-${chat.type}-${chat.id}`);
  updateBadge();
  emit('chatlist');
}, 250);

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
function belongsTo(m, chat) {
  if (chat.type === 'group') return m.group_id === chat.id;
  if (m.group_id) return false;
  return (m.sender_id === chat.id && m.receiver_id === state.me.id) || (m.sender_id === state.me.id && m.receiver_id === chat.id);
}

function chatOfMessage(m) {
  if (m.group_id) return { type: 'group', id: m.group_id };
  return { type: 'direct', id: m.sender_id === state.me.id ? m.receiver_id : m.sender_id };
}

async function onRealtimeMessage(m) {
  const chat = chatOfMessage(m);
  const key = chatKey(chat.type, chat.id);
  const data = chats.get(key);
  if (!data || !data.loaded) return;

  // Our own optimistic copy: swap it for the real row.
  if (m.client_id && data.byClient.has(m.client_id)) {
    finalizeLocal(data, data.byClient.get(m.client_id), m);
    return;
  }
  if (data.byId.has(String(m.id))) return;

  if (m.attachment_path || m.audio_url) await signPaths([m.attachment_path, m.audio_url].filter(Boolean)).catch(() => {});
  if (m.reply_to && !data.byId.has(String(m.reply_to)) && !data.replies.has(String(m.reply_to))) {
    const [target] = await fetchMessagesByIds([m.reply_to]).catch(() => []);
    if (target) data.replies.set(String(target.id), target);
  }
  if (data.byId.has(String(m.id))) return;
  data.byId.set(String(m.id), m);
  data.list.push(m);

  if (active?.key === key) {
    const atBottom = isNearBottom();
    appendMessage(m);
    if (atBottom || m.sender_id === state.me.id) scrollToBottom(true);
    else {
      unseenBelow += 1;
      els.jump.hidden = false;
      els.jumpBadge.hidden = false;
      els.jumpBadge.textContent = String(unseenBelow);
    }
    if (m.sender_id !== state.me.id) markReadSoon();
  }
}

function onRealtimeUpdate(m) {
  const chat = chatOfMessage(m);
  const data = chats.get(chatKey(chat.type, chat.id));
  const existing = data?.byId.get(String(m.id));
  if (!existing) return;
  Object.assign(existing, m);
  if (active?.data === data) rerender(existing);
}

function onRealtimeDelete(old) {
  for (const [key, data] of chats) {
    const m = data.byId.get(String(old.id));
    if (!m) continue;
    const idx = data.list.indexOf(m);
    data.byId.delete(String(old.id));
    if (idx >= 0) data.list.splice(idx, 1);
    if (active?.key === key) {
      elFor(m)?.remove();
      const next = data.list[idx];
      if (next) rerender(next);
    }
  }
}

function addReactionRow(data, r) {
  const mid = String(r.message_id);
  if (!data.reactions.has(mid)) data.reactions.set(mid, new Map());
  data.reactions.get(mid).set(r.user_id, { id: r.id, emoji: r.emoji });
  if (r.id) data.reactionIndex.set(r.id, { messageId: mid, userId: r.user_id });
}

function onRealtimeReaction({ eventType, new: row, old }) {
  for (const data of chats.values()) {
    let messageId = null;
    if (eventType === 'DELETE') {
      const ref = data.reactionIndex.get(old?.id);
      if (!ref) continue;
      data.reactions.get(ref.messageId)?.delete(ref.userId);
      data.reactionIndex.delete(old.id);
      messageId = ref.messageId;
    } else {
      if (!data.byId.has(String(row.message_id))) continue;
      const prevMap = data.reactions.get(String(row.message_id));
      const prev = prevMap?.get(row.user_id);
      if (prev?.id && prev.id !== row.id) data.reactionIndex.delete(prev.id);
      addReactionRow(data, row);
      messageId = String(row.message_id);
    }
    if (active?.data === data && messageId) {
      const m = data.byId.get(messageId);
      if (m) rerender(m);
    }
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function baseRow(chat) {
  return chat.type === 'group' ? { group_id: chat.id, receiver_id: null } : { receiver_id: chat.id, group_id: null };
}

function addLocal(chat, fields) {
  const key = chatKey(chat.type, chat.id);
  const data = getData(key);
  const local = {
    local: true,
    client_id: uuid(),
    sender_id: state.me.id,
    ...baseRow(chat),
    created_at: new Date().toISOString(),
    status: 'sending',
    message_type: 'text',
    content: '',
    ...fields
  };
  data.list.push(local);
  data.byClient.set(local.client_id, local);
  if (active?.key === key) {
    appendMessage(local);
    scrollToBottom(true);
  }
  bumpChat(local);
  return { local, data, key };
}

function finalizeLocal(data, local, row) {
  data.byClient.delete(local.client_id);
  if (local.localUrl && !/^blob:/.test(row.audio_url || '')) {
    // keep showing the local preview until the signed link is cached
    setTimeout(() => URL.revokeObjectURL(local.localUrl), 60000);
  }
  const idx = data.list.indexOf(local);
  if (data.byId.has(String(row.id))) {
    if (idx >= 0) data.list.splice(idx, 1);
    if (active?.data === data) elFor(local)?.remove();
    return;
  }
  data.byId.set(String(row.id), row);
  if (idx >= 0) data.list[idx] = row;
  else data.list.push(row);
  if (active?.data === data) {
    const node = elFor(local);
    if (node) node.outerHTML = msgHtml(data, row, data.list[data.list.indexOf(row) - 1] || null);
  }
  bumpChat(row);
}

async function deliver({ local, data }, row) {
  try {
    const saved = await insertMessage({ ...row, client_id: local.client_id });
    finalizeLocal(data, local, saved);
    removeFromOutbox(local.client_id);
  } catch (err) {
    const offline = !navigator.onLine || /fetch|network/i.test(String(err?.message));
    if (offline && local.message_type === 'text') {
      local.status = 'queued';
      addToOutbox(local, row);
    } else {
      local.status = 'failed';
      local.retry = () => {
        local.status = 'sending';
        if (active?.data === data) rerender(local);
        deliver({ local, data }, row);
      };
      if (!offline) toast(friendlySendError(err), { type: 'error' });
    }
    if (active?.data === data) rerender(local);
  }
}

function friendlySendError(err) {
  const msg = String(err?.message || '');
  if (/row-level security|permission/i.test(msg)) return 'You can’t send messages to this chat.';
  if (/too large|exceeded|size/i.test(msg)) return 'That file is too large to send (50 MB max).';
  return 'Message not sent. Tap it to try again.';
}

export async function sendText(text) {
  if (!active) return;
  const content = text.trim();
  if (!content) return;
  const chat = active.chat;
  const reply = replyTo;
  clearReply();
  const ctx = addLocal(chat, { content, reply_to: reply?.id ?? null });
  sendTyping(chat, true);
  await deliver(ctx, { ...baseRow(chat), content, message_type: 'text', reply_to: reply?.id ?? null });
}

async function sendAttachment(chat, file, caption = '') {
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(`${file.name} is larger than 50 MB.`, { type: 'error' });
    return;
  }
  const kind = kindOf(file);
  const prepared = kind === 'image' ? await compressImage(file) : file;
  const dims = kind === 'image' ? await imageSize(prepared) : null;
  const messageType = kind === 'audio-file' ? 'file' : kind;
  const reply = replyTo;
  clearReply();
  const label = { image: 'Photo', video: 'Video', file: prepared.name || 'File' }[messageType];
  const ctx = addLocal(chat, {
    message_type: messageType,
    content: caption || label,
    attachment_name: prepared.name,
    attachment_size: prepared.size,
    attachment_mime: prepared.type,
    metadata: dims,
    localUrl: kind === 'image' || kind === 'video' ? URL.createObjectURL(prepared) : null,
    progress: 0,
    reply_to: reply?.id ?? null
  });
  const { local, data } = ctx;
  const updateProgress = p => {
    local.progress = p;
    const bar = active?.data === data ? elFor(local)?.querySelector('.upload-progress i') : null;
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  };
  try {
    const path = await uploadMedia(prepared, { name: prepared.name, onProgress: updateProgress });
    local.progress = null;
    await signPaths([path]).catch(() => {});
    await deliver(ctx, {
      ...baseRow(chat),
      message_type: messageType,
      content: caption || label,
      attachment_path: path,
      attachment_name: prepared.name,
      attachment_size: prepared.size,
      attachment_mime: prepared.type,
      metadata: dims,
      reply_to: reply?.id ?? null
    });
  } catch (err) {
    local.status = 'failed';
    local.retry = () => {
      const idx = data.list.indexOf(local);
      if (idx >= 0) data.list.splice(idx, 1);
      data.byClient.delete(local.client_id);
      if (active?.data === data) elFor(local)?.remove();
      sendAttachment(chat, prepared, caption);
    };
    if (active?.data === data) rerender(local);
    toast(err?.message || 'Upload failed.', { type: 'error' });
  }
}

async function sendVoice(chat, { blob, duration: secs, waveform }) {
  const reply = replyTo;
  clearReply();
  const localUrl = URL.createObjectURL(blob);
  const ctx = addLocal(chat, {
    message_type: 'audio',
    content: 'Voice message',
    audio_duration: secs,
    audio_waveform: waveform,
    localUrl,
    progress: 0,
    reply_to: reply?.id ?? null
  });
  const { local, data } = ctx;
  try {
    const path = await uploadMedia(blob, {
      name: `voice.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`,
      onProgress: p => {
        local.progress = p;
        const bar = active?.data === data ? elFor(local)?.querySelector('.upload-progress i') : null;
        if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      }
    });
    local.progress = null;
    await signPaths([path]).catch(() => {});
    await deliver(ctx, {
      ...baseRow(chat),
      message_type: 'audio',
      content: 'Voice message',
      audio_url: path,
      audio_duration: secs,
      audio_waveform: waveform,
      reply_to: reply?.id ?? null
    });
  } catch (err) {
    local.status = 'failed';
    local.retry = () => {
      const idx = data.list.indexOf(local);
      if (idx >= 0) data.list.splice(idx, 1);
      data.byClient.delete(local.client_id);
      if (active?.data === data) elFor(local)?.remove();
      sendVoice(chat, { blob, duration: secs, waveform });
    };
    if (active?.data === data) rerender(local);
    toast(err?.message || 'Voice message not sent.', { type: 'error' });
  }
}

// Offline outbox for text messages (survives a reload).
const OUTBOX_KEY = 'wazambi-outbox';
function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
  } catch {
    return [];
  }
}
function writeOutbox(items) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}
function addToOutbox(local, row) {
  const items = readOutbox().filter(i => i.client_id !== local.client_id);
  items.push({ client_id: local.client_id, row, created_at: local.created_at, owner: state.me.id });
  writeOutbox(items);
}
function removeFromOutbox(clientId) {
  const items = readOutbox();
  const next = items.filter(i => i.client_id !== clientId);
  if (next.length !== items.length) writeOutbox(next);
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine || !state.me) return;
  flushing = true;
  try {
    for (const item of readOutbox()) {
      if (item.owner !== state.me.id) continue;
      const row = item.row;
      const chat = row.group_id ? { type: 'group', id: row.group_id } : { type: 'direct', id: row.receiver_id };
      const data = getData(chatKey(chat.type, chat.id));
      let local = data.byClient.get(item.client_id);
      if (!local) {
        local = { local: true, client_id: item.client_id, sender_id: state.me.id, ...row, created_at: item.created_at, status: 'sending' };
        data.byClient.set(local.client_id, local);
        if (data.loaded) data.list.push(local);
      } else {
        local.status = 'sending';
      }
      if (active?.data === data) rerender(local) || (!elFor(local) && appendMessage(local));
      await deliver({ local, data }, row);
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
function autosize() {
  const t = els.input;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

function updatePrimaryButton() {
  const hasText = els.input.value.trim().length > 0;
  const recording = !!recorder;
  const mode = recording || hasText || !voiceSupported() ? 'send' : 'mic';
  if (els.primary.dataset.mode === mode) return;
  els.primary.dataset.mode = mode;
  els.primary.innerHTML = icon(mode === 'send' ? 'send' : 'mic');
  els.primary.setAttribute('aria-label', mode === 'send' ? (recording ? 'Send voice message' : 'Send message') : 'Record voice message');
}

function draftKey(key) {
  return `wazambi-draft:${state.me?.id}:${key}`;
}
function saveDraft() {
  if (!active) return;
  try {
    const v = els.input.value;
    if (v.trim()) localStorage.setItem(draftKey(active.key), v);
    else localStorage.removeItem(draftKey(active.key));
  } catch {
    /* ignore */
  }
}
function loadDraft(key) {
  try {
    return localStorage.getItem(draftKey(key)) || '';
  } catch {
    return '';
  }
}

function bindComposer() {
  els.input.addEventListener('input', () => {
    autosize();
    updatePrimaryButton();
    if (active && els.input.value.trim()) sendTyping(active.chat);
    saveDraftSoon();
  });
  els.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (settings.enterToSend || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitText();
    }
    if (e.key === 'Escape' && replyTo) clearReply();
    if (e.key === 'ArrowUp' && !els.input.value && active) {
      // quick reply to the latest incoming message
      const last = [...active.data.list].reverse().find(m => !m.local && m.sender_id !== state.me.id);
      if (last && e.altKey) setReply(last);
    }
  });
  els.input.addEventListener('blur', () => active && sendTyping(active.chat, true));
  els.input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      openAttachPreview(files);
    }
  });

  root.querySelector('.composer').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'attach') els.file.click();
    else if (act === 'cancel-reply') clearReply();
    else if (act === 'rec-cancel') cancelRecording();
    else if (act === 'primary') {
      if (recorder) finishRecording();
      else if (els.primary.dataset.mode === 'mic') startRecording();
      else submitText();
    }
  });
  els.file.addEventListener('change', () => {
    const files = [...els.file.files];
    els.file.value = '';
    if (files.length) openAttachPreview(files);
  });
}
const saveDraftSoon = debounce(saveDraft, 400);

function submitText() {
  const text = els.input.value;
  if (!text.trim() || !active) return;
  els.input.value = '';
  autosize();
  updatePrimaryButton();
  saveDraft();
  sendText(text);
  if (isTouch()) els.input.focus({ preventScroll: true });
}

function setReply(m) {
  replyTo = m;
  els.replyQuote.outerHTML = quoteHtml(m, { clickable: false }).value;
  els.replyQuote = els.replyBox.querySelector('.quote');
  els.replyBox.hidden = false;
  els.input.focus({ preventScroll: true });
}
function clearReply() {
  replyTo = null;
  els.replyBox.hidden = true;
}

// Voice recording -----------------------------------------------------------
async function startRecording() {
  if (!active || recorder) return;
  stopVoice();
  const rec = new VoiceRecorder({
    onLevel: level => {
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(8, Math.round(level * 100))}%`;
      els.recWave.appendChild(bar);
      while (els.recWave.childElementCount > 80) els.recWave.firstElementChild.remove();
    },
    onTick: secs => { els.recTime.textContent = duration(secs); },
    onLimit: () => finishRecording()
  });
  try {
    recorder = rec;
    await rec.start();
  } catch (err) {
    recorder = null;
    if (await mediaHelpDialog(err)) startRecording();
    return;
  }
  els.recWave.innerHTML = '';
  els.recTime.textContent = '0:00';
  els.input.hidden = true;
  root.querySelector('[data-act="attach"]').hidden = true;
  els.recorderBox.hidden = false;
  updatePrimaryButton();
  if (active) sendTyping(active.chat);
}

async function finishRecording() {
  const rec = recorder;
  if (!rec) return;
  const chat = active?.chat;
  resetRecorderUi();
  const result = await rec.stop();
  if (!result) {
    toast('Hold on a little longer: voice messages need at least a second.');
    return;
  }
  if (result.duration >= MAX_VOICE_SECONDS) toast('Voice messages are limited to 5 minutes.');
  if (chat) sendVoice(chat, result);
}

function cancelRecording() {
  if (!recorder) return;
  recorder.cancel();
  resetRecorderUi();
}

function resetRecorderUi() {
  recorder = null;
  els.recorderBox.hidden = true;
  els.input.hidden = false;
  root.querySelector('[data-act="attach"]').hidden = false;
  updatePrimaryButton();
}

// Attachments ----------------------------------------------------------------
function openAttachPreview(files) {
  if (!active) return;
  const chat = active.chat;
  let list = files.slice(0, 10);
  if (files.length > 10) toast('You can send up to 10 files at a time.');
  const content = document.createElement('div');
  content.className = 'attach-preview';
  const urls = [];
  const draw = () => {
    urls.forEach(u => URL.revokeObjectURL(u));
    urls.length = 0;
    content.querySelector('.attach-grid').innerHTML = list.map((f, i) => {
      const kind = kindOf(f);
      let inner;
      if (kind === 'image' || kind === 'video') {
        const u = URL.createObjectURL(f);
        urls.push(u);
        inner = kind === 'image' ? `<img src="${u}" alt="">` : `<video src="${u}" muted playsinline></video>`;
      } else {
        inner = `<span>${icon('file', 'lg')}<br>${escapeHtml(f.name)}<br>${bytes(f.size)}</span>`;
      }
      return `<div class="attach-item">${inner}<button type="button" class="icon-btn remove" data-remove="${i}" aria-label="Remove ${escapeHtml(f.name)}">${icon('x', 'sm')}</button></div>`;
    }).join('');
  };
  content.innerHTML = `
    <div class="attach-grid"></div>
    <div class="attach-send">
      <textarea class="input" rows="1" placeholder="Add a caption" maxlength="2000" aria-label="Caption"></textarea>
      <button type="button" class="send-btn" aria-label="Send">${icon('send')}</button>
    </div>`;
  draw();
  const caption = content.querySelector('textarea');
  caption.value = els.input.value;
  const sheet = openSheet({
    title: list.length === 1 ? 'Send 1 file' : `Send ${list.length} files`,
    content,
    onClose: () => urls.forEach(u => URL.revokeObjectURL(u))
  });
  const send = () => {
    const text = caption.value.trim();
    sheet.close();
    if (text && text === els.input.value.trim()) {
      els.input.value = '';
      autosize();
      updatePrimaryButton();
      saveDraft();
    }
    list.forEach((f, i) => sendAttachment(chat, f, i === 0 ? text : ''));
  };
  content.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      list = list.filter((_, i) => i !== Number(rm.dataset.remove));
      if (!list.length) sheet.close();
      else draw();
    }
    if (e.target.closest('.send-btn')) send();
  });
  caption.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  if (!isTouch()) caption.focus();
}

function bindDragDrop() {
  let depth = 0;
  root.addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    depth += 1;
    els.drop.hidden = false;
  });
  root.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  root.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) els.drop.hidden = true;
  });
  root.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    depth = 0;
    els.drop.hidden = true;
    if (!files.length) return;
    e.preventDefault();
    openAttachPreview(files);
  });
}

// ---------------------------------------------------------------------------
// Message interactions
// ---------------------------------------------------------------------------
function messageFromEl(node) {
  const key = node?.closest('.msg')?.dataset.key;
  if (!key || !active) return null;
  const { data } = active;
  return key.startsWith('c-') ? data.byClient.get(key.slice(2)) : data.byId.get(key);
}

function openMessageMenu(m, point) {
  if (!m || m.local) return;
  const data = active.data;
  const mine = m.sender_id === state.me.id;
  const myReaction = data.reactions.get(String(m.id))?.get(state.me.id)?.emoji;
  const header = document.createElement('div');
  header.className = 'menu-emojis';
  REACTIONS.forEach(emoji => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.setAttribute('aria-label', `React ${emoji}`);
    if (emoji === myReaction) b.classList.add('mine');
    b.addEventListener('click', () => {
      closeMenu();
      react(m, emoji === myReaction ? null : emoji);
    });
    header.appendChild(b);
  });
  const items = [{ label: 'Reply', icon: 'reply', onSelect: () => setReply(m) }];
  if ((m.message_type || 'text') === 'text' && m.content) {
    items.push({
      label: 'Copy text',
      icon: 'copy',
      onSelect: () => navigator.clipboard?.writeText(m.content).then(() => toast('Copied'), () => toast('Couldn’t copy', { type: 'error' }))
    });
  }
  if (m.attachment_path || (m.audio_url && m.message_type === 'audio')) {
    items.push({
      label: 'Save',
      icon: 'download',
      onSelect: async () => {
        const url = await mediaUrl(m.attachment_path || m.audio_url);
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = m.attachment_name || 'voice-message';
        a.target = '_blank';
        a.rel = 'noopener';
        a.click();
      }
    });
  }
  if (mine) {
    items.push({
      label: 'Delete for everyone',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({ title: 'Delete message?', message: 'It will be removed for everyone in this chat.', confirm: 'Delete', danger: true });
        if (!ok) return;
        try {
          await deleteMessage(m);
          onRealtimeDelete({ id: m.id });
        } catch {
          toast('Couldn’t delete the message.', { type: 'error' });
        }
      }
    });
  }
  showMenu({ ...point, items, header });
}

async function react(m, emoji) {
  const data = active.data;
  const mid = String(m.id);
  const before = data.reactions.get(mid)?.get(state.me.id);
  // optimistic
  if (emoji) addReactionRow(data, { id: before?.id, message_id: m.id, user_id: state.me.id, emoji });
  else data.reactions.get(mid)?.delete(state.me.id);
  rerender(m);
  try {
    await setReaction(m.id, emoji);
  } catch {
    if (before) addReactionRow(data, { ...before, message_id: m.id, user_id: state.me.id });
    else data.reactions.get(mid)?.delete(state.me.id);
    rerender(m);
    toast('Couldn’t save your reaction.', { type: 'error' });
  }
}

function bindMessages() {
  els.scroller.addEventListener('scroll', () => {
    if (isNearBottom()) {
      unseenBelow = 0;
      els.jump.hidden = true;
      els.jumpBadge.hidden = true;
    } else if (els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight > 600) {
      els.jump.hidden = false;
    }
  }, { passive: true });
  els.jump.addEventListener('click', () => scrollToBottom(true));

  els.inner.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-act="retry-load"]')) {
      refresh();
      return;
    }
    const m = messageFromEl(t);
    if (t.closest('[data-act="retry"]')) {
      m?.retry?.();
      return;
    }
    if (t.closest('[data-act="msg-menu"]')) {
      openMessageMenu(m, { anchor: t.closest('[data-act="msg-menu"]') });
      return;
    }
    const reaction = t.closest('[data-react]');
    if (reaction && m) {
      const mine = active.data.reactions.get(String(m.id))?.get(state.me.id)?.emoji;
      react(m, mine === reaction.dataset.react ? null : reaction.dataset.react);
      return;
    }
    const photo = t.closest('[data-photo]');
    if (photo && m) {
      openLightbox({ path: m.attachment_path, localUrl: m.localUrl, name: m.attachment_name || 'photo.jpg' });
      return;
    }
    const voice = t.closest('.voice');
    if (voice) {
      const wave = t.closest('.voice-wave');
      if (wave) {
        const r = wave.getBoundingClientRect();
        toggleVoice(voice, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      } else if (t.closest('.voice-play')) {
        toggleVoice(voice);
      }
      return;
    }
    const file = t.closest('[data-file]');
    if (file && !file.getAttribute('href') && m) {
      e.preventDefault();
      mediaUrl(m.attachment_path).then(url => url && window.open(url, '_blank', 'noopener'));
      return;
    }
    const jump = t.closest('[data-jump]');
    if (jump) {
      const target = active.data.byId.get(jump.dataset.jump);
      const node = target && elFor(target);
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.classList.remove('highlight');
        void node.offsetWidth;
        node.classList.add('highlight');
      } else {
        toast('That message is further back in the chat.');
      }
    }
  });

  // Right-click on desktop, long-press on Android (fires contextmenu)
  let lastMenuAt = 0;
  els.inner.addEventListener('contextmenu', e => {
    const m = messageFromEl(e.target);
    if (!m || e.target.closest('a, video')) return;
    e.preventDefault();
    lastMenuAt = Date.now();
    openMessageMenu(m, { x: e.clientX, y: e.clientY });
  });

  // Long-press for iOS (no contextmenu) + swipe right to reply on touch screens
  let press = null;
  els.inner.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const msgEl = e.target.closest('.msg');
    if (!msgEl || e.target.closest('button, a, video, .voice')) return;
    press = { el: msgEl, x: e.clientX, y: e.clientY, dx: 0, swiping: false };
    press.timer = setTimeout(() => {
      if (!press || press.swiping || Date.now() - lastMenuAt < 700) return;
      lastMenuAt = Date.now();
      navigator.vibrate?.(15);
      openMessageMenu(messageFromEl(press.el), { x: press.x, y: press.y });
      press = null;
    }, 480);
  });
  els.inner.addEventListener('pointermove', e => {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (Math.abs(dy) > 12 && !press.swiping) {
      clearTimeout(press.timer);
      press = null;
      return;
    }
    if (dx > 10 && Math.abs(dx) > Math.abs(dy)) {
      clearTimeout(press.timer);
      press.swiping = true;
      press.dx = Math.min(80, dx);
      press.el.style.transform = `translateX(${press.dx}px)`;
    }
  });
  const endPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.swiping) {
      const node = press.el;
      node.style.transition = 'transform 160ms';
      node.style.transform = '';
      setTimeout(() => { node.style.transition = ''; }, 170);
      if (press.dx > 56) {
        const m = messageFromEl(node);
        if (m && !m.local) {
          navigator.vibrate?.(10);
          setReply(m);
        }
      }
    }
    press = null;
  };
  els.inner.addEventListener('pointerup', endPress);
  els.inner.addEventListener('pointercancel', endPress);

  // keyboard: Enter or Space on the waveform toggles playback
  els.inner.addEventListener('keydown', e => {
    const wave = e.target.closest?.('.voice-wave');
    if (wave && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleVoice(wave.closest('.voice'));
    }
  });
}

export function activeChat() {
  return active?.chat || null;
}

export function isChatOpen(type, id) {
  return isActive(type, id);
}
