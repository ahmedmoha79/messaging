// Team map. Leaflet (about 150 KB) is only downloaded the first time someone
// opens this tab, so it never slows down opening chats. Location sharing is
// opt-in and only runs while the app is open.
import { sb, config } from '../lib/supabase.js';
import { html, raw, toast, throttle, escapeHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { relative, initials, colorFor } from '../lib/format.js';
import { state, on, settings, saveSetting } from './state.js';
import { avatarHtml, emptyState } from './ui.js';
import { loadLocations, saveLocation, stopSharingLocation } from './data.js';

const view = document.getElementById('mapView');
const peopleList = document.getElementById('mapPeople');
let L = null;
let map = null;
let layers = {};
let markers = new Map(); // user id -> marker
let locations = new Map(); // user id -> row
let channel = null;
let watchId = null;
let lastSent = null;
let myPosition = null;
let fitted = false;
let weatherLoadedAt = 0;

export function initMap() {
  on('route', r => {
    if (r.tab === 'map') show();
  });
  on('presence', () => map && redrawMarkers());
  on('users', () => map && redrawMarkers());
  peopleList.addEventListener('click', e => {
    const row = e.target.closest('[data-locate]');
    if (row) focusUser(row.dataset.locate);
  });
  if (settings.shareLocation) startWatching();
}

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error('Map failed to load'));
    document.head.appendChild(s);
  });
}

async function show() {
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    refresh();
    return;
  }
  view.innerHTML = '<div class="empty" style="margin:auto"><span class="spinner"></span><p>Loading map…</p></div>';
  try {
    L = await loadLeaflet();
  } catch {
    view.innerHTML = emptyState({ iconName: 'map', title: 'Map unavailable', text: 'The map couldn’t load. Check your connection and open this tab again.' }).value;
    return;
  }
  view.innerHTML = html`
    <div class="map-canvas" id="mapCanvas" role="application" aria-label="Map of team locations"></div>
    <div class="weather-card" hidden></div>
    <div class="map-tools">
      <button type="button" class="map-tool" data-map="me" aria-label="Show my location">${raw(icon('crosshair'))}</button>
      <button type="button" class="map-tool" data-map="team" aria-label="Show the whole team">${raw(icon('users'))}</button>
      <button type="button" class="map-tool" data-map="layer" aria-label="Switch map style">${raw(icon('layers'))}</button>
    </div>
    <div class="map-share"></div>`.value;

  map = L.map('mapCanvas', { zoomControl: false, attributionControl: true, preferCanvas: true, worldCopyJump: true })
    .setView([-15.4167, 28.2833], 11); // Lusaka until we know better
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  layers = {
    streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Imagery © Esri'
    })
  };
  (layers[settings.mapLayer] || layers.streets).addTo(map);

  view.addEventListener('click', onToolClick);
  subscribe();
  renderShareBar();
  await refresh();
}

async function refresh() {
  try {
    const rows = await loadLocations();
    locations = new Map(rows.map(r => [r.user_id, r]));
  } catch {
    toast('Couldn’t load team locations.', { type: 'error' });
  }
  redrawMarkers();
  if (!fitted) {
    fitted = true;
    fitTeam(false);
  }
  loadWeather();
}

function subscribe() {
  if (channel) return;
  channel = sb.channel('map-locations')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_locations' }, p => {
      if (p.eventType === 'DELETE') {
        // RLS-protected deletes only carry the key
        const id = p.old?.user_id;
        if (id) locations.delete(id);
      } else if (p.new?.user_id) {
        locations.set(p.new.user_id, p.new);
      }
      redrawMarkers();
    })
    .subscribe();
}

function pinIcon(user, { me = false, stale = false } = {}) {
  const size = me ? 46 : 42;
  const inner = user?.avatar_url
    ? `<img src="${escapeHtml(user.avatar_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer">`
    : `<span style="display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:${colorFor(user?.id || '')};color:#fff;font-weight:700">${escapeHtml(initials(user?.name))}</span>`;
  return L.divIcon({
    className: '',
    html: `<div class="map-pin${me ? ' me' : ''}${stale ? ' stale' : ''}" style="width:${size}px;height:${size}px">${inner}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

function popupHtml(user, loc) {
  const battery = loc.battery_level ?? loc.device_context?.battery_level;
  const self = user.id === state.me.id;
  return `
    <div class="pin-popup">
      <b>${escapeHtml(self ? 'You' : user.name)}</b>
      <span>${state.online.has(user.id) ? 'Online · ' : ''}Updated ${escapeHtml(relative(loc.last_updated))}${battery ? ` · battery ${Math.round(battery)}%` : ''}</span>
      ${self ? '' : `<a class="btn small primary" href="#/chat/u/${escapeHtml(user.id)}">Message</a>`}
    </div>`;
}

function redrawMarkers() {
  if (!map) return;
  const seen = new Set();
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  locations.forEach((loc, uid) => {
    if (new Date(loc.last_updated).getTime() < dayAgo) return;
    const user = state.users.get(uid);
    if (!user) return;
    seen.add(uid);
    const stale = Date.now() - new Date(loc.last_updated).getTime() > 20 * 60 * 1000;
    const me = uid === state.me.id;
    let m = markers.get(uid);
    const latlng = [loc.latitude, loc.longitude];
    if (!m) {
      m = L.marker(latlng, { icon: pinIcon(user, { me, stale }), zIndexOffset: me ? 1000 : 0, title: user.name, keyboard: true });
      m.bindPopup('');
      m.addTo(map);
      markers.set(uid, m);
    } else {
      m.setLatLng(latlng);
      m.setIcon(pinIcon(user, { me, stale }));
    }
    m.setPopupContent(popupHtml(user, loc));
  });
  markers.forEach((m, uid) => {
    if (!seen.has(uid)) {
      m.remove();
      markers.delete(uid);
    }
  });
  renderPeople();
}

function renderPeople() {
  const rows = [...locations.values()]
    .filter(l => state.users.get(l.user_id) && Date.now() - new Date(l.last_updated).getTime() < 24 * 3600 * 1000)
    .sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  peopleList.innerHTML = rows.length
    ? rows.map(l => {
        const u = state.users.get(l.user_id);
        return html`
          <button type="button" class="row" data-locate="${u.id}">
            ${avatarHtml(u, { size: 44, presence: true })}
            <span class="row-main">
              <span class="row-name">${u.id === state.me.id ? 'You' : u.name}</span>
              <span class="row-sub">Updated ${relative(l.last_updated)}</span>
            </span>
            ${raw(icon('pin', 'sm'))}
          </button>`.value;
      }).join('')
    : emptyState({ iconName: 'pin', title: 'No one is sharing yet', text: 'Teammates who turn on location sharing appear here and on the map.' }).value;
}

function focusUser(uid) {
  const loc = locations.get(uid);
  const m = markers.get(uid);
  if (!loc || !map) return;
  if (matchMedia('(max-width: 859px)').matches) location.hash = '#/map';
  map.flyTo([loc.latitude, loc.longitude], 16, { duration: 0.6 });
  setTimeout(() => m?.openPopup(), 650);
}

function fitTeam(animate = true) {
  const pts = [...markers.values()].map(m => m.getLatLng());
  if (myPosition) pts.push(L.latLng(myPosition.latitude, myPosition.longitude));
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], 15, { animate });
  else map.fitBounds(L.latLngBounds(pts).pad(0.2), { animate, maxZoom: 16 });
}

function onToolClick(e) {
  const act = e.target.closest('[data-map]')?.dataset.map;
  if (act === 'me') locateMe();
  else if (act === 'team') fitTeam();
  else if (act === 'layer') {
    const next = settings.mapLayer === 'satellite' ? 'streets' : 'satellite';
    map.removeLayer(layers[settings.mapLayer] || layers.streets);
    layers[next].addTo(map);
    saveSetting('mapLayer', next);
  } else if (e.target.closest('[data-share]')) {
    const want = e.target.closest('[data-share]').dataset.share === 'on';
    setLocationSharing(want).then(ok => ok && saveSetting('shareLocation', want));
  }
}

function locateMe() {
  if (myPosition) {
    map.flyTo([myPosition.latitude, myPosition.longitude], 16, { duration: 0.6 });
    return;
  }
  getPosition().then(pos => {
    myPosition = pos.coords;
    map.flyTo([pos.coords.latitude, pos.coords.longitude], 16, { duration: 0.6 });
    loadWeather(true);
  }).catch(err => toast(geoErrorText(err), { type: 'error' }));
}

function renderShareBar() {
  const bar = view.querySelector('.map-share');
  if (!bar) return;
  bar.innerHTML = settings.shareLocation
    ? html`<span class="map-share-text"><b>Sharing your live location</b>Your team sees where you are while WAZAMBI is open.</span>
        <button type="button" class="btn small outline" data-share="off">Stop</button>`.value
    : html`<span class="map-share-text"><b>Your location is private</b>Share it so your team can see you on the map.</span>
        <button type="button" class="btn small primary" data-share="on">Share</button>`.value;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

function geoErrorText(err) {
  if (err?.code === 1) return 'Location access is blocked. Allow it for this site in your browser settings.';
  if (err?.message === 'unsupported') return 'This device can’t share its location.';
  return 'Couldn’t get your location. Try again outside or near a window.';
}

/** Turns sharing on/off. Returns true on success. */
export async function setLocationSharing(enable) {
  if (!enable) {
    stopWatching();
    try {
      await stopSharingLocation();
    } catch {
      /* the row expires on its own */
    }
    settings.shareLocation = false;
    renderShareBar();
    toast('Location sharing is off');
    return true;
  }
  try {
    const pos = await getPosition();
    myPosition = pos.coords;
    await sendPosition(pos, true);
  } catch (err) {
    toast(geoErrorText(err), { type: 'error' });
    return false;
  }
  settings.shareLocation = true;
  startWatching();
  renderShareBar();
  toast('Your team can now see your location');
  return true;
}

let battery = null;
async function batteryLevel() {
  try {
    battery = battery || (await navigator.getBattery?.());
    return battery ? Math.round(battery.level * 100) : null;
  } catch {
    return null;
  }
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function sendPosition(pos, force = false) {
  const { latitude, longitude, accuracy } = pos.coords;
  const now = Date.now();
  // Save when moved 25 m, or every 60 s regardless (keeps the row fresh).
  if (!force && lastSent && now - lastSent.at < 60000 && distanceMeters(lastSent, pos.coords) < 25) return;
  lastSent = { latitude, longitude, at: now };
  await saveLocation({ latitude, longitude, accuracy, battery: await batteryLevel() });
}
const sendThrottled = throttle(pos => sendPosition(pos).catch(() => {}), 10000);

function startWatching() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(pos => {
    myPosition = pos.coords;
    sendThrottled(pos);
  }, err => {
    if (err.code === 1) {
      stopWatching();
      saveSetting('shareLocation', false);
      renderShareBar();
    }
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  // keep the "updated" time fresh even when standing still
  startWatching.keepAlive = setInterval(() => {
    if (myPosition && document.visibilityState === 'visible') {
      sendPosition({ coords: myPosition }).catch(() => {});
    }
  }, 60000);
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(startWatching.keepAlive);
}

// ---------------------------------------------------------------------------
// Weather (through our server, so the API key stays private)
// ---------------------------------------------------------------------------
async function loadWeather(force = false) {
  if (!config.weather || !map) return;
  if (!force && Date.now() - weatherLoadedAt < 10 * 60 * 1000) return;
  const center = myPosition ? { lat: myPosition.latitude, lon: myPosition.longitude } : { lat: map.getCenter().lat, lon: map.getCenter().lng };
  weatherLoadedAt = Date.now();
  try {
    const r = await fetch(`/api/weather?lat=${center.lat.toFixed(3)}&lon=${center.lon.toFixed(3)}`, {
      headers: { Authorization: `Bearer ${state.session.access_token}` }
    });
    if (!r.ok) return;
    const w = await r.json();
    const card = view.querySelector('.weather-card');
    card.innerHTML = html`
      ${w.icon ? html`<img src="https://openweathermap.org/img/wn/${w.icon}@2x.png" alt="">` : raw(icon('cloud'))}
      <span><b>${w.temp}°</b> ${w.description}${w.place ? html`<br><small>${w.place}</small>` : ''}</span>`.value;
    card.hidden = false;
  } catch {
    /* weather is a nice-to-have */
  }
}
