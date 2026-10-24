// Settings: your profile and photo, appearance, notifications, privacy and
// account security. Replaces the old accounts.html and secure.html pages.
import { sb, config } from '../lib/supabase.js';
import { html, raw, el, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fullDate, relative } from '../lib/format.js';
import { state, on, settings, saveSetting, applyTheme } from './state.js';
import { avatarHtml, openSheet, confirmDialog } from './ui.js';
import { updateMe, uploadAvatar, loadProfileDetails, saveMyProfile, loadSessions } from './data.js';
import { requestNotificationPermission, notificationPermission, notificationsSupported } from './notify.js';
import { setLocationSharing } from './map.js';
import { compressImage } from './media.js';

const body = document.getElementById('settingsBody');

export function initSettings() {
  on('me', render);
  on('settings', render);
  on('route', r => {
    if (r.tab === 'settings') {
      render();
      if (r.sub === 'password') openChangePassword({ recovery: true });
    }
  });
  body.addEventListener('click', onClick);
  body.addEventListener('change', onChange);
  render();
}

function switchHtml(name, checked, label) {
  return html`<span class="switch"><input type="checkbox" role="switch" data-setting="${name}" ${raw(checked ? 'checked' : '')} aria-label="${label}"><span></span></span>`;
}

function render() {
  if (!state.me) return;
  const me = state.me;
  const perm = notificationPermission();
  const notifOn = settings.desktopNotifications && perm === 'granted';
  body.innerHTML = html`
    <div class="settings-me">
      <button type="button" class="avatar-edit" data-s="photo" aria-label="Change your photo">
        ${avatarHtml(me, { size: 72 })}
        <span class="edit-badge">${raw(icon('edit'))}</span>
      </button>
      <span class="who"><b>${me.name}</b><span>${me.email}</span></span>
    </div>
    <input type="file" accept="image/*" hidden data-photo-input>

    <section class="settings-group">
      <h2>Profile</h2>
      <div class="settings-card">
        <button type="button" class="setting" data-s="profile">${raw(icon('edit'))}<span class="setting-text">Edit profile<small>Name, about, work and location</small></span></button>
        <button type="button" class="setting" data-s="view-profile">${raw(icon('info'))}<span class="setting-text">See how others see you</span></button>
      </div>
    </section>

    <section class="settings-group">
      <h2>Appearance</h2>
      <div class="settings-card">
        <div class="setting">
          ${raw(icon('moon'))}
          <span class="setting-text">Theme</span>
          <span class="segmented" role="group" aria-label="Theme">
            ${raw(['system', 'light', 'dark'].map(t => `<button type="button" data-theme-choice="${t}" aria-pressed="${settings.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join(''))}
          </span>
        </div>
        <label class="setting">
          ${raw(icon('send'))}
          <span class="setting-text">Enter sends messages<small>Use Shift+Enter for a new line</small></span>
          ${switchHtml('enterToSend', settings.enterToSend, 'Enter sends messages')}
        </label>
      </div>
    </section>

    <section class="settings-group">
      <h2>Notifications</h2>
      <div class="settings-card">
        <label class="setting">
          ${raw(icon('bell'))}
          <span class="setting-text">Message and call alerts<small>${!notificationsSupported() ? 'Not supported in this browser' : perm === 'denied' ? 'Blocked. Allow notifications for this site in your browser settings.' : 'Shown when WAZAMBI is in the background'}</small></span>
          ${switchHtml('desktopNotifications', notifOn, 'Message and call alerts')}
        </label>
        <label class="setting">
          ${raw(icon('mic'))}
          <span class="setting-text">Sounds<small>Play a sound for new messages</small></span>
          ${switchHtml('sound', settings.sound, 'Sounds')}
        </label>
      </div>
    </section>

    <section class="settings-group">
      <h2>Privacy</h2>
      <div class="settings-card">
        <label class="setting">
          ${raw(icon('pin'))}
          <span class="setting-text">Share my location with the team<small>Only while WAZAMBI is open. Turn off any time.</small></span>
          ${switchHtml('shareLocation', settings.shareLocation, 'Share my location')}
        </label>
      </div>
    </section>

    <section class="settings-group">
      <h2>Account and security</h2>
      <div class="settings-card">
        <button type="button" class="setting" data-s="password">${raw(icon('lock'))}<span class="setting-text">Change password</span></button>
        <button type="button" class="setting" data-s="sessions">${raw(icon('clock'))}<span class="setting-text">Recent sign-ins</span></button>
        <button type="button" class="setting" data-s="signout-others">${raw(icon('logout'))}<span class="setting-text">Sign out of other devices<small>Keeps you signed in here</small></span></button>
        <button type="button" class="setting danger" data-s="signout">${raw(icon('logout'))}<span class="setting-text">Sign out</span></button>
      </div>
    </section>
    <p class="hint" style="text-align:center;margin-top:var(--space-5)">WAZAMBI · version ${config.version}</p>`.value;
}

async function onChange(e) {
  const input = e.target;
  if (input.matches('[data-photo-input]')) {
    const file = input.files?.[0];
    input.value = '';
    if (file) changePhoto(file);
    return;
  }
  const key = input.dataset.setting;
  if (!key) return;
  const on_ = input.checked;
  if (key === 'desktopNotifications' && on_) {
    const perm = await requestNotificationPermission();
    if (perm !== 'granted') {
      toast('Notifications are blocked. Allow them in your browser’s site settings.', { type: 'error' });
      saveSetting(key, false);
      return;
    }
  }
  if (key === 'shareLocation') {
    const ok = await setLocationSharing(on_);
    if (!ok) {
      render();
      return;
    }
  }
  saveSetting(key, on_);
}

async function onClick(e) {
  const theme = e.target.closest('[data-theme-choice]');
  if (theme) {
    saveSetting('theme', theme.dataset.themeChoice);
    applyTheme();
    return;
  }
  const act = e.target.closest('[data-s]')?.dataset.s;
  if (!act) return;
  if (act === 'photo') body.querySelector('[data-photo-input]').click();
  else if (act === 'profile') openEditProfile();
  else if (act === 'view-profile') {
    const { openProfile } = await import('./profile.js');
    openProfile(state.me.id);
  } else if (act === 'password') openChangePassword();
  else if (act === 'sessions') openSessions();
  else if (act === 'signout-others') {
    if (!(await confirmDialog({ title: 'Sign out of other devices?', message: 'Every other phone or computer signed in to your account will be signed out. You stay signed in here.', confirm: 'Sign out others' }))) return;
    const { error } = await sb.auth.signOut({ scope: 'others' });
    toast(error ? 'Couldn’t sign out other devices.' : 'Other devices signed out', { type: error ? 'error' : 'info' });
  } else if (act === 'signout') {
    if (!(await confirmDialog({ title: 'Sign out?', message: 'You’ll need to sign in again to see your chats on this device.', confirm: 'Sign out', danger: true }))) return;
    await signOut();
  }
}

export async function signOut() {
  try {
    await sb.from('users').update({ status: 'offline', lastonline: new Date().toISOString() }).eq('id', state.me.id);
  } catch {
    /* ignore */
  }
  await sb.auth.signOut({ scope: 'local' });
  try {
    Object.keys(localStorage).filter(k => k.startsWith('wazambi-cache') || k.startsWith('wazambi-draft') || k === 'wazambi-outbox')
      .forEach(k => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  location.replace('/?signedout=1');
}

async function changePhoto(file) {
  if (!file.type.startsWith('image/')) {
    toast('Choose an image file.', { type: 'error' });
    return;
  }
  const t = toast('Updating your photo…', { duration: 15000 });
  try {
    const small = await compressImage(file, { maxSide: 512, quality: 0.85 });
    const url = await uploadAvatar(small);
    await updateMe({ avatar_url: url });
    t.remove();
    toast('Photo updated');
  } catch {
    t.remove();
    toast('Couldn’t update your photo. Try a smaller image.', { type: 'error' });
  }
}

async function openEditProfile() {
  const content = el('<div class="empty"><span class="spinner"></span></div>');
  const sheet = openSheet({ title: 'Edit profile', content, wide: true });
  let profile = {};
  try {
    profile = (await loadProfileDetails(state.me.id)).profile || {};
  } catch {
    /* start blank */
  }
  const form = el(html`
    <form class="form-stack">
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="60" required value="${state.me.name}" autocomplete="name"></label>
      <label class="field"><span>About</span><textarea class="input" name="bio" maxlength="300" placeholder="A line about you or your role">${profile.bio || ''}</textarea></label>
      <label class="field"><span>Job title</span><input class="input" name="job_title" maxlength="80" value="${profile.job_title || ''}" placeholder="e.g. Fleet supervisor"></label>
      <label class="field"><span>Company</span><input class="input" name="company" maxlength="80" value="${profile.company || ''}"></label>
      <label class="field"><span>Location</span><input class="input" name="location" maxlength="80" value="${profile.location || ''}" placeholder="e.g. Lusaka"></label>
      <label class="field"><span>Website</span><input class="input" name="website" type="url" maxlength="200" value="${profile.website || ''}" placeholder="https://"></label>
      <p class="error-text" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn outline" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save changes</button>
      </div>
    </form>`);
  content.replaceWith(form);
  sheet.body.innerHTML = '';
  sheet.body.appendChild(form);
  form.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const err = form.querySelector('.error-text');
    const name = String(data.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2) {
      err.textContent = 'Your name needs at least 2 characters.';
      err.hidden = false;
      return;
    }
    let website = String(data.website || '').trim();
    if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await Promise.all([
        name !== state.me.name ? updateMe({ name }) : null,
        saveMyProfile({
          bio: String(data.bio || '').trim() || null,
          job_title: String(data.job_title || '').trim() || null,
          company: String(data.company || '').trim() || null,
          location: String(data.location || '').trim() || null,
          website: website || null
        })
      ]);
      sheet.close();
      toast('Profile saved');
    } catch {
      err.textContent = 'Couldn’t save your profile. Check your connection.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

export function openChangePassword({ recovery = false } = {}) {
  const form = el(html`
    <form class="form-stack">
      ${recovery ? html`<p class="hint">Choose a new password for ${state.me?.email || 'your account'}.</p>` : ''}
      <label class="field"><span>New password</span><input class="input" name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <label class="field"><span>Confirm new password</span><input class="input" name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
      <p class="error-text" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn outline" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Update password</button>
      </div>
    </form>`);
  const sheet = openSheet({ title: recovery ? 'Set a new password' : 'Change password', content: form });
  form.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const pw = form.password.value;
    const err = form.querySelector('.error-text');
    err.hidden = true;
    if (pw.length < 8) {
      err.textContent = 'Use at least 8 characters.';
      err.hidden = false;
      return;
    }
    if (pw !== form.confirm.value) {
      err.textContent = 'The two passwords don’t match.';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw });
    btn.disabled = false;
    if (error) {
      err.textContent = /reauthentication|recent/i.test(error.message)
        ? 'For your security, sign out and sign in again, then change your password.'
        : /should be|weak|pwned/i.test(error.message)
          ? 'Choose a stronger password that you haven’t used on other sites.'
          : error.message;
      err.hidden = false;
      return;
    }
    sb.from('users').update({ last_password_change: new Date().toISOString() }).eq('id', state.me.id).then(() => {});
    sb.from('security_logs').insert({ user_id: state.me.id, action: 'password_change', status: 'success', user_agent: navigator.userAgent.slice(0, 300) }).then(() => {});
    await sheet.close();
    if (location.hash.endsWith('/password')) history.replaceState(null, '', '#/settings');
    toast('Password updated');
  });
}

async function openSessions() {
  const content = el('<div class="empty"><span class="spinner"></span></div>');
  const sheet = openSheet({ title: 'Recent sign-ins', content });
  try {
    const rows = await loadSessions();
    const list = el(html`<div>${raw(rows.length ? rows.map(r => html`
      <div class="session-row">
        ${raw(icon(/Mobile|Android|iPhone/i.test(r.user_agent || '') ? 'phone' : 'layers'))}
        <span class="row-main">
          <span class="row-name">${describeAgent(r.user_agent)}</span>
          <span class="row-sub" title="${fullDate(r.created_at)}">${relative(r.created_at)}${r.ip_address && r.ip_address !== 'unknown' ? ` · ${r.ip_address}` : ''}</span>
        </span>
      </div>`.value).join('') : '<p class="hint">No sign-ins recorded yet.</p>')}
      <p class="hint" style="margin-top:var(--space-4)">Don’t recognise one? Change your password and sign out of other devices.</p></div>`);
    sheet.body.innerHTML = '';
    sheet.body.appendChild(list);
  } catch {
    content.outerHTML = '<p class="error-text">Couldn’t load sign-ins.</p>';
  }
}

function describeAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  return `${browser} on ${os}`;
}
