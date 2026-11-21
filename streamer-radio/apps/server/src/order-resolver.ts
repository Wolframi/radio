import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTrackQuery } from '@streamer-radio/shared';
import type { AtomicJsonStore } from './storage';

export interface ResolvedOrderAudio {
  title: string;
  artist: string;
  durationMs: number;
  cachePath?: string;
  previewUrl?: string;
  provider: 'yt-dlp' | 'itunes' | 'deezer' | 'cache';
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
    throw new Error('Blocked private or loopback network target');
  }
  return parsed;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function runCommandNoShell(args: string[], timeoutMs = 45_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function probeDurationMs(filePath: string): Promise<number> {
  const res = await runCommandNoShell([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  if (res.exitCode === 0) {
    const secs = Number.parseFloat(res.stdout.trim());
    if (Number.isFinite(secs) && secs > 0) {
      return Math.round(secs * 1000);
    }
  }
  return 180_000;
}

async function searchItunesFallback(query: string): Promise<ResolvedOrderAudio | null> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const json = (await resp.json()) as {
    results?: Array<{ trackName?: string; artistName?: string; previewUrl?: string; trackTimeMillis?: number }>;
  };
  const first = json.results?.[0];
  if (!first?.previewUrl) return null;
  assertSafeExternalUrl(first.previewUrl);
  return {
    title: first.trackName || query,
    artist: first.artistName || 'Unknown Artist',
    durationMs: Math.min(first.trackTimeMillis || 30_000, 30_000),
    previewUrl: first.previewUrl,
    provider: 'itunes',
  };
}

async function searchDeezerFallback(query: string): Promise<ResolvedOrderAudio | null> {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const json = (await resp.json()) as {
    data?: Array<{ title?: string; artist?: { name?: string }; preview?: string; duration?: number }>;
  };
  const first = json.data?.[0];
  if (!first?.preview) return null;
  assertSafeExternalUrl(first.preview);
  return {
    title: first.title || query,
    artist: first.artist?.name || 'Unknown Artist',
    durationMs: 30_000,
    previewUrl: first.preview,
    provider: 'deezer',
  };
}

/**
 * Resolves a viewer order query:
 * 1. Check SHA-256 disk cache in data/users/:id/cache/{sha256}.opus
 * 2. Run yt-dlp ("ytsearch1:{query} audio") + ffmpeg transcode to 48 kHz 64 kbps Opus
 * 3. Fallback to iTunes Search API -> Deezer Search API (transcoding preview into Opus cache if ffmpeg available)
 */
export async function resolveOrderTrack(
  store: AtomicJsonStore,
  userId: string,
  rawQuery: string,
  bitrateKbps = 64,
): Promise<ResolvedOrderAudio> {
  const parsed = parseTrackQuery(rawQuery);
  const hash = sha256Hex(parsed.normalizedQuery);
  const cacheDir = store.getUserCacheDir(userId);
  const cacheFile = path.resolve(cacheDir, `${hash}.opus`);
  if (!cacheFile.startsWith(cacheDir + path.sep)) {
    throw new Error('Cache path confinement violation');
  }

  // 1. Disk cache hit
  if (await fileExists(cacheFile)) {
    const durationMs = await probeDurationMs(cacheFile);
    return {
      title: parsed.title || rawQuery,
      artist: parsed.artist || 'Cached Track',
      durationMs,
      cachePath: cacheFile,
      provider: 'cache',
    };
  }

  // 2. Primary: yt-dlp -> ffmpeg -> .opus cache
  const safeSearchTerm = parsed.normalizedQuery.replace(/[\r\n\0]/g, ' ').slice(0, 180);
  try {
    const metaRes = await runCommandNoShell([
      'yt-dlp',
      '--no-playlist',
      '--print',
      '%(title)s\t%(uploader)s\t%(duration)s\t%(url)s',
      '-f',
      'bestaudio/best',
      '--',
      `ytsearch1:${safeSearchTerm} audio`,
    ]);

    if (metaRes.exitCode === 0 && metaRes.stdout.trim()) {
      const [ytTitle, ytUploader, ytDurSec, mediaUrl] = metaRes.stdout.trim().split('\t');
      if (mediaUrl) {
        assertSafeExternalUrl(mediaUrl);
        const tmpOut = `${cacheFile}.tmp.${process.pid}.opus`;
        const ff = await runCommandNoShell(
          [
            'ffmpeg',
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
            '-application',
            'audio',
            tmpOut,
          ],
          90_000,
        );

        if (ff.exitCode === 0 && (await fileExists(tmpOut))) {
          await fs.rename(tmpOut, cacheFile);
          const durationMs =
            Number.isFinite(Number(ytDurSec)) && Number(ytDurSec) > 0
              ? Math.round(Number(ytDurSec) * 1000)
              : await probeDurationMs(cacheFile);
          return {
            title: ytTitle || parsed.title || rawQuery,
            artist: ytUploader || parsed.artist || 'YouTube Audio',
            durationMs,
            cachePath: cacheFile,
            provider: 'yt-dlp',
          };
        }
        await fs.rm(tmpOut, { force: true }).catch(() => {});
      }
    }
  } catch {
    // Fall through to iTunes / Deezer
  }

  // 3. Fallback: iTunes Search API -> Deezer Search API
  const fallback = (await searchItunesFallback(safeSearchTerm)) ?? (await searchDeezerFallback(safeSearchTerm));
  if (fallback?.previewUrl) {
    const tmpOut = `${cacheFile}.tmp.${process.pid}.opus`;
    try {
      const ff = await runCommandNoShell([
        'ffmpeg',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        fallback.previewUrl,
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
        tmpOut,
      ]);
      if (ff.exitCode === 0 && (await fileExists(tmpOut))) {
        await fs.rename(tmpOut, cacheFile);
        return { ...fallback, cachePath: cacheFile };
      }
    } catch {
      await fs.rm(tmpOut, { force: true }).catch(() => {});
    }
    return fallback;
  }

  throw new Error(`No audio match found for "${rawQuery}"`);
}
