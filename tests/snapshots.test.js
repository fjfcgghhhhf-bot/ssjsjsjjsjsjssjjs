import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, samplePlayer } from '../public/snapshots.js';
import { Game } from '../src/game.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);
const actor = (changes = {}) => ({ id: 1, x: 0, y: 0, dir: 'right', progress: 0,
  trail: [], trailEpoch: 0, trailAnchor: null,
  motion: [{ x: .5, y: .5, time: 0, dir: 'right', trailLength: 0, trailEpoch: 0, trailAnchor: null }], ...changes });
const state = (time, changes = {}) => {
  const distance = time / 1000 * 6;
  return { time, width: 84, height: 60, speed: 6, players: [actor({ x: Math.floor(distance), progress: distance % 1, ...changes })], codes: [] };
};
const cornerTime = 1000 / 6;

test('a new board epoch snaps to the new round without interpolating across reset positions', () => {
  const buffer = new SnapshotBuffer();
  buffer.add({ ...state(100), match: { boardEpoch: 0 } }, 100);
  buffer.sample(110);
  assert.equal(buffer.add({ ...state(200, { x: 50, progress: 0 }), match: { boardEpoch: 1 } }, 200), true);
  assert.equal(buffer.frames.length, 1);
  assert.equal(buffer.sample(200).players[0].position.x, 50.5);
});
const before = actor({ progress: .6 });
const after = actor({ x: 1, dir: 'down', progress: .2, trail: [1], trailAnchor: 0,
  motion: [...before.motion, { x: 1.5, y: .5, time: cornerTime, dir: 'down', trailLength: 1, trailEpoch: 0, trailAnchor: 0 }] });

test('rapid and irregular packets do not rewind the head or change its speed abruptly', () => {
  const buffer = new SnapshotBuffer();
  const packets = [[0,0],[66,66],[99,100],[165,165],[231,260],[264,267],[330,330],[363,364],[429,459],[462,465],[528,530]];
  let i = 0, previous = null;
  for (let now = 0; now <= 620; now += 5) {
    while (i < packets.length && packets[i][1] <= now) { buffer.add(state(packets[i][0]), packets[i][1]); i++; }
    const frame = buffer.sample(now), point = frame.players[0].position;
    if (previous) {
      const dx = point.x - previous.x;
      assert.ok(dx >= -1e-8, `head moved backward at ${now}ms`);
      assert.ok(dx <= 5 / 1000 * 6 * 1.05 + 1e-8, `head jumped at ${now}ms`);
    }
    previous = point;
  }
});

test('a full sync at the same timestamp does not restart interpolation', () => {
  const buffer = new SnapshotBuffer();
  buffer.add(state(0), 0); buffer.add(state(66), 66); buffer.add(state(132), 132);
  const old = buffer.sample(200).players[0].position;
  buffer.add({ ...state(132), grid: Array(84 * 60).fill(0) }, 200);
  assert.deepEqual(buffer.sample(200).players[0].position, old);
});

test('turns pass through the exact corner, without diagonal shortcuts', () => {
  const first = samplePlayer(before, after, 100, 200, 150);
  near(first.position.x, 1.4); near(first.position.y, .5); assert.equal(first.dir, 'right');
  const corner = samplePlayer(before, after, 100, 200, cornerTime);
  near(corner.position.x, 1.5); near(corner.position.y, .5);
  const second = samplePlayer(before, after, 100, 200, 175);
  near(second.position.x, 1.5); near(second.position.y, .55); assert.equal(second.dir, 'down');
});

test('the tail starts continuously and never draws a full cell ahead of the head', () => {
  const first = samplePlayer(before, after, 100, 200, 150);
  assert.deepEqual(first.trail, []); assert.equal(first.trailAnchor, 0);
  const second = samplePlayer(before, after, 100, 200, 175);
  assert.deepEqual(second.trail, [1]); assert.equal(second.trailAnchor, 0);
  near(second.position.x, 1.5);
});

test('a capture clears the tail when the displayed head returns, not on packet arrival', () => {
  const a = actor({ progress: .6, trail: [0], trailAnchor: 84,
    motion: [{ ...before.motion[0], trailLength: 1, trailAnchor: 84 }] });
  const b = actor({ x: 1, dir: 'down', progress: .2, trailEpoch: 1, motion: [
    ...a.motion, { x: 1.5, y: .5, time: cornerTime, dir: 'down', trailLength: 0, trailEpoch: 1, trailAnchor: null },
  ] });
  assert.deepEqual(samplePlayer(a, b, 100, 200, 150).trail, [0]);
  const returned = samplePlayer(a, b, 100, 200, 175);
  assert.deepEqual(returned.trail, []); assert.equal(returned.trailAnchor, null);
});

test('a network stall freezes at authoritative data instead of inventing movement', () => {
  const buffer = new SnapshotBuffer(); buffer.add(state(0), 0); buffer.add(state(66), 66);
  const a = buffer.sample(300), b = buffer.sample(600);
  near(a.time, 66); assert.deepEqual(a.players[0].position, b.players[0].position);
});

test('server restart resets history and does not animate between unrelated lives', () => {
  const buffer = new SnapshotBuffer(); buffer.add(state(5000), 0); buffer.sample(200);
  assert.equal(buffer.add(state(0, { x: 50 }), 250), true);
  const frame = buffer.sample(250); near(frame.players[0].position.x, 50.5);
  assert.equal(buffer.frames.length, 1);
});

test('background tabs retain a bounded snapshot history', () => {
  const buffer = new SnapshotBuffer();
  for (let i = 0; i < 1000; i++) buffer.add(state(i * 66), i * 66);
  assert.equal(buffer.frames.length, 32);
  const frame = buffer.sample(66000); assert.ok(frame.time <= 999 * 66);
});

test('actual game snapshots keep a connected tail through three turns and a capture', () => {
  const game = new Game({ width: 24, height: 24, spawnRadius: 1, random: () => .37 });
  const p = game.addPlayer();
  for (let i = 0; i < game.grid.length; i++) game.setCell(i, 0);
  Object.assign(p, { x: 5, y: 5, dir: 'right', progress: 0, shieldUntil: 0, motion: [] });
  for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) game.setCell(game.index(x, y), p.id);
  game.recordMotion(p, 0); game.drainEvents();
  const packets = [{ state: game.snapshot(), arrivedAt: 0 }];
  let seq = 0, captureTime = null;
  for (let tick = 1; tick <= 200; tick++) {
    if (!p.turns.length) {
      if (p.dir === 'right' && p.x === 9) game.input(p.id, 'down', ++seq);
      else if (p.dir === 'down' && p.y === 9) game.input(p.id, 'left', ++seq);
      else if (p.dir === 'left' && p.x === 6) game.input(p.id, 'up', ++seq);
    }
    game.step(1000 / 30);
    if (game.drainEvents().some(e => e.type === 'captured')) captureTime ??= game.time;
    if (tick % 2 === 0) packets.push({ state: game.snapshot(), arrivedAt: game.time + [0, 18, 3, 12][packets.length % 4] });
    if (captureTime && game.time > captureTime + 100) break;
  }
  assert.ok(captureTime); assert.ok(p.alive);
  const buffer = new SnapshotBuffer(); let i = 0, sawTail = false, sawCapture = false;
  for (let now = 0; now <= packets.at(-1).arrivedAt + 200; now += 5) {
    while (i < packets.length && packets[i].arrivedAt <= now) { buffer.add(packets[i].state, packets[i].arrivedAt); i++; }
    const actor = buffer.sample(now).players[0], point = actor.position;
    if (actor.trail.length) {
      sawTail = true;
      const cell = actor.trail.at(-1), x = cell % game.width + .5, y = Math.floor(cell / game.width) + .5;
      assert.ok(Math.abs(point.x - x) < 1e-8 || Math.abs(point.y - y) < 1e-8, 'tail and head must share an axis');
      assert.ok(Math.abs(point.x - x) + Math.abs(point.y - y) < 1.01, 'tail must not be ahead or more than a cell behind');
    }
    if (actor.trailEpoch === 0 && (point.x > 7.01 || point.y > 7.01)) assert.notEqual(actor.trailAnchor, null, 'head outside base must have a connected ribbon');
    if (actor.trailEpoch > 0) { sawCapture = true; assert.equal(actor.trail.length, 0); }
  }
  assert.ok(sawTail); assert.ok(sawCapture);
});
