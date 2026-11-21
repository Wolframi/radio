import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTrackQuery } from '../shared/schemas';
import type { AtomicJsonStore } from './storage';

export interface ResolvedOrderResult {
  title: string;
  artist: string;
  durationMs: number;
  cachePath?: string;
  previewUrl?: string;
  provider: 'yt-dlp' | 'itunes' | 'deezer' | 'cache' | 'manual';
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export function assertSafeExternalUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are permitted');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error('Blocked private or loopback address');
  }
  return parsed;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

function runSubprocess(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve({ code: -1, stdout });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

async function searchItunes(query: string): Promise<ResolvedOrderResult | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      results?: Array<{ trackName?: string; artistName?: string; previewUrl?: string; trackTimeMillis?: number }>;
    };
    const item = data.results?.[0];
    if (!item?.previewUrl) return null;
    assertSafeExternalUrl(item.previewUrl);
    return {
      title: item.trackName || query,
      artist: item.artistName || 'Unknown Artist',
      durationMs: Math.min(item.trackTimeMillis || 30_000, 30_000),
      previewUrl: item.previewUrl,
      provider: 'itunes',
    };
  } catch {
    return null;
  }
}

async function searchDeezer(query: string): Promise<ResolvedOrderResult | null> {
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      data?: Array<{ title?: string; artist?: { name?: string }; preview?: string }>;
    };
    const item = data.data?.[0];
    if (!item?.preview) return null;
    assertSafeExternalUrl(item.preview);
    return {
      title: item.title || query,
      artist: item.artist?.name || 'Unknown Artist',
      durationMs: 30_000,
      previewUrl: item.preview,
      provider: 'deezer',
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a viewer track order with SHA-256 disk caching:
 * 1. Check `data/users/:id/cache/{sha256}.meta.json` & `.opus`
 * 2. Attempt `yt-dlp` -> `ffmpeg` Opus transcode when installed on host
 * 3. Fallback to iTunes Search API -> Deezer Search API
 */
export async function resolveOrderTrack(
  store: AtomicJsonStore,
  userId: string,
  rawQuery: string,
  bitrateKbps = 64,
): Promise<ResolvedOrderResult> {
  const parsed = parseTrackQuery(rawQuery);
  const hash = sha256Hex(parsed.normalizedQuery);
  const cacheDir = store.getUserCacheDir(userId);
  const cacheOpus = path.resolve(cacheDir, `${hash}.opus`);
  const cacheMeta = path.resolve(cacheDir, `${hash}.meta.json`);

  if (!cacheOpus.startsWith(cacheDir + path.sep) || !cacheMeta.startsWith(cacheDir + path.sep)) {
    throw new Error('Cache path violation');
  }

  // 1. Cache lookup
  try {
    const metaRaw = await fs.readFile(cacheMeta, 'utf8');
    const cached = JSON.parse(metaRaw) as ResolvedOrderResult;
    return { ...cached, provider: 'cache' };
  } catch {
    // cache miss
  }

  const safeQuery = parsed.normalizedQuery.replace(/[\r\n\0]/g, ' ').slice(0, 180);

  // 2. Primary: yt-dlp + ffmpeg
  const ytMeta = await runSubprocess('yt-dlp', [
    '--no-playlist',
    '--print',
    '%(title)s\t%(uploader)s\t%(duration)s\t%(url)s',
    '-f',
    'bestaudio/best',
    '--',
    `ytsearch1:${safeQuery} audio`,
  ]);

  if (ytMeta.code === 0 && ytMeta.stdout.trim()) {
    const [ytTitle, ytArtist, ytDurSec, mediaUrl] = ytMeta.stdout.trim().split('\t');
    if (mediaUrl) {
      try {
        assertSafeExternalUrl(mediaUrl);
        const tmpOpus = `${cacheOpus}.tmp.${process.pid}.opus`;
        const ff = await runSubprocess(
          'ffmpeg',
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            mediaUrl,
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
            '20',
            tmpOpus,
          ],
          45_000,
        );
        if (ff.code === 0) {
          await fs.rename(tmpOpus, cacheOpus);
          const result: ResolvedOrderResult = {
            title: ytTitle || parsed.title || rawQuery,
            artist: ytArtist || parsed.artist || 'YouTube Audio',
            durationMs:
              Number.isFinite(Number(ytDurSec)) && Number(ytDurSec) > 0 ? Math.round(Number(ytDurSec) * 1000) : 180_000,
            cachePath: cacheOpus,
            provider: 'yt-dlp',
          };
          await fs.writeFile(cacheMeta, JSON.stringify(result, null, 2), 'utf8');
          return result;
        }
        await fs.rm(tmpOpus, { force: true }).catch(() => {});
      } catch {
        // fallback below
      }
    }
  }

  // 3. Fallback: iTunes Search API -> Deezer Search API
  const fallback = (await searchItunes(safeQuery)) ?? (await searchDeezer(safeQuery));
  if (fallback) {
    await fs.writeFile(cacheMeta, JSON.stringify(fallback, null, 2), 'utf8').catch(() => {});
    return fallback;
  }

  // 4. Offline-safe fallback when external search APIs are unreachable in sandbox
  const localResolved: ResolvedOrderResult = {
    title: parsed.title || rawQuery,
    artist: parsed.artist || 'Viewer Request',
    durationMs: 30_000,
    provider: 'manual',
  };
  await fs.writeFile(cacheMeta, JSON.stringify(localResolved, null, 2), 'utf8').catch(() => {});
  return localResolved;
}
