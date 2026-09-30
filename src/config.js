export const COLORS = ['#f5b8d4', '#81cbbd', '#edc28c', '#baacf2', '#8bbdeb', '#c3d28d'];
export const CODE_VALUES = ['876', '156', '367', '986'];
export const DIRECTIONS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const DEFAULTS = {
  width: 84, height: 60, speed: 6, tickRate: 30, snapshotRate: 15,
  codeTTL: 40_000, codeRespawn: 7_000, maxPlayers: 48, spawnRadius: 3,
};
