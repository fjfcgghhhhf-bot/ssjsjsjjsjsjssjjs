import { Renderer } from './renderer.js';

const $ = id => document.getElementById(id);
const renderer = new Renderer($('game-canvas'));
const VALUES = ['876', '156', '367', '986'];
const storage = {
  read(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  write(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch {} },
};
let socket, selfId = null, state = null, receivedAt = 0;
let seq = Number(storage.read('pc-seq', true)) || 0;
let collection = new Set(), selectedColor = Number(storage.read('pc-color')) || 0;
let mode = 'join', retry = 0, reconnectTimer, connected = false, joinedPending = false;
let sound = false, audio = null, deathSummary = null, resultKey = '';
const nameInput = $('player-name');
nameInput.value = storage.read('pc-name') || 'Игрок';
const serverTime = () => (state?.time ?? 0) + (connected ? performance.now() - receivedAt : 0);
const seconds = end => Math.max(0, Math.ceil((end - serverTime()) / 1000));

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
  $('connection-cover').hidden = ok || mode === 'join';
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
      selfId = msg.selfId; collection = new Set(msg.collection); joinedPending = false; deathSummary = null;
      setConnection(connected);
    } else if (msg.type === 'state') {
      if (Object.hasOwn(msg, 'selfId')) selfId = msg.selfId;
      state = msg; receivedAt = performance.now();
      const me = state.players.find(p => p.id === selfId);
      if (me) collection = new Set(me.codes);
      if (state.match?.phase === 'waiting' || state.match?.phase === 'countdown') collection.clear();
      updateUI();
      renderer.update(state, mode === 'playing' ? selfId : null);
    } else if (msg.type === 'events') for (const event of msg.events) onEvent(event);
    else if (msg.type === 'pong') $('ping').textContent = `${Math.max(1, Math.round(performance.now() - msg.nonce))} ms`;
    else if (msg.type === 'left') { selfId = null; collection.clear(); updateUI(); }
    else if (msg.type === 'error') { joinedPending = false; setConnection(connected); toast('Не получилось войти', msg.message, '!'); }
  });
  socket.addEventListener('close', () => {
    joinedPending = false; setConnection(false);
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000) + Math.random() * 300);
  });
  socket.addEventListener('error', () => socket.close());
}
function join() {
  if (!connected || joinedPending) return;
  joinedPending = true; setConnection(true);
  storage.write('pc-name', nameInput.value.trim() || 'Игрок'); storage.write('pc-color', selectedColor);
  send({ type: 'join', name: nameInput.value.trim() || 'Игрок', color: selectedColor });
}
function leave() {
  send({ type: 'leave' }); selfId = null; collection.clear(); deathSummary = null; updateUI();
}
function setMode(next) {
  const changed = next !== mode; mode = next;
  for (const [id, view] of [['join-form', 'join'], ['lobby-card', 'waiting'], ['death-card', 'dead'], ['result-card', 'finished']]) $(id).hidden = mode !== view;
  $('active-controls').hidden = mode !== 'playing'; $('arena-hud').hidden = mode !== 'playing';
  $('touch-pad').hidden = mode !== 'playing' || !matchMedia('(pointer: coarse), (max-width: 680px)').matches;
  document.querySelector('.map-label').hidden = mode === 'playing';
  if (mode !== 'playing') renderer.selfId = null;
  if (changed && mode === 'playing') $('game-canvas').focus({ preventScroll: true });
  setConnection(connected);
}
const REASONS = {
  wall: 'Край карты оказался ближе. Вернись и попробуй другой маршрут.',
  'self-trail': 'Ты пересёк собственный след. Возвращайся на базу, чтобы замкнуть контур.',
  'tail-cut': 'Соперник перерезал твой хвост. Твои коды сохранены до конца раунда.',
  'head-collision': 'Столкновение с соперником. На своей территории ты сильнее.',
  captured: 'Соперник захватил территорию под тобой, пока ты был вне базы.',
  'no-territory': 'Соперники захватили всю твою территорию.',
};
function onEvent(event) {
  if (event.type === 'code-spawn') toast(`Код ${event.code.value} на карте`, `Доберись первым. Через ${Math.round(event.ttl / 1000)} с он сменит точку.`, event.code.value);
  else if (event.type === 'code-collected') {
    if (event.playerId === selfId) { collection.add(event.value); beep(800, .15); }
    toast(event.playerId === selfId ? `Код ${event.value} — твой!` : `${event.name} забрал ${event.value}`, event.nextValue ? `Следующий — ${event.nextValue}. Скоро на карте.` : 'Все четыре кода найдены. Раунд завершён!', event.value);
  } else if (event.type === 'captured' && event.playerId === selfId) {
    const me = state?.players.find(p => p.id === selfId);
    if (me) renderer.burst(me.x, me.y, me.color);
    beep(600, .08);
  } else if (event.type === 'died' && event.playerId === selfId) {
    deathSummary = event; if (event.summary?.codes) collection = new Set(event.summary.codes); beep(180, .2);
  } else if (event.type === 'round-start') {
    collection.clear(); deathSummary = null; toast('Раунд начался', 'Четыре кода. Один за другим. Удачи!', '↗'); beep(620, .2);
  } else if (event.type === 'countdown-cancelled') toast('Ждём ещё игрока', 'Кто-то вышел. Стартуем, когда снова будет четверо.', '…');
  else if (event.type === 'lobby-open') { collection.clear(); deathSummary = null; }
}
function toast(title, description, badge) {
  const stack = $('toasts');
  while (stack.children.length >= 2) stack.firstElementChild.remove();
  const el = document.createElement('div'); el.className = 'toast';
  const icon = document.createElement('span'); icon.className = 'toast-badge'; icon.textContent = badge;
  const body = document.createElement('div'), heading = document.createElement('strong'), text = document.createElement('span');
  heading.textContent = title; text.textContent = description; body.append(heading, text); el.append(icon, body); stack.append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, 4500);
}

// A small horizontal sequence replaces the former right-hand dashboard.
const codeTiles = new Map();
for (const value of VALUES) {
  const tile = document.createElement('span'); tile.className = 'code-chip'; tile.textContent = value;
  $('code-sequence').append(tile); codeTiles.set(value, tile);
}
function updateTimers() {
  const match = state?.match;
  for (const value of VALUES) {
    const tile = codeTiles.get(value), taken = match?.collected.some(c => c.value === value);
    const active = state?.codes.some(c => c.value === value && c.active);
    tile.classList.toggle('taken', Boolean(taken)); tile.classList.toggle('current', Boolean(active));
    tile.classList.toggle('owned', collection.has(value));
    tile.title = collection.has(value) ? 'Твой код' : taken ? 'Уже найден' : active ? 'На карте' : 'Ждёт своей очереди';
    tile.setAttribute('aria-label', `${value}: ${tile.title}`);
  }
  if (!match) return;
  const current = state.codes.find(c => c.active);
  $('code-status').textContent = match.phase === 'finished' ? '4 / 4 — все найдены' : current ? `На карте: ${current.value} · ${seconds(current.expiresAt)} с` : match.phase === 'playing' && match.nextCodeAt ? `Следующий ${match.nextCode} через ${seconds(match.nextCodeAt)} с` : 'Коды появятся после старта';
  if (match.phase === 'countdown') {
    $('waiting-count').textContent = String(seconds(match.countdownEndsAt));
    $('arena-title').textContent = `Старт через ${seconds(match.countdownEndsAt)} с`;
  }
  if (match.phase === 'finished') $('result-timer').textContent = `Возвращаемся в лобби через ${seconds(match.nextRoundAt)} с`;
}
let rosterKey = '';
function updateUI() {
  if (!state?.match) { setMode('join'); return; }
  const match = state.match, me = state.players.find(p => p.id === selfId);
  const enrolled = match.readyPlayers.some(p => p.id === selfId);
  const next = match.phase === 'finished' ? enrolled ? 'finished' : 'join' : match.phase === 'playing' ? me ? 'playing' : enrolled ? 'dead' : 'join' : enrolled ? 'waiting' : 'join';
  setMode(next);
  $('phase-label').textContent = ({ waiting: 'ЛОББИ', countdown: 'ГОТОВНОСТЬ', playing: 'В ИГРЕ', finished: 'ФИНИШ' })[match.phase];
  $('arena-title').textContent = match.phase === 'playing' ? `Раунд ${match.number} · найдено ${match.collected.length} / 4` : match.phase === 'finished' ? `Раунд ${match.number} завершён` : 'Ждём четырёх игроков';
  $('lobby-title').textContent = match.phase === 'playing' ? 'Глобальная арена' : 'Глобальное лобби';
  $('online-count').textContent = `${match.humanCount}${match.phase === 'playing' ? '' : ` / ${match.requiredPlayers}`} человек · ${match.botCount} бота`;
  $('play-button').querySelector('span').textContent = match.phase === 'playing' ? 'Войти в раунд' : 'Войти в лобби';
  $('waiting-kicker').textContent = match.phase === 'countdown' ? 'ВСЕ ГОТОВЫ' : 'ТЫ В ЛОББИ';
  if (match.phase !== 'countdown') $('waiting-count').replaceChildren(document.createTextNode(String(match.humanCount)), Object.assign(document.createElement('span'), { textContent: `/${match.requiredPlayers}` }));
  $('waiting-title').textContent = match.phase === 'countdown' ? 'Приготовься к старту.' : 'Собираем команду.';
  $('waiting-description').textContent = match.phase === 'countdown' ? 'Следи за своим квадратом. Первый код появится на старте.' : 'Игра начнётся, когда войдут четыре человека. Два бота уже готовы.';
  const key = JSON.stringify(match.readyPlayers);
  if (rosterKey !== key) {
    rosterKey = key; $('lobby-players').replaceChildren();
    for (let i = 0; i < match.requiredPlayers; i++) {
      const p = match.readyPlayers[i], item = document.createElement('div'), dot = document.createElement('span'), name = document.createElement('span');
      item.className = `lobby-player${p ? ' ready' : ''}`; dot.className = 'player-dot'; dot.textContent = p ? p.name.slice(0, 1).toUpperCase() : '+';
      if (p) dot.style.setProperty('--player-color', p.color);
      name.textContent = p?.name || 'Ждём игрока'; item.append(dot, name); $('lobby-players').append(item);
    }
  }
  const roundKey = JSON.stringify(match.collected);
  if (roundKey !== resultKey) {
    resultKey = roundKey; $('round-results').replaceChildren();
    for (const c of match.collected) {
      const row = document.createElement('div'), code = document.createElement('strong'), name = document.createElement('span');
      code.textContent = c.value; name.textContent = c.name + (c.bot ? ' · бот' : ''); row.append(code, name); $('round-results').append(row);
    }
  }
  const sorted = [...state.players].sort((a, b) => b.cells - a.cells || b.kills - a.kills || a.id - b.id);
  $('hud-name').textContent = me?.name || 'Твоя территория';
  $('hud-area').textContent = me ? `${(me.cells / (state.width * state.height) * 100).toFixed(2)}% мира · ${collection.size} / 4 кода` : '0% мира';
  $('hud-rank').textContent = me ? `#${sorted.indexOf(me) + 1}` : '↗';
  document.querySelector('.hud-avatar').style.background = me?.color || '#f5b8d4';
  if (mode === 'dead') {
    const summary = deathSummary?.summary;
    $('death-reason').textContent = REASONS[deathSummary?.reason] || 'Раунд продолжается. Возвращайся в охоту за кодами.';
    $('death-area').textContent = `${((summary?.territory || 0) / (state.width * state.height) * 100).toFixed(1)}%`;
    $('death-kills').textContent = summary?.kills || 0; $('death-codes').textContent = `${collection.size}/4`;
  }
  $('round-state').textContent = ({ join: 'Выбери цвет и присоединяйся', waiting: `Ожидание: ${match.humanCount} / 4 человека`, playing: 'Твой раунд идёт', dead: 'Охота продолжается — можно вернуться', finished: 'Все четыре кода найдены' })[mode];
  updateTimers();
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
for (const id of ['menu-button', 'leave-button', 'waiting-leave', 'result-leave']) $(id).addEventListener('click', leave);
const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', ц: 'up', ы: 'down', ф: 'left', в: 'right' };
document.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea') || $('help-dialog').open || event.repeat) return;
  const dir = keyMap[event.key] || keyMap[event.key.toLowerCase()];
  if (dir && mode === 'playing') { event.preventDefault(); direction(dir); }
});
let touchStart = null;
$('game-canvas').addEventListener('pointerdown', event => { touchStart = { x: event.clientX, y: event.clientY }; $('game-canvas').setPointerCapture(event.pointerId); });
$('game-canvas').addEventListener('pointerup', event => {
  if (!touchStart) return;
  let dx = event.clientX - touchStart.x, dy = event.clientY - touchStart.y; touchStart = null;
  if (event.pointerType === 'mouse' && Math.hypot(dx, dy) < 16) { const box = $('game-canvas').getBoundingClientRect(); dx = event.clientX - box.left - box.width / 2; dy = event.clientY - box.top - box.height / 2; }
  if (Math.hypot(dx, dy) < 16) return;
  direction(Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up');
});
$('game-canvas').addEventListener('pointercancel', () => { touchStart = null; });
document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('pointerdown', event => { event.preventDefault(); direction(button.dataset.dir); }));
const help = $('help-dialog');
$('help-button').addEventListener('click', () => help.showModal());
for (const id of ['close-help', 'got-it']) $(id).addEventListener('click', () => help.close());
help.addEventListener('click', event => { if (event.target === help) { const r = help.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) help.close(); } });
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('arena-panel').requestFullscreen(); }
  catch { toast('Полный экран недоступен', 'Можно увеличить окно браузера.', '↗'); }
});
function beep(frequency, duration = .1) {
  if (!sound || !audio) return;
  const oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = frequency;
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
setInterval(updateTimers, 250);
connect();
