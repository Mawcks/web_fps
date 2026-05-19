- v0.4: Added wall collision, visible spawn carve zone, and smoother camera logic
- v0.5: Full rewrite. True carve-out level editor on a cell grid (overlapping
  carves merge, shared edges become doorways), erase tool, undo, zoom. Rebuilt
  FPS controller with sprint/crouch/jump and 2D wall collision. Hitscan shooting
  with floating targets, score and accuracy. JSON map export/import. Modular
  source split (grid / builder / editor / player / main).
- v0.6: Settings panel — sensitivity entered as a Valorant sens value and
  matched 1:1 with raw mouse input, plus rebindable keys. Multiplayer: a
  WebSocket room server where players share one carve grid with per-player tile
  budgets and a keep-it-connected rule, invite-link rooms, and remote-player
  avatars in play mode.
- v0.7: Turned the game into a Counter-Strike-style 1v1 arena shooter. Dropped
  the shooting-gallery targets for server-authoritative PvP — hitscan combat
  with HP, headshots, hitmarkers, a killfeed, and death/respawn. Netcode rebuilt
  for exact lag compensation: server-timestamped snapshots, a client clock
  estimate, snapshot interpolation at a fixed delay, and shots that carry a
  render time the server rewinds targets to. Gunplay gained movement-scaled
  spread, a learnable recoil spray pattern, bullet holes, and a crosshair editor.
  Movement became a Quake/Source friction + acceleration model with
  counter-strafing and air-strafing. Added a 1v1 match system — one-life rounds,
  spawns at the arena's farthest points, a side swap at half, a round/score HUD
  and banners. Synthesized Web Audio sound effects for combat and match events,
  with positional remote gunshots and a volume control.
