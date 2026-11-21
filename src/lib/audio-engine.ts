import { decodeAudioFrame, encodeAudioFrame, OPUS_CONSTANTS } from '../../shared/protocol';

export interface IngestTelemetry {
  branchSlug: string;
  connected: boolean;
  transport: 'webtransport' | 'websocket' | 'reconnecting';
  rttMs: number;
  bufferMs: number;
  droppedFrames: number;
  levelDb: number;
  framesSent: number;
}

export interface PlayerTelemetry {
  connected: boolean;
  transport: 'webtransport' | 'websocket' | 'reconnecting';
  latencyMs: number;
  bufferMs: number;
  droppedFrames: number;
  usingSab: boolean;
  muted: boolean;
}

function wsOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

/**
 * Browser-side low-latency audio ingest emitter for testing live branch routing:
 * Supports real Microphone capture OR a clean stereo studio synth feed, framed with
 * the exact 8-byte binary header `[uint32 seq][uint32 timestamp_ms] + PCM16 payload`.
 */
export class BrowserBranchIngest {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private synthTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private droppedFrames = 0;
  private framesSent = 0;
  private rttMs = 0;
  private levelDb = -96;
  private phase = 0;
  private stopped = false;

  constructor(
    private readonly opts: {
      userSlug: string;
      branchSlug: string;
      token: string;
      frameMs: 10 | 20;
      sourceKind: 'synth' | 'microphone';
      synthFreqHz?: number;
      onTelemetry: (tel: IngestTelemetry) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    const url = `${wsOrigin()}/ingest/${encodeURIComponent(this.opts.userSlug)}/${encodeURIComponent(this.opts.branchSlug)}?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ingest WebSocket timeout')), 5000);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(
          JSON.stringify({
            type: 'stream_meta',
            codec: 'pcm16',
            sampleRate: OPUS_CONSTANTS.SAMPLE_RATE,
            channels: 2,
            frameMs: this.opts.frameMs,
            bitrateKbps: 64,
            branchSlug: this.opts.branchSlug,
          }),
        );
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Ingest WebSocket connection failed'));
      };
    });

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'pong' && typeof msg.clientTimeMs === 'number') {
            this.rttMs = Math.max(1, Date.now() - msg.clientTimeMs);
            this.emit(true);
          }
        } catch {
          // ignore
        }
      }
    };

    ws.onclose = () => {
      if (!this.stopped) this.emit(false);
    };

    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientTimeMs: Date.now() }));
      }
    }, 1500);

    if (this.opts.sourceKind === 'microphone' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      try {
        await this.startMicrophoneCapture();
        return;
      } catch {
        // Fall back to stereo synth generator if microphone denied
      }
    }

    this.startStereoSynthGenerator();
  }

  private async startMicrophoneCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: OPUS_CONSTANTS.SAMPLE_RATE,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new AudioContext({ sampleRate: OPUS_CONSTANTS.SAMPLE_RATE, latencyHint: 'interactive' });
    const source = this.ctx.createMediaStreamSource(this.mediaStream);
    const processor = this.ctx.createScriptProcessor(1024, 2, 2);
    source.connect(processor);
    processor.connect(this.ctx.destination);

    processor.onaudioprocess = (ev) => {
      if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const chL = ev.inputBuffer.getChannelData(0);
      const chR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : chL;
      const pcm = new Int16Array(chL.length * 2);
      let peak = 0;
      for (let i = 0; i < chL.length; i++) {
        const l = Math.max(-1, Math.min(1, chL[i]));
        const r = Math.max(-1, Math.min(1, chR[i]));
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
        pcm[i * 2] = Math.round(l * 32767);
        pcm[i * 2 + 1] = Math.round(r * 32767);
      }
      this.levelDb = peak <= 1e-5 ? -72 : Math.max(-72, Math.min(0, 20 * Math.log10(peak)));
      this.sendPcmFrame(pcm);
    };
  }

  private startStereoSynthGenerator(): void {
    const framesPerPacket = Math.round((OPUS_CONSTANTS.SAMPLE_RATE * this.opts.frameMs) / 1000);
    const baseFreq = this.opts.synthFreqHz ?? 261.63;
    const twoPi = Math.PI * 2;

    this.synthTimer = setInterval(() => {
      if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const pcm = new Int16Array(framesPerPacket * 2);
      let peak = 0;
      for (let i = 0; i < framesPerPacket; i++) {
        const t = this.phase / OPUS_CONSTANTS.SAMPLE_RATE;
        const pulse = 0.55 + 0.45 * Math.sin(twoPi * 1.25 * t);
        const l = (Math.sin(twoPi * baseFreq * t) * 0.14 + Math.sin(twoPi * baseFreq * 1.5 * t) * 0.08) * pulse;
        const r = (Math.sin(twoPi * (baseFreq * 1.004) * t) * 0.14 + Math.sin(twoPi * baseFreq * 1.25 * t) * 0.08) * pulse;
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
        pcm[i * 2] = Math.round(l * 32767);
        pcm[i * 2 + 1] = Math.round(r * 32767);
        this.phase++;
      }
      this.levelDb = peak <= 1e-5 ? -72 : Math.max(-72, Math.min(0, 20 * Math.log10(peak)));
      this.sendPcmFrame(pcm);
    }, this.opts.frameMs);
  }

  private sendPcmFrame(pcm: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 65_536) {
      this.droppedFrames++;
      return;
    }
    this.seq = (this.seq + 1) >>> 0;
    const packet = encodeAudioFrame(this.seq, Date.now() >>> 0, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    this.ws.send(packet);
    this.framesSent++;
    if (this.framesSent % 6 === 0) {
      this.emit(true);
    }
  }

  private emit(connected: boolean): void {
    this.opts.onTelemetry({
      branchSlug: this.opts.branchSlug,
      connected,
      transport: connected ? 'websocket' : 'reconnecting',
      rttMs: this.rttMs,
      bufferMs: this.opts.frameMs * 2,
      droppedFrames: this.droppedFrames,
      levelDb: this.levelDb,
      framesSent: this.framesSent,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.synthTimer) clearInterval(this.synthTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.emit(false);
  }
}

/**
 * Low-latency Web Player audio receiver using AudioWorklet + SharedArrayBuffer ring buffer
 * (with MessagePort fallback if crossOriginIsolated is unavailable) + WebCodecs Opus decoder.
 */
export class BrowserBranchPlayer {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private sabCtrl: Int32Array | null = null;
  private sabRing: Float32Array | null = null;
  private capacityFrames = 24_000;
  private usingSab = false;

  private ws: WebSocket | null = null;
  private stopped = false;
  private muted = true;
  private backoffMs = 500;
  private lastSeq = 0;
  private droppedFrames = 0;
  private latencyMs = 0;
  private bufferMs = 0;
  private codecMode: 'opus' | 'pcm16' = 'pcm16';
  private connected = false;

  constructor(
    private readonly opts: {
      userSlug: string;
      branchSlug: string;
      targetBufferMs?: number;
      onTelemetry: (tel: PlayerTelemetry) => void;
    },
  ) {}

  async start(initialMuted: boolean): Promise<void> {
    this.stopped = false;
    this.muted = initialMuted;
    await this.initAudioGraph();
    void this.connectLoop();
  }

  async resumeAudio(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.workletNode?.port.postMessage({ type: 'mute', muted });
    if (!muted) {
      void this.resumeAudio();
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

    let sab: SharedArrayBuffer | undefined;
    if (typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated) {
      const bytes = 16 + this.capacityFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
      sab = new SharedArrayBuffer(bytes);
      this.sabCtrl = new Int32Array(sab, 0, 4);
      this.sabRing = new Float32Array(sab, 16);
      this.usingSab = true;
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'pcm-ring-worklet', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        sab,
        channels: 2,
        targetBufferMs: this.opts.targetBufferMs ?? 80,
        maxBufferMs: 320,
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

    if (typeof AudioDecoder !== 'undefined') {
      try {
        this.decoder = new AudioDecoder({
          output: (audioData) => {
            const frames = audioData.numberOfFrames;
            const ch = Math.min(2, audioData.numberOfChannels);
            const interleaved = new Float32Array(frames * 2);
            if (audioData.format === 'f32') {
              audioData.copyTo(interleaved, { planeIndex: 0 });
            } else {
              const l = new Float32Array(frames);
              const r = new Float32Array(frames);
              audioData.copyTo(l, { planeIndex: 0 });
              audioData.copyTo(ch > 1 ? r : l, { planeIndex: ch > 1 ? 1 : 0 });
              for (let i = 0; i < frames; i++) {
                interleaved[i * 2] = l[i];
                interleaved[i * 2 + 1] = r[i];
              }
            }
            this.pushPcm(interleaved);
            audioData.close();
          },
          error: () => {},
        });
        this.decoder.configure({ codec: 'opus', sampleRate: OPUS_CONSTANTS.SAMPLE_RATE, numberOfChannels: 2 });
      } catch {
        this.decoder = null;
      }
    }
  }

  private pushPcm(interleaved: Float32Array): void {
    const frames = Math.floor(interleaved.length / 2);
    if (this.usingSab && this.sabCtrl && this.sabRing) {
      const w = Atomics.load(this.sabCtrl, 0);
      for (let i = 0; i < frames; i++) {
        const slot = ((w + i) % this.capacityFrames) * 2;
        this.sabRing[slot] = interleaved[i * 2];
        this.sabRing[slot + 1] = interleaved[i * 2 + 1];
      }
      Atomics.store(this.sabCtrl, 0, w + frames);
    } else if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'pcm', samples: interleaved }, [interleaved.buffer]);
    }
  }

  private onPacket(buf: ArrayBuffer): void {
    const pkt = decodeAudioFrame(buf);
    if (!pkt) return;
    if (this.lastSeq > 0 && pkt.seq > this.lastSeq + 1) {
      this.droppedFrames += pkt.seq - this.lastSeq - 1;
    }
    this.lastSeq = pkt.seq;

    const delta = ((Date.now() >>> 0) - pkt.timestampMs) >>> 0;
    if (delta < 5000) {
      this.latencyMs = Math.round(delta + this.bufferMs);
    }

    if (this.codecMode === 'pcm16') {
      const i16 = new Int16Array(pkt.payload.buffer, pkt.payload.byteOffset, Math.floor(pkt.payload.byteLength / 2));
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) {
        f32[i] = i16[i] / 32768;
      }
      this.pushPcm(f32);
    } else if (this.decoder && this.decoder.state === 'configured') {
      try {
        this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pkt.timestampMs * 1000, data: pkt.payload }));
      } catch {
        this.droppedFrames++;
      }
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        const url = `${wsOrigin()}/stream/${encodeURIComponent(this.opts.userSlug)}/${encodeURIComponent(this.opts.branchSlug)}`;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        let pingTimer: ReturnType<typeof setInterval> | null = null;

        ws.onopen = () => {
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
            this.onPacket(ev.data);
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

        const done = () => {
          if (pingTimer) clearInterval(pingTimer);
          this.connected = false;
          this.emitTelemetry();
          resolve();
        };
        ws.onerror = done;
        ws.onclose = done;
      });

      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(10_000, this.backoffMs * 2);
    }
  }

  private emitTelemetry(): void {
    this.opts.onTelemetry({
      connected: this.connected,
      transport: this.connected ? 'websocket' : 'reconnecting',
      latencyMs: this.latencyMs,
      bufferMs: this.bufferMs,
      droppedFrames: this.droppedFrames,
      usingSab: this.usingSab,
      muted: this.muted,
    });
  }
}
