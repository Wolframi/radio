import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { encodeAudioFrame } from '../shared/protocol';
import type {
  Order,
  PlaybackMode,
  PlaybackStateSnapshot,
  PlaylistData,
  PlaylistTrack,
} from '../shared/schemas';
import { assertSafeExternalUrl } from './orders';
import type { AtomicJsonStore } from './storage';

export interface BinarySubscriber {
  id: string;
  sendBinary: (packet: Uint8Array) => void;
  sendText: (json: string) => void;
}

export interface EventSubscriber {
  id: string;
  sendText: (json: string) => void;
}

interface ActivePump {
  kind: 'ffmpeg' | 'tone';
  sourceKey: string;
  child?: ChildProcess;
  timer?: ReturnType<typeof setInterval>;
}

const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');
const FRAME_BYTES_20MS_48K_STEREO = 960 * 2 * 2; // 3840 bytes = 20 ms @ 48 kHz stereo PCM16

/**
 * Authoritative multi-tenant playback engine for a single streamer.
 * Enforces:
 * - Isolated branches per user
 * - Real-time ffmpeg PCM16 48 kHz stereo decoding for FLAC/Opus/MP3/URL sources
 * - Main branch state machine: LIVE | PLAYLIST | ORDER
 * - Orders NEVER interrupt the currently playing track
 * - Exact or Next playlist resumption after order queue empties
 * - On-demand ffmpeg lifecycle (only decodes while >= 1 listener is connected to a branch)
 */
export class TenantPlaybackEngine {
  private mode: PlaybackMode = 'PLAYLIST';
  private liveIngests = new Set<string>();
  private subscribers = new Map<string, Map<string, BinarySubscriber>>();
  private eventSubscribers = new Map<string, EventSubscriber>();
  private branchCodec = new Map<string, 'opus' | 'pcm16'>();
  private branchSeq = new Map<string, number>();
  private activePumps = new Map<string, ActivePump>();

  private currentOrderId: string | null = null;
  private currentOrder: Order | null = null;
  private currentTrack: PlaylistTrack | null = null;
  private trackStartedAtMs = 0;
  private trackBaseOffsetMs = 0;
  private trackDurationMs = 0;
  private isPlaying = false;
  private initialized = false;
  private currentVirtualObsScene: string | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private phase = 0;

  constructor(
    public readonly userId: string,
    public readonly userSlug: string,
    private readonly store: AtomicJsonStore,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.mode === 'PLAYLIST' && !this.isPlaying) {
      await this.startPlaylistFromSavedPosition();
      await this.broadcastState();
    }
  }

  shutdown(): void {
    this.stopProgressTimer();
    for (const slug of Array.from(this.activePumps.keys())) {
      this.stopBranchPump(slug);
    }
  }

  private nextSeq(branchSlug: string): number {
    const next = ((this.branchSeq.get(branchSlug) ?? 0) + 1) >>> 0;
    this.branchSeq.set(branchSlug, next);
    return next;
  }

  private getCurrentElapsedMs(): number {
    if (!this.isPlaying) return this.trackBaseOffsetMs;
    const raw = this.trackBaseOffsetMs + (Date.now() - this.trackStartedAtMs);
    return Math.max(0, Math.min(this.trackDurationMs || raw, Math.round(raw)));
  }

  async getSnapshot(): Promise<PlaybackStateSnapshot> {
    const playlist = await this.store.readPlaylist(this.userId);
    const subscriberCounts: Record<string, number> = {};
    for (const [slug, map] of this.subscribers.entries()) {
      subscriberCounts[slug] = map.size;
    }

    const elapsed = this.isPlaying ? this.getCurrentElapsedMs() : playlist.position.offsetMs;

    return {
      userSlug: this.userSlug,
      mode: this.mode,
      liveConnectedBranches: Array.from(this.liveIngests),
      subscriberCounts,
      playlistPosition: playlist.position,
      currentTrack: this.mode === 'PLAYLIST' ? this.currentTrack : null,
      currentOrderId: this.currentOrderId,
      currentOrder: this.currentOrder,
      trackElapsedMs: Math.max(0, Math.round(elapsed)),
      trackDurationMs: this.trackDurationMs,
      isPlaying: this.mode === 'LIVE' ? this.liveIngests.size > 0 : this.isPlaying,
      updatedAt: Date.now(),
    };
  }

  getAdminSummary(): { online: boolean; mode: PlaybackMode; activeBranches: string[]; listenerCount: number } {
    let listenerCount = 0;
    for (const map of this.subscribers.values()) {
      listenerCount += map.size;
    }
    return {
      online: this.liveIngests.size > 0 || this.eventSubscribers.size > 0 || listenerCount > 0,
      mode: this.mode,
      activeBranches: Array.from(this.liveIngests),
      listenerCount,
    };
  }

  addEventSubscriber(sub: EventSubscriber): void {
    this.eventSubscribers.set(sub.id, sub);
    void this.sendFullSync(sub);
  }

  removeEventSubscriber(id: string): void {
    this.eventSubscribers.delete(id);
  }

  async broadcastEvent(event: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify({ event, data: payload, ts: Date.now() });
    for (const sub of this.eventSubscribers.values()) {
      try {
        sub.sendText(serialized);
      } catch {
        this.eventSubscribers.delete(sub.id);
      }
    }
  }

  private async sendFullSync(sub: EventSubscriber): Promise<void> {
    await this.ensureStarted();
    const [state, queue, playlist, config] = await Promise.all([
      this.getSnapshot(),
      this.store.readQueue(this.userId),
      this.store.readPlaylist(this.userId),
      this.store.readConfig(this.userId),
    ]);
    sub.sendText(
      JSON.stringify({
        event: 'sync',
        data: {
          state,
          queue: queue.orders,
          playlist,
          config,
          virtualObsScene: this.currentVirtualObsScene,
        },
        ts: Date.now(),
      }),
    );
  }

  async broadcastState(): Promise<void> {
    await this.broadcastEvent('playback:state', await this.getSnapshot());
  }

  async broadcastQueueUpdate(): Promise<void> {
    const queue = await this.store.readQueue(this.userId);
    await this.broadcastEvent('queue:updated', queue.orders);
  }

  async setVirtualObsScene(sceneName: string): Promise<void> {
    this.currentVirtualObsScene = sceneName;
    await this.broadcastEvent('obs:scene', { sceneName });
  }

  async onConfigUpdated(): Promise<void> {
    for (const slug of this.subscribers.keys()) {
      await this.syncBranchPump(slug, true);
    }
  }

  addAudioSubscriber(branchSlug: string, sub: BinarySubscriber): void {
    let map = this.subscribers.get(branchSlug);
    if (!map) {
      map = new Map();
      this.subscribers.set(branchSlug, map);
    }
    map.set(sub.id, sub);

    const codec = this.branchCodec.get(branchSlug) ?? 'pcm16';
    try {
      sub.sendText(
        JSON.stringify({
          type: 'stream_meta',
          codec,
          sampleRate: 48000,
          channels: 2,
          frameMs: 20,
          bitrateKbps: 64,
          branchSlug,
        }),
      );
    } catch {
      // ignore
    }

    void this.ensureStarted().then(() => this.syncBranchPump(branchSlug, false));
    void this.broadcastState();
  }

  removeAudioSubscriber(branchSlug: string, id: string): void {
    const map = this.subscribers.get(branchSlug);
    if (!map) return;
    map.delete(id);
    if (map.size === 0) {
      this.subscribers.delete(branchSlug);
      this.stopBranchPump(branchSlug);
    }
    void this.broadcastState();
  }

  setBranchCodec(branchSlug: string, codec: 'opus' | 'pcm16'): void {
    this.branchCodec.set(branchSlug, codec);
    const subs = this.subscribers.get(branchSlug);
    if (!subs) return;
    const msg = JSON.stringify({
      type: 'stream_meta',
      codec,
      sampleRate: 48000,
      channels: 2,
      frameMs: 20,
      bitrateKbps: 64,
      branchSlug,
    });
    for (const sub of subs.values()) {
      try {
        sub.sendText(msg);
      } catch {
        // ignore
      }
    }
  }

  private fanoutBinary(branchSlug: string, packet: Uint8Array): void {
    const subs = this.subscribers.get(branchSlug);
    if (!subs || subs.size === 0) return;
    for (const sub of subs.values()) {
      try {
        sub.sendBinary(packet);
      } catch {
        subs.delete(sub.id);
      }
    }
  }

  async onIngestConnected(branchSlug: string): Promise<void> {
    this.liveIngests.add(branchSlug);
    const cfg = await this.store.readConfig(this.userId);
    const main = cfg.branches.find((b) => b.isMain);
    if (main && main.slug === branchSlug) {
      await this.setMode('LIVE');
    } else {
      await this.broadcastState();
    }
  }

  async onIngestDisconnected(branchSlug: string): Promise<void> {
    this.liveIngests.delete(branchSlug);
    const cfg = await this.store.readConfig(this.userId);
    const main = cfg.branches.find((b) => b.isMain);
    if (main && main.slug === branchSlug && this.mode === 'LIVE') {
      await this.setMode('PLAYLIST');
    } else {
      await this.broadcastState();
    }
  }

  async handleIngestFrame(branchSlug: string, packet: Uint8Array): Promise<void> {
    const cfg = await this.store.readConfig(this.userId);
    const branch = cfg.branches.find((b) => b.slug === branchSlug);
    if (!branch) return;

    if (branch.isMain) {
      if (this.mode === 'LIVE') {
        this.fanoutBinary(branchSlug, packet);
      }
      return;
    }

    if (branch.mode === 'passthrough') {
      this.fanoutBinary(branchSlug, packet);
    }
  }

  async setMode(nextMode: PlaybackMode): Promise<void> {
    if (this.mode === nextMode && (nextMode === 'LIVE' || this.isPlaying)) {
      await this.broadcastState();
      return;
    }

    if (this.mode === 'PLAYLIST' && this.isPlaying) {
      await this.persistPlaylistOffset();
    }

    this.stopProgressTimer();
    await this.stopMainBranchPump();
    this.mode = nextMode;

    if (nextMode === 'LIVE') {
      this.currentOrderId = null;
      this.currentOrder = null;
      this.isPlaying = false;
      await this.broadcastState();
      return;
    }

    if (nextMode === 'ORDER') {
      const started = await this.tryStartNextOrder();
      if (!started) {
        this.mode = 'PLAYLIST';
        await this.startPlaylistFromSavedPosition();
      }
      await this.broadcastState();
      return;
    }

    await this.startPlaylistFromSavedPosition();
    await this.broadcastState();
  }

  async playTrackAt(trackIndex: number, offsetMs = 0): Promise<void> {
    const pl = await this.store.readPlaylist(this.userId);
    if (pl.tracks.length === 0) return;
    const clampedIndex = Math.max(0, Math.min(pl.tracks.length - 1, Math.floor(trackIndex)));
    const targetTrack = pl.tracks[clampedIndex];
    const clampedOffset = Math.max(0, Math.min(Math.max(0, targetTrack.durationMs - 1000), Math.floor(offsetMs)));

    await this.store.mutatePlaylist(this.userId, (data) => {
      data.position = { trackIndex: clampedIndex, offsetMs: clampedOffset };
    });

    this.stopProgressTimer();
    await this.stopMainBranchPump();
    this.mode = 'PLAYLIST';
    this.currentOrderId = null;
    this.currentOrder = null;
    await this.startPlaylistFromSavedPosition(true);
    await this.broadcastEvent('playlist:updated', await this.store.readPlaylist(this.userId));
    await this.broadcastState();
  }

  async finishCurrentTrackNow(): Promise<void> {
    await this.onCurrentItemFinished();
  }

  private stopProgressTimer(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.isPlaying = false;
  }

  private async stopMainBranchPump(): Promise<void> {
    const cfg = await this.store.readConfig(this.userId);
    const main = cfg.branches.find((b) => b.isMain);
    if (main) {
      this.stopBranchPump(main.slug);
    }
  }

  private stopBranchPump(branchSlug: string): void {
    const pump = this.activePumps.get(branchSlug);
    if (!pump) return;
    this.activePumps.delete(branchSlug);
    if (pump.timer) {
      clearInterval(pump.timer);
    }
    if (pump.child && !pump.child.killed) {
      try {
        pump.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  private async persistPlaylistOffset(): Promise<void> {
    if (!this.currentTrack || this.trackStartedAtMs <= 0) return;
    const elapsed = this.getCurrentElapsedMs();
    await this.store.mutatePlaylist(this.userId, (pl) => {
      pl.position.offsetMs = elapsed;
    });
  }

  private async startPlaylistFromSavedPosition(forceExactOffset = false): Promise<void> {
    const [cfg, pl] = await Promise.all([
      this.store.readConfig(this.userId),
      this.store.readPlaylist(this.userId),
    ]);

    if (pl.tracks.length === 0) {
      this.currentTrack = null;
      this.isPlaying = false;
      await this.stopMainBranchPump();
      return;
    }

    const idx = Math.min(pl.position.trackIndex, pl.tracks.length - 1);
    const track = pl.tracks[idx];
    const startOffset =
      forceExactOffset || cfg.playlistResumeMode === 'exact'
        ? Math.min(pl.position.offsetMs, Math.max(0, track.durationMs - 1000))
        : 0;

    this.currentTrack = track;
    this.currentOrderId = null;
    this.currentOrder = null;
    this.trackBaseOffsetMs = startOffset;
    this.trackDurationMs = track.durationMs;
    this.trackStartedAtMs = Date.now();
    this.isPlaying = true;

    const main = cfg.branches.find((b) => b.isMain);
    if (main) {
      await this.syncBranchPump(main.slug, true);
    }
    this.startProgressTimer();
  }

  private async tryStartNextOrder(): Promise<boolean> {
    const cfg = await this.store.readConfig(this.userId);
    const nextOrder = await this.store.mutateQueue(this.userId, (q) => {
      const candidate = q.orders.find((o) => o.status === 'ready');
      if (!candidate) return null;
      candidate.status = 'playing';
      return { ...candidate };
    });

    if (!nextOrder) return false;

    this.mode = 'ORDER';
    this.currentOrderId = nextOrder.id;
    this.currentOrder = nextOrder;
    this.trackBaseOffsetMs = 0;
    this.trackDurationMs = nextOrder.durationMs ?? 30_000;
    this.trackStartedAtMs = Date.now();
    this.isPlaying = true;

    const main = cfg.branches.find((b) => b.isMain);
    if (main) {
      await this.syncBranchPump(main.slug, true);
    }

    await this.broadcastQueueUpdate();
    this.startProgressTimer();
    return true;
  }

  /**
   * Non-interrupting transition boundary:
   * Only invoked when the current track or order completes.
   */
  private async onCurrentItemFinished(): Promise<void> {
    const prevMode = this.mode;
    const finishedOrderId = this.currentOrderId;
    this.stopProgressTimer();
    await this.stopMainBranchPump();

    if (prevMode === 'ORDER' && finishedOrderId) {
      await this.store.mutateQueue(this.userId, (q) => {
        q.orders = q.orders.filter((o) => o.id !== finishedOrderId);
      });
      await this.broadcastQueueUpdate();

      if (await this.tryStartNextOrder()) {
        await this.broadcastState();
        return;
      }

      const cfg = await this.store.readConfig(this.userId);
      if (cfg.playlistResumeMode === 'next') {
        await this.advancePlaylistIndex();
      }
      this.mode = 'PLAYLIST';
      await this.startPlaylistFromSavedPosition();
      await this.broadcastState();
      return;
    }

    if (prevMode === 'PLAYLIST') {
      const queue = await this.store.readQueue(this.userId);
      const hasReadyOrder = queue.orders.some((o) => o.status === 'ready');
      if (hasReadyOrder) {
        await this.advancePlaylistIndex();
        if (await this.tryStartNextOrder()) {
          await this.broadcastState();
          return;
        }
      } else {
        await this.advancePlaylistIndex();
      }

      await this.startPlaylistFromSavedPosition();
      await this.broadcastState();
    }
  }

  private async advancePlaylistIndex(): Promise<void> {
    await this.store.mutatePlaylist(this.userId, (pl: PlaylistData) => {
      if (pl.tracks.length === 0) {
        pl.position = { trackIndex: 0, offsetMs: 0 };
        return;
      }
      if (pl.mode === 'shuffle' && pl.tracks.length > 1) {
        let next = Math.floor(Math.random() * pl.tracks.length);
        if (next === pl.position.trackIndex) {
          next = (next + 1) % pl.tracks.length;
        }
        pl.position = { trackIndex: next, offsetMs: 0 };
      } else if (pl.mode === 'loop') {
        pl.position = { trackIndex: pl.position.trackIndex % pl.tracks.length, offsetMs: 0 };
      } else {
        pl.position = { trackIndex: (pl.position.trackIndex + 1) % pl.tracks.length, offsetMs: 0 };
      }
    });
  }

  private startProgressTimer(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.isPlaying) return;
      const elapsed = this.trackBaseOffsetMs + (Date.now() - this.trackStartedAtMs);
      if (this.mode === 'PLAYLIST') {
        void this.store.mutatePlaylist(this.userId, (pl) => {
          pl.position.offsetMs = Math.min(this.trackDurationMs || elapsed, Math.round(elapsed));
        });
      }
      if (this.trackDurationMs > 0 && elapsed >= this.trackDurationMs) {
        void this.onCurrentItemFinished();
      } else {
        void this.broadcastState();
      }
    }, 1000);
  }

  /**
   * Resolves local media paths safely inside public/ or tenant data/ directories,
   * or validates external http(s) URLs against SSRF before handing to ffmpeg.
   */
  private resolvePlayableSource(pathOrUrl: string | undefined): string | null {
    if (!pathOrUrl || pathOrUrl.includes('\0')) return null;

    if (pathOrUrl.startsWith('/assets/')) {
      const rel = pathOrUrl.slice(1);
      const resolved = path.resolve(PUBLIC_ROOT, rel);
      if (resolved.startsWith(PUBLIC_ROOT + path.sep) && fs.existsSync(resolved)) {
        return resolved;
      }
      return null;
    }

    if (pathOrUrl.startsWith('/media/')) {
      const rel = pathOrUrl.slice('/media/'.length);
      const mediaRoot = this.store.resolveSafe('users', this.userId, 'media');
      const resolved = path.resolve(mediaRoot, rel);
      if (resolved.startsWith(mediaRoot + path.sep) && fs.existsSync(resolved)) {
        return resolved;
      }
      return null;
    }

    if (path.isAbsolute(pathOrUrl)) {
      const cacheRoot = this.store.getUserCacheDir(this.userId);
      const mediaRoot = this.store.resolveSafe('users', this.userId, 'media');
      const resolved = path.resolve(pathOrUrl);
      const inAllowed =
        resolved.startsWith(cacheRoot + path.sep) ||
        resolved.startsWith(mediaRoot + path.sep) ||
        resolved.startsWith(PUBLIC_ROOT + path.sep);
      if (inAllowed && fs.existsSync(resolved)) {
        return resolved;
      }
      return null;
    }

    if (/^https?:\/\//i.test(pathOrUrl)) {
      try {
        assertSafeExternalUrl(pathOrUrl);
        return pathOrUrl;
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Ensures the given branch has the right server-side audio pump running
   * whenever >= 1 listener is subscribed to it.
   */
  private async syncBranchPump(branchSlug: string, forceRestart: boolean): Promise<void> {
    const subs = this.subscribers.get(branchSlug);
    if (!subs || subs.size === 0) {
      this.stopBranchPump(branchSlug);
      return;
    }

    const cfg = await this.store.readConfig(this.userId);
    const branch = cfg.branches.find((b) => b.slug === branchSlug);
    if (!branch) return;

    if (branch.isMain) {
      if (this.mode === 'LIVE' || !this.isPlaying) {
        this.stopBranchPump(branchSlug);
        return;
      }

      if (this.mode === 'PLAYLIST' && this.currentTrack) {
        const sourceKey = `playlist:${this.currentTrack.id}`;
        const existing = this.activePumps.get(branchSlug);
        if (!forceRestart && existing && existing.sourceKey === sourceKey) return;

        const resolved = this.resolvePlayableSource(this.currentTrack.pathOrUrl);
        if (resolved) {
          this.startFfmpegPcmPump(branchSlug, sourceKey, resolved, {
            offsetMs: this.getCurrentElapsedMs(),
            loop: false,
          });
        } else {
          this.startFallbackTonePump(branchSlug, sourceKey, 240);
        }
        return;
      }

      if (this.mode === 'ORDER' && this.currentOrder) {
        const sourceKey = `order:${this.currentOrder.id}`;
        const existing = this.activePumps.get(branchSlug);
        if (!forceRestart && existing && existing.sourceKey === sourceKey) return;

        const resolved =
          this.resolvePlayableSource(this.currentOrder.cachePath) ||
          this.resolvePlayableSource(this.currentOrder.previewUrl);
        if (resolved) {
          this.startFfmpegPcmPump(branchSlug, sourceKey, resolved, {
            offsetMs: this.getCurrentElapsedMs(),
            loop: false,
          });
        } else {
          this.startFallbackTonePump(branchSlug, sourceKey, 330);
        }
        return;
      }

      this.stopBranchPump(branchSlug);
      return;
    }

    // Non-main branch: loop mode streams its configured loopFile continuously
    if (branch.mode === 'loop' && branch.loopFile) {
      const sourceKey = `loop:${branch.loopFile}`;
      const existing = this.activePumps.get(branchSlug);
      if (!forceRestart && existing && existing.sourceKey === sourceKey) return;

      const resolved = this.resolvePlayableSource(branch.loopFile);
      if (resolved) {
        this.startFfmpegPcmPump(branchSlug, sourceKey, resolved, { loop: true });
      } else {
        this.startFallbackTonePump(branchSlug, sourceKey, 196);
      }
      return;
    }

    this.stopBranchPump(branchSlug);
  }

  /**
   * Decodes any real audio file (FLAC, Opus, MP3, M4A, HTTP stream) via ffmpeg
   * in real-time (`-re`) into 48 kHz stereo PCM16 and chunks it into exact 20 ms
   * binary frames (`[uint32 seq][uint32 ts_ms] + 3840-byte PCM16 payload`).
   */
  private startFfmpegPcmPump(
    branchSlug: string,
    sourceKey: string,
    resolvedSource: string,
    opts: { offsetMs?: number; loop?: boolean },
  ): void {
    this.stopBranchPump(branchSlug);
    this.setBranchCodec(branchSlug, 'pcm16');

    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-re'];
    if (opts.loop) {
      args.push('-stream_loop', '-1');
    }
    if (opts.offsetMs && opts.offsetMs > 250) {
      args.push('-ss', (opts.offsetMs / 1000).toFixed(3));
    }
    args.push(
      '-i',
      resolvedSource,
      '-vn',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      's16le',
      'pipe:1',
    );

    const child = spawn('ffmpeg', args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pumpRecord: ActivePump = { kind: 'ffmpeg', sourceKey, child };
    this.activePumps.set(branchSlug, pumpRecord);

    let carry = Buffer.alloc(0);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.activePumps.get(branchSlug) !== pumpRecord) return;
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (offset + FRAME_BYTES_20MS_48K_STEREO <= combined.length) {
        const frameSlice = combined.subarray(offset, offset + FRAME_BYTES_20MS_48K_STEREO);
        const packet = encodeAudioFrame(
          this.nextSeq(branchSlug),
          Date.now() >>> 0,
          new Uint8Array(frameSlice.buffer, frameSlice.byteOffset, frameSlice.byteLength),
        );
        this.fanoutBinary(branchSlug, packet);
        offset += FRAME_BYTES_20MS_48K_STEREO;
      }
      carry = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);
    });

    child.on('error', () => {
      if (this.activePumps.get(branchSlug) === pumpRecord) {
        this.activePumps.delete(branchSlug);
      }
    });

    child.on('close', () => {
      if (this.activePumps.get(branchSlug) === pumpRecord) {
        this.activePumps.delete(branchSlug);
      }
    });
  }

  private startFallbackTonePump(branchSlug: string, sourceKey: string, baseFreqHz: number): void {
    this.stopBranchPump(branchSlug);
    this.setBranchCodec(branchSlug, 'pcm16');

    const framesPerPacket = 960;
    const twoPi = Math.PI * 2;
    const timer = setInterval(() => {
      const subs = this.subscribers.get(branchSlug);
      if (!subs || subs.size === 0) return;

      const pcm = new Int16Array(framesPerPacket * 2);
      for (let i = 0; i < framesPerPacket; i++) {
        const t = this.phase / 48000;
        const env = 0.08 * (0.7 + 0.3 * Math.sin(twoPi * 0.5 * t));
        const sampleL = Math.sin(twoPi * baseFreqHz * t) * env + Math.sin(twoPi * (baseFreqHz * 1.5) * t) * (env * 0.45);
        const sampleR = Math.sin(twoPi * (baseFreqHz * 1.003) * t) * env + Math.sin(twoPi * (baseFreqHz * 1.25) * t) * (env * 0.45);
        pcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(sampleL * 32767)));
        pcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(sampleR * 32767)));
        this.phase++;
      }

      const packet = encodeAudioFrame(
        this.nextSeq(branchSlug),
        Date.now() >>> 0,
        new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      );
      this.fanoutBinary(branchSlug, packet);
    }, 20);

    this.activePumps.set(branchSlug, { kind: 'tone', sourceKey, timer });
  }
}
