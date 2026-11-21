# Architectural Decisions (DECISIONS.md)

This document records the key engineering choices and trade-offs made for **Streamer Radio**.

---

## 1. Audio Transport: WebTransport (HTTP/3 QUIC) with WebSocket Fallback

**Decision:** Primary transport is WebTransport over HTTP/3 (QUIC) using unreliable datagrams (falling back to unidirectional streams if payload > maxDatagramSize) on the same port (`4433/udp` alongside `4433/tcp` HTTP/2, following the MediaMTX dual-listener model). Automatic fallback to WebSocket over TLS (`wss://`) is built into both Desktop App and Web Player.

**Rationale:**
- TCP-based WebSocket suffers from head-of-line (HoL) blocking: a single lost packet stalls all subsequent audio frames and inflates jitter buffers beyond 300 ms.
- QUIC datagrams drop late packets cleanly without stalling newer Opus frames, allowing Opus PLC (Packet Loss Concealment) to bridge gaps transparently.
- WebSocket fallback guarantees connectivity behind restrictive corporate/ISP firewalls that block UDP 443/4433 and in environments without HTTP/3 termination (e.g., standard reverse proxies).

**Fallback behavior:**
1. Client attempts `new WebTransport(url, opts)` with a 3-second connect timeout.
2. If WebTransport is unsupported or handshake fails, client transparently connects to `wss://.../stream/:userSlug/:branchSlug` using the identical 8-byte binary frame format (`[uint32 seq][uint32 timestamp_ms] + Opus payload`).
3. Both transports use exponential backoff reconnection (`500ms → 1s → 2s → 4s → max 10s` with ±20% jitter) and a 200 ms loss-recovery ring buffer ceiling.

---

## 2. Codec & Framing: Opus 48 kHz, 20 ms Default (10 ms Option), 64 kbps

**Decision:** Opus at 48 kHz stereo (or mono), 20 ms default frame size (960 samples/channel), configurable to 10 ms (480 samples/channel), 48–64 kbps CBR/CVBR with in-band FEC enabled.

**Rationale:**
- 48 kHz is Opus's native sample rate and matches Windows WASAPI shared-mode default and Web Audio `AudioContext` native rate, avoiding resampling latency.
- 20 ms frames (~160 bytes at 64 kbps) fit well inside a single QUIC datagram (~1200 byte MTU) with low header overhead (8 bytes = 5% overhead), while keeping algorithmic delay to 22.5 ms.
- 10 ms frames reduce algorithmic delay by another 10 ms for ultra-low-latency LAN/regional setups at the cost of 2× packet rate.
- WebCodecs `AudioDecoder` supports Opus natively across Chromium/OBS CEF without `<audio>` or MSE buffering overhead.

---

## 3. Browser Audio Pipeline: WebCodecs + AudioWorklet + SharedArrayBuffer Ring Buffer

**Decision:** Decode incoming Opus frames via `AudioDecoder` and copy interleaved Float32 PCM samples into a lock-free `SharedArrayBuffer` ring buffer consumed by a dedicated `AudioWorkletProcessor`.

**Rationale:**
- `AudioWorklet` runs on the high-priority real-time audio rendering thread, immune to main-thread GC pauses or React renders.
- Lock-free single-producer/single-consumer (SPSC) ring buffer with `Atomics.load/store` prevents audio glitches and enables tunable jitter buffer targets (50–100 ms target, 200 ms burst tolerance).
- **COOP/COEP fallback:** If the browser context is not `crossOriginIsolated` (e.g., behind a misconfigured proxy stripping COOP/COEP), the player falls back to transferring Float32 chunks over `AudioWorkletNode.port.postMessage` so audio still plays instead of failing silently.

---

## 4. Desktop Application: Tauri 2.0 (Rust) vs. Electron

**Decision:** Tauri 2.0 (Rust backend + React/TypeScript frontend).

**Rationale:**
- Binary size ~12–15 MB and idle RAM ~25–35 MB vs. Electron's ~150 MB binary and ~180 MB RAM (critical for streamers running OBS + game + browser simultaneously).
- Direct Rust FFI access to Windows WASAPI (`wasapi` / `windows` crates), including Windows 10 2004+ `ActivateAudioInterfaceAsync` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` for per-process audio isolation (e.g., capturing only Spotify without Discord/game sound).
- Native `audiopus` encoding and `wtransport` / `tokio-tungstenite` async streaming run on Tokio worker threads with zero IPC serialization of raw PCM across the WebView bridge.

---

## 5. Server Storage: Atomic JSON Files Without a Database

**Decision:** Per-tenant directory isolation under `data/users/<userId>/{config.json,playlist.json,queue.json,cache/}` plus `data/users.json`, written atomically using per-file async mutexes + `.tmp.<pid>.<rand>` → `fs.rename()`.

**Rationale:**
- Satisfies the zero-database operational constraint (single directory volume backup).
- POSIX `rename()` on the same filesystem is atomic, preventing truncated JSON files on crash or power loss.
- In-process async mutex per canonical path serializes concurrent writes (e.g., simultaneous playlist position tick and order deletion).
- Path confinement verifies every resolved file path starts with `path.resolve(DATA_DIR) + path.sep` and enforces strict slug regexes (`^[a-z0-9][a-z0-9_-]{0,47}$`).

---

## 6. Playback Engine State Machine (`LIVE | PLAYLIST | ORDER`)

**Decision:** Authoritative per-user state machine on the server for the single branch marked `isMain: true`:
- `LIVE` streams desktop ingest frames directly to subscribers. Incoming orders are queued (`status: pending → downloading → ready`) without interrupting live audio.
- Transitioning to `PLAYLIST` resumes from `playlist.position` (`exact` offset or `next` track).
- When a track ends naturally during `PLAYLIST` and a `ready` order exists, the engine saves the playlist resume position, transitions to `ORDER`, and plays orders FIFO until the queue drains.
- Orders **never** interrupt the currently playing track.
- Non-main branches operate independently in `passthrough`, `loop` (looping a server-side Opus file via `ffmpeg`), or `silence` mode.

---

## 7. Security & Multi-Tenancy Choices

- **Passwords:** `bcrypt` (cost 10) stored in `data/users.json`.
- **Tokens:** HS256 JWT with 24h expiration; `JWT_SECRET` read from `process.env` (with ephemeral `crypto.randomBytes(32)` fallback if unset in dev). Clients hold tokens in memory (`Authorization: Bearer`) and never persist them in `localStorage`.
- **Subprocess safety:** `yt-dlp` and `ffmpeg` are invoked exclusively with argument arrays (`shell: false`), never interpolated into shell strings.
- **SSRF guard:** Playlist URL tracks and external previews are validated against `http:`/`https:` schemes and blocked from loopback, RFC 1918 private networks, and link-local metadata endpoints.
- **Rate limiting:** Sliding-window per-IP + per-userSlug rate limiter on `/api/:userSlug/orders` and `/webhook/:userSlug/order`.
