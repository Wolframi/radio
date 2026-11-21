import OBSWebSocket from 'obs-websocket-js';

export interface ObsSceneState {
  connected: boolean;
  currentScene: string;
  shouldPlay: boolean;
}

/**
 * Connects to OBS WebSocket v5 (`ws://127.0.0.1:4455`), queries `GetCurrentProgramScene` on startup,
 * and subscribes to `CurrentProgramSceneChanged` for instant scene-to-branch switching.
 */
export class ObsSceneController {
  private obs = new OBSWebSocket();
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly password: string | undefined,
    private readonly branchSlug: string,
    private readonly sceneMapping: Record<string, string>,
    private readonly onSceneChange: (state: ObsSceneState) => void,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.obs.disconnect().catch(() => {});
  }

  private evaluateScene(sceneName: string): void {
    const mappedBranch = this.sceneMapping[sceneName];
    const shouldPlay = mappedBranch === this.branchSlug;
    this.onSceneChange({ connected: true, currentScene: sceneName, shouldPlay });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.obs.connect(this.wsUrl, this.password || undefined);

      // 1. Query current OBS scene immediately on connect
      const { currentProgramSceneName } = await this.obs.call('GetCurrentProgramScene');
      this.evaluateScene(currentProgramSceneName);

      // 2. React instantaneously on scene change
      this.obs.on('CurrentProgramSceneChanged', (data: { sceneName: string }) => {
        this.evaluateScene(data.sceneName);
      });

      this.obs.on('ConnectionClosed', () => {
        if (!this.stopped) {
          this.onSceneChange({ connected: false, currentScene: 'disconnected', shouldPlay: false });
          this.retryTimer = setTimeout(() => void this.connect(), 3000);
        }
      });
    } catch {
      if (!this.stopped) {
        this.onSceneChange({ connected: false, currentScene: 'no-obs', shouldPlay: false });
        this.retryTimer = setTimeout(() => void this.connect(), 3000);
      }
    }
  }
}
