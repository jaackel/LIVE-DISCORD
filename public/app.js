const { Room, RoomEvent, Track, VideoPresets } = LivekitClient;

// Qualidade do compartilhamento de tela. "eco" poupa CPU/banda de quem compartilha.
const PRESETS = {
  eco:      { w: 1280, h: 720,  fps: 15, bitrate: 1_500_000,  hint: 'detail' },
  balanced: { w: 1920, h: 1080, fps: 30, bitrate: 5_000_000,  hint: 'detail' },
  max:      { w: 3840, h: 2160, fps: 60, bitrate: 20_000_000, hint: 'detail' },
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
$('room').value = params.get('sala') || '';
$('name').value = localStorage.getItem('live:nome') || '';

let room = null;
let clientId = sessionStorage.getItem('live:cid');
if (!clientId) { clientId = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('live:cid', clientId); }
let sharing = false;

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinErr').textContent = '';
  const name = $('name').value.trim();
  const roomName = $('room').value.trim();
  try {
    localStorage.setItem('live:nome', name);
    const r = await fetch('/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, room: roomName, clientId }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'falha ao entrar');
    const { token } = await r.json();

    room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, render);
    room.on(RoomEvent.TrackUnsubscribed, render);
    room.on(RoomEvent.LocalTrackPublished, render);
    room.on(RoomEvent.LocalTrackUnpublished, render);
    room.on(RoomEvent.ParticipantConnected, render);
    room.on(RoomEvent.ParticipantDisconnected, render);
    room.on(RoomEvent.TrackMuted, render);
    room.on(RoomEvent.TrackUnmuted, render);
    room.on(RoomEvent.Reconnecting, () => toast('Reconectando...'));
    room.on(RoomEvent.Reconnected, () => toast('Conexão restabelecida'));
    room.on(RoomEvent.ActiveSpeakersChanged, renderUsers);
    room.on(RoomEvent.Disconnected, leave);
    await room.connect(`${location.origin.replace(/^http/, 'ws')}`, token);

    history.replaceState(null, '', `?sala=${encodeURIComponent(roomName)}`);
    $('join').hidden = true;
    $('stage').hidden = false;
    render();
  } catch (err) {
    $('joinErr').textContent = err.message;
  }
});

function setBtn(id, on) { $(id).classList.toggle('on', on); $(id).classList.toggle('off', !on); }

$('btnMic').onclick = async () => {
  try {
    const on = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(on, { echoCancellation: true, noiseSuppression: true });
    setBtn('btnMic', on);
  } catch (err) { toast('Microfone: ' + (err.message || err)); }
};
$('btnCam').onclick = async () => {
  try {
    const on = !room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(on, { resolution: VideoPresets.h720.resolution });
    setBtn('btnCam', on);
  } catch (err) { toast('Câmera: ' + (err.message || err)); }
};

$('btnScreen').onclick = async () => {
  try {
    if (sharing) { await room.localParticipant.setScreenShareEnabled(false); sharing = false; setBtn('btnScreen', false); return; }
    const p = PRESETS[$('quality').value];
    await room.localParticipant.setScreenShareEnabled(true, {
      audio: true,
      resolution: { width: p.w, height: p.h, frameRate: p.fps },
      contentHint: p.hint,
      // Sem simulcast: um único fluxo na qualidade escolhida (menos CPU para quem transmite)
    }, {
      videoEncoding: { maxBitrate: p.bitrate, maxFramerate: p.fps },
      videoCodec: 'h264',      // costuma ter encoder por hardware => menos carga no PC
      simulcast: false,
      degradationPreference: 'maintain-resolution',
    });
    sharing = true; setBtn('btnScreen', true);
  } catch (err) { if (err?.name !== 'NotAllowedError') toast('Tela: ' + (err.message || err)); }
};

// Trocar a qualidade durante a transmissão, sem pedir a tela de novo
$('quality').onchange = async () => {
  if (!sharing) return;
  const p = PRESETS[$('quality').value];
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub?.track;
  if (!track) return;
  try {
    await track.mediaStreamTrack.applyConstraints({ width: { max: p.w }, height: { max: p.h }, frameRate: { max: p.fps } });
    const sender = track.sender;
    const par = sender.getParameters();
    par.encodings.forEach((e) => { e.maxBitrate = p.bitrate; e.maxFramerate = p.fps; });
    await sender.setParameters(par);
  } catch (err) { console.warn('ajuste de qualidade:', err); }
};

$('btnCopy').onclick = () => navigator.clipboard.writeText(location.href);
$('btnLeave').onclick = () => room?.disconnect();

function leave() { location.href = location.pathname; }

function renderUsers() {
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  $('count').textContent = `(${all.length})`;
  const ul = $('userList');
  ul.replaceChildren();
  for (const p of all) {
    const li = document.createElement('li');
    if (p.isSpeaking) li.className = 'speaking';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (p.name || p.identity) + (p.isLocal ? ' (você)' : '');
    li.append(nm);
    const icon = (txt, on) => { const s = document.createElement('span'); s.className = 'ic ' + (on ? 'live' : 'off'); s.textContent = txt; return s; };
    const sharing = p.getTrackPublication(Track.Source.ScreenShare);
    if (sharing) li.append(icon('tela', true));
    li.append(icon('mic', p.isMicrophoneEnabled), icon('cam', p.isCameraEnabled));
    ul.append(li);
  }
}

const tiles = new Map(); // chave -> elemento (video ficam vivos entre renders)

function render() {
  renderUsers();
  const grid = $('grid');
  const want = new Set();
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    for (const pub of p.trackPublications.values()) {
      const t = pub.track;
      if (!t || pub.isMuted) continue;
      if (t.kind === 'audio' && p.isLocal) continue;
      const key = `${p.identity}:${pub.trackSid}`;
      want.add(key);
      if (tiles.has(key)) continue;
      const isScreen = pub.source === Track.Source.ScreenShare;
      const el = t.attach();
      if (t.kind === 'audio') { el.hidden = true; tiles.set(key, el); grid.append(el); continue; }
      const tile = document.createElement('div');
      tile.className = 'tile' + (isScreen ? ' screen' : '');
      el.autoplay = true; el.playsInline = true; el.muted = p.isLocal;
      if (p.isLocal && !isScreen) el.style.transform = 'scaleX(-1)';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `${p.name || p.identity}${isScreen ? ' · tela' : ''}`;
      tile.dataset.key = key;
      if (isScreen) tile.dataset.screen = '1';
      tile.append(el, tag, controls(tile, el));
      el.addEventListener('dblclick', () => toggleFullscreen(tile));
      tiles.set(key, tile);
      grid.append(tile);
    }
  }
  for (const [key, node] of tiles) {
    if (want.has(key)) continue;
    if (manualPin === key) manualPin = null;
    node.querySelectorAll?.('video').forEach((v) => v.srcObject = null);
    node.remove();
    tiles.delete(key);
  }
  updateLayout();
}

let manualPin = null;
const FITS = [['contain', 'Ajustar'], ['cover', 'Preencher'], ['real', 'Tamanho real']];

function toggleFullscreen(tile) {
  if (document.fullscreenElement) document.exitFullscreen();
  else tile.requestFullscreen?.().catch(() => {});
}

function controls(tile, video) {
  const box = document.createElement('div');
  box.className = 'ctl';
  const btn = (txt, fn) => { const b = document.createElement('button'); b.textContent = txt; b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
  let fit = 0;
  const fitBtn = btn(FITS[0][1], (b) => {
    fit = (fit + 1) % FITS.length;
    tile.classList.remove('fit-cover', 'fit-real');
    if (FITS[fit][0] !== 'contain') tile.classList.add('fit-' + FITS[fit][0]);
    b.textContent = FITS[fit][1];
  });
  const pinBtn = btn('Fixar', () => { manualPin = manualPin === tile.dataset.key ? null : tile.dataset.key; updateLayout(); });
  pinBtn.className = 'pinbtn';
  const fsBtn = btn('Tela cheia', () => toggleFullscreen(tile));
  box.append(fitBtn, pinBtn, fsBtn);
  return box;
}

// Destaque: o que a pessoa fixou; senão, a primeira tela compartilhada
function updateLayout() {
  let pin = manualPin && tiles.has(manualPin) ? manualPin : null;
  if (!pin) for (const [k, n] of tiles) if (n.classList?.contains('tile') && n.dataset.screen) { pin = k; break; }
  $('grid').classList.toggle('pinned', !!pin && [...tiles.values()].filter((n) => n.classList?.contains('tile')).length > 1);
  for (const [k, n] of tiles) {
    if (!n.classList?.contains('tile')) continue;
    n.classList.toggle('pin', k === pin);
    const pb = n.querySelector('.pinbtn');
    if (pb) { pb.textContent = k === manualPin ? 'Desafixar' : 'Fixar'; pb.classList.toggle('act', k === manualPin); }
  }
}

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
setBtn('btnMic', false); setBtn('btnCam', false); setBtn('btnScreen', false);
