# Web FPS

Carve a level out of solid rock from a top-down view, then drop into first
person to walk it and shoot.

## How it works

The world starts as solid rock. In **Edit** mode you look straight down and
click-drag to carve rectangular rooms and corridors out of it. Overlapping
carves merge into one connected space — a shared edge simply becomes an open
doorway. Press **Enter Play** and the camera swoops down into first person:
every carved edge is now a wall, the carved floor is walkable, and floating
targets are scattered around to shoot.

## Controls

**Edit (top-down)**

- Click-drag — carve (or erase) a rectangle
- `1` / `2`, or the Tool button — switch Carve / Erase
- `Ctrl+Z` — undo · Clear — wipe the map · Scroll — zoom
- Save / Load — browser storage · Export / Import — `.json` map file

**Play (first person)**

- `WASD` move · mouse look · `Shift` sprint · `C` crouch · `Space` jump
- Click — shoot · `Esc` — release the mouse · `P` — back to Edit

## Run

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default <http://localhost:5173>).

## Source layout

| File         | Responsibility                                            |
| ------------ | --------------------------------------------------------- |
| `grid.js`    | The carve model — ops, open cells, wall derivation, save  |
| `builder.js` | Turns the grid into Three.js meshes and colliders         |
| `editor.js`  | Top-down carve/erase interaction                          |
| `player.js`  | FPS controller — movement, collision, hitscan shooting    |
| `main.js`    | Orchestration — mode switching, render loop, UI, targets  |

Built with vanilla JavaScript, [Three.js](https://threejs.org/), and
[Vite](https://vitejs.dev/).
