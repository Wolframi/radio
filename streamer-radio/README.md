# Streamer Radio

Low-latency personal audio router for streamers with multi-branch routing, OBS Browser Source scene automation, non-interrupting viewer track requests, and multi-tenant JSON persistence.

## Architecture Overview

```
streamer-radio/
├── apps/
│   ├── server/         # Bun 1.x + WebTransport (HTTP/3 QUIC) + WebSocket fallback + REST
│   ├── desktop/        # Tauri 2.0 (Rust WASAPI per-process loopback + Opus + QUIC/WS) + React UI
│   ├── web-player/     # OBS Browser Source (WebCodecs AudioDecoder + AudioWorklet + SAB ring buffer)
│   └── admin/          # Minimal admin panel (create users, reset passwords, live status)
├── packages/
│   ├── shared/         # Zod schemas, API DTOs, heuristic track query parser
│   └── protocol/       # 8-byte binary frame protocol ([uint32 seq][uint32 ts_ms] + Opus payload)
├── scripts/
│   └── gen-dev-certs.sh
├── data/
│   └── users.example.json
├── docker-compose.yml
├── DECISIONS.md
└── README.md
```

## Quick Start (Local Development)

### 1. Prerequisites
- **Bun 1.1+** (for server & workspaces)
- **Rust toolchain (1.80+) + Tauri CLI v2** (for Windows Desktop App)
- **ffmpeg** and **yt-dlp** on `PATH` (for playlist streaming & viewer order downloads)
- **OpenSSL** (for local WebTransport ECDSA certificates)

### 2. Generate WebTransport Self-Signed Certificates
WebTransport requires HTTPS/TLS. For local development, Chromium/OBS accepts self-signed ECDSA P-256 certificates valid for **≤ 14 days** when pinned via `serverCertificateHashes`:

```bash
cd streamer-radio
bash scripts/gen-dev-certs.sh ./certs
```

This outputs:
- `./certs/cert.pem` & `./certs/key.pem`
- `./certs/cert-hash.base64` (automatically served by `/api/public/cert-hash` for dev WebTransport clients)

> In production, mount valid Let's Encrypt certificates (`fullchain.pem` / `privkey.pem`) to `/app/certs`.

### 3. Configure Environment & Bootstrap Admin
Set `JWT_SECRET` and (optionally) `ADMIN_PASSWORD`:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export ADMIN_PASSWORD="your-strong-admin-password"
```

If `ADMIN_PASSWORD` is omitted and `data/users.json` has no admin yet, open the Admin Panel to complete the one-time admin claim form.

### 4. Start the Server & Docker

Local with Bun:
```bash
bun install
bun run dev:server
```

Docker Compose (exposes both `4433/tcp` for HTTP/2+WS and `4433/udp` for HTTP/3 WebTransport):
```bash
docker compose up --build -d
```

### 5. Build the Windows Desktop App (Tauri 2.0)

```bash
cd apps/desktop
bun install
bun run tauri build
```

> Requires Windows 10 2004+ (build 19041+) for WASAPI per-process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`). Older Windows 10 builds automatically fall back to system-wide WASAPI mixer loopback.

---

## OBS Browser Source Setup

1. In OBS Studio, enable **Tools → WebSocket Server Settings**:
   - Port: `4455` (default)
   - Set a Server Password (recommended)
2. Add a **Browser Source** to each OBS scene (`Intro Scene`, `Game Scene`, `BRB Scene`, `Ending Scene`):
   - **URL**: `https://your-server:4433/player/<userSlug>/<branchSlug>?obsPassword=<OBS_WS_PASSWORD>`
   - Append `&debug=1` while testing to display the `200×24 px` bottom-left status strip (`● branch | scene | latency | buffer`).
   - **Width / Height**: `220 × 40` (or `1 × 1` when `debug=1` is off).
   - **Control audio via OBS**: Checked (allows OBS mixer volume/ducking per branch).
   - **Shutdown source when not visible**: **Unchecked** (keeps the WebTransport connection warm for instantaneous scene switches).
3. Launch OBS with autoplay enabled (if Browser Source blocks `AudioContext.resume()`):
   ```
   obs64.exe --autoplay-policy=no-user-gesture-required
   ```
4. **Required Response Headers**: The server automatically sets:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   on `/player/*` so `SharedArrayBuffer` and `AudioWorklet` operate in cross-origin isolated mode.

---

## Viewer Orders & Chat-Bot Webhook

- **Public Viewer Page**: `https://your-server:4433/order/<userSlug>`
- **Chat-Bot Webhook** (rate-limited):
  ```bash
  curl -X POST https://your-server:4433/webhook/<userSlug>/order \
    -H "Content-Type: application/json" \
    -d '{"query": "Daft Punk — Instant Crush", "requestedBy": "viewer42"}'
  ```
- Orders never interrupt the currently playing track; they play after the current track finishes, and the playlist resumes at the saved `exact` offset or `next` track once the queue empties.
