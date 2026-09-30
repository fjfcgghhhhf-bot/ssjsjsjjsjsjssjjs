const VECTORS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function position(player) {
  const [dx, dy] = VECTORS[player.dir] ?? [0, 0];
  return { x: player.x + .5 + dx * player.progress, y: player.y + .5 + dy * player.progress };
}

/** Pure snapshot playback, shared with Node regression tests.
 * Packet arrivals never restart an animation. A 100ms buffer absorbs the usual
 * 15Hz delivery jitter; the monotonic playhead drives head, tail and territory. */
export class SnapshotBuffer {
  constructor({ delay = 100 } = {}) {
    this.delay = delay;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.offset = null;
    this.offsetSamples = [];
    this.playhead = -Infinity;
    this.lastNow = null;
  }

  add(state, now) {
    const newest = this.frames.at(-1);
    // A fresh round relocates avatars. Never interpolate across that reset.
    const restarted = Boolean(newest && (state.time < newest.state.time || state.match?.boardEpoch !== newest.state.match?.boardEpoch));
    if (restarted) this.reset();
    const offset = state.time - now;
    this.offsetSamples.push(offset);
    if (this.offsetSamples.length > 30) this.offsetSamples.shift();
    if (this.offset === null) this.offset = offset;
    const frame = { state, players: new Map(state.players.map(p => [p.id, p])) };
    if (this.frames.at(-1)?.state.time === state.time) this.frames[this.frames.length - 1] = frame;
    else this.frames.push(frame);
    // Keep enough history to cope with coalesced packets after short stalls.
    while (this.frames.length > 32) this.frames.shift();
    return restarted;
  }

  sample(now) {
    if (!this.frames.length) return null;
    const dt = this.lastNow === null ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    const targetOffset = Math.max(...this.offsetSamples);
    // Clock correction is limited to 5% of elapsed time. Irregular packet
    // arrival therefore cannot jump the player backward or teleport it forward.
    this.offset += clamp(targetOffset - this.offset, -dt * .05, dt * .05);
    const newest = this.frames.at(-1);
    this.playhead = Math.max(this.playhead, Math.min(now + this.offset - this.delay, newest.state.time));
    let before = this.frames[0], after = before;
    for (const frame of this.frames) {
      if (frame.state.time <= this.playhead) before = frame;
      if (frame.state.time >= this.playhead) { after = frame; break; }
      after = frame;
    }
    const time = Math.max(before.state.time, this.playhead);
    const players = before.state.players.map(p => samplePlayer(p, after.players.get(p.id), before.state.time, after.state.time, time, newest.players.get(p.id)));
    return { time, state: before.state, players };
  }
}

export function samplePlayer(before, after, beforeTime, afterTime, time, lookahead = after) {
  if (!after || afterTime <= beforeTime) return { ...before, position: position(before) };
  const start = position(before), end = position(after);
  // Cell-center milestones are authoritative right-angle route vertices.
  // A plain x/y lerp cuts diagonally across turns and disconnects the ribbon.
  const corners = (after.motion ?? []).filter(point => point.time > beforeTime && point.time <= afterTime);
  const route = [{ ...start, time: beforeTime }, ...corners, { ...end, time: afterTime }];
  let a = route[0], b = route.at(-1);
  for (let i = 1; i < route.length; i++) {
    if (time <= route[i].time) { a = route[i - 1]; b = route[i]; break; }
  }
  const t = b.time > a.time ? clamp((time - a.time) / (b.time - a.time), 0, 1) : 1;
  const pose = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  // A tick can report arrival at a corner whose precise crossing time equals
  // the preceding snapshot time. Include that milestone's metadata as well.
  const milestones = [...(before.motion ?? []), ...(after.motion ?? [])];
  let current = null, upcoming = null;
  for (const point of milestones) if (point.time <= time && (!current || point.time >= current.time)) current = point;
  // The next cell can lie just beyond the two snapshots used for this pose.
  // The buffered lookahead tells us that it is an exit without moving the head
  // or drawing that future cell before its center is actually reached.
  for (const point of lookahead?.motion ?? []) if (point.time > time) { upcoming = point; break; }

  if (!current) return { ...before, position: pose };
  const source = after.trailEpoch === current.trailEpoch ? after : before;
  const trail = source.trail.slice(0, current.trailLength);
  // Begin the moving ribbon from the last base cell as soon as the head leaves
  // it. Append a full trail cell only once the displayed head reaches its center.
  const pendingExit = !trail.length && upcoming?.trailLength === 1 && upcoming.trailEpoch === current.trailEpoch;
  return { ...before, position: pose, dir: current.dir,
    trail, trailEpoch: current.trailEpoch,
    trailAnchor: pendingExit ? upcoming.trailAnchor : current.trailAnchor };
}
