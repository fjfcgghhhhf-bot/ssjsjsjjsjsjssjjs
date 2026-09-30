import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { CODE_VALUES } from '../src/config.js';

const make = options => new Game({ width: 24, height: 24, spawnRadius: 1, random: () => .37, ...options });
function player(game, x, y, name = 'Test') {
  const p = game.addPlayer({ name }); assert.ok(p);
  for (let i = 0; i < game.grid.length; i++) if (game.grid[i] === p.id) game.setCell(i, 0);
  p.x = x; p.y = y; p.shieldUntil = 0;
  game.setCell(game.index(x, y), p.id); return p;
}
function trail(game, p, cells) {
  p.trail = cells.map(([x, y]) => game.index(x, y));
  for (const i of p.trail) game.trails.set(i, p.id);
}
function move(game, p, dir) {
  p.dir = dir; p.progress = .99; game.step(10);
}

test('spawn creates a clear base, sanitizes names and chooses a known color', () => {
  const game = make(), p = game.addPlayer({ name: '<img>\u0000Alice', color: -8 });
  assert.equal(p.name, 'imgAlice'); assert.equal(p.cells, 9); assert.equal(p.color, '#8b5cf6');
  const q = game.addPlayer(); assert.ok(q); assert.notEqual(p.id, q.id);
  assert.equal([...game.grid].filter(i => i === p.id).length, 9);
});

test('closing a loop fills its interior and trail, leaving exterior untouched', () => {
  const game = make(), p = player(game, 5, 5);
  for (let y = 5; y <= 9; y++) game.setCell(game.index(5, y), p.id);
  trail(game, p, [[6,5],[7,5],[8,5],[9,5],[9,6],[9,7],[9,8],[9,9],[8,9],[7,9],[6,9]]);
  game.capture(p);
  assert.equal(p.cells, 25); assert.equal(game.grid[game.index(7, 7)], p.id);
  assert.equal(game.grid[game.index(10, 7)], 0); assert.equal(game.trails.size, 0);
  assert.equal(game.drainEvents().find(e => e.type === 'captured').cells, 20);
});

test('an open line captures only its trail, not the whole world', () => {
  const game = make(), p = player(game, 5, 5); trail(game, p, [[6, 5], [7, 5]]);
  game.capture(p); assert.equal(p.cells, 3); assert.equal(game.grid[game.index(6, 6)], 0);
});

test('cutting an enemy trail kills its owner and clears all their land', () => {
  const game = make(), a = player(game, 10, 10, 'A'), b = player(game, 4, 4, 'B');
  trail(game, b, [[11, 10], [12, 10]]); move(game, a, 'right');
  assert.equal(b.alive, false); assert.equal(a.alive, true); assert.equal(a.kills, 1);
  assert.equal(b.cells, 0); assert.equal(game.trails.get(game.index(12, 10)), undefined);
});

test('spawn protection preserves exclusive trail ownership and prevents overlapping heads', () => {
  const game = make(), a = player(game, 10, 10), b = player(game, 14, 10);
  b.shieldUntil = 2000; trail(game, b, [[11, 10], [12, 10]]);
  move(game, a, 'right'); assert.equal(a.x, 10); assert.equal(b.alive, true);
  assert.equal(game.trails.get(game.index(11, 10)), b.id);
  assert.equal(a.trail.length, 0);
  b.x = 12; b.y = 10; a.shieldUntil = 2000;
  game.trails.clear(); b.trail = [];
  a.dir = 'right'; b.dir = 'left'; a.progress = b.progress = .99; game.step(10);
  assert.equal(a.alive, true); assert.equal(b.alive, true); assert.equal(a.x, 10); assert.equal(b.x, 12);
});

test('crossing your own trail and hitting a wall end the round', () => {
  const game = make(), p = player(game, 10, 10); trail(game, p, [[11, 10]]); move(game, p, 'right');
  assert.equal(p.alive, false);
  const q = player(game, 0, 4); move(game, q, 'left'); assert.equal(q.alive, false);
  assert.ok(game.drainEvents().some(e => e.type === 'died' && e.reason === 'wall'));
});

test('simultaneous neutral head collisions kill both, including swapped cells', () => {
  for (const swap of [false, true]) {
    const game = make(), a = player(game, 10, 10), b = player(game, swap ? 11 : 12, 10);
    game.setCell(game.index(a.x, a.y), 0); game.setCell(game.index(b.x, b.y), 0);
    a.dir = 'right'; b.dir = 'left'; a.progress = b.progress = .99; game.step(10);
    assert.equal(a.alive, false); assert.equal(b.alive, false);
  }
});

test('home territory wins a head collision', () => {
  const game = make(), a = player(game, 10, 10), b = player(game, 12, 10);
  game.setCell(game.index(11, 10), a.id);
  a.dir = 'right'; b.dir = 'left'; a.progress = b.progress = .99; game.step(10);
  assert.equal(a.alive, true); assert.equal(b.alive, false); assert.equal(a.kills, 1);
});

test('capture steals enemy land and kills an enclosed vulnerable enemy', () => {
  const game = make(), a = player(game, 5, 5), b = player(game, 7, 7);
  game.setCell(game.index(7, 7), 0); game.setCell(game.index(15, 15), b.id);
  for (let y = 5; y <= 9; y++) game.setCell(game.index(5, y), a.id);
  trail(game, a, [[6,5],[7,5],[8,5],[9,5],[9,6],[9,7],[9,8],[9,9],[8,9],[7,9],[6,9]]);
  game.capture(a); assert.equal(b.alive, false); assert.equal(game.grid[game.index(7, 7)], a.id);
});

test('expired codes move to a different cell and broadcast a fresh spawn', () => {
  const game = make({ codeTTL: 40 }), old = { ...game.codes.get('876') };
  game.drainEvents(); game.step(41);
  const next = game.codes.get('876'); assert.ok(next.active); assert.notDeepEqual([old.x, old.y], [next.x, next.y]);
  assert.equal(next.expiresAt, 81);
  const events = game.drainEvents(); assert.equal(events.filter(e => e.type === 'code-spawn').length, 4);
  assert.ok(events.some(e => e.type === 'code-expired' && e.value === '876'));
});

test('pickup is awarded exactly once; collected code respawns after cooldown', () => {
  const game = make({ codeRespawn: 100 }), p = player(game, 10, 10);
  Object.assign(game.codes.get('876'), { x: 11, y: 10 }); game.drainEvents(); move(game, p, 'right');
  assert.ok(p.codes.has('876')); assert.equal(p.pickups, 1); assert.equal(game.codes.get('876').active, false);
  game.collect(p); assert.equal(p.pickups, 1);
  game.step(101); assert.equal(game.codes.get('876').active, true);
  assert.equal(game.drainEvents().filter(e => e.type === 'code-collected').length, 1);
});

test('all four codes are distinct and collection carries into a new life', () => {
  const game = make(), p = game.addPlayer({ collection: [...CODE_VALUES, 'BAD'] });
  assert.equal(p.codes.size, 4); const codes = [...p.codes]; game.removePlayer(p.id);
  const next = game.addPlayer({ collection: codes }); assert.deepEqual([...next.codes], CODE_VALUES);
  const coords = [...game.codes.values()].map(c => `${c.x},${c.y}`); assert.equal(new Set(coords).size, 4);
});

test('invalid, reversed, duplicate and stale input are rejected', () => {
  const game = make(), p = game.addPlayer();
  p.dir = 'right';
  assert.equal(game.input(p.id, 'teleport', 1), false); assert.equal(game.input(p.id, '__proto__', 2), false);
  assert.equal(game.input(p.id, 'left', 3), false); assert.equal(game.input(p.id, 'down', 4), true);
  assert.equal(game.input(p.id, 'up', 5), false); assert.equal(game.input(p.id, 'down', 4), false);
  assert.equal(game.input(p.id, 'up', Infinity), false);
  assert.ok(p.x >= 0 && p.x < game.width);
});

test('turn occurs on arrival, without skipping cells at a corner', () => {
  const game = make(), p = player(game, 10, 10); p.progress = .99;
  assert.equal(game.input(p.id, 'down', 1), true); game.step(10);
  assert.deepEqual([p.x, p.y, p.dir], [11, 10, 'down']);
  p.progress = .99; game.step(10); assert.deepEqual([p.x, p.y], [11, 11]);
});

test('disconnect removes owned cells and trail; full arena rejects new players', () => {
  const game = make({ maxPlayers: 1 }), p = game.addPlayer(); trail(game, p, [[10, 10]]);
  assert.equal(game.addPlayer(), null); game.removePlayer(p.id);
  assert.equal(game.trails.size, 0); assert.ok([...game.grid].every(i => i === 0));
  assert.ok(game.addPlayer());
});

test('territory patches reconstruct exactly the authoritative grid', () => {
  const game = make(), reconstructed = new Uint16Array(game.grid.length);
  const p = game.addPlayer(); for (const [i, owner] of game.drainPatch()) reconstructed[i] = owner;
  assert.deepEqual(reconstructed, game.grid);
  game.kill(p.id, 'test'); for (const [i, owner] of game.drainPatch()) reconstructed[i] = owner;
  assert.deepEqual(reconstructed, game.grid);
});

test('two minutes of bot simulation maintain owner counts and valid trails', () => {
  const game = new Game(); for (let i = 0; i < 6; i++) game.addPlayer({ name: `Bot${i}`, bot: true, color: i });
  for (let i = 0; i < 3600; i++) { game.step(1000 / 30); game.drainEvents(); game.drainPatch(); }
  for (const p of game.players.values()) {
    assert.ok(p.alive); assert.equal(p.cells, [...game.grid].filter(id => id === p.id).length);
    assert.ok(game.inside(p.x, p.y)); assert.equal(new Set(p.trail).size, p.trail.length);
    for (const cell of p.trail) assert.equal(game.trails.get(cell), p.id);
  }
  for (const owner of game.grid) if (owner) assert.ok(game.players.get(owner)?.alive);
});
