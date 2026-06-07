//! eterm — a smart terminal.
//!
//! A real pty-backed shell rendered in a ratatui TUI, with an opt-in recording
//! layer (Ctrl-S) that taps the raw output stream. Recording locally today;
//! the same tap point streams to the cloud backend once that's wired up.

mod app;
mod detector;
mod pty;
mod recorder;
mod streamer;
mod ui;

use anyhow::Result;
use clap::Parser;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::path::PathBuf;

use app::App;

#[derive(Parser, Debug)]
#[command(name = "eterm", about = "A smart terminal with opt-in cloud session sync")]
struct Args {
    /// Shell to launch (defaults to $SHELL, then /bin/sh).
    #[arg(long)]
    shell: Option<String>,

    /// Directory where session recordings are written.
    #[arg(long, default_value = "~/.eterm/sessions")]
    record_dir: String,

    /// Relay base URL to stream sessions to when sync is on.
    #[arg(long, default_value = "ws://127.0.0.1:8787")]
    server: String,

    /// Start with session sync already enabled.
    #[arg(long)]
    sync: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let shell = args.shell.unwrap_or_else(default_shell);
    let record_dir = expand_tilde(&args.record_dir);

    let mut terminal = ratatui::init();
    let size = terminal.size()?;
    // Reserve the bottom row for the status bar.
    let rows = size.height.saturating_sub(1).max(1);
    let cols = size.width.max(1);

    let mut app = App::new(&shell, record_dir, args.server, rows, cols)?;
    if args.sync {
        app.toggle_sync(now_unix())?;
    }

    let res = run(&mut terminal, &mut app);

    // Notify the dashboard the session ended (no-op when sync was never on).
    app.shutdown();
    ratatui::restore();
    res
}

fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<()> {
    loop {
        app.pump_output()?;

        if app.pty.has_exited() {
            break;
        }

        terminal.draw(|f| ui::draw(f, app))?;

        // Poll briefly so output keeps flowing even without keypresses.
        if event::poll(Duration::from_millis(16))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    handle_key(app, key)?;
                }
                Event::Resize(w, h) => {
                    let rows = h.saturating_sub(1).max(1);
                    let cols = w.max(1);
                    app.resize(rows, cols)?;
                }
                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }
    Ok(())
}

/// Translate key events into pty input, intercepting eterm's own chords first.
fn handle_key(app: &mut App, key: KeyEvent) -> Result<()> {
    // Control chords reserved by eterm.
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('q') => {
                app.should_quit = true;
                return Ok(());
            }
            KeyCode::Char('s') => {
                app.toggle_sync(now_unix())?;
                return Ok(());
            }
            _ => {}
        }
    }

    let bytes = encode_key(key);
    if !bytes.is_empty() {
        app.send_input(&bytes)?;
    }
    Ok(())
}

/// Encode a key event into the byte sequence a real terminal would send.
fn encode_key(key: KeyEvent) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);

    let mut out: Vec<u8> = match key.code {
        KeyCode::Char(c) => {
            if ctrl {
                // Map Ctrl-A..Ctrl-Z and a few symbols to control codes.
                let b = c.to_ascii_lowercase() as u8;
                if b.is_ascii_alphabetic() {
                    vec![b - b'a' + 1]
                } else {
                    match c {
                        ' ' => vec![0],
                        '\\' => vec![28],
                        ']' => vec![29],
                        '^' => vec![30],
                        '_' => vec![31],
                        _ => c.to_string().into_bytes(),
                    }
                }
            } else {
                c.to_string().into_bytes()
            }
        }
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::BackTab => vec![0x1b, b'[', b'Z'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Left => vec![0x1b, b'[', b'D'],
        KeyCode::Right => vec![0x1b, b'[', b'C'],
        KeyCode::Up => vec![0x1b, b'[', b'A'],
        KeyCode::Down => vec![0x1b, b'[', b'B'],
        KeyCode::Home => vec![0x1b, b'[', b'H'],
        KeyCode::End => vec![0x1b, b'[', b'F'],
        KeyCode::PageUp => vec![0x1b, b'[', b'5', b'~'],
        KeyCode::PageDown => vec![0x1b, b'[', b'6', b'~'],
        KeyCode::Delete => vec![0x1b, b'[', b'3', b'~'],
        KeyCode::Insert => vec![0x1b, b'[', b'2', b'~'],
        _ => Vec::new(),
    };

    // Alt prefixes the sequence with ESC, as most terminals do.
    if alt && !out.is_empty() {
        let mut prefixed = vec![0x1b];
        prefixed.append(&mut out);
        return prefixed;
    }
    out
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
