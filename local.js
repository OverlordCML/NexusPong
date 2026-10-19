/**
 * NexusPong — local 1v1 simulation + bot
 *
 * Same physics numbers as server.js so vs-bot feels like online play.
 * Snapshot shape matches the networked `state` packet so the existing
 * renderer / HUD / particles can stay unchanged.
 *
 * Open public/index.html from disk → this runs, no Node required.
 * Host the whole project with `node server.js` → multiplayer also works.
 */
(function (global) {
  "use strict";

  const C = {
    FIELD_W: 1000,
    FIELD_H: 600,
    PADDLE_W: 14,
    PADDLE_H: 112,
    PADDLE_MARGIN: 38,
    PADDLE_SPEED: 980,
    BALL_R: 8.5,
    BALL_SPEED_INIT: 420,
    BALL_SPEED_INC: 22,
    BALL_SPEED_MAX: 980,
    BALL_SPEED_RALLY: 28,
    MAX_BOUNCE_ANGLE: (52 * Math.PI) / 180,
    SPIN_FACTOR: 0.38,
    SPIN_CURVE: 0.9,
    SPIN_DECAY: 0.93,
    SMASH_MULT: 1.6,
    SMASH_CHARGE_TIME: 0.42,
    SMASH_COOLDOWN: 7,
    WIN_SCORE: 11,
    WIN_BY: 2,
    SERVE_DELAY: 1.15,
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

  const DIFF = {
    easy: {
      maxSpeed: 340,
      react: 0.34,
      error: 78,
      lookAhead: 0.42,
      smashChance: 0.04,
      smashDist: 140,
      idleDrift: 90,
      trackAway: 0.12,
      aimEdge: 0,
    },
    normal: {
      maxSpeed: 580,
      react: 0.13,
      error: 26,
      lookAhead: 0.82,
      smashChance: 0.28,
      smashDist: 200,
      idleDrift: 40,
      trackAway: 0.32,
      aimEdge: 0.15,
    },
    hard: {
      maxSpeed: 860,
      react: 0.045,
      error: 7,
      lookAhead: 1.05,
      smashChance: 0.5,
      smashDist: 260,
      idleDrift: 18,
      trackAway: 0.55,
      aimEdge: 0.45,
    },
  };

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }
  function hypot(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  class Ball {
    constructor(isExtra) {
      this.id = "b" + Math.random().toString(36).slice(2, 8);
      this.x = C.FIELD_W / 2;
      this.y = C.FIELD_H / 2;
      this.vx = 0;
      this.vy = 0;
      this.r = C.BALL_R;
      this.spin = 0;
      this.live = false;
      this.serveDelay = 0;
      this._serveDir = 1;
      this.lastHit = null;
      this.isExtra = !!isExtra;
      this.extraT = isExtra ? C.PU.multiball.dur : 0;
      this.ghostT = 0;
      this.overT = 0;
    }
  }

  class Paddle {
    constructor(id, team, name) {
      this.id = id;
      this.team = team;
      this.name = name;
      this.w = C.PADDLE_W;
      this.baseH = C.PADDLE_H;
      this.h = C.PADDLE_H;
      this.x = team === 0 ? C.PADDLE_MARGIN : C.FIELD_W - C.PADDLE_MARGIN - C.PADDLE_W;
      this.y = C.FIELD_H / 2;
      this.prevY = this.y;
      this.vy = 0;
      this.targetY = this.y;
      this.charging = false;
      this.smashCharge = 0;
      this.smashCd = 0;
      this.giantT = 0;
      this.shrinkT = 0;
      this.reverseT = 0;
    }
  }

  class LocalMatch {
    constructor(opts) {
      opts = opts || {};
      this.playerId = opts.playerId || "PLAYER";
      this.playerName = (opts.playerName || "YOU").slice(0, 14);
      this.botId = "BOT";
      this.botName = opts.botName || this._botName(opts.difficulty);
      this.difficulty = DIFF[opts.difficulty] ? opts.difficulty : "normal";
      this.ai = DIFF[this.difficulty];

      this.paddles = [
        new Paddle(this.playerId, 0, this.playerName),
        new Paddle(this.botId, 1, this.botName),
      ];
      this.playerPad = this.paddles[0];
      this.botPad = this.paddles[1];

      this.balls = [];
      this.mainBall = null;
      this.scores = [0, 0];
      this.rally = 0;
      this.rallyFlashed = {};
      this.phase = "countdown";
      this.countdown = 3;
      this.countdownAcc = 0;
      this.running = false;
      this.winner = -1;
      this.powerUp = null;
      this.puTimer = rand(C.POWERUP_MIN, C.POWERUP_MAX);
      this.fxQueue = [];
      this.announces = [];
      this.over = false;

      this.aiTarget = C.FIELD_H / 2;
      this.aiReactT = 0;
      this.aiError = 0;
      this.aiSmashHold = false;
      this.aiIdleT = 0;

      this.serve(Math.random() < 0.5 ? -1 : 1, true);
    }

    _botName(d) {
      if (d === "easy") return "TRAINEE-01";
      if (d === "hard") return "NEXUS-9";
      return "SENTINEL";
    }

    fx(type, x, y, team) {
      this.fxQueue.push({ type: type, x: x, y: y, team: team || 0, rally: this.rally });
    }
    announce(text) {
      this.announces.push(text);
    }

    serve(dir, resetRally) {
      this.balls = [];
      this.mainBall = new Ball(false);
      this.balls.push(this.mainBall);
      const b = this.mainBall;
      b.x = C.FIELD_W / 2;
      b.y = C.FIELD_H / 2;
      b.vx = 0;
      b.vy = 0;
      b.spin = 0;
      b.live = false;
      b.serveDelay = C.SERVE_DELAY;
      b._serveDir = dir < 0 ? -1 : 1;
      if (resetRally) {
        this.rally = 0;
        this.rallyFlashed = {};
      }
      this.fx("serve", C.FIELD_W / 2, C.FIELD_H / 2, 0);
    }

    launch(ball) {
      const angle = rand(-0.28, 0.28);
      const dir = ball._serveDir || 1;
      const spd = C.BALL_SPEED_INIT;
      ball.vx = Math.cos(angle) * spd * dir;
      ball.vy = Math.sin(angle) * spd;
      ball.live = true;
      ball.serveDelay = 0;
    }

    update(dt, input) {
      const events = { fx: [], announces: [], countdown: null, over: null };

      if (this.phase === "countdown") {
        this.countdownAcc += dt;
        const left = Math.ceil(this.countdown - this.countdownAcc);
        if (left !== this._lastCd) {
          this._lastCd = left;
          events.countdown = Math.max(1, left);
        }
        this._applyPlayerInput(input);
        this._updatePaddles(dt);
        if (this.countdownAcc >= this.countdown) {
          this.phase = "playing";
          this.running = true;
        }
        events.fx = this.fxQueue.splice(0);
        events.announces = this.announces.splice(0);
        return events;
      }

      if (this.phase !== "playing") {
        events.fx = this.fxQueue.splice(0);
        events.announces = this.announces.splice(0);
        if (this.over) events.over = this._overPayload();
        return events;
      }

      this._applyPlayerInput(input);
      this._updateAI(dt);
      this._updatePaddles(dt);
      this._updateBalls(dt);
      this._updatePowerUps(dt);
      this._decayEffects(dt);
      this._checkWin();

      events.fx = this.fxQueue.splice(0);
      events.announces = this.announces.splice(0);
      if (this.over) events.over = this._overPayload();
      return events;
    }

    _applyPlayerInput(input) {
      input = input || {};
      let y = typeof input.y === "number" ? input.y : this.playerPad.targetY;
      this.playerPad.targetY = y;
      this.playerPad.charging = !!input.charging && this.playerPad.smashCd <= 0;
    }

    /* ---- AI: predict intercept, add error, optional smash ---- */
    _updateAI(dt) {
      const cfg = this.ai;
      const pad = this.botPad;
      const incoming = this._primaryIncoming();

      this.aiReactT -= dt;
      this.aiIdleT += dt;

      if (incoming) {
        const b = incoming;
        const timeToPad = Math.max(0.05, (pad.x - b.x) / (b.vx || 1));
        const look = Math.min(timeToPad, 0.9) * cfg.lookAhead;
        let predY = b.y + b.vy * look;

        // Reflect off top/bottom so the bot aims at the bounced intercept.
        const h = C.FIELD_H;
        const period = h * 2;
        let m = predY % period;
        if (m < 0) m += period;
        predY = m > h ? period - m : m;

        if (this.aiReactT <= 0) {
          this.aiReactT = cfg.react * rand(0.7, 1.3);
          this.aiError = rand(-cfg.error, cfg.error);
          if (cfg.aimEdge > 0 && Math.random() < cfg.aimEdge) {
            this.aiError += (Math.random() < 0.5 ? -1 : 1) * pad.h * 0.32;
          }
        }
        this.aiTarget = predY + this.aiError;

        const dist = pad.x - b.x;
        const aligned = Math.abs(pad.y - predY) < pad.h * 0.42;
        if (
          pad.smashCd <= 0 &&
          dist < cfg.smashDist &&
          dist > 40 &&
          aligned &&
          Math.random() < cfg.smashChance * dt * 8
        ) {
          this.aiSmashHold = true;
        }
        if (dist < 28) this.aiSmashHold = false;
      } else {
        // Ball going away — drift toward center with a little wander.
        const wander = Math.sin(this.aiIdleT * 1.3) * cfg.idleDrift;
        this.aiTarget = C.FIELD_H / 2 + wander;
        this.aiSmashHold = false;
        // Still peek at extra balls coming our way.
      }

      pad.targetY = this.aiTarget;
      pad.charging = this.aiSmashHold && pad.smashCd <= 0;
    }

    _primaryIncoming() {
      let best = null;
      let bestT = 1e9;
      for (const b of this.balls) {
        if (!b.live || b.vx <= 40) continue;
        const t = (this.botPad.x - b.x) / b.vx;
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = b;
        }
      }
      return best;
    }

    _updatePaddles(dt) {
      for (const pad of this.paddles) {
        let ty = pad.targetY;
        if (pad.reverseT > 0) ty = C.FIELD_H - ty;

        pad.prevY = pad.y;
        const maxSpd = pad.id === this.botId ? this.ai.maxSpeed : C.PADDLE_SPEED;
        const maxMove = maxSpd * dt;
        const desired = clamp(ty, pad.h / 2, C.FIELD_H - pad.h / 2);
        const dy = clamp(desired - pad.y, -maxMove, maxMove);
        pad.y += dy;
        pad.y = clamp(pad.y, pad.h / 2, C.FIELD_H - pad.h / 2);
        pad.vy = dt > 0 ? (pad.y - pad.prevY) / dt : 0;

        if (pad.charging) {
          pad.smashCharge = Math.min(1, pad.smashCharge + dt / C.SMASH_CHARGE_TIME);
        } else {
          pad.smashCharge = Math.max(0, pad.smashCharge - dt * 2.4);
        }
        if (pad.smashCd > 0) pad.smashCd = Math.max(0, pad.smashCd - dt);
      }
    }

    _refreshSize(pad) {
      let h = pad.baseH;
      if (pad.giantT > 0) h *= C.PU.giant.mult;
      if (pad.shrinkT > 0) h *= C.PU.shrink.mult;
      pad.h = h;
      pad.y = clamp(pad.y, pad.h / 2, C.FIELD_H - pad.h / 2);
    }

    _updateBalls(dt) {
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

        if (Math.abs(b.spin) > 4) {
          const spd = hypot(b.vx, b.vy) || 1;
          const nx = -b.vy / spd;
          const ny = b.vx / spd;
          b.vx += nx * b.spin * C.SPIN_CURVE * dt;
          b.vy += ny * b.spin * C.SPIN_CURVE * dt;
          b.spin *= Math.pow(C.SPIN_DECAY, dt * 60);
        }

        let speedMult = 1;
        if (b.overT > 0) speedMult *= C.PU.overdrive.mult;
        b.x += b.vx * dt * speedMult;
        b.y += b.vy * dt * speedMult;

        if (b.y - b.r <= 0) {
          b.y = b.r;
          b.vy = Math.abs(b.vy);
          b.spin *= 0.55;
          this.fx("wall", b.x, 0, 0);
        } else if (b.y + b.r >= C.FIELD_H) {
          b.y = C.FIELD_H - b.r;
          b.vy = -Math.abs(b.vy);
          b.spin *= 0.55;
          this.fx("wall", b.x, C.FIELD_H, 0);
        }

        this._collidePaddles(b);

        if (b.x + b.r < 0) {
          const extra = b.isExtra;
          this._onGoal(b, 1);
          if (!extra) return;
          continue;
        }
        if (b.x - b.r > C.FIELD_W) {
          const extra = b.isExtra;
          this._onGoal(b, 0);
          if (!extra) return;
          continue;
        }

        if (this.powerUp) this._tryCollect(b, null);
      }

      for (const pad of this.paddles) {
        if (this.powerUp) this._tryCollect(null, pad);
      }
    }

    _collidePaddles(b) {
      const approachingLeft = b.vx < 0;
      for (const pad of this.paddles) {
        if (approachingLeft && pad.team !== 0) continue;
        if (!approachingLeft && pad.team !== 1) continue;

        const px = pad.x;
        const py = pad.y;
        const hw = pad.w;
        const hh = pad.h / 2;
        const r = b.r;
        const closestX = clamp(b.x, px, px + hw);
        const closestY = clamp(b.y, py - hh, py + hh);
        const dx = b.x - closestX;
        const dy = b.y - closestY;
        if (dx * dx + dy * dy > r * r) continue;

        // Don't re-hit the same paddle until the ball has left.
        if (b._lastPad === pad && b._hitLock > 0) continue;

        const rel = clamp((b.y - py) / hh, -1, 1);
        const angle = rel * C.MAX_BOUNCE_ANGLE;
        let spd = hypot(b.vx, b.vy) + C.BALL_SPEED_INC;
        const smashed = pad.smashCharge >= 0.85 && pad.smashCd <= 0;
        if (smashed) {
          spd *= C.SMASH_MULT;
          pad.smashCd = C.SMASH_COOLDOWN;
          pad.smashCharge = 0;
          pad.charging = false;
          if (pad.id === this.botId) this.aiSmashHold = false;
          this.fx("smash", b.x, b.y, pad.team);
        } else {
          this.fx("hit", b.x, b.y, pad.team);
        }
        spd = Math.min(C.BALL_SPEED_MAX, spd);

        const dir = pad.team === 0 ? 1 : -1;
        b.vx = Math.cos(angle) * spd * dir;
        b.vy = Math.sin(angle) * spd;
        b.spin = pad.vy * C.SPIN_FACTOR;
        b.lastHit = pad;
        b._lastPad = pad;
        b._hitLock = 0.08;

        if (pad.team === 0) b.x = px + hw + r + 0.5;
        else b.x = px - r - 0.5;

        this.rally += 1;
        if (C.RALLY_FLASH.indexOf(this.rally) !== -1 && !this.rallyFlashed[this.rally]) {
          this.rallyFlashed[this.rally] = true;
          spd = Math.min(C.BALL_SPEED_MAX, hypot(b.vx, b.vy) + C.BALL_SPEED_RALLY);
          const cur = hypot(b.vx, b.vy) || 1;
          b.vx = (b.vx / cur) * spd;
          b.vy = (b.vy / cur) * spd;
          this.fx("rally", b.x, b.y, pad.team);
          this.announce("RALLY " + this.rally);
        }
      }
      if (b._hitLock > 0) b._hitLock -= 1 / 60;
    }

    _onGoal(ball, scoringTeam) {
      const pts = this.rally >= C.RALLY_DOUBLE ? 2 : 1;
      this.scores[scoringTeam] += pts;
      this.fx("score", scoringTeam === 0 ? C.FIELD_W : 0, ball.y, scoringTeam);
      if (pts > 1) this.announce("DOUBLE — RALLY " + this.rally);

      if (ball.isExtra) {
        const idx = this.balls.indexOf(ball);
        if (idx >= 0) this.balls.splice(idx, 1);
        return;
      }
      const dir = scoringTeam === 0 ? 1 : -1;
      this.serve(dir, true);
    }

    _updatePowerUps(dt) {
      if (this.powerUp) return;
      this.puTimer -= dt;
      if (this.puTimer > 0) return;
      this.puTimer = rand(C.POWERUP_MIN, C.POWERUP_MAX);
      this.powerUp = {
        type: pick(PU_TYPES),
        x: rand(220, C.FIELD_W - 220),
        y: rand(80, C.FIELD_H - 80),
      };
    }

    _tryCollect(ball, pad) {
      const pu = this.powerUp;
      if (!pu) return;
      let hit = false;
      let collector = null;
      if (ball) {
        const dx = ball.x - pu.x;
        const dy = ball.y - pu.y;
        if (dx * dx + dy * dy <= (C.POWERUP_R + ball.r) * (C.POWERUP_R + ball.r)) {
          hit = true;
          collector = ball.lastHit;
        }
      }
      if (pad) {
        const px = clamp(pu.x, pad.x, pad.x + pad.w);
        const py = clamp(pu.y, pad.y - pad.h / 2, pad.y + pad.h / 2);
        const dx = pu.x - px;
        const dy = pu.y - py;
        if (dx * dx + dy * dy <= C.POWERUP_R * C.POWERUP_R) {
          hit = true;
          collector = pad;
        }
      }
      if (!hit || !collector) return;

      this.powerUp = null;
      this.fx("power", pu.x, pu.y, collector.team);
      this.announce((collector.name || "PLAYER") + " got " + PU_LABEL[pu.type] + "!");
      this._applyPU(pu.type, collector, ball);
    }

    _applyPU(type, collector, ball) {
      const foe = this.paddles.filter((p) => p.team !== collector.team);
      if (type === "overdrive") {
        for (const b of this.balls) b.overT = C.PU.overdrive.dur;
      } else if (type === "giant") {
        collector.giantT = C.PU.giant.dur;
        this._refreshSize(collector);
      } else if (type === "shrink") {
        foe.forEach((p) => {
          p.shrinkT = C.PU.shrink.dur;
          this._refreshSize(p);
        });
      } else if (type === "multiball") {
        const src = ball || this.mainBall;
        const extra = new Ball(true);
        extra.x = src.x;
        extra.y = src.y;
        extra.live = true;
        extra.vx = -src.vx * 0.85;
        extra.vy = src.vy * 0.7 + rand(-80, 80);
        extra.lastHit = collector;
        this.balls.push(extra);
      } else if (type === "ghost") {
        for (const b of this.balls) b.ghostT = C.PU.ghost.dur;
      } else if (type === "reverse") {
        foe.forEach((p) => (p.reverseT = C.PU.reverse.dur));
      }
    }

    _decayEffects(dt) {
      for (const pad of this.paddles) {
        if (pad.giantT > 0) {
          pad.giantT = Math.max(0, pad.giantT - dt);
          if (pad.giantT === 0) this._refreshSize(pad);
        }
        if (pad.shrinkT > 0) {
          pad.shrinkT = Math.max(0, pad.shrinkT - dt);
          if (pad.shrinkT === 0) this._refreshSize(pad);
        }
        if (pad.reverseT > 0) pad.reverseT = Math.max(0, pad.reverseT - dt);
      }
      for (const b of this.balls) {
        if (b.ghostT > 0) b.ghostT = Math.max(0, b.ghostT - dt);
        if (b.overT > 0) b.overT = Math.max(0, b.overT - dt);
      }
    }

    _checkWin() {
      const a = this.scores[0];
      const b = this.scores[1];
      if (a >= C.WIN_SCORE && a - b >= C.WIN_BY) this._end(0);
      else if (b >= C.WIN_SCORE && b - a >= C.WIN_BY) this._end(1);
    }

    _end(winner) {
      this.over = true;
      this.winner = winner;
      this.phase = "over";
      this.running = false;
      this.fx("win", C.FIELD_W / 2, C.FIELD_H / 2, winner);
    }

    _overPayload() {
      return {
        winner: this.winner,
        scores: this.scores.slice(),
        forfeit: false,
        names: { a: this.playerName, b: this.botName },
        vsBot: true,
      };
    }

    snapshot() {
      return {
        t: performance.now(),
        phase: this.phase,
        mode: "1v1",
        scores: this.scores.slice(),
        rally: this.rally,
        names: { a: this.playerName, b: this.botName },
        paddles: this.paddles.map((p) => ({
          id: p.id,
          team: p.team,
          slot: 0,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          sc: p.smashCharge,
          cd: p.smashCd,
          rv: p.reverseT,
          gi: p.giantT,
          sh: p.shrinkT,
        })),
        balls: this.balls.map((b) => ({
          id: b.id,
          x: b.x,
          y: b.y,
          g: b.ghostT > 0,
          od: b.overT > 0,
          ex: b.isExtra,
        })),
        pu: this.powerUp ? { type: this.powerUp.type, x: this.powerUp.x, y: this.powerUp.y } : null,
        fx: [],
      };
    }
  }

  global.LocalMatch = LocalMatch;
  global.NP_DIFFICULTY = DIFF;
})(window);
