// Company workspaces: first-run setup (create or join), invite links,
// members and roles, places (geofences), switching company.
import { html, raw, el, escapeHtml, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { state, emit } from './state.js';
import {
  createOrg, joinOrg, loadOrgs, loadOrgMembers, setMemberRole, removeMember, newInviteCode, renameOrg,
  setActiveOrg, isAdmin, isStaff, loadPlaces, addPlace, deletePlace, loadUsers, loadChatList
} from './data.js';
import { avatarHtml, openSheet, confirmDialog, emptyState } from './ui.js';
import { restartTeamChannel } from './realtime.js';

export const INVITE_KEY = 'wazambi-invite';
const ROLE_TEXT = {
  owner: 'Owner',
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  driver: 'Driver'
};
const ROLE_HELP = {
  admin: 'Everything a dispatcher can do, plus inviting people and changing roles',
  dispatcher: 'Creates jobs, sees every job and the team map',
  driver: 'Sees only their own jobs'
};

export const inviteUrl = (code = state.org?.invite_code) => `${location.origin}/join/${code}`;

export function pendingInvite() {
  try {
    return localStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}
function clearInvite() {
  try { localStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}

/** After joining or switching: reload everyone and everything company-scoped. */
async function afterOrgChange() {
  await Promise.all([loadUsers(), loadChatList(), loadOrgMembers()]).catch(() => {});
  restartTeamChannel();
  emit('org');
}

// ---------------------------------------------------------------------------
// First run: no company yet
// ---------------------------------------------------------------------------
/** Resolves once the person belongs to a company. */
export function showOnboarding() {
  return new Promise(resolve => {
    const code = pendingInvite() || '';
    const first = (state.me?.name || '').split(' ')[0];
    const root = el(html`
      <div class="onboard" role="dialog" aria-modal="true" aria-labelledby="onboardTitle">
        <div class="onboard-card">
          <div class="boot-mark" aria-hidden="true">WAZAMBI</div>
          <h1 id="onboardTitle">Welcome${first ? `, ${first}` : ''}</h1>
          <p class="onboard-sub">WAZAMBI works inside a company workspace. Your team, chats, jobs and map are shared only with people in it.</p>

          <form class="onboard-option" data-form="join">
            <h2>${raw(icon('users', 'sm'))} Join your team</h2>
            <p class="hint">Enter the invite code your dispatcher or manager sent you.</p>
            <div class="onboard-row">
              <input class="input code" name="code" required maxlength="20" autocomplete="off" autocapitalize="characters" placeholder="e.g. 3FA9C21B0E" value="${code}" aria-label="Invite code">
              <button type="submit" class="btn primary">Join</button>
            </div>
          </form>

          <div class="divider"><span>or</span></div>

          <form class="onboard-option" data-form="create">
            <h2>${raw(icon('building', 'sm'))} Set up your company</h2>
            <p class="hint">You’ll be the owner. Invite drivers and dispatchers with a link afterwards.</p>
            <div class="onboard-row">
              <input class="input" name="name" required maxlength="80" placeholder="Company name" aria-label="Company name">
              <button type="submit" class="btn outline">Create</button>
            </div>
          </form>
          <p class="error-text" role="alert" hidden></p>
          <button type="button" class="link-btn" data-signout>Sign out</button>
        </div>
      </div>`);
    document.body.appendChild(root);
    const err = root.querySelector('.error-text');
    const fail = msg => {
      err.textContent = msg;
      err.hidden = false;
    };
    const finish = async () => {
      clearInvite();
      root.remove();
      await afterOrgChange();
      resolve();
    };
    root.querySelector('[data-form="join"]').addEventListener('submit', async e => {
      e.preventDefault();
      const value = e.target.code.value.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
      if (value.length < 6) return fail('Invite codes are 10 letters and numbers. Check the message you were sent.');
      e.submitter && (e.submitter.disabled = true);
      try {
        await joinOrg(value);
        toast(`You joined ${state.org?.name || 'the team'}`);
        await finish();
      } catch (ex) {
        fail(/invalid invite/i.test(String(ex?.message)) ? 'That code didn’t work. Ask for a new invite link.' : 'Couldn’t join. Check your connection.');
      } finally {
        e.submitter && (e.submitter.disabled = false);
      }
    });
    root.querySelector('[data-form="create"]').addEventListener('submit', async e => {
      e.preventDefault();
      const name = e.target.name.value.trim().replace(/\s+/g, ' ');
      if (name.length < 2) return fail('Enter your company’s name.');
      e.submitter && (e.submitter.disabled = true);
      try {
        await createOrg(name);
        toast(`${name} is ready. Invite your team from Settings.`);
        await finish();
      } catch {
        fail('Couldn’t create the company. Check your connection.');
      } finally {
        e.submitter && (e.submitter.disabled = false);
      }
    });
    root.querySelector('[data-signout]').addEventListener('click', async () => {
      const { signOut } = await import('./settings.js');
      signOut();
    });
    (code ? root.querySelector('[name="code"]') : root.querySelector('[name="name"]')).focus();
  });
}

/** Opening an invite link while already signed in. */
export async function handleInviteLink(code) {
  history.replaceState(history.state, '', '#/chats');
  if (state.orgs.some(o => o.invite_code === code)) {
    toast(`You’re already in ${state.orgs.find(o => o.invite_code === code).name}.`);
    return;
  }
  const ok = await confirmDialog({
    title: 'Join a company?',
    message: 'You were invited to join a team on WAZAMBI. You’ll see its people, chats and jobs. You can leave at any time from Settings.',
    confirm: 'Join'
  });
  if (!ok) return;
  try {
    await joinOrg(code);
    clearInvite();
    toast(`You joined ${state.org?.name}`);
    await afterOrgChange();
  } catch {
    toast('That invite link didn’t work. Ask for a new one.', { type: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Settings: company section
// ---------------------------------------------------------------------------
export function companySettingsHtml() {
  if (!state.org) return '';
  const admin = isAdmin();
  return html`
    <section class="settings-group">
      <h2>Company</h2>
      <div class="settings-card">
        <div class="setting">
          ${raw(icon('building'))}
          <span class="setting-text">${state.org.name}<small>You’re ${ROLE_TEXT[state.role]?.toLowerCase() === 'owner' ? 'the owner' : `a ${ROLE_TEXT[state.role]?.toLowerCase()}`}${state.orgs.length > 1 ? ` · ${state.orgs.length} companies` : ''}</small></span>
          ${admin ? raw(`<button type="button" class="btn small outline" data-org="rename">Rename</button>`) : ''}
        </div>
        ${admin ? raw(`<button type="button" class="setting" data-org="invite">${icon('userPlus')}<span class="setting-text">Invite people<small>Share a link; new people join as drivers</small></span></button>`) : ''}
        <button type="button" class="setting" data-org="members">${raw(icon('users'))}<span class="setting-text">People and roles</span></button>
        ${isStaff() ? raw(`<button type="button" class="setting" data-org="places">${icon('pin')}<span class="setting-text">Places<small>Depots, borders and sites that update jobs automatically</small></span></button>`) : ''}
        ${state.orgs.length > 1 ? raw(`<button type="button" class="setting" data-org="switch">${icon('refresh')}<span class="setting-text">Switch company</span></button>`) : ''}
        <button type="button" class="setting" data-org="another">${raw(icon('plus'))}<span class="setting-text">Join or create another company</span></button>
      </div>
    </section>`.value;
}

export async function onCompanySettingsClick(act) {
  if (act === 'rename') {
    const { promptText } = await import('./groups.js');
    const name = await promptText({ title: 'Company name', label: 'Name', value: state.org.name, maxLength: 80 });
    if (name && name !== state.org.name) {
      try {
        await renameOrg(name);
        toast('Company renamed');
      } catch {
        toast('Couldn’t rename.', { type: 'error' });
      }
    }
  } else if (act === 'invite') openInvite();
  else if (act === 'members') openMembers();
  else if (act === 'places') openPlaces();
  else if (act === 'switch') openSwitch();
  else if (act === 'another') openAnother();
}

function openInvite() {
  const content = el('<div></div>');
  const draw = () => {
    const url = inviteUrl();
    const text = encodeURIComponent(`Join ${state.org.name} on WAZAMBI: ${url}`);
    content.innerHTML = html`
      <div class="form-stack">
        <p>Anyone with this link can join <b>${state.org.name}</b> as a driver. You can change their role afterwards.</p>
        <div class="link-box"><input class="input" readonly value="${url}" aria-label="Invite link"></div>
        <p class="hint">Invite code: <b class="code-text">${state.org.invite_code}</b></p>
        <div class="job-actions">
          <button type="button" class="btn small primary" data-inv="copy">${raw(icon('copy', 'sm'))}Copy link</button>
          <a class="btn small outline" href="https://wa.me/?text=${text}" target="_blank" rel="noopener">${raw(icon('chat', 'sm'))}Send on WhatsApp</a>
          ${navigator.share ? raw(`<button type="button" class="btn small outline" data-inv="share">${icon('share', 'sm')}Share</button>`) : ''}
        </div>
        <hr class="rule">
        <button type="button" class="link-btn" data-inv="reset">Make a new link (the old one stops working)</button>
      </div>`.value;
  };
  draw();
  openSheet({ title: 'Invite people', content });
  content.addEventListener('click', async e => {
    const act = e.target.closest('[data-inv]')?.dataset.inv;
    if (act === 'copy') navigator.clipboard?.writeText(inviteUrl()).then(() => toast('Invite link copied'));
    if (act === 'share') navigator.share?.({ title: `Join ${state.org.name}`, url: inviteUrl() }).catch(() => {});
    if (act === 'reset') {
      if (!(await confirmDialog({ title: 'Make a new invite link?', message: 'People who haven’t used the old link yet will need the new one.', confirm: 'Make new link' }))) return;
      try {
        await newInviteCode();
        draw();
        toast('New invite link ready');
      } catch {
        toast('Couldn’t change the link.', { type: 'error' });
      }
    }
  });
}

async function openMembers() {
  const content = el('<div class="empty"><span class="spinner"></span></div>');
  const sheet = openSheet({ title: 'People and roles', content, wide: true });
  const admin = isAdmin();
  const draw = rows => {
    const order = { owner: 0, admin: 1, dispatcher: 2, driver: 3 };
    rows.sort((a, b) => order[a.role] - order[b.role] || (state.users.get(a.user_id)?.name || '').localeCompare(state.users.get(b.user_id)?.name || ''));
    const body = el(`<div>
      <p class="hint">${rows.length} ${rows.length === 1 ? 'person' : 'people'} in ${escapeHtml(state.org.name)}.</p>
      <div class="list" role="list">${rows.map(m => {
        const u = state.users.get(m.user_id) || { id: m.user_id, name: 'Unknown' };
        const self = m.user_id === state.me.id;
        const canEdit = admin && !self && m.role !== 'owner';
        const roleControl = canEdit
          ? `<select class="input role-select" data-role-for="${escapeHtml(m.user_id)}" aria-label="Role of ${escapeHtml(u.name)}">
              ${['admin', 'dispatcher', 'driver'].filter(r => r !== 'admin' || state.role === 'owner' || m.role === 'admin').map(r => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_TEXT[r]}</option>`).join('')}
            </select>`
          : `<span class="pill tone-quiet">${ROLE_TEXT[m.role]}</span>`;
        return `<div class="row" role="listitem">
          ${avatarHtml(u, { size: 42, presence: true }).value}
          <span class="row-main"><span class="row-name">${escapeHtml(self ? `${u.name} (you)` : u.name)}</span><span class="row-sub">${escapeHtml(u.email || '')}</span></span>
          ${roleControl}
          ${canEdit ? `<button type="button" class="icon-btn" data-remove="${escapeHtml(m.user_id)}" aria-label="Remove ${escapeHtml(u.name)}">${icon('x', 'sm')}</button>` : ''}
        </div>`;
      }).join('')}</div>
      <dl class="profile-details role-help">${['admin', 'dispatcher', 'driver'].map(r => `<div class="detail"><dt>${ROLE_TEXT[r]}</dt><dd>${ROLE_HELP[r]}</dd></div>`).join('')}</dl>
      ${state.role !== 'owner' ? '<div class="form-actions"><button type="button" class="btn small danger" data-leave>Leave this company</button></div>' : ''}
    </div>`);
    sheet.body.innerHTML = '';
    sheet.body.appendChild(body);
    body.addEventListener('change', async e => {
      const sel = e.target.closest('[data-role-for]');
      if (!sel) return;
      try {
        await setMemberRole(sel.dataset.roleFor, sel.value);
        toast(`Role changed to ${ROLE_TEXT[sel.value]}`);
      } catch (ex) {
        toast(String(ex?.message || 'Couldn’t change the role.'), { type: 'error' });
        reload();
      }
    });
    body.addEventListener('click', async e => {
      const rm = e.target.closest('[data-remove]')?.dataset.remove;
      if (rm) {
        const u = state.users.get(rm);
        if (!(await confirmDialog({ title: `Remove ${u?.name || 'this person'}?`, message: 'They lose access to this company’s people, jobs and map. Their past messages stay.', confirm: 'Remove', danger: true }))) return;
        try {
          await removeMember(rm);
          toast('Removed');
          reload();
        } catch {
          toast('Couldn’t remove them.', { type: 'error' });
        }
      }
      if (e.target.closest('[data-leave]')) {
        if (!(await confirmDialog({ title: `Leave ${state.org.name}?`, message: 'You’ll lose access to its people, chats and jobs until someone invites you again.', confirm: 'Leave', danger: true }))) return;
        try {
          await removeMember(state.me.id);
          await sheet.close();
          location.reload();
        } catch {
          toast('Couldn’t leave.', { type: 'error' });
        }
      }
    });
  };
  const reload = () => loadOrgMembers().then(draw).catch(() => {
    content.outerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load people' }).value;
  });
  reload();
}

async function openPlaces() {
  const content = el('<div class="empty"><span class="spinner"></span></div>');
  const sheet = openSheet({ title: 'Places', content, wide: true });
  const KIND = { depot: 'Depot or yard', border: 'Border post', customer: 'Customer site', site: 'Mine or work site', other: 'Other' };
  const draw = rows => {
    const body = el(`<div class="form-stack">
      <p class="hint">When a driver on a job reaches one of these places, the job’s timeline records it automatically. Reaching a border sets the job to “At border”; leaving sets it back to “In transit”.</p>
      <div class="list" role="list">${rows.length ? rows.map(p => `
        <div class="row" role="listitem">
          <span class="job-icon tone-${p.kind === 'border' ? 'alert' : 'quiet'}">${icon(p.kind === 'border' ? 'flag' : 'pin')}</span>
          <span class="row-main"><span class="row-name">${escapeHtml(p.name)}</span><span class="row-sub">${escapeHtml(KIND[p.kind] || p.kind)} · ${p.radius_m} m radius</span></span>
          <button type="button" class="icon-btn" data-del="${escapeHtml(p.id)}" aria-label="Delete ${escapeHtml(p.name)}">${icon('trash', 'sm')}</button>
        </div>`).join('') : emptyState({ iconName: 'pin', title: 'No places yet', text: 'Add your depot and the borders your trucks cross, e.g. Kasumbalesa or Chirundu.' }).value}</div>
      <form class="place-form form-stack">
        <h3>Add a place</h3>
        <div class="two-col">
          <label class="field"><span>Name</span><input class="input" name="name" required maxlength="80" placeholder="e.g. Kasumbalesa border"></label>
          <label class="field"><span>Type</span><select class="input" name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Radius</span><select class="input" name="radius">
          <option value="200">200 m (a building or yard)</option>
          <option value="500" selected>500 m (a depot or site)</option>
          <option value="1500">1.5 km (a border post and its queue)</option>
          <option value="5000">5 km (a whole town)</option>
        </select></label>
        <div class="loc-row"><button type="button" class="btn outline" data-pick>${icon('map', 'sm')}Choose on map</button><span class="hint" data-picked>No location chosen</span></div>
        <p class="error-text" hidden></p>
        <div class="form-actions"><button type="submit" class="btn primary">Add place</button></div>
      </form>
    </div>`);
    sheet.body.innerHTML = '';
    sheet.body.appendChild(body);
    let point = null;
    body.querySelector('[data-pick]').addEventListener('click', async () => {
      const { pickOnMap } = await import('./jobs.js');
      const p = await pickOnMap(point, 'Place location');
      if (p) {
        point = p;
        body.querySelector('[data-picked]').textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      }
    });
    body.addEventListener('click', async e => {
      const id = e.target.closest('[data-del]')?.dataset.del;
      if (!id) return;
      try {
        await deletePlace(id);
        reload();
      } catch {
        toast('Couldn’t delete.', { type: 'error' });
      }
    });
    body.querySelector('.place-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const err = f.querySelector('.error-text');
      if (!f.name.value.trim()) { err.textContent = 'Give the place a name.'; err.hidden = false; return; }
      if (!point) { err.textContent = 'Choose where it is on the map.'; err.hidden = false; return; }
      try {
        await addPlace({ name: f.name.value.trim(), kind: f.kind.value, radius_m: Number(f.radius.value), lat: point.lat, lng: point.lng });
        toast('Place added');
        reload();
      } catch {
        err.textContent = 'Couldn’t add the place.';
        err.hidden = false;
      }
    });
  };
  const reload = () => loadPlaces().then(draw).catch(() => {
    sheet.body.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load places' }).value;
  });
  reload();
}

function openSwitch() {
  const content = el(`<div class="list" role="list">${state.orgs.map(o => `
    <button type="button" class="row" data-org-id="${escapeHtml(o.id)}" ${o.id === state.org.id ? 'aria-current="true"' : ''}>
      <span class="job-icon tone-quiet">${icon('building')}</span>
      <span class="row-main"><span class="row-name">${escapeHtml(o.name)}</span><span class="row-sub">${ROLE_TEXT[o.role]}</span></span>
    </button>`).join('')}</div>`);
  const sheet = openSheet({ title: 'Switch company', content });
  content.addEventListener('click', async e => {
    const id = e.target.closest('[data-org-id]')?.dataset.orgId;
    if (!id || id === state.org.id) return;
    setActiveOrg(state.orgs.find(o => o.id === id), { silent: true });
    await sheet.close();
    await afterOrgChange();
    toast(`Switched to ${state.org.name}`);
  });
}

function openAnother() {
  const form = el(`<form class="form-stack">
    <label class="field"><span>Invite code</span><input class="input code" name="code" maxlength="20" placeholder="To join a team"></label>
    <div class="divider"><span>or</span></div>
    <label class="field"><span>New company name</span><input class="input" name="name" maxlength="80" placeholder="To start your own"></label>
    <p class="error-text" hidden></p>
    <div class="form-actions"><button type="submit" class="btn primary">Continue</button></div>
  </form>`);
  const sheet = openSheet({ title: 'Another company', content: form });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const code = form.code.value.trim().toUpperCase();
    const name = form.name.value.trim();
    const err = form.querySelector('.error-text');
    try {
      if (code) await joinOrg(code);
      else if (name.length >= 2) await createOrg(name);
      else {
        err.textContent = 'Enter an invite code or a company name.';
        err.hidden = false;
        return;
      }
      await sheet.close();
      await afterOrgChange();
      toast(`You’re now in ${state.org.name}`);
    } catch {
      err.textContent = code ? 'That invite code didn’t work.' : 'Couldn’t create the company.';
      err.hidden = false;
    }
  });
}

export { loadOrgs };
