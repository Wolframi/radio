import { useEffect, useState } from 'react';
import OBSWebSocket from 'obs-websocket-js';
import type { PublicPlayerConfig } from '../../shared/schemas';
import { api } from '../lib/api';
import { BrowserBranchPlayer, type PlayerTelemetry } from '../lib/audio-engine';

interface WebPlayerViewProps {
  userSlug: string;
  branchSlug: string;
  debug: boolean;
  obsPassword?: string;
}

/**
 * OBS Browser Source Web Player (`/player/:userSlug/:branchSlug`)
 * - Completely hidden by default (renders nothing unless `?debug=1`)
 * - Connects to OBS WebSocket v5 (`ws://127.0.0.1:4455`), checks `GetCurrentProgramScene`,
 *   and subscribes to `CurrentProgramSceneChanged`.
 * - Also responds to virtual OBS scene events from the server `/ws/events/:userSlug` for browser testing.
 * - Renders `200×24 px` bottom-left status bar when `?debug=1`: `● branch | scene | latency | buffer`
 */
export function WebPlayerView({ userSlug, branchSlug, debug, obsPassword }: WebPlayerViewProps) {
  const [sceneName, setSceneName] = useState<string>('wait-obs');
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    connected: false,
    transport: 'reconnecting',
    latencyMs: 0,
    bufferMs: 0,
    droppedFrames: 0,
    usingSab: false,
    muted: true,
  });

  useEffect(() => {
    let cancelled = false;
    let player: BrowserBranchPlayer | null = null;
    let obs: OBSWebSocket | null = null;
    let eventsWs: WebSocket | null = null;
    let sceneMapping: Record<string, string> = {};

    const applyScene = (scene: string) => {
      setSceneName(scene);
      const targetBranch = sceneMapping[scene];
      const active = targetBranch === branchSlug;
      player?.setMuted(!active);
    };

    const resumeOnGesture = () => {
      void player?.resumeAudio();
    };
    window.addEventListener('pointerdown', resumeOnGesture, { once: true });

    void (async () => {
      let cfg: PublicPlayerConfig | null = null;
      try {
        cfg = await api.getPublicConfig(userSlug);
        sceneMapping = cfg.obsSceneMapping || {};
      } catch {
        // ignore
      }
      if (cancelled) return;

      player = new BrowserBranchPlayer({
        userSlug,
        branchSlug,
        onTelemetry: setTelemetry,
      });
      await player.start(true);

      // 1. Real OBS WebSocket v5 connection
      obs = new OBSWebSocket();
      void (async () => {
        try {
          await obs!.connect(cfg?.obsWsUrl || 'ws://127.0.0.1:4455', obsPassword || undefined);
          const current = await obs!.call('GetCurrentProgramScene');
          applyScene(current.currentProgramSceneName);
          obs!.on('CurrentProgramSceneChanged', (ev: { sceneName: string }) => {
            applyScene(ev.sceneName);
          });
        } catch {
          setSceneName('obs-offline');
        }
      })();

      // 2. Real-time server event channel (picks up config updates & virtual OBS scene switches)
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      eventsWs = new WebSocket(`${proto}//${window.location.host}/ws/events/${encodeURIComponent(userSlug)}`);
      eventsWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.event === 'sync') {
            if (msg.data?.config?.obsSceneMapping) {
              sceneMapping = msg.data.config.obsSceneMapping;
            }
            if (msg.data?.virtualObsScene) {
              applyScene(msg.data.virtualObsScene);
            }
          } else if (msg.event === 'config:updated' && msg.data?.obsSceneMapping) {
            sceneMapping = msg.data.obsSceneMapping;
          } else if (msg.event === 'obs:scene' && typeof msg.data?.sceneName === 'string') {
            applyScene(msg.data.sceneName);
          }
        } catch {
          // ignore
        }
      };
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', resumeOnGesture);
      player?.stop();
      eventsWs?.close();
      void obs?.disconnect().catch(() => {});
    };
  }, [userSlug, branchSlug, obsPassword]);

  if (!debug) {
    return null;
  }

  const dotColor = !telemetry.connected ? '#dc2626' : telemetry.muted ? '#d97706' : '#16a34a';

  return (
    <div
      className="fixed bottom-2 left-2 flex h-[24px] w-[200px] items-center gap-1.5 overflow-hidden rounded-[6px] border border-[#2f343d] bg-[#14161a]/95 px-2 font-mono text-[10px] leading-none text-[#e5e7eb] tabular-nums"
      title={`Transport: ${telemetry.transport} | SAB: ${telemetry.usingSab ? 'on' : 'fallback'} | Dropped: ${telemetry.droppedFrames}`}
    >
      <span style={{ color: dotColor }} aria-hidden="true">
        ●
      </span>
      <span className="truncate">
        {branchSlug} | {sceneName} | {telemetry.latencyMs}ms | {telemetry.bufferMs}ms
      </span>
    </div>
  );
}
