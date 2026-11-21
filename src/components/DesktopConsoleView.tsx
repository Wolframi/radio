import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  ListMusic,
  LogOut,
  Monitor,
  Play,
  Plus,
  Radio,
  Settings,
  SkipForward,
  Sliders,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  Branch,
  BranchMode,
  Order,
  PlaybackMode,
  PlaybackStateSnapshot,
  PlaylistData,
  PlaylistMode,
  UserConfig,
} from '../../shared/schemas';
import { api, type AuthUser, type SetupStatusResponse } from '../lib/api';
import {
  BrowserBranchIngest,
  BrowserBranchPlayer,
  type IngestTelemetry,
  type PlayerTelemetry,
} from '../lib/audio-engine';

type DesktopTab = 'connection' | 'branches' | 'playlist' | 'queue' | 'obs' | 'settings' | 'repo';

const SIDEBAR_TABS: Array<{ key: DesktopTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'connection', label: 'Подключение', icon: Radio },
  { key: 'branches', label: 'Ветви', icon: GitBranch },
  { key: 'playlist', label: 'Плейлист', icon: ListMusic },
  { key: 'queue', label: 'Очередь', icon: Sliders },
  { key: 'obs', label: 'OBS-сцены', icon: Monitor },
  { key: 'settings', label: 'Настройки', icon: Settings },
  { key: 'repo', label: 'Репозиторий', icon: Code2 },
];

const SIMULATED_WASAPI_DEVICES = [
  { id: 'wasapi-default', name: 'System Mixer (WASAPI Loopback)' },
  { id: 'wasapi-spotify', name: 'Per-Process: Spotify.exe (Win10 2004+)' },
  { id: 'wasapi-chrome', name: 'Per-Process: chrome.exe (YouTube Music)' },
  { id: 'wasapi-browser-mic', name: 'Browser Microphone (Live WebAudio)' },
];

const BRANCH_FREQS: Record<string, number> = {
  intro: 220,
  main: 293.66,
  pause: 196,
  ending: 261.63,
};

interface DesktopConsoleViewProps {
  token: string | null;
  user: AuthUser | null;
  setupStatus: SetupStatusResponse | null;
  onAuthChange: (token: string | null, user: AuthUser | null) => void;
  onNavigate: (path: string) => void;
}

export function DesktopConsoleView({
  token,
  user,
  setupStatus,
  onAuthChange,
  onNavigate,
}: DesktopConsoleViewProps) {
  const [tab, setTab] = useState<DesktopTab>('connection');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Target streamer slug (when admin logs in, admin can manage any streamer or self)
  const [activeTenantSlug, setActiveTenantSlug] = useState<string>('');

  const [config, setConfig] = useState<UserConfig | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistData | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [playback, setPlayback] = useState<PlaybackStateSnapshot | null>(null);
  const [virtualObsScene, setVirtualObsScene] = useState<string>('Game Scene');
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Live capture per branch
  const ingestsRef = useRef<Map<string, BrowserBranchIngest>>(new Map());
  const [selectedSourceByBranch, setSelectedSourceByBranch] = useState<Record<string, string>>({});
  const [telemetryByBranch, setTelemetryByBranch] = useState<Record<string, IngestTelemetry>>({});
  const [activeIngests, setActiveIngests] = useState<Record<string, boolean>>({});

  // Integrated Live Audio Monitor (real WebSocket -> AudioWorklet playback inside console)
  const monitorPlayerRef = useRef<BrowserBranchPlayer | null>(null);
  const [monitoringBranch, setMonitoringBranch] = useState<string | null>(null);
  const [monitorTelemetry, setMonitorTelemetry] = useState<PlayerTelemetry | null>(null);

  // Form inputs
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchSlug, setNewBranchSlug] = useState('');
  const [newBranchMode, setNewBranchMode] = useState<BranchMode>('passthrough');

  const [trackTitle, setTrackTitle] = useState('');
  const [trackArtist, setTrackArtist] = useState('');
  const [trackSource, setTrackSource] = useState<'file' | 'url' | 'yt'>('file');
  const [trackPath, setTrackPath] = useState('/media/track.opus');
  const [trackDurationSec, setTrackDurationSec] = useState(45);

  const [manualOrderQuery, setManualOrderQuery] = useState('');
  const [newSceneName, setNewSceneName] = useState('');
  const [newSceneBranch, setNewSceneBranch] = useState('main');

  // Monorepo Blueprint explorer
  const [blueprintFiles, setBlueprintFiles] = useState<string[]>([]);
  const [selectedBlueprintPath, setSelectedBlueprintPath] = useState<string>('DECISIONS.md');
  const [selectedBlueprintContent, setSelectedBlueprintContent] = useState<string>('');

  useEffect(() => {
    if (!user) {
      setActiveTenantSlug('');
      return;
    }
    if (user.role === 'streamer') {
      setActiveTenantSlug(user.username);
    } else if (!activeTenantSlug || activeTenantSlug === 'admin') {
      const firstStreamer = setupStatus?.streamerSlugs[0];
      if (firstStreamer) {
        setActiveTenantSlug(firstStreamer);
      } else if (!activeTenantSlug) {
        setActiveTenantSlug(user.username);
      }
    }
  }, [user, setupStatus, activeTenantSlug]);

  // Cleanup ingests & live audio monitor on unmount or logout
  useEffect(() => {
    return () => {
      for (const ing of ingestsRef.current.values()) {
        ing.stop();
      }
      ingestsRef.current.clear();
      monitorPlayerRef.current?.stop();
      monitorPlayerRef.current = null;
    };
  }, []);

  // Load tenant state + subscribe to real-time WS events
  useEffect(() => {
    if (!token || !activeTenantSlug) return;
    let cancelled = false;

    void Promise.all([
      api.getConfig(token, activeTenantSlug),
      api.getPlaylist(token, activeTenantSlug),
      api.getOrders(activeTenantSlug),
      api.getPlayback(token, activeTenantSlug),
    ])
      .then(([cfg, pl, ordRes, pb]) => {
        if (cancelled) return;
        setConfig(cfg);
        setPlaylist(pl);
        setOrders(ordRes.orders);
        setPlayback(pb);
        const firstScene = Object.keys(cfg.obsSceneMapping)[0];
        if (firstScene) setVirtualObsScene(firstScene);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice(err instanceof Error ? err.message : 'Ошибка загрузки данных');
      });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/events/${encodeURIComponent(activeTenantSlug)}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'sync') {
          if (msg.data.state) setPlayback(msg.data.state);
          if (msg.data.queue) setOrders(msg.data.queue);
          if (msg.data.playlist) setPlaylist(msg.data.playlist);
          if (msg.data.config) setConfig(msg.data.config);
          if (msg.data.virtualObsScene) setVirtualObsScene(msg.data.virtualObsScene);
        } else if (msg.event === 'playback:state') {
          setPlayback(msg.data);
        } else if (msg.event === 'queue:updated') {
          setOrders(msg.data);
        } else if (msg.event === 'playlist:updated') {
          setPlaylist(msg.data);
        } else if (msg.event === 'config:updated') {
          setConfig(msg.data);
        } else if (msg.event === 'obs:scene' && msg.data?.sceneName) {
          setVirtualObsScene(msg.data.sceneName);
        }
      } catch {
        // ignore
      }
    };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [token, activeTenantSlug]);

  // Load monorepo blueprint tree when repo tab opened
  useEffect(() => {
    if (tab !== 'repo') return;
    if (blueprintFiles.length === 0) {
      void api.getBlueprintTree().then((res) => setBlueprintFiles(res.files)).catch(() => {});
    }
  }, [tab, blueprintFiles.length]);

  useEffect(() => {
    if (tab !== 'repo' || !selectedBlueprintPath) return;
    void api
      .getBlueprintFile(selectedBlueprintPath)
      .then((res) => setSelectedBlueprintContent(res.content))
      .catch(() => setSelectedBlueprintContent('Unable to read file.'));
  }, [tab, selectedBlueprintPath]);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((prev) => (prev === msg ? null : prev)), 3500);
  }, []);

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // ignore
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      const res = await api.login(loginUsername, loginPassword);
      onAuthChange(res.token, res.user);
      setLoginPassword('');
    } catch (err: unknown) {
      setLoginError(err instanceof Error ? err.message : 'Ошибка входа');
    } finally {
      setLoggingIn(false);
    }
  }

  function stopMonitor() {
    monitorPlayerRef.current?.stop();
    monitorPlayerRef.current = null;
    setMonitoringBranch(null);
    setMonitorTelemetry(null);
  }

  async function startMonitor(branchSlug: string) {
    if (!activeTenantSlug) return;
    if (monitoringBranch === branchSlug && monitorPlayerRef.current) {
      await monitorPlayerRef.current.resumeAudio();
      monitorPlayerRef.current.setMuted(false);
      return;
    }
    monitorPlayerRef.current?.stop();
    const player = new BrowserBranchPlayer({
      userSlug: activeTenantSlug,
      branchSlug,
      targetBufferMs: 60,
      onTelemetry: (tel) => setMonitorTelemetry(tel),
    });
    monitorPlayerRef.current = player;
    setMonitoringBranch(branchSlug);
    try {
      await player.start(false);
      await player.resumeAudio();
    } catch (err: unknown) {
      stopMonitor();
      showNotice(err instanceof Error ? err.message : 'Ошибка запуска аудиомонитора');
    }
  }

  async function toggleMonitor(branchSlug?: string) {
    const targetBranch = branchSlug || config?.branches.find((b) => b.isMain)?.slug || 'main';
    if (monitoringBranch === targetBranch) {
      stopMonitor();
      return;
    }
    await startMonitor(targetBranch);
  }

  function handleLogout() {
    for (const ing of ingestsRef.current.values()) {
      ing.stop();
    }
    ingestsRef.current.clear();
    stopMonitor();
    setActiveIngests({});
    setTelemetryByBranch({});
    onAuthChange(null, null);
  }

  async function toggleBranchIngest(branch: Branch) {
    if (!token || !activeTenantSlug || !config) return;
    const existing = ingestsRef.current.get(branch.slug);
    if (existing) {
      existing.stop();
      ingestsRef.current.delete(branch.slug);
      setActiveIngests((prev) => ({ ...prev, [branch.slug]: false }));
      return;
    }

    const selectedDevice = selectedSourceByBranch[branch.slug] || 'wasapi-default';
    const ingest = new BrowserBranchIngest({
      userSlug: activeTenantSlug,
      branchSlug: branch.slug,
      token,
      frameMs: config.audio.frameMs,
      sourceKind: selectedDevice === 'wasapi-browser-mic' ? 'microphone' : 'synth',
      synthFreqHz: BRANCH_FREQS[branch.slug] ?? 246.94,
      onTelemetry: (tel) => {
        setTelemetryByBranch((prev) => ({ ...prev, [branch.slug]: tel }));
      },
    });

    try {
      await ingest.start();
      ingestsRef.current.set(branch.slug, ingest);
      setActiveIngests((prev) => ({ ...prev, [branch.slug]: true }));
    } catch (err: unknown) {
      showNotice(err instanceof Error ? err.message : 'Ошибка запуска захвата');
    }
  }

  async function saveConfig(nextCfg: UserConfig, msg = 'Конфигурация сохранена') {
    if (!token || !activeTenantSlug) return;
    try {
      const saved = await api.putConfig(token, activeTenantSlug, nextCfg);
      setConfig(saved);
      showNotice(msg);
    } catch (err: unknown) {
      showNotice(err instanceof Error ? err.message : 'Ошибка сохранения конфигурации');
    }
  }

  async function handleAddBranch(e: React.FormEvent) {
    e.preventDefault();
    if (!config || !newBranchName.trim() || !newBranchSlug.trim()) return;
    const slug = newBranchSlug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return;
    const next: UserConfig = {
      ...config,
      branches: [
        ...config.branches,
        {
          id: slug,
          name: newBranchName.trim(),
          slug,
          isMain: false,
          mode: newBranchMode,
          ...(newBranchMode === 'loop' ? { loopFile: `${slug}.opus` } : {}),
        },
      ],
    };
    await saveConfig(next, `Ветвь ${slug} добавлена`);
    setNewBranchName('');
    setNewBranchSlug('');
  }

  async function handleSetMainBranch(branchId: string) {
    if (!config) return;
    const next: UserConfig = {
      ...config,
      branches: config.branches.map((b) => ({
        ...b,
        isMain: b.id === branchId,
        mode: b.id === branchId ? 'passthrough' : b.mode,
      })),
    };
    await saveConfig(next, 'Основная ветвь обновлена');
  }

  async function handleBranchModeChange(branchId: string, mode: BranchMode) {
    if (!config) return;
    const next: UserConfig = {
      ...config,
      branches: config.branches.map((b) =>
        b.id === branchId
          ? { ...b, mode, loopFile: mode === 'loop' ? b.loopFile || `${b.slug}.opus` : b.loopFile }
          : b,
      ),
    };
    await saveConfig(next, 'Режим ветви обновлён');
  }

  async function handleDeleteBranch(branchId: string) {
    if (!config) return;
    const target = config.branches.find((b) => b.id === branchId);
    if (!target || target.isMain) {
      showNotice('Нельзя удалить основную ветвь (isMain: true)');
      return;
    }
    const nextMapping = Object.fromEntries(
      Object.entries(config.obsSceneMapping).filter(([, slug]) => slug !== target.slug),
    );
    await saveConfig(
      {
        ...config,
        branches: config.branches.filter((b) => b.id !== branchId),
        obsSceneMapping: nextMapping,
      },
      `Ветвь ${target.slug} удалена`,
    );
  }

  async function handleAddTrack(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !activeTenantSlug || !trackTitle.trim() || !trackArtist.trim()) return;
    try {
      const res = await api.addTrack(token, activeTenantSlug, {
        title: trackTitle.trim(),
        artist: trackArtist.trim(),
        source: trackSource,
        pathOrUrl: trackPath.trim(),
        durationMs: Math.max(5, trackDurationSec) * 1000,
      });
      setPlaylist(res.playlist);
      setTrackTitle('');
      setTrackArtist('');
      showNotice('Трек добавлен в плейлист');
    } catch (err: unknown) {
      showNotice(err instanceof Error ? err.message : 'Ошибка добавления трека');
    }
  }

  async function handleMoveTrack(index: number, delta: -1 | 1) {
    if (!token || !activeTenantSlug || !playlist) return;
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= playlist.tracks.length) return;
    const ids = playlist.tracks.map((t) => t.id);
    [ids[index], ids[targetIdx]] = [ids[targetIdx], ids[index]];
    const updated = await api.patchPlaylist(token, activeTenantSlug, { trackIds: ids });
    setPlaylist(updated);
  }

  async function handlePlaylistMode(mode: PlaylistMode) {
    if (!token || !activeTenantSlug) return;
    const updated = await api.patchPlaylist(token, activeTenantSlug, { mode });
    setPlaylist(updated);
  }

  async function handleDeleteTrack(trackId: string) {
    if (!token || !activeTenantSlug) return;
    const updated = await api.deleteTrack(token, activeTenantSlug, trackId);
    setPlaylist(updated);
  }

  async function handleAddManualOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!activeTenantSlug || !manualOrderQuery.trim()) return;
    try {
      await api.createOrder(activeTenantSlug, {
        query: manualOrderQuery.trim(),
        requestedBy: user?.username || 'streamer',
      });
      setManualOrderQuery('');
      showNotice('Заказ добавлен в очередь');
    } catch (err: unknown) {
      showNotice(err instanceof Error ? err.message : 'Ошибка заказа');
    }
  }

  async function handleMoveOrder(index: number, delta: -1 | 1) {
    if (!token || !activeTenantSlug) return;
    const target = index + delta;
    if (target < 0 || target >= orders.length) return;
    const ids = orders.map((o) => o.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const res = await api.reorderOrders(token, activeTenantSlug, ids);
    setOrders(res.orders);
  }

  async function handleDeleteOrder(orderId: string) {
    if (!token || !activeTenantSlug) return;
    const res = await api.deleteOrder(token, activeTenantSlug, orderId);
    setOrders(res.orders);
  }

  async function handleSetMode(mode: PlaybackMode) {
    if (!token || !activeTenantSlug) return;
    const snap = await api.setPlaybackMode(token, activeTenantSlug, mode);
    setPlayback(snap);
  }

  async function handleFinishTrackNow() {
    if (!token || !activeTenantSlug) return;
    const snap = await api.finishCurrentTrack(token, activeTenantSlug);
    setPlayback(snap);
  }

  async function handlePlayTrackIndex(trackIndex: number) {
    if (!token || !activeTenantSlug) return;
    const snap = await api.playPlaylistTrack(token, activeTenantSlug, trackIndex, 0);
    setPlayback(snap);
    const mainSlug = config?.branches.find((b) => b.isMain)?.slug || 'main';
    if (!monitoringBranch) {
      await startMonitor(mainSlug);
    }
  }

  async function handleAddSceneMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!config || !newSceneName.trim()) return;
    const next: UserConfig = {
      ...config,
      obsSceneMapping: {
        ...config.obsSceneMapping,
        [newSceneName.trim()]: newSceneBranch,
      },
    };
    await saveConfig(next, 'Сцена OBS привязана');
    setNewSceneName('');
  }

  async function handleRemoveSceneMapping(sceneName: string) {
    if (!config) return;
    const copy = { ...config.obsSceneMapping };
    delete copy[sceneName];
    await saveConfig({ ...config, obsSceneMapping: copy }, 'Привязка сцены удалена');
  }

  async function handleSwitchVirtualScene(sceneName: string) {
    setVirtualObsScene(sceneName);
    if (!token || !activeTenantSlug) return;
    await api.broadcastVirtualObsScene(token, activeTenantSlug, sceneName);
    const mappedBranch = config?.obsSceneMapping[sceneName];
    if (monitoringBranch && mappedBranch && mappedBranch !== monitoringBranch) {
      await startMonitor(mappedBranch);
    }
  }

  const formatMs = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="flex min-h-screen bg-[#111214] text-[#e5e7eb]">
      {/* Left Navigation Rail (240px) */}
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-[#24272f] bg-[#15171b]">
        <div className="flex h-[57px] items-center border-b border-[#24272f] px-5">
          <span className="text-[15px] font-semibold tracking-tight text-white whitespace-nowrap">
            Streamer Radio
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 p-3">
          {SIDEBAR_TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-left text-[13px] font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#23262e] text-white'
                    : 'text-[#9ca3af] hover:bg-[#1b1e24] hover:text-[#e5e7eb]'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-[#24272f] p-3 space-y-1.5">
          {user?.role === 'admin' && (
            <button
              onClick={() => onNavigate('/admin')}
              className="flex w-full items-center justify-between rounded-[6px] px-3 py-2 text-xs font-medium text-[#d1d5db] hover:bg-[#1e2128]"
            >
              <span>Админ-панель</span>
              <ExternalLink className="h-3.5 w-3.5 text-[#6b7280]" />
            </button>
          )}
          {!user && (
            <button
              onClick={() => onNavigate('/admin')}
              className="flex w-full items-center justify-between rounded-[6px] px-3 py-2 text-xs text-[#9ca3af] hover:bg-[#1e2128] hover:text-white"
            >
              <span>Админ-панель</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
          {activeTenantSlug && (
            <button
              onClick={() => onNavigate(`/order/${activeTenantSlug}`)}
              className="flex w-full items-center justify-between rounded-[6px] px-3 py-2 text-xs text-[#9ca3af] hover:bg-[#1e2128] hover:text-white"
            >
              <span>Страница заказов</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </aside>

      {/* Main Viewport */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar (3-zone contract: Breadcrumb — Context — Primary Action) */}
        <header className="flex h-[57px] items-center justify-between gap-8 border-b border-[#24272f] bg-[#15171b] px-6">
          <div className="flex items-center gap-2 text-sm text-[#9ca3af] whitespace-nowrap shrink-0">
            <span>Desktop App</span>
            <span aria-hidden="true">/</span>
            <span className="font-medium text-white">
              {SIDEBAR_TABS.find((t) => t.key === tab)?.label}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-[#9ca3af] whitespace-nowrap shrink-0">
            {user && playback && (
              <div className="flex items-center gap-2 font-mono tabular-nums">
                <span className={playback.mode === 'LIVE' ? 'text-[#22c55e]' : 'text-[#e5e7eb]'}>
                  {playback.mode}
                </span>
                <span aria-hidden="true">·</span>
                <span>Ветвей: {config?.branches.length ?? 0}</span>
                <span aria-hidden="true">·</span>
                <span>Очередь: {orders.length}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <>
                <button
                  onClick={() => void toggleMonitor()}
                  className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    monitoringBranch
                      ? 'border border-[#22c55e]/40 bg-[#17281e] text-[#4ade80] hover:bg-[#1c3325]'
                      : 'bg-[#e5e7eb] text-[#111214] hover:bg-white'
                  }`}
                >
                  {monitoringBranch ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  {monitoringBranch
                    ? `Эфир /${monitoringBranch}${monitorTelemetry ? ` · ${monitorTelemetry.bufferMs}ms` : ''}`
                    : 'Слушать эфир'}
                </button>
                {user.role === 'admin' && setupStatus && setupStatus.streamerSlugs.length > 0 && (
                  <select
                    value={activeTenantSlug}
                    onChange={(e) => setActiveTenantSlug(e.target.value)}
                    className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-2.5 py-1.5 font-mono text-xs text-white focus:outline-none"
                    aria-label="Выбор стримера"
                  >
                    <option value={user.username}>{user.username}</option>
                    {setupStatus.streamerSlugs.map((slug) => (
                      <option key={slug} value={slug}>
                        {slug}
                      </option>
                    ))}
                  </select>
                )}
                {!setupStatus?.authDisabled && (
                  <button
                    onClick={handleLogout}
                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs font-medium text-[#e5e7eb] hover:bg-[#262a32] whitespace-nowrap shrink-0"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Выйти ({user.username})
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => onNavigate('/admin')}
                className="rounded-[6px] bg-[#e5e7eb] px-3.5 py-1.5 text-xs font-semibold text-[#111214] hover:bg-white whitespace-nowrap shrink-0"
              >
                {setupStatus?.needsAdminSetup ? 'Настроить админа' : 'Админ-панель'}
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-[1100px]">
            {notice && (
              <div className="mb-5 rounded-[6px] border border-[#2f343d] bg-[#1a1d23] px-4 py-2.5 text-xs text-[#e5e7eb]">
                {notice}
              </div>
            )}

            {/* Blueprint Repo Explorer is always accessible even before login */}
            {tab === 'repo' ? (
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-[290px_1fr]">
                <div className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
                  <div className="border-b border-[#24272f] px-4 py-3 text-xs font-semibold text-white">
                    streamer-radio/ ({blueprintFiles.length} файлов)
                  </div>
                  <div className="max-h-[620px] overflow-y-auto p-2 font-mono text-xs">
                    {blueprintFiles.map((file) => (
                      <button
                        key={file}
                        onClick={() => setSelectedBlueprintPath(file)}
                        className={`block w-full truncate rounded-[6px] px-2.5 py-1.5 text-left transition-colors ${
                          selectedBlueprintPath === file
                            ? 'bg-[#262a33] text-white'
                            : 'text-[#9ca3af] hover:bg-[#1e2128] hover:text-[#e5e7eb]'
                        }`}
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col rounded-[8px] border border-[#282c34] bg-[#17191d]">
                  <div className="flex items-center justify-between border-b border-[#24272f] px-4 py-3">
                    <span className="font-mono text-xs text-white">streamer-radio/{selectedBlueprintPath}</span>
                    <button
                      onClick={() => void copyText('repo-file', selectedBlueprintContent)}
                      className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-2.5 py-1 text-xs text-[#d1d5db] hover:bg-[#262a32]"
                    >
                      {copiedKey === 'repo-file' ? <Check className="h-3.5 w-3.5 text-[#22c55e]" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedKey === 'repo-file' ? 'Скопировано' : 'Копировать'}
                    </button>
                  </div>
                  <pre className="max-h-[620px] overflow-auto p-4 font-mono text-xs leading-relaxed text-[#d1d5db]">
                    <code>{selectedBlueprintContent}</code>
                  </pre>
                </div>
              </section>
            ) : !token || !user ? (
              /* Login Gate — note: "Создать пользователя" is explicitly unavailable to streamers */
              <section className="mx-auto mt-10 max-w-[440px] rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
                <h1 className="text-lg font-semibold text-white">Подключение стримера</h1>
                <p className="mt-1.5 text-xs leading-relaxed text-[#9ca3af]">
                  Войдите с учётными данными, выданными администратором. Аккаунты создаются только в админ-панели.
                </p>

                {setupStatus?.needsAdminSetup && (
                  <div className="mt-4 rounded-[6px] border border-[#3a3525] bg-[#1c1a14] p-3 text-xs text-[#e5d5a8]">
                    Сервер ещё не инициализирован. Перейдите в{' '}
                    <button onClick={() => onNavigate('/admin')} className="font-semibold underline">
                      Админ-панель
                    </button>
                    , чтобы задать пароль администратора и создать первого стримера.
                  </div>
                )}

                <form onSubmit={handleLogin} className="mt-5 space-y-3.5">
                  <div>
                    <label className="mb-1 block text-xs text-[#9ca3af]">Логин</label>
                    <input
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="streamer1"
                      required
                      className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-[#9ca3af]">Пароль</label>
                    <input
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                    />
                  </div>
                  {loginError && <p className="text-xs text-[#ef4444]">{loginError}</p>}
                  <button
                    type="submit"
                    disabled={loggingIn}
                    className="w-full rounded-[6px] bg-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-[#111214] hover:bg-white disabled:opacity-50"
                  >
                    {loggingIn ? 'Подключение...' : 'Войти'}
                  </button>
                </form>
              </section>
            ) : (
              /* Authenticated Desktop Console Tabs */
              <div className="space-y-6">
                {/* TAB 1: ПОДКЛЮЧЕНИЕ */}
                {tab === 'connection' && config && (
                  <>
                    {/* Main Branch Playback Engine Bar */}
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <div className="text-xs text-[#9ca3af]">
                            Основная ветвь (<span className="font-mono text-[#e5e7eb]">{config.branches.find((b) => b.isMain)?.slug}</span>)
                            {' · '}
                            Резюме плейлиста: <span className="font-mono text-[#e5e7eb]">{config.playlistResumeMode}</span>
                          </div>
                          <div className="mt-1.5 text-base font-semibold text-white">
                            {playback?.mode === 'LIVE'
                              ? 'LIVE — Прямой захват с ПК'
                              : playback?.mode === 'ORDER' && playback.currentOrder
                                ? `ORDER — ${playback.currentOrder.resolvedArtist || ''} ${playback.currentOrder.resolvedTitle || playback.currentOrder.query}`
                                : playback?.currentTrack
                                  ? `PLAYLIST — ${playback.currentTrack.artist} — ${playback.currentTrack.title}`
                                  : 'PLAYLIST — Плейлист пуст'}
                          </div>
                          {playback && playback.mode !== 'LIVE' && playback.trackDurationMs > 0 && (
                            <div className="mt-2 flex items-center gap-3">
                              <div className="h-1.5 w-[240px] overflow-hidden rounded-[4px] bg-[#242830]">
                                <div
                                  className="h-full bg-[#e5e7eb]"
                                  style={{
                                    width: `${Math.min(100, Math.round((playback.trackElapsedMs / playback.trackDurationMs) * 100))}%`,
                                  }}
                                />
                              </div>
                              <span className="font-mono text-xs text-[#9ca3af] tabular-nums">
                                {formatMs(playback.trackElapsedMs)} / {formatMs(playback.trackDurationMs)}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex items-center rounded-[6px] border border-[#2f343d] bg-[#111214] p-0.5">
                            {(['LIVE', 'PLAYLIST', 'ORDER'] as PlaybackMode[]).map((m) => (
                              <button
                                key={m}
                                onClick={() => void handleSetMode(m)}
                                className={`rounded-[5px] px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                                  playback?.mode === m ? 'bg-[#2a2e37] text-white' : 'text-[#9ca3af] hover:text-white'
                                }`}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                          {playback?.mode !== 'LIVE' && (
                            <button
                              onClick={() => void handleFinishTrackNow()}
                              title="Завершить текущий трек сейчас (проверка перехода к заказу без прерывания)"
                              className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs font-medium text-[#e5e7eb] hover:bg-[#262a32] whitespace-nowrap"
                            >
                              <SkipForward className="h-3.5 w-3.5" />
                              Доиграть трек
                            </button>
                          )}
                        </div>
                      </div>
                    </section>

                    {/* Branch Capture Strips */}
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
                      <div className="flex items-center justify-between border-b border-[#24272f] px-5 py-3.5">
                        <h2 className="text-sm font-semibold text-white">Захват аудио по ветвям</h2>
                        <span className="font-mono text-xs text-[#9ca3af] tabular-nums">
                          Opus 48 kHz · {config.audio.bitrateKbps} kbps · {config.audio.frameMs} ms
                        </span>
                      </div>

                      <div className="divide-y divide-[#22252d]">
                        {config.branches.map((branch) => {
                          const isStreaming = Boolean(activeIngests[branch.slug]);
                          const tel = telemetryByBranch[branch.slug];
                          const listeners = playback?.subscriberCounts[branch.slug] ?? 0;
                          const levelPct = tel ? Math.max(0, Math.min(100, Math.round(((tel.levelDb + 72) / 72) * 100))) : 0;

                          return (
                            <div key={branch.id} className="p-5">
                              <div className="flex flex-wrap items-center justify-between gap-4">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                                    <span>{branch.name}</span>
                                    <span className="font-mono text-xs font-normal text-[#9ca3af]">
                                      /{branch.slug}
                                    </span>
                                    <span className="text-xs font-normal text-[#6b7280]">
                                      · {branch.isMain ? 'Основная (очередь заказов)' : branch.mode}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs text-[#9ca3af] tabular-nums">
                                    <span className={isStreaming ? 'text-[#22c55e]' : 'text-[#6b7280]'}>
                                      {isStreaming ? 'В эфире' : 'Остановлен'}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>Слушателей: {listeners}</span>
                                    {tel && isStreaming && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span>RTT {tel.rttMs} ms</span>
                                        <span aria-hidden="true">·</span>
                                        <span>Buf {tel.bufferMs} ms</span>
                                        <span aria-hidden="true">·</span>
                                        <span>Drop {tel.droppedFrames}</span>
                                        <span aria-hidden="true">·</span>
                                        <span>{tel.levelDb.toFixed(1)} dB</span>
                                      </>
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-center gap-2.5">
                                  <select
                                    value={selectedSourceByBranch[branch.slug] || 'wasapi-default'}
                                    onChange={(e) =>
                                      setSelectedSourceByBranch((prev) => ({
                                        ...prev,
                                        [branch.slug]: e.target.value,
                                      }))
                                    }
                                    disabled={isStreaming}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-1.5 text-xs text-[#e5e7eb] disabled:opacity-50"
                                  >
                                    {SIMULATED_WASAPI_DEVICES.map((d) => (
                                      <option key={d.id} value={d.id}>
                                        {d.name}
                                      </option>
                                    ))}
                                  </select>

                                  <button
                                    onClick={() => void toggleMonitor(branch.slug)}
                                    className={`inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                                      monitoringBranch === branch.slug
                                        ? 'border-[#22c55e]/40 bg-[#17281e] text-[#4ade80]'
                                        : 'border-[#2f343d] bg-[#1d2026] text-[#d1d5db] hover:bg-[#262a32]'
                                    }`}
                                  >
                                    {monitoringBranch === branch.slug ? (
                                      <Volume2 className="h-3.5 w-3.5" />
                                    ) : (
                                      <VolumeX className="h-3.5 w-3.5" />
                                    )}
                                    {monitoringBranch === branch.slug ? 'Звук вкл' : 'Слушать'}
                                  </button>

                                  <button
                                    onClick={() => void toggleBranchIngest(branch)}
                                    className={`inline-flex items-center gap-1.5 rounded-[6px] px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                                      isStreaming
                                        ? 'border border-[#472529] bg-[#2a1719] text-[#fca5a5] hover:bg-[#361c1f]'
                                        : 'bg-[#e5e7eb] text-[#111214] hover:bg-white'
                                    }`}
                                  >
                                    {isStreaming ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                    {isStreaming ? 'Stop' : 'Start'}
                                  </button>
                                </div>
                              </div>

                              {/* Level meter */}
                              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-[3px] bg-[#111214]">
                                <div
                                  className="h-full bg-[#22c55e] transition-transform duration-75 origin-left"
                                  style={{ transform: `scaleX(${isStreaming ? levelPct / 100 : 0})` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </>
                )}

                {/* TAB 2: ВЕТВИ */}
                {tab === 'branches' && config && (
                  <>
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <h2 className="text-sm font-semibold text-white">Добавить ветвь</h2>
                      <form onSubmit={handleAddBranch} className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_170px_auto]">
                        <input
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          placeholder="Название (например: Just Chatting)"
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <input
                          value={newBranchSlug}
                          onChange={(e) => setNewBranchSlug(e.target.value)}
                          placeholder="slug (chatting)"
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 font-mono text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <select
                          value={newBranchMode}
                          onChange={(e) => setNewBranchMode(e.target.value as BranchMode)}
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white"
                        >
                          <option value="passthrough">passthrough</option>
                          <option value="loop">loop</option>
                          <option value="silence">silence</option>
                        </select>
                        <button
                          type="submit"
                          className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#e5e7eb] px-4 py-2 text-sm font-semibold text-[#111214] hover:bg-white whitespace-nowrap"
                        >
                          <Plus className="h-4 w-4" />
                          Добавить
                        </button>
                      </form>
                    </section>

                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
                      <div className="border-b border-[#24272f] px-5 py-3.5 text-sm font-semibold text-white">
                        Изолированные аудио-ветви ({config.branches.length})
                      </div>
                      <div className="divide-y divide-[#22252d]">
                        {config.branches.map((branch) => {
                          const playerUrl = `${window.location.origin}/player/${activeTenantSlug}/${branch.slug}`;
                          const debugUrl = `${playerUrl}?debug=1`;
                          return (
                            <div key={branch.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                                  <span>{branch.name}</span>
                                  <span className="font-mono text-xs font-normal text-[#9ca3af]">{branch.slug}</span>
                                  {branch.isMain && (
                                    <span className="font-mono text-xs font-medium text-[#22c55e]">· Main</span>
                                  )}
                                </div>
                                <div className="mt-1 font-mono text-xs text-[#6b7280] truncate">{playerUrl}</div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                {!branch.isMain && (
                                  <select
                                    value={branch.mode}
                                    onChange={(e) => void handleBranchModeChange(branch.id, e.target.value as BranchMode)}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-2.5 py-1.5 font-mono text-xs text-[#e5e7eb]"
                                  >
                                    <option value="passthrough">passthrough</option>
                                    <option value="loop">loop</option>
                                    <option value="silence">silence</option>
                                  </select>
                                )}
                                {!branch.isMain && (
                                  <button
                                    onClick={() => void handleSetMainBranch(branch.id)}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-2.5 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32] whitespace-nowrap"
                                  >
                                    Сделать Main
                                  </button>
                                )}
                                <button
                                  onClick={() => void copyText(branch.id, debugUrl)}
                                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-2.5 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32] whitespace-nowrap"
                                >
                                  {copiedKey === branch.id ? <Check className="h-3.5 w-3.5 text-[#22c55e]" /> : <Copy className="h-3.5 w-3.5" />}
                                  OBS URL
                                </button>
                                <button
                                  onClick={() => onNavigate(`/player/${activeTenantSlug}/${branch.slug}?debug=1`)}
                                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-2.5 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32] whitespace-nowrap"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  Открыть плеер
                                </button>
                                {!branch.isMain && (
                                  <button
                                    onClick={() => void handleDeleteBranch(branch.id)}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-[#ef4444]"
                                    aria-label="Удалить ветвь"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </>
                )}

                {/* TAB 3: ПЛЕЙЛИСТ */}
                {tab === 'playlist' && playlist && (
                  <>
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <h2 className="text-sm font-semibold text-white">Добавить трек в плейлист</h2>
                          <p className="mt-0.5 font-mono text-xs text-[#9ca3af] tabular-nums">
                            Позиция: трек #{playlist.position.trackIndex + 1} · смещение {formatMs(playlist.position.offsetMs)}
                          </p>
                        </div>
                        <div className="flex items-center rounded-[6px] border border-[#2f343d] bg-[#111214] p-0.5">
                          {(['sequential', 'shuffle', 'loop'] as PlaylistMode[]).map((m) => (
                            <button
                              key={m}
                              onClick={() => void handlePlaylistMode(m)}
                              className={`rounded-[5px] px-3 py-1.5 font-mono text-xs transition-colors ${
                                playlist.mode === m ? 'bg-[#2a2e37] text-white' : 'text-[#9ca3af] hover:text-white'
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>

                      <form onSubmit={handleAddTrack} className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_100px_1fr_90px_auto]">
                        <input
                          value={trackArtist}
                          onChange={(e) => setTrackArtist(e.target.value)}
                          placeholder="Исполнитель"
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <input
                          value={trackTitle}
                          onChange={(e) => setTrackTitle(e.target.value)}
                          placeholder="Название трека"
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <select
                          value={trackSource}
                          onChange={(e) => setTrackSource(e.target.value as 'file' | 'url' | 'yt')}
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-2.5 py-2 font-mono text-xs text-white"
                        >
                          <option value="file">file</option>
                          <option value="url">url</option>
                          <option value="yt">yt</option>
                        </select>
                        <input
                          value={trackPath}
                          onChange={(e) => setTrackPath(e.target.value)}
                          placeholder="/media/t1.opus или https://..."
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 font-mono text-xs text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <input
                          type="number"
                          min={5}
                          max={3600}
                          value={trackDurationSec}
                          onChange={(e) => setTrackDurationSec(Number(e.target.value))}
                          title="Длительность (сек)"
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-2.5 py-2 font-mono text-xs text-white tabular-nums focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#e5e7eb] px-4 py-2 text-sm font-semibold text-[#111214] hover:bg-white whitespace-nowrap"
                        >
                          <Plus className="h-4 w-4" />
                          Добавить
                        </button>
                      </form>
                    </section>

                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
                      <div className="border-b border-[#24272f] px-5 py-3.5 text-sm font-semibold text-white">
                        Треки ({playlist.tracks.length})
                      </div>
                      {playlist.tracks.length === 0 ? (
                        <div className="px-5 py-10 text-center text-sm text-[#6b7280]">
                          Плейлист пуст. Добавьте треки, чтобы включить автоматическое воспроизведение вне режима LIVE.
                        </div>
                      ) : (
                        <div className="divide-y divide-[#22252d]">
                          {playlist.tracks.map((trk, idx) => {
                            const isCurrent = playback?.mode === 'PLAYLIST' && playlist.position.trackIndex === idx;
                            return (
                              <div key={trk.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 font-medium text-white truncate">
                                    <span className="font-mono text-xs text-[#6b7280] tabular-nums">
                                      {String(idx + 1).padStart(2, '0')}
                                    </span>
                                    <span className="truncate">
                                      {trk.artist} — {trk.title}
                                    </span>
                                    {isCurrent && <span className="font-mono text-xs text-[#22c55e]">· Играет</span>}
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-[#6b7280]">
                                    <span>{trk.source}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="truncate max-w-[360px]">{trk.pathOrUrl}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">{formatMs(trk.durationMs)}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={() => void handlePlayTrackIndex(idx)}
                                    className={`inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                                      isCurrent
                                        ? 'border-[#22c55e]/40 bg-[#17281e] text-[#4ade80]'
                                        : 'border-[#2f343d] bg-[#1d2026] text-[#e5e7eb] hover:bg-[#262a32]'
                                    }`}
                                    aria-label="Включить трек"
                                  >
                                    <Play className="h-3 w-3" />
                                    {isCurrent ? 'Играет' : 'Включить'}
                                  </button>
                                  <button
                                    onClick={() => void handleMoveTrack(idx, -1)}
                                    disabled={idx === 0}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-white disabled:opacity-30"
                                    aria-label="Выше"
                                  >
                                    <ArrowUp className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => void handleMoveTrack(idx, 1)}
                                    disabled={idx === playlist.tracks.length - 1}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-white disabled:opacity-30"
                                    aria-label="Ниже"
                                  >
                                    <ArrowDown className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => void handleDeleteTrack(trk.id)}
                                    className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-[#ef4444]"
                                    aria-label="Удалить трек"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  </>
                )}

                {/* TAB 4: ОЧЕРЕДЬ ЗАКАЗОВ */}
                {tab === 'queue' && (
                  <>
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <h2 className="text-sm font-semibold text-white">Очередь заказов зрителей (только Main)</h2>
                          <p className="mt-0.5 text-xs text-[#9ca3af]">
                            Заказы никогда не прерывают текущий трек. После опустошения очереди плейлист продолжается с сохранённой позиции.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              void copyText(
                                'webhook',
                                `curl -X POST ${window.location.origin}/webhook/${activeTenantSlug}/order -H "Content-Type: application/json" -d '{"query":"Artist — Title"}'`,
                              )
                            }
                            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32]"
                          >
                            {copiedKey === 'webhook' ? <Check className="h-3.5 w-3.5 text-[#22c55e]" /> : <Copy className="h-3.5 w-3.5" />}
                            Webhook cURL
                          </button>
                          <button
                            onClick={() => onNavigate(`/order/${activeTenantSlug}`)}
                            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32]"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Форма /order/{activeTenantSlug}
                          </button>
                        </div>
                      </div>

                      <form onSubmit={handleAddManualOrder} className="mt-4 flex gap-3">
                        <input
                          value={manualOrderQuery}
                          onChange={(e) => setManualOrderQuery(e.target.value)}
                          placeholder="Добавить заказ вручную: Artist — Title"
                          className="flex-1 rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="rounded-[6px] bg-[#e5e7eb] px-4 py-2 text-sm font-semibold text-[#111214] hover:bg-white whitespace-nowrap"
                        >
                          В очередь
                        </button>
                      </form>
                    </section>

                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
                      <div className="flex items-center justify-between border-b border-[#24272f] px-5 py-3.5">
                        <span className="text-sm font-semibold text-white">Заказы ({orders.length})</span>
                        {orders.some((o) => o.status === 'ready') && playback?.mode === 'LIVE' && (
                          <button
                            onClick={() => void handleSetMode('ORDER')}
                            className="rounded-[6px] bg-[#e5e7eb] px-3 py-1 text-xs font-semibold text-[#111214] hover:bg-white"
                          >
                            Запустить очередь сейчас
                          </button>
                        )}
                      </div>

                      {orders.length === 0 ? (
                        <div className="px-5 py-10 text-center text-sm text-[#6b7280]">
                          Очередь заказов пуста. Отправьте заказ здесь, через /order/{activeTenantSlug} или POST /webhook/{activeTenantSlug}/order.
                        </div>
                      ) : (
                        <div className="divide-y divide-[#22252d]">
                          {orders.map((order, idx) => (
                            <div key={order.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                              <div className="min-w-0">
                                <div className="truncate font-medium text-white">
                                  <span className="mr-2 font-mono text-xs text-[#6b7280] tabular-nums">
                                    {String(idx + 1).padStart(2, '0')}
                                  </span>
                                  {order.resolvedTitle
                                    ? `${order.resolvedArtist || ''} — ${order.resolvedTitle}`
                                    : order.query}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-[#6b7280]">
                                  <span
                                    className={
                                      order.status === 'playing' || order.status === 'ready'
                                        ? 'text-[#22c55e]'
                                        : order.status === 'failed'
                                          ? 'text-[#ef4444]'
                                          : 'text-[#d97706]'
                                    }
                                  >
                                    {order.status}
                                  </span>
                                  {order.sourceProvider && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>{order.sourceProvider}</span>
                                    </>
                                  )}
                                  {order.requestedBy && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span>{order.requestedBy}</span>
                                    </>
                                  )}
                                  {order.durationMs && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="tabular-nums">{formatMs(order.durationMs)}</span>
                                    </>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() => void handleMoveOrder(idx, -1)}
                                  disabled={idx === 0}
                                  className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-white disabled:opacity-30"
                                  aria-label="Выше"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => void handleMoveOrder(idx, 1)}
                                  disabled={idx === orders.length - 1}
                                  className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-white disabled:opacity-30"
                                  aria-label="Ниже"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => void handleDeleteOrder(order.id)}
                                  className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-[#ef4444]"
                                  aria-label="Удалить заказ"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </>
                )}

                {/* TAB 5: OBS-СЦЕНЫ */}
                {tab === 'obs' && config && (
                  <>
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <h2 className="text-sm font-semibold text-white">Маппинг сцен OBS → ветви</h2>
                      <p className="mt-1 text-xs text-[#9ca3af]">
                        Плеер на каждой сцене слушает <span className="font-mono text-[#d1d5db]">CurrentProgramSceneChanged</span> через OBS WebSocket v5 (<span className="font-mono">{config.obsWsUrl}</span>).
                      </p>

                      <form onSubmit={handleAddSceneMapping} className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_200px_auto]">
                        <input
                          value={newSceneName}
                          onChange={(e) => setNewSceneName(e.target.value)}
                          placeholder="Точное имя сцены в OBS (например: Game Scene)"
                          required
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none"
                        />
                        <select
                          value={newSceneBranch}
                          onChange={(e) => setNewSceneBranch(e.target.value)}
                          className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 font-mono text-xs text-white"
                        >
                          {config.branches.map((b) => (
                            <option key={b.id} value={b.slug}>
                              {b.name} ({b.slug})
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="rounded-[6px] bg-[#e5e7eb] px-4 py-2 text-sm font-semibold text-[#111214] hover:bg-white whitespace-nowrap"
                        >
                          Привязать
                        </button>
                      </form>

                      <div className="mt-4 divide-y divide-[#22252d] border-t border-[#24272f]">
                        {Object.entries(config.obsSceneMapping).map(([scene, slug]) => (
                          <div key={scene} className="flex items-center justify-between py-3 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white">{scene}</span>
                              <span className="text-[#6b7280]">→</span>
                              <span className="font-mono text-xs text-[#d1d5db]">{slug}</span>
                            </div>
                            <button
                              onClick={() => void handleRemoveSceneMapping(scene)}
                              className="rounded-[6px] border border-[#2f343d] bg-[#1d2026] p-1.5 text-[#9ca3af] hover:text-[#ef4444]"
                              aria-label="Удалить привязку"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>

                    {/* Interactive OBS Scene Switcher & Live Embedded Branch Players */}
                    <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#24272f] pb-4">
                        <div>
                          <h2 className="text-sm font-semibold text-white">Проверка переключения сцен OBS</h2>
                          <p className="mt-0.5 text-xs text-[#9ca3af]">
                            Переключайте активную сцену — подключённые плееры /player/{activeTenantSlug}/:branch мгновенно включают активную ветвь и ставят остальные на паузу.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.keys(config.obsSceneMapping).map((scene) => (
                            <button
                              key={scene}
                              onClick={() => void handleSwitchVirtualScene(scene)}
                              className={`rounded-[6px] border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                                virtualObsScene === scene
                                  ? 'border-[#e5e7eb] bg-[#e5e7eb] text-[#111214]'
                                  : 'border-[#2f343d] bg-[#111214] text-[#d1d5db] hover:bg-[#1e2128]'
                              }`}
                            >
                              {scene}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {config.branches.map((branch) => {
                          const isActive = config.obsSceneMapping[virtualObsScene] === branch.slug;
                          return (
                            <div
                              key={branch.id}
                              className="flex items-center justify-between rounded-[6px] border border-[#262a32] bg-[#111214] p-3.5"
                            >
                              <div>
                                <div className="text-xs font-semibold text-white">
                                  {branch.name} <span className="font-mono font-normal text-[#9ca3af]">/{branch.slug}</span>
                                </div>
                                <div className={`mt-1 font-mono text-xs ${isActive ? 'text-[#22c55e]' : 'text-[#d97706]'}`}>
                                  {isActive ? 'PLAY (активная сцена)' : 'PAUSED / MUTED'}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => void toggleMonitor(branch.slug)}
                                  className={`inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1.5 text-xs transition-colors whitespace-nowrap ${
                                    monitoringBranch === branch.slug
                                      ? 'border-[#22c55e]/40 bg-[#17281e] text-[#4ade80]'
                                      : 'border-[#2f343d] bg-[#1d2026] text-[#d1d5db] hover:bg-[#262a32]'
                                  }`}
                                >
                                  {monitoringBranch === branch.slug ? (
                                    <Volume2 className="h-3.5 w-3.5" />
                                  ) : (
                                    <VolumeX className="h-3.5 w-3.5" />
                                  )}
                                  {monitoringBranch === branch.slug ? 'Слушаем' : 'Слушать'}
                                </button>
                                <button
                                  onClick={() => onNavigate(`/player/${activeTenantSlug}/${branch.slug}?debug=1`)}
                                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-2.5 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32] whitespace-nowrap"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  ?debug=1
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </>
                )}

                {/* TAB 6: НАСТРОЙКИ */}
                {tab === 'settings' && config && (
                  <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-6 space-y-6">
                    <div>
                      <h2 className="text-sm font-semibold text-white">Параметры кодирования Opus и воспроизведения</h2>
                      <p className="mt-1 text-xs text-[#9ca3af]">
                        Изменения атомарно сохраняются на сервере в <span className="font-mono">data/users/:id/config.json</span>.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs text-[#9ca3af]">Битрейт Opus (24–192 kbps)</label>
                        <input
                          type="number"
                          min={24}
                          max={192}
                          step={8}
                          value={config.audio.bitrateKbps}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              audio: { ...config.audio, bitrateKbps: Math.max(24, Math.min(192, Number(e.target.value))) },
                            })
                          }
                          className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 font-mono text-sm text-white tabular-nums focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="mb-1.5 block text-xs text-[#9ca3af]">Размер фрейма Opus</label>
                        <div className="flex gap-2">
                          {([10, 20] as const).map((ms) => (
                            <button
                              key={ms}
                              type="button"
                              onClick={() => setConfig({ ...config, audio: { ...config.audio, frameMs: ms } })}
                              className={`flex-1 rounded-[6px] border py-2 font-mono text-xs font-medium ${
                                config.audio.frameMs === ms
                                  ? 'border-[#e5e7eb] bg-[#2a2e37] text-white'
                                  : 'border-[#2f343d] bg-[#111214] text-[#9ca3af]'
                              }`}
                            >
                              {ms} ms ({ms === 10 ? '480' : '960'} samples)
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-xs text-[#9ca3af]">Возобновление плейлиста после заказов</label>
                        <div className="flex gap-2">
                          {(['exact', 'next'] as const).map((rm) => (
                            <button
                              key={rm}
                              type="button"
                              onClick={() => setConfig({ ...config, playlistResumeMode: rm })}
                              className={`flex-1 rounded-[6px] border py-2 text-xs font-medium ${
                                config.playlistResumeMode === rm
                                  ? 'border-[#e5e7eb] bg-[#2a2e37] text-white'
                                  : 'border-[#2f343d] bg-[#111214] text-[#9ca3af]'
                              }`}
                            >
                              {rm === 'exact' ? 'exact (с той же секунды)' : 'next (со следующего трека)'}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-xs text-[#9ca3af]">OBS WebSocket v5 URL</label>
                        <input
                          value={config.obsWsUrl || 'ws://127.0.0.1:4455'}
                          onChange={(e) => setConfig({ ...config, obsWsUrl: e.target.value })}
                          className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 font-mono text-sm text-white focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end border-t border-[#24272f] pt-4">
                      <button
                        onClick={() => void saveConfig(config, 'Настройки сохранены')}
                        className="rounded-[6px] bg-[#e5e7eb] px-5 py-2 text-sm font-semibold text-[#111214] hover:bg-white"
                      >
                        Сохранить настройки
                      </button>
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
