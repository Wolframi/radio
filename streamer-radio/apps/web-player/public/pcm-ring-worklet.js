/**
 * Lock-free SharedArrayBuffer Ring Buffer AudioWorkletProcessor (OBS Web Player)
 */
class PcmRingWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.channels = opts.channels || 2;
    this.targetBufferFrames = Math.round(((opts.targetBufferMs || 60) * sampleRate) / 1000);
    this.maxBufferFrames = Math.round(((opts.maxBufferMs || 200) * sampleRate) / 1000);
    this.muted = Boolean(opts.initialMuted);
    this.primed = false;
    this.gain = this.muted ? 0 : 1;

    if (opts.sab instanceof SharedArrayBuffer) {
      this.useSab = true;
      this.ctrl = new Int32Array(opts.sab, 0, 4);
      this.ring = new Float32Array(opts.sab, 16);
      this.capacityFrames = Math.floor(this.ring.length / this.channels);
    } else {
      this.useSab = false;
      this.fallbackQueue = [];
      this.fallbackOffset = 0;
      this.fallbackFramesAvailable = 0;
    }

    this.underruns = 0;
    this.telemetryCounter = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'mute') {
        this.muted = Boolean(msg.muted);
      } else if (msg.type === 'pcm' && !this.useSab && msg.samples instanceof Float32Array) {
        this.fallbackQueue.push(msg.samples);
        this.fallbackFramesAvailable += Math.floor(msg.samples.length / this.channels);
        while (this.fallbackFramesAvailable > this.maxBufferFrames && this.fallbackQueue.length > 1) {
          const dropped = this.fallbackQueue.shift();
          this.fallbackFramesAvailable -= Math.floor(dropped.length / this.channels);
          this.fallbackOffset = 0;
        }
      }
    };
  }

  getBufferedFrames() {
    if (this.useSab) {
      return Math.max(0, Atomics.load(this.ctrl, 0) - Atomics.load(this.ctrl, 1));
    }
    return this.fallbackFramesAvailable;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output[1] || output[0];
    const blockSize = outL.length;
    const buffered = this.getBufferedFrames();

    if (!this.primed) {
      if (buffered >= this.targetBufferFrames) {
        this.primed = true;
      } else {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        this.maybeEmitTelemetry(buffered);
        return true;
      }
    }

    const targetGain = this.muted ? 0 : 1;

    if (this.useSab) {
      let r = Atomics.load(this.ctrl, 1);
      const w = Atomics.load(this.ctrl, 0);
      let avail = w - r;
      if (avail > this.maxBufferFrames) {
        r = w - this.targetBufferFrames;
        avail = w - r;
      }
      if (avail < blockSize) {
        this.underruns++;
        Atomics.store(this.ctrl, 3, this.underruns);
        this.primed = false;
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        this.maybeEmitTelemetry(avail);
        return true;
      }
      for (let i = 0; i < blockSize; i++) {
        this.gain += (targetGain - this.gain) * 0.04;
        const slot = ((r + i) % this.capacityFrames) * this.channels;
        outL[i] = this.ring[slot] * this.gain;
        if (outR !== outL) outR[i] = this.ring[slot + (this.channels > 1 ? 1 : 0)] * this.gain;
      }
      Atomics.store(this.ctrl, 1, r + blockSize);
    } else {
      if (this.fallbackFramesAvailable < blockSize) {
        this.underruns++;
        this.primed = false;
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        this.maybeEmitTelemetry(this.fallbackFramesAvailable);
        return true;
      }
      for (let i = 0; i < blockSize; i++) {
        this.gain += (targetGain - this.gain) * 0.04;
        const head = this.fallbackQueue[0];
        if (!head) {
          outL[i] = 0;
          if (outR !== outL) outR[i] = 0;
          continue;
        }
        const idx = this.fallbackOffset * this.channels;
        outL[i] = head[idx] * this.gain;
        if (outR !== outL) outR[i] = head[idx + (this.channels > 1 ? 1 : 0)] * this.gain;
        this.fallbackOffset++;
        this.fallbackFramesAvailable--;
        if (this.fallbackOffset * this.channels >= head.length) {
          this.fallbackQueue.shift();
          this.fallbackOffset = 0;
        }
      }
    }

    this.maybeEmitTelemetry(this.getBufferedFrames());
    return true;
  }

  maybeEmitTelemetry(bufferedFrames) {
    this.telemetryCounter++;
    if (this.telemetryCounter >= 40) {
      this.telemetryCounter = 0;
      this.port.postMessage({
        type: 'telemetry',
        bufferMs: Math.round((bufferedFrames / sampleRate) * 1000),
        underruns: this.underruns,
        muted: this.muted,
        usingSab: this.useSab,
      });
    }
  }
}

registerProcessor('pcm-ring-worklet', PcmRingWorkletProcessor);
