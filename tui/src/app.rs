//! App state: ties the pty, the vt100 emulator, the local recorder, and the
//! cloud streamer together. Owns the sync toggle that decides whether output is
//! being recorded/streamed.

use anyhow::Result;
use shared::{Control, SessionMeta};
use std::path::PathBuf;

use crate::detector::Detector;
use crate::pty::PtySession;
use crate::recorder::Recorder;
use crate::streamer::Streamer;

pub struct App {
    pub pty: PtySession,
    /// Terminal emulator: maintains the screen grid from the raw byte stream.
    pub parser: vt100::Parser,
    pub recorder: Option<Recorder>,
    /// Cloud streamer, present only while syncing and the relay is reachable.
    pub streamer: Option<Streamer>,
    /// Heuristic agent/prompt detector fed by the output stream.
    pub detector: Detector,
    /// Where a recording is written when sync turns on.
    pub record_dir: PathBuf,
    /// Relay base URL, e.g. `ws://127.0.0.1:8787`.
    pub server_url: String,
    /// Shell name, surfaced in session metadata.
    pub shell: String,
    pub sync_on: bool,
    /// Per-session secret the dashboard must present to send control input.
    pub control_token: String,
    /// Set when streaming was requested but the relay was unreachable.
    pub stream_error: Option<String>,
    pub should_quit: bool,
    pub rows: u16,
    pub cols: u16,
    /// Generated session id, shown in the status bar and used in share URLs.
    pub session_id: String,
}

impl App {
    pub fn new(
        shell: &str,
        record_dir: PathBuf,
        server_url: String,
        rows: u16,
        cols: u16,
    ) -> Result<Self> {
        let pty = PtySession::spawn(shell, rows, cols)?;
        let parser = vt100::Parser::new(rows, cols, 5000);
        let session_id = gen_session_id();
        Ok(Self {
            pty,
            parser,
            recorder: None,
            streamer: None,
            detector: Detector::new(),
            record_dir,
            server_url,
            shell: shell.to_string(),
            sync_on: false,
            control_token: gen_session_id(),
            stream_error: None,
            should_quit: false,
            rows,
            cols,
            session_id,
        })
    }

    /// Drain pty output: feed the emulator, record locally, and mirror to the
    /// relay — all from the single tap point.
    pub fn pump_output(&mut self) -> Result<()> {
        while let Ok(bytes) = self.pty.output_rx.try_recv() {
            self.parser.process(&bytes);
            if let Some(rec) = self.recorder.as_mut() {
                rec.record_output(&bytes)?;
            }
            // Detect agent/prompt changes and relay them alongside the output.
            if self.streamer.is_some() {
                let events = self.detector.feed(&bytes);
                if let Some(stream) = self.streamer.as_ref() {
                    stream.send_output(&bytes);
                    for ev in events {
                        stream.send_control(ev);
                    }
                }
            }
        }

        // Apply input relayed from the dashboard control channel.
        let mut relayed: Vec<Vec<u8>> = Vec::new();
        if let Some(stream) = self.streamer.as_ref() {
            while let Some(bytes) = stream.try_input() {
                relayed.push(bytes);
            }
        }
        for bytes in relayed {
            self.pty.write_input(&bytes)?;
        }
        Ok(())
    }

    pub fn send_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.pty.write_input(bytes)
    }

    /// Toggle recording/streaming. On enable, opens a fresh cast file and tries
    /// (best-effort) to connect the cloud streamer.
    pub fn toggle_sync(&mut self, timestamp: i64) -> Result<()> {
        if self.sync_on {
            self.sync_on = false;
            self.recorder = None;
            if let Some(stream) = self.streamer.take() {
                stream.close();
            }
        } else {
            std::fs::create_dir_all(&self.record_dir)?;
            let path = self.record_dir.join(format!("{}.cast", self.session_id));
            let mut rec = Recorder::create(&path, self.cols, self.rows, timestamp)?;
            rec.record_marker("session-sync-start")?;
            self.recorder = Some(rec);

            let meta = SessionMeta {
                id: self.session_id.clone(),
                title: session_title(),
                cols: self.cols,
                rows: self.rows,
                shell: self.shell.clone(),
                started_at: timestamp,
            };
            match Streamer::connect(&self.server_url, meta, &self.control_token) {
                Ok(stream) => {
                    self.streamer = Some(stream);
                    self.stream_error = None;
                }
                Err(e) => {
                    // Recording still works locally; note the relay miss.
                    self.streamer = None;
                    self.stream_error = Some(e.to_string());
                }
            }
            self.sync_on = true;
        }
        Ok(())
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<()> {
        self.rows = rows;
        self.cols = cols;
        self.parser.set_size(rows, cols);
        self.pty.resize(rows, cols)?;
        if let Some(stream) = self.streamer.as_ref() {
            stream.send_control(Control::Resize { cols, rows });
        }
        Ok(())
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Cleanly end any active stream so the dashboard marks the session ended.
    /// Called when eterm exits (quit chord or the shell process dying).
    pub fn shutdown(&mut self) {
        self.recorder = None;
        if let Some(stream) = self.streamer.take() {
            stream.close();
        }
        self.sync_on = false;
    }
}

/// A human-meaningful session label: the current working directory.
fn session_title() -> String {
    std::env::current_dir()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "eterm session".to_string())
}

/// Cheap, dependency-free session id derived from process + time entropy.
fn gen_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mix = nanos ^ (pid.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    format!("{:012x}", mix & 0xFFFF_FFFF_FFFF)
}
