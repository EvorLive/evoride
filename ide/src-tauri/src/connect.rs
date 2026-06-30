//! One-click "Connect evor.dev" — OAuth loopback flow (RFC 8252) with PKCE.
//!
//! Instead of pasting a device token, the IDE:
//!   1. starts a one-shot loopback listener on 127.0.0.1:<random>,
//!   2. opens the browser to `<base>/connect?cb=…&state=…&challenge=…&name=…`,
//!   3. the user logs in + approves the device on evor.dev,
//!   4. evor.dev redirects to the loopback `…/cb?code=…&state=…`,
//!   5. the IDE exchanges the code (with the PKCE verifier) at `/device/exchange`
//!      for a device token, which it stores — now connected.
//!
//! Security: loopback-only, ephemeral single-use listener; `state` (CSRF); a
//! one-time short-TTL `code`; PKCE so another local app can't steal the code; the
//! token is returned only over HTTPS at exchange, never in the redirect URL.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Default hosted base when the user hasn't set one in Settings → Remote.
const DEFAULT_BASE: &str = "https://evor.dev";
/// How long to wait for the browser round-trip before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Serialize, Clone)]
pub struct Connected {
    /// The device name evor.dev assigned (shown in the UI).
    pub device: String,
    /// The evor.dev base now configured.
    pub url: String,
}

/// Run the loopback login. Blocking — call from a Tauri command worker.
pub fn login(app: &AppHandle) -> Result<Connected, String> {
    // Base: the configured remote URL if valid, else the hosted default.
    let base = {
        let s = app.state::<crate::settings::SettingsStore>().get();
        crate::remote::validate_url(&s.remote_url).unwrap_or_else(|_| DEFAULT_BASE.to_string())
    };

    // Loopback listener on an ephemeral port.
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("loopback bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    // PKCE + CSRF state. Challenge = hex(sha256(verifier)) — our own client and
    // server, so hex keeps the evor.dev side dependency-light (sha2 + hex).
    let verifier = b64url(&rand_bytes::<32>());
    let challenge = hex_bytes(sha256(verifier.as_bytes()).as_slice());
    let state = hex_bytes(&rand_bytes::<16>());
    let name = format!(
        "EvorIDE-{}",
        std::env::var("USER").unwrap_or_else(|_| "device".into())
    );

    let cb = format!("http://127.0.0.1:{port}/cb");
    let url = format!(
        "{base}/connect?cb={}&state={state}&challenge={challenge}&name={name}",
        pct(&cb)
    );
    open_browser(&url)?;

    // Wait for the single callback request, then parse code + state.
    let (code, got_state) = wait_for_callback(&listener)?;
    if got_state != state {
        return Err("state mismatch (possible CSRF) — try again".into());
    }
    if code.is_empty() {
        return Err("no authorization code returned".into());
    }

    // Exchange the code (with the PKCE verifier) for a device token.
    let cl = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = cl
        .post(format!("{base}/device/exchange"))
        .json(&serde_json::json!({ "code": code, "verifier": verifier }))
        .send()
        .map_err(|e| format!("exchange: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("evor.dev rejected the connection ({})", resp.status()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    let token = v
        .get("token")
        .and_then(|x| x.as_str())
        .ok_or("evor.dev returned no token")?;
    let device = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("EvorIDE")
        .to_string();

    // Persist: store the token + remember the base + enable remote.
    crate::secrets::save_evor_token(Some(token.to_string()))?;
    let _ = app
        .state::<crate::settings::SettingsStore>()
        .set_remote(base.clone(), true);

    Ok(Connected { device, url: base })
}

/// Poll the non-blocking listener until one request arrives (or timeout), parse
/// `GET /cb?code=…&state=…`, and send a friendly close-the-tab page.
fn wait_for_callback(listener: &TcpListener) -> Result<(String, String), String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut line = String::new();
                let mut reader = BufReader::new(&stream);
                let _ = reader.read_line(&mut line);
                let (code, state) = parse_cb(&line);
                let body = "<!doctype html><meta charset=utf-8><title>EvorIDE</title>\
                    <body style=\"font:16px system-ui;padding:3rem;text-align:center\">\
                    <h2>✓ Connected to evor.dev</h2><p>You can close this tab and return to EvorIDE.</p>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
                return Ok((code, state));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for the browser — try again".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("loopback accept: {e}")),
        }
    }
}

/// Pull `code` and `state` out of a `GET /cb?…` request line.
fn parse_cb(request_line: &str) -> (String, String) {
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = String::new();
    let mut state = String::new();
    for kv in query.split('&') {
        if let Some((k, val)) = kv.split_once('=') {
            match k {
                "code" => code = pct_decode(val),
                "state" => state = pct_decode(val),
                _ => {}
            }
        }
    }
    (code, state)
}

// --- small helpers (no extra deps) ----------------------------------------

fn rand_bytes<const N: usize>() -> [u8; N] {
    use rand::RngCore;
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

fn sha256(data: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().to_vec()
}

fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn hex_bytes(data: &[u8]) -> String {
    hex::encode(data)
}

/// Minimal percent-encoding for a URL query value (encode all but unreserved).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open the system browser at `url` (best-effort, per platform).
fn open_browser(url: &str) -> Result<(), String> {
    use std::process::Command;
    let r = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    r.map(|_| ()).map_err(|e| format!("could not open browser: {e}"))
}
