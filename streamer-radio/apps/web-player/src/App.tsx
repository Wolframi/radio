import { useEffect, useState } from 'react';
import type { PublicPlayerConfig } from '@streamer-radio/shared';
import { LowLatencyAudioPipeline, type PlayerTelemetry } from './audio-pipeline';
import { ObsSceneController } from './obs-controller';

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const debug = params.get('debug') === '1';
  const obsPasswordParam = params.get('obsPassword') || undefined;
  const segments = window.location.pathname.split('/').filter(Boolean);
  // /player/:userSlug/:branchSlug
  const userSlug = segments[1] || 'demo';
  const branchSlug = segments[2] || 'main';

  const [scene, setScene] = useState('connecting');
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    transport: 'reconnecting',
    connected: false,
    latencyMs: 0,
    bufferMs: 0,
    droppedFrames: 0,
    usingSab: false,
    muted: true,
  });

  useEffect(() => {
    let pipeline: LowLatencyAudioPipeline | null = null;
    let obsCtrl: ObsSceneController | null = null;
    let cancelled = false;

    const unlock = () => {
      void pipeline?.ensureAudioResumed();
    };
    window.addEventListener('pointerdown', unlock, { once: true });

    void (async () => {
      const [cfgRes, hashRes] = await Promise.all([
        fetch(`/api/public/${encodeURIComponent(userSlug)}/config`).then((r) => (r.ok ? r.json() : null)),
        fetch('/api/public/cert-hash').then((r) => (r.ok ? r.json() : { hashBase64: null })),
      ]);
      if (cancelled) return;
      const cfg = cfgRes as PublicPlayerConfig | null;

      pipeline = new LowLatencyAudioPipeline({
        serverBaseUrl: window.location.origin,
        userSlug,
        branchSlug,
        certHashBase64: hashRes?.hashBase64 ?? null,
        onTelemetry: setTelemetry,
      });

      await pipeline.start(true);

      obsCtrl = new ObsSceneController(
        cfg?.obsWsUrl || 'ws://127.0.0.1:4455',
        obsPasswordParam,
        branchSlug,
        cfg?.obsSceneMapping || {},
        (obsState) => {
          setScene(obsState.currentScene);
          pipeline?.setMuted(!obsState.shouldPlay);
        },
      );
      obsCtrl.start();
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', unlock);
      obsCtrl?.stop();
      pipeline?.stop();
    };
  }, [userSlug, branchSlug, obsPasswordParam]);

  // Completely hidden unless ?debug=1 is passed
  if (!debug) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 8,
        bottom: 8,
        width: 200,
        height: 24,
        background: 'rgba(18, 19, 22, 0.92)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        borderRadius: 6,
        color: '#e5e7eb',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
        lineHeight: '24px',
        padding: '0 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: telemetry.connected ? (telemetry.muted ? '#d97706' : '#16a34a') : '#dc2626' }}>●</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {branchSlug} | {scene} | {telemetry.latencyMs}ms | {telemetry.bufferMs}ms
      </span>
    </div>
  );
}
