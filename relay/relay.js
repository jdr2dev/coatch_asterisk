// relay.js (ESM)
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

const PORT = process.env.PORT || 7070;

// --- Opcional: JWT simple ---
// Si defines JWT_SECRET, se exigirá token en WS (?token=) o en Authorization: Bearer <token>
// El token DEBERÍA incluir "callId" (scope) o "scope":"*"
const JWT_SECRET = process.env.JWT_SECRET || null;

// --- Límites/backlog ---
const BACKLOG_MAX = parseInt(process.env.BACKLOG_MAX || '50', 10);
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '20000', 10);
const MAX_MSG_SIZE = parseInt(process.env.MAX_MSG_SIZE || '32768', 10); // 32KB
const RATE_LIMIT_RPS = parseFloat(process.env.RATE_LIMIT_RPS || '50');  // por IP
const RATE_LIMIT_BURST = parseInt(process.env.RATE_LIMIT_BURST || '100', 10);

// --- Infra ---
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' })); // ya protege tu /event

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Estado en memoria ---
const rooms = new Map();   // callId -> Set<WebSocket>
const backlog = new Map(); // callId -> evt[]
const roomLru = [];        // mantenemos orden para expulsar callIds viejos
const metrics = {
  startedAt: Date.now(),
  rooms: 0,
  sockets: 0,
  eventsIn: 0,
  eventsFanout: 0,
  droppedBySize: 0,
  droppedNoCallId: 0,
  droppedUnauth: 0,
};

// --- Rate limit muy simple (token-bucket por IP) ---
const buckets = new Map(); // ip -> {tokens, ts}
function allow(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_LIMIT_BURST, ts: now }; buckets.set(ip, b); }
  const elapsed = (now - b.ts) / 1000;
  b.ts = now;
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + elapsed * RATE_LIMIT_RPS);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// --- Helpers ---
function lruTouch(callId) {
  const idx = roomLru.indexOf(callId);
  if (idx >= 0) roomLru.splice(idx, 1);
  roomLru.push(callId);
  // Evict si superamos MAX_ROOMS
  while (roomLru.length > MAX_ROOMS) {
    const evictId = roomLru.shift();
    if (!evictId) break;
    rooms.delete(evictId);
    backlog.delete(evictId);
  }
}

function safeJSON(obj) {
  try { return JSON.stringify(obj); } catch { return null; }
}

function publish(evt) {
  const callId = evt?.callId;
  if (!callId) { metrics.droppedNoCallId++; return; }

  // Validaciones mínimas
  const s = safeJSON(evt);
  if (!s) return;
  if (s.length > MAX_MSG_SIZE) { metrics.droppedBySize++; return; }

  // Backlog
  const arr = backlog.get(callId) || [];
  arr.push(evt);
  if (arr.length > BACKLOG_MAX) arr.shift();
  backlog.set(callId, arr);
  lruTouch(callId);

  // Fanout
  const subs = rooms.get(callId);
  if (!subs || subs.size === 0) return;
  for (const client of subs) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Evita inundar si el buffer va cargado
    if (client.bufferedAmount > MAX_MSG_SIZE * 10) continue;
    client.send(s);
    metrics.eventsFanout++;
  }
}

function verifyJwt(token, expectedCallId) {
  if (!JWT_SECRET) return { ok: true, scope: '*' };
  try {
    const [h, p, sig] = token.split('.');
    const base = `${h}.${p}`;
    const mac = crypto.createHmac('sha256', JWT_SECRET).update(base).digest('base64url');
    if (mac !== sig) return { ok: false, reason: 'bad-signature' };
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return { ok: false, reason: 'expired' };
    const scope = payload.callId || payload.scope;
    if (scope && scope !== '*' && scope !== expectedCallId) {
      return { ok: false, reason: 'scope-mismatch' };
    }
    return { ok: true, scope: scope || '*' };
  } catch {
    return { ok: false, reason: 'invalid-token' };
  }
}

// --- Rutas ---
app.get('/health', (_req, res) => res.send('ok'));

app.get('/stats', (_req, res) => {
  res.json({
    uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    rooms: rooms.size,
    sockets: metrics.sockets,
    eventsIn: metrics.eventsIn,
    eventsFanout: metrics.eventsFanout,
    dropped: {
      noCallId: metrics.droppedNoCallId,
      oversize: metrics.droppedBySize
    }
  });
});

// Recibe eventos de STT/LLM/etc
app.post('/event', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!allow(ip)) return res.status(429).json({ error: 'rate_limited' });

  // Acepta evento único o array de eventos
  const body = req.body;
  const list = Array.isArray(body) ? body : [body];

  for (const evt of list) {
    if (!evt || typeof evt !== 'object') continue;
    if (!evt.callId) continue;
    metrics.eventsIn++;
    publish(evt);
  }
  res.sendStatus(200);
});

// --- WebSocket ---
wss.on('connection', (ws, req) => {
  // URL robusta
  const rawUrl = req.url || '/ws';
  const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  let callId = null;
  let token = null;
  try {
    const u = new URL(rawUrl, base);
    callId = u.searchParams.get('callId');
    token = u.searchParams.get('token') || null;
  } catch {}

  if (!callId) {
    ws.close(1008, 'callId required');
    return;
  }

  // Auth opcional (JWT)
  const hdrToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  const check = verifyJwt(token || hdrToken, callId);
  if (!check.ok) {
    metrics.droppedUnauth++;
    ws.close(1008, `unauthorized:${check.reason}`);
    return;
  }

  // Alta en room
  let set = rooms.get(callId);
  if (!set) rooms.set(callId, (set = new Set()));
  set.add(ws);
  metrics.sockets++;
  lruTouch(callId);

  // Enviar backlog
  const arr = backlog.get(callId) || [];
  for (const evt of arr) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const s = safeJSON(evt);
    if (s && s.length <= MAX_MSG_SIZE) ws.send(s);
  }

  // Heartbeat ping/pong
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Limpieza
  const cleanup = () => {
    try { set.delete(ws); } catch {}
    if (set.size === 0) {
      rooms.delete(callId);
      backlog.delete(callId); // opcional: conservar o limpiar
      const idx = roomLru.indexOf(callId);
      if (idx >= 0) roomLru.splice(idx, 1);
    }
    metrics.sockets = Math.max(0, metrics.sockets - 1);
  };

  ws.on('close', cleanup);
  ws.on('error', (_e) => { try { ws.close(); } catch {} cleanup(); });
});

// Barrido periódico para cerrar zombies
const INTERVAL_PING_MS = 15000;
const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    // @ts-ignore extendemos la instancia
    if (ws.isAlive === false) return ws.terminate();
    // @ts-ignore
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, INTERVAL_PING_MS);

wss.on('close', () => clearInterval(hb));

// Inicio
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RELAY] up on :${PORT}`);
  console.log(`[RELAY] Health:  GET  http://localhost:${PORT}/health`);
  console.log(`[RELAY] Stats:   GET  http://localhost:${PORT}/stats`);
  console.log(`[RELAY] WS URL:  ws://localhost:${PORT}/ws?callId=<callId>[&token=JWT]`);
  console.log(`[RELAY] POST events -> http://localhost:${PORT}/event`);
});
