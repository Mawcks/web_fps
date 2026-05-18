/**
 * Web FPS multiplayer server.
 *
 * One small WebSocket server hosts "rooms". Players in a room share one carve
 * grid: every carve op is validated (tile budget + connectivity) and broadcast.
 * The same HTTP server also serves the built client from ../dist when present,
 * so a deployment is a single process on a single port.
 *
 *   node server/index.js          # PORT / TILE_BUDGET via env vars
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(DIR, '..', 'dist');
const PORT = Number(process.env.PORT) || 8787;
const TILE_BUDGET = Number(process.env.TILE_BUDGET) || 800;
const MAX_PLAYERS = 6;
const PLAYER_COLORS = ['#ff5a36', '#4ea1d3', '#7bd36a', '#e8c14e', '#b06ce8', '#e86ca8'];

/** ====== Carve model (open-cell replay, ownership, connectivity) ====== */

// Replay ops into an open-cell set, tracking which player opened each cell.
function recompute(ops) {
  const open = new Set();
  const owner = new Map(); // "x,z" -> playerId
  const used = new Map(); // playerId -> open cells owned
  for (const op of ops) {
    for (let dz = 0; dz < op.d; dz++) {
      for (let dx = 0; dx < op.w; dx++) {
        const k = op.x + dx + ',' + (op.z + dz);
        if (op.type === 'carve') {
          if (!open.has(k)) {
            open.add(k);
            owner.set(k, op.by);
            used.set(op.by, (used.get(op.by) || 0) + 1);
          }
        } else if (open.has(k)) {
          open.delete(k);
          const o = owner.get(k);
          if (o != null) used.set(o, (used.get(o) || 0) - 1);
          owner.delete(k);
        }
      }
    }
  }
  return { open, used };
}

// Is the carved space a single connected region?
function isConnected(open) {
  if (open.size <= 1) return true;
  const start = open.values().next().value;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const k = stack.pop();
    const c = k.indexOf(',');
    const x = +k.slice(0, c);
    const z = +k.slice(c + 1);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = x + dx + ',' + (z + dz);
      if (open.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  return seen.size === open.size;
}

function sanitizeOp(op) {
  if (!op || (op.type !== 'carve' && op.type !== 'fill')) return null;
  const x = op.x | 0;
  const z = op.z | 0;
  const w = op.w | 0;
  const d = op.d | 0;
  if (w < 1 || d < 1 || w > 250 || d > 250) return null;
  return { type: op.type, x, z, w, d };
}

/** ====== Rooms ====== */

const rooms = new Map();
let nextPlayerId = 1;

function newRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function roster(room) {
  const { used } = recompute(room.ops);
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    used: Math.max(0, used.get(p.id) || 0),
    playing: p.playing,
  }));
}

function sendState(room) {
  broadcast(room, { t: 'state', ops: room.ops, players: roster(room) });
}

/** ====== HTTP (serves the built client when ../dist exists) ====== */

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(DIST, urlPath));
  if (filePath.startsWith(DIST) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const indexFile = path.join(DIST, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(indexFile).pipe(res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('web-fps multiplayer server running. Build the client (npm run build) to serve it here.');
});

/** ====== WebSocket ====== */

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // --- join / create ---
    if (msg.t === 'create' || msg.t === 'join') {
      if (player) return;
      const name = (String(msg.name || '').trim() || 'Player').slice(0, 16);
      if (msg.t === 'create') {
        room = { code: newRoomCode(), ops: [] };
        room.players = new Map();
        rooms.set(room.code, room);
      } else {
        room = rooms.get(String(msg.room || '').trim().toUpperCase());
        if (!room) {
          send(ws, { t: 'error', reason: 'Room not found' });
          room = null;
          return;
        }
        if (room.players.size >= MAX_PLAYERS) {
          send(ws, { t: 'error', reason: 'Room is full' });
          room = null;
          return;
        }
      }
      const id = nextPlayerId++;
      player = {
        id,
        name,
        color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
        ws,
        x: 0,
        z: 0,
        yaw: 0,
        playing: false,
      };
      room.players.set(id, player);
      send(ws, { t: 'joined', selfId: id, room: room.code, tileBudget: TILE_BUDGET });
      sendState(room);
      return;
    }

    if (!player || !room) return;

    // --- carve / erase ---
    if (msg.t === 'carve') {
      const op = sanitizeOp(msg.op);
      if (!op) return;
      op.by = player.id;
      const { open, used } = recompute([...room.ops, op]);
      if (op.type === 'carve' && (used.get(player.id) || 0) > TILE_BUDGET) {
        send(ws, { t: 'reject', reason: 'Out of tiles' });
        return;
      }
      if (!isConnected(open)) {
        send(ws, { t: 'reject', reason: 'Carves must connect to the existing space' });
        return;
      }
      room.ops.push(op);
      sendState(room);
      return;
    }

    // --- undo (your most recent op only) ---
    if (msg.t === 'undo') {
      let idx = -1;
      for (let i = room.ops.length - 1; i >= 0; i--) {
        if (room.ops[i].by === player.id) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        send(ws, { t: 'reject', reason: 'Nothing of yours to undo' });
        return;
      }
      const removed = room.ops.splice(idx, 1)[0];
      if (!isConnected(recompute(room.ops).open)) {
        room.ops.splice(idx, 0, removed); // would split the map — keep it
        send(ws, { t: 'reject', reason: 'Undo would split the map' });
        return;
      }
      sendState(room);
      return;
    }

    // --- presence ---
    if (msg.t === 'move') {
      player.x = Number.isFinite(msg.x) ? msg.x : 0;
      player.z = Number.isFinite(msg.z) ? msg.z : 0;
      player.yaw = Number.isFinite(msg.yaw) ? msg.yaw : 0;
      player.playing = !!msg.playing;
      broadcast(
        room,
        {
          t: 'moved',
          id: player.id,
          name: player.name,
          color: player.color,
          x: player.x,
          z: player.z,
          yaw: player.yaw,
          playing: player.playing,
        },
        player.id,
      );
      return;
    }
  });

  ws.on('close', () => {
    if (!room || !player) return;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    } else {
      broadcast(room, { t: 'left', id: player.id });
      sendState(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`web-fps server listening on http://localhost:${PORT}  (WebSocket + static client)`);
  console.log(`tile budget per player: ${TILE_BUDGET}`);
});
