use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub kind: String, // "render_loopback" | "capture"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessInfo {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct PcmChunk {
    pub samples: Vec<f32>, // interleaved stereo 48 kHz
    pub peak_db: f32,
}

pub fn compute_peak_db(samples: &[f32]) -> f32 {
    let peak = samples.iter().fold(0.0_f32, |acc, &s| acc.max(s.abs()));
    if peak <= 1e-6 {
        -96.0
    } else {
        (20.0 * peak.log10()).clamp(-96.0, 0.0)
    }
}

/// Enumerates Windows WASAPI render endpoints (for system mixer loopback) and active audio processes.
pub fn list_wasapi_devices() -> Result<Vec<AudioDeviceInfo>> {
    #[cfg(windows)]
    {
        use wasapi::{Direction, DeviceCollection};
        let _ = wasapi::initialize_mta();
        let default_dev = wasapi::get_default_device(&Direction::Render).ok();
        let default_id = default_dev.and_then(|d| d.get_id().ok()).unwrap_or_default();

        let collection = DeviceCollection::new(&Direction::Render)
            .map_err(|e| anyhow!("WASAPI enumerate failed: {e:?}"))?;
        let mut out = Vec::new();
        for idx in 0..collection.get_nbr_devices().unwrap_or(0) {
            if let Ok(dev) = collection.get_device_at_index(idx) {
                let id = dev.get_id().unwrap_or_default();
                let name = dev.get_friendlyname().unwrap_or_else(|_| "Unknown Audio Device".into());
                out.push(AudioDeviceInfo {
                    is_default: id == default_id,
                    id,
                    name,
                    kind: "render_loopback".into(),
                });
            }
        }
        return Ok(out);
    }

    #[cfg(not(windows))]
    {
        Ok(vec![AudioDeviceInfo {
            id: "default-loopback".into(),
            name: "System Mixer (WASAPI unavailable on non-Windows host)".into(),
            is_default: true,
            kind: "render_loopback".into(),
        }])
    }
}

/// Lists running processes eligible for Windows 10 2004+ WASAPI per-process loopback capture.
pub fn list_running_audio_processes() -> Result<Vec<AudioProcessInfo>> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };
        let mut results = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
                .map_err(|e| anyhow!("Snapshot failed: {e}"))?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    if entry.th32ProcessID > 4 && !name.is_empty() {
                        results.push(AudioProcessInfo {
                            pid: entry.th32ProcessID,
                            name,
                        });
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        return Ok(results);
    }

    #[cfg(not(windows))]
    {
        Ok(vec![])
    }
}

/// Spawns a dedicated real-time capture thread:
/// - If `process_id` is Some(pid) on Windows 10 2004+, configures `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
///   via `wasapi::AudioClient::new_application_loopback_client(pid, true)` (include target process tree).
/// - Otherwise opens full-endpoint WASAPI loopback capture on `device_id`.
pub fn spawn_capture_thread(
    device_id: String,
    process_id: Option<u32>,
    frame_ms: u32,
    tx: mpsc::Sender<PcmChunk>,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let samples_per_frame = ((48_000 * frame_ms) / 1000) as usize * 2; // stereo f32

        #[cfg(windows)]
        {
            use std::collections::VecDeque;
            use std::sync::atomic::Ordering;
            use wasapi::{AudioClient, DeviceCollection, Direction, SampleType, StreamMode, WaveFormat};

            let _ = wasapi::initialize_mta();
            let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);

            let client_res: Result<AudioClient> = if let Some(pid) = process_id {
                // Windows 10 2004+ AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                AudioClient::new_application_loopback_client(pid, true)
                    .map_err(|e| anyhow!("Per-process WASAPI loopback activation failed for PID {pid}: {e:?}"))
            } else {
                let device = DeviceCollection::new(&Direction::Render)
                    .ok()
                    .and_then(|col| {
                        let count = col.get_nbr_devices().unwrap_or(0);
                        (0..count).find_map(|i| {
                            let d = col.get_device_at_index(i).ok()?;
                            if d.get_id().ok()? == device_id {
                                Some(d)
                            } else {
                                None
                            }
                        })
                    })
                    .or_else(|| wasapi::get_default_device(&Direction::Render).ok());

                match device {
                    Some(dev) => dev
                        .get_iaudioclient()
                        .map_err(|e| anyhow!("Failed to open WASAPI IAudioClient: {e:?}")),
                    None => Err(anyhow!("No WASAPI render device available")),
                }
            };

            let mut audio_client = match client_res {
                Ok(c) => c,
                Err(err) => {
                    tracing::error!(error = %err, "WASAPI capture init failed");
                    return;
                }
            };

            let (_def_time, min_time) = audio_client.get_periods().unwrap_or((100_000, 100_000));
            let mode = StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time.max(100_000),
            };

            if let Err(err) = audio_client.initialize_client(&desired_format, &Direction::Capture, &mode) {
                tracing::error!(error = ?err, "WASAPI initialize_client failed");
                return;
            }

            let event_handle = match audio_client.set_get_eventhandle() {
                Ok(h) => h,
                Err(err) => {
                    tracing::error!(error = ?err, "WASAPI event handle error");
                    return;
                }
            };

            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(c) => c,
                Err(err) => {
                    tracing::error!(error = ?err, "WASAPI capture client error");
                    return;
                }
            };

            if let Err(err) = audio_client.start_stream() {
                tracing::error!(error = ?err, "WASAPI start_stream failed");
                return;
            }

            let mut raw_queue: VecDeque<u8> = VecDeque::with_capacity(samples_per_frame * 8);
            let mut float_buf: Vec<f32> = Vec::with_capacity(samples_per_frame * 2);

            while !stop_flag.load(Ordering::Relaxed) {
                if event_handle.wait_for_event(50).is_ok() {
                    let _ = capture_client.read_from_device_to_deque(&mut raw_queue);
                    while raw_queue.len() >= 4 {
                        let bytes = [
                            raw_queue.pop_front().unwrap(),
                            raw_queue.pop_front().unwrap(),
                            raw_queue.pop_front().unwrap(),
                            raw_queue.pop_front().unwrap(),
                        ];
                        float_buf.push(f32::from_le_bytes(bytes));
                    }

                    while float_buf.len() >= samples_per_frame {
                        let frame: Vec<f32> = float_buf.drain(..samples_per_frame).collect();
                        let peak_db = compute_peak_db(&frame);
                        if tx.blocking_send(PcmChunk { samples: frame, peak_db }).is_err() {
                            break;
                        }
                    }
                }
            }

            let _ = audio_client.stop_stream();
        }

        #[cfg(not(windows))]
        {
            use std::sync::atomic::Ordering;
            // Non-Windows compile stub: emits silence frames at real-time cadence for CI/cross-dev.
            let silence = vec![0.0_f32; samples_per_frame];
            let interval = std::time::Duration::from_millis(frame_ms as u64);
            while !stop_flag.load(Ordering::Relaxed) {
                if tx
                    .blocking_send(PcmChunk {
                        samples: silence.clone(),
                        peak_db: -96.0,
                    })
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(interval);
            }
        }
    })
}
