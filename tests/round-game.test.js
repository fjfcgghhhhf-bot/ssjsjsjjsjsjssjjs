import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundGame } from '../src/round-game.js';
import { CODE_VALUES } from '../src/config.js';

function arena(options = {}) {
  const game = new RoundGame({ countdownMs: 100, intermissionMs: 100, codeRespawn: 20, ...options });
  game.addPlayer({ name: 'Mochi', bot: true });
  game.addPlayer({ name: 'Orbit', bot: true, color: 1 });
  return game;
}
function humans(game, count = 4) {
  return Array.from({ length: count }, (_, i) => game.addPlayer({ name: `Human ${i}` }));
}
function start(game) { game.step(1); game.step(100); assert.equal(game.phase, 'playing'); }
function pick(game, p) {
  const code = [...game.codes.values()][0]; assert.ok(code);
  p.x = code.x; p.y = code.y; game.collect(p); return code.value;
}

test('no codes, bot movement, or human movement before four connected humans join', () => {
  const game = arena(), players = humans(game, 3);
  const positions = game.snapshot().players.map(p => [p.id, p.x, p.y, p.progress]);
  game.drainEvents(); game.step(60000);
  assert.equal(game.phase, 'waiting'); assert.equal(game.codes.size, 0);
  assert.equal(game.snapshot().match.humanCount, 3); assert.equal(game.snapshot().match.botCount, 2);
  assert.deepEqual(game.snapshot().players.map(p => [p.id, p.x, p.y, p.progress]), positions);
  assert.equal(game.input(players[0].id, 'down', 1), false);
  assert.ok(!game.drainEvents().some(e => e.type === 'code-spawn'));
});

test('the fourth human starts a countdown; disconnect cancels it and reconnect starts a fresh one', () => {
  const game = arena(), players = humans(game);
  game.step(1); assert.equal(game.phase, 'countdown'); assert.equal(game.codes.size, 0);
  game.setConnected(players[3].id, false); game.step(70);
  assert.equal(game.phase, 'waiting'); assert.equal(game.countdownEndsAt, null);
  game.setConnected(players[3].id, true); game.step(1);
  assert.equal(game.phase, 'countdown'); const deadline = game.countdownEndsAt;
  game.step(99); assert.equal(game.codes.size, 0); assert.equal(game.phase, 'countdown');
  game.step(1); assert.equal(game.time, deadline); assert.equal(game.phase, 'playing');
  assert.deepEqual([...game.codes.keys()], ['876']); assert.equal(game.snapshot().players.length, 6);
  assert.ok(game.snapshot().players.every(p => p.shield));
});

test('only the current code relocates on expiry; future codes do not spawn', () => {
  const game = arena({ speed: 0, codeTTL: 50 }); humans(game); start(game);
  const old = { ...game.codes.get('876') }; game.drainEvents(); game.step(50);
  const current = game.codes.get('876');
  assert.equal(game.codes.size, 1); assert.notDeepEqual([current.x, current.y], [old.x, old.y]);
  assert.deepEqual(game.drainEvents().map(e => e.type), ['code-expired', 'code-spawn']);
  assert.equal(game.collected.length, 0);
});

test('codes appear in order once, cannot be double-picked, and the fourth pickup finishes the round', () => {
  const game = arena({ speed: 0 }), players = humans(game); start(game);
  const initialIds = players.map(p => p.id);
  for (const [i, value] of CODE_VALUES.entries()) {
    assert.equal(game.codes.size, 1); assert.equal(pick(game, players[i]), value);
    game.collect(players[i]); assert.equal(game.collected.length, i + 1); assert.equal(game.codes.size, 0);
    game.step(1);
    if (i < 3) {
      assert.equal(game.phase, 'playing'); game.step(18); assert.equal(game.codes.size, 0);
      game.step(1); assert.deepEqual([...game.codes.keys()], [CODE_VALUES[i + 1]]);
    }
  }
  assert.equal(game.phase, 'finished'); assert.equal(game.nextCodeAt, null);
  assert.deepEqual(game.collected.map(c => c.value), CODE_VALUES);
  game.step(99); assert.equal(game.phase, 'finished'); assert.equal(game.codes.size, 0);
  game.step(1); assert.equal(game.phase, 'waiting'); assert.equal(game.codes.size, 0);
  assert.deepEqual([...game.players.values()].filter(p => !p.bot).map(p => p.id), initialIds);
  assert.ok([...game.players.values()].every(p => p.codes.size === 0 && p.trail.length === 0 && p.alive));
  assert.equal(game.collected.length, 0); assert.equal(game.snapshot().match.botCount, 2);
  start(game); assert.equal(game.roundNumber, 2); assert.deepEqual([...game.codes.keys()], ['876']);
});

test('empty active arena returns to a quiet lobby and recreates both bots', () => {
  const game = arena({ speed: 0 }), players = humans(game); start(game);
  const bot = [...game.players.values()].find(p => p.bot); game.kill(bot.id, 'wall');
  for (const p of players) game.setConnected(p.id, false);
  game.step(1); assert.equal(game.phase, 'waiting'); assert.equal(game.codes.size, 0);
  assert.equal(game.snapshot().players.filter(p => p.bot).length, 2);
  game.step(60000); assert.equal(game.codes.size, 0); assert.equal(game.phase, 'waiting');
});

test('leaving after the start does not restart the round; respawn keeps only this round collection', () => {
  const game = arena({ speed: 0 }), players = humans(game); start(game);
  pick(game, players[0]); const codes = [...players[0].codes];
  game.kill(players[0].id, 'wall'); game.removePlayer(players[0].id);
  const returned = game.addPlayer({ name: 'Returned', collection: codes });
  assert.deepEqual([...returned.codes], ['876']);
  game.removePlayer(players[1].id); game.step(1);
  assert.equal(game.phase, 'playing'); assert.equal(game.humans().length, 3);
  game.prepareLobby(); assert.equal(returned.codes.size, 0);
  const newcomer = game.addPlayer({ collection: ['156'] }); assert.equal(newcomer.codes.size, 0);
});
