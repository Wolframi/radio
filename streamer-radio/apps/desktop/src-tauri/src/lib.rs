mod opus_encoder;
mod transport;
mod wasapi_capture;

use opus_encoder::OpusFrameEncoder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex, RwLock};
use transport::{run_ingest_transport, BranchTelemetry, IngestTransportConfig};
use wasapi_capture::{
    list_running_audio_processes, list_wasapi_devices, spawn_capture_thread, AudioDeviceInfo, AudioProcessInfo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSettings {
    pub server_url: String,
    pub user_slug: String,
    pub jwt_token: String,
    pub bitrate_kbps: u32,
    pub frame_ms: u32,
    pub prefer_webtransport: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            server_url: "https://localhost:4433".into(),
            user_slug: String::new(),
            jwt_token: String::new(),
            bitrate_kbps: 64,
            frame_ms: 20,
            prefer_webtransport: true,
        }
    }
}

struct ActiveBranchHandle {
    stop_flag: Arc<AtomicBool>,
    dropped_frames: Arc<AtomicU64>,
    rtt_ms: Arc<AtomicU64>,
    level_db_bits: Arc<AtomicU64>,
    transport_name: Arc<RwLock<String>>,
}

struct AppState {
    settings: RwLock<CaptureSettings>,
    active_branches: Mutex<HashMap<String, ActiveBranchHandle>>,
}

#[tauri::command]
async fn list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    list_wasapi_devices().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_audio_processes() -> Result<Vec<AudioProcessInfo>, String> {
    list_running_audio_processes().map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_settings(state: State<'_, AppState>, settings: CaptureSettings) -> Result<(), String> {
    let mut guard = state.settings.write().await;
    *guard = settings;
    Ok(())
}

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    branch_id: String,
    device_id: String,
    process_id: Option<u32>,
) -> Result<(), String> {
    let settings = state.settings.read().await.clone();
    if settings.user_slug.is_empty() || settings.jwt_token.is_empty() {
        return Err("Authenticate and configure server settings before starting capture".into());
    }

    // Stop any previous pipeline for this branch
    stop_capture_internal(&state, &branch_id).await;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let dropped_frames = Arc::new(AtomicU64::new(0));
    let rtt_ms = Arc::new(AtomicU64::new(0));
    let level_db_bits = Arc::new(AtomicU64::new((-96.0_f32).to_bits() as u64));
    let transport_name = Arc::new(RwLock::new("connecting".to_string()));

    let (pcm_tx, mut pcm_rx) = mpsc::channel(16);
    let (pkt_tx, pkt_rx) = mpsc::channel(32);

    // 1. Spawn WASAPI loopback / per-process loopback thread
    spawn_capture_thread(device_id, process_id, settings.frame_ms, pcm_tx, stop_flag.clone());

    // 2. Spawn Opus encoder task
    let enc_stop = stop_flag.clone();
    let enc_dropped = dropped_frames.clone();
    let enc_level = level_db_bits.clone();
    let bitrate = settings.bitrate_kbps;
    tokio::spawn(async move {
        let mut encoder = match OpusFrameEncoder::new(bitrate) {
            Ok(e) => e,
            Err(err) => {
                tracing::error!(error = %err, "Failed to initialize Opus encoder");
                return;
            }
        };
        while !enc_stop.load(Ordering::Relaxed) {
            match pcm_rx.recv().await {
                Some(chunk) => {
                    enc_level.store(chunk.peak_db.to_bits() as u64, Ordering::Relaxed);
                    match encoder.encode_framed(&chunk.samples) {
                        Ok(packet) => {
                            if pkt_tx.try_send(packet).is_err() {
                                enc_dropped.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(_) => {
                            enc_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                None => break,
            }
        }
    });

    // 3. Spawn WebTransport / WebSocket ingest task
    let ingest_cfg = IngestTransportConfig {
        server_base_url: settings.server_url.clone(),
        user_slug: settings.user_slug.clone(),
        branch_slug: branch_id.clone(),
        jwt_token: settings.jwt_token.clone(),
        prefer_webtransport: settings.prefer_webtransport,
        frame_ms: settings.frame_ms,
    };
    tokio::spawn(run_ingest_transport(
        ingest_cfg,
        pkt_rx,
        stop_flag.clone(),
        dropped_frames.clone(),
        rtt_ms.clone(),
        transport_name.clone(),
    ));

    // 4. Emit real-time telemetry events to Tauri UI every 120 ms
    let tel_stop = stop_flag.clone();
    let tel_branch = branch_id.clone();
    let tel_dropped = dropped_frames.clone();
    let tel_rtt = rtt_ms.clone();
    let tel_level = level_db_bits.clone();
    let tel_transport = transport_name.clone();
    let frame_ms = settings.frame_ms as u64;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(120));
        while !tel_stop.load(Ordering::Relaxed) {
            ticker.tick().await;
            let tr = tel_transport.read().await.clone();
            let level = f32::from_bits(tel_level.load(Ordering::Relaxed) as u32);
            let payload = BranchTelemetry {
                branch_slug: tel_branch.clone(),
                connected: tr == "webtransport" || tr == "websocket",
                transport: tr,
                rtt_ms: tel_rtt.load(Ordering::Relaxed),
                dropped_frames: tel_dropped.load(Ordering::Relaxed),
                buffer_ms: frame_ms * 2,
                level_db: level,
            };
            let _ = app.emit("capture-telemetry", payload);
        }
    });

    state.active_branches.lock().await.insert(
        branch_id,
        ActiveBranchHandle {
            stop_flag,
            dropped_frames,
            rtt_ms,
            level_db_bits,
            transport_name,
        },
    );

    Ok(())
}

async fn stop_capture_internal(state: &State<'_, AppState>, branch_id: &str) {
    if let Some(handle) = state.active_branches.lock().await.remove(branch_id) {
        handle.stop_flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn stop_capture(state: State<'_, AppState>, branch_id: String) -> Result<(), String> {
    stop_capture_internal(&state, &branch_id).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .manage(AppState {
            settings: RwLock::new(CaptureSettings::default()),
            active_branches: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            list_audio_processes,
            set_settings,
            start_capture,
            stop_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running Streamer Radio desktop application");
}
