/**
 * NexusPong — socket event layer
 * Thin wrapper around Socket.io so client.js never talks to the raw socket.
 *
 * If Socket.io is missing (opened as a file, or static host with no Node),
 * connect() is a no-op and the vs-bot path still works.
 */
(function (global) {
  "use strict";

  const Net = {
    socket: null,
    connected: false,
    lastPingAt: 0,
    pingMs: 0,
    available: typeof io === "function",
    _handlers: {},

    connect() {
      if (this.socket) return this.socket;
      if (typeof io !== "function") {
        this.available = false;
        this.connected = false;
        this._fire("offline", null);
        return null;
      }
      this.available = true;
      this.socket = io({
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 12,
        reconnectionDelay: 500,
        reconnectionDelayMax: 4000,
      });

      this.socket.on("connect", () => {
        this.connected = true;
        this._fire("connect", this.socket.id);
      });
      this.socket.on("disconnect", (reason) => {
        this.connected = false;
        this._fire("disconnect", reason);
      });
      this.socket.on("connect_error", (err) => this._fire("connect_error", err));

      const events = [
        "errorMsg",
        "roomCreated",
        "roomJoined",
        "lobby",
        "kicked",
        "countdown",
        "state",
        "fx",
        "announce",
        "paused",
        "resumed",
        "matchOver",
        "pongMs",
        "rejoined",
      ];
      events.forEach((ev) => {
        this.socket.on(ev, (payload) => this._fire(ev, payload));
      });

      return this.socket;
    },

    on(event, fn) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(fn);
    },

    _fire(event, payload) {
      const list = this._handlers[event];
      if (!list) return;
      for (let i = 0; i < list.length; i++) list[i](payload);
    },

    emit(event, payload) {
      if (!this.socket || !this.connected) return;
      this.socket.emit(event, payload);
    },

    ping() {
      if (!this.connected) return;
      this.lastPingAt = performance.now();
      this.emit("pingMs", this.lastPingAt);
    },
  };

  global.Net = Net;
})(window);
