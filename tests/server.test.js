import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.js';
import { Game } from '../src/game.js';

function inbox(ws) {
  const messages = [], waiters = [];
  let grid = null, latest = null;
  ws.on('message', data => {
    const msg = JSON.parse(data.toString()); messages.push(msg);
    if (msg.type === 'state') {
      latest = msg;
      if (msg.grid) grid = Uint16Array.from(msg.grid);
      if (msg.patch && grid) for (const [i, owner] of msg.patch) grid[i] = owner;
    }
    for (const waiter of [...waiters]) {
      if (!waiter.match(msg)) continue;
      clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(msg);
    }
  });
  return {
    get grid() { return grid; }, get latest() { return latest; }, messages,
    wait(match, timeout = 3000) {
      const existing = messages.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: null };
        waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('WebSocket event timeout')); }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

async function client(url, token = null) {
  const ws = new WebSocket(url), box = inbox(ws); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', token }));
  const hello = await box.wait(m => m.type === 'hello'); await box.wait(m => m.type === 'state' && m.grid);
  return { ws, box, hello, send: msg => ws.send(JSON.stringify(msg)) };
}

test('the default global arena starts with exactly two bots', async t => {
  const previous = process.env.BOT_COUNT; delete process.env.BOT_COUNT;
  const app = createGameServer();
  if (previous !== undefined) process.env.BOT_COUNT = previous;
  t.after(() => app.close());
  assert.equal(app.game.snapshot().players.filter(p => p.bot).length, 2);
});

test('real WebSocket clients share one arena, terrain, pickup and expiry events', async t => {
  const game = new Game({ codeTTL: 250, codeRespawn: 100, random: () => .4 });
  const app = createGameServer({ game, botCount: 0 }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), url = `ws://127.0.0.1:${address.port}/ws`;
  const a = await client(url), b = await client(url);
  a.send({ type: 'join', name: 'Альфа', color: 0 }); b.send({ type: 'join', name: 'Бета', color: 1 });
  const joinedA = await a.box.wait(m => m.type === 'joined'), joinedB = await b.box.wait(m => m.type === 'joined');
  assert.notEqual(joinedA.selfId, joinedB.selfId);
  await Promise.all([a.box.wait(m => m.type === 'state' && m.players.length === 2), b.box.wait(m => m.type === 'state' && m.players.length === 2)]);
  assert.deepEqual(a.box.grid, b.box.grid); assert.deepEqual(a.box.grid, game.grid);
  assert.ok(a.box.latest.players.some(p => p.name === 'Бета'));

  const p = game.players.get(joinedA.selfId);
  // Position a real server-owned collectible in front of A; neither client can
  // dictate position or send a pickup event through the public protocol.
  const c = game.codes.get('876'); c.x = p.x + (p.dir === 'left' ? -1 : 1); c.y = p.y; c.expiresAt = game.time + 2000;
  p.progress = .99;
  const collected = m => m.type === 'events' && m.events.some(e => e.type === 'code-collected' && e.value === '876');
  const [eventA, eventB] = await Promise.all([a.box.wait(collected), b.box.wait(collected)]);
  assert.deepEqual(eventA, eventB); assert.ok(p.codes.has('876'));
  const spawn = m => m.type === 'events' && m.events.some(e => e.type === 'code-spawn');
  const [spawnA, spawnB] = await Promise.all([a.box.wait(spawn), b.box.wait(spawn)]); assert.deepEqual(spawnA, spawnB);

  const before = { x: p.x, y: p.y };
  a.send({ type: 'input', dir: 'teleport', seq: 7, x: -1000, y: -1000 });
  a.send({ type: 'code-collected', value: '156', playerId: p.id });
  assert.equal(p.codes.has('156'), false); assert.ok(Math.abs(p.x - before.x) <= 2 && p.y >= 0);

  const token = a.hello.token, id = p.id;
  a.ws.close(); await once(a.ws, 'close');
  const resumed = await client(url, token); assert.equal(resumed.hello.selfId, id); assert.ok(resumed.hello.collection.includes('876'));
  const duplicate = await client(url, token); assert.notEqual(duplicate.hello.token, token); assert.equal(duplicate.hello.selfId, null);
  resumed.send({ type: 'leave' }); await resumed.box.wait(m => m.type === 'left');
  assert.equal(game.players.has(id), false); assert.ok([...game.grid].every(owner => owner !== id));
});

test('HTTP serves only public assets and rejects cross-origin upgrades', async t => {
  const app = createGameServer({ botCount: 0 }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /game-canvas/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const js = await fetch(`${base}/app.js`); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  const health = await fetch(`${base}/health`); assert.equal((await health.json()).arena, 'global');
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'https://unrelated.example' });
  const error = await once(ws, 'error'); assert.match(error[0].message, /403/);
});

test('disconnected sessions expire and release territory after the grace period', async t => {
  const app = createGameServer({ botCount: 0 }); t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1');
  const a = await client(`ws://127.0.0.1:${address.port}/ws`);
  a.send({ type: 'join', name: 'Temporary' }); const joined = await a.box.wait(m => m.type === 'joined');
  const serverClosed = once([...app.wss.clients][0], 'close');
  a.ws.close(); await Promise.all([once(a.ws, 'close'), serverClosed]);
  app.game.step(31000); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(app.game.players.has(joined.selfId), false);
  assert.ok([...app.game.grid].every(i => i !== joined.selfId));
});
