import { encodeAudioFrame } from '@streamer-radio/protocol';
import type {
  Order,
  PlaybackMode,
  PlaybackStateSnapshot,
  PlaylistData,
  PlaylistTrack,
  UserConfig,
} from '@streamer-radio/shared';
import type { AtomicJsonStore } from './storage';

export interface AudioSubscriber {
  id: string;
  transport: 'webtransport' | 'websocket';
  sendBinary: (frame: Uint8Array) => void;
  sendText: (json: string) => void;
}

export interface EventSubscriber {
  id: string;
  sendText: (json: string) => void;
}

/**
 * Multi-tenant playback engine for a single streamer account.
 *
 * State machine for the branch with `isMain: true`:
 *   LIVE     -> forwards incoming desktop ingest frames directly. Incoming orders queue silently.
 *   PLAYLIST -> streams tracks via ffmpeg (Opus 48 kHz), saving trackIndex + offsetMs.
 *               When the current track finishes naturally, checks queue for ready orders.
 *   ORDER    -> plays ready orders FIFO without ever interrupting an active track.
 *               When queue empties, returns to PLAYLIST using `playlistResumeMode` ('exact' | 'next').
 *
 * Non-main branches:
 *   passthrough -> forwards desktop ingest frames for that branchSlug
 *   loop        -> loops configured loopFile via ffmpeg
 *   silence     -> no audio frames emitted
 */
export class UserPlaybackEngine {
  private mode: PlaybackMode = 'PLAYLIST';
  private liveIngests = new Set<string>();
  private subscribers = new Map<string, Map<string, AudioSubscriber>>();
  private eventSubscribers = new Map<string, EventSubscriber>();
  private branchSeq = new Map<string, number>();

  private currentOrderId: string | null = null;
  private currentOrder: Order | null = null;
  private currentTrack: PlaylistTrack | null = null;
  private trackStartedAtMs = 0;
  private trackBaseOffsetMs = 0;
  private trackDurationMs = 0;
  private isPlaying = false;

  private activeFfmpeg: ReturnType<typeof Bun.spawn> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private loopProcesses = new Map<string, ReturnType<typeof Bun.spawn>>();

  constructor(
    public readonly userId: string,
    public readonly userSlug: string,
    private readonly store: AtomicJsonStore,
  ) {}

  private nextSeq(branchSlug: string): number {
    const next = ((this.branchSeq.get(branchSlug) ?? 0) + 1) >>> 0;
    this.branchSeq.set(branchSlug, next);
    return next;
  }

  async getSnapshot(): Promise<PlaybackStateSnapshot> {
    const playlist = await this.store.readPlaylist(this.userId);
    const subscriberCounts: Record<string, number> = {};
    for (const [slug, map] of this.subscribers.entries()) {
      subscriberCounts[slug] = map.size;
    }
    const elapsed = this.isPlaying
      ? Math.min(this.trackDurationMs || Number.MAX_SAFE_INTEGER, this.trackBaseOffsetMs + (Date.now() - this.trackStartedAtMs))
      : playlist.position.offsetMs;

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

  getAdminStatus(): { online: boolean; mode: PlaybackMode; activeBranches: string[]; listenerCount: number } {
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
    void this.emitStateToOne(sub);
  }

  removeEventSubscriber(id: string): void {
    this.eventSubscribers.delete(id);
  }

  async broadcastEvent(event: string, payload: unknown): Promise<void> {
    const msg = JSON.stringify({ event, data: payload, ts: Date.now() });
    for (const sub of this.eventSubscribers.values()) {
      try {
        sub.sendText(msg);
      } catch {
        this.eventSubscribers.delete(sub.id);
      }
    }
  }

  private async emitStateToOne(sub: EventSubscriber): Promise<void> {
    const snap = await this.getSnapshot();
    const queue = await this.store.readQueue(this.userId);
    const playlist = await this.store.readPlaylist(this.userId);
    sub.sendText(JSON.stringify({ event: 'sync', data: { state: snap, queue: queue.orders, playlist }, ts: Date.now() }));
  }

  async broadcastState(): Promise<void> {
    const snap = await this.getSnapshot();
    await this.broadcastEvent('playback:state', snap);
  }

  addAudioSubscriber(branchSlug: string, sub: AudioSubscriber): void {
    let map = this.subscribers.get(branchSlug);
    if (!map) {
      map = new Map();
      this.subscribers.set(branchSlug, map);
    }
    map.set(sub.id, sub);
    void this.broadcastState();
  }

  removeAudioSubscriber(branchSlug: string, subId: string): void {
    const map = this.subscribers.get(branchSlug);
    if (!map) return;
    map.delete(subId);
    if (map.size === 0) {
      this.subscribers.delete(branchSlug);
    }
    void this.broadcastState();
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
    const config = await this.store.readConfig(this.userId);
    const mainBranch = config.branches.find((b) => b.isMain);
    if (mainBranch && mainBranch.slug === branchSlug) {
      await this.setMode('LIVE');
    } else {
      await this.broadcastState();
    }
  }

  async onIngestDisconnected(branchSlug: string): Promise<void> {
    this.liveIngests.delete(branchSlug);
    const config = await this.store.readConfig(this.userId);
    const mainBranch = config.branches.find((b) => b.isMain);
    if (mainBranch && mainBranch.slug === branchSlug && this.mode === 'LIVE') {
      await this.setMode('PLAYLIST');
    } else {
      await this.broadcastState();
    }
  }

  async handleIngestFrame(branchSlug: string, packet: Uint8Array): Promise<void> {
    const config = await this.store.readConfig(this.userId);
    const branch = config.branches.find((b) => b.slug === branchSlug);
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

    // Persist playlist offset if leaving PLAYLIST
    if (this.mode === 'PLAYLIST' && this.isPlaying) {
      await this.persistCurrentPlaylistOffset();
    }

    this.stopActiveStream();
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

    // PLAYLIST
    await this.startPlaylistFromSavedPosition();
    await this.broadcastState();
  }

  async triggerNextTrackOrOrder(): Promise<void> {
    await this.onCurrentItemFinished();
  }

  private stopActiveStream(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.activeFfmpeg) {
      try {
        this.activeFfmpeg.kill();
      } catch {
        // ignore
      }
      this.activeFfmpeg = null;
    }
    this.isPlaying = false;
  }

  private async persistCurrentPlaylistOffset(): Promise<void> {
    if (!this.currentTrack || this.trackStartedAtMs <= 0) return;
    const elapsed = Math.min(
      this.trackDurationMs || 180_000,
      Math.max(0, Math.round(this.trackBaseOffsetMs + (Date.now() - this.trackStartedAtMs))),
    );
    await this.store.mutatePlaylist(this.userId, (pl) => {
      pl.position.offsetMs = elapsed;
    });
  }

  private async startPlaylistFromSavedPosition(): Promise<void> {
    const config = await this.store.readConfig(this.userId);
    const playlist = await this.store.readPlaylist(this.userId);
    if (playlist.tracks.length === 0) {
      this.currentTrack = null;
      this.isPlaying = false;
      return;
    }

    const idx = Math.min(playlist.position.trackIndex, playlist.tracks.length - 1);
    const track = playlist.tracks[idx];
    const startOffset = config.playlistResumeMode === 'exact' ? Math.min(playlist.position.offsetMs, Math.max(0, track.durationMs - 1000)) : 0;

    this.currentTrack = track;
    this.currentOrderId = null;
    this.currentOrder = null;
    this.trackBaseOffsetMs = startOffset;
    this.trackDurationMs = track.durationMs;
    this.trackStartedAtMs = Date.now();
    this.isPlaying = true;

    const mainBranch = config.branches.find((b) => b.isMain);
    if (mainBranch) {
      this.spawnFfmpegOpusPump(mainBranch.slug, track.pathOrUrl, startOffset, config);
    }

    this.startProgressTimer();
  }

  private async tryStartNextOrder(): Promise<boolean> {
    const config = await this.store.readConfig(this.userId);
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

    const source = nextOrder.cachePath || nextOrder.previewUrl;
    const mainBranch = config.branches.find((b) => b.isMain);
    if (source && mainBranch) {
      this.spawnFfmpegOpusPump(mainBranch.slug, source, 0, config);
    }

    await this.broadcastQueueUpdate();
    this.startProgressTimer();
    return true;
  }

  /**
   * Called strictly when the current track or order finishes completely.
   * Never called mid-track on new order arrival (acceptance criterion: orders never interrupt).
   */
  private async onCurrentItemFinished(): Promise<void> {
    const finishedMode = this.mode;
    const finishedOrderId = this.currentOrderId;
    this.stopActiveStream();

    if (finishedMode === 'ORDER' && finishedOrderId) {
      await this.store.mutateQueue(this.userId, (q) => {
        q.orders = q.orders.filter((o) => o.id !== finishedOrderId);
      });
      await this.broadcastQueueUpdate();

      // Play next order if available
      if (await this.tryStartNextOrder()) {
        await this.broadcastState();
        return;
      }

      // Queue empty -> return to PLAYLIST applying resumeMode ('exact' | 'next')
      const config = await this.store.readConfig(this.userId);
      if (config.playlistResumeMode === 'next') {
        await this.advancePlaylistIndex();
      }
      this.mode = 'PLAYLIST';
      await this.startPlaylistFromSavedPosition();
      await this.broadcastState();
      return;
    }

    if (finishedMode === 'PLAYLIST') {
      await this.advancePlaylistIndex();

      // Check if an order is ready now that the current track finished
      if (await this.tryStartNextOrder()) {
        await this.broadcastState();
        return;
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
   * Decodes and encodes a media file/URL into real-time paced Opus packets via ffmpeg
   * and fans out 8-byte framed binary packets to subscribers of `branchSlug`.
   */
  private spawnFfmpegOpusPump(branchSlug: string, source: string, offsetMs: number, config: UserConfig): void {
    const frameMs = config.audio.frameMs;
    const bitrateKbps = config.audio.bitrateKbps;
    const seekSec = (offsetMs / 1000).toFixed(3);

    try {
      const proc = Bun.spawn(
        [
          'ffmpeg',
          '-re',
          '-hide_banner',
          '-loglevel',
          'error',
          ...(offsetMs > 0 ? ['-ss', seekSec] : []),
          '-i',
          source,
          '-vn',
          '-ac',
          '2',
          '-ar',
          '48000',
          '-c:a',
          'libopus',
          '-b:a',
          `${bitrateKbps}k`,
          '-frame_duration',
          String(frameMs),
          '-f',
          'ogg',
          'pipe:1',
        ],
        { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
      );

      this.activeFfmpeg = proc;
      const reader = proc.stdout.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              const packet = encodeAudioFrame(this.nextSeq(branchSlug), Date.now() >>> 0, value);
              this.fanoutBinary(branchSlug, packet);
            }
          }
        } catch {
          // Process stopped cleanly
        }
      })();
    } catch {
      // ffmpeg unavailable in container; timer continues tracking playback timeline cleanly
    }
  }

  async syncLoopBranches(): Promise<void> {
    const config = await this.store.readConfig(this.userId);
    const activeSlugs = new Set<string>();
    for (const b of config.branches) {
      if (!b.isMain && b.mode === 'loop' && b.loopFile) {
        activeSlugs.add(b.slug);
        if (!this.loopProcesses.has(b.slug)) {
          try {
            const mediaPath = this.store.getUserMediaPath(this.userId, b.loopFile);
            const proc = Bun.spawn(
              [
                'ffmpeg',
                '-re',
                '-stream_loop',
                '-1',
                '-hide_banner',
                '-loglevel',
                'error',
                '-i',
                mediaPath,
                '-vn',
                '-ac',
                '2',
                '-ar',
                '48000',
                '-c:a',
                'libopus',
                '-b:a',
                `${config.audio.bitrateKbps}k`,
                '-frame_duration',
                String(config.audio.frameMs),
                '-f',
                'ogg',
                'pipe:1',
              ],
              { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
            );
            this.loopProcesses.set(b.slug, proc);
            const reader = proc.stdout.getReader();
            void (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value?.byteLength) {
                    this.fanoutBinary(b.slug, encodeAudioFrame(this.nextSeq(b.slug), Date.now() >>> 0, value));
                  }
                }
              } catch {
                // ignore
              }
            })();
          } catch {
            // missing loop file or ffmpeg
          }
        }
      }
    }

    for (const [slug, proc] of this.loopProcesses.entries()) {
      if (!activeSlugs.has(slug)) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        this.loopProcesses.delete(slug);
      }
    }
  }

  async broadcastQueueUpdate(): Promise<void> {
    const queue = await this.store.readQueue(this.userId);
    await this.broadcastEvent('queue:updated', queue.orders);
  }
}
