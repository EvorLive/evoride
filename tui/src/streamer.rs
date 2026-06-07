//! Best-effort cloud streamer. When sync is enabled, the same tapped bytes that
//! feed the local recorder are mirrored to the relay over a WebSocket — and, in
//! the reverse direction, control input from the dashboard is delivered back to
//! be written into the pty.
//!
//! Networking runs on its own thread driven by a channel, so a slow or absent
//! relay never stalls the render loop. If the connection fails, local recording
//! still proceeds — streaming is purely additive.

use anyhow::{Context, Result};
use shared::{Control, SessionMeta, ViewerMsg};
use std::io::ErrorKind;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::thread::JoinHandle;
use std::time::Duration;
use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

enum Outbound {
    Output(Vec<u8>),
    Control(Control),
    Close,
}

pub struct Streamer {
    tx: Sender<Outbound>,
    /// Input bytes relayed from dashboard viewers, to be written to the pty.
    inbound: Receiver<Vec<u8>>,
    handle: Option<JoinHandle<()>>,
}

impl Streamer {
    /// Connect to `ws_base` (e.g. `ws://127.0.0.1:8787`) and announce the
    /// session. `token` gates the dashboard's control channel for this session.
    pub fn connect(ws_base: &str, meta: SessionMeta, token: &str) -> Result<Self> {
        let url = format!(
            "{}/produce/{}?token={}",
            ws_base.trim_end_matches('/'),
            meta.id,
            token
        );
        let (mut socket, _resp) =
            tungstenite::connect(&url).with_context(|| format!("connecting to relay at {url}"))?;

        // Poll-read with a short timeout so the single network thread can both
        // send queued output and pick up inbound control input.
        if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
        }

        socket
            .send(Message::Text(Control::Start(meta).to_json().into()))
            .context("sending session start")?;

        let (tx, rx) = channel::<Outbound>();
        let (in_tx, inbound) = channel::<Vec<u8>>();

        let handle = std::thread::spawn(move || {
            'outer: loop {
                // 1) Flush any queued outbound frames.
                loop {
                    match rx.try_recv() {
                        Ok(Outbound::Output(bytes)) => {
                            if socket.send(Message::Binary(bytes.into())).is_err() {
                                break 'outer;
                            }
                        }
                        Ok(Outbound::Control(ctrl)) => {
                            if socket.send(Message::Text(ctrl.to_json().into())).is_err() {
                                break 'outer;
                            }
                        }
                        Ok(Outbound::Close) => {
                            let _ = socket.send(Message::Text(Control::End.to_json().into()));
                            let _ = socket.close(None);
                            break 'outer;
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            let _ = socket.close(None);
                            break 'outer;
                        }
                    }
                }

                // 2) Read inbound control input (blocks up to the read timeout).
                match socket.read() {
                    Ok(Message::Text(text)) => {
                        if let Some(ViewerMsg::Input { data }) = ViewerMsg::from_json(text.as_str())
                        {
                            let _ = in_tx.send(data.into_bytes());
                        }
                    }
                    Ok(Message::Close(_)) => break 'outer,
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e))
                        if e.kind() == ErrorKind::WouldBlock
                            || e.kind() == ErrorKind::TimedOut =>
                    {
                        // No inbound message this tick — loop and flush again.
                    }
                    Err(_) => break 'outer,
                }
            }
        });

        Ok(Self {
            tx,
            inbound,
            handle: Some(handle),
        })
    }

    pub fn send_output(&self, bytes: &[u8]) {
        let _ = self.tx.send(Outbound::Output(bytes.to_vec()));
    }

    pub fn send_control(&self, ctrl: Control) {
        let _ = self.tx.send(Outbound::Control(ctrl));
    }

    /// Next chunk of dashboard-relayed input, if any (non-blocking).
    pub fn try_input(&self) -> Option<Vec<u8>> {
        self.inbound.try_recv().ok()
    }

    /// Signal end-of-session and join the network thread.
    pub fn close(mut self) {
        let _ = self.tx.send(Outbound::Close);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
