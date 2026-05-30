# Web FPS

Carve an arena out of solid rock from a top-down view, then drop into first
person and fight 1v1 rounds in it.

## How it works

The world starts as solid rock. In **Edit** mode you look straight down and
click-drag to carve rectangular rooms and corridors out of it. Overlapping
carves merge into one connected space — a shared edge becomes an open doorway.
Press **Enter Play** and the camera swoops into first person: every carved edge
is a wall and the carved floor is walkable.

The game it builds toward is a Counter-Strike-style **1v1**: two players, one
arena, a stack of one-life rounds. You build the map you fight on.

## Controls

**Edit (top-down)**

- Click-drag — carve (or erase) a rectangle
- `1` / `2`, or the Tool button — switch Carve / Erase
- `Ctrl+Z` — undo · Clear — wipe the map · Scroll — zoom
- Save / Load — browser storage · Export / Import — `.json` map file

**Play (first person)**

- `WASD` move · mouse look · `Shift` walk (slow) · `C` crouch · `Space` jump
- Click — shoot · `Esc` — release the mouse · `P` — back to Edit

Movement is a Quake/Source-style friction + acceleration model: counter-strafing
stops you almost instantly so you can take an accurate shot, and a low air-accel
cap lets you air-strafe. Shooting is hitscan — standing still is pin-point, but
moving, jumping, and holding the trigger all bloom the cone, and recoil follows a
fixed spray pattern you can learn and pull down against.

Sensitivity, keybinds, crosshair, and volume are configurable under
**Settings**. Sensitivity is entered as a Valorant sens value and matched 1:1
using raw mouse input.

## Multiplayer

Players share one carve grid. One player **creates a room** and shares the
invite link; others **join** with it. Everyone has a tile budget — carve one big
shape or many small ones, but every carve must stay connected to the shared
space. Other players show up as avatars when they are in play mode.

### 1v1 match

With exactly two players in a room and an arena carved, hit **Start 1v1 match**:

- Each round both players spawn at the two points farthest apart in the arena.
- A short freeze opens the round; then it is a fight to the last player standing.
- First to 5 round wins takes the match; sides swap after 4 rounds.

Combat is **server-authoritative** with lag compensation: the server rewinds
every target to the exact instant the shooter was rendering, so shots land where
you aimed them even on an imperfect connection. A headshot is a one-shot kill.

Multiplayer needs the room server running:

```bash
npm run server      # WebSocket + static host on :8787
```

- **Dev:** run `npm run dev` (client) and `npm run server` (rooms) side by side.
  The client connects to `ws://localhost:8787`.
- **Deploy:** `npm run build`, then `npm run server` — the server also serves
  the built client from `dist/`, so one process on one port is the whole game.
  Share `http://<host>:8787/?room=CODE`. For containerized / Pterodactyl hosting
  behind a domain (with `wss://`), see [DEPLOY.md](DEPLOY.md).

Server tuning is via environment variables: `PORT`, `TILE_BUDGET`, `ROUND_WINS`,
`ROUNDS_TO_SWAP`, `FREEZE_MS`, `ROUND_END_MS`, `MATCH_END_MS`.

## Run

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default <http://localhost:5173>).

## Source layout

| File              | Responsibility                                               |
| ----------------- | ------------------------------------------------------------ |
| `grid.js`         | The carve model — ops, open cells, wall derivation, save     |
| `builder.js`      | Turns the grid into Three.js meshes and colliders            |
| `editor.js`       | Top-down carve/erase interaction                             |
| `player.js`       | FPS controller — movement, collision, spread/recoil shooting |
| `settings.js`     | Sensitivity, keybinds, crosshair, volume, settings modal     |
| `net.js`          | Multiplayer client — connection, clock sync, lag-comp timing |
| `avatars.js`      | Remote-player avatars with snapshot interpolation            |
| `decals.js`       | Bullet-hole decals                                           |
| `audio.js`        | Synthesized sound effects (no asset files)                   |
| `main.js`         | Orchestration — modes, render loop, UI, match flow, netcode  |
| `server/index.js` | WebSocket room server — shared grid, combat, the 1v1 match   |

Built with vanilla JavaScript, [Three.js](https://threejs.org/), and
[Vite](https://vitejs.dev/); the server uses [ws](https://github.com/websockets/ws).
