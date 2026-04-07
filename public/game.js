const socket = io();

// DOM
const lobbyEl = document.getElementById('lobby');
const waitingEl = document.getElementById('waiting');
const waitingRoomEl = document.getElementById('waitingRoom');
const waitingCountEl = document.getElementById('waitingCount');
const gameScreenEl = document.getElementById('gameScreen');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreP1El = document.getElementById('scoreP1');
const scoreP2El = document.getElementById('scoreP2');
const overlayEl = document.getElementById('overlay');
const overlayTextEl = document.getElementById('overlayText');
const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const modeDescEl = document.getElementById('modeDesc');
const movesListEl = document.getElementById('movesList');
const winTargetEl = document.getElementById('winTarget');
const rodInfoEl = document.getElementById('rodInfoList');

// State
let myPlayerNum = 0;
let myTeam = 0;
let mySlot = null;
let gameMode = '2p';
let gameState = null;
let TABLE = null;
let myRods = [];
let specialMoves = {};
let winScore = 10;
let rodConfig = [];

// Rod selection
const heldRodKeys = new Set();
let selectedRodSlots = [];

// Mouse
let mouseLocked = false;
const MOUSE_SENSITIVITY = 1.8;
let gameActive = false;
let mouseVelX = 0;
let mouseVelY = 0;
const MOUSE_VEL_DECAY = 0.8;
const POWER_SCALE = 0.015;
const ANGLE_SCALE = 0.008;

// Special move tracking
let selfieFirstTap = 0;
let activePPSquare = false;
let activeCornettoPhase = null;
let spinCharging = false;
let spinCharge = 0;
let spinDir = 1;
let fakeShotFirstTap = 0;
let spinVisualAngle = 0;

// Tooltip state
let hoveredMoveId = null;

// ============================================================
// MODE SELECT
// ============================================================

let selectedMode = '2p';
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedMode = btn.dataset.mode;
    modeDescEl.textContent = selectedMode === '2p'
      ? 'Each player controls all 4 rods on their side.'
      : '2v2: One player plays GK+DEF, the other plays MID+ATK.';
  });
});

// ============================================================
// CONNECTION
// ============================================================

joinBtn.addEventListener('click', joinRoom);
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const roomId = roomInput.value.trim();
  if (!roomId) return;
  gameMode = selectedMode;
  socket.emit('joinRoom', { roomId, mode: gameMode });
  waitingRoomEl.textContent = roomId;
}

socket.on('joined', (data) => {
  myPlayerNum = data.playerNum;
  myTeam = data.team;
  mySlot = data.slot;
  gameMode = data.mode;
  gameState = data.state;
  TABLE = data.table;
  myRods = data.myRodIndices;
  specialMoves = data.specialMoves;
  winScore = data.winScore || 10;
  rodConfig = data.rodConfig || [];
  winTargetEl.textContent = winScore;
  selectedRodSlots = myRods.length > 0 ? [0] : [];
});

socket.on('waitingForOpponent', (data) => {
  lobbyEl.classList.add('hidden');
  waitingEl.classList.remove('hidden');
  waitingCountEl.textContent = `Players: ${data.current}/${data.needed}`;
});

socket.on('playerJoined', (data) => {
  waitingCountEl.textContent = `Players: ${data.current}/${data.needed}`;
});

socket.on('roomFull', () => { alert('Room is full! Try a different room code.'); });

socket.on('gameStart', () => {
  lobbyEl.classList.add('hidden');
  waitingEl.classList.add('hidden');
  gameScreenEl.classList.remove('hidden');
  gameActive = true;
  resizeCanvas();
  buildMovesPanel();
  buildRodInfoPanel();
  showOverlay('GET READY');
  setTimeout(() => showOverlay('CLICK TO LOCK MOUSE'), 500);
});

socket.on('countdown', (count) => {
  if (count > 0) showOverlay(count.toString());
  else { showOverlay('GO!'); setTimeout(() => hideOverlay(), 600); }
});

socket.on('state', (state) => {
  if (gameState && state.score) {
    if (state.score.p1 > gameState.score.p1) showGoal(1);
    else if (state.score.p2 > gameState.score.p2) showGoal(2);
  }
  if (state.winner && (!gameState || !gameState.winner)) {
    const won = state.winner === myTeam;
    showOverlay(won ? 'YOU WIN!' : 'YOU LOSE');
  }
  gameState = state;
  updateMovesPanel();

  // Track active special move states
  const sm = state.specialMove;
  activePPSquare = !!(sm && sm.type === 'ppsquare' && sm.phase === 'dribble');
  activeCornettoPhase = sm && sm.type === 'cornetto' ? sm.phase : null;
  const wasSpinCharging = spinCharging;
  spinCharging = !!(sm && sm.type === 'spinneroni' && sm.phase === 'charge');
  if (!spinCharging && wasSpinCharging) { spinCharge = 0; }

  // Update spin visual angle
  if (state.ball && state.ball.spin) {
    spinVisualAngle += state.ball.spin * 0.1;
  }
});

socket.on('opponentLeft', () => showOverlay('OPPONENT LEFT'));

socket.on('shakeStatus', (requests) => {
  const el = document.getElementById('shakeStatus');
  const txt = document.getElementById('shakeText');
  const myReq = myTeam === 1 ? requests.p1 : requests.p2;
  const oppReq = myTeam === 1 ? requests.p2 : requests.p1;
  if (myReq && oppReq) { el.classList.remove('hidden'); el.classList.add('agreed'); txt.textContent = 'SHAKING!'; }
  else if (myReq) { el.classList.remove('hidden', 'agreed'); txt.textContent = 'Waiting for opponent to press T...'; }
  else if (oppReq) { el.classList.remove('hidden', 'agreed'); txt.textContent = 'Opponent wants shake — press T!'; }
  else { el.classList.add('hidden'); el.classList.remove('agreed'); }
});

socket.on('shakeStart', () => {
  canvas.classList.add('shaking');
  setTimeout(() => { canvas.classList.remove('shaking'); document.getElementById('shakeStatus').classList.add('hidden'); }, 500);
});

socket.on('specialMoveStarted', (data) => {});
socket.on('specialMoveFailed', (data) => {});

// ============================================================
// ROD INFO PANEL (right side, shows which rods player controls)
// ============================================================

function buildRodInfoPanel() {
  if (!rodInfoEl) return;
  rodInfoEl.innerHTML = '';

  const allRodNames = ['GK', 'DEF', 'ATK', 'MID', 'MID', 'ATK', 'DEF', 'GK'];
  const allRodOwners = [1, 1, 2, 1, 2, 1, 2, 2];

  // Show rods for my team
  const myRodSet = new Set(myRods);
  const teamRods = [];
  for (let i = 0; i < 8; i++) {
    if (allRodOwners[i] === myTeam) {
      teamRods.push({ index: i, name: allRodNames[i], mine: myRodSet.has(i) });
    }
  }

  for (const rod of teamRods) {
    const div = document.createElement('div');
    div.className = 'rod-info-item' + (rod.mine ? ' mine' : ' locked');
    const mySlotIdx = myRods.indexOf(rod.index);
    const keyLabel = mySlotIdx >= 0 ? ['Q', 'W', 'E', 'R'][mySlotIdx] : '—';
    div.innerHTML = `<span class="rod-info-key">${keyLabel}</span><span class="rod-info-name">${rod.name}</span>`;
    if (!rod.mine) {
      div.innerHTML += '<span class="rod-info-lock">👤 Teammate</span>';
    }
    rodInfoEl.appendChild(div);
  }
}

// ============================================================
// SPECIAL MOVES PANEL
// ============================================================

function getMovesForRole(role) {
  const roleMoves = specialMoves[role] || [];
  const allMoves = specialMoves['ALL'] || [];
  return [...roleMoves, ...allMoves];
}

function buildMovesPanel() {
  movesListEl.innerHTML = '';
  const myRoles = new Set();
  for (const idx of myRods) {
    const rod = gameState.rods[idx];
    if (rod) myRoles.add(rod.role);
  }

  for (const role of ['GK', 'DEF', 'MID', 'ATK']) {
    if (!myRoles.has(role)) continue;

    // Role-specific moves
    const roleMoves = specialMoves[role] || [];
    if (roleMoves.length === 0 && !(specialMoves['ALL'] || []).length) continue;

    const roleDiv = document.createElement('div');
    roleDiv.className = 'move-role';
    roleDiv.textContent = role;
    movesListEl.appendChild(roleDiv);

    for (const move of roleMoves) {
      movesListEl.appendChild(createMoveItem(move));
    }
  }

  // ALL moves section
  const allMoves = specialMoves['ALL'] || [];
  if (allMoves.length > 0) {
    const roleDiv = document.createElement('div');
    roleDiv.className = 'move-role';
    roleDiv.textContent = 'ALL RODS';
    movesListEl.appendChild(roleDiv);

    for (const move of allMoves) {
      movesListEl.appendChild(createMoveItem(move));
    }
  }
}

function createMoveItem(move) {
  const div = document.createElement('div');
  div.className = 'move-item unavailable';
  div.id = `move-${move.id}`;
  div.innerHTML = `<span class="move-key">${move.key}</span><span class="move-name">${move.name}</span><div class="move-desc">${move.desc}</div>`;

  // Tooltip on hover
  if (move.tooltip) {
    div.addEventListener('mouseenter', (e) => {
      showTooltip(move.tooltip, e.target);
    });
    div.addEventListener('mouseleave', () => {
      hideTooltip();
    });
  }
  return div;
}

function showTooltip(text, anchor) {
  let tip = document.getElementById('moveTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'moveTooltip';
    tip.className = 'move-tooltip';
    document.body.appendChild(tip);
  }
  tip.textContent = '';
  // Support multiline with \n
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) tip.appendChild(document.createElement('br'));
    tip.appendChild(document.createTextNode(line));
  });
  tip.classList.add('visible');

  const rect = anchor.getBoundingClientRect();
  tip.style.left = (rect.right + 8) + 'px';
  tip.style.top = rect.top + 'px';

  // Keep tooltip on screen
  requestAnimationFrame(() => {
    const tipRect = tip.getBoundingClientRect();
    if (tipRect.right > window.innerWidth - 10) {
      tip.style.left = (rect.left - tipRect.width - 8) + 'px';
    }
    if (tipRect.bottom > window.innerHeight - 10) {
      tip.style.top = (window.innerHeight - tipRect.height - 10) + 'px';
    }
  });
}

function hideTooltip() {
  const tip = document.getElementById('moveTooltip');
  if (tip) tip.classList.remove('visible');
}

function updateMovesPanel() {
  if (!gameState) return;
  const ball = gameState.ball;

  // Get currently selected rod's role
  let selectedRole = null;
  let selectedRodNearBall = false;
  for (const slot of selectedRodSlots) {
    const rodIdx = myRods[slot];
    if (rodIdx === undefined) continue;
    const rod = gameState.rods[rodIdx];
    if (rod) {
      selectedRole = rod.role;
      if (Math.abs(ball.x - rod.x) < 40) selectedRodNearBall = true;
    }
  }

  // Update all move items
  for (const role of ['GK', 'DEF', 'MID', 'ATK']) {
    const moves = specialMoves[role] || [];
    for (const move of moves) {
      const el = document.getElementById(`move-${move.id}`);
      if (!el) continue;
      const isActive = gameState.specialMove && gameState.specialMove.type === move.id;
      const isSelectedRole = selectedRole === role;
      const available = isSelectedRole && selectedRodNearBall;
      el.className = 'move-item ' + (isActive ? 'active' : (available ? 'available' : 'unavailable'));
    }
  }

  // ALL moves
  const allMoves = specialMoves['ALL'] || [];
  for (const move of allMoves) {
    const el = document.getElementById(`move-${move.id}`);
    if (!el) continue;
    const isActive = gameState.specialMove && gameState.specialMove.type === move.id;
    // Fake shot doesn't need ball proximity, others do
    const needsBall = move.id !== 'fakeshot';
    const available = needsBall ? selectedRodNearBall : (selectedRole !== null);
    el.className = 'move-item ' + (isActive ? 'active' : (available ? 'available' : 'unavailable'));
  }
}

// ============================================================
// CANVAS
// ============================================================

function resizeCanvas() {
  if (!TABLE) return;
  const maxW = (window.innerWidth - 180) * 0.9; // account for rod info panel on right
  const maxH = window.innerHeight * 0.55; // leave room for moves bar below
  const ratio = TABLE.width / TABLE.height;
  let w = maxW, h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  canvas.width = w; canvas.height = h;
}
window.addEventListener('resize', resizeCanvas);

// ============================================================
// RENDERING
// ============================================================

const C = {
  table: '#2e7d32', walls: '#5d4037', wallTop: '#795548',
  lines: 'rgba(255,255,255,0.15)', ball: '#fffde7', ballShadow: 'rgba(0,0,0,0.3)',
  goalNet: '#263238', rod: '#9e9e9e', rodHighlight: '#ffd54f', rodSecondary: '#4dd0e1',
  p1Man: '#1565c0', p1ManLight: '#42a5f5', p2Man: '#c62828', p2ManLight: '#ef5350',
};
const ROD_LABELS = { 0: 'Q', 1: 'W', 2: 'E', 3: 'R' };

function render() {
  if (!gameState || !TABLE) { requestAnimationFrame(render); return; }
  const sx = canvas.width / TABLE.width, sy = canvas.height / TABLE.height;
  ctx.save(); ctx.scale(sx, sy);

  // Table
  const g = ctx.createLinearGradient(0, 0, TABLE.width, 0);
  g.addColorStop(0, C.table); g.addColorStop(0.5, '#388e3c'); g.addColorStop(1, C.table);
  ctx.fillStyle = g; ctx.fillRect(0, 0, TABLE.width, TABLE.height);

  drawFieldMarkings(); drawGoals(); drawWalls(); drawRods(); drawBall();

  if (selectedRodSlots.length === 2) {
    ctx.fillStyle = 'rgba(77,208,225,0.8)'; ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('DUAL ROD', TABLE.width / 2, TABLE.height - 4);
  }
  if (mouseLocked) drawKickHUD();

  // PP Square dribble indicator
  if (activePPSquare) {
    ctx.fillStyle = 'rgba(255,213,79,0.7)'; ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('CLICK TO SHOOT!', TABLE.width / 2, 50);
  }

  // Cornetto stick indicator
  if (activeCornettoPhase === 'stick' || activeCornettoPhase === 'doubleDribble') {
    ctx.fillStyle = 'rgba(255,152,0,0.7)'; ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    const label = activeCornettoPhase === 'stick' ? 'CORNETTO — CLICK TO SHOOT!' : 'DOUBLE CORNETTO — CLICK TO SHOOT!';
    ctx.fillText(label, TABLE.width / 2, 50);
  }

  // Spinneroni charge indicator
  if (spinCharging) {
    ctx.fillStyle = 'rgba(156,39,176,0.7)'; ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('CHARGING SPIN — MOVE MOUSE L/R!', TABLE.width / 2, 50);
    // Spin charge bar
    const barW = 200, barH = 12;
    const bx = TABLE.width / 2 - barW / 2, by = 58;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(bx, by, barW, barH);
    const charge = Math.min(1, spinCharge);
    const r = Math.floor(156 + charge * 99), gr = Math.floor(39 + charge * 100), bl = Math.floor(176 - charge * 50);
    ctx.fillStyle = `rgb(${r},${gr},${bl})`; ctx.fillRect(bx, by, barW * charge, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.strokeRect(bx, by, barW, barH);
  }

  ctx.restore();
  scoreP1El.textContent = gameState.score.p1;
  scoreP2El.textContent = gameState.score.p2;
  requestAnimationFrame(render);
}

function drawFieldMarkings() {
  ctx.strokeStyle = C.lines; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(TABLE.width / 2, TABLE.wallThickness);
  ctx.lineTo(TABLE.width / 2, TABLE.height - TABLE.wallThickness); ctx.stroke();
  ctx.beginPath(); ctx.arc(TABLE.width / 2, TABLE.height / 2, 60, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = C.lines; ctx.beginPath();
  ctx.arc(TABLE.width / 2, TABLE.height / 2, 5, 0, Math.PI * 2); ctx.fill();
  const pw = 120, ph = 260;
  ctx.strokeRect(0, (TABLE.height - ph) / 2, pw, ph);
  ctx.strokeRect(TABLE.width - pw, (TABLE.height - ph) / 2, pw, ph);
}

function drawGoals() {
  const gt = (TABLE.height - TABLE.goalWidth) / 2, gd = TABLE.goalDepth;
  ctx.fillStyle = C.goalNet;
  ctx.fillRect(-gd, gt, gd + 2, TABLE.goalWidth); ctx.fillRect(TABLE.width - 2, gt, gd + 2, TABLE.goalWidth);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  ctx.strokeRect(-gd, gt, gd + 2, TABLE.goalWidth); ctx.strokeRect(TABLE.width - 2, gt, gd + 2, TABLE.goalWidth);
}

function drawWalls() {
  const wt = TABLE.wallThickness;
  let wg = ctx.createLinearGradient(0, 0, 0, wt);
  wg.addColorStop(0, C.wallTop); wg.addColorStop(1, C.walls);
  ctx.fillStyle = wg; ctx.fillRect(0, 0, TABLE.width, wt);
  wg = ctx.createLinearGradient(0, TABLE.height - wt, 0, TABLE.height);
  wg.addColorStop(0, C.walls); wg.addColorStop(1, C.wallTop);
  ctx.fillStyle = wg; ctx.fillRect(0, TABLE.height - wt, TABLE.width, wt);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(0, 0, TABLE.width, 2); ctx.fillRect(0, TABLE.height - 2, TABLE.width, 2);
}

function drawRods() {
  if (!gameState.rods) return;
  for (let i = 0; i < gameState.rods.length; i++) {
    const rod = gameState.rods[i];
    const mySlotIdx = myRods.indexOf(i);
    const isMyRod = mySlotIdx >= 0;
    const isPrimary = isMyRod && selectedRodSlots[0] === mySlotIdx;
    const isSecondary = isMyRod && selectedRodSlots.length === 2 && selectedRodSlots[1] === mySlotIdx;
    const isSel = isPrimary || isSecondary;

    const rc = isPrimary ? C.rodHighlight : (isSecondary ? C.rodSecondary : C.rod);
    ctx.strokeStyle = rc; ctx.lineWidth = isSel ? 5 : 3;
    ctx.globalAlpha = isSel ? 1 : 0.7;
    ctx.beginPath(); ctx.moveTo(rod.x, TABLE.wallThickness);
    ctx.lineTo(rod.x, TABLE.height - TABLE.wallThickness); ctx.stroke();
    ctx.globalAlpha = 1;

    if (isMyRod) {
      const kl = ROD_LABELS[mySlotIdx] || '?';
      ctx.fillStyle = isSel ? rc : 'rgba(255,255,255,0.3)';
      ctx.font = isSel ? 'bold 16px sans-serif' : '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`[${kl}] ${rod.name}`, rod.x, TABLE.wallThickness - 4);
    }

    const mW = 22, mH = 66;
    for (let m = 0; m < rod.menCount; m++) {
      const y = rod.men[m].y + rod.offsetY;
      const bc = rod.owner === 1 ? C.p1Man : C.p2Man;
      const lc = rod.owner === 1 ? C.p1ManLight : C.p2ManLight;

      ctx.save(); ctx.translate(rod.x, y);
      if (rod.angle !== 0) ctx.rotate(rod.angle * 0.3);

      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(-mW / 2 + 3, -mH / 2 + 3, mW, mH);

      const mg = ctx.createLinearGradient(-mW / 2, 0, mW / 2, 0);
      mg.addColorStop(0, bc); mg.addColorStop(0.5, lc); mg.addColorStop(1, bc);
      ctx.fillStyle = mg; ctx.fillRect(-mW / 2, -mH / 2, mW, mH);

      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
      ctx.strokeRect(-mW / 2, -mH / 2, mW, mH);

      ctx.fillStyle = '#ffcc80'; ctx.beginPath();
      ctx.arc(0, -mH / 2 + 10, 7, 0, Math.PI * 2); ctx.fill();

      const ka = rod.angle || 0, ke = Math.abs(Math.sin(ka)) * 20;
      const fd = ka >= 0 ? 1 : -1;
      if (ke > 1) {
        ctx.fillStyle = '#333';
        ctx.fillRect(fd > 0 ? mW / 2 : -mW / 2 - ke, mH / 2 - 10, ke, 8);
      }
      ctx.restore();
    }
  }
}

function drawBall() {
  const b = gameState.ball;
  ctx.fillStyle = C.ballShadow; ctx.beginPath();
  ctx.ellipse(b.x + 3, b.y + 3, b.radius, b.radius * 0.8, 0, 0, Math.PI * 2); ctx.fill();

  const bg = ctx.createRadialGradient(b.x - 3, b.y - 3, 2, b.x, b.y, b.radius);
  bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.7, C.ball); bg.addColorStop(1, '#fbc02d');
  ctx.fillStyle = bg; ctx.beginPath();
  ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1; ctx.stroke();

  // Spin indicator: rotating cross pattern on ball
  const spin = b.spin || 0;
  if (Math.abs(spin) > 0.3) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(spinVisualAngle);
    const intensity = Math.min(1, Math.abs(spin) / 8);
    ctx.strokeStyle = `rgba(156,39,176,${0.3 + intensity * 0.5})`;
    ctx.lineWidth = 1.5;
    const r = b.radius * 0.7;
    // Draw cross
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke();
    // Spin direction arrow
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + intensity * 0.4})`;
    const arrowAngle = spin > 0 ? Math.PI * 0.3 : -Math.PI * 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, arrowAngle, spin < 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawKickHUD() {
  const hx = TABLE.width - 80, hy = TABLE.height - 55;
  const speed = Math.sqrt(mouseVelX * mouseVelX + mouseVelY * mouseVelY);
  const power = Math.min(1, speed * POWER_SCALE);
  const angle = Math.max(-1, Math.min(1, mouseVelX * ANGLE_SCALE));

  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(hx - 25, hy - 20, 50, 8);
  const r = Math.floor(255 * power), gr = Math.floor(255 * (1 - power));
  ctx.fillStyle = `rgb(${r},${gr},50)`; ctx.fillRect(hx - 25, hy - 20, 50 * power, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('PWR', hx, hy - 23);

  ctx.save(); ctx.translate(hx, hy + 5);
  const aa = angle * 0.6;
  ctx.strokeStyle = `rgba(255,255,255,${0.3 + power * 0.5})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0);
  const al = 15 + power * 10;
  ctx.lineTo(Math.sin(aa) * al, -Math.cos(aa) * al); ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle; ctx.beginPath();
  ctx.arc(Math.sin(aa) * al, -Math.cos(aa) * al, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ============================================================
// CONTROLS
// ============================================================

canvas.addEventListener('click', () => {
  if (gameActive && !mouseLocked) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  mouseLocked = document.pointerLockElement === canvas;
  const lm = document.getElementById('lockMessage');
  if (mouseLocked) lm.classList.add('hidden');
  else if (gameActive) lm.classList.remove('hidden');
});

document.addEventListener('mousemove', (e) => {
  if (!mouseLocked || !gameState || myRods.length === 0) return;
  mouseVelX = mouseVelX * MOUSE_VEL_DECAY + e.movementX * (1 - MOUSE_VEL_DECAY);
  mouseVelY = mouseVelY * MOUSE_VEL_DECAY + e.movementY * (1 - MOUSE_VEL_DECAY);

  // Spinneroni charge: accumulate horizontal mouse movement
  if (spinCharging) {
    spinCharge += Math.abs(e.movementX) * 0.003;
    spinDir = e.movementX >= 0 ? 1 : -1;
  }

  const scaleY = TABLE.height / canvas.height;
  const deltaY = e.movementY * scaleY * MOUSE_SENSITIVITY;

  for (const slot of selectedRodSlots) {
    const rodIdx = myRods[slot];
    if (rodIdx === undefined) continue;
    const rod = gameState.rods[rodIdx];
    if (!rod) continue;
    socket.emit('moveRod', { rodIndex: rodIdx, offsetY: rod.offsetY + deltaY });
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (!mouseLocked || !gameState) return;
  e.preventDefault();

  // If PP Square dribble is active, click fires
  if (activePPSquare) {
    socket.emit('ppsquareShoot', {});
    return;
  }

  // If Cornetto is in stick/doubleDribble phase, click fires
  if (activeCornettoPhase === 'stick' || activeCornettoPhase === 'doubleDribble') {
    socket.emit('cornettoShoot', {});
    return;
  }

  // If Spinneroni charging, click fires
  if (spinCharging) {
    socket.emit('spinneroniFire', { spinCharge: spinCharge, spinDir: spinDir });
    return;
  }

  const direction = e.button === 0 ? 1 : -1;
  const speed = Math.sqrt(mouseVelX * mouseVelX + mouseVelY * mouseVelY);
  const power = Math.min(1, speed * POWER_SCALE);
  const angle = Math.max(-1, Math.min(1, mouseVelX * ANGLE_SCALE));

  for (const slot of selectedRodSlots) {
    const rodIdx = myRods[slot];
    if (rodIdx !== undefined) {
      socket.emit('kick', { rodIndex: rodIdx, direction, power, angle });
    }
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Keyboard
const rodKeyMap = { 'KeyQ': 0, 'KeyW': 1, 'KeyE': 2, 'KeyR': 3 };
const specialKeyMap = { 'KeyF': 'F', 'KeyG': 'G', 'KeyH': 'H', 'KeyJ': 'J', 'KeyV': 'V', 'KeyB': 'B' };

document.addEventListener('keydown', (e) => {
  if (!gameActive) return;

  // Rod selection
  if (rodKeyMap[e.code] !== undefined) {
    const slot = rodKeyMap[e.code];
    if (slot < myRods.length && !heldRodKeys.has(e.code)) {
      heldRodKeys.add(e.code);
      rebuildSelectedRods();
    }
    return;
  }

  // Special move keys
  if (specialKeyMap[e.code]) {
    const key = specialKeyMap[e.code];
    trySpecialMove(key);
    return;
  }

  switch (e.code) {
    case 'KeyT': socket.emit('requestShake'); break;
    case 'Escape': if (mouseLocked) document.exitPointerLock(); break;
  }
});

document.addEventListener('keyup', (e) => {
  if (rodKeyMap[e.code] !== undefined) {
    heldRodKeys.delete(e.code);
    rebuildSelectedRods();
  }
});

function rebuildSelectedRods() {
  const slots = [];
  for (const code of ['KeyQ', 'KeyW', 'KeyE', 'KeyR']) {
    if (heldRodKeys.has(code)) {
      const slot = rodKeyMap[code];
      if (slot < myRods.length) slots.push(slot);
    }
    if (slots.length >= 2) break;
  }
  if (slots.length > 0) selectedRodSlots = slots;
}

// ============================================================
// SPECIAL MOVES
// ============================================================

function trySpecialMove(key) {
  // Handle B key double-tap for Dribble Shot
  if (key === 'B') {
    const now = Date.now();
    if (now - fakeShotFirstTap < 500) {
      // Dribble Shot: double-tap B
      fakeShotFirstTap = 0;
      for (const slot of selectedRodSlots) {
        const rodIdx = myRods[slot];
        if (rodIdx === undefined) continue;
        socket.emit('specialMove', { rodIndex: rodIdx, moveId: 'dribbleshot' });
        return;
      }
    } else {
      // First tap: Fake Shot
      fakeShotFirstTap = now;
      for (const slot of selectedRodSlots) {
        const rodIdx = myRods[slot];
        if (rodIdx === undefined) continue;
        socket.emit('specialMove', { rodIndex: rodIdx, moveId: 'fakeshot' });
        return;
      }
    }
    return;
  }

  // Handle V key for Spinneroni
  if (key === 'V') {
    for (const slot of selectedRodSlots) {
      const rodIdx = myRods[slot];
      if (rodIdx === undefined) continue;
      const rod = gameState.rods[rodIdx];
      if (!rod) continue;
      if (Math.abs(gameState.ball.x - rod.x) > 40) continue;
      spinCharge = 0;
      socket.emit('specialMove', { rodIndex: rodIdx, moveId: 'spinneroni' });
      return;
    }
    return;
  }

  // Role-specific moves: F, G, H, J
  for (const slot of selectedRodSlots) {
    const rodIdx = myRods[slot];
    if (rodIdx === undefined) continue;
    const rod = gameState.rods[rodIdx];
    if (!rod) continue;

    const roleMoves = specialMoves[rod.role] || [];
    const move = roleMoves.find(m => m.key === key);
    if (!move) continue;

    // Check ball proximity
    if (Math.abs(gameState.ball.x - rod.x) > 40) continue;

    // Selfie: double-tap F within 500ms (on GK)
    if (move.id === 'selfie') {
      const now = Date.now();
      if (now - selfieFirstTap < 500) {
        selfieFirstTap = 0;
        socket.emit('specialMove', { rodIndex: rodIdx, moveId: 'selfie' });
      } else {
        selfieFirstTap = now;
      }
      return;
    }

    // Dory: send mouse speed
    if (move.id === 'dory') {
      const ms = Math.sqrt(mouseVelX * mouseVelX + mouseVelY * mouseVelY);
      socket.emit('specialMove', { rodIndex: rodIdx, moveId: 'dory', mouseSpeed: ms });
      return;
    }

    // All others: just fire
    socket.emit('specialMove', { rodIndex: rodIdx, moveId: move.id });
    return;
  }
}

// ============================================================
// OVERLAY
// ============================================================

function showOverlay(text) { overlayTextEl.textContent = text; overlayEl.classList.remove('hidden'); }
function hideOverlay() { overlayEl.classList.add('hidden'); }

function showGoal(playerNum) {
  const won = playerNum === myTeam;
  showOverlay(won ? 'YOU SCORED!' : 'GOAL!');
  socket.emit('goalScored');
  setTimeout(() => {
    showOverlay('3');
    setTimeout(() => {
      showOverlay('2');
      setTimeout(() => {
        showOverlay('1');
        setTimeout(() => {
          showOverlay('GO!');
          setTimeout(() => hideOverlay(), 500);
        }, 1000);
      }, 1000);
    }, 1000);
  }, 1500);
}

// ============================================================
// START
// ============================================================

requestAnimationFrame(render);
