import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
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
} from './shared/schemas';
import {
  extractRequestToken,
  hasEnvAdminPassword,
  hashPassword,
  signAuthToken,
  verifyAuthToken,
  verifyEnvAdminPassword,
  verifyPassword,
  type AuthTokenPayload,
} from './server/auth';
import { assertSafeExternalUrl, resolveOrderTrack } from './server/orders';
import { TenantPlaybackEngine } from './server/playback';
import { AtomicJsonStore } from './server/storage';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || './data';
const MONOREPO_ROOT = path.resolve(process.cwd(), 'streamer-radio');
// Set REQUIRE_AUTH=true in production to enforce login/registration gate
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly maxReq: number, private readonly windowMs: number) {}
  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxReq) {
      const retryAfterSec = Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000));
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSec };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSec: 0 };
  }
}

const store = new AtomicJsonStore(DATA_DIR);
const engines = new Map<string, TenantPlaybackEngine>();
const orderRateLimiter = new RateLimiter(20, 60_000);

interface AuthedRequest extends Request {
  auth?: AuthTokenPayload;
}

function logEvent(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>): void {
  // Structured JSON logging without PII
  const record = { ts: new Date().toISOString(), level, event, ...meta };
  console.log(JSON.stringify(record));
}

async function getEngineBySlug(userSlug: string): Promise<{ engine: TenantPlaybackEngine; userId: string } | null> {
  if (!SLUG_REGEX.test(userSlug)) return null;
  const usersFile = await store.readUsers();
  const user = usersFile.users.find((u) => u.username === userSlug);
  if (!user) return null;

  let engine = engines.get(user.id);
  if (!engine) {
    await store.ensureUserDirectory(user.id);
    engine = new TenantPlaybackEngine(user.id, user.username, store);
    engines.set(user.id, engine);
    await engine.ensureStarted();
  }
  return { engine, userId: user.id };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractRequestToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  req.auth = payload;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required' });
    return;
  }
  next();
}

function requireTenantAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const userSlug = String(req.params.userSlug || '');
  if (!SLUG_REGEX.test(userSlug)) {
    res.status(400).json({ error: 'Invalid user slug' });
    return;
  }
  if (!req.auth || (req.auth.role !== 'admin' && req.auth.username !== userSlug)) {
    res.status(403).json({ error: 'Forbidden: tenant isolation enforced' });
    return;
  }
  next();
}

async function collectBlueprintFiles(dir: string, relBase = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBlueprintFiles(full, relPath)));
    } else {
      files.push(relPath);
    }
  }
  return files.sort();
}

async function enqueueOrderHandler(req: Request, res: Response): Promise<void> {
  const userSlug = String(req.params.userSlug || '');
  if (!SLUG_REGEX.test(userSlug)) {
    res.status(400).json({ error: 'Invalid streamer slug' });
    return;
  }

  const clientKey = req.ip || 'client';
  const rate = orderRateLimiter.check(`${userSlug}:${clientKey}`);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.status(429).json({ error: 'Слишком много заказов, подождите немного.' });
    return;
  }

  const parsed = CreateOrderInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid order payload', details: parsed.error.flatten() });
    return;
  }

  const target = await getEngineBySlug(userSlug);
  if (!target) {
    res.status(404).json({ error: 'Streamer not found' });
    return;
  }

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

  // Resolve audio asynchronously
  void (async () => {
    await store.mutateQueue(target.userId, (q) => {
      const item = q.orders.find((o) => o.id === orderId);
      if (item) item.status = 'downloading';
    });
    await target.engine.broadcastQueueUpdate();

    try {
      const cfg = await store.readConfig(target.userId);
      const resolved = await resolveOrderTrack(store, target.userId, rawQuery, cfg.audio.bitrateKbps);
      await store.mutateQueue(target.userId, (q) => {
        const item = q.orders.find((o) => o.id === orderId);
        if (item) {
          item.status = 'ready';
          item.resolvedTitle = resolved.title;
          item.resolvedArtist = resolved.artist;
          item.durationMs = resolved.durationMs;
          item.cachePath = resolved.cachePath;
          item.previewUrl = resolved.previewUrl;
          item.sourceProvider = resolved.provider;
        }
      });
    } catch (err: unknown) {
      await store.mutateQueue(target.userId, (q) => {
        const item = q.orders.find((o) => o.id === orderId);
        if (item) {
          item.status = 'failed';
          item.error = err instanceof Error ? err.message : 'Resolution error';
        }
      });
    }
    await target.engine.broadcastQueueUpdate();
  })();

  res.status(201).json({ order });
}

async function bootstrapPreviewWorkspace(): Promise<void> {
  if (REQUIRE_AUTH) return;
  const { adminRec, streamerRec } = await store.mutateUsers(async (file) => {
    let admin = file.users.find((u) => u.role === 'admin');
    if (!admin) {
      admin = {
        id: 'usr_admin_preview',
        username: 'admin',
        passwordHash: await hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'admin',
        createdAt: new Date().toISOString(),
      };
      file.users.push(admin);
    }
    let streamer = file.users.find((u) => u.role === 'streamer');
    if (!streamer) {
      streamer = {
        id: 'usr_streamer1_preview',
        username: 'streamer1',
        passwordHash: await hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'streamer',
        createdAt: new Date().toISOString(),
      };
      file.users.push(streamer);
    }
    return { adminRec: admin, streamerRec: streamer };
  });

  await store.ensureUserDirectory(adminRec.id);
  await store.ensureUserDirectory(streamerRec.id);
  const currentCfg = await store.readConfig(streamerRec.id);
  const pauseBranch = currentCfg.branches.find((b) => b.slug === 'pause');
  if (pauseBranch && pauseBranch.mode === 'loop' && (!pauseBranch.loopFile || pauseBranch.loopFile === 'pause.opus')) {
    pauseBranch.loopFile = '/assets/aistudio/Plb__oldPlay_TheScientist_d9c642af.flac';
    await store.writeConfig(streamerRec.id, currentCfg);
  }
  await store.readQueue(streamerRec.id);

  // Seed uploaded lossless FLAC tracks (also upgrades old demo placeholder tracks if present)
  await store.mutatePlaylist(streamerRec.id, (pl) => {
    const hasOnlyDemoPlaceholders =
      pl.tracks.length === 0 || pl.tracks.every((t) => t.id.startsWith('trk_demo_'));
    if (hasOnlyDemoPlaceholders) {
      pl.tracks = [
        {
          id: 'trk_flac_britney',
          artist: 'Britney Spears',
          title: '...Baby One More Time',
          source: 'file',
          pathOrUrl: '/assets/aistudio/Plb_BritnieSpirs_BabyOneMoreTime_0dfdb119.flac',
          durationMs: 224_634,
        },
        {
          id: 'trk_flac_sia',
          artist: 'Sia',
          title: 'Cheap Thrills',
          source: 'file',
          pathOrUrl: '/assets/aistudio/Plb_Sia_Cheap_f63fcf96.flac',
          durationMs: 217_000,
        },
        {
          id: 'trk_flac_coldplay_viva',
          artist: 'Coldplay',
          title: 'Viva La Vida',
          source: 'file',
          pathOrUrl: '/assets/aistudio/Plb__oldPlay_VivaLaVida_76818cde.flac',
          durationMs: 254_291,
        },
        {
          id: 'trk_flac_rihanna',
          artist: 'Rihanna',
          title: 'We Found Love',
          source: 'file',
          pathOrUrl: '/assets/aistudio/Plb_Rihana_WeFoundLove_329d8fef.flac',
          durationMs: 214_750,
        },
        {
          id: 'trk_flac_coldplay_scientist',
          artist: 'Coldplay',
          title: 'The Scientist',
          source: 'file',
          pathOrUrl: '/assets/aistudio/Plb__oldPlay_TheScientist_d9c642af.flac',
          durationMs: 314_547,
        },
      ];
      pl.position = { trackIndex: 0, offsetMs: 0 };
    }
  });
}

async function startServer(): Promise<void> {
  await store.init();
  await bootstrapPreviewWorkspace();

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  // Mandatory COOP/COEP headers on OBS Web Player pages for SharedArrayBuffer + AudioWorklet
  app.use('/player', (_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // Health & status
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, transport: 'websocket+webtransport-ready', ts: Date.now() });
  });

  // First-run admin claim status
  app.get('/api/auth/setup-status', async (_req, res) => {
    const usersFile = await store.readUsers();
    const hasAdmin = usersFile.users.some((u) => u.role === 'admin');
    const envConfigured = hasEnvAdminPassword();
    res.json({
      authDisabled: !REQUIRE_AUTH,
      needsAdminSetup: REQUIRE_AUTH && !hasAdmin && !envConfigured,
      envAdminConfigured: envConfigured,
      streamerSlugs: usersFile.users.filter((u) => u.role === 'streamer').map((u) => u.username),
    });
  });

  // Frictionless preview session when REQUIRE_AUTH is disabled
  app.post('/api/auth/preview-session', async (_req, res) => {
    if (REQUIRE_AUTH) {
      res.status(403).json({ error: 'Authentication is required' });
      return;
    }
    const usersFile = await store.readUsers();
    const adminUser = usersFile.users.find((u) => u.role === 'admin');
    if (!adminUser) {
      res.status(500).json({ error: 'Preview workspace unavailable' });
      return;
    }
    const token = signAuthToken(adminUser);
    res.json({
      token,
      user: { id: adminUser.id, username: adminUser.username, role: adminUser.role },
    });
  });

  // One-time admin claim route (locked once claimed or when ADMIN_PASSWORD env var is configured)
  app.post('/api/auth/setup-admin', async (req, res) => {
    if (hasEnvAdminPassword()) {
      res.status(403).json({ error: 'Admin password is managed by ADMIN_PASSWORD environment variable' });
      return;
    }

    const body = req.body as {
      adminPassword?: string;
      initialStreamerUsername?: string;
      initialStreamerPassword?: string;
    };
    if (!body?.adminPassword || typeof body.adminPassword !== 'string' || body.adminPassword.length < 8) {
      res.status(400).json({ error: 'Пароль администратора должен быть не короче 8 символов' });
      return;
    }

    const adminHash = await hashPassword(body.adminPassword);
    let streamerHash: string | null = null;
    let streamerName: string | null = null;

    if (body.initialStreamerUsername && body.initialStreamerPassword) {
      const parsedStreamer = CreateUserInputSchema.safeParse({
        username: body.initialStreamerUsername,
        password: body.initialStreamerPassword,
        role: 'streamer',
      });
      if (!parsedStreamer.success) {
        res.status(400).json({ error: 'Некорректный логин или пароль стримера (мин. 8 символов)' });
        return;
      }
      streamerName = parsedStreamer.data.username;
      streamerHash = await hashPassword(parsedStreamer.data.password);
    }

    try {
      const result = await store.mutateUsers((file) => {
        if (file.users.some((u) => u.role === 'admin')) {
          throw new Error('ALREADY_CLAIMED');
        }
        const adminRec = {
          id: `usr_admin_${crypto.randomBytes(4).toString('hex')}`,
          username: 'admin',
          passwordHash: adminHash,
          role: 'admin' as const,
          createdAt: new Date().toISOString(),
        };
        file.users.push(adminRec);

        let streamerRec = null;
        if (streamerName && streamerHash && streamerName !== 'admin') {
          streamerRec = {
            id: `usr_${crypto.randomBytes(6).toString('hex')}`,
            username: streamerName,
            passwordHash: streamerHash,
            role: 'streamer' as const,
            createdAt: new Date().toISOString(),
          };
          file.users.push(streamerRec);
        }
        return { adminRec, streamerRec };
      });

      await store.ensureUserDirectory(result.adminRec.id);
      if (result.streamerRec) {
        await store.ensureUserDirectory(result.streamerRec.id);
      }

      const token = signAuthToken(result.adminRec);
      logEvent('info', 'admin_claimed', { hasInitialStreamer: Boolean(result.streamerRec) });
      res.status(201).json({
        token,
        user: { id: result.adminRec.id, username: result.adminRec.username, role: result.adminRec.role },
        createdStreamer: result.streamerRec ? result.streamerRec.username : null,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'ALREADY_CLAIMED') {
        res.status(403).json({ error: 'Admin account has already been initialized' });
        return;
      }
      res.status(500).json({ error: 'Initialization error' });
    }
  });

  // Login
  app.post('/api/auth/login', async (req, res) => {
    const parsed = LoginInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Введите логин и пароль' });
      return;
    }

    const username = parsed.data.username.toLowerCase();

    // If ADMIN_PASSWORD env var is set, allow logging in as `admin` directly
    if (username === 'admin' && hasEnvAdminPassword()) {
      if (!verifyEnvAdminPassword(parsed.data.password)) {
        res.status(401).json({ error: 'Неверный логин или пароль' });
        return;
      }
      const adminUser = await store.mutateUsers(async (file) => {
        let existing = file.users.find((u) => u.username === 'admin');
        if (!existing) {
          existing = {
            id: `usr_admin_${crypto.randomBytes(4).toString('hex')}`,
            username: 'admin',
            passwordHash: await hashPassword(crypto.randomBytes(24).toString('hex')),
            role: 'admin',
            createdAt: new Date().toISOString(),
          };
          file.users.push(existing);
        }
        return existing;
      });
      await store.ensureUserDirectory(adminUser.id);
      const token = signAuthToken(adminUser);
      res.json({ token, user: { id: adminUser.id, username: adminUser.username, role: adminUser.role } });
      return;
    }

    const usersFile = await store.readUsers();
    const user = usersFile.users.find((u) => u.username === username);
    if (!user) {
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }

    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Неверный логин или пароль' });
      return;
    }

    const token = signAuthToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ id: req.auth!.sub, username: req.auth!.username, role: req.auth!.role });
  });

  // Admin routes
  app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
    const usersFile = await store.readUsers();
    const summaries: StreamerAdminSummary[] = await Promise.all(
      usersFile.users.map(async (u) => {
        const eng = engines.get(u.id);
        const status = eng?.getAdminSummary() ?? { online: false, mode: 'PLAYLIST', activeBranches: [], listenerCount: 0 };
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
    res.json({ users: summaries });
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const parsed = CreateUserInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Некорректные данные (логин a-z0-9_-, пароль ≥ 8 симв.)', details: parsed.error.flatten() });
      return;
    }
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const created = await store.mutateUsers((file) => {
        if (file.users.some((u) => u.username === parsed.data.username)) {
          throw new Error('USERNAME_TAKEN');
        }
        const rec = {
          id: `usr_${crypto.randomBytes(6).toString('hex')}`,
          username: parsed.data.username,
          passwordHash,
          role: parsed.data.role,
          createdAt: new Date().toISOString(),
        };
        file.users.push(rec);
        return rec;
      });
      await store.ensureUserDirectory(created.id);
      await store.readConfig(created.id);
      await store.readPlaylist(created.id);
      await store.readQueue(created.id);
      res.status(201).json({
        user: { id: created.id, username: created.username, role: created.role, createdAt: created.createdAt },
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
        res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
        return;
      }
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const parsed = ResetPasswordInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
      return;
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const updated = await store.mutateUsers((file) => {
      const target = file.users.find((u) => u.id === req.params.id);
      if (!target) return false;
      target.passwordHash = passwordHash;
      return true;
    });
    if (!updated) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }
    res.json({ ok: true });
  });

  // Public player config
  app.get('/api/public/:userSlug/config', async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug || ''));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const cfg = await store.readConfig(target.userId);
    const pub: PublicPlayerConfig = {
      userSlug: String(req.params.userSlug),
      branches: cfg.branches.map(({ id, name, slug, isMain, mode }) => ({ id, name, slug, isMain, mode })),
      obsSceneMapping: cfg.obsSceneMapping,
      obsWsUrl: cfg.obsWsUrl || 'ws://127.0.0.1:4455',
      hasObsPassword: Boolean(cfg.obsWsPassword),
      audio: cfg.audio,
    };
    res.json(pub);
  });

  // Public order creation & chat-bot webhook
  app.post('/api/:userSlug/orders', enqueueOrderHandler);
  app.post('/webhook/:userSlug/order', enqueueOrderHandler);

  // Public order queue read (for /order/:userSlug)
  app.get('/api/:userSlug/orders', async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug || ''));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const [queue, playback] = await Promise.all([
      store.readQueue(target.userId),
      target.engine.getSnapshot(),
    ]);
    res.json({ orders: queue.orders, playback });
  });

  // Protected tenant config
  app.get('/api/:userSlug/config', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    res.json(await store.readConfig(target.userId));
  });

  app.put('/api/:userSlug/config', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const parsed = UserConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config', details: parsed.error.flatten() });
      return;
    }
    const saved = await store.writeConfig(target.userId, parsed.data);
    await target.engine.onConfigUpdated();
    await target.engine.broadcastEvent('config:updated', saved);
    res.json(saved);
  });

  // Protected playback controls
  app.get('/api/:userSlug/playback', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    res.json(await target.engine.getSnapshot());
  });

  app.post('/api/:userSlug/playback/mode', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const mode = req.body?.mode;
    if (mode !== 'LIVE' && mode !== 'PLAYLIST' && mode !== 'ORDER') {
      res.status(400).json({ error: 'Invalid mode' });
      return;
    }
    await target.engine.setMode(mode);
    res.json(await target.engine.getSnapshot());
  });

  app.post('/api/:userSlug/playback/finish-current', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    await target.engine.finishCurrentTrackNow();
    res.json(await target.engine.getSnapshot());
  });

  app.post('/api/:userSlug/playback/play-track', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const trackIndex = Number(req.body?.trackIndex);
    const offsetMs = Number(req.body?.offsetMs ?? 0);
    if (!Number.isFinite(trackIndex) || trackIndex < 0) {
      res.status(400).json({ error: 'Invalid trackIndex' });
      return;
    }
    await target.engine.playTrackAt(trackIndex, Number.isFinite(offsetMs) ? offsetMs : 0);
    res.json(await target.engine.getSnapshot());
  });

  app.post('/api/:userSlug/obs/scene', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const sceneName = typeof req.body?.sceneName === 'string' ? req.body.sceneName.trim() : '';
    if (!sceneName) {
      res.status(400).json({ error: 'sceneName is required' });
      return;
    }
    await target.engine.setVirtualObsScene(sceneName);
    res.json({ ok: true, sceneName });
  });

  // Protected playlist routes
  app.get('/api/:userSlug/playlist', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    res.json(await store.readPlaylist(target.userId));
  });

  app.post('/api/:userSlug/playlist', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const parsed = AddTrackInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid track data', details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.source === 'url' || parsed.data.source === 'yt') {
      try {
        assertSafeExternalUrl(parsed.data.pathOrUrl);
      } catch (err: unknown) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Blocked URL' });
        return;
      }
    }
    const track = { id: `trk_${crypto.randomBytes(5).toString('hex')}`, ...parsed.data };
    const updated = await store.mutatePlaylist(target.userId, (pl) => {
      pl.tracks.push(track);
      return pl;
    });
    await target.engine.broadcastEvent('playlist:updated', updated);
    res.status(201).json({ track, playlist: updated });
  });

  app.patch('/api/:userSlug/playlist', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const parsed = UpdatePlaylistSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid playlist update' });
      return;
    }
    const updated = await store.mutatePlaylist(target.userId, (pl) => {
      if (parsed.data.mode) pl.mode = parsed.data.mode;
      if (parsed.data.position) pl.position = parsed.data.position;
      if (parsed.data.trackIds) {
        const byId = new Map(pl.tracks.map((t) => [t.id, t]));
        const ordered = parsed.data.trackIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
        const rest = pl.tracks.filter((t) => !parsed.data.trackIds!.includes(t.id));
        pl.tracks = [...ordered, ...rest];
      }
      return pl;
    });
    await target.engine.broadcastEvent('playlist:updated', updated);
    res.json(updated);
  });

  app.delete('/api/:userSlug/playlist/:trackId', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const updated = await store.mutatePlaylist(target.userId, (pl) => {
      pl.tracks = pl.tracks.filter((t) => t.id !== req.params.trackId);
      if (pl.position.trackIndex >= pl.tracks.length) {
        pl.position = { trackIndex: 0, offsetMs: 0 };
      }
      return pl;
    });
    await target.engine.broadcastEvent('playlist:updated', updated);
    res.json(updated);
  });

  // Protected order queue mutations
  app.patch('/api/:userSlug/orders/reorder', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const parsed = ReorderOrdersInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid orderIds array' });
      return;
    }
    const queue = await store.mutateQueue(target.userId, (q) => {
      const byId = new Map(q.orders.map((o) => [o.id, o]));
      const reordered = parsed.data.orderIds.map((id) => byId.get(id)).filter((o): o is Order => Boolean(o));
      const rest = q.orders.filter((o) => !parsed.data.orderIds.includes(o.id));
      q.orders = [...reordered, ...rest];
      return q;
    });
    await target.engine.broadcastQueueUpdate();
    res.json({ orders: queue.orders });
  });

  app.delete('/api/:userSlug/orders/:orderId', requireAuth, requireTenantAccess, async (req, res) => {
    const target = await getEngineBySlug(String(req.params.userSlug));
    if (!target) {
      res.status(404).json({ error: 'Streamer not found' });
      return;
    }
    const queue = await store.mutateQueue(target.userId, (q) => {
      q.orders = q.orders.filter((o) => o.id !== req.params.orderId);
      return q;
    });
    await target.engine.broadcastQueueUpdate();
    res.json({ orders: queue.orders });
  });

  // Read-only Monorepo Blueprint viewer endpoints (strictly confined to streamer-radio/)
  app.get('/api/blueprint/tree', async (_req, res) => {
    const files = await collectBlueprintFiles(MONOREPO_ROOT);
    res.json({ root: 'streamer-radio', files });
  });

  app.get('/api/blueprint/file', async (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath || relPath.includes('\0')) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }
    const resolved = path.resolve(MONOREPO_ROOT, relPath);
    if (!resolved.startsWith(MONOREPO_ROOT + path.sep)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    try {
      const content = await fs.readFile(resolved, 'utf8');
      res.json({ path: relPath, content });
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // Serve Vite middlewares in dev, or built dist/ in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    const ingestMatch = pathname.match(/^\/ingest\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);
    const streamMatch = pathname.match(/^\/stream\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);
    const eventsMatch = pathname.match(/^\/ws\/events\/([a-z0-9_-]+)$/);

    if (!ingestMatch && !streamMatch && !eventsMatch) {
      socket.destroy();
      return;
    }

    if (ingestMatch) {
      const [, userSlug, branchSlug] = ingestMatch;
      const authHeader = req.headers.authorization;
      const token =
        (authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null) ||
        url.searchParams.get('token');
      const auth = token ? verifyAuthToken(token) : null;
      if (!auth || (auth.role !== 'admin' && auth.username !== userSlug)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const target = await getEngineBySlug(userSlug);
      if (!target) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        void target.engine.onIngestConnected(branchSlug);
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            const buf = Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
            void target.engine.handleIngestFrame(branchSlug, buf);
          } else {
            try {
              const msg = JSON.parse(String(data));
              if (msg.type === 'ping' && typeof msg.clientTimeMs === 'number') {
                ws.send(JSON.stringify({ type: 'pong', clientTimeMs: msg.clientTimeMs, serverTimeMs: Date.now() }));
              } else if (msg.type === 'stream_meta' && (msg.codec === 'opus' || msg.codec === 'pcm16')) {
                target.engine.setBranchCodec(branchSlug, msg.codec);
              }
            } catch {
              // ignore
            }
          }
        });
        ws.on('close', () => {
          void target.engine.onIngestDisconnected(branchSlug);
        });
      });
      return;
    }

    if (streamMatch) {
      const [, userSlug, branchSlug] = streamMatch;
      const target = await getEngineBySlug(userSlug);
      if (!target) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const subId = `sub_${crypto.randomBytes(6).toString('hex')}`;
        target.engine.addAudioSubscriber(branchSlug, {
          id: subId,
          sendBinary: (packet) => {
            if (ws.readyState === ws.OPEN) ws.send(packet, { binary: true });
          },
          sendText: (json) => {
            if (ws.readyState === ws.OPEN) ws.send(json);
          },
        });
        ws.on('message', (data, isBinary) => {
          if (!isBinary) {
            try {
              const msg = JSON.parse(String(data));
              if (msg.type === 'ping' && typeof msg.clientTimeMs === 'number') {
                ws.send(JSON.stringify({ type: 'pong', clientTimeMs: msg.clientTimeMs, serverTimeMs: Date.now() }));
              }
            } catch {
              // ignore
            }
          }
        });
        ws.on('close', () => {
          target.engine.removeAudioSubscriber(branchSlug, subId);
        });
      });
      return;
    }

    if (eventsMatch) {
      const [, userSlug] = eventsMatch;
      const target = await getEngineBySlug(userSlug);
      if (!target) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const subId = `evt_${crypto.randomBytes(6).toString('hex')}`;
        target.engine.addEventSubscriber({
          id: subId,
          sendText: (json) => {
            if (ws.readyState === ws.OPEN) ws.send(json);
          },
        });
        ws.on('close', () => {
          target.engine.removeEventSubscriber(subId);
        });
      });
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    logEvent('info', 'server_started', { port: PORT, dataDir: DATA_DIR });
  });

  const cleanup = () => {
    for (const eng of engines.values()) {
      eng.shutdown();
    }
    process.exit(0);
  };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
}

void startServer();
