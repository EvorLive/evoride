//! Real pseudo-terminal: spawns a shell so every binary works natively.
//! A reader thread taps the raw output stream and forwards bytes over a channel
//! — this is the single point where session recording/streaming hooks in.

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;

/// Owns the pty master, the spawned shell, and a writer back into the pty.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Raw bytes read from the shell's output, delivered off the read thread.
    pub output_rx: Receiver<Vec<u8>>,
}

impl PtySession {
    /// Spawn `shell` inside a fresh pty of the given size.
    pub fn spawn(shell: &str, rows: u16, cols: u16) -> Result<Self> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        if let Ok(cwd) = std::env::current_dir() {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn shell")?;
        // Slave handle no longer needed in this process once the child holds it.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader failed")?;
        let writer = pair.master.take_writer().context("take pty writer failed")?;

        let (tx, output_rx): (Sender<Vec<u8>>, Receiver<Vec<u8>>) = channel();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: shell exited
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            master: pair.master,
            writer,
            child,
            output_rx,
        })
    }

    /// Forward user keystrokes into the shell.
    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Keep the pty and the emulator in sync with the visible area.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// True once the shell process has exited.
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}
