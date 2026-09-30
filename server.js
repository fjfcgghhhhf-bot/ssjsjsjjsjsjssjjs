import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { RoundGame } from './src/round-game.js';

const PUBLIC = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const numberEnv = (key, fallback, min, max) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && process.env[key] ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
};

/** One process = one shared global arena, including every connected browser.
 * Exporting the factory makes real HTTP/WebSocket integration tests possible. */
export function createGameServer(options = {}) {
  const game = options.game ?? new RoundGame({
    codeTTL: numberEnv('CODE_TTL_MS', 40000, 1000, 300000),
    codeRespawn: numberEnv('CODE_RESPAWN_MS', 7000, 1000, 60000),
    maxPlayers: numberEnv('MAX_PLAYERS', 48, 2, 100),
  });
  const sessions = new Map(); // Opaque resume token -> session, expires after 30s offline.
  const botCount = options.botCount ?? numberEnv('BOT_COUNT', 2, 0, 12);
  const maxConnections = options.maxConnections ?? numberEnv('MAX_CONNECTIONS', 128, 2, 1024);
  for (let i = 0; i < botCount; i++) game.addPlayer({ name: ['Mochi', 'Orbit', 'Клевер', 'Sunny', 'Pixel', 'Lime'][i % 6], color: i, bot: true });
  game.drainEvents();

  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400, headers).end(); return; }
    if (pathname === '/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? '' : JSON.stringify({ status: 'ok', arena: 'global', players: game.snapshot().players.length, clients: wss.clients.size, phase: game.phase ?? 'playing' }));
      return;
    }
    const target = path.resolve(PUBLIC, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(PUBLIC + path.sep) || !MIME[path.extname(target)]) { res.writeHead(404, headers).end('Not found'); return; }
    try {
      const content = await readFile(target);
      res.writeHead(200, { ...headers, 'Content-Type': `${MIME[path.extname(target)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? '' : content);
    } catch { res.writeHead(404, headers).end('Not found'); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let allowed = req.url === '/ws' && wss.clients.size < maxConnections;
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        allowed &&= process.env.PUBLIC_ORIGIN ? origin.origin === new URL(process.env.PUBLIC_ORIGIN).origin : origin.host === req.headers.host;
      } catch { allowed = false; }
    }
    if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  const send = (ws, payload) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Never drop a terrain patch: a slow socket reconnects with a full map.
    if (ws.bufferedAmount > 256 * 1024) { ws.close(1013, 'slow connection'); return; }
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  const broadcast = payload => {
    const text = JSON.stringify(payload);
    for (const ws of wss.clients) if (ws.session) send(ws, text);
  };
  const full = ws => send(ws, { type: 'state', ...game.snapshot(), grid: [...game.grid], selfId: ws.session?.playerId ?? null });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.windowStart = performance.now(); ws.messageCount = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // Transport errors are cleaned up by close.
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const now = performance.now();
      if (now - ws.windowStart >= 1000) { ws.windowStart = now; ws.messageCount = 0; }
      if (++ws.messageCount > 50) { ws.close(1008, 'rate limit'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.type === 'hello' && !ws.session) {
        let session = typeof msg.token === 'string' ? sessions.get(msg.token) : null;
        if (session?.ws?.readyState === WebSocket.OPEN) session = null;
        if (!session) {
          const token = randomBytes(24).toString('hex');
          session = { token, playerId: null, codes: [], ws: null, disconnectedAt: null };
          sessions.set(token, session);
        }
        session.ws = ws; session.disconnectedAt = null; ws.session = session;
        game.setConnected?.(session.playerId, true);
        const restored = game.players.get(session.playerId);
        if (restored) session.codes = [...restored.codes];
        send(ws, { type: 'hello', token: session.token, selfId: session.playerId, collection: session.codes });
        full(ws);
      } else if (msg.type === 'join' && ws.session) {
        const session = ws.session;
        if (game.players.get(session.playerId)?.alive) { full(ws); return; }
        if (now - (ws.lastJoin ?? -Infinity) < 1000) return;
        ws.lastJoin = now;
        const old = game.players.get(session.playerId);
        if (old) { session.codes = [...old.codes]; game.removePlayer(old.id); }
        const p = game.addPlayer({ name: typeof msg.name === 'string' ? msg.name : 'Игрок', color: msg.color, collection: session.codes });
        if (!p) { send(ws, { type: 'error', message: 'Арена заполнена. Попробуйте через несколько секунд.' }); return; }
        session.playerId = p.id;
        send(ws, { type: 'joined', selfId: p.id, collection: [...p.codes] });
        full(ws);
      } else if (msg.type === 'input' && ws.session) game.input(ws.session.playerId, msg.dir, msg.seq);
      else if (msg.type === 'ping' && ws.session) send(ws, { type: 'pong', nonce: typeof msg.nonce === 'number' ? msg.nonce : 0 });
      else if (msg.type === 'sync' && ws.session) full(ws);
      else if (msg.type === 'leave' && ws.session) {
        const p = game.players.get(ws.session.playerId);
        if (p) ws.session.codes = [...p.codes];
        game.removePlayer(ws.session.playerId);
        ws.session.playerId = null;
        send(ws, { type: 'left' }); full(ws);
      }
    });
    ws.on('close', () => {
      if (ws.session?.ws === ws) {
        ws.session.ws = null; ws.session.disconnectedAt = game.time;
        game.setConnected?.(ws.session.playerId, false);
      }
    });
  });

  let last = performance.now(), snapshotCounter = 0, stopped = false, boardEpoch = game.boardEpoch;
  const simulation = setInterval(() => {
    const now = performance.now();
    game.step(now - last); last = now;
    const events = game.drainEvents();
    if (events.length) {
      for (const session of sessions.values()) {
        const p = game.players.get(session.playerId);
        if (p) session.codes = [...p.codes];
      }
      broadcast({ type: 'events', events });
    }
    for (const [token, session] of sessions) {
      if (session.disconnectedAt !== null && game.time - session.disconnectedAt > 30000) {
        game.removePlayer(session.playerId); sessions.delete(token);
      }
    }
  }, 1000 / game.config.tickRate);
  const snapshots = setInterval(() => {
    const state = { type: 'state', ...game.snapshot(), patch: game.drainPatch() };
    // Periodic full snapshots also recover clients after a suspended tab.
    if (++snapshotCounter % 75 === 0 || game.boardEpoch !== boardEpoch) state.grid = [...game.grid];
    boardEpoch = game.boardEpoch;
    broadcast(state);
  }, 1000 / game.config.snapshotRate);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive || !ws.session) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 15000);

  return {
    server, wss, game,
    listen(port = 3000, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      if (stopped) return; stopped = true;
      clearInterval(simulation); clearInterval(snapshots); clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createGameServer();
  try {
    const address = await app.listen(numberEnv('PORT', 3000, 0, 65535), process.env.HOST || '0.0.0.0');
    console.log(`Paper // Code: http://localhost:${address.port} · one global arena`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.message); await app.close(); process.exitCode = 1; }
}
