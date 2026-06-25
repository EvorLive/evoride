//! evor.dev cloud link — reach this IDE from anywhere, not just the LAN.
//!
//! The desktop dials OUT to the evor.dev relay (`/link/host`, authed by the
//! device token from Settings → Remote) and serves the same `serve::dispatch`
//! over the socket. A phone on cellular connects to the relay (`/link/join`) and
//! gets the same IDE — sharing the desktop's live `SessionManager` (via the
//! shared `dispatch_app` + the `TauriSink` event tee).
//!
//! END-TO-END ENCRYPTED: every frame is XChaCha20-Poly1305 sealed with a key the
//! desktop and phone share OUT OF BAND (the pairing QR). evor.dev only relays
//! ciphertext — it can't read terminals/code/secrets or MITM the session. The
//! relay is untrusted; command handling still goes through the confine/trust
//! gates in `serve::dispatch`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

const RECONNECT_SECS: u64 = 5;

/// Managed state: the running cloud link (if any).
#[derive(Default)]
pub struct CloudState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    /// Plaintext host→client frames (responses + events) fanned to the session.
    tx: broadcast::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    base: String,
}

#[derive(Serialize, Clone)]
pub struct CloudStatus {
    pub running: bool,
    pub url: String,
}

impl CloudState {
    pub fn status(&self) -> CloudStatus {
        match self.inner.lock().unwrap().as_ref() {
            Some(r) => CloudStatus { running: true, url: r.base.clone() },
            None => CloudStatus { running: false, url: String::new() },
        }
    }

    /// Event broadcast sender, so `TauriSink` tees agent output to a connected
    /// cloud client. `None` when the link is off.
    pub fn broadcast(&self) -> Option<broadcast::Sender<Vec<u8>>> {
        self.inner.lock().unwrap().as_ref().map(|r| r.tx.clone())
    }

    pub fn start(&self, app: &AppHandle) -> Result<CloudStatus, String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(r) = guard.as_ref() {
            return Ok(CloudStatus { running: true, url: r.base.clone() });
        }
        // Reuse the evor.dev base + device token configured in Settings → Remote.
        let base = {
            let s = app.state::<crate::settings::SettingsStore>().get();
            crate::remote::validate_url(&s.remote_url)?
        };
        let token = crate::secrets::load_evor_token()
            .ok_or("connect evor.dev in Settings → Remote first (no device token)")?;
        let key = crate::secrets::cloud_key_or_create()?;

        let (tx, _rx) = broadcast::channel::<Vec<u8>>(4096);
        let stop = Arc::new(AtomicBool::new(false));
        let (app2, base2, tx2, stop2) = (app.clone(), base.clone(), tx.clone(), stop.clone());
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("cloud: runtime: {e}");
                    return;
                }
            };
            rt.block_on(run_link(app2, base2, token, key, tx2, stop2));
        });

        *guard = Some(Running { tx, stop, base: base.clone() });
        Ok(CloudStatus { running: true, url: base })
    }

    pub fn stop(&self) -> CloudStatus {
        if let Some(r) = self.inner.lock().unwrap().take() {
            r.stop.store(true, Ordering::Relaxed);
        }
        CloudStatus { running: false, url: String::new() }
    }
}

/// The pairing a phone needs to connect over the cloud, as a scannable QR.
/// The QR encodes a link the phone opens; the fragment carries the E2E key +
/// device id OUT OF BAND so evor.dev never sees/controls them.
#[derive(Serialize, Clone)]
pub struct CloudPairing {
    /// Link to open on the phone (`<base>/#cloud=<base64url({device,key})>`).
    pub url: String,
    /// This desktop's evor.dev device id (the relay room).
    pub device: String,
    /// Inline SVG QR for `url`.
    pub qr_svg: String,
}

/// Build the cloud pairing (device id from evor.dev `/device/me`, the shared E2E
/// key, and a QR). The key is the pairing secret — like a password — so the QR
/// is shown only to the user to scan on their own phone.
pub fn pairing(app: &AppHandle) -> Result<CloudPairing, String> {
    use base64::Engine;
    let base = {
        let s = app.state::<crate::settings::SettingsStore>().get();
        crate::remote::validate_url(&s.remote_url)?
    };
    let token = crate::secrets::load_evor_token()
        .ok_or("connect evor.dev in Settings → Remote first (no device token)")?;
    let key = crate::secrets::cloud_key_or_create()?;
    let device = fetch_device_id(&base, &token)?;
    let payload = json!({ "device": device, "key": hex::encode(key) }).to_string();
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes());
    let url = format!("{base}/#cloud={b64}");
    let qr_svg = crate::mobile::qr_svg(&url);
    Ok(CloudPairing { url, device, qr_svg })
}

/// Ask evor.dev who this device is (token → id), so the phone can join the
/// right `/link/join/:device` room.
fn fetch_device_id(base: &str, token: &str) -> Result<String, String> {
    let cl = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = cl
        .get(format!("{base}/device/me"))
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("evor.dev device/me: {}", resp.status()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    v.get("id")
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| "evor.dev returned no device id".to_string())
}

/// One plaintext event frame for the cloud client: `{"t":"ev","topic","payload"}`.
pub fn event_frame(topic: &str, payload: &Value) -> Vec<u8> {
    json!({ "t": "ev", "topic": topic, "payload": payload })
        .to_string()
        .into_bytes()
}

// --- connection loop ------------------------------------------------------

async fn run_link(
    app: AppHandle,
    base: String,
    token: String,
    key: [u8; 32],
    tx: broadcast::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
) {
    let url = host_url(&base, &token);
    while !stop.load(Ordering::Relaxed) {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => serve_session(&app, ws, &key, &tx, &stop).await,
            Err(e) => eprintln!("cloud: connect {base}: {e}"),
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(RECONNECT_SECS)).await;
    }
}

async fn serve_session<S>(
    app: &AppHandle,
    ws: tokio_tungstenite::WebSocketStream<S>,
    key: &[u8; 32],
    tx: &broadcast::Sender<Vec<u8>>,
    stop: &Arc<AtomicBool>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut write, mut read) = ws.split();
    // Single outbound queue of PLAINTEXT frames; the writer seals each.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut ev_rx = tx.subscribe();

    loop {
        tokio::select! {
            incoming = read.next() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(pt) = open(key, &data) {
                        if let Ok(req) = serde_json::from_slice::<ReqFrame>(&pt) {
                            let app = app.clone();
                            let out = out_tx.clone();
                            // Commands are blocking (sqlite/git/pty) — off the executor.
                            tokio::spawn(async move {
                                let res = tokio::task::spawn_blocking(move || {
                                    crate::dispatch_app(&app, &req.cmd, &req.args)
                                })
                                .await
                                .unwrap_or_else(|_| Err("command panicked".into()));
                                let frame = match res {
                                    Ok(data) => json!({"t":"res","id":req.id,"ok":true,"data":data}),
                                    Err(e) => json!({"t":"res","id":req.id,"ok":false,"error":e}),
                                };
                                let _ = out.send(frame.to_string().into_bytes());
                            });
                        }
                    }
                }
                Some(Ok(Message::Ping(p))) => { let _ = write.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            },
            out = out_rx.recv() => match out {
                Some(pt) => {
                    if write.send(Message::Binary(seal(key, &pt).into())).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            ev = ev_rx.recv() => match ev {
                Ok(frame) => { let _ = out_tx.send(frame); }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
    }
}

#[derive(serde::Deserialize)]
struct ReqFrame {
    #[serde(default)]
    id: String,
    cmd: String,
    #[serde(default)]
    args: Value,
}

// --- crypto (XChaCha20-Poly1305; frame = 24-byte nonce || ciphertext) -----

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("32-byte key")
}

fn seal(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    use rand::RngCore;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    match cipher(key).encrypt(XNonce::from_slice(&nonce), plaintext) {
        Ok(ct) => {
            let mut out = nonce.to_vec();
            out.extend_from_slice(&ct);
            out
        }
        Err(_) => Vec::new(),
    }
}

fn open(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 24 {
        return None;
    }
    let (nonce, ct) = data.split_at(24);
    cipher(key).decrypt(XNonce::from_slice(nonce), ct).ok()
}

/// `wss://host/link/host?token=…` from the base (http→ws, https→wss).
fn host_url(base: &str, token: &str) -> String {
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{base}")
    };
    format!("{ws}/link/host?token={token}")
}
