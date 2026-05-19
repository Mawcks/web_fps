/**
 * Client networking for multiplayer.
 *
 * Thin wrapper over a WebSocket to the room server. The server is authoritative
 * for the shared carve grid and combat. It also tracks a server-clock estimate
 * so remote players can be rendered at a fixed delay behind real time and shots
 * can tell the server exactly which past instant to validate against.
 */

const INTERP_DELAY = 50; // ms — remote players rendered this far back; raise it if a
//                          jittery connection makes opponents stutter

export class Net {
  constructor() {
    this.ws = null;
    this.selfId = null;
    this.room = null;
    this.tileBudget = 0;
    this._clockOffset = null; // serverTime - performance.now(), estimated from snapshots
    this._handlers = {};
  }

  /** True once joined to a room with an open connection. */
  get inRoom() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.room;
  }

  /** Estimated current server clock, and the past instant remote players render at. */
  get serverNow() {
    return performance.now() + (this._clockOffset || 0);
  }
  get renderTime() {
    return this.serverNow - INTERP_DELAY;
  }

  /** Sync the server-clock estimate from an incoming snapshot's timestamp. */
  _noteServerTime(st) {
    if (!Number.isFinite(st)) return;
    const sample = st - performance.now();
    if (this._clockOffset === null) this._clockOffset = sample;
    else if (sample > this._clockOffset) this._clockOffset = sample; // trust the fastest packet
    else this._clockOffset += (sample - this._clockOffset) * 0.02; // drift gently otherwise
  }

  /** Register a handler for a server message type (or 'closed' / 'neterror'). */
  on(type, fn) {
    this._handlers[type] = fn;
  }

  _emit(type, data) {
    if (this._handlers[type]) this._handlers[type](data);
  }

  /**
   * Open a connection and create or join a room.
   * @param {string} url           - ws:// or wss:// server URL
   * @param {{ create?: boolean, room?: string, name: string }} opts
   */
  connect(url, opts) {
    this.disconnect();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._emit('neterror', { reason: 'Bad server address' });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._send(
        opts.create
          ? { t: 'create', name: opts.name }
          : { t: 'join', room: opts.room, name: opts.name },
      );
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'joined') {
        this.selfId = msg.selfId;
        this.room = msg.room;
        this.tileBudget = msg.tileBudget;
      }
      if (Number.isFinite(msg.st)) this._noteServerTime(msg.st);
      this._emit(msg.t, msg);
    };

    ws.onclose = () => {
      const wasInRoom = !!this.room;
      this.room = null;
      this.selfId = null;
      if (this.ws === ws) this.ws = null;
      this._emit('closed', { wasInRoom });
    };

    ws.onerror = () => {
      this._emit('neterror', { reason: 'Could not reach the server' });
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch (err) {
        /* already closing */
      }
      this.ws = null;
    }
    this.room = null;
    this.selfId = null;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  carve(type, x, z, w, d) {
    this._send({ t: 'carve', op: { type, x, z, w, d } });
  }

  undo() {
    this._send({ t: 'undo' });
  }

  move(x, z, yaw, h, playing) {
    this._send({ t: 'move', x, z, yaw, h, playing });
  }

  shoot(from, dir) {
    this._send({
      t: 'shoot',
      ox: from.x, oy: from.y, oz: from.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      rt: this.renderTime, // the instant we were rendering — server rewinds to here
    });
  }

  startMatch() {
    this._send({ t: 'startmatch' });
  }
}
