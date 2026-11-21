/**
 * Streamer Radio Binary Audio Wire Protocol
 *
 * Frame layout (Opus 48 kHz, 1 or 2 channels, 10 ms or 20 ms):
 * ┌─────────────────────┬──────────────────────────┬──────────────────────────┐
 * │ uint32 BE seq (4 B) │ uint32 BE timestamp (4B) │ Opus/PCM payload (N B)   │
 * └─────────────────────┴──────────────────────────┴──────────────────────────┘
 *
 * Header size is strictly 8 bytes as specified in Section 7.
 * Extended control frames (optional) use text JSON over the same WS/WebTransport channel.
 */

export const AUDIO_HEADER_BYTES = 8;

export const OPUS_CONSTANTS = {
  SAMPLE_RATE: 48_000,
  DEFAULT_CHANNELS: 2,
  SUPPORTED_FRAME_MS: [10, 20] as const,
  DEFAULT_FRAME_MS: 20 as const,
  DEFAULT_BITRATE_KBPS: 64,
  SAMPLES_PER_10MS: 480,
  SAMPLES_PER_20MS: 960,
  TARGET_E2E_LATENCY_MS: 300,
  DEFAULT_JITTER_BUFFER_MS: 60,
  LOSS_RECOVERY_BUFFER_MS: 200,
} as const;

export interface AudioFrameHeader {
  seq: number;
  timestampMs: number;
}

export interface AudioFramePacket {
  seq: number;
  timestampMs: number;
  payload: Uint8Array;
}

/**
 * Encodes an audio payload with the 8-byte binary header:
 * [uint32 big-endian seq][uint32 big-endian timestamp_ms] + payload
 */
export function encodeAudioFrame(seq: number, timestampMs: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(AUDIO_HEADER_BYTES + payload.byteLength));
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, seq >>> 0, false);
  view.setUint32(4, timestampMs >>> 0, false);
  out.set(payload, AUDIO_HEADER_BYTES);
  return out;
}

/**
 * Decodes a binary frame packet into { seq, timestampMs, payload }.
 * Returns null if the packet is shorter than the 8-byte header.
 */
export function decodeAudioFrame(packet: ArrayBuffer | Uint8Array): AudioFramePacket | null {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (bytes.byteLength < AUDIO_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = view.getUint32(0, false);
  const timestampMs = view.getUint32(4, false);
  const payload = bytes.subarray(AUDIO_HEADER_BYTES);
  return { seq, timestampMs, payload };
}

/**
 * Control messages sent as UTF-8 JSON text frames alongside binary audio frames
 * on /stream/:userSlug/:branchSlug, /ingest/:userSlug/:branchSlug, and /ws/events/:userSlug.
 */
export type StreamControlMessage =
  | { type: 'ping'; clientTimeMs: number }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number }
  | {
      type: 'stream_meta';
      codec: 'opus' | 'pcm16';
      sampleRate: number;
      channels: number;
      frameMs: 10 | 20;
      bitrateKbps: number;
      branchSlug: string;
    }
  | { type: 'branch_state'; branchSlug: string; active: boolean; source: 'live' | 'playlist' | 'order' | 'loop' | 'silence' }
  | { type: 'telemetry'; rttMs: number; droppedFrames: number; bufferMs: number; levelDb: number };

export function parseControlMessage(raw: string): StreamControlMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as StreamControlMessage;
  } catch {
    return null;
  }
}
