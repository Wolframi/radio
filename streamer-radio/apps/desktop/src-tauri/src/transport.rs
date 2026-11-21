use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use wtransport::{ClientConfig, Endpoint};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchTelemetry {
    pub branch_slug: String,
    pub transport: String, // "webtransport" | "websocket" | "reconnecting"
    pub connected: bool,
    pub rtt_ms: u64,
    pub dropped_frames: u64,
    pub buffer_ms: u64,
    pub level_db: f32,
}

pub struct IngestTransportConfig {
    pub server_base_url: String,
    pub user_slug: String,
    pub branch_slug: String,
    pub jwt_token: String,
    pub prefer_webtransport: bool,
    pub frame_ms: u32,
}

/// Streams encoded Opus binary packets to `/ingest/:userSlug/:branchSlug`.
/// Attempts HTTP/3 QUIC WebTransport datagrams first, automatically falling back
/// to WebSocket (`wss://`) with exponential backoff reconnection (500ms -> 10s).
pub async fn run_ingest_transport(
    cfg: IngestTransportConfig,
    mut rx: mpsc::Receiver<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
    dropped_frames: Arc<AtomicU64>,
    rtt_ms: Arc<AtomicU64>,
    active_transport: Arc<tokio::sync::RwLock<String>>,
) {
    let mut backoff_ms = 500_u64;

    while !stop_flag.load(Ordering::Relaxed) {
        let mut connected_ok = false;

        if cfg.prefer_webtransport && cfg.server_base_url.starts_with("https://") {
            let wt_url = format!(
                "{}/ingest/{}/{}?token={}",
                cfg.server_base_url.trim_end_matches('/'),
                cfg.user_slug,
                cfg.branch_slug,
                cfg.jwt_token
            );

            match try_webtransport_session(&wt_url, &mut rx, &stop_flag, &dropped_frames, &active_transport).await {
                Ok(()) => {
                    connected_ok = true;
                    backoff_ms = 500;
                }
                Err(err) => {
                    tracing::warn!(error = %err, branch = %cfg.branch_slug, "WebTransport ingest failed, falling back to WebSocket");
                }
            }
        }

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Fallback: WebSocket (wss:// or ws://)
        let ws_base = cfg
            .server_base_url
            .trim_end_matches('/')
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let ws_url = format!(
            "{}/ingest/{}/{}?token={}",
            ws_base, cfg.user_slug, cfg.branch_slug, cfg.jwt_token
        );

        match try_websocket_session(&ws_url, &mut rx, &stop_flag, &dropped_frames, &rtt_ms, &active_transport).await {
            Ok(()) => {
                connected_ok = true;
                backoff_ms = 500;
            }
            Err(err) => {
                tracing::warn!(error = %err, branch = %cfg.branch_slug, "WebSocket ingest disconnected");
            }
        }

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        *active_transport.write().await = "reconnecting".into();
        if !connected_ok {
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(10_000);
        }
    }
}

async fn try_webtransport_session(
    url: &str,
    rx: &mut mpsc::Receiver<Vec<u8>>,
    stop_flag: &Arc<AtomicBool>,
    dropped_frames: &Arc<AtomicU64>,
    active_transport: &Arc<tokio::sync::RwLock<String>>,
) -> Result<()> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_native_certs()
        .build();
    let endpoint = Endpoint::client(config)?;
    let connection = tokio::time::timeout(Duration::from_secs(3), endpoint.connect(url))
        .await
        .map_err(|_| anyhow!("WebTransport handshake timeout"))??;

    *active_transport.write().await = "webtransport".into();

    while !stop_flag.load(Ordering::Relaxed) {
        match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
            Ok(Some(packet)) => {
                if connection.send_datagram(packet).is_err() {
                    dropped_frames.fetch_add(1, Ordering::Relaxed);
                    return Err(anyhow!("WebTransport datagram send error"));
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    Ok(())
}

async fn try_websocket_session(
    url: &str,
    rx: &mut mpsc::Receiver<Vec<u8>>,
    stop_flag: &Arc<AtomicBool>,
    dropped_frames: &Arc<AtomicU64>,
    rtt_ms: &Arc<AtomicU64>,
    active_transport: &Arc<tokio::sync::RwLock<String>>,
) -> Result<()> {
    let (ws_stream, _) = tokio::time::timeout(Duration::from_secs(5), connect_async(url))
        .await
        .map_err(|_| anyhow!("WebSocket connect timeout"))??;

    *active_transport.write().await = "websocket".into();
    let (mut write, mut read) = ws_stream.split();
    let mut last_ping = Instant::now();

    while !stop_flag.load(Ordering::Relaxed) {
        if last_ping.elapsed() >= Duration::from_secs(2) {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let ping_json = format!(r#"{{"type":"ping","clientTimeMs":{now_ms}}}"#);
            if write.send(Message::Text(ping_json.into())).await.is_err() {
                return Err(anyhow!("WebSocket ping send failed"));
            }
            last_ping = Instant::now();
        }

        tokio::select! {
            maybe_pkt = rx.recv() => {
                match maybe_pkt {
                    Some(packet) => {
                        if write.send(Message::Binary(packet.into())).await.is_err() {
                            dropped_frames.fetch_add(1, Ordering::Relaxed);
                            return Err(anyhow!("WebSocket binary send failed"));
                        }
                    }
                    None => break,
                }
            }
            maybe_in = read.next() => {
                match maybe_in {
                    Some(Ok(Message::Text(txt))) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                            if val.get("type").and_then(|v| v.as_str()) == Some("pong") {
                                if let Some(sent) = val.get("clientTimeMs").and_then(|v| v.as_u64()) {
                                    let now_ms = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(sent);
                                    rtt_ms.store(now_ms.saturating_sub(sent), Ordering::Relaxed);
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Err(anyhow!("WebSocket closed by server")),
                    _ => {}
                }
            }
        }
    }

    let _ = write.close().await;
    Ok(())
}
