import express from 'express';
import httpProxy from 'http-proxy';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const PORT = Number(process.env.PORT || 8086);
const LIVEKIT_INTERNAL = process.env.LIVEKIT_INTERNAL || 'http://127.0.0.1:7880';
if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Defina LIVEKIT_API_KEY e LIVEKIT_API_SECRET');
  process.exit(1);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const proxy = httpProxy.createProxyServer({ target: LIVEKIT_INTERNAL, ws: true });
proxy.on('error', (e, _req, res) => { if (res?.writeHead) { res.writeHead(502); res.end(); } });

app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(root, '../public')));
app.use('/vendor/livekit-client.js',
  (_q, res) => res.sendFile(path.join(root, '../node_modules/livekit-client/dist/livekit-client.umd.js')));

// rate limit simples: 30 entradas/min por IP
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

const clean = (s, n) => String(s ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, n);

app.post('/api/token', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  hits.set(ip, (hits.get(ip) || 0) + 1);
  if (hits.get(ip) > 30) return res.status(429).json({ error: 'muitas tentativas' });

  const name = clean(req.body?.name, 40);
  const room = clean(req.body?.room, 60).toLowerCase().replace(/ +/g, '-');
  if (!name || !room) return res.status(400).json({ error: 'nome e sala são obrigatórios' });

  // clientId fixo por aba: reconectar/atualizar a página substitui a sessão antiga em vez de duplicar
  const cid = /^[a-f0-9]{8,32}$/.test(req.body?.clientId) ? req.body.clientId : randomBytes(4).toString('hex');
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `${cid}`,
    name,
    ttl: '8h',
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt() });
});

// Sinalização do LiveKit passa pelo mesmo domínio (/rtc, /twirp)
app.use(['/rtc', '/twirp'], (req, res) => {
  req.url = req.originalUrl;
  proxy.web(req, res);
});

const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/rtc')) proxy.ws(req, socket, head);
  else socket.destroy();
});
server.listen(PORT, '127.0.0.1', () => console.log(`live app em 127.0.0.1:${PORT}`));
