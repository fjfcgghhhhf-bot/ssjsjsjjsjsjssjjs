import { Renderer } from './renderer.js';

const $ = id => document.getElementById(id);
const renderer = new Renderer($('game-canvas'));
const VALUES = ['876', '156', '367', '986'];
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const storage = {
  read(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  write(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch {} },
};
let socket, selfId = null, state = null, receivedAt = 0, seq = Number(storage.read('pc-seq', true)) || 0;
let collection = new Set(), selectedColor = Number(storage.read('pc-color')) || 0;
let mode = 'lobby', retry = 0, reconnectTimer, connected = false, joinedPending = false;
let sound = false, audio = null, lastUiAt = 0;
const nameInput = $('player-name');
nameInput.value = storage.read('pc-name') || 'Player';

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload)); return true;
}

function setConnection(ok) {
  connected = ok;
  const label = $('connection-status'); label.classList.toggle('offline', !ok);
  label.replaceChildren(document.createElement('i'), document.createTextNode(ok ? 'Соединение установлено' : 'Переподключение…'));
  $('play-button').disabled = !ok || joinedPending;
  $('respawn-button').disabled = !ok || joinedPending;
  $('connection-cover').hidden = ok || mode === 'lobby';
  if (!ok) $('ping').textContent = '— ms';
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.addEventListener('open', () => send({ type: 'hello', token: storage.read('pc-token', true) }));
  socket.addEventListener('message', event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'hello') {
      storage.write('pc-token', msg.token, true); selfId = msg.selfId;
      collection = new Set(msg.collection); retry = 0; setConnection(true);
    } else if (msg.type === 'joined') {
      selfId = msg.selfId; collection = new Set(msg.collection); joinedPending = false; setPlaying();
      toast('Твой лист, твоя история', 'Замкни контур, чтобы расширить базу.', '↗'); beep(520);
    } else if (msg.type === 'state') {
      if (Object.hasOwn(msg, 'selfId')) selfId = msg.selfId;
      state = msg; receivedAt = performance.now();
      const me = state.players.find(p => p.id === selfId);
      if (me) {
        collection = new Set(me.codes);
        if (mode !== 'playing') setPlaying();
      } else if (mode === 'playing') showDeath({ reason: 'offline', summary: { territory: 0, kills: 0, codes: [...collection] } });
      renderer.update(state, mode === 'playing' ? selfId : null);
      if (!lastUiAt || performance.now() - lastUiAt > 250) { updateUI(); lastUiAt = performance.now(); }
    } else if (msg.type === 'events') for (const event of msg.events) onEvent(event);
    else if (msg.type === 'pong') $('ping').textContent = `${Math.max(1, Math.round(performance.now() - msg.nonce))} ms`;
    else if (msg.type === 'left') { selfId = null; setLobby(); }
    else if (msg.type === 'error') { joinedPending = false; setConnection(connected); toast('Арена пока занята', msg.message, '!'); }
  });
  socket.addEventListener('close', () => {
    joinedPending = false; setConnection(false);
    // Bounded exponential backoff prevents retry storms after server restart.
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000) + Math.random() * 300);
  });
  socket.addEventListener('error', () => socket.close());
}

function join() {
  if (!connected || joinedPending) return;
  joinedPending = true; setConnection(true);
  storage.write('pc-name', nameInput.value.trim() || 'Player'); storage.write('pc-color', selectedColor);
  send({ type: 'join', name: nameInput.value.trim() || 'Player', color: selectedColor });
}

function setPlaying() {
  mode = 'playing'; joinedPending = false;
  $('join-form').hidden = true; $('death-card').hidden = true; $('active-controls').hidden = false;
  document.querySelector('.map-label').hidden = true;
  $('touch-pad').hidden = !matchMedia('(pointer: coarse), (max-width: 680px)').matches;
  $('round-state').textContent = 'Твой раунд идёт'; $('game-canvas').focus({ preventScroll: true });
  $('connection-cover').hidden = connected;
  setConnection(connected);
}

function setLobby() {
  mode = 'lobby'; joinedPending = false;
  document.querySelector('.map-label').hidden = false;
  $('join-form').hidden = false; $('death-card').hidden = true; $('active-controls').hidden = true; $('touch-pad').hidden = true;
  $('round-state').textContent = 'Наблюдаешь за ареной'; $('connection-cover').hidden = true;
  renderer.selfId = null; setConnection(connected); updateUI();
}

const REASONS = {
  wall: 'Ты достиг края карты. Развернись раньше в следующий раз.',
  'self-trail': 'Ты пересёк собственный след. Держи контур открытым до базы.',
  'tail-cut': 'Соперник перерезал твой хвост. Коллекция кодов остаётся с тобой.',
  'head-collision': 'Столкновение с соперником. На своей территории ты сильнее.',
  captured: 'Соперник захватил территорию под тобой, пока ты был вне базы.',
  'no-territory': 'Соперники захватили всю твою территорию.',
  offline: 'Пока восстанавливалась связь, раунд закончился.',
};
function showDeath(event) {
  if (mode === 'dead') return;
  mode = 'dead'; joinedPending = false;
  document.querySelector('.map-label').hidden = false;
  const summary = event.summary;
  if (summary?.codes) collection = new Set(summary.codes);
  $('death-reason').textContent = REASONS[event.reason] || 'Новый раунд уже ждёт. Твоя коллекция сохранена.';
  $('death-area').textContent = `${((summary?.territory || 0) / ((state?.width || 84) * (state?.height || 60)) * 100).toFixed(1)}%`;
  $('death-kills').textContent = summary?.kills || 0; $('death-codes').textContent = `${collection.size}/4`;
  $('death-card').hidden = false; $('join-form').hidden = true; $('active-controls').hidden = true; $('touch-pad').hidden = true;
  $('round-state').textContent = 'Раунд окончен'; renderer.selfId = null;
  beep(180, .2); updateUI(); setConnection(connected);
}

function onEvent(event) {
  if (event.type === 'code-spawn') toast(`На карте появился код ${event.code.value}`, `До новой точки — ${Math.round(event.ttl / 1000)} секунд. Успей первым!`, event.code.value);
  else if (event.type === 'code-collected') {
    if (event.playerId === selfId) {
      collection.add(event.value); toast(`Код ${event.value} — твой!`, collection.size === 4 ? 'Вся комбинация собрана. Красивый раунд!' : `В коллекции ${collection.size} из 4 кодов.`, '✓');
      const me = state?.players.find(p => p.id === selfId); if (me) renderer.burst(me.x, me.y, me.color);
      beep(800, .15);
    } else toast(`${event.name} забрал ${event.value}`, 'Код вернётся на карту через 7 секунд.', event.value);
  } else if (event.type === 'captured' && event.playerId === selfId) {
    toast('Ещё немного твоего мира', `+${event.cells} клеток территории`, '↗');
    const me = state?.players.find(p => p.id === selfId); if (me) renderer.burst(me.x, me.y, me.color);
    beep(600, .08);
  } else if (event.type === 'died' && event.playerId === selfId) showDeath(event);
  updateCodes();
}

function toast(title, description, badge) {
  const stack = $('toasts');
  while (stack.children.length >= 2) stack.firstElementChild.remove();
  const el = document.createElement('div'); el.className = 'toast';
  const icon = document.createElement('span'); icon.className = 'toast-badge'; icon.textContent = badge;
  const body = document.createElement('div'); const heading = document.createElement('strong'); heading.textContent = title;
  const text = document.createElement('span'); text.textContent = description;
  body.append(heading, text); el.append(icon, body); stack.append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, 4500);
}

const codeTiles = new Map();
for (const value of VALUES) {
  const tile = document.createElement('div'); tile.className = 'code-tile'; tile.dataset.value = value;
  const number = document.createElement('strong'); number.textContent = value;
  const time = document.createElement('span'); time.className = 'code-time';
  const status = document.createElement('div'); status.className = 'code-status';
  const dot = document.createElement('i'), label = document.createElement('span'); label.textContent = 'ожидание'; status.append(dot, label);
  const life = document.createElement('span'); life.className = 'code-life';
  tile.append(number, time, status, life); $('code-grid').append(tile); codeTiles.set(value, { tile, time, label, life });
}

function updateCodes() {
  const time = (state?.time || 0) + (connected ? performance.now() - receivedAt : 0);
  for (const value of VALUES) {
    const el = codeTiles.get(value), c = state?.codes.find(c => c.value === value);
    const owned = collection.has(value);
    el.tile.classList.toggle('collected', owned);
    el.time.textContent = owned ? '✓' : c ? `${Math.max(0, Math.ceil(((c.active ? c.expiresAt : c.respawnAt) - time) / 1000))}с` : '—';
    el.label.textContent = owned ? 'в коллекции' : c?.active ? 'на карте' : c ? 'скоро вернётся' : 'ожидание';
    el.life.style.width = owned ? '100%' : c?.active ? `${Math.max(0, Math.min(100, (c.expiresAt - time) / (state.codeTTL || 40000) * 100))}%` : '0%';
  }
  $('collection-count').replaceChildren(document.createTextNode(`${collection.size} `), Object.assign(document.createElement('span'), { textContent: '/ 4' }));
  $('collection-progress').style.width = `${collection.size / 4 * 100}%`;
  const note = document.querySelector('.code-note');
  if (state) note.lastChild.textContent = ` Через ${Math.round(state.codeTTL / 1000)} секунд код сменит точку`;
}

function updateUI() {
  updateCodes();
  if (!state) return;
  const sorted = [...state.players].sort((a, b) => b.cells - a.cells || b.kills - a.kills || a.id - b.id);
  const me = sorted.find(p => p.id === selfId), humanCount = sorted.filter(p => !p.bot).length, botCount = sorted.filter(p => p.bot).length;
  $('online-count').textContent = `${humanCount} ${plural(humanCount, ['игрок', 'игрока', 'игроков'])} · ${botCount} ${plural(botCount, ['бот', 'бота', 'ботов'])} в игре`;
  const board = $('leaderboard'); board.replaceChildren();
  sorted.slice(0, 5).forEach((p, i) => {
    const row = document.createElement('li'); row.className = `leader-row${p.id === selfId ? ' self' : ''}`;
    const place = document.createElement('span'); place.className = 'place'; place.textContent = i + 1;
    const dot = document.createElement('span'); dot.className = 'leader-dot'; dot.style.background = p.color;
    const name = document.createElement('span'); name.className = 'leader-name'; name.textContent = p.name;
    row.append(place, dot, name);
    if (p.bot) { const tag = document.createElement('span'); tag.className = 'bot-tag'; tag.textContent = 'B'; tag.title = 'Бот'; row.append(tag); }
    const area = document.createElement('span'); area.className = 'leader-area'; area.textContent = `${(p.cells / (state.width * state.height) * 100).toFixed(1)}%`; row.append(area); board.append(row);
  });
  if (!sorted.length) { const row = document.createElement('li'); row.className = 'leader-placeholder'; row.textContent = 'Стань первым на арене'; board.append(row); }
  const rank = $('personal-rank'); rank.classList.toggle('playing', Boolean(me));
  rank.replaceChildren(Object.assign(document.createElement('span'), { textContent: me ? 'Ты уже в игре' : 'Твоё место пока свободно' }), Object.assign(document.createElement('span'), { textContent: me ? `#${sorted.indexOf(me) + 1}` : '—' }));
  $('hud-name').textContent = me ? me.name : 'Твоя территория';
  $('hud-area').textContent = me ? `${(me.cells / (state.width * state.height) * 100).toFixed(2)}% мира · ${me.kills} ${plural(me.kills, ['победа', 'победы', 'побед'])}` : 'Всё начинается с тебя';
  $('hud-rank').textContent = me ? `#${sorted.indexOf(me) + 1}` : '↗';
  document.querySelector('.hud-avatar').style.background = me?.color || '#9466ed';
}

function direction(dir) {
  if (mode !== 'playing' || !connected) return;
  seq++; storage.write('pc-seq', seq, true); send({ type: 'input', dir, seq });
}

function chooseColor(index) {
  selectedColor = Math.max(0, Math.min(5, Number(index) || 0));
  document.querySelectorAll('.color-option').forEach(button => {
    const selected = Number(button.dataset.color) === selectedColor;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
}
document.querySelectorAll('.color-option').forEach(button => button.addEventListener('click', () => chooseColor(button.dataset.color)));
chooseColor(selectedColor);
$('join-form').addEventListener('submit', event => { event.preventDefault(); join(); });
$('respawn-button').addEventListener('click', join);
$('menu-button').addEventListener('click', () => { send({ type: 'leave' }); selfId = null; setLobby(); });
$('leave-button').addEventListener('click', () => { send({ type: 'leave' }); selfId = null; setLobby(); });

const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', ц: 'up', ы: 'down', ф: 'left', в: 'right' };
document.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea') || $('help-dialog').open || event.repeat) return;
  const dir = keyMap[event.key] || keyMap[event.key.toLowerCase()];
  if (dir && mode === 'playing') { event.preventDefault(); direction(dir); }
});
let touchStart = null;
$('game-canvas').addEventListener('pointerdown', event => {
  touchStart = { x: event.clientX, y: event.clientY }; $('game-canvas').setPointerCapture(event.pointerId);
});
$('game-canvas').addEventListener('pointerup', event => {
  if (!touchStart) return;
  let dx = event.clientX - touchStart.x, dy = event.clientY - touchStart.y; touchStart = null;
  if (event.pointerType === 'mouse' && Math.hypot(dx, dy) < 16) {
    const box = $('game-canvas').getBoundingClientRect(); dx = event.clientX - box.left - box.width / 2; dy = event.clientY - box.top - box.height / 2;
  }
  if (Math.hypot(dx, dy) < 16) return;
  direction(Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up');
});
$('game-canvas').addEventListener('pointercancel', () => { touchStart = null; });
document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('pointerdown', event => { event.preventDefault(); direction(button.dataset.dir); }));

const help = $('help-dialog');
for (const id of ['help-button', 'help-nav']) $(id).addEventListener('click', () => help.showModal());
for (const id of ['close-help', 'got-it']) $(id).addEventListener('click', () => help.close());
help.addEventListener('click', event => { if (event.target === help) { const r = help.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) help.close(); } });
function highlight(id) { const el = $(id); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('pulse-card'); requestAnimationFrame(() => el.classList.add('pulse-card')); }
$('leader-nav').addEventListener('click', () => highlight('leader-card'));
$('codes-nav').addEventListener('click', () => highlight('codes-card'));
$('arena-nav').addEventListener('click', () => highlight('arena-panel'));
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('arena-panel').requestFullscreen(); }
  catch { toast('Полный экран недоступен', 'Можно увеличить окно браузера.', '↗'); }
});

function beep(frequency, duration = .1) {
  if (!sound || !audio) return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(.025, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + duration);
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + duration);
}
$('sound-button').addEventListener('click', async () => {
  sound = !sound;
  if (sound) { try { audio ??= new AudioContext(); await audio.resume(); } catch { sound = false; } }
  $('sound-button').classList.toggle('muted', !sound); $('sound-button').setAttribute('aria-pressed', String(sound));
  $('sound-button').setAttribute('aria-label', sound ? 'Выключить звук' : 'Включить звук'); beep(650);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && connected) send({ type: 'sync' }); });
setInterval(() => { if (connected) send({ type: 'ping', nonce: performance.now() }); }, 3000);
setInterval(updateCodes, 250);
connect();
