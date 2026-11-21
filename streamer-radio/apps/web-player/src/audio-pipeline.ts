import { decodeAudioFrame, OPUS_CONSTANTS } from '@streamer-radio/protocol';

export interface PlayerTelemetry {
  transport: 'webtransport' | 'websocket' | 'reconnecting';
  connected: boolean;
  latencyMs: number;
  bufferMs: number;
  droppedFrames: number;
  usingSab: boolean;
  muted: boolean;
}

export interface AudioPipelineOptions {
  serverBaseUrl: string;
  userSlug: string;
  branchSlug: string;
  targetBufferMs?: number;
  certHashBase64?: string | null;
  onTelemetry: (telemetry: PlayerTelemetry) => void;
}

/**
 * Low-latency Web Player audio pipeline:
 * 1. Connects to `/stream/:userSlug/:branchSlug` via WebTransport (HTTP/3 QUIC) with WS fallback
 * 2. Decodes incoming Opus packets with WebCodecs `AudioDecoder` (48 kHz stereo) or raw PCM16 fallback
 * 3. Writes Float32 PCM into lock-free `SharedArrayBuffer` ring buffer (or MessagePort fallback)
 * 4. Plays sample-accurately via `AudioWorkletProcessor` with instant click-free OBS scene mute/unmute
 */
export class LowLatencyAudioPipeline {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private sabCtrl: Int32Array | null = null;
  private sabRing: Float32Array | null = null;
  private capacityFrames = 0;

  private ws: WebSocket | null = null;
  private wt: unknown = null;
  private stopped = false;
  private muted = true;
  private backoffMs = 500;
  private lastSeq = 0;
  private droppedFrames = 0;
  private latencyMs = 0;
  private bufferMs = 0;
  private usingSab = false;
  private transport: PlayerTelemetry['transport'] = 'reconnecting';
  private connected = false;
  private codecMode: 'opus' | 'pcm16' = 'opus';

  constructor(private readonly opts: AudioPipelineOptions) {}

  async start(initialMuted: boolean): Promise<void> {
    this.stopped = false;
    this.muted = initialMuted;
    await this.initAudioGraph();
    void this.connectLoop();
  }

  async ensureAudioResumed(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.workletNode?.port.postMessage({ type: 'mute', muted });
    if (!muted) {
      void this.ensureAudioResumed();
    }
    this.emitTelemetry();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    try {
      (this.wt as { close?: () => void } | null)?.close?.();
    } catch {
      // ignore
    }
    try {
      this.decoder?.close();
    } catch {
      // ignore
    }
    void this.ctx?.close().catch(() => {});
  }

  private async initAudioGraph(): Promise<void> {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx({ sampleRate: OPUS_CONSTANTS.SAMPLE_RATE, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/pcm-ring-worklet.js');

    const channels = OPUS_CONSTANTS.DEFAULT_CHANNELS;
    let sab: SharedArrayBuffer | undefined;

    if (typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated) {
      // 48 kHz * 0.5 sec ring = 24000 stereo frames
      this.capacityFrames = 24_000;
      const bytes = 16 + this.capacityFrames * channels * Float32Array.BYTES_PER_ELEMENT;
      sab = new SharedArrayBuffer(bytes);
      this.sabCtrl = new Int32Array(sab, 0, 4);
      this.sabRing = new Float32Array(sab, 16);
      this.usingSab = true;
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'pcm-ring-worklet', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        sab,
        channels,
        targetBufferMs: this.opts.targetBufferMs ?? OPUS_CONSTANTS.DEFAULT_JITTER_BUFFER_MS,
        maxBufferMs: OPUS_CONSTANTS.LOSS_RECOVERY_BUFFER_MS,
        initialMuted: this.muted,
      },
    });

    this.workletNode.port.onmessage = (e) => {
      if (e.data?.type === 'telemetry') {
        this.bufferMs = e.data.bufferMs;
        this.usingSab = Boolean(e.data.usingSab);
        this.emitTelemetry();
      }
    };
    this.workletNode.connect(this.ctx.destination);

    // Initialize WebCodecs AudioDecoder for Opus 48 kHz stereo
    if (typeof AudioDecoder !== 'undefined') {
      this.decoder = new AudioDecoder({
        output: (audioData) => {
          this.handleDecodedAudioData(audioData);
          audioData.close();
        },
        error: () => {
          // Recover silently on single corrupt datagram
        },
      });
      this.decoder.configure({
        codec: 'opus',
        sampleRate: OPUS_CONSTANTS.SAMPLE_RATE,
        numberOfChannels: channels,
      });
    }
  }

  private handleDecodedAudioData(audioData: AudioData): void {
    const frames = audioData.numberOfFrames;
    const channels = Math.min(2, audioData.numberOfChannels);
    const interleaved = new Float32Array(frames * 2);

    if (audioData.format === 'f32') {
      audioData.copyTo(interleaved, { planeIndex: 0 });
    } else {
      const ch0 = new Float32Array(frames);
      const ch1 = new Float32Array(frames);
      audioData.copyTo(ch0, { planeIndex: 0 });
      audioData.copyTo(channels > 1 ? ch1 : ch0, { planeIndex: channels > 1 ? 1 : 0 });
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = ch0[i];
        interleaved[i * 2 + 1] = ch1[i];
      }
    }

    this.pushPcmFrames(interleaved);
  }

  private pushPcmFrames(interleavedStereo: Float32Array): void {
    const frames = Math.floor(interleavedStereo.length / 2);
    if (this.usingSab && this.sabCtrl && this.sabRing) {
      let w = Atomics.load(this.sabCtrl, 0);
      for (let i = 0; i < frames; i++) {
        const slot = ((w + i) % this.capacityFrames) * 2;
        this.sabRing[slot] = interleavedStereo[i * 2];
        this.sabRing[slot + 1] = interleavedStereo[i * 2 + 1];
      }
      Atomics.store(this.sabCtrl, 0, w + frames);
    } else if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'pcm', samples: interleavedStereo }, [interleavedStereo.buffer]);
    }
  }

  private onBinaryPacket(buf: ArrayBuffer | Uint8Array): void {
    const pkt = decodeAudioFrame(buf);
    if (!pkt) return;

    if (this.lastSeq > 0 && pkt.seq > this.lastSeq + 1) {
      this.droppedFrames += pkt.seq - this.lastSeq - 1;
    }
    this.lastSeq = pkt.seq;

    // Estimate one-way transit + jitter buffer latency
    const nowLow32 = Date.now() >>> 0;
    const rawDelta = (nowLow32 - pkt.timestampMs) >>> 0;
    if (rawDelta < 5000) {
      this.latencyMs = Math.round(rawDelta + this.bufferMs);
    }

    if (this.codecMode === 'pcm16') {
      const i16 = new Int16Array(pkt.payload.buffer, pkt.payload.byteOffset, Math.floor(pkt.payload.byteLength / 2));
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) {
        f32[i] = i16[i] / 32768;
      }
      this.pushPcmFrames(f32);
      return;
    }

    if (this.decoder && this.decoder.state === 'configured') {
      try {
        const chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: pkt.timestampMs * 1000,
          data: pkt.payload,
        });
        this.decoder.decode(chunk);
      } catch {
        this.droppedFrames++;
      }
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      // 1. Attempt WebTransport over HTTP/3 QUIC first
      if (typeof (window as unknown as { WebTransport?: unknown }).WebTransport === 'function' && this.opts.serverBaseUrl.startsWith('https://')) {
        const ok = await this.runWebTransport();
        if (this.stopped) return;
        if (ok) this.backoffMs = 500;
      }

      // 2. Fallback to WebSocket
      await this.runWebSocket();
      if (this.stopped) return;

      this.connected = false;
      this.transport = 'reconnecting';
      this.emitTelemetry();

      const jitter = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4));
      await new Promise((r) => setTimeout(r, jitter));
      this.backoffMs = Math.min(10_000, this.backoffMs * 2);
    }
  }

  private async runWebTransport(): Promise<boolean> {
    const WT = (window as unknown as {
      WebTransport: new (url: string, opts?: unknown) => {
        ready: Promise<void>;
        closed: Promise<void>;
        close: () => void;
        datagrams: { readable: ReadableStream<Uint8Array> };
      };
    }).WebTransport;

    const url = `${this.opts.serverBaseUrl.replace(/\/$/, '')}/stream/${this.opts.userSlug}/${this.opts.branchSlug}`;
    const wtOpts: Record<string, unknown> = {};
    if (this.opts.certHashBase64) {
      const bin = Uint8Array.from(atob(this.opts.certHashBase64), (c) => c.charCodeAt(0));
      wtOpts.serverCertificateHashes = [{ algorithm: 'sha-256', value: bin.buffer }];
    }

    try {
      const session = new WT(url, wtOpts);
      this.wt = session;
      await Promise.race([
        session.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('WT timeout')), 3000)),
      ]);
      this.transport = 'webtransport';
      this.connected = true;
      this.backoffMs = 500;
      this.emitTelemetry();

      const reader = session.datagrams.readable.getReader();
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.onBinaryPacket(value);
      }
      return true;
    } catch {
      return false;
    }
  }

  private runWebSocket(): Promise<void> {
    return new Promise((resolve) => {
      const wsBase = this.opts.serverBaseUrl
        .replace(/\/$/, '')
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://');
      const url = `${wsBase}/stream/${this.opts.userSlug}/${this.opts.branchSlug}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      let pingTimer: ReturnType<typeof setInterval> | null = null;

      ws.onopen = () => {
        this.transport = 'websocket';
        this.connected = true;
        this.backoffMs = 500;
        this.emitTelemetry();
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', clientTimeMs: Date.now() }));
          }
        }, 2000);
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.onBinaryPacket(ev.data);
        } else if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'pong' && typeof msg.clientTimeMs === 'number') {
              const rtt = Math.max(0, Date.now() - msg.clientTimeMs);
              this.latencyMs = Math.round(rtt / 2 + this.bufferMs);
              this.emitTelemetry();
            } else if (msg.type === 'stream_meta' && (msg.codec === 'opus' || msg.codec === 'pcm16')) {
              this.codecMode = msg.codec;
            }
          } catch {
            // ignore
          }
        }
      };

      const finish = () => {
        if (pingTimer) clearInterval(pingTimer);
        this.connected = false;
        resolve();
      };
      ws.onerror = finish;
      ws.onclose = finish;
    });
  }

  private emitTelemetry(): void {
    this.opts.onTelemetry({
      transport: this.transport,
      connected: this.connected,
      latencyMs: this.latencyMs,
      bufferMs: this.bufferMs,
      droppedFrames: this.droppedFrames,
      usingSab: this.usingSab,
      muted: this.muted,
    });
  }
}
