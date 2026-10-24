// Someone's profile: who they are, how to reach them, follow/unfollow.
import { html, raw, el, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { lastSeen } from '../lib/format.js';
import { state } from './state.js';
import { avatarHtml, openSheet } from './ui.js';
import { loadProfileDetails, setFollowing } from './data.js';
import { startCall } from './calls.js';

export async function openProfile(userId) {
  const user = state.users.get(userId);
  if (!user) return;
  const self = userId === state.me.id;
  const content = el('<div></div>');
  const sheet = openSheet({ title: self ? 'Your profile' : 'Profile', content });
  let details = null;

  const draw = () => {
    const online = state.online.has(userId);
    const p = details?.profile || {};
    const rows = [
      p.job_title || p.company ? ['Work', [p.job_title, p.company].filter(Boolean).join(' at ')] : null,
      p.bio ? ['About', p.bio] : null,
      p.location ? ['Based in', p.location] : null,
      user.email ? ['Email', user.email] : null
    ].filter(Boolean);
    const website = p.website && /^https?:\/\//i.test(p.website) ? p.website : null;

    content.innerHTML = html`
      <div class="profile">
        ${avatarHtml(user, { size: 112, presence: true })}
        <h3>${user.name}${user.verified ? raw(` <span class="verified" title="Verified">${icon('check', 'sm')}</span>`) : ''}</h3>
        <p class="status-line${online ? ' online' : ''}">${online ? 'Online' : lastSeen(user.lastonline)}</p>
        ${self ? raw('') : html`
          <div class="profile-actions">
            <button type="button" class="profile-action" data-p="message">${raw(icon('chat'))}<span>Message</span></button>
            <button type="button" class="profile-action" data-p="audio">${raw(icon('phone'))}<span>Voice</span></button>
            <button type="button" class="profile-action" data-p="video">${raw(icon('video'))}<span>Video</span></button>
          </div>`}
        ${details ? html`
          <div class="profile-stats">
            <div><b>${details.followers}</b><span>Followers</span></div>
            <div><b>${details.following}</b><span>Following</span></div>
          </div>
          ${self
            ? raw('<a class="btn outline small" href="#/settings" data-p="edit">Edit profile</a>')
            : html`<button type="button" class="btn small ${details.isFollowing ? 'outline' : 'primary'}" data-p="follow">${details.isFollowing ? 'Following' : 'Follow'}</button>`}
          <dl class="profile-details">
            ${raw(rows.map(([k, v]) => html`<div class="detail"><dt>${k}</dt><dd>${v}</dd></div>`.value).join(''))}
            ${website ? html`<div class="detail"><dt>Website</dt><dd><a href="${website}" target="_blank" rel="noopener noreferrer nofollow">${website.replace(/^https?:\/\//, '')}</a></dd></div>` : ''}
          </dl>` : raw('<div class="empty"><span class="spinner"></span></div>')}
      </div>`.value;
  };

  draw();
  try {
    details = await loadProfileDetails(userId);
  } catch {
    details = { profile: {}, followers: 0, following: 0, isFollowing: false };
  }
  draw();

  content.addEventListener('click', async e => {
    const act = e.target.closest('[data-p]')?.dataset.p;
    if (!act) return;
    if (act === 'message') {
      await sheet.close();
      location.hash = `#/chat/u/${userId}`;
    } else if (act === 'audio' || act === 'video') {
      sheet.close();
      startCall(userId, act);
    } else if (act === 'edit') {
      e.preventDefault();
      await sheet.close();
      location.hash = '#/settings';
    } else if (act === 'follow') {
      const next = !details.isFollowing;
      details.isFollowing = next;
      details.followers += next ? 1 : -1;
      draw();
      try {
        await setFollowing(userId, next);
      } catch {
        details.isFollowing = !next;
        details.followers += next ? -1 : 1;
        draw();
        toast('Couldn’t update follow. Try again.', { type: 'error' });
      }
    }
  });
}
