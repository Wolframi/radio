import type {
  Order,
  PlaybackMode,
  PlaybackStateSnapshot,
  PlaylistData,
  PlaylistMode,
  PublicPlayerConfig,
  StreamerAdminSummary,
  UserConfig,
  UserRole,
} from '../../shared/schemas';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface SetupStatusResponse {
  authDisabled: boolean;
  needsAdminSetup: boolean;
  envAdminConfigured: boolean;
  streamerSlugs: string[];
}

async function apiRequest<T>(
  url: string,
  opts: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  const resp = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
  }
  return data as T;
}

export const api = {
  getSetupStatus: () => apiRequest<SetupStatusResponse>('/api/auth/setup-status'),

  getPreviewSession: () =>
    apiRequest<{ token: string; user: AuthUser }>('/api/auth/preview-session', {
      method: 'POST',
    }),

  setupAdmin: (payload: {
    adminPassword: string;
    initialStreamerUsername?: string;
    initialStreamerPassword?: string;
  }) =>
    apiRequest<{ token: string; user: AuthUser; createdStreamer: string | null }>('/api/auth/setup-admin', {
      method: 'POST',
      body: payload,
    }),

  login: (username: string, password: string) =>
    apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    }),

  me: (token: string) => apiRequest<AuthUser>('/api/me', { token }),

  getAdminUsers: (token: string) => apiRequest<{ users: StreamerAdminSummary[] }>('/api/admin/users', { token }),

  createUser: (token: string, payload: { username: string; password: string; role: UserRole }) =>
    apiRequest<{ user: AuthUser & { createdAt: string } }>('/api/admin/users', {
      method: 'POST',
      token,
      body: payload,
    }),

  resetUserPassword: (token: string, userId: string, password: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      token,
      body: { password },
    }),

  getPublicConfig: (userSlug: string) =>
    apiRequest<PublicPlayerConfig>(`/api/public/${encodeURIComponent(userSlug)}/config`),

  getConfig: (token: string, userSlug: string) =>
    apiRequest<UserConfig>(`/api/${encodeURIComponent(userSlug)}/config`, { token }),

  putConfig: (token: string, userSlug: string, config: UserConfig) =>
    apiRequest<UserConfig>(`/api/${encodeURIComponent(userSlug)}/config`, {
      method: 'PUT',
      token,
      body: config,
    }),

  getPlayback: (token: string, userSlug: string) =>
    apiRequest<PlaybackStateSnapshot>(`/api/${encodeURIComponent(userSlug)}/playback`, { token }),

  setPlaybackMode: (token: string, userSlug: string, mode: PlaybackMode) =>
    apiRequest<PlaybackStateSnapshot>(`/api/${encodeURIComponent(userSlug)}/playback/mode`, {
      method: 'POST',
      token,
      body: { mode },
    }),

  finishCurrentTrack: (token: string, userSlug: string) =>
    apiRequest<PlaybackStateSnapshot>(`/api/${encodeURIComponent(userSlug)}/playback/finish-current`, {
      method: 'POST',
      token,
    }),

  playPlaylistTrack: (token: string, userSlug: string, trackIndex: number, offsetMs = 0) =>
    apiRequest<PlaybackStateSnapshot>(`/api/${encodeURIComponent(userSlug)}/playback/play-track`, {
      method: 'POST',
      token,
      body: { trackIndex, offsetMs },
    }),

  broadcastVirtualObsScene: (token: string, userSlug: string, sceneName: string) =>
    apiRequest<{ ok: boolean; sceneName: string }>(`/api/${encodeURIComponent(userSlug)}/obs/scene`, {
      method: 'POST',
      token,
      body: { sceneName },
    }),

  getPlaylist: (token: string, userSlug: string) =>
    apiRequest<PlaylistData>(`/api/${encodeURIComponent(userSlug)}/playlist`, { token }),

  addTrack: (
    token: string,
    userSlug: string,
    track: { title: string; artist: string; source: 'file' | 'url' | 'yt'; pathOrUrl: string; durationMs: number },
  ) =>
    apiRequest<{ playlist: PlaylistData }>(`/api/${encodeURIComponent(userSlug)}/playlist`, {
      method: 'POST',
      token,
      body: track,
    }),

  patchPlaylist: (
    token: string,
    userSlug: string,
    patch: { mode?: PlaylistMode; trackIds?: string[]; position?: { trackIndex: number; offsetMs: number } },
  ) =>
    apiRequest<PlaylistData>(`/api/${encodeURIComponent(userSlug)}/playlist`, {
      method: 'PATCH',
      token,
      body: patch,
    }),

  deleteTrack: (token: string, userSlug: string, trackId: string) =>
    apiRequest<PlaylistData>(`/api/${encodeURIComponent(userSlug)}/playlist/${encodeURIComponent(trackId)}`, {
      method: 'DELETE',
      token,
    }),

  getOrders: (userSlug: string) =>
    apiRequest<{ orders: Order[]; playback: PlaybackStateSnapshot }>(`/api/${encodeURIComponent(userSlug)}/orders`),

  createOrder: (userSlug: string, payload: { query: string; requestedBy?: string } | { title: string; artist: string; requestedBy?: string }) =>
    apiRequest<{ order: Order }>(`/api/${encodeURIComponent(userSlug)}/orders`, {
      method: 'POST',
      body: payload,
    }),

  deleteOrder: (token: string, userSlug: string, orderId: string) =>
    apiRequest<{ orders: Order[] }>(`/api/${encodeURIComponent(userSlug)}/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      token,
    }),

  reorderOrders: (token: string, userSlug: string, orderIds: string[]) =>
    apiRequest<{ orders: Order[] }>(`/api/${encodeURIComponent(userSlug)}/orders/reorder`, {
      method: 'PATCH',
      token,
      body: { orderIds },
    }),

  getBlueprintTree: () => apiRequest<{ root: string; files: string[] }>('/api/blueprint/tree'),

  getBlueprintFile: (filePath: string) =>
    apiRequest<{ path: string; content: string }>(`/api/blueprint/file?path=${encodeURIComponent(filePath)}`),
};
