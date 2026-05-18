# Web FPS

Carve a level out of solid rock from a top-down view, then drop into first
person to walk it and shoot — alone or with friends.

## How it works

The world starts as solid rock. In **Edit** mode you look straight down and
click-drag to carve rectangular rooms and corridors out of it. Overlapping
carves merge into one connected space — a shared edge becomes an open doorway.
Press **Enter Play** and the camera swoops into first person: every carved edge
is a wall, the carved floor is walkable, and floating targets are scattered to
shoot.

## Controls

**Edit (top-down)**

- Click-drag — carve (or erase) a rectangle
- `1` / `2`, or the Tool button — switch Carve / Erase
- `Ctrl+Z` — undo · Clear — wipe the map · Scroll — zoom
- Save / Load — browser storage · Export / Import — `.json` map file

**Play (first person)**

- `WASD` move · mouse look · `Shift` sprint · `C` crouch · `Space` jump
- Click — shoot · `Esc` — release the mouse · `P` — back to Edit

Sensitivity and keybinds are configurable under **Settings**. Sensitivity is
entered as a Valorant sens value and matched 1:1 using raw mouse input.

## Multiplayer

Players share one carve grid. One player **creates a room** and shares the
invite link; others **join** with it. Everyone has a tile budget — carve one big
shape or many small ones, but every carve must stay connected to the shared
space. Other players show up as avatars when they are in play mode.

Multiplayer needs the room server running:

```bash
npm run server      # WebSocket + static host on :8787 (PORT / TILE_BUDGET env vars)
```

- **Dev:** run `npm run dev` (client) and `npm run server` (rooms) side by side.
  The client connects to `ws://localhost:8787`.
- **Deploy:** `npm run build`, then `npm run server` — the server also serves
  the built client from `dist/`, so one process on one port is the whole game.
  Share `http://<host>:8787/?room=CODE`.

## Run

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default <http://localhost:5173>).

## Source layout

| File              | Responsibility                                              |
| ----------------- | ----------------------------------------------------------- |
| `grid.js`         | The carve model — ops, open cells, wall derivation, save    |
| `builder.js`      | Turns the grid into Three.js meshes and colliders           |
| `editor.js`       | Top-down carve/erase interaction                            |
| `player.js`       | FPS controller — movement, collision, hitscan shooting      |
| `settings.js`     | Sensitivity conversion, keybinds, settings modal            |
| `net.js`          | Multiplayer client — WebSocket room connection              |
| `avatars.js`      | Remote-player avatars                                       |
| `main.js`         | Orchestration — modes, render loop, UI, targets, netcode    |
| `server/index.js` | WebSocket room server (shared grid, tile budgets, presence) |

Built with vanilla JavaScript, [Three.js](https://threejs.org/), and
[Vite](https://vitejs.dev/); the server uses [ws](https://github.com/websockets/ws).
