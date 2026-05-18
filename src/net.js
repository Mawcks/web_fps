/**
 * Client networking for multiplayer.
 *
 * Thin wrapper over a WebSocket to the room server. The server is authoritative
 * for the shared carve grid: the client sends carve/undo intents and applies
 * whatever state the server broadcasts back.
 */

export class Net {
  constructor() {
    this.ws = null;
    this.selfId = null;
    this.room = null;
    this.tileBudget = 0;
    this._handlers = {};
  }

  /** True once joined to a room with an open connection. */
  get inRoom() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.room;
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

  move(x, z, yaw, playing) {
    this._send({ t: 'move', x, z, yaw, playing });
  }
}
