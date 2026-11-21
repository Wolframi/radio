import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  kind: string;
}

export interface AudioProcessInfo {
  pid: number;
  name: string;
}

export interface CaptureSettings {
  serverUrl: string;
  userSlug: string;
  jwtToken: string;
  bitrateKbps: number;
  frameMs: number;
  preferWebtransport: boolean;
}

export interface BranchTelemetry {
  branchSlug: string;
  transport: 'webtransport' | 'websocket' | 'reconnecting';
  connected: boolean;
  rttMs: number;
  droppedFrames: number;
  bufferMs: number;
  levelDb: number;
}

export async function listDevices(): Promise<AudioDeviceInfo[]> {
  return invoke<AudioDeviceInfo[]>('list_devices');
}

export async function listAudioProcesses(): Promise<AudioProcessInfo[]> {
  return invoke<AudioProcessInfo[]>('list_audio_processes');
}

export async function setCaptureSettings(settings: CaptureSettings): Promise<void> {
  return invoke('set_settings', { settings });
}

export async function startCapture(branchId: string, deviceId: string, processId?: number | null): Promise<void> {
  return invoke('start_capture', {
    branchId,
    deviceId,
    processId: processId ?? null,
  });
}

export async function stopCapture(branchId: string): Promise<void> {
  return invoke('stop_capture', { branchId });
}

export async function onCaptureTelemetry(cb: (tel: BranchTelemetry) => void): Promise<UnlistenFn> {
  return listen<BranchTelemetry>('capture-telemetry', (event) => cb(event.payload));
}
