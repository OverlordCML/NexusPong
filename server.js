/**
 * NexusPong — authoritative Node + Express + Socket.io server
 *
 * The server owns ball position, collisions, scoring, power-ups and win
 * conditions. Clients only send paddle Y + smash-charge intent (~25 Hz).
 * Simulation runs at 60 Hz; full state is broadcast at 30 Hz.
 */
"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

/* ------------------------------------------------------------------ */
/* Config — tweak numbers here, nowhere else                           */
/* ------------------------------------------------------------------ */
const CONFIG = {
  TICK_RATE: 60,
  BROADCAST_RATE: 30,
  FIELD_W: 1000,
  FIELD_H: 600,

  PADDLE_W: 14,
  PADDLE_H_1V1: 112,
  PADDLE_H_2V2: 70,
  PADDLE_MARGIN: 38,
  PADDLE_SPEED: 980, // max px/s the server will chase a target Y

  BALL_R: 8.5,
  BALL_SPEED_INIT: 420,
  BALL_SPEED_INC: 22,
  BALL_SPEED_MAX: 980,
  BALL_SPEED_RALLY: 28,
  MAX_BOUNCE_ANGLE: (52 * Math.PI) / 180,
  SPIN_FACTOR: 0.38, // how much paddle vy becomes ball spin
  SPIN_CURVE: 0.9, // curve strength
  SPIN_DECAY: 0.93,

  SMASH_MULT: 1.6,
  SMASH_CHARGE_TIME: 0.42,
  SMASH_COOLDOWN: 7,

  WIN_SCORE: 11,
  WIN_BY: 2,

  SERVE_DELAY: 1.15,
  COUNTDOWN: 3,

  POWERUP_MIN: 9,
  POWERUP_MAX: 14,
  POWERUP_R: 16,
  PU: {
    overdrive: { dur: 6, mult: 1.6 },
    giant: { dur: 8, mult: 1.7 },
    shrink: { dur: 7, mult: 0.55 },
    multiball: { dur: 12 },
    ghost: { dur: 5 },
    reverse: { dur: 4 },
  },

  RALLY_FLASH: [6, 12, 18],
  RALLY_DOUBLE: 12,

  DISCONNECT_GRACE: 10,
  MAX_PLAYERS: 4,
  INPUT_Y_MIN: 0,
  INPUT_Y_MAX: 600,
};

const PU_TYPES = ["overdrive", "giant", "shrink", "multiball", "ghost", "reverse"];
const PU_LABEL = {
  overdrive: "OVERDRIVE",
  giant: "GIANT",
  shrink: "SHRINK",
  multiball: "MULTI-BALL",
  ghost: "GHOST",
  reverse: "REVERSE",
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function rand(a, b) {
  return a + Math.random() * (b - a);
}
function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}
function nowSec() {
  return Date.now() / 1000;
}
function generateCode() {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return c;
}
function hypot(x, y) {
  return Math.sqrt(x * x + y * y);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 8000,
  pingTimeout: 20000,
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, name: "NexusPong" }));

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */
/** @type {Map<string, Room>} */
const rooms = new Map();
/** socket.id -> { code, token } */
const socketIndex = new Map();

class Player {
  constructor(token, socketId, name) {
    this.token = token;
    this.socketId = socketId;
    this.name = name;
    this.ready = false;
    this.rematch = false;
    this.ping = 0;
    this.connected = true;
    this.team = 0; // 0 = left/cyan, 1 = right/magenta
    this.slot = 0; // 0 or 1 within the team (paddle index)
    this.targetY = CONFIG.FIELD_H / 2;
    this.charging = false;
  }
}

class Room {
  constructor(code, host) {
    this.code = code;
    this.hostToken = host.token;
    this.players = [host]; // join order — first two vs last two by default
    this.mode = "1v1";
    this.phase = "lobby"; // lobby | countdown | playing | paused | over
    this.game = null;
    this.countdownLeft = 0;
    this.pauseTimer = 0;
    this.pauseName = "";
    this.forfeitTeam = null;
    this.winner = null; // 0 | 1 | 'forfeit'
    this.finalScores = [0, 0];
  }

  getPlayer(token) {
    return this.players.find((p) => p.token === token) || null;
  }
  getBySocket(sid) {
    return this.players.find((p) => p.socketId === sid) || null;
  }
  connectedPlayers() {
    return this.players.filter((p) => p.connected);
  }
  isHost(token) {
    return this.hostToken === token;
  }

  reassignTeams() {
    // Prompt: first two vs last two. Host can swap, which reorders `players`.
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.players[i];
      if (this.mode === "1v1") {
        p.team = i % 2;
        p.slot = 0;
      } else {
        // 2v2: indices 0,1 → team 0 (slots 0,1); 2,3 → team 1
        p.team = i < 2 ? 0 : 1;
        p.slot = i % 2;
      }
    }
  }

  lobbyPayload() {
    return {
      code: this.code,
      mode: this.mode,
      phase: this.phase,
      hostToken: this.hostToken,
      winner: this.winner,
      scores: this.finalScores,
      forfeit: this.forfeitTeam !== null,
      names: teamNames(this),
      players: this.players.map((p) => ({
        token: p.token,
        name: p.name,
        ready: p.ready,
        rematch: p.rematch,
        ping: p.ping,
        connected: p.connected,
        team: p.team,
        slot: p.slot,
        isHost: p.token === this.hostToken,
      })),
    };
  }

  broadcastLobby() {
    io.to(this.code).emit("lobby", this.lobbyPayload());
  }

  emitAll(event, payload) {
    io.to(this.code).emit(event, payload);
  }

  canStart() {
    const ready = this.connectedPlayers().filter((p) => p.ready);
    if (this.mode === "1v1") return ready.length >= 2 && this.connectedPlayers().length >= 2;
    return ready.length >= 4 && this.connectedPlayers().length >= 4;
  }

  startMatch() {
    this.reassignTeams();
    this.winner = null;
    this.forfeitTeam = null;
    this.players.forEach((p) => (p.rematch = false));
    this.game = new Game(this);
    this.phase = "countdown";
    this.countdownLeft = CONFIG.COUNTDOWN;
    this.emitAll("countdown", { n: this.countdownLeft, mode: this.mode });
  }

  beginPlay() {
    this.phase = "playing";
    this.game.running = true;
    this.game.serve(Math.random() < 0.5 ? 1 : -1, true);
  }

  pauseForDisconnect(player) {
    if (this.phase !== "playing" && this.phase !== "countdown") return;
    this.phase = "paused";
    if (this.game) this.game.running = false;
    this.pauseTimer = CONFIG.DISCONNECT_GRACE;
    this.pauseName = player.name;
    this.emitAll("paused", {
      name: player.name,
      seconds: Math.ceil(this.pauseTimer),
    });
  }

  resumeIfPossible() {
    const missing = this.players.filter((p) => {
      if (this.mode === "1v1") return p.slot === 0 && !p.connected;
      return !p.connected;
    });
    // For 1v1 only the two active players matter; extras shouldn't exist.
    const needed = this.mode === "1v1" ? 2 : 4;
    const present = this.players.filter((p) => p.connected).length;
    if (present >= needed && missing.length === 0) {
      this.phase = "playing";
      if (this.game) this.game.running = true;
      this.emitAll("resumed", {});
    }
  }

  forfeit(disconnected) {
    this.phase = "over";
    if (this.game) this.game.running = false;
    const loseTeam = disconnected.team;
    const winTeam = 1 - loseTeam;
    this.winner = winTeam;
    this.forfeitTeam = loseTeam;
    this.finalScores = this.game ? [this.game.scores[0], this.game.scores[1]] : [0, 0];
    this.emitAll("matchOver", {
      winner: winTeam,
      scores: this.finalScores,
      forfeit: true,
      forfeitName: disconnected.name,
      names: teamNames(this),
    });
  }

  endMatch(winTeam) {
    this.phase = "over";
    if (this.game) this.game.running = false;
    this.winner = winTeam;
    this.finalScores = [this.game.scores[0], this.game.scores[1]];
    this.emitAll("matchOver", {
      winner: winTeam,
      scores: this.finalScores,
      forfeit: false,
      names: teamNames(this),
    });
  }

  backToLobby() {
    this.phase = "lobby";
    this.game = null;
    this.winner = null;
    this.players.forEach((p) => {
      p.ready = false;
      p.rematch = false;
    });
    this.broadcastLobby();
  }
}

function teamNames(room) {
  const a = room.players.filter((p) => p.team === 0).map((p) => p.name);
  const b = room.players.filter((p) => p.team === 1).map((p) => p.name);
  return {
    a: a.join(" + ") || "CYAN",
    b: b.join(" + ") || "MAGENTA",
  };
}

/* ------------------------------------------------------------------ */
/* Authoritative game                                                  */
/* ------------------------------------------------------------------ */
let ballSeq = 1;

class Ball {
  constructor(extra) {
    this.id = ballSeq++;
    this.x = CONFIG.FIELD_W / 2;
    this.y = CONFIG.FIELD_H / 2;
    this.vx = 0;
    this.vy = 0;
    this.r = CONFIG.BALL_R;
    this.spin = 0;
    this.ghostT = 0;
    this.overdriveT = 0;
    this.isExtra = !!extra;
    this.extraT = extra ? CONFIG.PU.multiball.dur : 0;
    this.lastHit = null; // player token
    this.serveDelay = 0;
    this.live = false;
  }
}

class Paddle {
  constructor(player, mode) {
    this.token = player.token;
    this.team = player.team;
    this.slot = player.slot;
    this.w = CONFIG.PADDLE_W;
    this.baseH = mode === "2v2" ? CONFIG.PADDLE_H_2V2 : CONFIG.PADDLE_H_1V1;
    this.h = this.baseH;
    this.x = player.team === 0 ? CONFIG.PADDLE_MARGIN : CONFIG.FIELD_W - CONFIG.PADDLE_MARGIN - this.w;
    this.y = defaultPaddleY(player, mode);
    this.prevY = this.y;
    this.vy = 0;
    this.targetY = this.y;
    this.smashCharge = 0;
    this.charging = false;
    this.smashCd = 0;
    this.giantT = 0;
    this.shrinkT = 0;
    this.reverseT = 0;
  }
}

function defaultPaddleY(player, mode) {
  if (mode === "1v1") return CONFIG.FIELD_H / 2;
  return player.slot === 0 ? CONFIG.FIELD_H * 0.32 : CONFIG.FIELD_H * 0.68;
}

class Game {
  constructor(room) {
    this.room = room;
    this.mode = room.mode;
    this.running = false;
    this.scores = [0, 0];
    this.rally = 0;
    this.rallyFlashed = new Set();
    this.balls = [];
    this.paddles = [];
    this.powerUp = null;
    this.puTimer = rand(CONFIG.POWERUP_MIN, CONFIG.POWERUP_MAX);
    this.fxQueue = []; // drained each broadcast

    const needed = this.mode === "1v1" ? 2 : 4;
    const active = room.players.slice(0, Math.max(needed, room.players.length));
    for (const p of active) {
      if (this.mode === "1v1" && this.paddles.length >= 2) break;
      if (this.mode === "2v2" && this.paddles.length >= 4) break;
      this.paddles.push(new Paddle(p, this.mode));
    }
    this.mainBall = new Ball(false);
    this.balls.push(this.mainBall);
  }

  paddleFor(token) {
    return this.paddles.find((p) => p.token === token) || null;
  }

  serve(dir, resetRally) {
    // Reset to a single live ball after a point.
    this.balls = [];
    this.mainBall = new Ball(false);
    this.balls.push(this.mainBall);
    const b = this.mainBall;
    b.x = CONFIG.FIELD_W / 2;
    b.y = CONFIG.FIELD_H / 2;
    b.vx = 0;
    b.vy = 0;
    b.spin = 0;
    b.live = false;
    b.serveDelay = CONFIG.SERVE_DELAY;
    b._serveDir = dir < 0 ? -1 : 1;
    if (resetRally) {
      this.rally = 0;
      this.rallyFlashed.clear();
    }
    this.fx("serve", CONFIG.FIELD_W / 2, CONFIG.FIELD_H / 2, 0);
  }

  launch(ball) {
    const angle = rand(-0.28, 0.28);
    const dir = ball._serveDir || (Math.random() < 0.5 ? 1 : -1);
    const spd = CONFIG.BALL_SPEED_INIT;
    ball.vx = Math.cos(angle) * spd * dir;
    ball.vy = Math.sin(angle) * spd;
    ball.live = true;
    ball.serveDelay = 0;
  }

  fx(type, x, y, team) {
    this.fxQueue.push({ type, x, y, team: team || 0, rally: this.rally });
  }

  tick(dt) {
    if (!this.running) return;

    this.updatePaddles(dt);
    this.updateBalls(dt);
    this.updatePowerUps(dt);
    this.decayEffects(dt);
    this.checkWin();
  }

  updatePaddles(dt) {
    for (const pad of this.paddles) {
      const pl = this.room.getPlayer(pad.token);
      if (pl) {
        let ty = pl.targetY;
        if (pad.reverseT > 0) ty = CONFIG.FIELD_H - ty;
        pad.targetY = ty;
        pad.charging = !!pl.charging && pad.smashCd <= 0;
      }

      // Chase target with a capped speed so a cheater can't teleport,
      // but 980 px/s is fast enough that a fair mouse never feels lagged.
      pad.prevY = pad.y;
      const maxMove = CONFIG.PADDLE_SPEED * dt;
      const dy = clamp(pad.targetY - pad.y, -maxMove, maxMove);
      pad.y += dy;
      const half = pad.h / 2;
      pad.y = clamp(pad.y, half, CONFIG.FIELD_H - half);
      pad.vy = dt > 0 ? (pad.y - pad.prevY) / dt : 0;

      if (pad.charging) {
        pad.smashCharge = Math.min(1, pad.smashCharge + dt / CONFIG.SMASH_CHARGE_TIME);
      } else {
        pad.smashCharge = Math.max(0, pad.smashCharge - dt * 2.4);
      }
      if (pad.smashCd > 0) pad.smashCd = Math.max(0, pad.smashCd - dt);
    }
  }

  refreshPaddleSize(pad) {
    let h = pad.baseH;
    if (pad.giantT > 0) h *= CONFIG.PU.giant.mult;
    if (pad.shrinkT > 0) h *= CONFIG.PU.shrink.mult;
    pad.h = h;
    pad.y = clamp(pad.y, pad.h / 2, CONFIG.FIELD_H - pad.h / 2);
  }

  updateBalls(dt) {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];

      if (b.isExtra) {
        b.extraT -= dt;
        if (b.extraT <= 0) {
          this.balls.splice(i, 1);
          continue;
        }
      }

      if (!b.live) {
        b.serveDelay -= dt;
        if (b.serveDelay <= 0) this.launch(b);
        continue;
      }

      // Subtle curve from spin (perpendicular acceleration).
      if (Math.abs(b.spin) > 4) {
        const spd = hypot(b.vx, b.vy) || 1;
        const nx = -b.vy / spd;
        const ny = b.vx / spd;
        b.vx += nx * b.spin * CONFIG.SPIN_CURVE * dt;
        b.vy += ny * b.spin * CONFIG.SPIN_CURVE * dt;
        b.spin *= Math.pow(CONFIG.SPIN_DECAY, dt * 60);
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Walls (top / bottom).
      if (b.y - b.r <= 0) {
        b.y = b.r;
        b.vy = Math.abs(b.vy);
        b.spin *= 0.55;
        this.fx("wall", b.x, 0, 0);
      } else if (b.y + b.r >= CONFIG.FIELD_H) {
        b.y = CONFIG.FIELD_H - b.r;
        b.vy = -Math.abs(b.vy);
        b.spin *= 0.55;
        this.fx("wall", b.x, CONFIG.FIELD_H, 0);
      }

      // Paddles — teammates occupy the same x and pass through each other,
      // so we test every paddle on the side the ball is approaching.
      this.collidePaddles(b);

      // Goals. Extra (multi-ball) scoring only removes that ball; the main
      // ball scoring resets the rally and re-serves, so we abort the loop.
      if (b.x + b.r < 0) {
        const extra = b.isExtra;
        this.onGoal(b, 1);
        if (!extra) return;
        continue;
      }
      if (b.x - b.r > CONFIG.FIELD_W) {
        const extra = b.isExtra;
        this.onGoal(b, 0);
        if (!extra) return;
        continue;
      }

      // Power-up pickup by ball.
      if (this.powerUp) this.tryCollect(b, null);
    }
  }

  collidePaddles(b) {
    const approachingLeft = b.vx < 0;
    for (const pad of this.paddles) {
      if (approachingLeft && pad.team !== 0) continue;
      if (!approachingLeft && pad.team !== 1) continue;

      const px = pad.x;
      const py = pad.y;
      const hw = pad.w;
      const hh = pad.h / 2;
      const r = b.r;

      // AABB vs circle, with a little vertical forgiveness so grazing hits
      // still register — feels better in 2v2 where paddles are shorter.
      const closestX = clamp(b.x, px, px + hw);
      const closestY = clamp(b.y, py - hh, py + hh);
      const dx = b.x - closestX;
      const dy = b.y - closestY;
      if (dx * dx + dy * dy > r * r) continue;

      // Must actually be in front of the paddle face so we don't catch a
      // ball that's already behind it (own-goal tunnel).
      if (pad.team === 0 && b.x < px) continue;
      if (pad.team === 1 && b.x > px + hw) continue;

      this.bounceOffPaddle(b, pad);
      break; // one bounce per tick
    }
  }

  bounceOffPaddle(b, pad) {
    const rel = clamp((b.y - pad.y) / (pad.h / 2 || 1), -1, 1);
    const angle = rel * CONFIG.MAX_BOUNCE_ANGLE;
    const dir = pad.team === 0 ? 1 : -1;

    let speed = hypot(b.vx, b.vy) + CONFIG.BALL_SPEED_INC;
    const smashed = pad.smashCharge >= 0.95 && pad.smashCd <= 0;
    if (smashed) {
      speed *= CONFIG.SMASH_MULT;
      pad.smashCharge = 0;
      pad.smashCd = CONFIG.SMASH_COOLDOWN;
      pad.charging = false;
      const pl = this.room.getPlayer(pad.token);
      if (pl) pl.charging = false;
    }
    speed = Math.min(CONFIG.BALL_SPEED_MAX, speed);

    b.vx = Math.cos(angle) * speed * dir;
    b.vy = Math.sin(angle) * speed + pad.vy * CONFIG.SPIN_FACTOR;
    b.spin = pad.vy * 1.15;
    b.lastHit = pad.token;

    // Nudge out so we don't re-collide next tick.
    if (pad.team === 0) b.x = pad.x + pad.w + b.r + 0.5;
    else b.x = pad.x - b.r - 0.5;

    this.rally += 1;
    if (CONFIG.RALLY_FLASH.includes(this.rally) && !this.rallyFlashed.has(this.rally)) {
      this.rallyFlashed.add(this.rally);
      speed = Math.min(CONFIG.BALL_SPEED_MAX, hypot(b.vx, b.vy) + CONFIG.BALL_SPEED_RALLY);
      const s = hypot(b.vx, b.vy) || 1;
      b.vx = (b.vx / s) * speed;
      b.vy = (b.vy / s) * speed;
      this.fx("rally", b.x, b.y, pad.team);
    }

    this.fx(smashed ? "smash" : "hit", b.x, b.y, pad.team);
  }

  onGoal(ball, scoringTeam) {
    if (ball.isExtra) {
      // Extra ball scores then vanishes — main rally continues.
      const pts = this.rally >= CONFIG.RALLY_DOUBLE ? 2 : 1;
      this.scores[scoringTeam] += pts;
      this.fx("score", ball.x, ball.y, scoringTeam);
      this.balls = this.balls.filter((b) => b !== ball);
      this.checkWin();
      return;
    }
    const pts = this.rally >= CONFIG.RALLY_DOUBLE ? 2 : 1;
    this.scores[scoringTeam] += pts;
    this.fx("score", ball.x, ball.y, scoringTeam);
    this.checkWin();
    if (this.room.phase === "playing") {
      // Serve toward the team that got scored on.
      const dir = scoringTeam === 0 ? 1 : -1;
      this.serve(dir, true);
    }
  }

  updatePowerUps(dt) {
    if (this.powerUp) {
      // Paddles can vacuum a power-up too.
      for (const pad of this.paddles) this.tryCollect(null, pad);
      return;
    }
    this.puTimer -= dt;
    if (this.puTimer <= 0) this.spawnPowerUp();
  }

  spawnPowerUp() {
    // Safe band: away from both paddle walls and the very center serve spot
    // is fine — we just keep it off the edges.
    this.powerUp = {
      type: pick(PU_TYPES),
      x: rand(180, CONFIG.FIELD_W - 180),
      y: rand(70, CONFIG.FIELD_H - 70),
      r: CONFIG.POWERUP_R,
    };
  }

  tryCollect(ball, pad) {
    const pu = this.powerUp;
    if (!pu) return;
    let hit = false;
    let collector = null;
    if (ball) {
      const dx = ball.x - pu.x;
      const dy = ball.y - pu.y;
      if (dx * dx + dy * dy <= (ball.r + pu.r) * (ball.r + pu.r)) {
        hit = true;
        collector = ball.lastHit ? this.room.getPlayer(ball.lastHit) : null;
      }
    }
    if (pad) {
      const closestX = clamp(pu.x, pad.x, pad.x + pad.w);
      const closestY = clamp(pu.y, pad.y - pad.h / 2, pad.y + pad.h / 2);
      const dx = pu.x - closestX;
      const dy = pu.y - closestY;
      if (dx * dx + dy * dy <= pu.r * pu.r) {
        hit = true;
        collector = this.room.getPlayer(pad.token);
      }
    }
    if (!hit) return;
    this.applyPowerUp(pu.type, collector, ball);
    this.powerUp = null;
    this.puTimer = rand(CONFIG.POWERUP_MIN, CONFIG.POWERUP_MAX);
  }

  applyPowerUp(type, collector, ball) {
    const name = collector ? collector.name : "A GHOST";
    this.room.emitAll("announce", { text: `${name} got ${PU_LABEL[type]}!`, type });
    this.fx("power", (ball && ball.x) || (this.powerUp && this.powerUp.x) || CONFIG.FIELD_W / 2,
      (ball && ball.y) || CONFIG.FIELD_H / 2, collector ? collector.team : 0);

    const team = collector ? collector.team : 0;
    const padOf = (token) => this.paddleFor(token);

    switch (type) {
      case "overdrive": {
        for (const b of this.balls) {
          if (b.overdriveT <= 0) {
            b.vx *= CONFIG.PU.overdrive.mult;
            b.vy *= CONFIG.PU.overdrive.mult;
          }
          b.overdriveT = CONFIG.PU.overdrive.dur;
        }
        break;
      }
      case "giant": {
        if (collector) {
          const pad = padOf(collector.token);
          if (pad) {
            pad.giantT = CONFIG.PU.giant.dur;
            this.refreshPaddleSize(pad);
          }
        }
        break;
      }
      case "shrink": {
        for (const pad of this.paddles) {
          if (pad.team !== team) {
            pad.shrinkT = CONFIG.PU.shrink.dur;
            this.refreshPaddleSize(pad);
          }
        }
        break;
      }
      case "multiball": {
        const src = this.mainBall;
        const extra = new Ball(true);
        extra.x = src.x;
        extra.y = src.y;
        extra.live = true;
        extra.lastHit = src.lastHit;
        extra.ghostT = src.ghostT;
        const ang = 0.42;
        extra.vx = src.vx * Math.cos(ang) - src.vy * Math.sin(ang);
        extra.vy = src.vx * Math.sin(ang) + src.vy * Math.cos(ang);
        if (hypot(extra.vx, extra.vy) < 200) {
          extra.vx = (src.vx || 200) * 0.9;
          extra.vy = (src.vy || 80) + 120;
        }
        this.balls.push(extra);
        break;
      }
      case "ghost": {
        for (const b of this.balls) b.ghostT = CONFIG.PU.ghost.dur;
        break;
      }
      case "reverse": {
        for (const pad of this.paddles) {
          if (pad.team !== team) pad.reverseT = CONFIG.PU.reverse.dur;
        }
        break;
      }
    }
  }

  decayEffects(dt) {
    for (const b of this.balls) {
      if (b.ghostT > 0) b.ghostT = Math.max(0, b.ghostT - dt);
      if (b.overdriveT > 0) {
        b.overdriveT -= dt;
        if (b.overdriveT <= 0) {
          b.overdriveT = 0;
          b.vx /= CONFIG.PU.overdrive.mult;
          b.vy /= CONFIG.PU.overdrive.mult;
        }
      }
    }
    for (const pad of this.paddles) {
      let sizeDirty = false;
      if (pad.giantT > 0) {
        pad.giantT -= dt;
        if (pad.giantT <= 0) {
          pad.giantT = 0;
          sizeDirty = true;
        }
      }
      if (pad.shrinkT > 0) {
        pad.shrinkT -= dt;
        if (pad.shrinkT <= 0) {
          pad.shrinkT = 0;
          sizeDirty = true;
        }
      }
      if (pad.reverseT > 0) pad.reverseT = Math.max(0, pad.reverseT - dt);
      if (sizeDirty) this.refreshPaddleSize(pad);
    }
  }

  checkWin() {
    const [a, b] = this.scores;
    const need = CONFIG.WIN_SCORE;
    const by = CONFIG.WIN_BY;
    if (a >= need && a - b >= by) this.room.endMatch(0);
    else if (b >= need && b - a >= by) this.room.endMatch(1);
  }

  serialize() {
    const fx = this.fxQueue;
    this.fxQueue = [];
    return {
      t: Date.now(),
      phase: this.room.phase,
      mode: this.mode,
      scores: [this.scores[0], this.scores[1]],
      rally: this.rally,
      balls: this.balls.map((b) => ({
        id: b.id,
        x: round1(b.x),
        y: round1(b.y),
        vx: round1(b.vx),
        vy: round1(b.vy),
        g: b.ghostT > 0 ? 1 : 0,
        od: b.overdriveT > 0 ? 1 : 0,
        ex: b.isExtra ? 1 : 0,
        live: b.live ? 1 : 0,
      })),
      paddles: this.paddles.map((p) => ({
        id: p.token,
        team: p.team,
        slot: p.slot,
        x: p.x,
        y: round1(p.y),
        h: round1(p.h),
        w: p.w,
        sc: round2(p.smashCharge),
        cd: round2(p.smashCd),
        gi: p.giantT > 0 ? round1(p.giantT) : 0,
        sh: p.shrinkT > 0 ? round1(p.shrinkT) : 0,
        rv: p.reverseT > 0 ? round1(p.reverseT) : 0,
      })),
      pu: this.powerUp ? { type: this.powerUp.type, x: round1(this.powerUp.x), y: round1(this.powerUp.y) } : null,
      names: teamNames(this.room),
      pings: this.room.players.map((p) => ({ id: p.token, ping: p.ping })),
      fx,
    };
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */
io.on("connection", (socket) => {
  socket.on("pingMs", (clientStamp) => {
    socket.emit("pongMs", { clientStamp, serverTime: Date.now() });
  });

  socket.on("createRoom", (data) => {
    try {
      const name = sanitizeName(data && data.name);
      const token = sanitizeToken(data && data.token) || makeToken();
      let code = generateCode();
      while (rooms.has(code)) code = generateCode();
      const host = new Player(token, socket.id, name);
      host.team = 0;
      host.slot = 0;
      const room = new Room(code, host);
      rooms.set(code, room);
      socket.join(code);
      socketIndex.set(socket.id, { code, token });
      socket.emit("roomCreated", { token, ...room.lobbyPayload() });
      room.broadcastLobby();
    } catch (e) {
      socket.emit("errorMsg", { msg: "Could not create room." });
    }
  });

  socket.on("joinRoom", (data) => {
    try {
      const code = String((data && data.code) || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
      const room = rooms.get(code);
      if (!room) {
        socket.emit("errorMsg", { msg: "Room not found." });
        return;
      }
      const token = sanitizeToken(data && data.token) || makeToken();
      const existing = room.getPlayer(token);

      // Reconnect path — same token, possibly mid-match.
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        if (data && data.name) existing.name = sanitizeName(data.name);
        socket.join(code);
        socketIndex.set(socket.id, { code, token });
        socket.emit("rejoined", { token, ...room.lobbyPayload() });
        room.broadcastLobby();
        if (room.phase === "paused") room.resumeIfPossible();
        return;
      }

      if (room.phase !== "lobby") {
        socket.emit("errorMsg", { msg: "Match already in progress." });
        return;
      }
      if (room.players.length >= CONFIG.MAX_PLAYERS) {
        socket.emit("errorMsg", { msg: "Room is full (max 4)." });
        return;
      }
      const player = new Player(token, socket.id, sanitizeName(data && data.name));
      room.players.push(player);
      room.reassignTeams();
      socket.join(code);
      socketIndex.set(socket.id, { code, token });
      socket.emit("roomJoined", { token, ...room.lobbyPayload() });
      room.broadcastLobby();
    } catch (e) {
      socket.emit("errorMsg", { msg: "Could not join room." });
    }
  });

  socket.on("setMode", (data) => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room || !room.isHost(ctx.token) || room.phase !== "lobby") return;
    const mode = data && data.mode === "2v2" ? "2v2" : "1v1";
    room.mode = mode;
    room.players.forEach((p) => (p.ready = false));
    room.reassignTeams();
    room.broadcastLobby();
  });

  socket.on("swapPlayers", (data) => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room || !room.isHost(ctx.token) || room.phase !== "lobby") return;
    const a = room.players.findIndex((p) => p.token === (data && data.a));
    const b = room.players.findIndex((p) => p.token === (data && data.b));
    if (a < 0 || b < 0 || a === b) return;
    const tmp = room.players[a];
    room.players[a] = room.players[b];
    room.players[b] = tmp;
    room.reassignTeams();
    room.broadcastLobby();
  });

  socket.on("setReady", (data) => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room || room.phase !== "lobby") return;
    const p = room.getPlayer(ctx.token);
    if (!p) return;
    p.ready = !!(data && data.ready);
    room.broadcastLobby();
  });

  socket.on("startMatch", () => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room || !room.isHost(ctx.token) || room.phase !== "lobby") return;
    if (!room.canStart()) {
      socket.emit("errorMsg", { msg: room.mode === "2v2" ? "Need 4 players ready." : "Need 2 players ready." });
      return;
    }
    room.startMatch();
  });

  socket.on("input", (data) => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room) return;
    const p = room.getPlayer(ctx.token);
    if (!p) return;
    if (typeof (data && data.y) === "number" && Number.isFinite(data.y)) {
      p.targetY = clamp(data.y, CONFIG.INPUT_Y_MIN, CONFIG.INPUT_Y_MAX);
    }
    p.charging = !!(data && data.charging);
  });

  socket.on("setPing", (ms) => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room) return;
    const p = room.getPlayer(ctx.token);
    if (!p) return;
    if (typeof ms === "number" && Number.isFinite(ms)) p.ping = clamp(ms | 0, 0, 9999);
  });

  socket.on("rematch", () => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room || room.phase !== "over") return;
    const p = room.getPlayer(ctx.token);
    if (!p) return;
    p.rematch = true;
    room.broadcastLobby();
    const connected = room.connectedPlayers();
    if (connected.length >= (room.mode === "2v2" ? 4 : 2) && connected.every((pl) => pl.rematch)) {
      room.startMatch();
    }
  });

  socket.on("backToLobby", () => {
    const ctx = socketIndex.get(socket.id);
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    if (!room) return;
    if (!room.isHost(ctx.token) && room.phase !== "over") return;
    room.backToLobby();
    room.emitAll("lobby", room.lobbyPayload());
  });

  socket.on("leaveRoom", () => handleLeave(socket, false));
  socket.on("disconnect", () => handleLeave(socket, true));
});

function handleLeave(socket, isDisconnect) {
  const ctx = socketIndex.get(socket.id);
  if (!ctx) return;
  socketIndex.delete(socket.id);
  const room = rooms.get(ctx.code);
  if (!room) return;
  const p = room.getPlayer(ctx.token);
  if (!p) return;
  // A newer socket already claimed this player (refresh / second tab).
  if (p.socketId && p.socketId !== socket.id) return;

  if (isDisconnect && (room.phase === "playing" || room.phase === "countdown" || room.phase === "paused")) {
    p.connected = false;
    p.socketId = null;
    room.pauseForDisconnect(p);
    room.broadcastLobby();
    return;
  }

  // Hard leave (button) or disconnect in lobby/over.
  room.players = room.players.filter((pl) => pl.token !== ctx.token);
  socket.leave(room.code);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostToken === ctx.token) {
    const next = room.connectedPlayers()[0] || room.players[0];
    room.hostToken = next.token;
  }
  room.reassignTeams();
  if (room.phase === "playing" || room.phase === "countdown" || room.phase === "paused") {
    // They intentionally left a live match — forfeit their team.
    room.forfeit(p);
  }
  room.broadcastLobby();
}

function sanitizeName(n) {
  const s = String(n || "")
    .replace(/[^\w \-_.]/g, "")
    .trim()
    .slice(0, 14);
  return s || "PLAYER";
}
function sanitizeToken(t) {
  const s = String(t || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return s.length >= 8 ? s : "";
}
function makeToken() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

/* ------------------------------------------------------------------ */
/* Fixed-timestep loop + broadcast                                     */
/* ------------------------------------------------------------------ */
const STEP = 1 / CONFIG.TICK_RATE;
let acc = 0;
let last = Date.now();
let broadcastAcc = 0;
const BROAD_STEP = 1 / CONFIG.BROADCAST_RATE;

function frame() {
  const t = Date.now();
  let dt = (t - last) / 1000;
  last = t;
  if (dt > 0.25) dt = 0.25; // spiral-of-death guard
  acc += dt;
  broadcastAcc += dt;

  while (acc >= STEP) {
    for (const room of rooms.values()) {
      if (room.phase === "countdown") {
        room.countdownLeft -= STEP;
        const n = Math.ceil(room.countdownLeft);
        if (n !== room._lastCd && n > 0) {
          room._lastCd = n;
          room.emitAll("countdown", { n, mode: room.mode });
        }
        // Let players line up during the 3-2-1; the ball is not live yet.
        if (room.game) room.game.updatePaddles(STEP);
        if (room.countdownLeft <= 0) {
          room._lastCd = 0;
          room.beginPlay();
        }
      } else if (room.phase === "paused") {
        room.pauseTimer -= STEP;
        if (Math.ceil(room.pauseTimer) !== room._lastPause) {
          room._lastPause = Math.ceil(room.pauseTimer);
          room.emitAll("paused", {
            name: room.pauseName,
            seconds: Math.max(0, room._lastPause),
          });
        }
        if (room.pauseTimer <= 0) {
          const gone = room.players.find((p) => !p.connected);
          if (gone) room.forfeit(gone);
          else room.resumeIfPossible();
        }
      } else if (room.phase === "playing" && room.game) {
        room.game.tick(STEP);
      }
    }
    acc -= STEP;
  }

  if (broadcastAcc >= BROAD_STEP) {
    broadcastAcc = 0;
    for (const room of rooms.values()) {
      if (room.game && (room.phase === "playing" || room.phase === "countdown" || room.phase === "paused")) {
        room.emitAll("state", room.game.serialize());
      }
    }
  }

  setImmediate ? setTimeout(frame, 1000 / CONFIG.TICK_RATE) : setTimeout(frame, 16);
}
frame();

// Empty-room janitor.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.connectedPlayers().length === 0) rooms.delete(code);
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`NexusPong listening on http://0.0.0.0:${PORT}`);
});
