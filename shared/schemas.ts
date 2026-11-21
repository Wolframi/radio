import { z } from 'zod';

export const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const UserRoleSchema = z.enum(['admin', 'streamer']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const BranchModeSchema = z.enum(['passthrough', 'loop', 'silence']);
export type BranchMode = z.infer<typeof BranchModeSchema>;

export const PlaybackModeSchema = z.enum(['LIVE', 'PLAYLIST', 'ORDER']);
export type PlaybackMode = z.infer<typeof PlaybackModeSchema>;

export const PlaylistModeSchema = z.enum(['sequential', 'shuffle', 'loop']);
export type PlaylistMode = z.infer<typeof PlaylistModeSchema>;

export const PlaylistResumeModeSchema = z.enum(['exact', 'next']);
export type PlaylistResumeMode = z.infer<typeof PlaylistResumeModeSchema>;

export const OrderStatusSchema = z.enum(['pending', 'downloading', 'ready', 'playing', 'failed']);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const BranchSchema = z.object({
  id: z.string().regex(SAFE_ID_REGEX, 'Invalid branch ID'),
  name: z.string().trim().min(1).max(64),
  slug: z.string().trim().toLowerCase().regex(SLUG_REGEX, 'Slug must be lowercase alphanumeric, - or _'),
  isMain: z.boolean(),
  mode: BranchModeSchema,
  loopFile: z.string().trim().max(255).optional(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const AudioConfigSchema = z.object({
  bitrateKbps: z.number().int().min(24).max(192).default(64),
  frameMs: z.union([z.literal(10), z.literal(20)]).default(20),
});
export type AudioConfig = z.infer<typeof AudioConfigSchema>;

export const UserConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    branches: z.array(BranchSchema).min(1).max(16),
    obsSceneMapping: z.record(z.string().min(1).max(128), z.string().regex(SLUG_REGEX)),
    obsWsUrl: z.string().trim().max(128).optional().default('ws://127.0.0.1:4455'),
    obsWsPassword: z.string().max(128).optional().default(''),
    audio: AudioConfigSchema,
    playlistResumeMode: PlaylistResumeModeSchema.default('exact'),
    mixOrdersInLive: z.boolean().optional().default(false),
  })
  .refine((cfg) => cfg.branches.filter((b) => b.isMain).length === 1, {
    message: 'Exactly one branch must be marked as isMain: true',
  })
  .refine(
    (cfg) => {
      const slugs = cfg.branches.map((b) => b.slug);
      return new Set(slugs).size === slugs.length;
    },
    { message: 'Branch slugs must be unique' },
  );
export type UserConfig = z.infer<typeof UserConfigSchema>;

export const PlaylistTrackSchema = z.object({
  id: z.string().regex(SAFE_ID_REGEX),
  title: z.string().trim().min(1).max(160),
  artist: z.string().trim().min(1).max(160),
  source: z.enum(['file', 'url', 'yt']),
  pathOrUrl: z.string().trim().min(1).max(1024),
  durationMs: z.number().int().min(1000).max(14_400_000),
});
export type PlaylistTrack = z.infer<typeof PlaylistTrackSchema>;

export const PlaylistPositionSchema = z.object({
  trackIndex: z.number().int().min(0),
  offsetMs: z.number().int().min(0),
});
export type PlaylistPosition = z.infer<typeof PlaylistPositionSchema>;

export const PlaylistDataSchema = z.object({
  tracks: z.array(PlaylistTrackSchema),
  mode: PlaylistModeSchema.default('sequential'),
  position: PlaylistPositionSchema.default({ trackIndex: 0, offsetMs: 0 }),
});
export type PlaylistData = z.infer<typeof PlaylistDataSchema>;

export const OrderSchema = z.object({
  id: z.string().regex(SAFE_ID_REGEX),
  query: z.string().trim().min(1).max(240),
  parsedArtist: z.string().trim().max(160).optional(),
  parsedTitle: z.string().trim().max(160).optional(),
  resolvedTitle: z.string().trim().max(200).optional(),
  resolvedArtist: z.string().trim().max(200).optional(),
  durationMs: z.number().int().min(1000).max(1_800_000).optional(),
  sourceProvider: z.enum(['yt-dlp', 'itunes', 'deezer', 'cache', 'manual']).optional(),
  previewUrl: z.string().max(1024).optional(),
  status: OrderStatusSchema,
  error: z.string().max(240).optional(),
  cachePath: z.string().max(512).optional(),
  requestedBy: z.string().trim().max(64).optional(),
  createdAt: z.string(),
});
export type Order = z.infer<typeof OrderSchema>;

export const QueueDataSchema = z.object({
  orders: z.array(OrderSchema),
});
export type QueueData = z.infer<typeof QueueDataSchema>;

export const UserRecordSchema = z.object({
  id: z.string().regex(SAFE_ID_REGEX),
  username: z.string().trim().toLowerCase().regex(SLUG_REGEX),
  passwordHash: z.string().min(20),
  role: UserRoleSchema,
  createdAt: z.string(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const UsersFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  users: z.array(UserRecordSchema),
});
export type UsersFile = z.infer<typeof UsersFileSchema>;

export const LoginInputSchema = z.object({
  username: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(128),
});

export const CreateUserInputSchema = z.object({
  username: z.string().trim().toLowerCase().regex(SLUG_REGEX, 'Username must be 1-48 chars: a-z, 0-9, -, _'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  role: UserRoleSchema.default('streamer'),
});

export const ResetPasswordInputSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const CreateOrderInputSchema = z.union([
  z.object({
    query: z.string().trim().min(2).max(240),
    requestedBy: z.string().trim().max(64).optional(),
  }),
  z.object({
    title: z.string().trim().min(1).max(120),
    artist: z.string().trim().min(1).max(120),
    requestedBy: z.string().trim().max(64).optional(),
  }),
]);

export const ReorderOrdersInputSchema = z.object({
  orderIds: z.array(z.string().regex(SAFE_ID_REGEX)).min(1).max(500),
});

export const AddTrackInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  artist: z.string().trim().min(1).max(160),
  source: z.enum(['file', 'url', 'yt']),
  pathOrUrl: z.string().trim().min(1).max(1024),
  durationMs: z.number().int().min(1000).max(14_400_000).default(180_000),
});

export const UpdatePlaylistSettingsSchema = z.object({
  mode: PlaylistModeSchema.optional(),
  trackIds: z.array(z.string().regex(SAFE_ID_REGEX)).optional(),
  position: PlaylistPositionSchema.optional(),
});

export interface PlaybackStateSnapshot {
  userSlug: string;
  mode: PlaybackMode;
  liveConnectedBranches: string[];
  subscriberCounts: Record<string, number>;
  playlistPosition: PlaylistPosition;
  currentTrack: PlaylistTrack | null;
  currentOrderId: string | null;
  currentOrder: Order | null;
  trackElapsedMs: number;
  trackDurationMs: number;
  isPlaying: boolean;
  updatedAt: number;
}

export interface StreamerAdminSummary {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  online: boolean;
  mode: PlaybackMode;
  activeBranches: string[];
  listenerCount: number;
  queueLength: number;
}

export interface PublicPlayerConfig {
  userSlug: string;
  branches: Array<{ id: string; name: string; slug: string; isMain: boolean; mode: BranchMode }>;
  obsSceneMapping: Record<string, string>;
  obsWsUrl: string;
  hasObsPassword: boolean;
  audio: AudioConfig;
}

export function createDefaultUserConfig(): UserConfig {
  return {
    schemaVersion: 1,
    branches: [
      { id: 'intro', name: 'Intro', slug: 'intro', isMain: false, mode: 'passthrough' },
      { id: 'main', name: 'Main', slug: 'main', isMain: true, mode: 'passthrough' },
      { id: 'pause', name: 'Pause', slug: 'pause', isMain: false, mode: 'loop', loopFile: 'pause.opus' },
      { id: 'ending', name: 'Ending', slug: 'ending', isMain: false, mode: 'passthrough' },
    ],
    obsSceneMapping: {
      'Intro Scene': 'intro',
      'Game Scene': 'main',
      'BRB Scene': 'pause',
      'Ending Scene': 'ending',
    },
    obsWsUrl: 'ws://127.0.0.1:4455',
    obsWsPassword: '',
    audio: {
      bitrateKbps: 64,
      frameMs: 20,
    },
    playlistResumeMode: 'exact',
    mixOrdersInLive: false,
  };
}

export function createDefaultPlaylist(): PlaylistData {
  return {
    tracks: [],
    mode: 'sequential',
    position: { trackIndex: 0, offsetMs: 0 },
  };
}

export function createDefaultQueue(): QueueData {
  return {
    orders: [],
  };
}

/**
 * Heuristic parser supporting "Artist — Title", "Artist - Title", "Artist – Title",
 * and "Title — Artist" detection when the first segment looks like a song title with remix/feat.
 */
export function parseTrackQuery(rawQuery: string): { artist: string; title: string; normalizedQuery: string } {
  const cleaned = rawQuery.replace(/\s+/g, ' ').trim();
  const separators = [' — ', ' – ', ' - ', ' —', '— ', ' -', '- '];
  for (const sep of separators) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0 && idx + sep.length < cleaned.length) {
      const left = cleaned.slice(0, idx).trim();
      const right = cleaned.slice(idx + sep.length).trim();
      const leftLooksLikeTitle = /\((remix|acoustic|live|slowed|edit|ost|feat\.?)/i.test(left);
      if (leftLooksLikeTitle) {
        return { artist: right, title: left, normalizedQuery: `${right} ${left}` };
      }
      return { artist: left, title: right, normalizedQuery: `${left} ${right}` };
    }
  }
  return { artist: '', title: cleaned, normalizedQuery: cleaned };
}
