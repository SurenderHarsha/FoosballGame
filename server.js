const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;
const WIN_SCORE = 10;

const TABLE = {
  width: 1200,
  height: 680,
  wallThickness: 20,
  goalWidth: 180,
  goalDepth: 40,
};

// BGK, BDEF, RATK, BMID, RMID, BATK, RDEF, RGK
const ROD_CONFIG = [
  { x: 65,   men: 1, owner: 1, name: 'GK',  role: 'GK' },
  { x: 165,  men: 2, owner: 1, name: 'DEF', role: 'DEF' },
  { x: 320,  men: 3, owner: 2, name: 'ATK', role: 'ATK' },
  { x: 480,  men: 5, owner: 1, name: 'MID', role: 'MID' },
  { x: 720,  men: 5, owner: 2, name: 'MID', role: 'MID' },
  { x: 880,  men: 3, owner: 1, name: 'ATK', role: 'ATK' },
  { x: 1035, men: 2, owner: 2, name: 'DEF', role: 'DEF' },
  { x: 1135, men: 1, owner: 2, name: 'GK',  role: 'GK' },
];

const TEAM_ROLES_4P = {
  a: ['GK', 'DEF'],
  b: ['MID', 'ATK'],
};

const BALL_RADIUS = 12;
const MAN_WIDTH = 22;
const MAN_HEIGHT = 66;
const MAN_KICK_REACH = 55;
const ROD_SLIDE_RANGE = 110;
const ROD_SLIDE_RANGE_DEF = 180;
const BALL_MAX_SPEED = 25;
const BALL_FRICTION = 0.997;
const KICK_FORCE_MIN = 6;
const KICK_FORCE_MAX = 22;
const KICK_ANGLE_MAX = 0.6;
const TRAP_SPEED_THRESHOLD = 8;
const TRAP_ROD_SPEED_SWEET_MIN = 0.3;
const TRAP_ROD_SPEED_SWEET_MAX = 3.0;
const TRAP_BEST_DAMPING = 0.12;
const TRAP_ESCAPE_FORCE = 0.4;
const STUCK_BALL_THRESHOLD = 180;

// Spin physics (nerfed: lower max, faster decay, weaker curve)
const SPIN_MAX = 8;
const SPIN_DECAY = 0.985;
const SPIN_MAGNUS = 0.02;
const SPIN_WALL_REVERSAL = 0.4;

// Ball must be within this distance of rod X to activate special moves
// MAN_WIDTH/2 + BALL_RADIUS + small margin = ~35px (ball touching the rod)
const SPECIAL_MOVE_BALL_RANGE = 40;

// Special move definitions per role
const SPECIAL_MOVES = {
  GK: [
    { id: 'selfie', name: 'Selfie Shot', key: 'F',
      desc: 'Score on yourself.',
      tooltip: 'Double-tap F to confirm. A self-goal for laughs.\nSkill: Courage (or trolling).' },
  ],
  DEF: [
    { id: 'spaghetti', name: 'Spaghetti Shot', key: 'F',
      desc: 'Max power straight shot.',
      tooltip: 'Fires straight at enemy goal with maximum power. Accuracy depends on how centered the ball is on your player.\nSkill: Precise ball positioning before activation.' },
    { id: 'pepperoni', name: 'Pepperoni', key: 'G',
      desc: 'Random wall-bounce shot.',
      tooltip: 'Fires at a random angle off the wall toward the goal. Pure luck!\nSkill: None — it\'s a gamble.' },
    { id: 'cornetto', name: 'Cornetto', key: 'H',
      desc: 'Stick ball, then power shot.',
      tooltip: 'Ball sticks to your player. Move rod to control it, click to fire max-power straight shot. Between 2 men = Double Cornetto (auto-dribble first).\nSkill: Smooth rod movement + precise shot timing.' },
    { id: 'yoyo', name: 'Yoyo Shot', key: 'J',
      desc: 'Wall bounce return.',
      tooltip: 'Fires at the wall beside enemy goal. Ball bounces back to your defender. A playful reset shot.\nSkill: Ball must be near DEF rod.' },
  ],
  MID: [
    { id: 'dory', name: 'Dory Shot', key: 'F',
      desc: 'Straight shot. Stay still!',
      tooltip: 'Powerful straight shot. Accuracy depends on mouse stillness at activation. Any movement reduces precision.\nSkill: Keep mouse completely still before pressing F.' },
    { id: 'eliza', name: 'The Eliza', key: 'G',
      desc: 'Chaotic wall slam.',
      tooltip: 'Rapidly slides the rod sideways. Ball slams into wall at max speed, bounces randomly.\nSkill: Embrace chaos. Direction is unpredictable.' },
    { id: 'diagonal', name: 'Diagonal Shot', key: 'H',
      desc: 'Diagonal from edge.',
      tooltip: 'Shoots diagonally toward enemy goal corner. Only works when ball is at top or bottom of rod range.\nSkill: Position ball at rod extremity before activating.' },
  ],
  ATK: [
    { id: 'ppsquare', name: 'PP Square', key: 'F',
      desc: 'Auto-dribble, click to shoot.',
      tooltip: 'Ball auto-dribbles between attackers. Click to shoot. Best timing ~1 second in.\nSkill: Precise click timing during dribble.' },
    { id: 'diagonal', name: 'Diagonal Shot', key: 'G',
      desc: 'Diagonal from edge.',
      tooltip: 'Shoots diagonally toward enemy goal corner. Only works when ball is at top or bottom of rod range.\nSkill: Position ball at rod extremity before activating.' },
  ],
  ALL: [
    { id: 'spinneroni', name: 'Spinneroni', key: 'V',
      desc: 'Maximum spin shot.',
      tooltip: 'Press V to start charging. Move mouse left/right rapidly to build spin. Click to fire. Ball curves dramatically.\nSkill: Fast horizontal mouse movement during charge. Hardest move in the game.' },
    { id: 'fakeshot', name: 'Fake Shot', key: 'B',
      desc: 'Bluff kick.',
      tooltip: 'Rod does a kick animation but intentionally misses. Mind games!\nSkill: Deception timing.' },
    { id: 'dribbleshot', name: 'Dribble Shot', key: 'BB',
      desc: 'Fake then real shot.',
      tooltip: 'Double-tap B: first fake, second fires max power. Quick deception into attack.\nSkill: Fast double-tap within 500ms.' },
  ],
};

function getSlideRange(rod) {
  return rod.role === 'DEF' ? ROD_SLIDE_RANGE_DEF : ROD_SLIDE_RANGE;
}

function createInitialState() {
  const rods = ROD_CONFIG.map((cfg, i) => {
    const spacing = (TABLE.height - 2 * TABLE.wallThickness) / (cfg.men + 1);
    const men = [];
    for (let m = 0; m < cfg.men; m++) {
      men.push({ y: TABLE.wallThickness + spacing * (m + 1) });
    }
    return {
      id: i, x: cfg.x, owner: cfg.owner, name: cfg.name, role: cfg.role,
      menCount: cfg.men, men,
      offsetY: 0, angle: 0, kicking: false, kickFrame: 0, moveSpeed: 0,
      fakeKick: false,
    };
  });

  return {
    ball: { x: TABLE.width / 2, y: TABLE.height / 2, vx: 0, vy: 0, radius: BALL_RADIUS, spin: 0 },
    rods,
    score: { p1: 0, p2: 0 },
    paused: false,
    countdown: 3,
    lastGoalBy: 0,
    stuckFrames: 0,
    shakeRequests: { p1: false, p2: false },
    shaking: false,
    shakeFrames: 0,
    winner: null,
    specialMove: null,
  };
}

function resetBall(state, serveToPlayer) {
  state.ball.x = TABLE.width / 2;
  state.ball.y = TABLE.height / 2;
  state.ball.vx = serveToPlayer === 1 ? -3 : 3;
  state.ball.vy = (Math.random() - 0.5) * 4;
  state.ball.spin = 0;
  state.paused = true;
  state.countdown = 3;
  state.specialMove = null;
}

function isBallNearRod(ball, rod) {
  return Math.abs(ball.x - rod.x) < SPECIAL_MOVE_BALL_RANGE;
}

function closestManToBall(ball, rod) {
  let bestDist = Infinity;
  let bestIdx = 0;
  for (let m = 0; m < rod.menCount; m++) {
    const my = rod.men[m].y + rod.offsetY;
    const d = Math.abs(ball.y - my);
    if (d < bestDist) { bestDist = d; bestIdx = m; }
  }
  return { index: bestIdx, dist: bestDist };
}

// Check if ball is at the top or bottom extremity of a rod's men range
function isBallAtExtremity(ball, rod) {
  if (rod.menCount < 2) return false;
  const menY = rod.men.map(m => m.y + rod.offsetY);
  const topMan = Math.min(...menY);
  const botMan = Math.max(...menY);
  const marginFromEdge = MAN_HEIGHT * 0.8;
  return ball.y < topMan + marginFromEdge || ball.y > botMan - marginFromEdge;
}

// Get which extremity the ball is near (top or bottom)
function getBallExtremity(ball, rod) {
  const menY = rod.men.map(m => m.y + rod.offsetY);
  const topMan = Math.min(...menY);
  const botMan = Math.max(...menY);
  return Math.abs(ball.y - topMan) < Math.abs(ball.y - botMan) ? 'top' : 'bottom';
}

function updateSpecialMove(state) {
  const sm = state.specialMove;
  if (!sm) return;

  const ball = state.ball;
  const rod = state.rods[sm.rodIndex];

  switch (sm.type) {
    case 'spaghetti': {
      const { dist } = closestManToBall(ball, rod);
      const accuracy = Math.max(0, 1 - dist / (MAN_HEIGHT * 0.6));
      const dir = rod.owner === 1 ? 1 : -1;
      ball.vx = dir * BALL_MAX_SPEED;
      ball.vy = (1 - accuracy) * (Math.random() - 0.5) * 8;
      state.specialMove = null;
      break;
    }

    case 'pepperoni': {
      const dir = rod.owner === 1 ? 1 : -1;
      const power = 18 + Math.random() * 7;
      const aimUp = Math.random() > 0.5;
      const angle = (aimUp ? -1 : 1) * (0.4 + Math.random() * 0.5);
      ball.vx = dir * power * Math.cos(angle);
      ball.vy = power * Math.sin(angle);
      state.specialMove = null;
      break;
    }

    case 'cornetto': {
      sm.frame = (sm.frame || 0) + 1;

      if (sm.phase === 'stick') {
        // Ball sticks to the nearest man on the rod
        const manIdx = sm.manIndex;
        const manY = rod.men[manIdx].y + rod.offsetY;
        const dir = rod.owner === 1 ? 1 : -1;
        ball.x += (rod.x + dir * (MAN_WIDTH / 2 + BALL_RADIUS + 2) - ball.x) * 0.3;
        ball.y += (manY - ball.y) * 0.3;
        ball.vx *= 0.1;
        ball.vy *= 0.1;

        // Auto-cancel after 3 seconds
        if (sm.frame > 180) {
          state.specialMove = null;
        }
      } else if (sm.phase === 'doubleDribble') {
        // Dribble between two men
        const men = rod.men.map((m, i) => ({ y: m.y + rod.offsetY, i }));
        men.sort((a, b) => a.y - b.y);
        const man1Y = men[sm.man1Sorted].y;
        const man2Y = men[sm.man2Sorted].y;
        const dir = rod.owner === 1 ? 1 : -1;
        ball.x += (rod.x + dir * (MAN_WIDTH / 2 + BALL_RADIUS + 2) - ball.x) * 0.2;

        // Bounce between men
        const period = 30;
        const t = (sm.frame % period) / period;
        const targetY = t < 0.5 ? man1Y + (man2Y - man1Y) * (t * 2) : man2Y + (man1Y - man2Y) * ((t - 0.5) * 2);
        ball.y += (targetY - ball.y) * 0.15;
        ball.vx *= 0.3;
        ball.vy *= 0.5;

        if (sm.frame > 180) {
          state.specialMove = null;
        }
      } else if (sm.phase === 'shoot') {
        const dir = rod.owner === 1 ? 1 : -1;
        const timingQuality = sm.timingQuality || 0.5;
        ball.vx = dir * BALL_MAX_SPEED;
        const goalCenterY = TABLE.height / 2;
        ball.vy = (goalCenterY - ball.y) * 0.12 * timingQuality;
        ball.vy += (1 - timingQuality) * (Math.random() - 0.5) * 6;
        state.specialMove = null;
      }
      break;
    }

    case 'yoyo': {
      // Shoot at wall beside enemy goal, ball bounces back
      const dir = rod.owner === 1 ? 1 : -1;
      const goalTop = (TABLE.height - TABLE.goalWidth) / 2;
      const goalBottom = (TABLE.height + TABLE.goalWidth) / 2;
      // Aim at wall above or below the goal on enemy side
      const aimY = ball.y < TABLE.height / 2 ? goalTop - 50 : goalBottom + 50;
      const targetX = dir > 0 ? TABLE.width - 5 : 5;
      const dx = targetX - ball.x;
      const dy = aimY - ball.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = 18;
      ball.vx = (dx / dist) * speed;
      ball.vy = (dy / dist) * speed;
      state.specialMove = null;
      break;
    }

    case 'dory': {
      const dir = rod.owner === 1 ? 1 : -1;
      const mouseSpeed = sm.mouseSpeed || 0;
      const accuracy = Math.max(0, 1 - mouseSpeed * 0.3);
      ball.vx = dir * BALL_MAX_SPEED;
      const goalCenterY = TABLE.height / 2;
      const aimY = (goalCenterY - ball.y) * accuracy * 0.1;
      ball.vy = aimY + (1 - accuracy) * (Math.random() - 0.5) * 10;
      state.specialMove = null;
      break;
    }

    case 'eliza': {
      sm.frame = (sm.frame || 0) + 1;
      // Rapidly oscillate the rod for 20 frames
      if (sm.frame <= 20) {
        const range = getSlideRange(rod);
        const oscillation = Math.sin(sm.frame * Math.PI * 0.5) * range;
        rod.offsetY = oscillation;
        rod.moveSpeed = range * 0.5;

        // If ball is near, slam it
        for (let m = 0; m < rod.menCount; m++) {
          const manY = rod.men[m].y + rod.offsetY;
          const dx = Math.abs(ball.x - rod.x);
          const dy = Math.abs(ball.y - manY);
          if (dx < MAN_WIDTH + BALL_RADIUS && dy < MAN_HEIGHT / 2 + BALL_RADIUS) {
            // Slam ball toward nearest wall
            const wallDir = ball.y < TABLE.height / 2 ? -1 : 1;
            ball.vy = wallDir * BALL_MAX_SPEED * 0.8;
            ball.vx = (rod.owner === 1 ? 1 : -1) * (5 + Math.random() * 10);
            state.specialMove = null;
            return;
          }
        }
      } else {
        state.specialMove = null;
      }
      break;
    }

    case 'diagonal': {
      const dir = rod.owner === 1 ? 1 : -1;
      const extremity = sm.extremity; // 'top' or 'bottom'
      const goalTop = (TABLE.height - TABLE.goalWidth) / 2;
      const goalBottom = (TABLE.height + TABLE.goalWidth) / 2;
      // Shoot diagonally toward the opposite corner of the goal
      const targetY = extremity === 'top' ? goalBottom - 20 : goalTop + 20;
      const targetX = dir > 0 ? TABLE.width : 0;
      const dx = targetX - ball.x;
      const dy = targetY - ball.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = BALL_MAX_SPEED * 0.9;
      ball.vx = (dx / dist) * speed;
      ball.vy = (dy / dist) * speed;
      state.specialMove = null;
      break;
    }

    case 'ppsquare': {
      sm.frame = (sm.frame || 0) + 1;
      if (sm.phase === 'dribble') {
        const men = rod.men.map((m, i) => ({ y: m.y + rod.offsetY, i }));
        men.sort((a, b) => a.y - b.y);
        const topY = men[0].y;
        const botY = men[men.length - 1].y;
        const dir = rod.owner === 1 ? 1 : -1;
        ball.x += (rod.x + dir * 15 - ball.x) * 0.2;
        if (sm.frame % 20 < 10) {
          ball.vy += (topY - ball.y) * 0.08;
        } else {
          ball.vy += (botY - ball.y) * 0.08;
        }
        ball.vy *= 0.9;
        ball.vx *= 0.5;
        if (sm.frame > 180) { state.specialMove = null; }
      } else if (sm.phase === 'shoot') {
        const dir = rod.owner === 1 ? 1 : -1;
        ball.vx = dir * BALL_MAX_SPEED;
        const timingQuality = sm.timingQuality || 0.5;
        const goalCenterY = TABLE.height / 2;
        ball.vy = (goalCenterY - ball.y) * 0.15 * timingQuality;
        ball.vy += (1 - timingQuality) * (Math.random() - 0.5) * 8;
        state.specialMove = null;
      }
      break;
    }

    case 'spinneroni': {
      sm.frame = (sm.frame || 0) + 1;
      if (sm.phase === 'charge') {
        ball.vx *= 0.8;
        ball.vy *= 0.8;
        // Shorter charge window: 1.5 seconds
        if (sm.frame > 90) {
          sm.phase = 'shoot';
          sm.spinCharge = sm.spinCharge || 0;
        }
      } else if (sm.phase === 'shoot') {
        const dir = rod.owner === 1 ? 1 : -1;
        const charge = Math.min(1, (sm.spinCharge || 0));
        // Nerfed: lower base power, moderate spin, more randomness
        const power = 10 + charge * 8;
        ball.vx = dir * power;
        ball.vy = (Math.random() - 0.5) * 6;
        ball.spin = charge * SPIN_MAX * (sm.spinDir || 1);
        state.specialMove = null;
      }
      break;
    }

    case 'fakeshot': {
      sm.frame = (sm.frame || 0) + 1;
      // Set rod to fake kick
      if (sm.frame === 1) {
        rod.fakeKick = true;
        rod.kicking = true;
        rod.kickFrame = 0;
        rod.kickDirection = rod.owner === 1 ? 1 : -1;
      }
      // Clear after animation completes
      if (sm.frame > 10) {
        rod.fakeKick = false;
        state.specialMove = null;
      }
      break;
    }

    case 'dribbleshot': {
      sm.frame = (sm.frame || 0) + 1;
      if (sm.phase === 'fake') {
        // Fake kick first
        if (sm.frame === 1) {
          rod.fakeKick = true;
          rod.kicking = true;
          rod.kickFrame = 0;
          rod.kickDirection = rod.owner === 1 ? 1 : -1;
        }
        if (sm.frame > 8) {
          rod.fakeKick = false;
          sm.phase = 'shoot';
          sm.frame = 0;
        }
      } else if (sm.phase === 'shoot') {
        if (sm.frame === 1) {
          // Real powerful kick
          rod.kicking = true;
          rod.kickFrame = 0;
          rod.kickDirection = rod.owner === 1 ? 1 : -1;
          rod.kickPower = 1.0;
          rod.kickAngle = 0;
          rod.fakeKick = false;
        }
        if (sm.frame > 10) {
          state.specialMove = null;
        }
      }
      break;
    }

    case 'selfie': {
      const dir = rod.owner === 1 ? -1 : 1;
      ball.vx = dir * 15;
      ball.vy = (TABLE.height / 2 - ball.y) * 0.1;
      state.specialMove = null;
      break;
    }
  }
}

function getManRect(rod, manIndex) {
  const man = rod.men[manIndex];
  const baseY = man.y + rod.offsetY;
  const halfW = MAN_WIDTH / 2;
  const halfH = MAN_HEIGHT / 2;
  const absAngle = Math.abs(rod.angle);
  // Fake kicks don't extend reach
  const reach = rod.fakeKick ? 0 : (absAngle / (Math.PI * 0.6)) * MAN_KICK_REACH;

  return {
    cx: rod.x, cy: baseY,
    left: rod.x - halfW - reach, right: rod.x + halfW + reach,
    top: baseY - halfH, bottom: baseY + halfH,
    reach,
  };
}

function updatePhysics(state) {
  if (state.paused) return;

  if (state.score.p1 >= WIN_SCORE) {
    state.winner = 1; state.paused = true; return;
  }
  if (state.score.p2 >= WIN_SCORE) {
    state.winner = 2; state.paused = true; return;
  }

  updateSpecialMove(state);

  const ball = state.ball;

  if (state.shaking) {
    state.shakeFrames++;
    if (state.shakeFrames <= 30) {
      ball.vx += (Math.random() - 0.5) * 6;
      ball.vy += (Math.random() - 0.5) * 6;
    } else {
      state.shaking = false;
      state.shakeFrames = 0;
      state.shakeRequests.p1 = false;
      state.shakeRequests.p2 = false;
    }
  }

  // Ball friction
  ball.vx *= BALL_FRICTION;
  ball.vy *= BALL_FRICTION;

  // Spin physics: Magnus effect
  ball.spin = (ball.spin || 0) * SPIN_DECAY;
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (speed > 0.5 && Math.abs(ball.spin) > 0.1) {
    // Magnus force perpendicular to velocity
    const nx = -ball.vy / speed;
    const ny = ball.vx / speed;
    ball.vx += nx * ball.spin * SPIN_MAGNUS;
    ball.vy += ny * ball.spin * SPIN_MAGNUS;
  }

  if (speed > BALL_MAX_SPEED) {
    ball.vx = (ball.vx / speed) * BALL_MAX_SPEED;
    ball.vy = (ball.vy / speed) * BALL_MAX_SPEED;
  }

  if (speed < 0.3) { state.stuckFrames++; } else { state.stuckFrames = 0; }
  if (state.stuckFrames >= STUCK_BALL_THRESHOLD) {
    ball.vx += (Math.random() - 0.5) * 8;
    ball.vy += (Math.random() - 0.5) * 8;
    state.stuckFrames = 0;
  }

  if (speed < 0.05 && state.stuckFrames < STUCK_BALL_THRESHOLD - 10) {
    ball.vx = 0; ball.vy = 0;
  }

  ball.x += ball.vx;
  ball.y += ball.vy;

  // Wall collisions
  const topWall = TABLE.wallThickness + ball.radius;
  const bottomWall = TABLE.height - TABLE.wallThickness - ball.radius;
  if (ball.y < topWall) {
    ball.y = topWall; ball.vy = Math.abs(ball.vy) * 0.85;
    ball.spin *= -SPIN_WALL_REVERSAL; // Spin partially reverses on wall bounce
  }
  if (ball.y > bottomWall) {
    ball.y = bottomWall; ball.vy = -Math.abs(ball.vy) * 0.85;
    ball.spin *= -SPIN_WALL_REVERSAL;
  }

  // Goals
  const goalTop = (TABLE.height - TABLE.goalWidth) / 2;
  const goalBottom = (TABLE.height + TABLE.goalWidth) / 2;
  const inGoalY = ball.y > goalTop && ball.y < goalBottom;

  if (ball.x - ball.radius < 0) {
    if (inGoalY) { state.score.p2++; state.lastGoalBy = 2; resetBall(state, 1); return; }
    else { ball.x = ball.radius; ball.vx = Math.abs(ball.vx) * 0.85; ball.spin *= -SPIN_WALL_REVERSAL; }
  }
  if (ball.x + ball.radius > TABLE.width) {
    if (inGoalY) { state.score.p1++; state.lastGoalBy = 1; resetBall(state, 2); return; }
    else { ball.x = TABLE.width - ball.radius; ball.vx = -Math.abs(ball.vx) * 0.85; ball.spin *= -SPIN_WALL_REVERSAL; }
  }

  // Rod collisions
  for (const rod of state.rods) {
    rod.moveSpeed = (rod.moveSpeed || 0) * 0.85;

    if (rod.kicking) {
      rod.kickFrame++;
      const dir = rod.kickDirection || 1;
      const sign = rod.owner === 1 ? dir : -dir;
      if (rod.kickFrame < 4) {
        rod.angle = sign * (rod.kickFrame / 4) * Math.PI * 0.6;
      } else if (rod.kickFrame < 8) {
        rod.angle = sign * ((8 - rod.kickFrame) / 4) * Math.PI * 0.6;
      } else {
        rod.angle = 0; rod.kicking = false; rod.kickFrame = 0; rod.kickDirection = 1;
        rod.fakeKick = false;
      }
    }

    for (let m = 0; m < rod.menCount; m++) {
      const rect = getManRect(rod, m);
      const closestX = Math.max(rect.left, Math.min(ball.x, rect.right));
      const closestY = Math.max(rect.top, Math.min(ball.y, rect.bottom));
      const dx = ball.x - closestX;
      const dy = ball.y - closestY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < ball.radius) {
        if (dist === 0) {
          const pushDir = rod.angle >= 0 ? 1 : -1;
          ball.x = pushDir > 0 ? rect.right + ball.radius : rect.left - ball.radius;
        } else {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = ball.radius - dist;
          ball.x += nx * overlap;
          ball.y += ny * overlap;

          const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

          if (rod.kicking && rod.kickFrame < 5 && !rod.fakeKick) {
            const power = rod.kickPower || 0.5;
            const angle = (rod.kickAngle || 0) * KICK_ANGLE_MAX;
            const force = KICK_FORCE_MIN + power * (KICK_FORCE_MAX - KICK_FORCE_MIN);
            const kickDir = rod.kickDirection || 1;
            const forceDir = rod.owner === 1 ? kickDir : -kickDir;
            ball.vx = forceDir * force * Math.cos(angle);
            ball.vy = force * Math.sin(angle);
            ball.vy += (Math.random() - 0.5) * 1.5;
            // Kicks add a small amount of spin based on rod movement
            ball.spin += rod.moveSpeed * 0.3 * (rod.moveSpeed > 0 ? 1 : -1);
          } else if (!rod.kicking && ballSpeed < TRAP_SPEED_THRESHOLD) {
            const rs = rod.moveSpeed || 0;
            if (rs >= TRAP_ROD_SPEED_SWEET_MIN && rs <= TRAP_ROD_SPEED_SWEET_MAX) {
              const center = (TRAP_ROD_SPEED_SWEET_MIN + TRAP_ROD_SPEED_SWEET_MAX) / 2;
              const half = (TRAP_ROD_SPEED_SWEET_MAX - TRAP_ROD_SPEED_SWEET_MIN) / 2;
              const quality = 1 - Math.abs(rs - center) / half;
              const damping = TRAP_BEST_DAMPING + (1 - quality) * 0.3;
              ball.vx *= damping; ball.vy *= damping;
              const trapDir = rod.owner === 1 ? 1 : -1;
              const trapX = rod.x + trapDir * (MAN_WIDTH / 2 + ball.radius + 1);
              ball.x += (trapX - ball.x) * 0.15 * quality;
            } else if (rs < TRAP_ROD_SPEED_SWEET_MIN) {
              const dot = ball.vx * nx + ball.vy * ny;
              ball.vx -= 2 * dot * nx; ball.vy -= 2 * dot * ny;
              ball.vx *= 0.92; ball.vy *= 0.92;
              ball.vx += nx * TRAP_ESCAPE_FORCE; ball.vy += ny * TRAP_ESCAPE_FORCE;
            } else {
              const dot = ball.vx * nx + ball.vy * ny;
              ball.vx -= 2 * dot * nx; ball.vy -= 2 * dot * ny;
              ball.vy += (rod.moveSpeed > 0 ? 1 : -1) * rs * 0.5;
              ball.vx *= 0.8; ball.vy *= 0.8;
            }
          } else {
            const dot = ball.vx * nx + ball.vy * ny;
            ball.vx -= 2 * dot * nx; ball.vy -= 2 * dot * ny;
            ball.vx *= 0.85; ball.vy *= 0.85;
          }
        }
      }
    }
  }
}

// ============================================================
// ROOM + NETWORKING
// ============================================================

function createRoom(roomId, mode) {
  const state = createInitialState();
  const room = {
    id: roomId,
    mode: mode || '2p',
    players: {},
    state,
    interval: null,
    playerCount: 0,
    maxPlayers: mode === '4p' ? 4 : 2,
  };
  rooms.set(roomId, room);
  return room;
}

function getPlayerRods(room, socketId) {
  const info = room.players[socketId];
  if (!info) return [];

  if (room.mode === '2p') {
    return room.state.rods
      .map((r, i) => r.owner === info.team ? i : -1)
      .filter(i => i >= 0);
  } else {
    const roles = TEAM_ROLES_4P[info.slot];
    return room.state.rods
      .map((r, i) => (r.owner === info.team && roles.includes(r.role)) ? i : -1)
      .filter(i => i >= 0);
  }
}

function canControlRod(room, socketId, rodIndex) {
  return getPlayerRods(room, socketId).includes(rodIndex);
}

function findMoveForRod(rod, moveId) {
  // Check role-specific moves first
  const roleMoves = SPECIAL_MOVES[rod.role] || [];
  const found = roleMoves.find(m => m.id === moveId);
  if (found) return found;
  // Check ALL moves
  const allMoves = SPECIAL_MOVES.ALL || [];
  return allMoves.find(m => m.id === moveId);
}

function startGame(room, roomId) {
  room.state.paused = true;
  room.state.countdown = 3;
  io.to(roomId).emit('gameStart');

  let count = 3;
  const countdownInterval = setInterval(() => {
    count--;
    io.to(roomId).emit('countdown', count);
    if (count <= 0) {
      clearInterval(countdownInterval);
      room.state.paused = false;
      room.state.countdown = 0;
      room.state.ball.vx = (Math.random() > 0.5 ? 1 : -1) * 4;
      room.state.ball.vy = (Math.random() - 0.5) * 3;
    }
  }, 1000);

  if (room.interval) clearInterval(room.interval);
  room.interval = setInterval(() => {
    updatePhysics(room.state);
    io.to(roomId).emit('state', room.state);
  }, TICK_INTERVAL);
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('joinRoom', ({ roomId, mode }) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom(roomId, mode);
    }

    if (room.playerCount >= room.maxPlayers) {
      socket.emit('roomFull');
      return;
    }

    room.playerCount++;
    let team, slot, playerNum;

    if (room.mode === '2p') {
      const teams = Object.values(room.players).map(p => p.team);
      team = teams.includes(1) ? 2 : 1;
      slot = null;
      playerNum = team;
    } else {
      const taken = Object.values(room.players).map(p => `${p.team}${p.slot}`);
      const order = ['1a', '2a', '1b', '2b'];
      const next = order.find(s => !taken.includes(s));
      team = parseInt(next[0]);
      slot = next[1];
      playerNum = room.playerCount;
    }

    room.players[socket.id] = { team, slot, playerNum };
    socket.join(roomId);
    socket.roomId = roomId;

    const myRodIndices = getPlayerRods(room, socket.id);

    socket.emit('joined', {
      playerNum,
      team,
      slot,
      mode: room.mode,
      state: room.state,
      table: TABLE,
      rodConfig: ROD_CONFIG,
      myRodIndices,
      specialMoves: SPECIAL_MOVES,
      winScore: WIN_SCORE,
    });

    const ready = room.mode === '2p' ? room.playerCount === 2 : room.playerCount === 4;
    if (ready) {
      startGame(room, roomId);
    } else {
      socket.emit('waitingForOpponent', {
        current: room.playerCount,
        needed: room.maxPlayers,
      });
      socket.to(roomId).emit('playerJoined', { current: room.playerCount, needed: room.maxPlayers });
    }
  });

  socket.on('moveRod', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (!canControlRod(room, socket.id, data.rodIndex)) return;
    const rod = room.state.rods[data.rodIndex];
    if (!rod) return;

    const prevOffset = rod.offsetY;
    const range = getSlideRange(rod);
    rod.offsetY = Math.max(-range, Math.min(range, data.offsetY));
    rod.moveSpeed = Math.abs(rod.offsetY - prevOffset);
  });

  socket.on('kick', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (!canControlRod(room, socket.id, data.rodIndex)) return;
    const rod = room.state.rods[data.rodIndex];
    if (!rod) return;

    if (!rod.kicking) {
      rod.kicking = true;
      rod.kickFrame = 0;
      rod.kickDirection = data.direction === -1 ? -1 : 1;
      rod.kickPower = Math.max(0, Math.min(1, data.power || 0.5));
      rod.kickAngle = Math.max(-1, Math.min(1, data.angle || 0));
      rod.fakeKick = false;
    }
  });

  socket.on('specialMove', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state.paused) return;
    if (!canControlRod(room, socket.id, data.rodIndex)) return;

    const rod = room.state.rods[data.rodIndex];
    if (!rod) return;
    const ball = room.state.ball;

    // Allow fakeshot and dribbleshot even if another special is active (they override)
    if (room.state.specialMove && data.moveId !== 'fakeshot' && data.moveId !== 'dribbleshot') return;

    // Verify ball is near rod (except fake shot which doesn't need ball)
    if (data.moveId !== 'fakeshot' && !isBallNearRod(ball, rod)) {
      socket.emit('specialMoveFailed', { reason: 'Ball not near rod' });
      return;
    }

    // Verify move exists
    const move = findMoveForRod(rod, data.moveId);
    if (!move) {
      socket.emit('specialMoveFailed', { reason: 'Invalid move' });
      return;
    }

    // Execute based on move type
    switch (data.moveId) {
      case 'ppsquare':
        room.state.specialMove = {
          type: 'ppsquare', rodIndex: data.rodIndex, owner: rod.owner,
          phase: 'dribble', frame: 0,
        };
        break;

      case 'cornetto': {
        const { index: manIdx, dist: manDist } = closestManToBall(ball, rod);
        // Check if ball is between two men (Double Cornetto)
        let isDouble = false;
        let man1Sorted = 0, man2Sorted = 0;
        if (rod.menCount >= 2) {
          const men = rod.men.map((m, i) => ({ y: m.y + rod.offsetY, i }));
          men.sort((a, b) => a.y - b.y);
          for (let i = 0; i < men.length - 1; i++) {
            if (ball.y >= men[i].y - MAN_HEIGHT / 2 && ball.y <= men[i + 1].y + MAN_HEIGHT / 2) {
              isDouble = true;
              man1Sorted = i;
              man2Sorted = i + 1;
              break;
            }
          }
        }
        room.state.specialMove = {
          type: 'cornetto', rodIndex: data.rodIndex, owner: rod.owner,
          phase: isDouble ? 'doubleDribble' : 'stick',
          frame: 0, manIndex: manIdx,
          man1Sorted, man2Sorted,
          isDouble,
        };
        break;
      }

      case 'spinneroni':
        room.state.specialMove = {
          type: 'spinneroni', rodIndex: data.rodIndex, owner: rod.owner,
          phase: 'charge', frame: 0, spinCharge: 0, spinDir: 1,
        };
        break;

      case 'fakeshot':
        room.state.specialMove = {
          type: 'fakeshot', rodIndex: data.rodIndex, owner: rod.owner, frame: 0,
        };
        break;

      case 'dribbleshot':
        room.state.specialMove = {
          type: 'dribbleshot', rodIndex: data.rodIndex, owner: rod.owner,
          phase: 'fake', frame: 0,
        };
        break;

      case 'diagonal':
        if (!isBallAtExtremity(ball, rod)) {
          socket.emit('specialMoveFailed', { reason: 'Ball must be at edge of rod' });
          return;
        }
        room.state.specialMove = {
          type: 'diagonal', rodIndex: data.rodIndex, owner: rod.owner,
          extremity: getBallExtremity(ball, rod),
        };
        break;

      case 'eliza':
        room.state.specialMove = {
          type: 'eliza', rodIndex: data.rodIndex, owner: rod.owner, frame: 0,
        };
        break;

      case 'yoyo':
        room.state.specialMove = {
          type: 'yoyo', rodIndex: data.rodIndex, owner: rod.owner,
        };
        break;

      case 'dory':
        room.state.specialMove = {
          type: 'dory', rodIndex: data.rodIndex, owner: rod.owner,
          mouseSpeed: data.mouseSpeed || 0,
        };
        break;

      case 'selfie':
        room.state.specialMove = {
          type: 'selfie', rodIndex: data.rodIndex, owner: rod.owner,
        };
        break;

      case 'spaghetti':
        room.state.specialMove = {
          type: 'spaghetti', rodIndex: data.rodIndex, owner: rod.owner,
        };
        break;

      case 'pepperoni':
        room.state.specialMove = {
          type: 'pepperoni', rodIndex: data.rodIndex, owner: rod.owner,
        };
        break;
    }

    io.to(socket.roomId).emit('specialMoveStarted', { type: data.moveId, rodIndex: data.rodIndex });
  });

  socket.on('ppsquareShoot', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const sm = room.state.specialMove;
    if (!sm || sm.type !== 'ppsquare' || sm.phase !== 'dribble') return;
    if (!canControlRod(room, socket.id, sm.rodIndex)) return;

    const f = sm.frame;
    let quality;
    if (f >= 30 && f <= 90) {
      quality = 1 - Math.abs(f - 60) / 30;
    } else {
      quality = 0.2;
    }
    sm.phase = 'shoot';
    sm.timingQuality = quality;
  });

  socket.on('cornettoShoot', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const sm = room.state.specialMove;
    if (!sm || sm.type !== 'cornetto') return;
    if (sm.phase !== 'stick' && sm.phase !== 'doubleDribble') return;
    if (!canControlRod(room, socket.id, sm.rodIndex)) return;

    // Timing quality: peaks at frame 40-80
    const f = sm.frame;
    let quality;
    if (f >= 20 && f <= 100) {
      quality = 1 - Math.abs(f - 60) / 40;
    } else {
      quality = 0.3;
    }
    sm.phase = 'shoot';
    sm.timingQuality = Math.max(0.2, quality);
  });

  socket.on('spinneroniFire', (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const sm = room.state.specialMove;
    if (!sm || sm.type !== 'spinneroni' || sm.phase !== 'charge') return;
    if (!canControlRod(room, socket.id, sm.rodIndex)) return;

    sm.phase = 'shoot';
    sm.spinCharge = Math.min(1, data.spinCharge || 0);
    sm.spinDir = data.spinDir || 1;
  });

  socket.on('requestShake', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.state.shaking) return;
    const info = room.players[socket.id];
    if (!info) return;

    if (info.team === 1) room.state.shakeRequests.p1 = true;
    if (info.team === 2) room.state.shakeRequests.p2 = true;

    io.to(socket.roomId).emit('shakeStatus', room.state.shakeRequests);

    if (room.state.shakeRequests.p1 && room.state.shakeRequests.p2) {
      room.state.shaking = true;
      room.state.shakeFrames = 0;
      io.to(socket.roomId).emit('shakeStart');
    }
  });

  socket.on('goalScored', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.state.paused && room.state.countdown > 0 && !room.state.winner) {
      let count = room.state.countdown;
      const ci = setInterval(() => {
        count--;
        room.state.countdown = count;
        io.to(socket.roomId).emit('countdown', count);
        if (count <= 0) { clearInterval(ci); room.state.paused = false; }
      }, 1000);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    const room = rooms.get(socket.roomId);
    if (!room) return;

    delete room.players[socket.id];
    room.playerCount--;

    if (room.playerCount <= 0) {
      if (room.interval) clearInterval(room.interval);
      rooms.delete(socket.roomId);
    } else {
      io.to(socket.roomId).emit('opponentLeft');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Foosball server running on http://localhost:${PORT}`);
});
