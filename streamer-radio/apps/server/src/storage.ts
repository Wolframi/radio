import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PlaylistDataSchema,
  QueueDataSchema,
  SAFE_ID_REGEX,
  UserConfigSchema,
  UsersFileSchema,
  createDefaultPlaylist,
  createDefaultQueue,
  createDefaultUserConfig,
  type PlaylistData,
  type QueueData,
  type UserConfig,
  type UsersFile,
} from '@streamer-radio/shared';

/**
 * Atomic JSON storage with per-path async mutex locking and strict directory confinement.
 * Writes always go to `<target>.tmp.<pid>.<rand>` followed by POSIX atomic `fs.rename`.
 */
export class AtomicJsonStore {
  private readonly baseDir: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.baseDir = path.resolve(dataDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.baseDir, 'users'), { recursive: true });
    const usersPath = this.resolveSafe('users.json');
    try {
      await fs.access(usersPath);
    } catch {
      await this.writeJsonAtomic(usersPath, { schemaVersion: 1, users: [] } satisfies UsersFile);
    }
  }

  /**
   * Resolves a relative path inside baseDir and enforces strict path confinement.
   */
  resolveSafe(...segments: string[]): string {
    const resolved = path.resolve(this.baseDir, ...segments);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error('Path traversal attempt blocked');
    }
    return resolved;
  }

  private assertSafeUserId(userId: string): void {
    if (!SAFE_ID_REGEX.test(userId)) {
      throw new Error('Invalid userId format');
    }
  }

  private async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => next);
    this.locks.set(filePath, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(filePath) === chain) {
        this.locks.delete(filePath);
      }
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const payload = JSON.stringify(data, null, 2) + '\n';
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, filePath);
  }

  private async readJsonOrDefault<T>(filePath: string, fallback: () => T, parse: (raw: unknown) => T): Promise<T> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return parse(JSON.parse(content));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const def = fallback();
        await this.writeJsonAtomic(filePath, def);
        return def;
      }
      throw err;
    }
  }

  async ensureUserDirectory(userId: string): Promise<void> {
    this.assertSafeUserId(userId);
    const userDir = this.resolveSafe('users', userId);
    const cacheDir = this.resolveSafe('users', userId, 'cache');
    const mediaDir = this.resolveSafe('users', userId, 'media');
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });
  }

  getUserCacheDir(userId: string): string {
    this.assertSafeUserId(userId);
    return this.resolveSafe('users', userId, 'cache');
  }

  getUserMediaPath(userId: string, fileName: string): string {
    this.assertSafeUserId(userId);
    const safeName = path.basename(fileName);
    if (!safeName || safeName === '.' || safeName === '..') {
      throw new Error('Invalid media filename');
    }
    return this.resolveSafe('users', userId, 'media', safeName);
  }

  async readUsers(): Promise<UsersFile> {
    const filePath = this.resolveSafe('users.json');
    return this.withLock(filePath, () =>
      this.readJsonOrDefault<UsersFile>(
        filePath,
        () => ({ schemaVersion: 1, users: [] }),
        (raw) => UsersFileSchema.parse(raw),
      ),
    );
  }

  async mutateUsers<T>(mutator: (file: UsersFile) => Promise<T> | T): Promise<T> {
    const filePath = this.resolveSafe('users.json');
    return this.withLock(filePath, async () => {
      const data = await this.readJsonOrDefault<UsersFile>(
        filePath,
        () => ({ schemaVersion: 1, users: [] }),
        (raw) => UsersFileSchema.parse(raw),
      );
      const result = await mutator(data);
      await this.writeJsonAtomic(filePath, UsersFileSchema.parse(data));
      return result;
    });
  }

  async readConfig(userId: string): Promise<UserConfig> {
    this.assertSafeUserId(userId);
    const filePath = this.resolveSafe('users', userId, 'config.json');
    return this.withLock(filePath, () =>
      this.readJsonOrDefault(filePath, createDefaultUserConfig, (raw) => UserConfigSchema.parse(raw)),
    );
  }

  async writeConfig(userId: string, config: UserConfig): Promise<UserConfig> {
    this.assertSafeUserId(userId);
    const validated = UserConfigSchema.parse(config);
    const filePath = this.resolveSafe('users', userId, 'config.json');
    return this.withLock(filePath, async () => {
      await this.writeJsonAtomic(filePath, validated);
      return validated;
    });
  }

  async readPlaylist(userId: string): Promise<PlaylistData> {
    this.assertSafeUserId(userId);
    const filePath = this.resolveSafe('users', userId, 'playlist.json');
    return this.withLock(filePath, () =>
      this.readJsonOrDefault(filePath, createDefaultPlaylist, (raw) => PlaylistDataSchema.parse(raw)),
    );
  }

  async mutatePlaylist<T>(userId: string, mutator: (pl: PlaylistData) => Promise<T> | T): Promise<T> {
    this.assertSafeUserId(userId);
    const filePath = this.resolveSafe('users', userId, 'playlist.json');
    return this.withLock(filePath, async () => {
      const data = await this.readJsonOrDefault(filePath, createDefaultPlaylist, (raw) => PlaylistDataSchema.parse(raw));
      const result = await mutator(data);
      await this.writeJsonAtomic(filePath, PlaylistDataSchema.parse(data));
      return result;
    });
  }

  async readQueue(userId: string): Promise<QueueData> {
    this.assertSafeUserId(userId);
    const filePath = this.resolveSafe('users', userId, 'queue.json');
    return this.withLock(filePath, () =>
      this.readJsonOrDefault(filePath, createDefaultQueue, (raw) => QueueDataSchema.parse(raw)),
    );
  }

  async mutateQueue<T>(userId: string, mutator: (q: QueueData) => Promise<T> | T): Promise<T> {
    this.assertSafeUserId(userId);
    const filePath = this.resolveSafe('users', userId, 'queue.json');
    return this.withLock(filePath, async () => {
      const data = await this.readJsonOrDefault(filePath, createDefaultQueue, (raw) => QueueDataSchema.parse(raw));
      const result = await mutator(data);
      await this.writeJsonAtomic(filePath, QueueDataSchema.parse(data));
      return result;
    });
  }
}
