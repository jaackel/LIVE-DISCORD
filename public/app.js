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
let leaving = false;   // clicou em Sair de propósito
let unloading = false; // a página está fechando/recarregando
let clientId = sessionStorage.getItem('live:cid');
if (!clientId) { clientId = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('live:cid', clientId); }
let sharing = false;

// Abas do mesmo navegador/computador na mesma sala: uma não toca o som da outra
// (senão a aba que compartilha a tela capturaria o som da aba que assiste => retorno)
const sameDevice = new Set();
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('live-sitevision') : null;
const announce = (t) => room && bc?.postMessage({ t, room: room.name, id: room.localParticipant.identity });
bc && (bc.onmessage = ({ data }) => {
  if (!room || data.room !== room.name || data.id === room.localParticipant.identity) return;
  if (data.t === 'bye') sameDevice.delete(data.id);
  else {
    if (!sameDevice.has(data.id)) { sameDevice.add(data.id); if (data.t === 'hello') announce('here'); toast('Outra aba sua está nesta sala: o som dela fica mudo aqui para não dar retorno'); }
  }
  render();
});

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom($('name').value.trim(), $('room').value.trim());
});

async function joinRoom(name, roomName) {
  $('joinErr').textContent = '';
  $('joinForm').classList.add('busy');
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
    room.on(RoomEvent.ParticipantConnected, (p) => { toast(`${p.name || p.identity} entrou na sala`); render(); });
    room.on(RoomEvent.ParticipantDisconnected, (p) => { toast(`${p.name || p.identity} saiu da sala`); render(); });
    room.on(RoomEvent.ParticipantNameChanged, render);
    room.on(RoomEvent.TrackMuted, render);
    room.on(RoomEvent.TrackUnmuted, render);
    room.on(RoomEvent.Reconnecting, () => toast('Reconectando...'));
    room.on(RoomEvent.Reconnected, () => toast('Conexão restabelecida'));
    room.on(RoomEvent.ActiveSpeakersChanged, renderUsers);
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!room.canPlaybackAudio) toast('Clique em qualquer lugar da página para ativar o som'); });
    room.on(RoomEvent.Disconnected, leave);
    await room.connect(`${location.origin.replace(/^http/, 'ws')}`, token);

    history.replaceState(null, '', `?sala=${encodeURIComponent(roomName)}`);
    $('roomName').textContent = roomName;
    announce('hello');
    const others = [...room.remoteParticipants.values()].map((p) => p.name || p.identity);
    setTimeout(() => toast(others.length ? `Você entrou. Na sala: ${others.join(', ')}` : 'Você entrou. Por enquanto só você está na sala'), 300);
    $('join').hidden = true;
    $('stage').hidden = false;
    render();
  } catch (err) {
    $('joinForm').classList.remove('busy');
    $('join').hidden = false;
    $('joinErr').textContent = err.message;
  }
}

// Atualizou a página já dentro de uma sala? Volta direto, sem pedir o nome de novo.
{
  const savedName = (localStorage.getItem('live:nome') || '').trim();
  const savedRoom = (params.get('sala') || '').trim();
  if (savedName && savedRoom) joinRoom(savedName, savedRoom);
}

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
    const withAudio = $('shareAudio').checked;
    await room.localParticipant.setScreenShareEnabled(true, {
      // restrictOwnAudio: tira da captura o som da própria live (as vozes dos outros), evitando eco/retorno
      audio: withAudio ? { restrictOwnAudio: true, autoGainControl: false, noiseSuppression: false } : false,
      systemAudio: withAudio ? 'include' : 'exclude',
      suppressLocalAudioPlayback: true,
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

document.addEventListener('click', () => room?.startAudio?.());
$('btnCopy').onclick = () => navigator.clipboard.writeText(location.href);
$('btnLeave').onclick = () => { leaving = true; room?.disconnect(); };

// Fechou a aba/navegador: sai da chamada na hora (não espera o servidor perceber)
const bye = () => { unloading = true; announce('bye'); try { room?.disconnect(true); } catch {} };
window.addEventListener('pagehide', bye);
window.addEventListener('beforeunload', bye);

// Sair de propósito volta ao formulário; queda inesperada recarrega e reentra sozinho
function leave() {
  if (unloading) return;
  if (leaving) location.href = location.pathname;
  else location.reload();
}

const SVG = {
  mic: '<path d="M5 11a7 7 0 0 0 14 0M12 18v4"/><rect x="9" y="2" width="6" height="12" rx="3"/>',
  micOff: '<path d="m2 2 20 20M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7M19 11a7 7 0 0 1-.9 3.4M5 11a7 7 0 0 0 11 5.7M12 18v4"/>',
  cam: '<rect x="2" y="6" width="14" height="12" rx="3"/><path d="m16 10 6-3v10l-6-3"/>',
  camOff: '<path d="m2 2 20 20M16 16v1a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h1m5 0h2a3 3 0 0 1 3 3v2l6-3v10"/>',
};
const ico = (k, on) => `<svg class="${on ? '' : 'off'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[k]}</svg>`;
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function renderUsers() {
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  $('count').textContent = `· ${all.length}`;
  const ul = $('userList');
  ul.replaceChildren();
  for (const p of all) {
    const name = p.name || p.identity;
    const li = document.createElement('li');
    if (p.isSpeaking) li.className = 'speaking';
    const av = document.createElement('div');
    av.className = 'av';
    av.textContent = name.trim().charAt(0).toUpperCase() || '?';
    av.style.background = `linear-gradient(135deg,hsl(${hue(name)} 70% 55%),hsl(${(hue(name) + 40) % 360} 70% 45%))`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    if (p.isLocal) { const s = document.createElement('small'); s.textContent = ' (você)'; nm.append(s); }
    else if (sameDevice.has(p.identity)) { const s = document.createElement('small'); s.textContent = ' (sua outra aba)'; nm.append(s); }
    const st = document.createElement('span');
    st.className = 'st';
    if (p.getTrackPublication(Track.Source.ScreenShare)) st.insertAdjacentHTML('beforeend', '<span class="badge">TELA</span>');
    st.insertAdjacentHTML('beforeend', ico(p.isMicrophoneEnabled ? 'mic' : 'micOff', p.isMicrophoneEnabled) + ico(p.isCameraEnabled ? 'cam' : 'camOff', p.isCameraEnabled));
    li.append(av, nm, st);
    ul.append(li);
  }
}

setInterval(() => { if (room && !$('stage').hidden) { renderUsers(); updateEmpty(ensureEmpty()); } }, 3000);

const tiles = new Map(); // chave -> elemento (vídeos ficam vivos entre renders)

function render() {
  renderUsers();
  const grid = $('grid');
  const want = new Set();
  const empty = ensureEmpty();
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    for (const pub of p.trackPublications.values()) {
      const t = pub.track;
      if (!t || pub.isMuted) continue;
      if (t.kind === 'audio' && (p.isLocal || sameDevice.has(p.identity))) continue; // nunca tocar o próprio som nem o de outra aba sua
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
      const view = document.createElement('div');
      view.className = 'view';
      view.append(el);
      tile.append(view, tag, controls(tile));
      el.addEventListener('dblclick', () => toggleFullscreen(tile));
      tiles.set(key, tile);
      grid.append(tile);
    }
  }
  for (const [key, node] of tiles) {
    if (want.has(key)) continue;
    if (manualPin === key) manualPin = null;
    if (node instanceof HTMLMediaElement) { node.pause(); node.srcObject = null; }
    node.querySelectorAll?.('video').forEach((v) => v.srcObject = null);
    node.remove();
    tiles.delete(key);
  }
  updateLayout();
  updateEmpty(empty);
}

function ensureEmpty() {
  let e = document.getElementById('empty');
  if (!e) { e = document.createElement('div'); e.id = 'empty'; $('grid').prepend(e); }
  return e;
}

function updateEmpty(e) {
  const hasTiles = [...tiles.values()].some((n) => n.classList?.contains('tile'));
  e.hidden = hasTiles;
  if (hasTiles) return;
  const others = [...room.remoteParticipants.values()].map((p) => p.name || p.identity);
  e.replaceChildren();
  const h = document.createElement('strong');
  const s = document.createElement('span');
  if (!others.length) { h.textContent = 'Só você está na sala'; s.textContent = 'Copie o link no topo para convidar outras pessoas.'; }
  else { h.textContent = others.length === 1 ? '1 outra pessoa na sala' : `${others.length} outras pessoas na sala`; s.textContent = others.join(', ') + ' — ninguém com câmera ou tela ligada.'; }
  e.append(h, s);
}

let manualPin = null;
const FITS = [['contain', 'Ajustar'], ['cover', 'Preencher'], ['real', 'Tamanho real']];

function toggleFullscreen(tile) {
  if (document.fullscreenElement) document.exitFullscreen();
  else tile.requestFullscreen?.().catch(() => {});
}

function controls(tile) {
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
  const ZOOMS = [1, 1.25, 1.5, 2, 3, 4];
  let zi = 0;
  const zl = document.createElement('span');
  zl.className = 'z'; zl.textContent = '100%';
  const setZoom = (i) => {
    zi = Math.max(0, Math.min(ZOOMS.length - 1, i));
    tile.style.setProperty('--z', ZOOMS[zi]);
    tile.classList.toggle('zoomed', zi > 0);
    zl.textContent = Math.round(ZOOMS[zi] * 100) + '%';
  };
  const minus = btn('−', () => setZoom(zi - 1));
  const plus = btn('+', () => setZoom(zi + 1));
  minus.title = 'Diminuir'; plus.title = 'Aumentar';
  box.append(minus, zl, plus, fitBtn, pinBtn, fsBtn);
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
