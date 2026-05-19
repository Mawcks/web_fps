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

// Combat tuning
const MAX_HP = 100;
const BODY_DAMAGE = 30;
const HEAD_DAMAGE = 120; // one-shots a full-HP player
const PLAYER_RADIUS = 0.42; // hitbox half-width
const HEAD_FRAC = 0.82; // hits above height*HEAD_FRAC count as headshots
const RESPAWN_MS = 2500;
const SHOOT_RANGE = 100;
const LAG_COMP_MS = 100; // fallback rewind when a shot carries no render time
const HISTORY_MS = 1000; // position history kept per player
const SHOT_MIN_INTERVAL = 85; // server-side fire-rate guard (ms)

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
    kills: p.kills,
    deaths: p.deaths,
    alive: p.alive,
  }));
}

function sendState(room) {
  broadcast(room, { t: 'state', ops: room.ops, players: roster(room) });
}

/** ====== Combat ====== */

// Ray vs axis-aligned box. Returns the entry distance along the unit ray, or null.
function rayAABB(o, d, minx, miny, minz, maxx, maxy, maxz) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const slab = (oo, dd, mn, mx) => {
    if (Math.abs(dd) < 1e-9) return oo >= mn && oo <= mx;
    let t1 = (mn - oo) / dd;
    let t2 = (mx - oo) / dd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(o.x, d.x, minx, maxx)) return null;
  if (!slab(o.y, d.y, miny, maxy)) return null;
  if (!slab(o.z, d.z, minz, maxz)) return null;
  if (tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

// Is the line of sight from (x0,z0) to (x1,z1) blocked by a solid cell?
function losBlocked(open, x0, z0, x1, z1) {
  let cx = Math.floor(x0);
  let cz = Math.floor(z0);
  const ex = Math.floor(x1);
  const ez = Math.floor(z1);
  const dx = x1 - x0;
  const dz = z1 - z0;
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  let tMaxX = stepX !== 0 ? ((stepX > 0 ? cx + 1 : cx) - x0) / dx : Infinity;
  let tMaxZ = stepZ !== 0 ? ((stepZ > 0 ? cz + 1 : cz) - z0) / dz : Infinity;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
  for (let guard = 0; guard < 4096; guard++) {
    if (cx === ex && cz === ez) return false;
    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (!open.has(cx + ',' + cz)) return true;
  }
  return false;
}

// A player's interpolated position at a past time (lag compensation).
function rewindPos(p, targetT) {
  const h = p.history;
  if (h.length === 0) return { x: p.x, z: p.z, h: p.height };
  if (targetT >= h[h.length - 1].t) return h[h.length - 1];
  if (targetT <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1].t <= targetT && targetT <= h[i].t) {
      const a = h[i - 1];
      const b = h[i];
      const f = (targetT - a.t) / ((b.t - a.t) || 1);
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, h: a.h };
    }
  }
  return h[h.length - 1];
}

function killPlayer(room, victim, killer, headshot) {
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  if (killer && killer.id !== victim.id) killer.kills++;
  broadcast(room, {
    t: 'death',
    killer: killer ? killer.id : null,
    victim: victim.id,
    killerName: killer ? killer.name : '',
    victimName: victim.name,
    headshot: !!headshot,
  });
  sendState(room);
  const code = room.code;
  setTimeout(() => {
    const r = rooms.get(code);
    if (!r || !r.players.has(victim.id)) return;
    victim.hp = MAX_HP;
    victim.alive = true;
    victim.history.length = 0;
    broadcast(r, { t: 'respawn', id: victim.id });
    sendState(r);
  }, RESPAWN_MS);
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
        room = { code: newRoomCode(), ops: [], open: new Set() };
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
        height: 1.8,
        playing: false,
        hp: MAX_HP,
        alive: true,
        kills: 0,
        deaths: 0,
        history: [],
        lastShotAt: 0,
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
      room.open = open;
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
      const after = recompute(room.ops);
      if (!isConnected(after.open)) {
        room.ops.splice(idx, 0, removed); // would split the map — keep it
        send(ws, { t: 'reject', reason: 'Undo would split the map' });
        return;
      }
      room.open = after.open;
      sendState(room);
      return;
    }

    // --- presence ---
    if (msg.t === 'move') {
      const wasPlaying = player.playing;
      player.x = Number.isFinite(msg.x) ? msg.x : 0;
      player.z = Number.isFinite(msg.z) ? msg.z : 0;
      player.yaw = Number.isFinite(msg.yaw) ? msg.yaw : 0;
      player.height = Number.isFinite(msg.h) ? msg.h : 1.8;
      player.playing = !!msg.playing;
      if (player.playing && !wasPlaying) {
        player.hp = MAX_HP;
        player.alive = true;
        player.history.length = 0;
      }
      const now = Date.now();
      player.history.push({ t: now, x: player.x, z: player.z, h: player.height });
      while (player.history.length > 1 && player.history[0].t < now - HISTORY_MS) {
        player.history.shift();
      }
      broadcast(
        room,
        {
          t: 'moved',
          id: player.id,
          st: now, // server timestamp — drives client interpolation + lag comp
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

    // --- shoot (server-authoritative hit validation) ---
    if (msg.t === 'shoot') {
      if (!player.alive || !player.playing) return;
      const now = Date.now();
      if (now - player.lastShotAt < SHOT_MIN_INTERVAL) return;
      player.lastShotAt = now;
      const o = { x: +msg.ox, y: +msg.oy, z: +msg.oz };
      const d = { x: +msg.dx, y: +msg.dy, z: +msg.dz };
      if (!Number.isFinite(o.x + o.y + o.z + d.x + d.y + d.z)) return;
      const dl = Math.hypot(d.x, d.y, d.z) || 1;
      d.x /= dl;
      d.y /= dl;
      d.z /= dl;
      // rewind targets to the exact moment the shooter was rendering — the
      // client sends its render time, clamped to the kept history window
      const rt = Number.isFinite(msg.rt) ? msg.rt : now - LAG_COMP_MS;
      const rewindT = Math.max(now - HISTORY_MS, Math.min(now, rt));
      let best = null;
      for (const b of room.players.values()) {
        if (b.id === player.id || !b.alive || !b.playing) continue;
        const pos = rewindPos(b, rewindT);
        const t = rayAABB(
          o, d,
          pos.x - PLAYER_RADIUS, 0, pos.z - PLAYER_RADIUS,
          pos.x + PLAYER_RADIUS, pos.h, pos.z + PLAYER_RADIUS,
        );
        if (t == null || t < 0 || t > SHOOT_RANGE) continue;
        if (best && t >= best.t) continue;
        if (losBlocked(room.open, o.x, o.z, pos.x, pos.z)) continue;
        best = { b, t, headshot: o.y + d.y * t > pos.h * HEAD_FRAC };
      }
      if (best) {
        best.b.hp -= best.headshot ? HEAD_DAMAGE : BODY_DAMAGE;
        const killed = best.b.hp <= 0;
        send(ws, { t: 'hitconfirm', headshot: best.headshot, killed });
        if (killed) {
          killPlayer(room, best.b, player, best.headshot);
        } else {
          send(best.b.ws, { t: 'damage', hp: best.b.hp, by: player.id });
        }
      }
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
