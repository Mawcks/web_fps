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
