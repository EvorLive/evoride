//! Local session recorder. Captures the raw pty output stream in asciinema v2
//! cast format (one JSON header line + `[time, "o", data]` event lines).
//!
//! This is the "tap" the cloud sync layer will later mirror over a WebSocket.
//! When recording is OFF, nothing is written and nothing leaves the machine.

use anyhow::Result;
use serde_json::json;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

pub struct Recorder {
    writer: BufWriter<File>,
    start: Instant,
}

impl Recorder {
    /// Create a new cast file and write the asciinema v2 header.
    pub fn create(path: &Path, cols: u16, rows: u16, timestamp: i64) -> Result<Self> {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        let header = json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": timestamp,
            "env": { "TERM": "xterm-256color", "SHELL": std::env::var("SHELL").unwrap_or_default() },
        });
        writeln!(writer, "{}", header)?;
        writer.flush()?;
        Ok(Self {
            writer,
            start: Instant::now(),
        })
    }

    /// Append an output event carrying raw terminal bytes.
    pub fn record_output(&mut self, bytes: &[u8]) -> Result<()> {
        let t = self.start.elapsed().as_secs_f64();
        let data = String::from_utf8_lossy(bytes);
        let line = json!([t, "o", data]);
        writeln!(self.writer, "{}", line)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Append a structured marker event (session start, prompt sent, etc.).
    pub fn record_marker(&mut self, label: &str) -> Result<()> {
        let t = self.start.elapsed().as_secs_f64();
        let line = json!([t, "m", label]);
        writeln!(self.writer, "{}", line)?;
        self.writer.flush()?;
        Ok(())
    }
}
