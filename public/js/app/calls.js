// Voice and video calls.
//
// How a call works:
//   1. The caller inserts a row in `calls` (status "ringing"). Row-level
//      security means only the two participants can see it, and the callee's
//      realtime subscription makes their phone ring.
//   2. When the callee accepts, both sides join a private broadcast channel
//      named after the call's random id and exchange WebRTC offer/answer and
//      ICE candidates over it.
//   3. Audio and video then flow directly between the two devices (or via a
//      TURN relay when networks block direct connections).
//   4. The `calls` row is updated as the call ends, which doubles as call history.
import { sb, config } from '../lib/supabase.js';
import { html, raw, toast, escapeHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { duration, listStamp, fullDate } from '../lib/format.js';
import { state, on, emit } from './state.js';
import { createCall, updateCall, loadCallHistory } from './data.js';
import { avatarHtml, emptyState, showMenu } from './ui.js';
import { startRing, stopRing, beep, systemNotify, closeNotifications } from './notify.js';

const RING_TIMEOUT_MS = 45000;
const layer = document.getElementById('callLayer');
let call = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initCalls() {
  on('call:incoming', onIncoming);
  on('call:update', onCallRowUpdate);
  on('route', r => {
    if (r.tab === 'calls') {
      markCallsSeen();
      renderHistory();
    }
  });
  document.getElementById('newCallBtn').addEventListener('click', pickSomeoneToCall);
  document.getElementById('callList').addEventListener('click', onHistoryClick);
  window.addEventListener('beforeunload', e => {
    if (call && call.phase !== 'ended') {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => call && hangup('ended', { silent: true }));
  refreshMissedBadge();
}

export function inCall() {
  return !!call;
}

export async function startCall(peerId, kind = 'audio') {
  if (call) {
    if (call.minimized) restoreCall();
    toast('You’re already in a call.');
    return;
  }
  const peer = state.users.get(peerId);
  if (!peer || peerId === state.me.id) return;
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    toast('Calls aren’t supported in this browser. Try Chrome, Edge, Firefox or Safari.', { type: 'error' });
    return;
  }

  call = newCallState({ role: 'caller', kind, peer });
  renderCallUi();
  setPhase('preparing', 'Starting…');

  const c = call;
  let stream;
  try {
    stream = await getMedia(kind);
  } catch (err) {
    if (call === c) cleanup();
    toast(mediaErrorText(err, kind), { type: 'error' });
    return;
  }
  if (call !== c || c.phase === 'ended') {
    // hung up while the browser was asking for permission
    stream.getTracks().forEach(t => t.stop());
    return;
  }
  c.localStream = stream;
  attachLocalVideo();

  try {
    c.row = await createCall(peerId, kind);
  } catch (err) {
    if (call === c) cleanup();
    toast('Couldn’t start the call. Check your connection.', { type: 'error' });
    return;
  }
  if (call !== c || c.phase === 'ended') {
    // hung up while the call was being created: make sure it never rings
    updateCall(c.row.id, { status: 'cancelled', ended_at: new Date().toISOString() });
    return;
  }
  setPhase('ringing', state.online.has(peerId) ? 'Ringing…' : 'Calling…');
  startRing('outgoing');
  await joinSignalChannel();
  call.ringTimer = setTimeout(() => {
    if (call?.phase === 'ringing') {
      hangup('missed', { message: 'No answer' });
    }
  }, RING_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Incoming calls
// ---------------------------------------------------------------------------
function onIncoming(row) {
  if (row.status !== 'ringing') return;
  if (Date.now() - new Date(row.created_at).getTime() > 60000) return; // stale
  if (call) {
    // Already on a call: tell the caller we're busy.
    if (call.row?.id !== row.id) updateCall(row.id, { status: 'busy', ended_at: new Date().toISOString() });
    return;
  }
  const peer = state.users.get(row.caller_id) || { id: row.caller_id, name: 'Someone' };
  call = newCallState({ role: 'callee', kind: row.kind, peer });
  call.row = row;
  renderCallUi();
  setPhase('incoming', row.kind === 'video' ? 'Incoming video call' : 'Incoming voice call');
  startRing('incoming');
  systemNotify({
    title: peer.name,
    body: row.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
    tag: `call-${row.id}`,
    url: '/app#/calls',
    requireInteraction: true
  });
  call.ringTimer = setTimeout(() => {
    if (call?.phase === 'incoming') {
      // caller's side marks it missed; we just stop ringing
      endLocally('Missed call');
    }
  }, RING_TIMEOUT_MS + 5000);
  emit('calls:changed');
}

async function acceptCall() {
  if (!call || call.phase !== 'incoming') return;
  stopRing();
  closeNotifications(`call-${call.row.id}`);
  setPhase('connecting', 'Connecting…');
  try {
    call.localStream = await getMedia(call.kind);
  } catch (err) {
    toast(mediaErrorText(err, call.kind), { type: 'error' });
    hangup('declined');
    return;
  }
  attachLocalVideo();
  await updateCall(call.row.id, { status: 'accepted', answered_at: new Date().toISOString() });
  await joinSignalChannel();
  createPeerConnection();
  // Tell the caller we're ready for their offer (repeat in case they joined late).
  let tries = 0;
  const sayReady = () => {
    if (!call || call.gotOffer || tries++ > 6) return;
    signal({ type: 'ready' });
    call.readyTimer = setTimeout(sayReady, 2000);
  };
  sayReady();
}

function declineCall() {
  if (!call) return;
  hangup('declined');
}

function onCallRowUpdate(row) {
  if (!call || call.row?.id !== row.id) {
    // A call we were ringing for got answered on another device or cancelled.
    return;
  }
  call.row = { ...call.row, ...row };
  if (call.role === 'caller') {
    if (row.status === 'accepted' && call.phase === 'ringing') {
      stopRing();
      clearTimeout(call.ringTimer);
      setPhase('connecting', 'Connecting…');
    } else if (row.status === 'declined') {
      endLocally('Call declined');
    } else if (row.status === 'busy') {
      endLocally(`${call.peer.name.split(' ')[0]} is on another call`);
    } else if (row.status === 'ended' && call.phase !== 'ended') {
      endLocally('Call ended');
    }
  } else {
    if ((row.status === 'cancelled' || row.status === 'missed') && call.phase === 'incoming') {
      endLocally('Missed call');
    } else if (row.status === 'accepted' && call.phase === 'incoming') {
      // answered on one of our other devices
      endLocally('Answered on another device', { quiet: true });
    } else if (row.status === 'ended' && call.phase !== 'ended') {
      endLocally('Call ended');
    }
  }
}

// ---------------------------------------------------------------------------
// Signalling and WebRTC
// ---------------------------------------------------------------------------
async function joinSignalChannel() {
  const c = call;
  if (!c) return;
  c.channel = sb.channel(`call:${c.row.id}`, { config: { broadcast: { self: false, ack: false } } })
    .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload));
  await new Promise(resolve => {
    const t = setTimeout(resolve, 6000);
    c.channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

function signal(payload) {
  call?.channel?.send({ type: 'broadcast', event: 'signal', payload: { ...payload, from: state.me.id } }).catch(() => {});
}

function createPeerConnection() {
  const c = call;
  const pc = new RTCPeerConnection({ iceServers: config.iceServers, iceCandidatePoolSize: 4 });
  c.pc = pc;
  c.localStream.getTracks().forEach(track => pc.addTrack(track, c.localStream));

  pc.onicecandidate = e => {
    if (e.candidate) signal({ type: 'ice', candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    const [stream] = e.streams;
    c.remoteStream = stream;
    const audio = c.ui.querySelector('.call-remote-audio');
    audio.srcObject = stream;
    audio.play().catch(() => {});
    if (c.kind === 'video' && e.track.kind === 'video') {
      const video = c.ui.querySelector('.call-remote-video');
      video.srcObject = stream;
      video.hidden = false;
      video.muted = true; // sound comes from the <audio> element
      video.play().catch(() => {});
      c.ui.classList.add('video-live');
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') onConnected();
    else if (s === 'disconnected') {
      setStateText('Reconnecting…');
      clearTimeout(c.restartTimer);
      c.restartTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected' && c.role === 'caller') restartIce();
      }, 3000);
    } else if (s === 'failed') {
      if (c.role === 'caller' && !c.restarted) restartIce();
      else {
        setStateText('Connection lost');
        clearTimeout(c.failTimer);
        c.failTimer = setTimeout(() => call === c && pc.connectionState === 'failed' && hangup('ended', { message: 'Call dropped' }), 8000);
      }
    }
  };
  return pc;
}

async function makeOffer({ iceRestart = false } = {}) {
  const c = call;
  if (!c?.pc) return;
  const offer = await c.pc.createOffer({ iceRestart });
  await c.pc.setLocalDescription(offer);
  signal({ type: 'offer', sdp: c.pc.localDescription.toJSON() });
}

async function restartIce() {
  if (!call?.pc) return;
  call.restarted = true;
  setStateText('Reconnecting…');
  try {
    await makeOffer({ iceRestart: true });
  } catch {
    /* the fail timer will end the call */
  }
}

async function flushCandidates() {
  const c = call;
  if (!c?.pc?.remoteDescription) return;
  const pending = c.pendingIce.splice(0);
  for (const cand of pending) {
    try {
      await c.pc.addIceCandidate(cand);
    } catch {
      /* stale candidate */
    }
  }
}

async function onSignal(msg) {
  const c = call;
  if (!c || msg.from === state.me.id) return;
  try {
    switch (msg.type) {
      case 'ready':
        if (c.role !== 'caller' || c.offered) return;
        c.offered = true;
        stopRing();
        clearTimeout(c.ringTimer);
        setPhase('connecting', 'Connecting…');
        createPeerConnection();
        await makeOffer();
        break;
      case 'offer':
        if (!c.pc) createPeerConnection();
        c.gotOffer = true;
        clearTimeout(c.readyTimer);
        await c.pc.setRemoteDescription(msg.sdp);
        await flushCandidates();
        await c.pc.setLocalDescription(await c.pc.createAnswer());
        signal({ type: 'answer', sdp: c.pc.localDescription.toJSON() });
        break;
      case 'answer':
        if (!c.pc || c.pc.signalingState !== 'have-local-offer') return;
        await c.pc.setRemoteDescription(msg.sdp);
        await flushCandidates();
        break;
      case 'ice':
        if (!msg.candidate) return;
        if (c.pc?.remoteDescription) await c.pc.addIceCandidate(msg.candidate).catch(() => {});
        else c.pendingIce.push(msg.candidate);
        break;
      case 'media':
        c.remoteMuted = !msg.audio;
        c.remoteCameraOff = msg.video === false;
        updateRemoteMediaHint();
        break;
      case 'hangup':
        endLocally(msg.reason === 'declined' ? 'Call declined' : 'Call ended');
        break;
    }
  } catch (err) {
    console.error('Signalling error', err);
  }
}

function onConnected() {
  const c = call;
  if (!c || c.phase === 'active') {
    if (c) setStateText(duration((Date.now() - c.connectedAt) / 1000));
    return;
  }
  stopRing();
  clearTimeout(c.ringTimer);
  c.connectedAt = Date.now();
  setPhase('active', '0:00');
  c.clock = setInterval(() => {
    if (call === c && c.pc?.connectionState === 'connected') setStateText(duration((Date.now() - c.connectedAt) / 1000));
  }, 1000);
  c.statsTimer = setInterval(checkQuality, 4000);
  requestWakeLock();
  signal({ type: 'media', audio: !c.muted, video: c.kind === 'video' ? !c.cameraOff : undefined });
}

async function checkQuality() {
  const c = call;
  if (!c?.pc) return;
  try {
    const stats = await c.pc.getStats();
    let rtt = null;
    let lost = 0;
    let received = 0;
    stats.forEach(r => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) rtt = r.currentRoundTripTime;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        lost += r.packetsLost || 0;
        received += r.packetsReceived || 0;
      }
    });
    const lossRate = received ? lost / (lost + received) : 0;
    const prev = c.lastLoss || { lost: 0, received: 0 };
    const windowLoss = (lost - prev.lost) / Math.max(1, (lost - prev.lost) + (received - prev.received));
    c.lastLoss = { lost, received };
    const weak = (rtt && rtt > 0.45) || windowLoss > 0.08 || lossRate > 0.15;
    const q = c.ui.querySelector('.call-quality');
    q.textContent = weak ? 'Weak connection' : '';
  } catch {
    /* stats not available */
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
async function getMedia(kind) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video = kind === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (err) {
    // No camera (or it's busy): fall back to voice so the call can still happen.
    if (kind === 'video' && /NotFound|NotReadable|Overconstrained/i.test(err?.name || '')) {
      toast('Camera not available. Continuing with voice only.');
      call && (call.cameraOff = true);
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    throw err;
  }
}

function mediaErrorText(err, kind) {
  const name = err?.name || '';
  const what = kind === 'video' ? 'camera and microphone' : 'microphone';
  if (/NotAllowed|Permission|Security/i.test(name)) return `Allow ${what} access in your browser to make calls.`;
  if (/NotFound/i.test(name)) return 'No microphone found on this device.';
  if (/NotReadable/i.test(name)) return 'Your microphone or camera is being used by another app.';
  return `Couldn’t access your ${what}.`;
}

function attachLocalVideo() {
  const c = call;
  if (!c || c.kind !== 'video') return;
  const v = c.ui.querySelector('.call-local-video');
  const hasVideo = c.localStream.getVideoTracks().length > 0;
  v.srcObject = c.localStream;
  v.hidden = !hasVideo;
  v.play().catch(() => {});
  renderControls();
}

function toggleMute() {
  const c = call;
  if (!c?.localStream) return;
  c.muted = !c.muted;
  c.localStream.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
  signal({ type: 'media', audio: !c.muted, video: c.kind === 'video' ? !c.cameraOff : undefined });
  renderControls();
}

function toggleCamera() {
  const c = call;
  if (!c?.localStream) return;
  const tracks = c.localStream.getVideoTracks();
  if (!tracks.length) return;
  c.cameraOff = !c.cameraOff;
  tracks.forEach(t => { t.enabled = !c.cameraOff; });
  c.ui.querySelector('.call-local-video').hidden = c.cameraOff;
  signal({ type: 'media', audio: !c.muted, video: !c.cameraOff });
  renderControls();
}

async function flipCamera() {
  const c = call;
  if (!c?.localStream || c.cameraOff) return;
  const old = c.localStream.getVideoTracks()[0];
  if (!old) return;
  const facing = c.facing === 'environment' ? 'user' : 'environment';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = s.getVideoTracks()[0];
    const sender = c.pc?.getSenders().find(x => x.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
    c.localStream.removeTrack(old);
    old.stop();
    c.localStream.addTrack(track);
    c.facing = facing;
    const v = c.ui.querySelector('.call-local-video');
    v.srcObject = c.localStream;
    v.classList.toggle('rear', facing === 'environment');
  } catch {
    toast('Couldn’t switch camera.');
  }
}

async function requestWakeLock() {
  try {
    call.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------
/** Ends the call from our side and records the outcome. */
async function hangup(status = 'ended', { message = 'Call ended', silent = false } = {}) {
  const c = call;
  if (!c) return;
  const finalStatus = c.phase === 'active' || c.phase === 'connecting'
    ? 'ended'
    : c.role === 'caller' ? (status === 'missed' ? 'missed' : 'cancelled') : status;
  if (c.row?.id) {
    signal({ type: 'hangup', reason: finalStatus });
    updateCall(c.row.id, { status: finalStatus, ended_at: new Date().toISOString() });
  }
  if (silent) cleanup();
  else endLocally(message);
}

function endLocally(message, { quiet = false } = {}) {
  const c = call;
  if (!c || c.phase === 'ended') return;
  c.phase = 'ended';
  stopRing();
  if (!quiet) beep('end');
  const totalSecs = c.connectedAt ? (Date.now() - c.connectedAt) / 1000 : 0;
  setStateText(totalSecs ? `${message} · ${duration(totalSecs)}` : message);
  c.ui.classList.remove('ringing');
  c.ui.querySelector('.call-controls').innerHTML = '';
  stopMedia(c);
  setTimeout(() => cleanup(), quiet ? 0 : 1400);
}

function stopMedia(c) {
  clearTimeout(c.ringTimer);
  clearTimeout(c.readyTimer);
  clearTimeout(c.restartTimer);
  clearTimeout(c.failTimer);
  clearInterval(c.clock);
  clearInterval(c.statsTimer);
  c.localStream?.getTracks().forEach(t => t.stop());
  try {
    c.pc?.close();
  } catch {
    /* ignore */
  }
  if (c.channel) sb.removeChannel(c.channel);
  c.wakeLock?.release?.().catch(() => {});
  c.pc = null;
  c.channel = null;
}

function cleanup() {
  const c = call;
  if (!c) return;
  stopMedia(c);
  stopRing();
  c.ui.classList.add('closing');
  setTimeout(() => c.ui.remove(), 200);
  c.mini?.remove();
  call = null;
  emit('calls:changed');
  if (location.hash.startsWith('#/calls')) renderHistory();
  refreshMissedBadge();
}

// ---------------------------------------------------------------------------
// Call screen
// ---------------------------------------------------------------------------
function newCallState({ role, kind, peer }) {
  return {
    role,
    kind,
    peer,
    phase: 'preparing',
    row: null,
    pc: null,
    channel: null,
    localStream: null,
    remoteStream: null,
    pendingIce: [],
    muted: false,
    cameraOff: false,
    facing: 'user',
    minimized: false,
    ui: null
  };
}

function renderCallUi() {
  const c = call;
  const ui = document.createElement('div');
  ui.className = 'call';
  ui.setAttribute('role', 'dialog');
  ui.setAttribute('aria-label', `Call with ${c.peer.name}`);
  ui.innerHTML = html`
    <video class="call-remote-video" autoplay playsinline hidden></video>
    <audio class="call-remote-audio" autoplay></audio>
    <video class="call-local-video" autoplay playsinline muted hidden></video>
    <div class="call-who">
      <div class="call-ring">${avatarHtml(c.peer, { size: 132 })}</div>
      <div class="call-name">${c.peer.name}</div>
      <div class="call-state" aria-live="polite"></div>
      <div class="call-quality" aria-live="polite"></div>
    </div>
    <div class="call-controls"></div>`.value;
  layer.appendChild(ui);
  c.ui = ui;
  ui.addEventListener('click', onCallClick);
  makeDraggable(ui.querySelector('.call-local-video'));
  renderControls();
}

function callBtn(act, iconName, label, extra = '') {
  return `<button type="button" class="call-btn ${extra}" data-call="${act}" aria-label="${escapeHtml(label)}"><span class="disc">${icon(iconName)}</span><span>${escapeHtml(label)}</span></button>`;
}

function renderControls() {
  const c = call;
  if (!c?.ui || c.phase === 'ended') return;
  const box = c.ui.querySelector('.call-controls');
  if (c.phase === 'incoming') {
    box.innerHTML = callBtn('decline', 'hangup', 'Decline', 'hangup') +
      callBtn('accept', c.kind === 'video' ? 'video' : 'phone', 'Accept', 'accept');
    box.querySelector('[data-call="accept"]').focus();
    return;
  }
  const hasVideo = c.kind === 'video' && c.localStream?.getVideoTracks().length;
  const canFlip = hasVideo && /Android|iPhone|iPad/i.test(navigator.userAgent);
  box.innerHTML =
    callBtn('mute', c.muted ? 'micOff' : 'mic', c.muted ? 'Unmute' : 'Mute', c.muted ? 'on' : '') +
    (hasVideo ? callBtn('camera', c.cameraOff ? 'videoOff' : 'video', c.cameraOff ? 'Camera on' : 'Camera off', c.cameraOff ? 'on' : '') : '') +
    (canFlip ? callBtn('flip', 'flip', 'Flip') : '') +
    callBtn('minimize', 'chat', 'Chat') +
    callBtn('hangup', 'hangup', 'End', 'hangup');
}

function onCallClick(e) {
  const act = e.target.closest('[data-call]')?.dataset.call;
  if (!act) return;
  switch (act) {
    case 'accept': acceptCall(); break;
    case 'decline': declineCall(); break;
    case 'mute': toggleMute(); break;
    case 'camera': toggleCamera(); break;
    case 'flip': flipCamera(); break;
    case 'minimize': minimizeCall(); break;
    case 'hangup': hangup('ended'); break;
  }
}

function setPhase(phase, text) {
  const c = call;
  if (!c) return;
  c.phase = phase;
  c.ui.classList.toggle('ringing', phase === 'ringing' || phase === 'incoming');
  setStateText(text);
  renderControls();
}

function setStateText(text) {
  if (!call?.ui) return;
  call.ui.querySelector('.call-state').textContent = text;
  if (call.mini) call.mini.querySelector('.mini-text').textContent = `${call.peer.name.split(' ')[0]} · ${text}`;
}

function updateRemoteMediaHint() {
  const c = call;
  if (!c?.ui) return;
  const q = c.ui.querySelector('.call-quality');
  const hints = [];
  if (c.remoteMuted) hints.push(`${c.peer.name.split(' ')[0]} is muted`);
  if (c.kind === 'video' && c.remoteCameraOff) hints.push('camera off');
  q.textContent = hints.join(' · ');
  const rv = c.ui.querySelector('.call-remote-video');
  if (c.kind === 'video') {
    rv.hidden = !!c.remoteCameraOff || !c.remoteStream;
    c.ui.classList.toggle('video-live', !rv.hidden);
  }
}

function minimizeCall() {
  const c = call;
  if (!c) return;
  c.minimized = true;
  c.ui.hidden = true;
  const mini = document.createElement('div');
  mini.className = 'call-mini';
  mini.innerHTML = `<button type="button" class="mini-text" style="all:unset;cursor:pointer">${escapeHtml(c.peer.name.split(' ')[0])}</button><button type="button" class="disc" style="border:0;color:#fff" aria-label="End call">${icon('hangup')}</button>`;
  mini.querySelector('.mini-text').addEventListener('click', restoreCall);
  mini.querySelector('.disc').addEventListener('click', () => hangup('ended'));
  document.body.appendChild(mini);
  c.mini = mini;
  setStateText(c.ui.querySelector('.call-state').textContent);
}

function restoreCall() {
  const c = call;
  if (!c) return;
  c.minimized = false;
  c.ui.hidden = false;
  c.mini?.remove();
  c.mini = null;
}

function makeDraggable(node) {
  let start = null;
  node.addEventListener('pointerdown', e => {
    start = { x: e.clientX, y: e.clientY, rect: node.getBoundingClientRect() };
    node.setPointerCapture(e.pointerId);
  });
  node.addEventListener('pointermove', e => {
    if (!start) return;
    const x = Math.min(window.innerWidth - start.rect.width - 8, Math.max(8, start.rect.left + e.clientX - start.x));
    const y = Math.min(window.innerHeight - start.rect.height - 8, Math.max(8, start.rect.top + e.clientY - start.y));
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.right = 'auto';
  });
  node.addEventListener('pointerup', () => { start = null; });
}

// ---------------------------------------------------------------------------
// Call history tab
// ---------------------------------------------------------------------------
let history = [];
async function renderHistory() {
  const list = document.getElementById('callList');
  if (!history.length) list.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    history = await loadCallHistory();
  } catch {
    list.innerHTML = emptyState({ iconName: 'alert', title: 'Couldn’t load calls', text: 'Check your connection and try again.' }).value;
    return;
  }
  if (!history.length) {
    list.innerHTML = emptyState({
      iconName: 'phone',
      title: 'No calls yet',
      text: 'Voice and video calls with your team show up here.',
      action: '<button type="button" class="btn primary" data-history="new">Start a call</button>'
    }).value;
    return;
  }
  list.innerHTML = history.map(row => {
    const outgoing = row.caller_id === state.me.id;
    const peerId = outgoing ? row.callee_id : row.caller_id;
    const peer = state.users.get(peerId) || { id: peerId, name: 'Unknown' };
    const missed = !outgoing && ['missed', 'cancelled'].includes(row.status);
    const secs = row.answered_at && row.ended_at ? (new Date(row.ended_at) - new Date(row.answered_at)) / 1000 : 0;
    const outgoingLabel = { declined: 'Declined', busy: 'Busy', cancelled: 'Cancelled', missed: 'No answer' }[row.status] || 'Outgoing';
    const label = missed ? 'Missed' : outgoing ? outgoingLabel : row.status === 'declined' ? 'Declined' : 'Incoming';
    return html`
      <div class="row call-row${missed ? ' missed' : ''}" role="listitem" data-history="open" data-peer="${peerId}" data-kind="${row.kind}" title="${fullDate(row.created_at)}">
        ${avatarHtml(peer, { size: 48, presence: true })}
        <span class="row-main">
          <span class="row-name">${peer.name}</span>
          <span class="row-preview${missed ? ' missed' : ''}">${raw(icon(outgoing ? 'outgoing' : 'incoming', 'xs'))}<span>${label}${secs ? ` · ${duration(secs)}` : ''} · ${listStamp(row.created_at)}</span></span>
        </span>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-history="call" data-peer="${peerId}" data-kind="${row.kind}" aria-label="${row.kind === 'video' ? 'Video' : 'Voice'} call ${peer.name}">${raw(icon(row.kind === 'video' ? 'video' : 'phone'))}</button>
        </span>
      </div>`.value;
  }).join('');
}

function onHistoryClick(e) {
  const t = e.target.closest('[data-history]');
  if (!t) return;
  const act = t.dataset.history;
  if (act === 'new') pickSomeoneToCall();
  else if (act === 'call') startCall(t.dataset.peer, t.dataset.kind);
  else if (act === 'open') {
    showMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Voice call', icon: 'phone', onSelect: () => startCall(t.dataset.peer, 'audio') },
        { label: 'Video call', icon: 'video', onSelect: () => startCall(t.dataset.peer, 'video') },
        { label: 'Message', icon: 'chat', onSelect: () => { location.hash = `#/chat/u/${t.dataset.peer}`; } }
      ]
    });
  }
}

async function pickSomeoneToCall() {
  const { openPeoplePicker } = await import('./groups.js');
  openPeoplePicker({
    title: 'Start a call',
    onPick: (user, kind) => startCall(user.id, kind),
    callMode: true
  });
}

// Missed-call badge on the Calls tab
const SEEN_KEY = 'wazambi-calls-seen';
function markCallsSeen() {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    /* ignore */
  }
  const badge = document.getElementById('callsBadge');
  if (badge) badge.hidden = true;
}

async function refreshMissedBadge() {
  const badge = document.getElementById('callsBadge');
  if (!badge || location.hash.startsWith('#/calls')) return;
  try {
    const since = localStorage.getItem(SEEN_KEY) || new Date(Date.now() - 7 * 86400000).toISOString();
    const { count } = await sb.from('calls').select('id', { count: 'exact', head: true })
      .eq('callee_id', state.me.id).in('status', ['missed', 'cancelled']).gt('created_at', since);
    badge.hidden = !count;
    badge.textContent = String(count || '');
  } catch {
    /* ignore */
  }
}
