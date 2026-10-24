// Arène Néon : sert le jeu et relaie les événements de ton live TikTok vers lui.
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.get('/', (req, res) => res.sendFile(path.join(dir, 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// Photos de profil : le serveur les récupère et les renvoie au jeu (même origine, donc elles s'affichent toujours).
const AVATAR_HOST = /(^|\.)(tiktokcdn(-[a-z]+)?\.com|tiktokcdn\.com|ibyteimg\.com|byteimg\.com|muscdn\.com)$/i;
const avatarCache = new Map();
function avatarPath(u) {
  const urls = (u.profilePicture && u.profilePicture.urls) || [];
  const url = urls.find((x) => /^https:/.test(x)) || urls[0];
  return url ? '/avatar?u=' + encodeURIComponent(url) : '';
}
app.get('/avatar', async (req, res) => {
  try {
    const url = new URL(String(req.query.u || ''));
    if (url.protocol !== 'https:' || !AVATAR_HOST.test(url.hostname)) return res.status(400).end();
    let hit = avatarCache.get(url.href);
    if (!hit) {
      const r = await fetch(url.href, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } });
      if (!r.ok) return res.status(502).end();
      hit = { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
      if (hit.body.length > 600000) return res.status(413).end();
      avatarCache.set(url.href, hit);
      if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
    }
    res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=86400').send(hit.body);
  } catch { res.status(400).end(); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let conn = null, current = null, retry = null;
let state = { type: 'status', status: 'idle', user: '', error: '' };

const send = (o) => { const s = JSON.stringify(o); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
const setState = (status, error = '') => { state = { type: 'status', status, user: current || '', error }; send(state); console.log('[live]', status, current || '', error); };
const who = (d) => {
  const u = d.user || {};
  return {
    userId: String(u.userId || u.uniqueId || u.nickname || 'anon'),
    name: u.nickname || u.uniqueId || 'anonyme',
    avatar: avatarPath(u)
  };
};

function stop() {
  clearTimeout(retry); retry = null;
  if (conn) { try { conn.removeAllListeners?.(); conn.disconnect(); } catch {} conn = null; }
}

async function start(username) {
  stop();
  current = username;
  setState('connecting');
  const c = new TikTokLiveConnection(username, {
    signApiKey: process.env.EULER_API_KEY || undefined,
    processInitialData: false
  });
  conn = c;

  c.on(WebcastEvent.GIFT, (d) => {
    const g = d.giftDetails || {};
    if (g.giftType === 1 && !d.repeatEnd) return; // attendre la fin du combo
    send({ type: 'gift', ...who(d), coins: g.diamondCount || 1, repeat: d.repeatCount || 1, gift: g.giftName || 'Gift' });
  });
  c.on(WebcastEvent.CHAT, (d) => send({ type: 'comment', ...who(d), text: d.comment || '' }));
  c.on(WebcastEvent.LIKE, (d) => send({ type: 'like', ...who(d), count: d.likeCount || 1 }));
  c.on(WebcastEvent.FOLLOW, (d) => send({ type: 'follow', ...who(d) }));
  c.on(WebcastEvent.SHARE, (d) => send({ type: 'share', ...who(d) }));
  c.on(WebcastEvent.STREAM_END, () => { if (conn === c) setState('ended'); });
  c.on('disconnected', () => {
    if (conn !== c || current !== username) return;
    setState('reconnecting');
    retry = setTimeout(() => current === username && start(username), 5000);
  });

  try {
    await c.connect();
    if (conn === c) setState('live');
  } catch (e) {
    if (conn !== c) return;
    const offline = /offline|not live|UserOffline|Room ID/i.test(String(e?.name) + String(e?.message));
    setState(offline ? 'offline' : 'error', offline ? '' : String(e?.message || e).slice(0, 160));
    retry = setTimeout(() => current === username && start(username), 15000);
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify(state));
  socket.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.cmd === 'connect' && typeof m.user === 'string') {
      const u = m.user.trim().replace(/^@/, '').slice(0, 64);
      if (u && (u !== current || !conn)) start(u); else socket.send(JSON.stringify(state));
    }
    if (m.cmd === 'disconnect') { current = null; stop(); setState('idle'); }
  });
});

if (process.env.TIKTOK_USERNAME) start(process.env.TIKTOK_USERNAME);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Arène Néon sur le port ' + port));
