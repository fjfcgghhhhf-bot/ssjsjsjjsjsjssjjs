import { Game } from './game.js';
import { CODE_VALUES, COLORS } from './config.js';

/** The global lobby and round lifecycle sit above the territory simulation.
 * Only connected humans who pressed Join count toward the four-player start.
 * Bots and spectators never satisfy the threshold. All clocks are server-owned. */
export class RoundGame extends Game {
  constructor(options = {}) {
    super({ ...options, autoCodes: false });
    this.requiredPlayers = options.requiredPlayers ?? 4;
    this.countdownMs = options.countdownMs ?? 3000;
    this.intermissionMs = options.intermissionMs ?? 8000;
    this.phase = 'waiting';
    this.roundNumber = 0;
    this.boardEpoch = 0;
    this.countdownEndsAt = null;
    this.nextRoundAt = null;
    this.nextCodeAt = null;
    this.collected = [];
    this.botRoster = new Map();
  }

  addPlayer(options = {}) {
    const p = super.addPlayer({ ...options, collection: this.phase === 'playing' ? options.collection ?? [] : [] });
    if (!p) return null;
    p.connected = true;
    if (p.bot) this.botRoster.set(p.name, { name: p.name, color: COLORS.indexOf(p.color), bot: true });
    return p;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (p && !p.bot) p.connected = connected;
  }

  humans() { return [...this.players.values()].filter(p => !p.bot && p.connected); }

  input(id, dir, seq) {
    return this.phase === 'playing' && super.input(id, dir, seq);
  }

  resetBoard() {
    this.boardEpoch++;
    // Keep human IDs so session tokens remain valid between rounds. Reset every
    // owned cell with setCell so existing clients receive a complete clear patch.
    for (let i = 0; i < this.grid.length; i++) this.setCell(i, 0);
    this.trails.clear(); this.codes.clear(); this.botRespawns = [];
    for (const p of this.players.values()) p.alive = false;
    for (const p of this.players.values()) {
      p.codes.clear(); p.kills = 0; p.pickups = 0; p.peak = 0;
      p.trail = []; p.trailAnchor = null; p.trailEpoch++; p.motion = []; p.turns = [];
      p.progress = 0; p.cells = 0; p.botPlan = [];
      if (!p.bot && !p.connected) continue;
      const spawn = this.findSpawn();
      if (!spawn) continue;
      [p.x, p.y] = spawn;
      p.alive = true; p.startedAt = this.time; p.shieldUntil = this.time + 2000;
      p.dir = p.x < this.width / 2 ? 'right' : 'left';
      const r = this.config.spawnRadius;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.setCell(this.index(p.x + dx, p.y + dy), p.id);
      p.peak = p.cells;
      if (p.bot) p.dir = this.botDirection(p);
      this.recordMotion(p, this.time);
    }
    // A bot may have died just before the previous round ended.
    for (const bot of this.botRoster.values()) {
      if (![...this.players.values()].some(p => p.bot && p.name === bot.name && p.alive)) this.addPlayer(bot);
    }
  }

  prepareLobby(reason = 'completed') {
    this.phase = 'waiting';
    this.countdownEndsAt = null; this.nextRoundAt = null; this.nextCodeAt = null;
    this.collected = [];
    this.resetBoard();
    this.emit('lobby-open', { reason });
  }

  startRound() {
    this.resetBoard();
    this.phase = 'playing'; this.roundNumber++;
    this.countdownEndsAt = null; this.nextCodeAt = null; this.collected = [];
    this.emit('round-start', { number: this.roundNumber });
    this.spawnCode(CODE_VALUES[0]);
  }

  finishRound() {
    this.phase = 'finished';
    this.nextRoundAt = this.time + this.intermissionMs;
    this.nextCodeAt = null; this.codes.clear(); this.botRespawns = [];
    this.emit('round-finished', { number: this.roundNumber, collected: [...this.collected], nextRoundAt: this.nextRoundAt });
  }

  updateCodes() {
    if (this.phase !== 'playing') return;
    const current = [...this.codes.values()].find(c => c.active);
    if (current && this.time >= current.expiresAt) {
      this.emit('code-expired', { value: current.value });
      this.codes.clear();
      this.spawnCode(current.value, current);
    } else if (!current && this.nextCodeAt !== null && this.time >= this.nextCodeAt) {
      this.nextCodeAt = null;
      this.spawnCode(CODE_VALUES[this.collected.length]);
    }
  }

  collect(p) {
    if (this.phase !== 'playing' || !p.alive) return;
    const code = [...this.codes.values()].find(c => c.active && c.x === p.x && c.y === p.y);
    if (!code) return;
    this.codes.clear(); // A picked code is never spawned again in this round.
    p.codes.add(code.value); p.pickups++;
    this.collected.push({ value: code.value, playerId: p.id, name: p.name, bot: p.bot });
    const nextValue = CODE_VALUES[this.collected.length] ?? null;
    this.nextCodeAt = nextValue ? this.time + this.config.codeRespawn : null;
    this.emit('code-collected', { value: code.value, playerId: p.id, name: p.name, total: p.codes.size, nextValue });
    // finishRound runs after the tick, once all movement/captures are resolved.
  }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const count = this.humans().length;
    if (this.phase === 'playing') {
      if (!count) { this.time += dt; this.prepareLobby('empty'); this.revision++; return; }
      super.step(dt);
      if (this.collected.length === CODE_VALUES.length) this.finishRound();
      return;
    }
    // Positions, trails and bot AI stay frozen until the round actually starts.
    this.time += dt; this.revision++;
    if (this.phase === 'finished') {
      if (this.time >= this.nextRoundAt) this.prepareLobby();
      return;
    }
    if (count < this.requiredPlayers) {
      if (this.phase === 'countdown') this.emit('countdown-cancelled');
      this.phase = 'waiting'; this.countdownEndsAt = null;
    } else if (this.phase === 'waiting') {
      this.phase = 'countdown'; this.countdownEndsAt = this.time + this.countdownMs;
      this.emit('round-countdown', { endsAt: this.countdownEndsAt });
    } else if (this.time >= this.countdownEndsAt) this.startRound();
  }

  snapshot() {
    const snapshot = super.snapshot();
    const humans = this.humans();
    return { ...snapshot, speed: this.phase === 'playing' ? snapshot.speed : 0,
      match: {
        phase: this.phase, number: this.roundNumber, boardEpoch: this.boardEpoch, requiredPlayers: this.requiredPlayers,
        humanCount: humans.length, botCount: this.botRoster.size,
        readyPlayers: humans.map(p => ({ id: p.id, name: p.name, color: p.color })),
        countdownEndsAt: this.countdownEndsAt, nextRoundAt: this.nextRoundAt,
        collected: this.collected.map(c => ({ ...c })), nextCodeAt: this.nextCodeAt,
        nextCode: this.phase === 'playing' ? CODE_VALUES[this.collected.length] ?? null : null,
      },
    };
  }
}
