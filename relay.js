import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 7070;
const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();   // callId -> Set<WebSocket>
const backlog = new Map(); // callId -> evt[]
const BACKLOG_MAX = 50;

function publish(evt) {
  const callId = evt?.callId;
  if (!callId) return;
  const arr = backlog.get(callId) || [];
  arr.push(evt);
  if (arr.length > BACKLOG_MAX) arr.shift();
  backlog.set(callId, arr);
  const subs = rooms.get(callId);
  if (!subs) return;
  const s = JSON.stringify(evt);
  for (const ws of subs) if (ws.readyState === ws.OPEN) ws.send(s);
}

app.get('/health', (_, res) => res.send('ok'));
app.post('/event', (req, res) => {
  if (!req.body?.callId) return res.status(400).json({ error: 'missing callId' });
  publish(req.body);
  res.sendStatus(200);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callId = url.searchParams.get('callId');
  if (!callId) return ws.close(1008, 'callId required');
  let set = rooms.get(callId);
  if (!set) rooms.set(callId, (set = new Set()));
  set.add(ws);
  const arr = backlog.get(callId) || [];
  for (const evt of arr) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
  ws.on('close', () => { set.delete(ws); if (set.size === 0) rooms.delete(callId); });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] listening on :${PORT}  (POST /event, WS /ws?callId=...)`);
});
