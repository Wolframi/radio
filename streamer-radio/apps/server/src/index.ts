import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import {
  AddTrackInputSchema,
  CreateOrderInputSchema,
  CreateUserInputSchema,
  LoginInputSchema,
  ReorderOrdersInputSchema,
  ResetPasswordInputSchema,
  SLUG_REGEX,
  UpdatePlaylistSettingsSchema,
  UserConfigSchema,
  parseTrackQuery,
  type Order,
  type PublicPlayerConfig,
  type StreamerAdminSummary,
} from '@streamer-radio/shared';
import {
  extractBearerOrQueryToken,
  hashPassword,
  signAuthToken,
  verifyAuthToken,
  verifyEnvAdminPassword,
  verifyPassword,
  type AuthTokenPayload,
} from './auth';
import { assertSafeExternalUrl, resolveOrderTrack } from './order-resolver';
import { UserPlaybackEngine } from './playback-engine';
import { SlidingWindowRateLimiter } from './rate-limit';
import { AtomicJsonStore } from './storage';

const PORT = Number(process.env.PORT || 4433);
const DATA_DIR = process.env.DATA_DIR || './data';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || './certs/cert.pem';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || './certs/key.pem';

// Structured logger without PII (never logs passwords, JWTs, or user IPs)
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['password', 'passwordHash', 'token', 'authorization'],
});

const store = new AtomicJsonStore(DATA_DIR);
const engines = new Map<string, UserPlaybackEngine>();
const orderRateLimiter = new SlidingWindowRateLimiter(15, 60_000);

async function getEngineBySlug(userSlug: string): Promise<{ engine: UserPlaybackEngine; userId: string } | null> {
  if (!SLUG_REGEX.test(userSlug)) return null;
  const usersFile = await store.readUsers();
  const user = usersFile.users.find((u) => u.username === userSlug);
  if (!user) return null;

  let engine = engines.get(user.id);
  if (!engine) {
    await store.ensureUserDirectory(user.id);
    engine = new UserPlaybackEngine(user.id, user.username, store);
    engines.set(user.id, engine);
    void engine.syncLoopBranches();
  }
  return { engine, userId: user.id };
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function playerIsolationHeaders(): Record<string, string> {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function requireAuth(req: Request): AuthTokenPayload | Response {
  const token = extractBearerOrQueryToken(req);
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  const payload = verifyAuthToken(token);
  if (!payload) return jsonResponse({ error: 'Invalid or expired token' }, 401);
  return payload;
}

function requireTenantOrAdmin(auth: AuthTokenPayload, userSlug: string): Response | null {
  if (auth.role === 'admin' || auth.username === userSlug) return null;
  return jsonResponse({ error: 'Forbidden: tenant isolation enforced' }, 403);
}

async function enqueueOrder(userSlug: string, body: unknown, clientKey: string): Promise<Response> {
  const limit = orderRateLimiter.check(`${userSlug}:${clientKey}`);
  if (!limit.allowed) {
    return jsonResponse(
      { error: 'Rate limit exceeded. Try again shortly.' },
      429,
      { 'Retry-After': String(limit.retryAfterSec) },
    );
  }

  const parsed = CreateOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'Invalid order payload', details: parsed.error.flatten() }, 400);
  }

  const target = await getEngineBySlug(userSlug);
  if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);

  const rawQuery = 'query' in parsed.data ? parsed.data.query : `${parsed.data.artist} — ${parsed.data.title}`;
  const queryParts = parseTrackQuery(rawQuery);
  const orderId = `ord_${crypto.randomBytes(6).toString('hex')}`;

  const order: Order = {
    id: orderId,
    query: rawQuery,
    parsedArtist: queryParts.artist || undefined,
    parsedTitle: queryParts.title || undefined,
    status: 'pending',
    requestedBy: parsed.data.requestedBy,
    createdAt: new Date().toISOString(),
  };

  await store.mutateQueue(target.userId, (q) => {
    q.orders.push(order);
  });
  await target.engine.broadcastQueueUpdate();

  // Asynchronous download/resolution pipeline
  void (async () => {
    await store.mutateQueue(target.userId, (q) => {
      const o = q.orders.find((item) => item.id === orderId);
      if (o) o.status = 'downloading';
    });
    await target.engine.broadcastQueueUpdate();

    try {
      const cfg = await store.readConfig(target.userId);
      const resolved = await resolveOrderTrack(store, target.userId, rawQuery, cfg.audio.bitrateKbps);
      await store.mutateQueue(target.userId, (q) => {
        const o = q.orders.find((item) => item.id === orderId);
        if (o) {
          o.status = 'ready';
          o.resolvedTitle = resolved.title;
          o.resolvedArtist = resolved.artist;
          o.durationMs = resolved.durationMs;
          o.cachePath = resolved.cachePath;
          o.previewUrl = resolved.previewUrl;
          o.sourceProvider = resolved.provider;
        }
      });
    } catch (err: unknown) {
      await store.mutateQueue(target.userId, (q) => {
        const o = q.orders.find((item) => item.id === orderId);
        if (o) {
          o.status = 'failed';
          o.error = err instanceof Error ? err.message : 'Resolution failed';
        }
      });
    }
    await target.engine.broadcastQueueUpdate();
  })();

  return jsonResponse({ order }, 201);
}

interface WsSessionData {
  kind: 'ingest' | 'stream' | 'events';
  userSlug: string;
  userId: string;
  branchSlug?: string;
  subId: string;
}

async function startWebTransportListener(certPem: string, keyPem: string): Promise<void> {
  try {
    // Dynamic import of optional Rust N-API WebTransport addon (webtransport-bun)
    const wtMod = await import('webtransport-bun');
    const WebTransportServer = wtMod.WebTransportServer ?? wtMod.default?.WebTransportServer;
    if (!WebTransportServer) {
      logger.warn('webtransport-bun module loaded without WebTransportServer export; using WebSocket fallback');
      return;
    }

    // Separate HTTP/3 UDP listener on the exact same port as HTTP/2 (MediaMTX pattern)
    const wtServer = new WebTransportServer({
      port: PORT,
      host: '0.0.0.0',
      cert: certPem,
      key: keyPem,
    });

    wtServer.onSession(async (session: {
      path: string;
      datagrams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
      closed: Promise<void>;
      close: (code?: number, reason?: string) => void;
    }) => {
      const url = new URL(session.path, `https://localhost:${PORT}`);
      const segments = url.pathname.split('/').filter(Boolean);
      const [routeType, userSlug, branchSlug] = segments;

      const target = userSlug ? await getEngineBySlug(userSlug) : null;
      if (!target || !branchSlug) {
        session.close(404, 'Unknown target');
        return;
      }

      if (routeType === 'ingest') {
        const token = url.searchParams.get('token');
        const auth = token ? verifyAuthToken(token) : null;
        if (!auth || (auth.role !== 'admin' && auth.username !== userSlug)) {
          session.close(401, 'Unauthorized');
          return;
        }

        await target.engine.onIngestConnected(branchSlug);
        const reader = session.datagrams.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) {
              await target.engine.handleIngestFrame(branchSlug, value);
            }
          }
        } finally {
          await target.engine.onIngestDisconnected(branchSlug);
        }
      } else if (routeType === 'stream') {
        const subId = `wt_${crypto.randomBytes(6).toString('hex')}`;
        const writer = session.datagrams.writable.getWriter();
        target.engine.addAudioSubscriber(branchSlug, {
          id: subId,
          transport: 'webtransport',
          sendBinary: (frame) => {
            void writer.write(frame).catch(() => {});
          },
          sendText: () => {},
        });
        await session.closed.catch(() => {});
        target.engine.removeAudioSubscriber(branchSlug, subId);
      }
    });

    logger.info({ port: PORT, proto: 'HTTP/3 QUIC WebTransport' }, 'WebTransport UDP listener active');
  } catch {
    logger.info('webtransport-bun native addon not installed in this environment; WebSocket binary transport active');
  }
}

async function bootstrap(): Promise<void> {
  await store.init();

  let tlsConfig: { cert: string; key: string } | undefined;
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(TLS_CERT_PATH, 'utf8'),
      fs.readFile(TLS_KEY_PATH, 'utf8'),
    ]);
    tlsConfig = { cert, key };
    await startWebTransportListener(cert, key);
  } catch {
    logger.warn({ TLS_CERT_PATH }, 'TLS certs not found; starting HTTP/WS server without TLS (run scripts/gen-dev-certs.sh)');
  }

  Bun.serve<WsSessionData>({
    port: PORT,
    hostname: '0.0.0.0',
    ...(tlsConfig ? { tls: tlsConfig } : {}),

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;

      // WebSocket upgrades: /ingest/:userSlug/:branchSlug, /stream/:userSlug/:branchSlug, /ws/events/:userSlug
      const ingestMatch = pathname.match(/^\/ingest\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);
      if (ingestMatch) {
        const [, userSlug, branchSlug] = ingestMatch;
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        const denied = requireTenantOrAdmin(auth, userSlug);
        if (denied) return denied;
        const target = await getEngineBySlug(userSlug);
        if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);
        const ok = server.upgrade(req, {
          data: { kind: 'ingest', userSlug, userId: target.userId, branchSlug, subId: crypto.randomUUID() },
        });
        return ok ? undefined : jsonResponse({ error: 'Upgrade failed' }, 400);
      }

      const streamMatch = pathname.match(/^\/stream\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);
      if (streamMatch) {
        const [, userSlug, branchSlug] = streamMatch;
        const target = await getEngineBySlug(userSlug);
        if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);
        const ok = server.upgrade(req, {
          data: { kind: 'stream', userSlug, userId: target.userId, branchSlug, subId: crypto.randomUUID() },
        });
        return ok ? undefined : jsonResponse({ error: 'Upgrade failed' }, 400);
      }

      const eventsMatch = pathname.match(/^\/ws\/events\/([a-z0-9_-]+)$/);
      if (eventsMatch) {
        const [, userSlug] = eventsMatch;
        const target = await getEngineBySlug(userSlug);
        if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);
        const ok = server.upgrade(req, {
          data: { kind: 'events', userSlug, userId: target.userId, subId: crypto.randomUUID() },
        });
        return ok ? undefined : jsonResponse({ error: 'Upgrade failed' }, 400);
      }

      // Healthcheck
      if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ ok: true, webTransport: Boolean(tlsConfig), ts: Date.now() });
      }

      // Serve dev self-signed cert SHA-256 base64 for WebTransport serverCertificateHashes
      if (method === 'GET' && pathname === '/api/public/cert-hash') {
        try {
          const hashPath = path.resolve(path.dirname(TLS_CERT_PATH), 'cert-hash.base64');
          const hashBase64 = (await fs.readFile(hashPath, 'utf8')).trim();
          return jsonResponse({ algorithm: 'sha-256', hashBase64 });
        } catch {
          return jsonResponse({ hashBase64: null });
        }
      }

      // Auth: login
      if (method === 'POST' && pathname === '/api/auth/login') {
        const parsed = LoginInputSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return jsonResponse({ error: 'Invalid credentials format' }, 400);
        const username = parsed.data.username.toLowerCase();
        const usersFile = await store.readUsers();
        const user = usersFile.users.find((u) => u.username === username);
        if (!user) return jsonResponse({ error: 'Invalid username or password' }, 401);

        const valid =
          user.role === 'admin' && process.env.ADMIN_PASSWORD?.trim()
            ? verifyEnvAdminPassword(parsed.data.password)
            : await verifyPassword(parsed.data.password, user.passwordHash);

        if (!valid) return jsonResponse({ error: 'Invalid username or password' }, 401);
        const token = signAuthToken(user);
        return jsonResponse({ token, user: { id: user.id, username: user.username, role: user.role } });
      }

      // Auth: me
      if (method === 'GET' && pathname === '/api/me') {
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        return jsonResponse({ id: auth.sub, username: auth.username, role: auth.role });
      }

      // Admin endpoints
      if (pathname === '/api/admin/users' && method === 'GET') {
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        if (auth.role !== 'admin') return jsonResponse({ error: 'Admin role required' }, 403);
        const usersFile = await store.readUsers();
        const summaries: StreamerAdminSummary[] = await Promise.all(
          usersFile.users.map(async (u) => {
            const eng = engines.get(u.id);
            const status = eng?.getAdminStatus() ?? { online: false, mode: 'PLAYLIST', activeBranches: [], listenerCount: 0 };
            const queue = await store.readQueue(u.id).catch(() => ({ orders: [] }));
            return {
              id: u.id,
              username: u.username,
              role: u.role,
              createdAt: u.createdAt,
              online: status.online,
              mode: status.mode,
              activeBranches: status.activeBranches,
              listenerCount: status.listenerCount,
              queueLength: queue.orders.length,
            };
          }),
        );
        return jsonResponse({ users: summaries });
      }

      if (pathname === '/api/admin/users' && method === 'POST') {
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        if (auth.role !== 'admin') return jsonResponse({ error: 'Admin role required' }, 403);
        const parsed = CreateUserInputSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return jsonResponse({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

        const passwordHash = await hashPassword(parsed.data.password);
        try {
          const created = await store.mutateUsers((file) => {
            if (file.users.some((u) => u.username === parsed.data.username)) {
              throw new Error('USERNAME_TAKEN');
            }
            const record = {
              id: `usr_${crypto.randomBytes(6).toString('hex')}`,
              username: parsed.data.username,
              passwordHash,
              role: parsed.data.role,
              createdAt: new Date().toISOString(),
            };
            file.users.push(record);
            return record;
          });
          await store.ensureUserDirectory(created.id);
          return jsonResponse(
            { user: { id: created.id, username: created.username, role: created.role, createdAt: created.createdAt } },
            201,
          );
        } catch (err: unknown) {
          if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
            return jsonResponse({ error: 'Username already exists' }, 409);
          }
          throw err;
        }
      }

      const resetMatch = pathname.match(/^\/api\/admin\/users\/([a-zA-Z0-9_-]+)\/reset-password$/);
      if (resetMatch && method === 'POST') {
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        if (auth.role !== 'admin') return jsonResponse({ error: 'Admin role required' }, 403);
        const parsed = ResetPasswordInputSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return jsonResponse({ error: 'Invalid password' }, 400);
        const passwordHash = await hashPassword(parsed.data.password);
        const found = await store.mutateUsers((file) => {
          const u = file.users.find((x) => x.id === resetMatch[1]);
          if (!u) return false;
          u.passwordHash = passwordHash;
          return true;
        });
        if (!found) return jsonResponse({ error: 'User not found' }, 404);
        return jsonResponse({ ok: true });
      }

      // Public player config: GET /api/public/:userSlug/config
      const pubConfigMatch = pathname.match(/^\/api\/public\/([a-z0-9_-]+)\/config$/);
      if (pubConfigMatch && method === 'GET') {
        const target = await getEngineBySlug(pubConfigMatch[1]);
        if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);
        const cfg = await store.readConfig(target.userId);
        const pub: PublicPlayerConfig = {
          userSlug: pubConfigMatch[1],
          branches: cfg.branches.map(({ id, name, slug, isMain, mode }) => ({ id, name, slug, isMain, mode })),
          obsSceneMapping: cfg.obsSceneMapping,
          obsWsUrl: cfg.obsWsUrl || 'ws://127.0.0.1:4455',
          hasObsPassword: Boolean(cfg.obsWsPassword),
          audio: cfg.audio,
        };
        return jsonResponse(pub);
      }

      // Webhook for chat bots: POST /webhook/:userSlug/order
      const webhookMatch = pathname.match(/^\/webhook\/([a-z0-9_-]+)\/order$/);
      if (webhookMatch && method === 'POST') {
        const body = await req.json().catch(() => null);
        const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'webhook';
        return enqueueOrder(webhookMatch[1], body, key);
      }

      // Tenant REST endpoints: /api/:userSlug/...
      const tenantMatch = pathname.match(/^\/api\/([a-z0-9_-]+)\/(.+)$/);
      if (tenantMatch) {
        const [, userSlug, subPath] = tenantMatch;

        // Publicly callable order creation (rate limited)
        if (subPath === 'orders' && method === 'POST') {
          const body = await req.json().catch(() => null);
          const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'client';
          return enqueueOrder(userSlug, body, key);
        }

        // Publicly readable queue for /order/:userSlug page
        if (subPath === 'orders' && method === 'GET') {
          const target = await getEngineBySlug(userSlug);
          if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);
          const queue = await store.readQueue(target.userId);
          return jsonResponse({ orders: queue.orders });
        }

        // All other tenant routes require authentication + tenant ownership or admin
        const auth = requireAuth(req);
        if (auth instanceof Response) return auth;
        const denied = requireTenantOrAdmin(auth, userSlug);
        if (denied) return denied;
        const target = await getEngineBySlug(userSlug);
        if (!target) return jsonResponse({ error: 'Streamer not found' }, 404);

        if (subPath === 'config' && method === 'GET') {
          return jsonResponse(await store.readConfig(target.userId));
        }

        if (subPath === 'config' && method === 'PUT') {
          const parsed = UserConfigSchema.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return jsonResponse({ error: 'Invalid config', details: parsed.error.flatten() }, 400);
          const saved = await store.writeConfig(target.userId, parsed.data);
          await target.engine.syncLoopBranches();
          await target.engine.broadcastEvent('config:updated', saved);
          return jsonResponse(saved);
        }

        if (subPath === 'playback' && method === 'GET') {
          return jsonResponse(await target.engine.getSnapshot());
        }

        if (subPath === 'playback/mode' && method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as { mode?: 'LIVE' | 'PLAYLIST' | 'ORDER' };
          if (body.mode !== 'LIVE' && body.mode !== 'PLAYLIST' && body.mode !== 'ORDER') {
            return jsonResponse({ error: 'Invalid playback mode' }, 400);
          }
          await target.engine.setMode(body.mode);
          return jsonResponse(await target.engine.getSnapshot());
        }

        if (subPath === 'playlist' && method === 'GET') {
          return jsonResponse(await store.readPlaylist(target.userId));
        }

        if (subPath === 'playlist' && method === 'POST') {
          const parsed = AddTrackInputSchema.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return jsonResponse({ error: 'Invalid track', details: parsed.error.flatten() }, 400);
          if (parsed.data.source === 'url' || parsed.data.source === 'yt') {
            try {
              assertSafeExternalUrl(parsed.data.pathOrUrl);
            } catch (e: unknown) {
              return jsonResponse({ error: e instanceof Error ? e.message : 'Invalid URL' }, 400);
            }
          }
          const track = { id: `trk_${crypto.randomBytes(5).toString('hex')}`, ...parsed.data };
          const updated = await store.mutatePlaylist(target.userId, (pl) => {
            pl.tracks.push(track);
            return pl;
          });
          await target.engine.broadcastEvent('playlist:updated', updated);
          return jsonResponse({ track, playlist: updated }, 201);
        }

        if (subPath === 'playlist' && method === 'PATCH') {
          const parsed = UpdatePlaylistSettingsSchema.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return jsonResponse({ error: 'Invalid playlist update' }, 400);
          const updated = await store.mutatePlaylist(target.userId, (pl) => {
            if (parsed.data.mode) pl.mode = parsed.data.mode;
            if (parsed.data.position) pl.position = parsed.data.position;
            if (parsed.data.trackIds) {
              const byId = new Map(pl.tracks.map((t) => [t.id, t]));
              pl.tracks = parsed.data.trackIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
            }
            return pl;
          });
          await target.engine.broadcastEvent('playlist:updated', updated);
          return jsonResponse(updated);
        }

        const delTrackMatch = subPath.match(/^playlist\/([a-zA-Z0-9_-]+)$/);
        if (delTrackMatch && method === 'DELETE') {
          const updated = await store.mutatePlaylist(target.userId, (pl) => {
            pl.tracks = pl.tracks.filter((t) => t.id !== delTrackMatch[1]);
            if (pl.position.trackIndex >= pl.tracks.length) {
              pl.position = { trackIndex: 0, offsetMs: 0 };
            }
            return pl;
          });
          await target.engine.broadcastEvent('playlist:updated', updated);
          return jsonResponse(updated);
        }

        if (subPath === 'orders/reorder' && method === 'PATCH') {
          const parsed = ReorderOrdersInputSchema.safeParse(await req.json().catch(() => null));
          if (!parsed.success) return jsonResponse({ error: 'Invalid reorder payload' }, 400);
          const queue = await store.mutateQueue(target.userId, (q) => {
            const map = new Map(q.orders.map((o) => [o.id, o]));
            const reordered = parsed.data.orderIds.map((id) => map.get(id)).filter((o): o is Order => Boolean(o));
            const remaining = q.orders.filter((o) => !parsed.data.orderIds.includes(o.id));
            q.orders = [...reordered, ...remaining];
            return q;
          });
          await target.engine.broadcastQueueUpdate();
          return jsonResponse({ orders: queue.orders });
        }

        const delOrderMatch = subPath.match(/^orders\/([a-zA-Z0-9_-]+)$/);
        if (delOrderMatch && method === 'DELETE') {
          const queue = await store.mutateQueue(target.userId, (q) => {
            q.orders = q.orders.filter((o) => o.id !== delOrderMatch[1]);
            return q;
          });
          await target.engine.broadcastQueueUpdate();
          return jsonResponse({ orders: queue.orders });
        }
      }

      // Player HTML route with mandatory COOP/COEP headers for SharedArrayBuffer + AudioWorklet
      if (method === 'GET' && /^\/player\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(pathname)) {
        const playerDist = path.resolve(import.meta.dir, '../../web-player/dist/index.html');
        try {
          const html = await fs.readFile(playerDist, 'utf8');
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              ...playerIsolationHeaders(),
            },
          });
        } catch {
          return new Response('Web Player build not found. Run `bun run --cwd apps/web-player build`.', {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...playerIsolationHeaders() },
          });
        }
      }

      return jsonResponse({ error: 'Not found' }, 404);
    },

    websocket: {
      open(ws) {
        const { kind, userId, branchSlug, subId } = ws.data;
        const engine = engines.get(userId);
        if (!engine) {
          ws.close(1011, 'Engine unavailable');
          return;
        }
        if (kind === 'ingest' && branchSlug) {
          void engine.onIngestConnected(branchSlug);
        } else if (kind === 'stream' && branchSlug) {
          engine.addAudioSubscriber(branchSlug, {
            id: subId,
            transport: 'websocket',
            sendBinary: (frame) => ws.sendBinary(frame),
            sendText: (text) => ws.sendText(text),
          });
        } else if (kind === 'events') {
          engine.addEventSubscriber({
            id: subId,
            sendText: (text) => ws.sendText(text),
          });
        }
      },
      message(ws, message) {
        const { kind, userId, branchSlug } = ws.data;
        const engine = engines.get(userId);
        if (!engine) return;
        if (kind === 'ingest' && branchSlug && message instanceof Uint8Array) {
          void engine.handleIngestFrame(branchSlug, message);
        } else if (typeof message === 'string') {
          try {
            const ctrl = JSON.parse(message) as { type?: string; clientTimeMs?: number };
            if (ctrl.type === 'ping' && typeof ctrl.clientTimeMs === 'number') {
              ws.sendText(JSON.stringify({ type: 'pong', clientTimeMs: ctrl.clientTimeMs, serverTimeMs: Date.now() }));
            }
          } catch {
            // ignore malformed control message
          }
        }
      },
      close(ws) {
        const { kind, userId, branchSlug, subId } = ws.data;
        const engine = engines.get(userId);
        if (!engine) return;
        if (kind === 'ingest' && branchSlug) {
          void engine.onIngestDisconnected(branchSlug);
        } else if (kind === 'stream' && branchSlug) {
          engine.removeAudioSubscriber(branchSlug, subId);
        } else if (kind === 'events') {
          engine.removeEventSubscriber(subId);
        }
      },
    },
  });

  logger.info({ port: PORT, tls: Boolean(tlsConfig), dataDir: DATA_DIR }, 'Streamer Radio server listening');
}

void bootstrap();
