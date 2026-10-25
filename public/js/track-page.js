// Public delivery tracking: /t/<token>. No account needed; the token is a
// 128-bit random secret, and the database function returns only what a
// customer should see (no phone numbers, no other jobs, no driver surname).
import { html, raw, escapeHtml, toast } from './lib/dom.js';
import { icon, hydrateIcons } from './lib/icons.js';
import { time, fullDate, relative, dayLabel, sameDay } from './lib/format.js';
import { STEPS, stepIndex, statusLabel, STATUS } from './lib/jobStatus.js';

const config = window.APP_CONFIG;
const sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'wazambi-track' }
});
const root = document.getElementById('track');
const token = (location.pathname.match(/^\/t\/([0-9a-f]{24,64})\/?$/i) || [])[1];
let data = null;
let map = null;
let markers = {};
let L = null;

hydrateIcons();

async function load() {
  if (!token) return notFound();
  const { data: d, error } = await sb.rpc('track_job', { token });
  if (error) {
    if (!data) root.innerHTML = html`<div class="track-empty">${raw(icon('wifiOff', 'lg'))}<h1>Can’t load this delivery</h1><p>Check your connection. This page refreshes on its own.</p></div>`.value;
    return;
  }
  if (!d) return notFound();
  const first = !data;
  data = d;
  render(first);
}

function notFound() {
  document.title = 'Delivery not found · WAZAMBI';
  root.innerHTML = html`<div class="track-empty">${raw(icon('package', 'lg'))}<h1>This tracking link isn’t active</h1><p>The delivery may have been cancelled, or the link was copied incompletely. Ask the sender for a new link.</p></div>`.value;
}

function headline(d) {
  switch (d.status) {
    case 'assigned': return 'Your delivery is booked';
    case 'loading': return 'Your delivery is being loaded';
    case 'in_transit': return 'Your delivery is on the way';
    case 'at_border': return 'Your delivery is at the border';
    case 'arrived': return 'Your delivery has arrived';
    case 'delivered':
    case 'paid': return 'Delivered';
    default: return statusLabel(d.status, true);
  }
}

function eventLine(e) {
  switch (e.kind) {
    case 'created': return 'Delivery booked';
    case 'status': return statusLabel(e.status, true);
    case 'geofence': return e.message;
    case 'proof': return e.message;
    case 'customer_message': return `${e.name || 'You'} wrote`;
    case 'customer_reply': return 'Message from the sender';
    default: return '';
  }
}

function render(first) {
  const d = data;
  document.title = `${d.ref}: ${statusLabel(d.status, true)} · ${d.company || 'WAZAMBI'}`;
  const at = stepIndex(d.status);
  const lastPos = d.position ? `Location updated ${relative(d.position.at)}` : '';
  const done = d.status === 'delivered' || d.status === 'paid';
  let prev = null;
  const events = (d.events || []).filter(e => eventLine(e)).map(e => {
    const sep = !prev || !sameDay(prev.at, e.at) ? `<li class="ev-day">${escapeHtml(dayLabel(e.at))}</li>` : '';
    prev = e;
    const body = e.message && (e.kind === 'customer_message' || e.kind === 'customer_reply') ? `<p class="t-msg">${escapeHtml(e.message)}</p>` : '';
    return `${sep}<li class="t-ev kind-${escapeHtml(e.kind)}"><time datetime="${escapeHtml(e.at)}" title="${escapeHtml(fullDate(e.at))}">${escapeHtml(time(e.at))}</time><div><span>${escapeHtml(eventLine(e))}</span>${body}</div></li>`;
  }).join('');

  const scrollY = window.scrollY;
  const keepMap = document.getElementById('tmap');
  const focused = document.activeElement?.name;
  const selStart = document.activeElement?.selectionStart;
  const draft = root.querySelector('textarea')?.value || '';
  const draftName = root.querySelector('[name="name"]')?.value || localStorage.getItem('wazambi-track-name') || '';
  root.innerHTML = html`
    <header class="t-head">
      <span class="t-company">${d.company || ''}</span>
      <span class="t-ref">Delivery ${d.ref}</span>
    </header>
    <section class="t-hero tone-${STATUS[d.status]?.tone || 'quiet'}">
      <span class="t-hero-icon">${raw(icon(done ? 'check' : d.status === 'at_border' ? 'flag' : 'truck', 'lg'))}</span>
      <h1>${headline(d)}</h1>
      <p>${done && d.delivered_at ? `on ${fullDate(d.delivered_at)}` : lastPos || (d.due_at ? `Expected by ${fullDate(d.due_at)}` : '')}</p>
    </section>
    <ol class="job-track" aria-label="Progress">${raw(STEPS.filter(s => s !== 'paid').map((s, i) => {
      const cls = i < at ? 'done' : i === at || (s === 'delivered' && d.status === 'paid') ? 'current' : 'todo';
      const label = s === 'in_transit' && d.status === 'at_border' ? 'At the border' : statusLabel(s, true);
      return `<li class="${cls}"><span class="dot">${i < at ? icon('check', 'xs') : ''}</span><span class="lbl">${escapeHtml(label)}</span></li>`;
    }).join(''))}</ol>
    ${d.pickup?.lat != null || d.dropoff?.lat != null || d.position ? raw('<div class="t-map" id="tmap" role="img" aria-label="Map of the delivery route"></div>') : ''}
    <section class="t-card">
      <dl class="t-facts">
        ${d.pickup?.name ? html`<div><dt>From</dt><dd>${d.pickup.name}</dd></div>` : ''}
        ${d.dropoff?.name ? html`<div><dt>To</dt><dd>${d.dropoff.name}</dd></div>` : ''}
        ${d.driver ? html`<div><dt>Driver</dt><dd>${d.driver}${d.vehicle ? ` · ${d.vehicle}` : ''}</dd></div>` : ''}
        ${d.due_at && !done ? html`<div><dt>Expected</dt><dd>${fullDate(d.due_at)}</dd></div>` : ''}
      </dl>
    </section>
    ${d.proof ? html`
      <section class="t-card t-proof">
        <h2>${raw(icon('shield', 'sm'))} Proof of delivery</h2>
        <p>Received by <b>${d.proof.receiver}</b> on ${fullDate(d.proof.at)}.</p>
        <p class="hint">Sealed record ${d.proof.hash.slice(0, 16)}. The sender holds the photo, signature and location.</p>
      </section>` : ''}
    <section class="t-card">
      <h2>${raw(icon('clock', 'sm'))} Updates</h2>
      <ol class="t-timeline">${raw(events || '<li class="hint">No updates yet.</li>')}</ol>
    </section>
    ${d.status !== 'paid' ? html`
      <section class="t-card">
        <h2>${raw(icon('chat', 'sm'))} Message the sender</h2>
        <form class="t-form">
          <input class="input" name="name" maxlength="60" placeholder="Your name" autocomplete="name" value="${draftName}" aria-label="Your name">
          <textarea class="input" name="body" maxlength="500" required placeholder="e.g. Please call when you’re 30 minutes away" aria-label="Message">${draft}</textarea>
          <button type="submit" class="btn primary">Send</button>
        </form>
      </section>` : ''}`.value;
  // keep the live map (and whatever the person is typing) across refreshes
  const fresh = document.getElementById('tmap');
  if (keepMap && fresh) fresh.replaceWith(keepMap);
  if (focused) {
    const f = root.querySelector(`[name="${focused}"]`);
    if (f) {
      f.focus({ preventScroll: true });
      try { f.setSelectionRange(selStart, selStart); } catch { /* not a text field */ }
    }
  }
  window.scrollTo(0, scrollY);
  root.querySelector('.t-form')?.addEventListener('submit', send);
  drawMap(first);
}

async function send(e) {
  e.preventDefault();
  const f = e.target;
  const body = f.body.value.trim();
  if (!body) return;
  const btn = f.querySelector('button');
  btn.disabled = true;
  try {
    localStorage.setItem('wazambi-track-name', f.name.value.trim());
  } catch { /* ignore */ }
  const { error } = await sb.rpc('track_message', { token, sender_name: f.name.value.trim(), body });
  btn.disabled = false;
  if (error) {
    toast(/too many/i.test(error.message) ? 'You’ve sent a lot of messages. Try again in a while.' : 'Message not sent. Try again.', { type: 'error' });
    return;
  }
  f.body.value = '';
  toast('Sent. The sender has been notified.');
  load();
}

async function drawMap(first) {
  const el = document.getElementById('tmap');
  if (!el) return;
  if (!L) {
    L = await new Promise((resolve, reject) => {
      if (window.L) return resolve(window.L);
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.onload = () => resolve(window.L);
      s.onerror = reject;
      document.head.appendChild(s);
    }).catch(() => null);
    if (!L) {
      el.remove();
      return;
    }
  }
  // the element is re-created on each render; keep one map instance per element
  if (!map || map._container !== el) {
    map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    markers = {};
    first = true;
  }
  const pts = [];
  const dot = (cls, label) => L.divIcon({ className: '', html: `<div class="t-pin ${cls}" title="${escapeHtml(label)}">${cls === 'truck' ? icon('truck', 'sm') : ''}</div>`, iconSize: cls === 'truck' ? [40, 40] : [18, 18], iconAnchor: cls === 'truck' ? [20, 20] : [9, 9] });
  const put = (key, lat, lng, cls, label) => {
    if (lat == null) return;
    pts.push([lat, lng]);
    if (markers[key]) markers[key].setLatLng([lat, lng]);
    else markers[key] = L.marker([lat, lng], { icon: dot(cls, label), title: label, keyboard: false }).addTo(map);
  };
  put('pickup', data.pickup?.lat, data.pickup?.lng, 'from', data.pickup?.name || 'Pickup');
  put('dropoff', data.dropoff?.lat, data.dropoff?.lng, 'to', data.dropoff?.name || 'Drop-off');
  if (data.position) put('truck', data.position.lat, data.position.lng, 'truck', 'Your delivery');
  else if (markers.truck) {
    markers.truck.remove();
    delete markers.truck;
  }
  if (first && pts.length) {
    if (pts.length === 1) map.setView(pts[0], 13);
    else map.fitBounds(pts, { padding: [36, 36], maxZoom: 14 });
  }
  setTimeout(() => map.invalidateSize(), 50);
}

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, 15000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
