// People picker, new chat, new group and group info / management.
import { html, raw, el, toast, debounce, escapeHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { lastSeen } from '../lib/format.js';
import { state, emit } from './state.js';
import { avatarHtml, groupAvatarHtml, openSheet, confirmDialog, emptyState } from './ui.js';
import { createGroup, loadGroup, addGroupMembers, removeGroupMember, updateGroup, setGroupMuted, loadChatList } from './data.js';

function people(excludeIds = []) {
  const skip = new Set([state.me.id, ...excludeIds]);
  return [...state.users.values()]
    .filter(u => !skip.has(u.id))
    .sort((a, b) => {
      const ao = state.online.has(a.id) ? 0 : 1;
      const bo = state.online.has(b.id) ? 0 : 1;
      return ao - bo || (a.name || '').localeCompare(b.name || '');
    });
}

function personRow(u, { selectable = false, selected = false, callMode = false } = {}) {
  const sub = state.online.has(u.id) ? 'Online' : lastSeen(u.lastonline);
  return html`
    <div class="row" role="${selectable ? 'checkbox' : 'listitem'}" ${raw(selectable ? `aria-checked="${selected}" tabindex="0"` : 'tabindex="0"')} data-user="${u.id}">
      ${avatarHtml(u, { size: 46, presence: true })}
      <span class="row-main">
        <span class="row-name">${u.name}</span>
        <span class="row-sub">${sub}</span>
      </span>
      ${selectable ? raw(`<span class="check-mark">${icon('check')}</span>`) : ''}
      ${callMode ? raw(`<span class="row-actions">
          <button type="button" class="icon-btn" data-call="audio" aria-label="Voice call ${escapeHtml(u.name)}">${icon('phone')}</button>
          <button type="button" class="icon-btn" data-call="video" aria-label="Video call ${escapeHtml(u.name)}">${icon('video')}</button>
        </span>`) : ''}
    </div>`;
}

/**
 * Generic people list with search. `onPick(user, kind?)` fires on tap
 * (or on a call button in call mode).
 */
export function openPeoplePicker({ title, onPick, callMode = false, extraTop = null }) {
  const content = el(html`
    <div class="form-stack">
      <div class="search" style="margin:0">${raw(icon('search', 'sm'))}<input type="search" placeholder="Search people" aria-label="Search people" autocomplete="off"></div>
      <div class="list" role="list"></div>
    </div>`);
  const input = content.querySelector('input');
  const list = content.querySelector('.list');
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const rows = people().filter(u => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
    list.innerHTML = (extraTop && !q ? extraTop : '') + (rows.length
      ? rows.map(u => personRow(u, { callMode }).value).join('')
      : emptyState({ iconName: 'search', title: q ? 'No one found' : 'No teammates yet', text: q ? 'Try a different name or email.' : 'When teammates create accounts they’ll appear here.' }).value);
  };
  draw();
  input.addEventListener('input', debounce(draw, 60));
  const sheet = openSheet({ title, content });
  const pick = (target, kind) => {
    const row = target.closest('[data-user]');
    if (!row) return false;
    const user = state.users.get(row.dataset.user);
    if (!user) return false;
    sheet.close().then(() => onPick(user, kind));
    return true;
  };
  list.addEventListener('click', e => {
    if (e.target.closest('[data-new-group]')) {
      sheet.close().then(openNewGroup);
      return;
    }
    const callBtn = e.target.closest('[data-call]');
    if (callBtn) pick(callBtn, callBtn.dataset.call);
    else if (!callMode) pick(e.target);
  });
  list.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !callMode) pick(e.target);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !callMode) {
      const first = list.querySelector('[data-user]');
      if (first) pick(first);
    }
  });
  return sheet;
}

export function openNewChat() {
  openPeoplePicker({
    title: 'New chat',
    extraTop: html`
      <button type="button" class="row" data-new-group>
        <span class="avatar group" style="--size:46px;--avatar-bg:var(--leaf)">${raw(icon('users'))}</span>
        <span class="row-main"><span class="row-name">New group</span><span class="row-sub">Talk with several teammates at once</span></span>
      </button>
      <div class="list-section">Your team</div>`.value,
    onPick: user => { location.hash = `#/chat/u/${user.id}`; }
  });
}

// ---------------------------------------------------------------------------
// New group: choose people, then name it
// ---------------------------------------------------------------------------
export function openNewGroup() {
  const selected = new Set();
  const content = el(html`
    <div class="form-stack">
      <label class="field"><span>Group name</span><input class="input" maxlength="80" placeholder="e.g. Lusaka dispatch" autocomplete="off"></label>
      <div class="selected-people" aria-live="polite"></div>
      <div class="search" style="margin:0">${raw(icon('search', 'sm'))}<input type="search" class="people-search" placeholder="Add people" aria-label="Search people to add" autocomplete="off"></div>
      <div class="list" role="group" aria-label="Team members"></div>
      <p class="error-text" hidden></p>
      <div class="form-actions"><button type="button" class="btn primary" data-create>Create group</button></div>
    </div>`);
  const nameInput = content.querySelector('.input');
  const search = content.querySelector('.people-search');
  const list = content.querySelector('.list');
  const chips = content.querySelector('.selected-people');
  const error = content.querySelector('.error-text');
  const createBtn = content.querySelector('[data-create]');

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = people().filter(u => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
    list.innerHTML = rows.map(u => personRow(u, { selectable: true, selected: selected.has(u.id) }).value).join('') ||
      emptyState({ iconName: 'search', title: 'No one found', text: 'Try a different name.' }).value;
    chips.innerHTML = [...selected].map(id => {
      const u = state.users.get(id);
      return html`<button type="button" class="person-chip" data-unselect="${id}" aria-label="Remove ${u?.name}">${avatarHtml(u, { size: 24 })}${u?.name?.split(' ')[0]}${raw(icon('x'))}</button>`.value;
    }).join('');
    createBtn.textContent = selected.size ? `Create group (${selected.size + 1})` : 'Create group';
  };
  draw();
  const toggle = id => {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    draw();
  };
  list.addEventListener('click', e => {
    const row = e.target.closest('[data-user]');
    if (row) toggle(row.dataset.user);
  });
  list.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-user]')) {
      e.preventDefault();
      toggle(e.target.closest('[data-user]').dataset.user);
      list.querySelector(`[data-user="${CSS.escape(e.target.closest('[data-user]').dataset.user)}"]`)?.focus();
    }
  });
  chips.addEventListener('click', e => {
    const chip = e.target.closest('[data-unselect]');
    if (chip) toggle(chip.dataset.unselect);
  });
  search.addEventListener('input', debounce(draw, 60));

  const sheet = openSheet({ title: 'New group', content, wide: true });
  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    error.hidden = true;
    if (!name) {
      error.textContent = 'Give the group a name.';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    if (!selected.size) {
      error.textContent = 'Add at least one person.';
      error.hidden = false;
      search.focus();
      return;
    }
    createBtn.disabled = true;
    try {
      const id = await createGroup(name, [...selected]);
      await sheet.close();
      location.hash = `#/chat/g/${id}`;
      toast(`Created ${name}`);
    } catch (err) {
      error.textContent = 'Couldn’t create the group. Check your connection and try again.';
      error.hidden = false;
    } finally {
      createBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Group info
// ---------------------------------------------------------------------------
export async function openGroupInfo(groupId) {
  const content = el('<div class="form-stack"><div class="empty"><span class="spinner"></span></div></div>');
  const sheet = openSheet({ title: 'Group info', content, wide: true });
  let info;

  const draw = () => {
    const { group, members } = info;
    const me = members.find(m => m.user_id === state.me.id);
    const isAdmin = me?.role === 'admin';
    const muted = state.groups.get(groupId)?.muted ?? me?.muted;
    const sorted = [...members].sort((a, b) =>
      (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) ||
      (state.users.get(a.user_id)?.name || '').localeCompare(state.users.get(b.user_id)?.name || ''));
    content.innerHTML = html`
      <div class="profile">
        ${groupAvatarHtml(group, 96)}
        <h3>${group.name}</h3>
        <p class="status-line">${members.length} members</p>
        ${group.description ? html`<p>${group.description}</p>` : ''}
        <div class="profile-actions">
          ${isAdmin ? raw(`<button type="button" class="profile-action" data-g="rename">${icon('edit')}<span>Rename</span></button>`) : ''}
          ${isAdmin ? raw(`<button type="button" class="profile-action" data-g="add">${icon('userPlus')}<span>Add</span></button>`) : ''}
          <button type="button" class="profile-action" data-g="mute">${raw(icon(muted ? 'bell' : 'bellOff'))}<span>${muted ? 'Unmute' : 'Mute'}</span></button>
          <button type="button" class="profile-action" data-g="leave" style="color:var(--danger)">${raw(icon('logout'))}<span>Leave</span></button>
        </div>
      </div>
      <div class="list" role="list">
        ${raw(sorted.map(m => {
          const u = state.users.get(m.user_id) || { id: m.user_id, name: 'Former member' };
          const self = m.user_id === state.me.id;
          return html`
            <div class="row" role="listitem" data-member="${m.user_id}">
              ${avatarHtml(u, { size: 44, presence: true })}
              <span class="row-main">
                <span class="row-name">${self ? `${u.name} (you)` : u.name}</span>
                <span class="row-sub">${m.role === 'admin' ? 'Admin' : state.online.has(u.id) ? 'Online' : lastSeen(u.lastonline)}</span>
              </span>
              ${isAdmin && !self ? raw(`<button type="button" class="icon-btn" data-remove="${escapeHtml(m.user_id)}" aria-label="Remove ${escapeHtml(u.name)}">${icon('x', 'sm')}</button>`) : ''}
            </div>`.value;
        }).join(''))}
      </div>`.value;
  };

  const reload = async () => {
    info = await loadGroup(groupId);
    draw();
  };
  try {
    await reload();
  } catch {
    content.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load this group', text: 'You may no longer be a member.' }).value;
    return;
  }

  content.addEventListener('click', async e => {
    const member = e.target.closest('[data-member]');
    const remove = e.target.closest('[data-remove]');
    const act = e.target.closest('[data-g]')?.dataset.g;
    if (remove) {
      const u = state.users.get(remove.dataset.remove);
      if (!(await confirmDialog({ title: 'Remove member?', message: `${u?.name || 'They'} will no longer see new messages in ${info.group.name}.`, confirm: 'Remove', danger: true }))) return;
      try {
        await removeGroupMember(groupId, remove.dataset.remove);
        await reload();
        emit('members', groupId);
      } catch {
        toast('Couldn’t remove that member.', { type: 'error' });
      }
      return;
    }
    if (act === 'rename') {
      const name = await promptText({ title: 'Rename group', label: 'Group name', value: info.group.name, maxLength: 80 });
      if (!name || name === info.group.name) return;
      try {
        await updateGroup(groupId, { name });
        const g = state.groups.get(groupId);
        if (g) g.name = name;
        emit('chatlist');
        emit('group', groupId);
        await reload();
      } catch {
        toast('Couldn’t rename the group.', { type: 'error' });
      }
    } else if (act === 'add') {
      const existing = info.members.map(m => m.user_id);
      openAddMembers(groupId, existing, async () => {
        await reload();
        await loadChatList();
        emit('members', groupId);
      });
    } else if (act === 'mute') {
      await toggleGroupMute(groupId);
      draw();
    } else if (act === 'leave') {
      await sheet.close();
      leaveGroup(groupId);
    } else if (member && member.dataset.member !== state.me.id && !remove) {
      await sheet.close();
      const { openProfile } = await import('./profile.js');
      openProfile(member.dataset.member);
    }
  });
}

function openAddMembers(groupId, existing, onDone) {
  const selected = new Set();
  const content = el(html`
    <div class="form-stack">
      <div class="list" role="group" aria-label="Team members"></div>
      <div class="form-actions"><button type="button" class="btn primary" data-add disabled>Add</button></div>
    </div>`);
  const list = content.querySelector('.list');
  const btn = content.querySelector('[data-add]');
  const draw = () => {
    const rows = people(existing);
    list.innerHTML = rows.map(u => personRow(u, { selectable: true, selected: selected.has(u.id) }).value).join('') ||
      emptyState({ iconName: 'users', title: 'Everyone’s already here', text: 'All of your teammates are in this group.' }).value;
    btn.disabled = !selected.size;
    btn.textContent = selected.size ? `Add ${selected.size}` : 'Add';
  };
  draw();
  list.addEventListener('click', e => {
    const row = e.target.closest('[data-user]');
    if (!row) return;
    const id = row.dataset.user;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    draw();
  });
  const sheet = openSheet({ title: 'Add members', content });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await addGroupMembers(groupId, [...selected]);
      sheet.close();
      toast(selected.size === 1 ? 'Member added' : `${selected.size} members added`);
      onDone?.();
    } catch {
      toast('Only group admins can add people.', { type: 'error' });
      btn.disabled = false;
    }
  });
}

export async function toggleGroupMute(groupId) {
  const g = state.groups.get(groupId);
  const next = !g?.muted;
  try {
    await setGroupMuted(groupId, next);
    if (g) g.muted = next;
    emit('chatlist');
    toast(next ? 'Notifications muted for this group' : 'Notifications on');
  } catch {
    toast('Couldn’t change notifications.', { type: 'error' });
  }
}

export async function leaveGroup(groupId) {
  const g = state.groups.get(groupId);
  const ok = await confirmDialog({
    title: `Leave ${g?.name || 'group'}?`,
    message: 'You won’t get new messages from this group. An admin can add you back.',
    confirm: 'Leave',
    danger: true
  });
  if (!ok) return;
  try {
    await removeGroupMember(groupId, state.me.id);
    state.groups.delete(groupId);
    emit('chatlist');
    if (state.active?.type === 'group' && state.active.id === groupId) location.hash = '#/chats';
    toast('You left the group');
  } catch {
    toast('Couldn’t leave the group.', { type: 'error' });
  }
}

/** Small text prompt in a sheet. Resolves to the trimmed value or null. */
export function promptText({ title, label, value = '', maxLength = 120, type = 'text', multiline = false, placeholder = '' }) {
  return new Promise(resolve => {
    const field = multiline
      ? html`<textarea class="input" maxlength="${maxLength}" placeholder="${placeholder}">${value}</textarea>`
      : html`<input class="input" type="${type}" maxlength="${maxLength}" value="${value}" placeholder="${placeholder}">`;
    const content = el(html`
      <form class="form-stack">
        <label class="field"><span>${label}</span>${field}</label>
        <div class="form-actions">
          <button type="button" class="btn outline" data-cancel>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`);
    let done = false;
    const sheet = openSheet({ title, content, className: 'compact', onClose: () => !done && resolve(null) });
    const input = content.querySelector('.input');
    input.focus();
    input.select?.();
    content.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
    content.addEventListener('submit', e => {
      e.preventDefault();
      done = true;
      resolve(input.value.trim());
      sheet.close();
    });
  });
}
