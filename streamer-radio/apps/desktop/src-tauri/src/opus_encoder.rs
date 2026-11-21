use anyhow::{anyhow, Result};
use audiopus::{coder::Encoder, Application, Bitrate, Channels, SampleRate};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HEADER_BYTES: usize = 8;

/// Encodes 48 kHz stereo PCM float frames into 10 ms or 20 ms Opus packets
/// prefixed with the 8-byte wire header: [uint32 BE seq][uint32 BE timestamp_ms].
pub struct OpusFrameEncoder {
    encoder: Encoder,
    seq: u32,
    out_buf: Vec<u8>,
}

impl OpusFrameEncoder {
    pub fn new(bitrate_kbps: u32) -> Result<Self> {
        let mut encoder = Encoder::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio)
            .map_err(|e| anyhow!("Opus encoder init failed: {e:?}"))?;
        let bps = (bitrate_kbps.clamp(24, 192) * 1000) as i32;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(bps))
            .map_err(|e| anyhow!("Opus bitrate config failed: {e:?}"))?;
        let _ = encoder.set_inband_fec(true);
        let _ = encoder.set_packet_loss_perc(5);

        Ok(Self {
            encoder,
            seq: 0,
            out_buf: vec![0u8; 4096],
        })
    }

    pub fn encode_framed(&mut self, pcm_stereo_f32: &[f32]) -> Result<Vec<u8>> {
        let encoded_len = self
            .encoder
            .encode_float(pcm_stereo_f32, &mut self.out_buf)
            .map_err(|e| anyhow!("Opus encode failed: {e:?}"))?;

        self.seq = self.seq.wrapping_add(1);
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u32)
            .unwrap_or(0);

        let mut packet = Vec::with_capacity(HEADER_BYTES + encoded_len);
        packet.extend_from_slice(&self.seq.to_be_bytes());
        packet.extend_from_slice(&ts_ms.to_be_bytes());
        packet.extend_from_slice(&self.out_buf[..encoded_len]);
        Ok(packet)
    }
}
