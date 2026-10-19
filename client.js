/**
 * NexusPong client
 * UI · input (mouse + keyboard) · interpolation · renderer · particles · audio
 *
 * Remote paddles and the ball are interpolated against a short snapshot buffer
 * so 80–120 ms of RTT never looks stuttery. Your own paddle is predicted
 * locally (mouse / keys) and reconciled by the authoritative server.
 */
(function () {
  "use strict";

  /* ================================================================== */
  /* Config (mirrors server.js — keep in sync)                           */
  /* ================================================================== */
  const CFG = {
    FIELD_W: 1000,
    FIELD_H: 600,
    PADDLE_W: 14,
    PADDLE_H_1V1: 112,
    PADDLE_H_2V2: 70,
    PADDLE_MARGIN: 38,
    BALL_R: 8.5,
    SMASH_COOLDOWN: 7,
    INTERP_DELAY: 80,
    INPUT_HZ: 25,
    KEY_SPEED: 980,
    COLORS: {
      bg: "#05060c",
      grid: "#12182a",
      cyan: "#00f0ff",
      magenta: "#ff2bd6",
      orange: "#ff8a00",
      gold: "#ffd166",
      wall: "#1a2240",
      ball: "#f4fbff",
    },
    PU: {
      overdrive: { icon: "⚡", color: "#ffd166", label: "OVERDRIVE" },
      giant: { icon: "📏", color: "#00f0ff", label: "GIANT" },
      shrink: { icon: "🔻", color: "#ff8a00", label: "SHRINK" },
      multiball: { icon: "🌀", color: "#e8f1ff", label: "MULTI-BALL" },
      ghost: { icon: "👻", color: "#c084fc", label: "GHOST" },
      reverse: { icon: "🔄", color: "#ff2bd6", label: "REVERSE" },
    },
  };

  /* ================================================================== */
  /* DOM                                                                 */
  /* ================================================================== */
  const $ = (id) => document.getElementById(id);
  const screens = {
    menu: $("screen-menu"),
    lobby: $("screen-lobby"),
    game: $("screen-game"),
    victory: $("screen-victory"),
  };
  const canvas = $("game-canvas");
  const ctx = canvas.getContext("2d");

  function showScreen(name) {
    Object.keys(screens).forEach((k) => {
      screens[k].classList.toggle("hidden", k !== name);
    });
  }

  /* ================================================================== */
  /* Session / identity                                                  */
  /* ================================================================== */
  function getToken() {
    let t = sessionStorage.getItem("np_token");
    if (!t) {
      t =
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem("np_token", t);
    }
    return t;
  }
  const TOKEN = getToken();

  function nick() {
    const v = ($("nick").value || "").trim().slice(0, 14);
    if (v) {
      localStorage.setItem("np_nick", v);
      return v;
    }
    return localStorage.getItem("np_nick") || "PLAYER";
  }

  /* ================================================================== */
  /* App state                                                           */
  /* ================================================================== */
  const S = {
    screen: "menu",
    room: null,
    me: TOKEN,
    isHost: false,
    mode: "1v1",
    phase: "lobby",
    localY: CFG.FIELD_H / 2,
    charging: false,
    keys: { up: false, down: false },
    lastMouse: 0,
    ping: 0,
    muted: false,
    swapPick: null,
    latest: null,
    names: { a: "CYAN", b: "MAGENTA" },
    reverseLocal: false,
    vsBot: false,
    botDiff: "normal",
    localMatch: null,
    pausedLocal: false,
  };

  /* ================================================================== */
  /* Audio — Web Audio API, no asset files                               */
  /* ================================================================== */
  const AudioFX = {
    ctx: null,
    muted: false,
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === "suspended") this.ctx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    },
    beep(freq, dur, type, vol, slide) {
      if (this.muted || !this.ctx) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t + dur);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    noise(dur, vol) {
      if (this.muted || !this.ctx) return;
      const n = this.ctx.sampleRate * dur;
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = vol || 0.1;
      const f = this.ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1800;
      src.connect(f);
      f.connect(g);
      g.connect(this.ctx.destination);
      src.start();
    },
    hit() { this.beep(420, 0.06, "square", 0.07); },
    wall() { this.beep(180, 0.07, "triangle", 0.05); },
    smash() {
      this.noise(0.18, 0.16);
      this.beep(140, 0.22, "sawtooth", 0.1, 60);
      this.beep(880, 0.08, "square", 0.06);
    },
    score() {
      this.beep(660, 0.12, "square", 0.08, 220);
      setTimeout(() => this.beep(330, 0.18, "square", 0.07, 110), 90);
    },
    power() {
      this.beep(523, 0.08, "sine", 0.07);
      setTimeout(() => this.beep(659, 0.08, "sine", 0.07), 70);
      setTimeout(() => this.beep(784, 0.14, "sine", 0.07), 140);
    },
    countdown() { this.beep(880, 0.12, "square", 0.08); },
    go() { this.beep(1174, 0.22, "square", 0.09); },
    victory() {
      [523, 659, 784, 1046].forEach((f, i) =>
        setTimeout(() => this.beep(f, 0.18, "square", 0.07), i * 120)
      );
    },
    rally() { this.beep(988, 0.1, "triangle", 0.08); },
    serve() { this.beep(200, 0.08, "sine", 0.04); },
  };

  /* ================================================================== */
  /* Particles                                                           */
  /* ================================================================== */
  const FX = {
    bits: [],
    shake: 0,
    flash: 0,
    trail: new Map(),
    spawn(x, y, color, n, spd, life) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = (Math.random() * 0.6 + 0.4) * (spd || 220);
        this.bits.push({
          x, y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: life || 0.45,
          max: life || 0.45,
          r: Math.random() * 2.4 + 0.8,
          color,
        });
      }
    },
    update(dt) {
      this.shake *= Math.pow(0.88, dt * 60);
      if (this.shake < 0.15) this.shake = 0;
      this.flash = Math.max(0, this.flash - dt * 3.2);
      for (let i = this.bits.length - 1; i >= 0; i--) {
        const p = this.bits[i];
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;
        if (p.life <= 0) this.bits.splice(i, 1);
      }
    },
    draw(c) {
      for (const p of this.bits) {
        c.globalAlpha = Math.max(0, p.life / p.max);
        c.fillStyle = p.color;
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
    },
    pushTrail(id, x, y) {
      let t = this.trail.get(id);
      if (!t) {
        t = [];
        this.trail.set(id, t);
      }
      t.push({ x, y });
      if (t.length > 14) t.shift();
    },
  };

  function onFx(fx) {
    if (!fx) return;
    const cyan = CFG.COLORS.cyan;
    const mag = CFG.COLORS.magenta;
    const col = fx.team === 1 ? mag : cyan;
    switch (fx.type) {
      case "hit":
        FX.spawn(fx.x, fx.y, col, 10, 260, 0.35);
        AudioFX.hit();
        break;
      case "wall":
        FX.spawn(fx.x, fx.y, "#9bb4ff", 7, 180, 0.28);
        AudioFX.wall();
        break;
      case "smash":
        FX.spawn(fx.x, fx.y, CFG.COLORS.gold, 28, 480, 0.55);
        FX.spawn(fx.x, fx.y, col, 14, 340, 0.4);
        FX.shake = 14;
        FX.flash = 0.7;
        AudioFX.smash();
        break;
      case "score":
        FX.spawn(fx.x, fx.y, col, 36, 520, 0.7);
        FX.shake = 10;
        FX.flash = 0.45;
        AudioFX.score();
        break;
      case "power":
        FX.spawn(fx.x, fx.y, CFG.COLORS.gold, 20, 300, 0.5);
        AudioFX.power();
        break;
      case "rally":
        FX.flash = 0.55;
        AudioFX.rally();
        $("rally-pip").classList.remove("hot");
        void $("rally-pip").offsetWidth;
        $("rally-pip").classList.add("hot");
        flashAnnounce("RALLY " + (fx.rally || ""));
        break;
      case "serve":
        AudioFX.serve();
        FX.trail.clear();
        break;
    }
  }

  /* ================================================================== */
  /* Snapshot interpolation                                              */
  /* ================================================================== */
  const Buf = {
    snaps: [],
    push(state) {
      this.snaps.push({ t: performance.now(), state });
      const cutoff = performance.now() - 1200;
      while (this.snaps.length > 2 && this.snaps[0].t < cutoff) this.snaps.shift();
    },
    sample() {
      const snaps = this.snaps;
      if (!snaps.length) return null;
      if (snaps.length === 1) return cloneState(snaps[0].state);
      const target = performance.now() - CFG.INTERP_DELAY;
      let i = 0;
      while (i < snaps.length - 2 && snaps[i + 1].t < target) i++;
      const a = snaps[i];
      const b = snaps[i + 1] || a;
      if (b.t <= a.t) return cloneState(b.state);
      const u = clamp((target - a.t) / (b.t - a.t), 0, 1);
      return lerpState(a.state, b.state, u);
    },
  };

  function cloneState(s) {
    return JSON.parse(JSON.stringify(s));
  }
  function lerp(a, b, u) {
    return a + (b - a) * u;
  }
  function lerpState(A, B, u) {
    const out = {
      t: lerp(A.t, B.t, u),
      phase: B.phase,
      mode: B.mode,
      scores: B.scores,
      rally: B.rally,
      pu: B.pu,
      names: B.names,
      pings: B.pings,
      fx: [],
      balls: [],
      paddles: [],
    };
    const bBalls = new Map((B.balls || []).map((b) => [b.id, b]));
    for (const ba of A.balls || []) {
      const bb = bBalls.get(ba.id);
      if (!bb) continue;
      out.balls.push({
        id: ba.id,
        x: lerp(ba.x, bb.x, u),
        y: lerp(ba.y, bb.y, u),
        vx: lerp(ba.vx, bb.vx, u),
        vy: lerp(ba.vy, bb.vy, u),
        g: bb.g,
        od: bb.od,
        ex: bb.ex,
        live: bb.live,
      });
    }
    for (const bb of B.balls || []) {
      if (!(A.balls || []).some((ba) => ba.id === bb.id)) out.balls.push(Object.assign({}, bb));
    }
    const bPads = new Map((B.paddles || []).map((p) => [p.id, p]));
    for (const pa of A.paddles || []) {
      const pb = bPads.get(pa.id);
      if (!pb) continue;
      out.paddles.push(Object.assign({}, pb, {
        y: lerp(pa.y, pb.y, u),
        h: lerp(pa.h, pb.h, u),
        sc: lerp(pa.sc, pb.sc, u),
        cd: pb.cd,
      }));
    }
    return out;
  }

  /* ================================================================== */
  /* Input                                                               */
  /* ================================================================== */
  function canvasYFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * CFG.FIELD_H;
    return clamp(y, 0, CFG.FIELD_H);
  }

  canvas.addEventListener("mousemove", (e) => {
    S.localY = canvasYFromEvent(e);
    S.lastMouse = performance.now();
  });
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      S.charging = true;
      AudioFX.ensure();
    }
  });
  window.addEventListener("mouseup", () => { S.charging = false; });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      S.charging = true;
      e.preventDefault();
      AudioFX.ensure();
    }
    if (e.code === "KeyW" || e.code === "ArrowUp") S.keys.up = true;
    if (e.code === "KeyS" || e.code === "ArrowDown") S.keys.down = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      S.charging = false;
      e.preventDefault();
    }
    if (e.code === "KeyW" || e.code === "ArrowUp") S.keys.up = false;
    if (e.code === "KeyS" || e.code === "ArrowDown") S.keys.down = false;
  });

  let lastInputSent = 0;
  function pumpInput(dt) {
    if (S.keys.up) S.localY -= CFG.KEY_SPEED * dt;
    if (S.keys.down) S.localY += CFG.KEY_SPEED * dt;
    S.localY = clamp(S.localY, 0, CFG.FIELD_H);

    const t = performance.now();
    if (t - lastInputSent < 1000 / CFG.INPUT_HZ) return;
    lastInputSent = t;
    if (S.vsBot) return;
    if (S.phase !== "playing" && S.phase !== "countdown" && S.phase !== "paused") return;
    Net.emit("input", { y: S.localY, charging: S.charging });
  }

  /* ================================================================== */
  /* Renderer                                                            */
  /* ================================================================== */
  function glow(c, color, blur) {
    c.shadowColor = color;
    c.shadowBlur = blur;
  }
  function noGlow(c) { c.shadowBlur = 0; }

  function drawGrid(c) {
    c.fillStyle = CFG.COLORS.bg;
    c.fillRect(0, 0, CFG.FIELD_W, CFG.FIELD_H);

    c.strokeStyle = CFG.COLORS.grid;
    c.lineWidth = 1;
    c.globalAlpha = 0.55;
    const step = 40;
    c.beginPath();
    for (let x = 0; x <= CFG.FIELD_W; x += step) {
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, CFG.FIELD_H);
    }
    for (let y = 0; y <= CFG.FIELD_H; y += step) {
      c.moveTo(0, y + 0.5);
      c.lineTo(CFG.FIELD_W, y + 0.5);
    }
    c.stroke();
    c.globalAlpha = 1;

    c.save();
    c.strokeStyle = "#1e2a48";
    c.setLineDash([8, 10]);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(CFG.FIELD_W / 2, 0);
    c.lineTo(CFG.FIELD_W / 2, CFG.FIELD_H);
    c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.arc(CFG.FIELD_W / 2, CFG.FIELD_H / 2, 56, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    glow(c, CFG.COLORS.cyan, 12);
    c.fillStyle = "#0a1a22";
    c.fillRect(0, 0, CFG.FIELD_W, 3);
    c.fillRect(0, CFG.FIELD_H - 3, CFG.FIELD_W, 3);
    noGlow(c);
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawPaddle(c, pad, isLocal) {
    const col = pad.team === 0 ? CFG.COLORS.cyan : CFG.COLORS.magenta;
    const x = pad.x;
    const y = pad.y - pad.h / 2;
    const w = pad.w;
    const h = pad.h;

    c.save();
    glow(c, col, isLocal ? 28 : 16);
    c.fillStyle = col;
    c.globalAlpha = 0.18;
    c.fillRect(x - 4, y - 4, w + 8, h + 8);
    c.globalAlpha = 1;
    roundRect(c, x, y, w, h, 3);
    c.fill();

    noGlow(c);
    c.fillStyle = "#ffffffcc";
    c.fillRect(x + (pad.team === 0 ? w - 3 : 0), y + 2, 3, h - 4);

    if (isLocal && pad.sc > 0.02 && pad.cd <= 0) {
      const ch = h * pad.sc;
      glow(c, CFG.COLORS.gold, 12);
      c.fillStyle = CFG.COLORS.gold;
      const cx = pad.team === 0 ? x + w + 5 : x - 7;
      c.fillRect(cx, y + h - ch, 4, ch);
    }
    noGlow(c);

    if (pad.rv > 0) {
      c.fillStyle = CFG.COLORS.magenta;
      c.font = "10px Orbitron, sans-serif";
      c.textAlign = "center";
      c.fillText("REV", x + w / 2, y - 6);
    }
    c.restore();
  }

  function drawBall(c, b) {
    FX.pushTrail(b.id, b.x, b.y);
    const trail = FX.trail.get(b.id) || [];
    const ghost = b.g;
    const core = b.od ? CFG.COLORS.gold : b.ex ? "#b8f3ff" : CFG.COLORS.ball;

    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const a = (i / trail.length) * (ghost ? 0.18 : 0.42);
      c.globalAlpha = a;
      c.fillStyle = core;
      c.beginPath();
      c.arc(t.x, t.y, CFG.BALL_R * (0.4 + i / trail.length) * 0.85, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = ghost ? 0.4 : 1;
    glow(c, core, ghost ? 8 : 18);
    c.fillStyle = core;
    c.beginPath();
    c.arc(b.x, b.y, CFG.BALL_R, 0, Math.PI * 2);
    c.fill();
    noGlow(c);
    c.globalAlpha = ghost ? 0.55 : 1;
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.arc(b.x - 2, b.y - 2, CFG.BALL_R * 0.35, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  function drawPowerUp(c, pu) {
    if (!pu) return;
    const meta = CFG.PU[pu.type] || CFG.PU.overdrive;
    const pulse = 1 + Math.sin(performance.now() / 180) * 0.08;
    c.save();
    glow(c, meta.color, 20);
    c.strokeStyle = meta.color;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(pu.x, pu.y, 16 * pulse, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 0.18;
    c.fillStyle = meta.color;
    c.fill();
    c.globalAlpha = 1;
    noGlow(c);
    c.font = "16px sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(meta.icon, pu.x, pu.y + 1);
    c.restore();
  }

  function draw(state, dt) {
    const c = ctx;
    c.save();
    if (FX.shake > 0) {
      c.translate((Math.random() - 0.5) * FX.shake, (Math.random() - 0.5) * FX.shake);
    }
    drawGrid(c);

    if (state) {
      const pads = state.paddles || [];
      for (const pad of pads) {
        const isLocal = pad.id === S.me;
        const drawPad = Object.assign({}, pad);
        if (isLocal && (S.phase === "playing" || S.phase === "countdown")) {
          let y = S.localY;
          if (pad.rv > 0) y = CFG.FIELD_H - y;
          drawPad.y = clamp(y, pad.h / 2, CFG.FIELD_H - pad.h / 2);
          if (S.charging && pad.cd <= 0) {
            drawPad.sc = Math.min(1, (drawPad.sc || 0) + dt / 0.42);
          }
        }
        drawPaddle(c, drawPad, isLocal);
      }

      for (const pad of pads) {
        const pl = ((S.room && S.room.players) || []).find((p) => p.token === pad.id);
        const label = pl ? pl.name : "";
        if (!label) continue;
        const col = pad.team === 0 ? CFG.COLORS.cyan : CFG.COLORS.magenta;
        c.font = "600 12px Rajdhani, sans-serif";
        c.fillStyle = col;
        c.globalAlpha = pad.id === S.me ? 1 : 0.7;
        c.textAlign = pad.team === 0 ? "left" : "right";
        const nx = pad.team === 0 ? pad.x + pad.w + 10 : pad.x - 10;
        c.fillText(label + (pad.id === S.me ? "  ◂ YOU" : ""), nx, pad.y - pad.h / 2 - 8);
        c.globalAlpha = 1;
      }

      for (const b of state.balls || []) drawBall(c, b);
      drawPowerUp(c, state.pu);
    }

    FX.draw(c);

    if (FX.flash > 0) {
      c.fillStyle = "rgba(255,255,255," + FX.flash * 0.22 + ")";
      c.fillRect(0, 0, CFG.FIELD_W, CFG.FIELD_H);
    }
    c.restore();

    const g = c.createRadialGradient(
      CFG.FIELD_W / 2, CFG.FIELD_H / 2, 180,
      CFG.FIELD_W / 2, CFG.FIELD_H / 2, 620
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.38)");
    c.fillStyle = g;
    c.fillRect(0, 0, CFG.FIELD_W, CFG.FIELD_H);
  }

  /* ================================================================== */
  /* HUD                                                                 */
  /* ================================================================== */
  function updateHud(state) {
    if (!state) return;
    $("score-a").textContent = state.scores[0];
    $("score-b").textContent = state.scores[1];
    $("rally-num").textContent = state.rally || 0;
    $("hud-name-a").textContent = (state.names && state.names.a) || "CYAN";
    $("hud-name-b").textContent = (state.names && state.names.b) || "MAGENTA";
    $("ping-num").textContent = S.vsBot
      ? (S.botDiff || "BOT").toUpperCase()
      : S.ping
        ? S.ping + "ms"
        : "—";

    const me = (state.paddles || []).find((p) => p.id === S.me);
    const smash = $("smash-ui");
    if (me) {
      S.reverseLocal = me.rv > 0;
      const cd = me.cd || 0;
      const ready = cd <= 0;
      const pct = ready
        ? Math.round((S.charging ? Math.max(me.sc, 0.05) : me.sc) * 100)
        : Math.round((1 - cd / CFG.SMASH_COOLDOWN) * 100);
      smash.innerHTML =
        '<div class="smash-label">' + (ready ? (S.charging ? "CHARGING" : "SMASH") : "COOLDOWN") + "</div>" +
        '<div class="smash-track"><div class="smash-fill ' +
        (ready ? (S.charging ? "ready" : "") : "cd") +
        '" style="width:' + clamp(pct, 0, 100) + '%"></div></div>';
    }

    const chips = [];
    if (me) {
      if (me.gi > 0) chips.push("📏 GIANT " + me.gi.toFixed(0) + "s");
      if (me.sh > 0) chips.push("🔻 SHRINK " + me.sh.toFixed(0) + "s");
      if (me.rv > 0) chips.push("🔄 REVERSE " + me.rv.toFixed(0) + "s");
    }
    if ((state.balls || []).some((b) => b.od)) chips.push("⚡ OVERDRIVE");
    if ((state.balls || []).some((b) => b.g)) chips.push("👻 GHOST");
    if ((state.balls || []).some((b) => b.ex)) chips.push("🌀 MULTI-BALL");
    $("effect-timers").innerHTML = chips.map((t) => '<div class="fx-chip">' + esc(t) + "</div>").join("");
  }

  let announceTimer = 0;
  function flashAnnounce(text) {
    const el = $("announce");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }

  /* ================================================================== */
  /* Lobby UI                                                            */
  /* ================================================================== */
  function renderLobby(payload) {
    S.room = payload;
    S.mode = payload.mode;
    S.isHost = payload.hostToken === S.me;
    $("lobby-code").textContent = payload.code;
    $("host-badge").classList.toggle("hidden", !S.isHost);
    $("btn-start").classList.toggle("hidden", !S.isHost);
    $("mode-1v1").classList.toggle("active", payload.mode === "1v1");
    $("mode-2v2").classList.toggle("active", payload.mode === "2v2");
    $("mode-1v1").disabled = !S.isHost;
    $("mode-2v2").disabled = !S.isHost;

    const me = (payload.players || []).find((p) => p.token === S.me);
    const ready = !!(me && me.ready);
    $("btn-ready").classList.toggle("ready-on", ready);
    $("btn-ready").textContent = ready ? "UNREADY" : "READY";

    const team0 = payload.players.filter((p) => p.team === 0);
    const team1 = payload.players.filter((p) => p.team === 1);
    const slots = payload.mode === "2v2" ? 2 : 1;

    $("team-board").innerHTML =
      teamCol("TEAM CYAN", "team-a", team0, slots, payload) +
      teamCol("TEAM MAGENTA", "team-b", team1, slots, payload);

    const need = payload.mode === "2v2" ? 4 : 2;
    const nReady = payload.players.filter((p) => p.ready && p.connected).length;
    $("btn-start").disabled = !(S.isHost && nReady >= need);
  }

  function teamCol(title, cls, players, slots, payload) {
    let rows = "";
    for (let i = 0; i < slots; i++) {
      const p = players[i];
      if (!p) {
        rows += '<div class="empty-slot">waiting for player…</div>';
        continue;
      }
      const pingCls = p.ping < 80 ? "good" : p.ping < 160 ? "ok" : "bad";
      const you = p.token === S.me ? '<span class="you-tag">YOU</span>' : "";
      const host = p.isHost ? '<span class="you-tag">HOST</span>' : "";
      const swap =
        S.isHost && payload.players.length > 1
          ? '<button class="swap-btn" data-swap="' + p.token + '">' +
            (S.swapPick === p.token ? "PICK…" : "SWAP") + "</button>"
          : "";
      rows +=
        '<div class="player-row">' +
        '<span class="ready-dot ' + (p.ready ? "on" : "") + '"></span>' +
        '<span class="pname">' + esc(p.name) + " " + you + " " + host + "</span>" +
        swap +
        '<span class="ping ' + pingCls + '">' + (p.connected ? p.ping + "ms" : "DC") + "</span>" +
        "</div>";
    }
    return '<div class="team-col ' + cls + '"><h3>' + title + "</h3>" + rows + "</div>";
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ================================================================== */
  /* Victory                                                             */
  /* ================================================================== */
  function showVictory(payload) {
    S.phase = "over";
    showScreen("victory");
    S.screen = "victory";
    const iWon = payload.winner === (S.vsBot ? 0 : myTeam());
    $("victory-title").textContent = payload.forfeit
      ? iWon ? "FORFEIT WIN" : "FORFEIT"
      : iWon ? "VICTORY" : "DEFEAT";
    $("victory-title").style.color = iWon ? CFG.COLORS.cyan : CFG.COLORS.magenta;
    $("victory-eyebrow").textContent = payload.forfeit
      ? (payload.forfeitName || "A player") + " disconnected"
      : "MATCH COMPLETE";
    const n = payload.names || { a: "CYAN", b: "MAGENTA" };
    $("victory-sub").textContent = (payload.winner === 0 ? n.a : n.b) + " wins";
    $("final-score").innerHTML =
      '<span style="color:' + CFG.COLORS.cyan + '">' + payload.scores[0] + "</span>" +
      "  —  " +
      '<span style="color:' + CFG.COLORS.magenta + '">' + payload.scores[1] + "</span>";
    $("rematch-status").textContent = S.vsBot
      ? "Play again, or go back and change difficulty."
      : "Waiting for rematch votes…";
    AudioFX.victory();
  }

  function myTeam() {
    const p = S.room && S.room.players.find((x) => x.token === S.me);
    return p ? p.team : 0;
  }

  /* ================================================================== */
  /* Net bindings                                                        */
  /* ================================================================== */
  function setNetStatus(online) {
    const el = $("net-status");
    if (!el) return;
    if (online) {
      el.textContent = "SERVER ONLINE — create / join a room to play a friend";
      el.className = "net-status online";
    } else {
      el.textContent = "NO SERVER — vs bot works now. Upload the folder + run node server.js for multiplayer.";
      el.className = "net-status offline";
    }
  }

  function bindNet() {
    Net.on("connect", () => {
      setNetStatus(true);
      if (S.vsBot) return;
      const code = sessionStorage.getItem("np_room");
      if (code) {
        Net.emit("joinRoom", { code: code, name: nick(), token: TOKEN });
      }
    });
    Net.on("offline", () => setNetStatus(false));
    Net.on("connect_error", () => setNetStatus(false));
    Net.on("disconnect", () => {
      setNetStatus(false);
      if (S.vsBot) return;
      if (S.screen === "game") {
        $("pause-overlay").classList.remove("hidden");
        $("pause-title").textContent = "LOST CONNECTION";
        $("pause-sub").textContent = "Reconnecting…";
        $("pause-timer").textContent = "";
      }
    });
    Net.on("errorMsg", (p) => {
      const msg = (p && p.msg) || "Error";
      if (/not found|full|progress/i.test(msg)) sessionStorage.removeItem("np_room");
      if (S.screen === "menu") $("menu-error").textContent = msg;
      else $("lobby-error").textContent = msg;
    });
    Net.on("roomCreated", (p) => enterLobby(p));
    Net.on("roomJoined", (p) => enterLobby(p));
    Net.on("rejoined", (p) => {
      S.me = p.token || S.me;
      S.room = p;
      sessionStorage.setItem("np_room", p.code);
      if (p.phase === "playing" || p.phase === "countdown" || p.phase === "paused") {
        showScreen("game");
        S.screen = "game";
        S.phase = p.phase;
      } else if (p.phase === "over") {
        showVictory({
          winner: p.winner,
          scores: p.scores || [0, 0],
          forfeit: !!p.forfeit,
          names: p.names,
        });
      } else {
        enterLobby(p);
      }
    });
    Net.on("lobby", (p) => {
      S.room = p;
      if (p.phase === "lobby") {
        if (S.screen !== "lobby") {
          showScreen("lobby");
          S.screen = "lobby";
        }
        S.phase = "lobby";
        renderLobby(p);
      } else if (p.phase === "over" && S.screen === "victory") {
        const votes = p.players.filter((x) => x.rematch).length;
        const live = p.players.filter((x) => x.connected).length;
        $("rematch-status").textContent = votes + "/" + live + " ready for rematch";
      }
    });
    Net.on("countdown", (p) => {
      S.vsBot = false;
      showScreen("game");
      S.screen = "game";
      S.phase = "countdown";
      $("btn-forfeit").classList.add("hidden");
      $("btn-pause-quit").classList.add("hidden");
      $("pause-overlay").classList.add("hidden");
      $("countdown-overlay").classList.remove("hidden");
      $("countdown-num").textContent = p.n;
      AudioFX.ensure();
      if (p.n <= 1) {
        AudioFX.go();
        setTimeout(() => $("countdown-overlay").classList.add("hidden"), 400);
      } else {
        AudioFX.countdown();
      }
    });
    Net.on("state", (st) => {
      S.latest = st;
      S.phase = st.phase;
      S.names = st.names || S.names;
      Buf.push(st);
      if (st.fx && st.fx.length) st.fx.forEach(onFx);
      updateHud(st);
      if (st.phase === "playing") $("countdown-overlay").classList.add("hidden");
    });
    Net.on("announce", (p) => flashAnnounce(p.text));
    Net.on("paused", (p) => {
      S.phase = "paused";
      $("pause-overlay").classList.remove("hidden");
      $("pause-title").textContent = (p.name || "Player") + " disconnected";
      $("pause-sub").textContent = "Game paused — reconnect or forfeit";
      $("pause-timer").textContent = p.seconds;
    });
    Net.on("resumed", () => {
      $("pause-overlay").classList.add("hidden");
      S.phase = "playing";
    });
    Net.on("matchOver", (p) => showVictory(p));
    Net.on("pongMs", () => {
      const rtt = Math.max(0, performance.now() - Net.lastPingAt);
      S.ping = Math.round(rtt);
      Net.emit("setPing", S.ping);
      $("ping-num").textContent = S.ping + "ms";
    });
    Net.on("kicked", (p) => {
      sessionStorage.removeItem("np_room");
      showScreen("menu");
      S.screen = "menu";
      $("menu-error").textContent = (p && p.msg) || "Left the room.";
    });
  }

  function enterLobby(p) {
    S.me = p.token || S.me;
    S.room = p;
    S.phase = "lobby";
    S.screen = "lobby";
    sessionStorage.setItem("np_room", p.code);
    $("menu-error").textContent = "";
    $("lobby-error").textContent = "";
    showScreen("lobby");
    renderLobby(p);
  }

  /* ================================================================== */
  /* Menu buttons                                                        */
  /* ================================================================== */
  function wireUi() {
    const saved = localStorage.getItem("np_nick");
    if (saved) $("nick").value = saved;

    document.querySelectorAll(".diff-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".diff-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        S.botDiff = btn.getAttribute("data-diff") || "normal";
      });
    });

    $("btn-vsbot").addEventListener("click", () => {
      AudioFX.ensure();
      startBotMatch();
    });

    $("btn-create").addEventListener("click", () => {
      AudioFX.ensure();
      $("menu-error").textContent = "";
      if (!Net.connected) {
        $("menu-error").textContent =
          "Multiplayer needs the Node server. Open this page via node server.js, or just hit PLAY VS BOT.";
        return;
      }
      Net.emit("createRoom", { name: nick(), token: TOKEN });
    });
    $("btn-join").addEventListener("click", joinFromMenu);
    $("join-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinFromMenu();
    });
    function joinFromMenu() {
      AudioFX.ensure();
      const code = $("join-code").value.trim().toUpperCase();
      if (code.length < 4) {
        $("menu-error").textContent = "Enter a 6-character room code.";
        return;
      }
      $("menu-error").textContent = "";
      if (!Net.connected) {
        $("menu-error").textContent =
          "Multiplayer needs the Node server. Open this page via node server.js, or just hit PLAY VS BOT.";
        return;
      }
      Net.emit("joinRoom", { code: code, name: nick(), token: TOKEN });
    }

    $("btn-howto").addEventListener("click", () => $("howto-modal").classList.remove("hidden"));
    $("howto-close").addEventListener("click", () => $("howto-modal").classList.add("hidden"));
    $("howto-modal").addEventListener("click", (e) => {
      if (e.target.id === "howto-modal") $("howto-modal").classList.add("hidden");
    });

    $("btn-copy").addEventListener("click", () => {
      const code = $("lobby-code").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(code).catch(function () {});
      $("btn-copy").textContent = "COPIED";
      setTimeout(() => { $("btn-copy").textContent = "COPY"; }, 1200);
    });

    $("mode-1v1").addEventListener("click", () => S.isHost && Net.emit("setMode", { mode: "1v1" }));
    $("mode-2v2").addEventListener("click", () => S.isHost && Net.emit("setMode", { mode: "2v2" }));

    $("btn-ready").addEventListener("click", () => {
      const me = S.room && S.room.players.find((p) => p.token === S.me);
      Net.emit("setReady", { ready: !(me && me.ready) });
    });
    $("btn-start").addEventListener("click", () => Net.emit("startMatch"));
    $("btn-leave").addEventListener("click", () => {
      Net.emit("leaveRoom");
      sessionStorage.removeItem("np_room");
      showScreen("menu");
      S.screen = "menu";
      S.phase = "lobby";
    });

    $("team-board").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-swap]");
      if (!btn || !S.isHost) return;
      const tok = btn.getAttribute("data-swap");
      if (!S.swapPick || S.swapPick === tok) {
        S.swapPick = S.swapPick === tok ? null : tok;
        renderLobby(S.room);
        return;
      }
      Net.emit("swapPlayers", { a: S.swapPick, b: tok });
      S.swapPick = null;
    });

    $("btn-rematch").addEventListener("click", () => {
      if (S.vsBot) {
        startBotMatch();
        return;
      }
      Net.emit("rematch");
      $("rematch-status").textContent = "You voted rematch — waiting on the others…";
    });
    $("btn-lobby").addEventListener("click", () => {
      if (S.vsBot) {
        quitToMenu();
        return;
      }
      Net.emit("backToLobby");
      showScreen("lobby");
      S.screen = "lobby";
    });

    $("btn-forfeit").addEventListener("click", () => {
      if (S.vsBot) pauseLocal(true);
    });
    $("btn-pause-quit").addEventListener("click", () => quitToMenu());

    window.addEventListener("keydown", (e) => {
      if (e.code !== "Escape") return;
      if (!S.vsBot || S.screen !== "game") return;
      if (S.phase === "over") return;
      pauseLocal(!S.pausedLocal);
    });

    $("btn-mute").addEventListener("click", () => {
      S.muted = !S.muted;
      AudioFX.muted = S.muted;
      $("btn-mute").textContent = S.muted ? "🔇" : "🔊";
    });
  }

  /* ================================================================== */
  /* Local vs-bot match                                                  */
  /* ================================================================== */
  function startBotMatch() {
    if (typeof LocalMatch !== "function") {
      $("menu-error").textContent = "Bot engine failed to load (js/local.js).";
      return;
    }
    S.vsBot = true;
    S.pausedLocal = false;
    S.me = TOKEN;
    S.phase = "countdown";
    S.screen = "game";
    S.mode = "1v1";
    S.localY = CFG.FIELD_H / 2;
    S.charging = false;
    S.room = {
      players: [
        { token: TOKEN, name: nick(), team: 0 },
        { token: "BOT", name: "BOT", team: 1 },
      ],
    };
    S.localMatch = new LocalMatch({
      playerId: TOKEN,
      playerName: nick(),
      difficulty: S.botDiff,
    });
    S.latest = S.localMatch.snapshot();
    Buf.buf = [];
    showScreen("game");
    $("btn-forfeit").classList.remove("hidden");
    $("pause-overlay").classList.add("hidden");
    $("btn-pause-quit").classList.remove("hidden");
    $("countdown-overlay").classList.remove("hidden");
    $("countdown-num").textContent = "3";
    $("ping-num").textContent = (S.botDiff || "BOT").toUpperCase();
    $("menu-error").textContent = "";
    AudioFX.ensure();
  }

  function quitToMenu() {
    S.vsBot = false;
    S.localMatch = null;
    S.pausedLocal = false;
    S.phase = "lobby";
    S.screen = "menu";
    S.latest = null;
    $("btn-forfeit").classList.add("hidden");
    $("btn-pause-quit").classList.add("hidden");
    $("pause-overlay").classList.add("hidden");
    $("countdown-overlay").classList.add("hidden");
    showScreen("menu");
  }

  function pauseLocal(on) {
    if (!S.vsBot || S.phase === "over") return;
    S.pausedLocal = !!on;
    const ov = $("pause-overlay");
    if (S.pausedLocal) {
      ov.classList.remove("hidden");
      $("pause-title").textContent = "PAUSED";
      $("pause-sub").textContent = "Press Esc to resume";
      $("pause-timer").textContent = "";
      $("btn-pause-quit").classList.remove("hidden");
    } else {
      ov.classList.add("hidden");
    }
  }

  function tickBot(dt) {
    if (!S.localMatch || S.screen !== "game") return;
    if (S.pausedLocal) return;
    if (S.phase === "over") return;

    let y = S.localY;
    if (S.reverseLocal) y = CFG.FIELD_H - y;
    const events = S.localMatch.update(dt, { y: y, charging: S.charging });
    S.latest = S.localMatch.snapshot();
    S.phase = S.latest.phase;

    if (events.countdown) {
      $("countdown-overlay").classList.remove("hidden");
      $("countdown-num").textContent = events.countdown;
      if (events.countdown <= 1) {
        AudioFX.go();
        setTimeout(() => $("countdown-overlay").classList.add("hidden"), 350);
      } else {
        AudioFX.countdown();
      }
    }
    if (S.phase === "playing") $("countdown-overlay").classList.add("hidden");

    (events.fx || []).forEach(onFx);
    (events.announces || []).forEach(flashAnnounce);
    if (events.over) {
      $("btn-forfeit").classList.add("hidden");
      showVictory(events.over);
    }
  }

  /* ================================================================== */
  /* Main loop                                                           */
  /* ================================================================== */
  let lastTs = performance.now();
  function loop(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    pumpInput(dt);
    if (S.vsBot) tickBot(dt);
    FX.update(dt);
    if (S.screen === "game") {
      const sampled = S.vsBot ? S.latest : Buf.sample() || S.latest;
      draw(sampled, dt);
      if (sampled) updateHud(sampled);
    }
    requestAnimationFrame(loop);
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  bindNet();
  wireUi();
  setNetStatus(false);
  Net.connect();
  requestAnimationFrame(loop);
  setInterval(() => Net.ping(), 2000);
  setTimeout(() => {
    if (!Net.connected) setNetStatus(false);
  }, 1200);

  $("join-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });
})();
