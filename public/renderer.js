import { SnapshotBuffer } from './snapshots.js';

const VECTORS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const mix = (a, b, t) => a + (b - a) * t;
const light = (color, alpha) => {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Canvas world renderer. Game rules live entirely on the server.
 * Head, tail, camera and terrain share the same buffered server timeline. */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = document.createElement('canvas');
    this.terrainCtx = this.terrain.getContext('2d');
    this.cell = 24;
    this.camera = { x: 42, y: 30, scale: 11 };
    this.state = null;
    this.snapshots = new SnapshotBuffer();
    this.pendingTerrain = [];
    this.presentedPlayers = [];
    this.grid = new Uint16Array(84 * 60);
    this.palette = new Map();
    this.selfId = null;
    this.particles = [];
    this.frameAt = performance.now();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    requestAnimationFrame(t => this.frame(t));
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    this.w = box.width; this.h = box.height;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  update(state, selfId) {
    if (this.snapshots.add(state, performance.now())) this.pendingTerrain = [];
    this.pendingTerrain.push(state);
    if (this.pendingTerrain.length > 150) {
      // Hidden tabs still receive packets. Discard old patches only when a full
      // map can replace them, avoiding minutes of repaint work on tab resume.
      const full = this.pendingTerrain.findLastIndex(s => s.grid && s.time <= state.time - this.snapshots.delay);
      if (full > 0) this.pendingTerrain.splice(0, full);
    }
    this.selfId = selfId;
  }

  applyTerrain(state) {
    let paletteChanged = false;
    for (const p of state.players) if (this.palette.get(p.id) !== p.color) { this.palette.set(p.id, p.color); paletteChanged = true; }
    if (this.terrain.width !== state.width * this.cell || this.terrain.height !== state.height * this.cell) {
      this.terrain.width = state.width * this.cell; this.terrain.height = state.height * this.cell;
      this.grid = new Uint16Array(state.width * state.height); paletteChanged = true;
    }
    if (state.grid) { this.grid = Uint16Array.from(state.grid); paletteChanged = true; }
    if (state.patch) for (const [i, owner] of state.patch) this.grid[i] = owner;
    if (paletteChanged) this.paintTerrain();
    else if (state.patch?.length) {
      // A cell change affects the outline of its immediate neighbours as well.
      const repaint = new Set();
      for (const [i] of state.patch) {
        repaint.add(i);
        for (const j of [i - 1, i + 1, i - state.width, i + state.width]) if (j >= 0 && j < this.grid.length) repaint.add(j);
      }
      for (const i of repaint) this.paintCell(i);
    }
  }

  paintTerrain() {
    this.terrainCtx.clearRect(0, 0, this.terrain.width, this.terrain.height);
    for (let i = 0; i < this.grid.length; i++) this.paintCell(i);
  }

  paintCell(i) {
    if (!this.state) return;
    const c = this.cell, x = i % this.state.width, y = Math.floor(i / this.state.width);
    const ctx = this.terrainCtx, owner = this.grid[i], color = this.palette.get(owner) ?? '#f5b8d4';
    ctx.clearRect(x * c, y * c, c, c);
    if (!owner) return;
    ctx.fillStyle = light(color, .34); ctx.fillRect(x * c, y * c, c, c);
    ctx.fillStyle = light(color, .045); ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
    ctx.strokeStyle = light(color, .26); ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (y === 0 || this.grid[i - this.state.width] !== owner) { ctx.moveTo(x * c, y * c + .7); ctx.lineTo((x + 1) * c, y * c + .7); }
    if (y === this.state.height - 1 || this.grid[i + this.state.width] !== owner) { ctx.moveTo(x * c, (y + 1) * c - .7); ctx.lineTo((x + 1) * c, (y + 1) * c - .7); }
    if (x === 0 || this.grid[i - 1] !== owner) { ctx.moveTo(x * c + .7, y * c); ctx.lineTo(x * c + .7, (y + 1) * c); }
    if (x === this.state.width - 1 || this.grid[i + 1] !== owner) { ctx.moveTo((x + 1) * c - .7, y * c); ctx.lineTo((x + 1) * c - .7, (y + 1) * c); }
    ctx.stroke();
  }

  burst(x, y, color = '#f5b8d4') {
    if (this.reducedMotion) return;
    for (let i = 0; i < 16; i++) this.particles.push({ x, y, vx: (Math.random() - .5) * 5, vy: (Math.random() - .5) * 5, age: 0, color });
  }

  frame(now) {
    const dt = Math.min((now - this.frameAt) / 1000, .05); this.frameAt = now;
    const ctx = this.ctx, { w, h } = this;
    if (w && h) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#18141e'; ctx.fillRect(0, 0, w, h);
      if (this.snapshots.frames.length) this.drawWorld(now, dt);
    }
    requestAnimationFrame(t => this.frame(t));
  }

  drawWorld(now, dt) {
    const sample = this.snapshots.sample(now);
    if (!sample) return;
    this.state = sample.state;
    this.presentedPlayers = sample.players;
    while (this.pendingTerrain.length && this.pendingTerrain[0].time <= sample.time) this.applyTerrain(this.pendingTerrain.shift());
    const ctx = this.ctx, state = this.state, players = this.presentedPlayers;
    const self = players.find(p => p.id === this.selfId);
    const target = self ? self.position : { x: state.width / 2, y: state.height / 2 };
    const scale = self ? Math.max(15, Math.min(23, this.w / 30)) : Math.max(this.w / 70, this.h / 47);
    const easing = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.x = mix(this.camera.x, target.x, easing);
    this.camera.y = mix(this.camera.y, target.y, easing);
    this.camera.scale = mix(this.camera.scale, scale, easing);
    const s = this.camera.scale;
    const offsetX = this.w / 2 - this.camera.x * s, offsetY = this.h / 2 - this.camera.y * s;
    ctx.save(); ctx.translate(offsetX, offsetY); ctx.scale(s, s);
    ctx.fillStyle = '#100c15'; ctx.fillRect(-100, -100, state.width + 200, state.height + 200);
    ctx.fillStyle = '#19141f'; ctx.fillRect(0, 0, state.width, state.height);
    ctx.strokeStyle = '#302237'; ctx.lineWidth = .035;
    ctx.beginPath();
    for (let x = 0; x <= state.width; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, state.height); }
    for (let y = 0; y <= state.height; y++) { ctx.moveTo(0, y); ctx.lineTo(state.width, y); }
    ctx.stroke();
    ctx.drawImage(this.terrain, 0, 0, state.width, state.height);
    ctx.strokeStyle = '#80526f'; ctx.lineWidth = .2; ctx.setLineDash([.5, .4]); ctx.strokeRect(0, 0, state.width, state.height); ctx.setLineDash([]);

    for (const p of players) {
      if (!p.trail.length && p.trailAnchor == null) continue;
      const points = [];
      if (p.trailAnchor != null) points.push({ x: p.trailAnchor % state.width + .5, y: Math.floor(p.trailAnchor / state.width) + .5 });
      for (const i of p.trail) points.push({ x: i % state.width + .5, y: Math.floor(i / state.width) + .5 });
      points.push(p.position);
      // One continuous ribbon, ending at the exact pose used for the head.
      // Do not draw future trail cells from the latest network packet.
      ctx.strokeStyle = light(p.color, .7); ctx.lineWidth = .68; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.stroke();
    }

    for (const code of state.codes) {
      if (!code.active) continue;
      const pulse = this.reducedMotion ? 0 : Math.sin(now / 550 + Number(code.value)) * .07;
      ctx.save(); ctx.translate(code.x + .5, code.y + .5 + pulse);
      ctx.shadowColor = '#f5b8d445'; ctx.shadowBlur = s; ctx.shadowOffsetY = s * .2;
      ctx.fillStyle = '#f5b8d4'; ctx.beginPath(); ctx.roundRect(-1.05, -.75, 2.1, 1.5, .22); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.strokeStyle = '#ffe0ee'; ctx.lineWidth = .07; ctx.stroke();
      ctx.fillStyle = '#4a263d'; ctx.font = `700 ${Math.max(.65, 10 / s)}px 'Segoe UI',sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(code.value, 0, .01);
      ctx.fillStyle = '#f5b8d4'; ctx.beginPath(); ctx.moveTo(-.2, .87); ctx.lineTo(.2, .87); ctx.lineTo(0, 1.1); ctx.fill();
      ctx.restore();
    }

    for (const p of players) {
      const pos = p.position;
      ctx.save(); ctx.translate(pos.x, pos.y);
      ctx.fillStyle = light(p.color, .18); ctx.beginPath(); ctx.roundRect(-.55, -.4, 1.1, 1.1, .16); ctx.fill();
      ctx.shadowColor = light(p.color, .3); ctx.shadowBlur = s * .6; ctx.shadowOffsetY = s * .12;
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.roundRect(-.48, -.48, .96, .96, .14); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#ffffff46'; ctx.fillRect(-.33, -.33, .64, .14);
      const [dx, dy] = VECTORS[p.dir];
      ctx.fillStyle = '#ffffffd9';
      const eyeX = dx * .18, eyeY = dy * .18;
      ctx.fillRect(eyeX - .15, eyeY - .08, .1, .12); ctx.fillRect(eyeX + .05, eyeY - .08, .1, .12);
      if (p.shield) { ctx.strokeStyle = '#ffffffb0'; ctx.lineWidth = .08; ctx.beginPath(); ctx.arc(0, 0, .72, 0, Math.PI * 2); ctx.stroke(); }
      ctx.font = `600 ${Math.max(.7, 9 / s)}px 'Segoe UI',sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#211829eb'; const measure = ctx.measureText(p.name).width;
      ctx.beginPath(); ctx.roundRect(-measure / 2 - .22, -1.65, measure + .44, .85, .16); ctx.fill();
      ctx.fillStyle = p.color; ctx.fillText(p.name, 0, -1.02);
      if (p.id === this.selfId) {
        ctx.fillStyle = p.color; ctx.beginPath(); ctx.moveTo(-.23, -2.12); ctx.lineTo(.23, -2.12); ctx.lineTo(0, -1.88); ctx.fill();
      }
      ctx.restore();
    }
    this.particles = this.particles.filter(p => p.age < 1);
    for (const p of this.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; ctx.globalAlpha = 1 - p.age; ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, .18, .18); }
    ctx.globalAlpha = 1; ctx.restore();
    if (self) this.drawMinimap();
    // Edge arrows locate codes outside the viewport during a live round.
    if (self) for (const c of state.codes) {
      if (!c.active) continue;
      const px = offsetX + (c.x + .5) * s, py = offsetY + (c.y + .5) * s;
      if (px > 30 && px < this.w - 30 && py > 30 && py < this.h - 30) continue;
      const dx = px - this.w / 2, dy = py - this.h / 2;
      const factor = Math.min((this.w / 2 - 29) / Math.max(1, Math.abs(dx)), (this.h / 2 - 33) / Math.max(1, Math.abs(dy)));
      const x = this.w / 2 + dx * factor, y = this.h / 2 + dy * factor;
      ctx.fillStyle = '#efb4d0'; ctx.beginPath(); ctx.roundRect(x - 18, y - 10, 36, 20, 5); ctx.fill();
      ctx.fillStyle = '#4a263d'; ctx.font = "600 9px 'Segoe UI',sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(c.value, x, y);
    }
  }

  drawMinimap() {
    const ctx = this.ctx, state = this.state, width = 105, height = width * state.height / state.width;
    const x = this.w - width - 16, y = 17;
    ctx.save(); ctx.globalAlpha = .9; ctx.fillStyle = '#392538'; ctx.beginPath(); ctx.roundRect(x - 5, y - 5, width + 10, height + 10, 7); ctx.fill();
    ctx.fillStyle = '#211829'; ctx.fillRect(x, y, width, height); ctx.drawImage(this.terrain, x, y, width, height);
    for (const p of this.presentedPlayers) { ctx.fillStyle = p.color; const px = x + p.position.x / state.width * width, py = y + p.position.y / state.height * height; ctx.fillRect(px - 1.5, py - 1.5, 3, 3); if (p.id === this.selfId) { ctx.strokeStyle = p.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.stroke(); } }
    for (const c of state.codes) if (c.active) { ctx.fillStyle = '#f5b8d4'; ctx.fillRect(x + c.x / state.width * width - 1, y + c.y / state.height * height - 1, 2, 2); }
    ctx.restore();
  }
}
