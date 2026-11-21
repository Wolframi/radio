import { useEffect, useState } from 'react';
import type { Order, PlaybackStateSnapshot, PlaylistData, UserConfig } from '@streamer-radio/shared';
import {
  listAudioProcesses,
  listDevices,
  onCaptureTelemetry,
  setCaptureSettings,
  startCapture,
  stopCapture,
  type AudioDeviceInfo,
  type AudioProcessInfo,
  type BranchTelemetry,
} from './tauri-bridge';

type TabKey = 'connection' | 'branches' | 'playlist' | 'queue' | 'obs' | 'settings';

const NAV_ITEMS: Array<{ key: TabKey; label: string }> = [
  { key: 'connection', label: 'Подключение' },
  { key: 'branches', label: 'Ветви' },
  { key: 'playlist', label: 'Плейлист' },
  { key: 'queue', label: 'Очередь' },
  { key: 'obs', label: 'OBS-сцены' },
  { key: 'settings', label: 'Настройки' },
];

export default function App() {
  const [tab, setTab] = useState<TabKey>('connection');
  const [serverUrl, setServerUrl] = useState('https://localhost:4433');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [userSlug, setUserSlug] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const [config, setConfig] = useState<UserConfig | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistData | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [playback, setPlayback] = useState<PlaybackStateSnapshot | null>(null);

  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [processes, setProcesses] = useState<AudioProcessInfo[]>([]);
  const [selectedDeviceByBranch, setSelectedDeviceByBranch] = useState<Record<string, string>>({});
  const [selectedProcessByBranch, setSelectedProcessByBranch] = useState<Record<string, number | null>>({});
  const [telemetryByBranch, setTelemetryByBranch] = useState<Record<string, BranchTelemetry>>({});
  const [activeCaptures, setActiveCaptures] = useState<Record<string, boolean>>({});
  const [newOrderQuery, setNewOrderQuery] = useState('');

  useEffect(() => {
    void listDevices().then(setDevices).catch(() => {});
    void listAudioProcesses().then(setProcesses).catch(() => {});
    let unlisten: (() => void) | undefined;
    void onCaptureTelemetry((tel) => {
      setTelemetryByBranch((prev) => ({ ...prev, [tel.branchSlug]: tel }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!token || !userSlug) return;
    const base = serverUrl.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${token}` };

    void Promise.all([
      fetch(`${base}/api/${userSlug}/config`, { headers }).then((r) => r.json()),
      fetch(`${base}/api/${userSlug}/playlist`, { headers }).then((r) => r.json()),
      fetch(`${base}/api/${userSlug}/orders`, { headers }).then((r) => r.json()),
      fetch(`${base}/api/${userSlug}/playback`, { headers }).then((r) => r.json()),
    ]).then(([cfg, pl, ord, pb]) => {
      setConfig(cfg);
      setPlaylist(pl);
      setOrders(ord.orders ?? []);
      setPlayback(pb);
    });

    const wsUrl = `${base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')}/ws/events/${userSlug}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'sync') {
          setPlayback(msg.data.state);
          setOrders(msg.data.queue);
          setPlaylist(msg.data.playlist);
        } else if (msg.event === 'playback:state') {
          setPlayback(msg.data);
        } else if (msg.event === 'queue:updated') {
          setOrders(msg.data);
        } else if (msg.event === 'playlist:updated') {
          setPlaylist(msg.data);
        } else if (msg.event === 'config:updated') {
          setConfig(msg.data);
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [token, userSlug, serverUrl]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const base = serverUrl.replace(/\/$/, '');
    const resp = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setError(data.error || 'Ошибка входа');
      return;
    }
    setToken(data.token);
    setUserSlug(data.user.username);
    setPassword('');
    await setCaptureSettings({
      serverUrl: base,
      userSlug: data.user.username,
      jwtToken: data.token,
      bitrateKbps: 64,
      frameMs: 20,
      preferWebtransport: true,
    });
  }

  async function toggleBranchCapture(branchSlug: string) {
    if (!token || !config) return;
    if (activeCaptures[branchSlug]) {
      await stopCapture(branchSlug);
      setActiveCaptures((prev) => ({ ...prev, [branchSlug]: false }));
      return;
    }
    await setCaptureSettings({
      serverUrl: serverUrl.replace(/\/$/, ''),
      userSlug,
      jwtToken: token,
      bitrateKbps: config.audio.bitrateKbps,
      frameMs: config.audio.frameMs,
      preferWebtransport: true,
    });
    const devId = selectedDeviceByBranch[branchSlug] || devices[0]?.id || 'default';
    const pid = selectedProcessByBranch[branchSlug] ?? null;
    await startCapture(branchSlug, devId, pid);
    setActiveCaptures((prev) => ({ ...prev, [branchSlug]: true }));
  }

  async function saveConfig(nextCfg: UserConfig) {
    if (!token) return;
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/${userSlug}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(nextCfg),
    });
    if (resp.ok) setConfig(await resp.json());
  }

  async function deleteOrder(orderId: string) {
    if (!token) return;
    await fetch(`${serverUrl.replace(/\/$/, '')}/api/${userSlug}/orders/${orderId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function addManualOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrderQuery.trim()) return;
    await fetch(`${serverUrl.replace(/\/$/, '')}/api/${userSlug}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: newOrderQuery.trim(), requestedBy: userSlug }),
    });
    setNewOrderQuery('');
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#111214', color: '#e5e7eb' }}>
      <aside style={{ width: 220, background: '#16181c', borderRight: '1px solid #262930', padding: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 20 }}>Streamer Radio</div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: tab === item.key ? '#262930' : 'transparent',
                color: tab === item.key ? '#ffffff' : '#9ca3af',
                fontSize: 13,
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main style={{ flex: 1, padding: 24, maxWidth: 960 }}>
        {!token ? (
          <form onSubmit={handleLogin} style={{ maxWidth: 380, background: '#16181c', padding: 20, borderRadius: 8, border: '1px solid #262930' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Подключение к серверу</h2>
            {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>URL сервера</label>
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} style={inputStyle} />
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', margin: '12px 0 4px' }}>Логин</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} required />
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', margin: '12px 0 4px' }}>Пароль</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} required />
            <button type="submit" style={{ ...primaryBtn, width: '100%', marginTop: 16 }}>
              Войти
            </button>
          </form>
        ) : (
          <div>
            {tab === 'connection' && config && (
              <div>
                <h2 style={{ marginTop: 0 }}>Захват и трансляция ({userSlug})</h2>
                <p style={{ fontSize: 13, color: '#9ca3af' }}>
                  Режим основной ветви: <strong>{playback?.mode ?? 'PLAYLIST'}</strong>
                </p>
                {config.branches.map((branch) => {
                  const tel = telemetryByBranch[branch.slug];
                  const active = Boolean(activeCaptures[branch.slug]);
                  return (
                    <div key={branch.id} style={{ background: '#16181c', border: '1px solid #262930', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <strong>{branch.name}</strong> ({branch.slug}) {branch.isMain ? '· Main' : `· ${branch.mode}`}
                        </div>
                        <button onClick={() => void toggleBranchCapture(branch.slug)} style={primaryBtn}>
                          {active ? 'Stop' : 'Start'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <select
                          value={selectedDeviceByBranch[branch.slug] || devices[0]?.id || ''}
                          onChange={(e) => setSelectedDeviceByBranch((p) => ({ ...p, [branch.slug]: e.target.value }))}
                          style={inputStyle}
                        >
                          {devices.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={selectedProcessByBranch[branch.slug] ?? ''}
                          onChange={(e) =>
                            setSelectedProcessByBranch((p) => ({
                              ...p,
                              [branch.slug]: e.target.value ? Number(e.target.value) : null,
                            }))
                          }
                          style={inputStyle}
                        >
                          <option value="">Весь системный микшер (WASAPI Loopback)</option>
                          {processes.map((proc) => (
                            <option key={proc.pid} value={proc.pid}>
                              {proc.name} (PID {proc.pid})
                            </option>
                          ))}
                        </select>
                      </div>
                      {tel && (
                        <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'monospace', color: '#9ca3af' }}>
                          {tel.transport} · RTT {tel.rttMs}ms · buf {tel.bufferMs}ms · drop {tel.droppedFrames} · {tel.levelDb.toFixed(1)} dB
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'queue' && (
              <div>
                <h2 style={{ marginTop: 0 }}>Очередь заказов (Main)</h2>
                <form onSubmit={addManualOrder} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  <input
                    value={newOrderQuery}
                    onChange={(e) => setNewOrderQuery(e.target.value)}
                    placeholder="Artist — Title"
                    style={inputStyle}
                  />
                  <button type="submit" style={primaryBtn}>
                    Добавить
                  </button>
                </form>
                {orders.map((o) => (
                  <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 10, borderBottom: '1px solid #262930' }}>
                    <span>
                      {o.resolvedArtist ? `${o.resolvedArtist} — ${o.resolvedTitle}` : o.query} ({o.status})
                    </span>
                    <button onClick={() => void deleteOrder(o.id)} style={{ ...primaryBtn, background: '#262930' }}>
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tab === 'branches' && config && (
              <div>
                <h2 style={{ marginTop: 0 }}>Ветви аудио</h2>
                {config.branches.map((b) => (
                  <div key={b.id} style={{ padding: 10, borderBottom: '1px solid #262930' }}>
                    {b.name} — <code>/player/{userSlug}/{b.slug}</code> ({b.isMain ? 'Main' : b.mode})
                  </div>
                ))}
              </div>
            )}

            {tab === 'playlist' && playlist && (
              <div>
                <h2 style={{ marginTop: 0 }}>Плейлист ({playlist.mode})</h2>
                {playlist.tracks.map((t, i) => (
                  <div key={t.id} style={{ padding: 8, borderBottom: '1px solid #262930' }}>
                    {i + 1}. {t.artist} — {t.title}
                  </div>
                ))}
              </div>
            )}

            {tab === 'obs' && config && (
              <div>
                <h2 style={{ marginTop: 0 }}>Маппинг сцен OBS</h2>
                {Object.entries(config.obsSceneMapping).map(([scene, slug]) => (
                  <div key={scene} style={{ padding: 8, borderBottom: '1px solid #262930' }}>
                    {scene} → <code>{slug}</code>
                  </div>
                ))}
              </div>
            )}

            {tab === 'settings' && config && (
              <div>
                <h2 style={{ marginTop: 0 }}>Настройки аудио</h2>
                <div style={{ display: 'flex', gap: 12 }}>
                  <button
                    onClick={() => void saveConfig({ ...config, audio: { ...config.audio, frameMs: 10 } })}
                    style={primaryBtn}
                  >
                    10 ms
                  </button>
                  <button
                    onClick={() => void saveConfig({ ...config, audio: { ...config.audio, frameMs: 20 } })}
                    style={primaryBtn}
                  >
                    20 ms
                  </button>
                  <button
                    onClick={() =>
                      void saveConfig({
                        ...config,
                        playlistResumeMode: config.playlistResumeMode === 'exact' ? 'next' : 'exact',
                      })
                    }
                    style={primaryBtn}
                  >
                    Resume: {config.playlistResumeMode}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #2f333c',
  background: '#111214',
  color: '#e5e7eb',
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid #3f444e',
  background: '#2c3038',
  color: '#ffffff',
  cursor: 'pointer',
  fontSize: 13,
};
