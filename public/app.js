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
      body: JSON.stringify({ name, room: roomName }),
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
  const on = !room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(on, { echoCancellation: true, noiseSuppression: true });
  setBtn('btnMic', on);
};
$('btnCam').onclick = async () => {
  const on = !room.localParticipant.isCameraEnabled;
  await room.localParticipant.setCameraEnabled(on, { resolution: VideoPresets.h720.resolution },
    { videoEncoding: { maxBitrate: 2_000_000, maxFramerate: 30 } });
  setBtn('btnCam', on);
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
  } catch (err) { console.warn(err); }
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

function render() {
  renderUsers();
  const grid = $('grid');
  grid.replaceChildren();
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    for (const pub of p.trackPublications.values()) {
      const t = pub.track;
      if (!t || pub.isMuted) continue;
      if (t.kind === 'audio') {
        if (p.isLocal) continue;
        const a = t.attach(); a.hidden = true; grid.append(a); continue;
      }
      const tile = document.createElement('div');
      const isScreen = pub.source === Track.Source.ScreenShare;
      tile.className = 'tile' + (isScreen ? ' screen' : '');
      const v = t.attach(); v.autoplay = true; v.playsInline = true; v.muted = p.isLocal;
      if (p.isLocal && !isScreen) v.style.transform = 'scaleX(-1)';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `${p.name || p.identity}${isScreen ? ' · tela' : ''}`;
      tile.append(v, tag);
      grid.append(tile);
    }
  }
}
setBtn('btnMic', false); setBtn('btnCam', false); setBtn('btnScreen', false);
