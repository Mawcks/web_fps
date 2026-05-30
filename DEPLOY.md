# Deploying web-fps

web-fps is a **single Node process** that serves the built client *and* the
WebSocket game server on **one port**. So hosting is simple: stand up that one
process, then point a TLS-terminating reverse proxy at it (forwarding WebSocket
upgrades). The browser auto-connects to `wss://<the page's own host>`, so there
is no client-side server address to configure.

- Runtime needs only Node and the `ws` package — Three.js is bundled into
  `dist/` at build time.
- Everything is env-configurable: `PORT` (or `SERVER_PORT`), `TILE_BUDGET`,
  `ROUND_WINS`, `ROUNDS_TO_SWAP`, `FREEZE_MS`, `ROUND_END_MS`, `MATCH_END_MS`.

---

## Option A — Pterodactyl egg

1. **Import the egg.** Admin → Nests → choose or create a nest → *Import Egg* →
   upload [`egg-web-fps.json`](./egg-web-fps.json).
2. **Create a server** using the *Web FPS (1v1 Arena)* egg:
   - **Allocation:** any free port — this is the HTTP+WS port your reverse proxy
     will target. (No port variable to set; the server reads `SERVER_PORT`.)
   - **Resources:** ~512 MB RAM, ~1 vCPU, ~2 GB disk is plenty.
   - **Variables:** defaults work. `Git branch` is `main`; the tuning variables
     map straight to the server's env vars.
3. **Install & start.** Installation clones the repo, runs `npm install`, builds
   the client, and prunes to runtime deps. The console prints
   `web-fps server listening on …` once it's up.
4. **Reverse-proxy it** (below) so players reach it over `https://` / `wss://`.

## Option B — Plain Docker

```bash
docker build -t web-fps .
docker run -d --name web-fps -p 8787:8787 web-fps
# override the port / tuning with -e:
#   -e PORT=9000 -e ROUND_WINS=7 -e TILE_BUDGET=1000
```

Then reverse-proxy `:8787` as below.

---

## Reverse proxy (nginx)

The only real requirement is **forwarding the WebSocket upgrade**:

```nginx
# in http { } once — skip if your config already defines $connection_upgrade:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name fps.example.com;              # your hostname

    # ssl_certificate     /path/fullchain.pem;
    # ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://BACKEND_HOST:BACKEND_PORT;   # the game server's host:port
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1d;                 # don't drop idle game sockets
    }
}
```

`nginx -t && systemctl reload nginx`, then point DNS at the proxy. If you front
it with Cloudflare, WebSockets pass through the proxy by default.

---

## Verify

1. Open `https://<your host>/` — the menu loads with no console errors.
2. **Multiplayer → Create room**, copy the invite link, open it in a second
   browser/tab → **Join**. The roster shows both players.
3. Carve an arena, **Start 1v1 match** → both clients freeze, then fight.

## Local dev (unchanged)

```bash
npm install
npm run dev        # client on :5173
npm run server     # rooms + static on :8787
```
