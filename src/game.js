import { COLORS, CODE_VALUES, DEFAULTS, DIRECTIONS, OPPOSITE } from './config.js';

/** Pure, deterministic simulation: no sockets, browser globals, or real timers.
 * All time comes from step(dt). Inject random for repeatable rule tests. */
export class Game {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.random = options.random ?? Math.random;
    this.width = this.config.width;
    this.height = this.config.height;
    this.grid = new Uint16Array(this.width * this.height);
    this.players = new Map();
    this.trails = new Map(); // Cell index -> owner. Constant-time trail collision.
    this.codes = new Map();
    this.events = [];
    this.dirty = new Map();
    this.time = 0;
    this.nextId = 1;
    this.revision = 0;
    this.botRespawns = [];
    for (const value of CODE_VALUES) this.spawnCode(value);
  }

  index(x, y) { return y * this.width + x; }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  emit(type, data = {}) { this.events.push({ type, time: this.time, ...data }); }

  setCell(index, owner) {
    const old = this.grid[index];
    if (old === owner) return;
    const previous = this.players.get(old);
    const next = this.players.get(owner);
    if (previous) previous.cells--;
    if (next) next.cells++;
    this.grid[index] = owner;
    this.dirty.set(index, owner);
  }

  findSpawn() {
    const r = this.config.spawnRadius;
    const candidates = [];
    // Scan possible clear bases. Never overwrite a live player's land or trail.
    for (let y = r + 2; y < this.height - r - 2; y += 2) {
      for (let x = r + 2; x < this.width - r - 2; x += 2) {
        let clear = true;
        for (let dy = -r - 1; dy <= r + 1 && clear; dy++) {
          for (let dx = -r - 1; dx <= r + 1; dx++) {
            const cell = this.index(x + dx, y + dy);
            if (this.grid[cell] || this.trails.has(cell)) { clear = false; break; }
          }
        }
        if (clear && ![...this.players.values()].some(p => p.alive && Math.hypot(p.x - x, p.y - y) < r + 5)) candidates.push([x, y]);
      }
    }
    return candidates.length ? candidates[Math.floor(this.random() * candidates.length)] : null;
  }

  addPlayer({ name = 'Игрок', color = 0, bot = false, collection = [] } = {}) {
    if ([...this.players.values()].filter(p => p.alive).length >= this.config.maxPlayers) return null;
    const spawn = this.findSpawn();
    if (!spawn) return null;
    // Owners fit in Uint16. Recycle only identifiers no longer present in players.
    let id = this.nextId;
    for (let n = 0; n < 65535 && this.players.has(id); n++) id = id % 65535 + 1;
    if (this.players.has(id)) return null;
    this.nextId = id % 65535 + 1;
    const [x, y] = spawn;
    const initialDirection = x < this.width / 2 ? 'right' : 'left';
    const p = {
      id, name: String(name).replace(/[\p{C}<>]/gu, '').trim().slice(0, 18) || 'Игрок',
      color: COLORS[Number.isInteger(color) && color >= 0 && color < COLORS.length ? color : 0],
      x, y, dir: initialDirection, progress: 0, trail: [], trailAnchor: null, trailEpoch: 0, motion: [], cells: 0,
      alive: true, bot, kills: 0, codes: new Set(collection.filter(c => CODE_VALUES.includes(c))),
      pickups: 0, startedAt: this.time, shieldUntil: this.time + 2000,
      peak: 0, turns: [], lastSeq: -1,
    };
    this.players.set(id, p);
    const r = this.config.spawnRadius;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.setCell(this.index(x + dx, y + dy), id);
    p.peak = p.cells;
    if (bot) p.dir = this.botDirection(p);
    this.recordMotion(p, this.time);
    this.emit('joined', { playerId: id, name: p.name, bot });
    return p;
  }

  input(id, dir, seq) {
    const p = this.players.get(id);
    if (!p?.alive || !Object.hasOwn(DIRECTIONS, dir) || !Number.isSafeInteger(seq) || seq < 0 || seq <= p.lastSeq) return false;
    p.lastSeq = seq;
    // Queue at most two turns. A reverse turn would instantly retrace the tail.
    const previous = p.turns.at(-1) ?? p.dir;
    if (dir === previous || dir === OPPOSITE[previous] || p.turns.length >= 2) return false;
    p.turns.push(dir);
    return true;
  }

  kill(id, reason, killerId = null) {
    const p = this.players.get(id);
    if (!p?.alive) return;
    const summary = { territory: p.peak, kills: p.kills, codes: [...p.codes], duration: this.time - p.startedAt };
    p.alive = false;
    for (const cell of p.trail) if (this.trails.get(cell) === id) this.trails.delete(cell);
    p.trail = []; p.trailAnchor = null;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === id) this.setCell(i, 0);
    const killer = this.players.get(killerId);
    if (killer?.alive) killer.kills++;
    this.emit('died', { playerId: id, killerId, reason, summary });
    if (p.bot) {
      this.botRespawns.push({ at: this.time + 4000, name: p.name, color: COLORS.indexOf(p.color) });
      this.players.delete(id);
    }
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // Disconnecting a human must release their land and exposed trail.
    if (p.alive) this.kill(id, 'disconnect');
    this.players.delete(id);
  }

  capture(p) {
    if (!p.trail.length || !p.alive) return;
    const before = p.cells;
    const vulnerable = [...this.players.values()].filter(o => o.alive && o.id !== p.id && this.grid[this.index(o.x, o.y)] !== o.id);
    // Flood from every boundary cell. Own territory + closed trail are barriers.
    // Everything unreachable from outside is the interior of the closed loop.
    const blocked = new Uint8Array(this.grid.length);
    const visited = new Uint8Array(this.grid.length);
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === p.id) blocked[i] = 1;
    for (const i of p.trail) blocked[i] = 1;
    const queue = new Int32Array(this.grid.length);
    let head = 0, tail = 0;
    const enqueue = i => { if (!blocked[i] && !visited[i]) { visited[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < this.width; x++) { enqueue(x); enqueue(this.index(x, this.height - 1)); }
    for (let y = 0; y < this.height; y++) { enqueue(this.index(0, y)); enqueue(this.index(this.width - 1, y)); }
    while (head < tail) {
      const i = queue[head++], x = i % this.width, y = Math.floor(i / this.width);
      if (x > 0) enqueue(i - 1);
      if (x < this.width - 1) enqueue(i + 1);
      if (y > 0) enqueue(i - this.width);
      if (y < this.height - 1) enqueue(i + this.width);
    }
    for (let i = 0; i < this.grid.length; i++) if (blocked[i] || !visited[i]) this.setCell(i, p.id);
    for (const i of p.trail) if (this.trails.get(i) === p.id) this.trails.delete(i);
    p.trail = []; p.trailAnchor = null; p.trailEpoch++;
    p.peak = Math.max(p.peak, p.cells);
    this.emit('captured', { playerId: p.id, cells: p.cells - before });
    for (const o of vulnerable) if (this.grid[this.index(o.x, o.y)] === p.id && this.time >= o.shieldUntil) this.kill(o.id, 'captured', p.id);
    for (const o of [...this.players.values()]) if (o.alive && o.id !== p.id && o.cells === 0) this.kill(o.id, 'no-territory', p.id);
  }

  spawnCode(value, previous = null) {
    const occupied = new Set([...this.codes.values()].filter(c => c.active).map(c => this.index(c.x, c.y)));
    const choices = [];
    for (let y = 3; y < this.height - 3; y++) for (let x = 3; x < this.width - 3; x++) {
      const i = this.index(x, y);
      if (!occupied.has(i) && !this.trails.has(i) && (!previous || x !== previous.x || y !== previous.y)) choices.push([x, y]);
    }
    if (!choices.length) return;
    const [x, y] = choices[Math.floor(this.random() * choices.length)];
    const code = { value, x, y, active: true, expiresAt: this.time + this.config.codeTTL, respawnAt: null };
    this.codes.set(value, code);
    this.emit('code-spawn', { code: { ...code }, ttl: this.config.codeTTL });
  }

  updateCodes() {
    for (const c of [...this.codes.values()]) {
      if (c.active && this.time >= c.expiresAt) {
        this.emit('code-expired', { value: c.value });
        this.spawnCode(c.value, c); // Expiry relocates immediately, with a new toast.
      } else if (!c.active && this.time >= c.respawnAt) this.spawnCode(c.value, c);
    }
  }

  collect(p) {
    for (const c of this.codes.values()) {
      if (!c.active || c.x !== p.x || c.y !== p.y) continue;
      c.active = false;
      c.respawnAt = this.time + this.config.codeRespawn;
      p.codes.add(c.value);
      p.pickups++;
      this.emit('code-collected', { value: c.value, playerId: p.id, name: p.name, total: p.codes.size });
    }
  }

  botDirection(p) {
    // Bots alternate rectangular excursions with a shortest path home.
    // They obey the same movement, collision, capture and pickup rules as humans.
    const candidates = Object.keys(DIRECTIONS).filter(d => d !== OPPOSITE[p.dir]);
    // Plan compact rectangular loops while at home, so bots grow real filled
    // regions rather than repeatedly extending long narrow strips.
    if (!p.botPlan?.length && !p.trail.length) {
      const clockwise = ['right', 'down', 'left', 'up'];
      for (let attempt = 0; attempt < 8; attempt++) {
        const first = candidates[Math.floor(this.random() * candidates.length)];
        const sign = this.random() > .5 ? 1 : -1;
        const dirs = Array.from({ length: 4 }, (_, n) => clockwise[(clockwise.indexOf(first) + sign * n + 8) % 4]);
        const a = 5 + Math.floor(this.random() * 6), b = 5 + Math.floor(this.random() * 6);
        let x = p.x, y = p.y, valid = true;
        const plan = [];
        for (let side = 0; side < 4; side++) {
          const dir = dirs[side], [dx, dy] = DIRECTIONS[dir], length = side % 2 ? b : a;
          for (let i = 0; i < length; i++) { x += dx; y += dy; plan.push(dir); if (x < 2 || y < 2 || x > this.width - 3 || y > this.height - 3) valid = false; }
        }
        if (valid) { p.botPlan = plan; break; }
      }
    }
    if (p.botPlan?.length) {
      const next = p.botPlan.shift(), [dx, dy] = DIRECTIONS[next];
      const x = p.x + dx, y = p.y + dy;
      if (this.inside(x, y) && this.trails.get(this.index(x, y)) !== p.id) return next;
      p.botPlan = [];
    }
    let best = p.dir, bestScore = -Infinity;
    const returnHome = p.trail.length > 12;
    let home = null;
    if (returnHome) {
      let distance = Infinity;
      for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === p.id) {
        const x = i % this.width, y = Math.floor(i / this.width), d = Math.abs(x - p.x) + Math.abs(y - p.y);
        if (d < distance) { distance = d; home = [x, y]; }
      }
    }
    for (const dir of candidates) {
      const [dx, dy] = DIRECTIONS[dir], x = p.x + dx, y = p.y + dy;
      if (!this.inside(x, y)) continue;
      const i = this.index(x, y);
      if (this.trails.get(i) === p.id) continue;
      let score = this.random() * 1.5 + (dir === p.dir ? 2.8 : 0);
      if (x < 2 || y < 2 || x > this.width - 3 || y > this.height - 3) score -= 15;
      if (home) score -= (Math.abs(x - home[0]) + Math.abs(y - home[1])) * 5;
      if (!p.trail.length && this.grid[i] !== p.id) score += 1.5;
      if (this.trails.has(i) && this.trails.get(i) !== p.id) score += 4;
      if (score > bestScore) { best = dir; bestScore = score; }
    }
    return best;
  }

  recordMotion(p, time) {
    // Exact cell-center times let the renderer follow corners at constant speed.
    // Trail metadata belongs to the same moment as the head, including captures.
    p.motion.push({ x: p.x + .5, y: p.y + .5, time, dir: p.dir,
      trailLength: p.trail.length, trailAnchor: p.trailAnchor, trailEpoch: p.trailEpoch });
    if (p.motion.length > 12) p.motion.shift();
  }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.time += dt;
    this.updateCodes();
    const dueBots = this.botRespawns.filter(b => b.at <= this.time);
    this.botRespawns = this.botRespawns.filter(b => b.at > this.time);
    for (const b of dueBots) if (!this.addPlayer({ ...b, bot: true })) this.botRespawns.push({ ...b, at: this.time + 2000 });
    // A bounded step prevents lag spikes from skipping collision cells.
    const elapsed = Math.min(dt, 100);
    const moving = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.progress += elapsed / 1000 * this.config.speed;
      if (p.progress < 1) continue;
      p.progress -= 1;
      const [dx, dy] = DIRECTIONS[p.dir];
      moving.push({ p, x: p.x + dx, y: p.y + dy });
    }
    const deaths = new Map();
    const held = new Set();
    const mark = (p, reason, killer = null) => { if (!deaths.has(p.id)) deaths.set(p.id, { reason, killer }); };
    const heads = [...this.players.values()].filter(p => p.alive);
    const proposed = new Map(moving.map(m => [m.p.id, m]));
    for (const m of moving) {
      if (!this.inside(m.x, m.y)) { mark(m.p, 'wall'); continue; }
      const cell = this.index(m.x, m.y), trailOwner = this.trails.get(cell);
      if (trailOwner === m.p.id) mark(m.p, 'self-trail');
      else if (trailOwner) {
        const victim = this.players.get(trailOwner);
        if (victim && this.time >= victim.shieldUntil) mark(victim, 'tail-cut', m.p.id);
        else if (victim) held.add(m.p.id);
      }
      for (const other of heads) {
        if (other.id === m.p.id) continue;
        const next = proposed.get(other.id) ?? { x: other.x, y: other.y };
        const same = m.x === next.x && m.y === next.y;
        const swap = m.x === other.x && m.y === other.y && next.x === m.p.x && next.y === m.p.y;
        if (!same && !swap) continue;
        const shieldA = this.time < m.p.shieldUntil, shieldB = this.time < other.shieldUntil;
        if (shieldA && shieldB) { held.add(m.p.id); held.add(other.id); continue; }
        if (shieldA) { mark(other, 'head-collision', m.p.id); continue; }
        if (shieldB) { mark(m.p, 'head-collision', other.id); continue; }
        const ownA = this.grid[cell] === m.p.id;
        const ownB = this.grid[this.index(next.x, next.y)] === other.id;
        if (ownA && !ownB) mark(other, 'head-collision', m.p.id);
        else if (ownB && !ownA) mark(m.p, 'head-collision', other.id);
        else { mark(m.p, 'head-collision'); mark(other, 'head-collision'); }
      }
    }
    // Resolve deaths together, independent of socket/Map insertion order.
    for (const [id, d] of deaths) this.kill(id, d.reason, d.killer);
    const returning = [];
    const arrived = [];
    for (const m of moving) {
      const p = m.p;
      if (!p.alive) continue;
      if (held.has(p.id)) {
        // Protected trails/heads remain exclusive: waiting at the previous
        // cell must not overwrite another owner's trail while immunity lasts.
        p.progress = 0;
        if (p.bot) p.dir = this.botDirection(p);
        else if (p.turns.length) p.dir = p.turns.shift();
        this.recordMotion(p, this.time);
        continue;
      }
      const previousCell = this.index(p.x, p.y);
      p.x = m.x; p.y = m.y;
      const i = this.index(p.x, p.y);
      if (this.grid[i] === p.id) { if (p.trail.length) returning.push(p); }
      else {
        if (!p.trail.length) p.trailAnchor = previousCell;
        p.trail.push(i); this.trails.set(i, p.id);
      }
      this.collect(p);
      // Turn after arriving at a cell center. Rendering progress along the new
      // direction now forms continuous corners instead of teleporting sideways.
      if (p.bot) p.dir = this.botDirection(p);
      else if (p.turns.length) p.dir = p.turns.shift();
      arrived.push(p);
    }
    // All final head positions are installed before testing enclosed opponents.
    for (const p of returning) if (p.alive) this.capture(p);
    for (const p of arrived) if (p.alive) this.recordMotion(p, this.time - p.progress / this.config.speed * 1000);
    this.revision++;
  }

  snapshot() {
    return {
      time: this.time, revision: this.revision, width: this.width, height: this.height,
      speed: this.config.speed, codeTTL: this.config.codeTTL,
      players: [...this.players.values()].filter(p => p.alive).map(p => ({
        id: p.id, name: p.name, color: p.color, bot: p.bot, x: p.x, y: p.y,
        dir: p.dir, progress: p.progress, trail: [...p.trail], cells: p.cells,
        trailAnchor: p.trailAnchor, trailEpoch: p.trailEpoch,
        motion: p.motion.map(point => ({ ...point })),
        kills: p.kills, codes: [...p.codes], pickups: p.pickups,
        shield: this.time < p.shieldUntil,
      })),
      codes: [...this.codes.values()].map(c => ({ ...c })),
    };
  }

  drainEvents() { const events = this.events; this.events = []; return events; }
  drainPatch() { const patch = [...this.dirty]; this.dirty.clear(); return patch; }
}
