// Jobs ("Loads"): every delivery is its own thread with a status track,
// a timeline (status changes, geofence arrivals, notes, photos, customer
// messages) and a sealed proof of delivery.
import { html, raw, el, escapeHtml, toast, debounce, linkify } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { listStamp, time, fullDate, dayLabel, sameDay } from '../lib/format.js';
import { STATUS, STEPS, ACTIVE, DONE, stepIndex, statusLabel, NEXT } from '../lib/jobStatus.js';
import { state, on, settings } from './state.js';
import {
  loadJobs, loadJob, createJob, updateJob, deleteJob, loadJobEvents, addJobEvent, loadProofs, createProof,
  verifyProof, loadPlaces, loadOrgMembers, uploadMedia, signPaths, cachedMediaUrl, isStaff
} from './data.js';
import { avatarHtml, openSheet, confirmDialog, showMenu, emptyState } from './ui.js';
import { startCall } from './calls.js';
import { compressImage, openLightbox } from './media.js';
import { setLocationSharing, loadLeaflet } from './map.js';
import { playMessageSound, systemNotify } from './notify.js';

const listEl = document.getElementById('jobList');
const viewEl = document.getElementById('jobView');
const searchEl = document.getElementById('jobSearch');

const jobs = new Map(); // id -> job
let loaded = false;
let filter = 'active';
let query = '';
let openJobId = null;
let openEvents = [];
let openProofs = [];
let places = [];
let unread = loadUnread();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function initJobs() {
  document.getElementById('newJobBtn').addEventListener('click', () => openJobForm());
  searchEl.addEventListener('input', debounce(() => {
    query = searchEl.value.trim().toLowerCase();
    renderList();
  }, 80));
  document.querySelectorAll('[data-job-filter]').forEach(chip => chip.addEventListener('click', () => {
    filter = chip.dataset.jobFilter;
    document.querySelectorAll('[data-job-filter]').forEach(c => c.setAttribute('aria-selected', String(c === chip)));
    renderList();
  }));
  listEl.addEventListener('click', e => {
    if (e.target.closest('[data-act="new-job"]')) openJobForm();
  });
  viewEl.addEventListener('click', onViewClick);

  on('route', r => {
    if (r.tab === 'jobs') {
      if (!loaded) refresh();
      if (r.jobId) openJob(r.jobId);
      else closeJob();
    } else if (openJobId) {
      closeJob();
    }
  });
  on('org', () => {
    jobs.clear();
    loaded = false;
    renderChrome();
    refresh();
  });
  on('users', () => renderList());
  on('job:change', onJobChange);
  on('job:event', onJobEvent);
  on('job:proof', p => {
    if (p.job_id === openJobId) reloadOpenJob();
  });
  on('places', () => loadPlaces().then(p => { places = p; }).catch(() => {}));
  on('resync', () => loaded && refresh());
  renderChrome();
  refresh();
}

function renderChrome() {
  document.getElementById('newJobBtn').hidden = !isStaff();
  updateJobsBadge();
}

async function refresh() {
  if (!state.org) return;
  try {
    const rows = await loadJobs();
    jobs.clear();
    rows.forEach(j => jobs.set(j.id, j));
    loaded = true;
    renderList();
    updateJobsBadge();
    if (!places.length) places = await loadPlaces().catch(() => []);
    if (!state.members.size) await loadOrgMembers().catch(() => {});
  } catch (err) {
    console.warn('Jobs failed to load', err);
    if (!loaded) listEl.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load jobs', text: 'Check your connection and try again.' }).value;
  }
}

// ---------------------------------------------------------------------------
// Unread customer messages (per device)
// ---------------------------------------------------------------------------
function loadUnread() {
  try {
    return new Set(JSON.parse(localStorage.getItem('wazambi-job-unread') || '[]'));
  } catch {
    return new Set();
  }
}
function saveUnread() {
  try {
    localStorage.setItem('wazambi-job-unread', JSON.stringify([...unread]));
  } catch { /* ignore */ }
}
function updateJobsBadge() {
  const badge = document.getElementById('jobsBadge');
  if (!badge) return;
  const mine = [...jobs.values()].filter(j => j.driver_id === state.me?.id && ACTIVE.includes(j.status)).length;
  const n = isStaff() ? unread.size : mine;
  badge.hidden = !n;
  badge.textContent = String(n);
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
function onJobChange({ eventType, new: row, old }) {
  if (eventType === 'DELETE') {
    jobs.delete(old?.id);
    if (openJobId === old?.id) {
      toast('This job was deleted.');
      location.hash = '#/jobs';
    }
  } else if (row?.id) {
    if (state.org && row.org_id !== state.org.id) return;
    const before = jobs.get(row.id);
    jobs.set(row.id, { ...(before || {}), ...row });
    // a job newly given to me
    if (!before && row.driver_id === state.me.id && row.created_by !== state.me.id && document.visibilityState === 'visible') {
      playMessageSound();
      toast(`New job ${row.ref}: ${row.title}`, { action: 'Open', onAction: () => { location.hash = `#/jobs/${row.id}`; } });
    }
    if (openJobId === row.id) renderView();
  }
  renderList();
  updateJobsBadge();
}

function onJobEvent(ev) {
  if (ev.job_id === openJobId) {
    if (!openEvents.some(e => e.id === ev.id)) {
      openEvents.push(ev);
      renderTimeline(true);
    }
  }
  if (ev.kind === 'customer_message' && isStaff()) {
    const job = jobs.get(ev.job_id);
    if (ev.job_id !== openJobId || document.visibilityState !== 'visible') {
      unread.add(ev.job_id);
      saveUnread();
      updateJobsBadge();
      renderList();
    }
    if (document.visibilityState === 'visible' && ev.job_id !== openJobId) {
      playMessageSound();
      toast(`${job?.ref || 'Job'} · ${ev.meta?.name || 'Customer'}: ${ev.message}`, {
        action: 'Open',
        duration: 7000,
        onAction: () => { location.hash = `#/jobs/${ev.job_id}`; }
      });
    } else if (document.visibilityState !== 'visible') {
      systemNotify({ title: `${job?.ref || 'Job'} · ${job?.customer_name || 'Customer'}`, body: `${ev.meta?.name || 'Customer'}: ${ev.message}`, tag: `job-${ev.job_id}`, url: `/app#/jobs/${ev.job_id}` });
    }
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
function personName(id) {
  if (!id) return 'Unassigned';
  if (id === state.me.id) return 'You';
  return state.users.get(id)?.name || 'Unknown';
}

function statusPill(status, extra = '') {
  return `<span class="pill tone-${STATUS[status]?.tone || 'quiet'} ${extra}">${escapeHtml(statusLabel(status))}</span>`;
}

function routeText(j) {
  const a = j.pickup_name || 'Pickup';
  const b = j.dropoff_name || 'Drop-off';
  return j.pickup_name || j.dropoff_name ? `${a} → ${b}` : '';
}

function filtered() {
  const all = [...jobs.values()];
  return all.filter(j => {
    if (filter === 'active' && !ACTIVE.includes(j.status)) return false;
    if (filter === 'done' && !DONE.includes(j.status)) return false;
    if (filter === 'mine' && j.driver_id !== state.me.id) return false;
    if (query) {
      const hay = [j.ref, j.title, j.customer_name, j.vehicle, j.pickup_name, j.dropoff_name, personName(j.driver_id)].join(' ').toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }).sort((a, b) => {
    // active first by urgency of status, then newest
    const ua = unread.has(a.id) ? 0 : 1;
    const ub = unread.has(b.id) ? 0 : 1;
    return ua - ub || (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at);
  });
}

function renderList() {
  if (!state.org) {
    listEl.innerHTML = '';
    return;
  }
  if (!loaded) {
    listEl.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    return;
  }
  const items = filtered();
  if (!items.length) {
    const staff = isStaff();
    listEl.innerHTML = query
      ? emptyState({ iconName: 'search', title: 'No matching jobs', text: 'Search by reference, customer, vehicle or driver.' }).value
      : filter === 'active'
        ? emptyState({
            iconName: 'truck',
            title: staff ? 'No active jobs' : 'No jobs for you right now',
            text: staff ? 'Create a job for each delivery. Your driver gets it on their phone and your customer gets a tracking link.' : 'When dispatch gives you a job, it appears here.',
            action: staff ? '<button type="button" class="btn primary" data-act="new-job">New job</button>' : null
          }).value
        : emptyState({ iconName: 'package', title: 'Nothing here yet', text: 'Delivered jobs show up here.' }).value;
    return;
  }
  listEl.innerHTML = items.map(j => html`
    <a class="row job-row${unread.has(j.id) ? ' unread' : ''}" role="listitem" href="#/jobs/${j.id}" aria-current="${j.id === openJobId}">
      <span class="job-icon tone-${STATUS[j.status]?.tone || 'quiet'}">${raw(icon(j.status === 'delivered' || j.status === 'paid' ? 'check' : 'truck'))}</span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-name"><span class="job-ref">${j.ref}</span> ${j.title}</span>
          <span class="row-time">${listStamp(j.updated_at || j.created_at)}</span>
        </span>
        <span class="row-bottom">
          <span class="row-preview"><span>${routeText(j) || j.customer_name || 'No route set'}</span></span>
          ${unread.has(j.id) ? raw('<span class="badge" aria-label="New customer message">1</span>') : ''}
        </span>
        <span class="job-meta">${raw(statusPill(j.status))}<span>${personName(j.driver_id)}${j.vehicle ? ` · ${j.vehicle}` : ''}</span></span>
      </span>
    </a>`.value).join('');
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------
async function openJob(id) {
  const app = document.getElementById('app');
  if (openJobId !== id) {
    openJobId = id;
    openEvents = [];
    openProofs = [];
    viewEl.innerHTML = '<div class="empty" style="margin:auto"><span class="spinner"></span></div>';
  }
  viewEl.hidden = false;
  app.classList.add('show-main', 'in-chat');
  document.getElementById('welcome').hidden = true;
  if (unread.delete(id)) {
    saveUnread();
    updateJobsBadge();
    renderList();
  }
  renderList();
  await reloadOpenJob();
}

async function reloadOpenJob() {
  const id = openJobId;
  if (!id) return;
  try {
    const [job, events, proofs] = await Promise.all([loadJob(id), loadJobEvents(id), loadProofs(id)]);
    if (openJobId !== id) return;
    if (!job) {
      viewEl.innerHTML = emptyState({ iconName: 'alert', title: 'Job not found', text: 'It may have been deleted, or it isn’t assigned to you.' }).value;
      return;
    }
    jobs.set(job.id, job);
    openEvents = events;
    openProofs = proofs;
    const paths = [
      ...proofs.flatMap(p => [p.photo_path, p.signature_path]),
      ...events.filter(e => e.kind === 'photo').map(e => e.meta?.path)
    ].filter(Boolean);
    await signPaths(paths).catch(() => {});
    if (openJobId !== id) return;
    renderView();
  } catch (err) {
    console.warn(err);
    viewEl.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load this job', text: 'Check your connection and try again.' }).value;
  }
}

function closeJob() {
  if (!openJobId) return;
  openJobId = null;
  viewEl.hidden = true;
  viewEl.innerHTML = '';
  renderList();
}

export const isJobOpen = () => !!openJobId;

function trackUrl(job) {
  return `${location.origin}/t/${job.track_token}`;
}

function mapsLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function renderTrack(job) {
  if (job.status === 'cancelled') return `<div class="job-track cancelled">${statusPill('cancelled')}</div>`;
  const at = stepIndex(job.status);
  return `<ol class="job-track" aria-label="Progress">${STEPS.map((s, i) => {
    const state_ = i < at ? 'done' : i === at ? 'current' : 'todo';
    const label = s === 'in_transit' && job.status === 'at_border' ? 'At border' : statusLabel(s);
    return `<li class="${state_}" ${i === at ? 'aria-current="step"' : ''}><span class="dot">${i < at ? icon('check', 'xs') : ''}</span><span class="lbl">${escapeHtml(label)}</span></li>`;
  }).join('')}</ol>`;
}

function primaryAction(job) {
  const mine = job.driver_id === state.me.id;
  const staff = isStaff();
  const next = NEXT[job.status];
  if (!next || (!mine && !staff) || (next.staffOnly && !staff)) return '';
  const secondary = job.status === 'in_transit'
    ? `<button type="button" class="btn outline" data-job="status" data-to="at_border">${icon('flag', 'sm')}At a border</button>` : '';
  return `<div class="job-actions">
    <button type="button" class="btn primary" data-job="next">${icon(next.to === 'proof' ? 'pen' : next.to === 'paid' ? 'check' : 'truck', 'sm')}${escapeHtml(next.label)}</button>
    ${secondary}
  </div>`;
}

function locationNudge(job) {
  if (job.driver_id !== state.me.id || !ACTIVE.includes(job.status) || settings.shareLocation) return '';
  return `<div class="job-card nudge">
    ${icon('pin')}
    <div><b>Share your location for this job</b><p>The job updates itself when you reach the depot, borders and the drop-off. Your customer sees you on their tracking link.</p></div>
    <button type="button" class="btn small primary" data-job="share-location">Share</button>
  </div>`;
}

function infoHtml(job) {
  const driver = job.driver_id ? state.users.get(job.driver_id) : null;
  const rows = [];
  if (job.customer_name || job.customer_phone) {
    rows.push(`<div class="detail"><dt>Customer</dt><dd>${escapeHtml(job.customer_name || '')}${job.customer_phone ? ` · <a href="tel:${escapeHtml(job.customer_phone.replace(/[^\d+]/g, ''))}">${escapeHtml(job.customer_phone)}</a>` : ''}</dd></div>`);
  }
  const place = (name, lat, lng, fallback) => {
    if (!name && lat == null) return `<span class="hint">${fallback}</span>`;
    const link = lat != null ? ` <a href="${mapsLink(lat, lng)}" target="_blank" rel="noopener">Map</a>` : '';
    return `${escapeHtml(name || `${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}`)}${link}`;
  };
  rows.push(`<div class="detail"><dt>Pickup</dt><dd>${place(job.pickup_name, job.pickup_lat, job.pickup_lng, 'Not set')}</dd></div>`);
  rows.push(`<div class="detail"><dt>Drop-off</dt><dd>${place(job.dropoff_name, job.dropoff_lat, job.dropoff_lng, 'Not set')}</dd></div>`);
  if (job.cargo) rows.push(`<div class="detail"><dt>Cargo</dt><dd>${escapeHtml(job.cargo)}</dd></div>`);
  if (job.vehicle) rows.push(`<div class="detail"><dt>Vehicle</dt><dd>${escapeHtml(job.vehicle)}</dd></div>`);
  if (job.due_at) rows.push(`<div class="detail"><dt>Due</dt><dd>${escapeHtml(fullDate(job.due_at))}</dd></div>`);
  if (job.notes) rows.push(`<div class="detail"><dt>Notes</dt><dd class="pre">${escapeHtml(job.notes)}</dd></div>`);

  const driverBlock = driver
    ? `<div class="job-driver">
        ${avatarHtml(driver, { size: 40, presence: true }).value}
        <span class="row-main"><span class="row-name">${escapeHtml(driver.id === state.me.id ? 'You' : driver.name)}</span><span class="row-sub">Driver</span></span>
        ${driver.id !== state.me.id ? `
          <button type="button" class="icon-btn" data-job="call-driver" aria-label="Call ${escapeHtml(driver.name)}">${icon('phone')}</button>
          <a class="icon-btn" href="#/chat/u/${escapeHtml(driver.id)}" aria-label="Message ${escapeHtml(driver.name)}">${icon('chat')}</a>` : ''}
      </div>`
    : `<div class="job-driver"><span class="hint">No driver assigned</span>${isStaff() ? '<button type="button" class="btn small outline" data-job="edit">Assign</button>' : ''}</div>`;

  return `<section class="job-card">${driverBlock}<dl class="profile-details">${rows.join('')}</dl></section>`;
}

function trackingCard(job) {
  if (!isStaff() || job.status === 'cancelled') return '';
  const url = trackUrl(job);
  const phone = (job.customer_phone || '').replace(/[^\d]/g, '');
  const text = encodeURIComponent(`Track your delivery ${job.ref}${job.title ? ` (${job.title})` : ''}: ${url}`);
  return `<section class="job-card">
    <h3>${icon('link', 'sm')} Customer tracking link</h3>
    <p class="hint">Anyone with this link sees the delivery’s progress, the truck on a map while it’s moving, and the proof of delivery. They can message you from it.</p>
    <div class="link-box"><input class="input" readonly value="${escapeHtml(url)}" aria-label="Tracking link"></div>
    <div class="job-actions">
      <button type="button" class="btn small outline" data-job="copy-link">${icon('copy', 'sm')}Copy</button>
      <a class="btn small outline" href="https://wa.me/${phone}?text=${text}" target="_blank" rel="noopener">${icon('chat', 'sm')}Send on WhatsApp</a>
      ${navigator.share ? `<button type="button" class="btn small outline" data-job="share-link">${icon('share', 'sm')}Share</button>` : ''}
      <a class="btn small outline" href="/t/${escapeHtml(job.track_token)}" target="_blank" rel="noopener">${icon('eye', 'sm')}Preview</a>
    </div>
  </section>`;
}

function proofCard(job) {
  const p = openProofs[0];
  if (!p) return '';
  const photo = cachedMediaUrl(p.photo_path);
  const sig = cachedMediaUrl(p.signature_path);
  return `<section class="job-card proof">
    <h3>${icon('shield', 'sm')} Proof of delivery</h3>
    <div class="proof-grid">
      ${photo ? `<button type="button" class="proof-photo" data-job="photo" data-path="${escapeHtml(p.photo_path)}" aria-label="Open delivery photo"><img src="${escapeHtml(photo)}" alt="Delivery photo"></button>` : ''}
      <dl class="profile-details">
        <div class="detail"><dt>Received by</dt><dd>${escapeHtml(p.receiver_name)}</dd></div>
        <div class="detail"><dt>When</dt><dd>${escapeHtml(fullDate(p.captured_at))}</dd></div>
        ${p.lat != null ? `<div class="detail"><dt>Where</dt><dd><a href="${mapsLink(p.lat, p.lng)}" target="_blank" rel="noopener">${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}</a>${p.accuracy ? ` (±${Math.round(p.accuracy)} m)` : ''}</dd></div>` : ''}
        ${p.note ? `<div class="detail"><dt>Note</dt><dd>${escapeHtml(p.note)}</dd></div>` : ''}
        ${sig ? `<div class="detail"><dt>Signature</dt><dd><img class="sig-img" src="${escapeHtml(sig)}" alt="Signature of ${escapeHtml(p.receiver_name)}"></dd></div>` : ''}
        <div class="detail"><dt>Seal</dt><dd><span class="seal" data-proof-seal="${escapeHtml(p.id)}">Checking…</span> <code title="${escapeHtml(p.hash)}">${escapeHtml((p.hash || '').slice(0, 16))}</code></dd></div>
      </dl>
    </div>
    <div class="job-actions"><a class="btn small outline" href="/proof?job=${escapeHtml(job.id)}" target="_blank" rel="noopener">${icon('download', 'sm')}Download PDF</a></div>
  </section>`;
}

function eventIcon(e) {
  return { created: 'plus', assigned: 'users', status: 'truck', note: 'chat', photo: 'image', geofence: 'pin', proof: 'shield', customer_message: 'mail', customer_reply: 'send' }[e.kind] || 'info';
}

function eventText(e) {
  const who = e.actor_id ? personName(e.actor_id) : 'Automatic';
  switch (e.kind) {
    case 'created': return `${who} created the job`;
    case 'assigned': return `${who} assigned it to ${personName(e.meta?.driver_id)}`;
    case 'status': return `${e.meta?.auto ? 'Automatic' : who}: ${statusLabel(e.status)}${e.meta?.from ? ` (was ${statusLabel(e.meta.from)})` : ''}`;
    case 'geofence': return e.message;
    case 'proof': return `${who}: ${e.message}`;
    case 'customer_message': return `${e.meta?.name || 'Customer'} (customer)`;
    case 'customer_reply': return `${who} replied to the customer`;
    case 'photo': return `${who} added a photo`;
    case 'note': return who;
    default: return e.message || e.kind;
  }
}

function eventHtml(e) {
  const body = ['note', 'customer_message', 'customer_reply'].includes(e.kind) && e.message
    ? `<p class="ev-body">${linkify(escapeHtml(e.message))}</p>` : '';
  const photo = e.kind === 'photo' && e.meta?.path
    ? `<button type="button" class="ev-photo" data-job="photo" data-path="${escapeHtml(e.meta.path)}" aria-label="Open photo">${cachedMediaUrl(e.meta.path) ? `<img src="${escapeHtml(cachedMediaUrl(e.meta.path))}" alt="">` : '<span class="spinner"></span>'}</button>${e.message ? `<p class="ev-body">${escapeHtml(e.message)}</p>` : ''}` : '';
  return `<li class="ev kind-${escapeHtml(e.kind)}" data-ev="${e.id}">
    <span class="ev-icon">${icon(eventIcon(e), 'xs')}</span>
    <div class="ev-main">
      <div class="ev-head"><span>${escapeHtml(eventText(e))}</span><time datetime="${escapeHtml(e.created_at)}" title="${escapeHtml(fullDate(e.created_at))}">${escapeHtml(time(e.created_at))}</time></div>
      ${body}${photo}
    </div>
  </li>`;
}

function renderTimeline(scroll = false) {
  const ol = viewEl.querySelector('.timeline');
  if (!ol) return;
  let prev = null;
  ol.innerHTML = openEvents.map(e => {
    const sep = !prev || !sameDay(prev.created_at, e.created_at) ? `<li class="ev-day">${escapeHtml(dayLabel(e.created_at))}</li>` : '';
    prev = e;
    return sep + eventHtml(e);
  }).join('');
  if (scroll) {
    const body = viewEl.querySelector('.job-scroll');
    body?.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  }
}

function renderView() {
  const job = jobs.get(openJobId);
  if (!job) return;
  const staff = isStaff();
  const scroll = viewEl.querySelector('.job-scroll')?.scrollTop || 0;
  const draft = viewEl.querySelector('.job-composer textarea')?.value || '';
  viewEl.innerHTML = `
    <header class="convo-head">
      <a class="icon-btn back" href="#/jobs" aria-label="Back to jobs">${icon('back')}</a>
      <div class="convo-who-text job-title">
        <span class="convo-name">${escapeHtml(job.ref)} · ${escapeHtml(job.title)}</span>
        <span class="convo-status">${statusPill(job.status)} <span>${escapeHtml(job.customer_name || '')}</span></span>
      </div>
      ${staff ? `<button type="button" class="icon-btn" data-job="menu" aria-label="Job options">${icon('more')}</button>` : ''}
    </header>
    <div class="job-scroll">
      <div class="job-body">
        ${renderTrack(job)}
        ${primaryAction(job)}
        ${locationNudge(job)}
        ${proofCard(job)}
        ${infoHtml(job)}
        ${trackingCard(job)}
        <section class="job-card">
          <h3>${icon('clock', 'sm')} Timeline</h3>
          <ol class="timeline"></ol>
        </section>
      </div>
    </div>
    <footer class="composer job-composer">
      ${staff ? `<label class="to-customer"><input type="checkbox" data-job="to-customer"> Send to customer</label>` : ''}
      <div class="composer-row">
        <button type="button" class="icon-btn" data-job="add-photo" aria-label="Add a photo">${icon('camera')}</button>
        <textarea class="composer-input" rows="1" placeholder="Add a note to this job" aria-label="Note" maxlength="2000"></textarea>
        <button type="button" class="send-btn" data-job="send-note" aria-label="Add note">${icon('send')}</button>
      </div>
      <input type="file" accept="image/*" capture="environment" hidden data-job-photo>
    </footer>`;
  renderTimeline();
  const scroller = viewEl.querySelector('.job-scroll');
  scroller.scrollTop = scroll;
  const ta = viewEl.querySelector('.job-composer textarea');
  ta.value = draft;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && settings.enterToSend) {
      e.preventDefault();
      sendNote();
    }
  });
  viewEl.querySelector('[data-job-photo]').addEventListener('change', e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) addPhoto(f);
  });
  const toCustomer = viewEl.querySelector('[data-job="to-customer"]');
  toCustomer?.addEventListener('change', () => {
    ta.placeholder = toCustomer.checked ? 'Message the customer (shown on their tracking link)' : 'Add a note to this job';
  });
  // proof seal check
  const seal = viewEl.querySelector('[data-proof-seal]');
  if (seal) {
    verifyProof(seal.dataset.proofSeal).then(ok => {
      seal.textContent = ok ? 'Intact' : 'Altered';
      seal.className = `seal ${ok ? 'ok' : 'bad'}`;
    }).catch(() => { seal.textContent = 'Not checked'; });
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function onViewClick(e) {
  const t = e.target.closest('[data-job]');
  if (!t) return;
  const job = jobs.get(openJobId);
  if (!job) return;
  const act = t.dataset.job;
  if (act === 'next') {
    const next = NEXT[job.status];
    if (next.to === 'proof') openProofForm(job);
    else changeStatus(job, next.to);
  } else if (act === 'status') changeStatus(job, t.dataset.to);
  else if (act === 'share-location') setLocationSharing(true).then(ok => ok && renderView());
  else if (act === 'call-driver') startCall(job.driver_id, 'audio');
  else if (act === 'edit') openJobForm(job);
  else if (act === 'copy-link') {
    navigator.clipboard?.writeText(trackUrl(job)).then(() => toast('Tracking link copied'), () => toast('Couldn’t copy', { type: 'error' }));
  } else if (act === 'share-link') {
    navigator.share?.({ title: `Delivery ${job.ref}`, text: `Track your delivery ${job.ref}`, url: trackUrl(job) }).catch(() => {});
  } else if (act === 'photo') openLightbox({ path: t.dataset.path, name: `${job.ref}.jpg` });
  else if (act === 'send-note') sendNote();
  else if (act === 'add-photo') viewEl.querySelector('[data-job-photo]').click();
  else if (act === 'menu') openJobMenu(job, t);
}

function openJobMenu(job, anchor) {
  const items = [
    { label: 'Edit job', icon: 'edit', onSelect: () => openJobForm(job) },
    { label: 'Change status', icon: 'truck', onSelect: () => openStatusPicker(job) }
  ];
  if (ACTIVE.includes(job.status)) items.push({ label: 'Capture proof of delivery', icon: 'pen', onSelect: () => openProofForm(job) });
  if (job.status !== 'cancelled') items.push({ label: 'Cancel job', icon: 'x', danger: true, onSelect: () => cancelJob(job) });
  items.push({ label: 'Delete job', icon: 'trash', danger: true, onSelect: () => removeJob(job) });
  showMenu({ anchor, items });
}

function openStatusPicker(job) {
  const content = el(`<div class="list" role="list">${Object.keys(STATUS).map(s => `
    <button type="button" class="row" data-s="${s}" ${s === job.status ? 'aria-current="true"' : ''}>${statusPill(s)}<span class="row-main"><span class="row-sub">${escapeHtml(STATUS[s].public)} on the tracking link</span></span></button>`).join('')}</div>`);
  const sheet = openSheet({ title: `Status of ${job.ref}`, content });
  content.addEventListener('click', async e => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (!s) return;
    await sheet.close();
    if (s === 'delivered' && !openProofs.length) {
      if (!(await confirmDialog({ title: 'Mark delivered without proof?', message: 'There’s no proof of delivery yet. Capture one instead so you have a photo, signature and location if the customer disputes it.', confirm: 'Mark delivered anyway' }))) return;
    }
    changeStatus(job, s);
  });
}

async function changeStatus(job, to) {
  const before = job.status;
  if (to === before) return;
  // drivers moving off the depot: offer location sharing so geofences work
  if (job.driver_id === state.me.id && ['loading', 'in_transit'].includes(to) && !settings.shareLocation) {
    setLocationSharing(true).catch(() => {});
  }
  job.status = to;
  renderView();
  renderList();
  try {
    const saved = await updateJob(job.id, { status: to });
    jobs.set(job.id, saved);
    renderView();
    renderList();
    updateJobsBadge();
  } catch (err) {
    job.status = before;
    renderView();
    renderList();
    toast(/drivers cannot/i.test(String(err?.message)) ? 'Only dispatch can set that status.' : 'Couldn’t update the job. Check your connection.', { type: 'error' });
  }
}

async function cancelJob(job) {
  if (!(await confirmDialog({ title: `Cancel ${job.ref}?`, message: 'The driver sees it as cancelled and the tracking link stops working.', confirm: 'Cancel job', danger: true }))) return;
  changeStatus(job, 'cancelled');
}

async function removeJob(job) {
  if (!(await confirmDialog({ title: `Delete ${job.ref}?`, message: 'The job, its timeline and its proof of delivery are deleted for everyone. This can’t be undone.', confirm: 'Delete', danger: true }))) return;
  try {
    await deleteJob(job.id);
    jobs.delete(job.id);
    location.hash = '#/jobs';
    toast(`${job.ref} deleted`);
  } catch {
    toast('Couldn’t delete the job.', { type: 'error' });
  }
}

async function sendNote() {
  const job = jobs.get(openJobId);
  const ta = viewEl.querySelector('.job-composer textarea');
  const text = ta?.value.trim();
  if (!job || !text) return;
  const toCustomer = viewEl.querySelector('[data-job="to-customer"]')?.checked;
  ta.value = '';
  ta.style.height = 'auto';
  try {
    const ev = await addJobEvent(job.id, toCustomer ? 'customer_reply' : 'note', text);
    if (!openEvents.some(e => e.id === ev.id)) openEvents.push(ev);
    renderTimeline(true);
  } catch {
    ta.value = text;
    toast('Note not saved. Check your connection.', { type: 'error' });
  }
}

async function addPhoto(file) {
  const job = jobs.get(openJobId);
  if (!job) return;
  const t = toast('Uploading photo…', { duration: 30000 });
  try {
    const small = await compressImage(file);
    const path = await uploadMedia(small, { name: small.name });
    await signPaths([path]).catch(() => {});
    const ev = await addJobEvent(job.id, 'photo', null, { path });
    if (!openEvents.some(e => e.id === ev.id)) openEvents.push(ev);
    renderTimeline(true);
  } catch {
    toast('Photo not uploaded.', { type: 'error' });
  } finally {
    t.remove();
  }
}

// ---------------------------------------------------------------------------
// New / edit job
// ---------------------------------------------------------------------------
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function openJobForm(job = null) {
  if (!isStaff()) return;
  const members = await loadOrgMembers().catch(() => []);
  if (!places.length) places = await loadPlaces().catch(() => []);
  const drivers = members
    .map(m => ({ ...m, user: state.users.get(m.user_id) }))
    .filter(m => m.user)
    .sort((a, b) => (a.role === 'driver' ? 0 : 1) - (b.role === 'driver' ? 0 : 1) || a.user.name.localeCompare(b.user.name));
  const loc = { pickup: job ? { lat: job.pickup_lat, lng: job.pickup_lng } : {}, dropoff: job ? { lat: job.dropoff_lat, lng: job.dropoff_lng } : {} };

  const placeOptions = places.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  const locField = (key, label) => `
    <div class="field">
      <span>${label}</span>
      <div class="loc-row">
        <input class="input" name="${key}_name" maxlength="160" placeholder="${key === 'pickup' ? 'e.g. Kitwe depot' : 'e.g. Lubumbashi yard'}" value="${escapeHtml(job?.[`${key}_name`] || '')}">
        <button type="button" class="icon-btn" data-loc="${key}" aria-label="Pick ${label.toLowerCase()} on the map">${icon('map')}</button>
        <button type="button" class="icon-btn" data-here="${key}" aria-label="Use my current location">${icon('crosshair')}</button>
      </div>
      ${places.length ? `<select class="input place-select" data-place="${key}" aria-label="Saved places"><option value="">Choose a saved place…</option>${placeOptions}</select>` : ''}
      <span class="hint" data-loc-hint="${key}"></span>
    </div>`;

  const form = el(`
    <form class="form-stack job-form" novalidate>
      <label class="field"><span>What’s being moved</span><input class="input" name="title" required maxlength="120" placeholder="e.g. 30 t copper cathodes" value="${escapeHtml(job?.title || '')}"></label>
      <div class="two-col">
        <label class="field"><span>Customer</span><input class="input" name="customer_name" maxlength="120" value="${escapeHtml(job?.customer_name || '')}" placeholder="Company or person"></label>
        <label class="field"><span>Customer phone</span><input class="input" name="customer_phone" type="tel" maxlength="40" inputmode="tel" value="${escapeHtml(job?.customer_phone || '')}" placeholder="+260…"></label>
      </div>
      ${locField('pickup', 'Pickup')}
      ${locField('dropoff', 'Drop-off')}
      <div class="two-col">
        <label class="field"><span>Driver</span>
          <select class="input" name="driver_id">
            <option value="">Not assigned yet</option>
            ${drivers.map(d => `<option value="${escapeHtml(d.user_id)}" ${job?.driver_id === d.user_id ? 'selected' : ''}>${escapeHtml(d.user.name)}${d.role === 'driver' ? '' : ` (${escapeHtml(d.role)})`}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Vehicle</span><input class="input" name="vehicle" maxlength="40" value="${escapeHtml(job?.vehicle || '')}" placeholder="e.g. ALB 1234"></label>
      </div>
      <div class="two-col">
        <label class="field"><span>Cargo details</span><input class="input" name="cargo" maxlength="300" value="${escapeHtml(job?.cargo || '')}" placeholder="Weight, pieces, seal number"></label>
        <label class="field"><span>Due by</span><input class="input" name="due_at" type="datetime-local" value="${escapeHtml(toLocalInput(job?.due_at))}"></label>
      </div>
      <label class="field"><span>Notes for the driver</span><textarea class="input" name="notes" maxlength="2000">${escapeHtml(job?.notes || '')}</textarea></label>
      <p class="error-text" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn outline" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">${job ? 'Save changes' : 'Create job'}</button>
      </div>
    </form>`);

  const sheet = openSheet({ title: job ? `Edit ${job.ref}` : 'New job', content: form, wide: true });
  const hint = key => {
    const h = form.querySelector(`[data-loc-hint="${key}"]`);
    const l = loc[key];
    h.innerHTML = l.lat != null
      ? `${icon('check', 'xs')} Location set (${(+l.lat).toFixed(4)}, ${(+l.lng).toFixed(4)}). The job updates itself when the driver gets there. <button type="button" class="link-btn" data-clear="${key}">Clear</button>`
      : 'Add a map location so arrivals are recorded automatically.';
  };
  hint('pickup');
  hint('dropoff');

  form.addEventListener('click', async e => {
    const pick = e.target.closest('[data-loc]')?.dataset.loc;
    const here = e.target.closest('[data-here]')?.dataset.here;
    const clear = e.target.closest('[data-clear]')?.dataset.clear;
    if (e.target.closest('[data-cancel]')) sheet.close();
    if (clear) {
      loc[clear] = {};
      hint(clear);
    }
    if (pick) {
      const point = await pickOnMap(loc[pick].lat != null ? loc[pick] : null, pick === 'pickup' ? 'Pickup location' : 'Drop-off location');
      if (point) {
        loc[pick] = point;
        hint(pick);
      }
    }
    if (here) {
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 12000 }));
        loc[here] = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        hint(here);
      } catch {
        toast('Couldn’t get your location.', { type: 'error' });
      }
    }
  });
  form.querySelectorAll('[data-place]').forEach(sel => sel.addEventListener('change', () => {
    const p = places.find(x => x.id === sel.value);
    if (!p) return;
    const key = sel.dataset.place;
    form.querySelector(`[name="${key}_name"]`).value = p.name;
    loc[key] = { lat: p.lat, lng: p.lng };
    hint(key);
    sel.value = '';
  }));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = form.querySelector('.error-text');
    const f = Object.fromEntries(new FormData(form).entries());
    const title = String(f.title || '').trim();
    if (!title) {
      err.textContent = 'Say what’s being moved, e.g. “30 t copper cathodes”.';
      err.hidden = false;
      form.querySelector('[name="title"]').focus();
      return;
    }
    const clean = v => (String(v || '').trim() || null);
    const fields = {
      title,
      customer_name: clean(f.customer_name),
      customer_phone: clean(f.customer_phone),
      pickup_name: clean(f.pickup_name),
      pickup_lat: loc.pickup.lat ?? null,
      pickup_lng: loc.pickup.lng ?? null,
      dropoff_name: clean(f.dropoff_name),
      dropoff_lat: loc.dropoff.lat ?? null,
      dropoff_lng: loc.dropoff.lng ?? null,
      cargo: clean(f.cargo),
      vehicle: clean(f.vehicle)?.toUpperCase() || null,
      notes: clean(f.notes),
      driver_id: f.driver_id || null,
      due_at: f.due_at ? new Date(f.due_at).toISOString() : null
    };
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const saved = job ? await updateJob(job.id, fields) : await createJob(fields);
      jobs.set(saved.id, saved);
      await sheet.close();
      if (!job) {
        location.hash = `#/jobs/${saved.id}`;
        toast(`${saved.ref} created${saved.driver_id ? ` and sent to ${personName(saved.driver_id)}` : ''}`);
      } else {
        renderView();
        toast('Job saved');
      }
      renderList();
    } catch (ex) {
      err.textContent = /driver must be a member/i.test(String(ex?.message)) ? 'That driver isn’t in your company.' : 'Couldn’t save the job. Check your connection.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

/** A map to tap a point on. Resolves { lat, lng } or null. */
export function pickOnMap(start, title = 'Choose a location') {
  return new Promise(resolve => {
    const content = el(`<div class="map-pick">
      <div class="map-pick-canvas" id="mapPick${Date.now()}"></div>
      <p class="hint">Tap the map to place the pin. Drag to move around, pinch or scroll to zoom.</p>
      <div class="form-actions">
        <button type="button" class="btn outline" data-mp="here">${icon('crosshair', 'sm')}My location</button>
        <button type="button" class="btn primary" data-mp="ok" disabled>Use this point</button>
      </div>
    </div>`);
    let chosen = start && start.lat != null ? { lat: +start.lat, lng: +start.lng } : null;
    let done = false;
    const sheet = openSheet({ title, content, wide: true, onClose: () => !done && resolve(null) });
    const okBtn = content.querySelector('[data-mp="ok"]');
    loadLeaflet().then(L => {
      const map = L.map(content.querySelector('.map-pick-canvas'), { zoomControl: true, attributionControl: true })
        .setView(chosen ? [chosen.lat, chosen.lng] : [-15.4167, 28.2833], chosen ? 14 : 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      let marker = chosen ? L.marker([chosen.lat, chosen.lng]).addTo(map) : null;
      const set = (lat, lng, zoom) => {
        chosen = { lat, lng };
        if (marker) marker.setLatLng([lat, lng]);
        else marker = L.marker([lat, lng]).addTo(map);
        if (zoom) map.setView([lat, lng], zoom);
        okBtn.disabled = false;
      };
      if (chosen) okBtn.disabled = false;
      map.on('click', ev => set(ev.latlng.lat, ev.latlng.lng));
      setTimeout(() => map.invalidateSize(), 200);
      content.querySelector('[data-mp="here"]').addEventListener('click', () => {
        navigator.geolocation?.getCurrentPosition(
          p => set(p.coords.latitude, p.coords.longitude, 15),
          () => toast('Couldn’t get your location.', { type: 'error' }),
          { enableHighAccuracy: true, timeout: 12000 });
      });
    }).catch(() => {
      content.querySelector('.map-pick-canvas').innerHTML = '<p class="hint">The map couldn’t load. Use “My location” instead.</p>';
    });
    okBtn.addEventListener('click', () => {
      done = true;
      resolve(chosen);
      sheet.close();
    });
  });
}

// ---------------------------------------------------------------------------
// Proof of delivery
// ---------------------------------------------------------------------------
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let last = null;
  let dirty = false;
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#13201b';
    dirty = false;
  };
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', e => {
    drawing = true;
    last = pos(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    dirty = true;
  });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  requestAnimationFrame(fit);
  return {
    clear: fit,
    isEmpty: () => !dirty,
    toBlob: () => new Promise(res => {
      // white background so the PDF and dark mode both read well
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const o = out.getContext('2d');
      o.fillStyle = '#ffffff';
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(canvas, 0, 0);
      out.toBlob(res, 'image/png');
    })
  };
}

export function openProofForm(job) {
  const content = el(`
    <form class="form-stack pod-form" novalidate>
      <label class="field"><span>Received by</span><input class="input" name="receiver" required maxlength="120" autocomplete="off" placeholder="Name of the person receiving"></label>
      <div class="field">
        <span>Photo of the delivered goods</span>
        <label class="pod-photo">
          <input type="file" accept="image/*" capture="environment" name="photo" hidden>
          <span class="pod-photo-empty">${icon('camera', 'lg')}<span>Take a photo</span></span>
          <img alt="" hidden>
        </label>
      </div>
      <div class="field">
        <span>Signature</span>
        <canvas class="sig-pad" aria-label="Signature pad: sign with your finger"></canvas>
        <button type="button" class="link-btn" data-clear-sig>Clear signature</button>
      </div>
      <label class="field"><span>Note (optional)</span><input class="input" name="note" maxlength="500" placeholder="e.g. 2 pallets, seal 44821 intact"></label>
      <p class="hint" data-gps>${icon('pin', 'xs')} Getting your location…</p>
      <p class="error-text" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn outline" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">${icon('shield', 'sm')}Seal proof of delivery</button>
      </div>
    </form>`);
  const sheet = openSheet({ title: `Proof of delivery · ${job.ref}`, content, wide: true });
  const pad = signaturePad(content.querySelector('.sig-pad'));
  let photo = null;
  let gps = null;
  const gpsEl = content.querySelector('[data-gps]');
  navigator.geolocation?.getCurrentPosition(p => {
    gps = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    gpsEl.innerHTML = `${icon('check', 'xs')} Location recorded (±${Math.round(p.coords.accuracy)} m)`;
  }, () => {
    gpsEl.textContent = 'Location not available. The proof will be saved without it.';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });

  content.querySelector('[name="photo"]').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    photo = await compressImage(f);
    const img = content.querySelector('.pod-photo img');
    img.src = URL.createObjectURL(photo);
    img.hidden = false;
    content.querySelector('.pod-photo-empty').hidden = true;
  });
  content.querySelector('[data-clear-sig]').addEventListener('click', () => pad.clear());
  content.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  content.addEventListener('submit', async e => {
    e.preventDefault();
    const err = content.querySelector('.error-text');
    const receiver = content.querySelector('[name="receiver"]').value.trim();
    if (!receiver) {
      err.textContent = 'Enter the name of the person who received the goods.';
      err.hidden = false;
      return;
    }
    if (!photo && pad.isEmpty()) {
      err.textContent = 'Add a photo or a signature so the proof holds up in a dispute.';
      err.hidden = false;
      return;
    }
    const btn = content.querySelector('[type="submit"]');
    btn.disabled = true;
    err.hidden = true;
    try {
      const [photoPath, sigPath] = await Promise.all([
        photo ? uploadMedia(photo, { name: photo.name }) : null,
        pad.isEmpty() ? null : pad.toBlob().then(b => uploadMedia(b, { name: 'signature.png' }))
      ]);
      await createProof({
        job_id: job.id,
        receiver_name: receiver,
        photo_path: photoPath,
        signature_path: sigPath,
        note: content.querySelector('[name="note"]').value.trim() || null,
        lat: gps?.lat ?? null,
        lng: gps?.lng ?? null,
        accuracy: gps?.accuracy ?? null
      });
      await sheet.close();
      toast(`${job.ref} delivered. Proof sealed.`);
      reloadOpenJob();
    } catch (ex) {
      console.warn(ex);
      err.textContent = 'Couldn’t save the proof. Check your connection and try again; nothing was lost on this screen.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

export function jobsForMap() {
  return [...jobs.values()].filter(j => ACTIVE.includes(j.status));
}

