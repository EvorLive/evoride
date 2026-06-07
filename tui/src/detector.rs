//! Heuristic agent detector. Taps the decoded pty output stream to infer which
//! coding agent is running (Claude Code / Codex), its model and rough state,
//! and — crucially — when it is blocked on a permission prompt. Detected
//! changes are emitted as `Control` events the streamer relays to the dashboard,
//! which is what makes the remote reply buttons light up automatically.
//!
//! This is best-effort pattern matching over terminal output, not a parser of
//! any private protocol; it degrades gracefully when patterns don't match.

use eterm_core::strip_ansi;
use regex::Regex;
use shared::{AgentKind, AgentState, AgentStatus, Control};
use std::sync::OnceLock;

/// How much recent (ANSI-stripped) output to keep for matching.
const BUF_CAP: usize = 6000;
/// Window at the tail we scan for an active prompt.
const TAIL: usize = 1800;

pub struct Detector {
    buf: String,
    kind: AgentKind,
    model: Option<String>,
    state: AgentState,
    /// Signature (joined options) of the prompt currently displayed, if any.
    current_prompt: Option<String>,
    req_counter: u64,
}

impl Default for Detector {
    fn default() -> Self {
        Self {
            buf: String::new(),
            kind: AgentKind::Unknown,
            model: None,
            state: AgentState::Idle,
            current_prompt: None,
            req_counter: 0,
        }
    }
}

impl Detector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a raw output chunk; returns any control events worth relaying.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Control> {
        let text = strip_ansi(bytes);
        if !text.is_empty() {
            self.buf.push_str(&text);
            if self.buf.len() > BUF_CAP {
                let cut = self.buf.len() - BUF_CAP;
                // Keep a char boundary.
                let cut = (cut..self.buf.len())
                    .find(|&i| self.buf.is_char_boundary(i))
                    .unwrap_or(self.buf.len());
                self.buf.drain(0..cut);
            }
        }

        let mut events = Vec::new();

        let prev_kind = self.kind;
        let prev_model = self.model.clone();
        let prev_state = self.state;

        self.detect_kind();
        self.detect_model();

        // Prompt detection drives both the prompt event and the state.
        let prompt = self.detect_prompt();
        match &prompt {
            Some(p) => {
                self.state = AgentState::WaitingInput;
                let sig = p.options.join("|");
                if self.current_prompt.as_deref() != Some(sig.as_str()) {
                    self.current_prompt = Some(sig);
                    self.req_counter += 1;
                    events.push(Control::PermissionRequest {
                        request_id: format!("req-{}", self.req_counter),
                        prompt: p.prompt.clone(),
                        options: p.options.clone(),
                    });
                }
            }
            None => {
                self.current_prompt = None;
                self.state = if self.is_working() {
                    AgentState::Thinking
                } else {
                    AgentState::Idle
                };
            }
        }

        // Emit a status update whenever kind/model/state shifts.
        if self.kind != prev_kind || self.model != prev_model || self.state != prev_state {
            events.push(Control::Agent(AgentStatus {
                kind: self.kind,
                state: self.state,
                model: self.model.clone(),
                context_pct: self.detect_context_pct(),
                tokens_in: None,
                tokens_out: None,
                cost_usd: None,
                action: None,
            }));
        }

        events
    }

    fn detect_kind(&mut self) {
        if self.kind != AgentKind::Unknown {
            return; // sticky once known
        }
        let b = &self.buf;
        if b.contains("Claude Code") || b.contains("Welcome to Claude Code") || b.contains("claude-")
        {
            self.kind = AgentKind::ClaudeCode;
        } else if b.contains("OpenAI Codex") || b.contains("Codex CLI") || b.contains("codex") {
            self.kind = AgentKind::Codex;
        }
    }

    fn detect_model(&mut self) {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| {
            Regex::new(r"(claude-[a-z0-9][a-z0-9.\-]+|gpt-[a-z0-9.\-]+|o[1-9][a-z0-9.\-]*)").unwrap()
        });
        if let Some(m) = re.find_iter(&self.buf).last() {
            self.model = Some(m.as_str().to_string());
        }
    }

    fn detect_context_pct(&self) -> Option<f32> {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"(\d{1,3})%\s*context").unwrap());
        re.captures_iter(&self.buf)
            .last()
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<f32>().ok())
    }

    /// True if the agent appears to be actively working (spinner / interrupt
    /// hint), used to distinguish Thinking from Idle.
    fn is_working(&self) -> bool {
        let tail = self.tail();
        tail.contains("esc to interrupt")
            || tail.contains("Thinking")
            || tail.contains("Working")
            || tail.chars().any(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
    }

    fn tail(&self) -> &str {
        let len = self.buf.len();
        let start = len.saturating_sub(TAIL);
        let start = (start..=len)
            .find(|&i| self.buf.is_char_boundary(i))
            .unwrap_or(len);
        &self.buf[start..]
    }

    /// Look for a permission/choice prompt near the tail and extract its
    /// question and options.
    fn detect_prompt(&self) -> Option<DetectedPrompt> {
        static NUM: OnceLock<Regex> = OnceLock::new();
        let num = NUM.get_or_init(|| {
            // e.g. "❯ 1. Yes" / "  2. No, edit first"
            Regex::new(r"(?m)^\s*[❯>\u{276f}]?\s*([1-9])[.)]\s+(.{1,80}?)\s*$").unwrap()
        });

        let tail = self.tail();

        // Numbered-menu style (Claude Code's permission prompt).
        let mut opts: Vec<(u8, String)> = Vec::new();
        for cap in num.captures_iter(tail) {
            if let (Some(n), Some(label)) = (cap.get(1), cap.get(2)) {
                if let Ok(n) = n.as_str().parse::<u8>() {
                    let label = label.as_str().trim().to_string();
                    if !label.is_empty() && !opts.iter().any(|(k, _)| *k == n) {
                        opts.push((n, label));
                    }
                }
            }
        }
        if opts.len() >= 2 {
            opts.sort_by_key(|(n, _)| *n);
            let prompt = last_question(tail).unwrap_or_else(|| "Agent is asking:".to_string());
            return Some(DetectedPrompt {
                prompt,
                options: opts.into_iter().map(|(_, l)| l).collect(),
            });
        }

        // (y/n) style.
        let lower = tail.to_lowercase();
        if lower.contains("(y/n)") || lower.contains("[y/n]") || lower.contains("yes/no") {
            let prompt = last_question(tail).unwrap_or_else(|| "Confirm?".to_string());
            return Some(DetectedPrompt {
                prompt,
                options: vec!["yes".to_string(), "no".to_string()],
            });
        }

        None
    }
}

struct DetectedPrompt {
    prompt: String,
    options: Vec<String>,
}

/// Last non-empty line ending in '?' within `text`.
fn last_question(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .find(|l| l.ends_with('?'))
        .map(|l| l.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_kind(events: &[Control]) -> Vec<&AgentStatus> {
        events
            .iter()
            .filter_map(|e| match e {
                Control::Agent(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    fn perm(events: &[Control]) -> Option<(&str, Vec<String>)> {
        events.iter().find_map(|e| match e {
            Control::PermissionRequest { prompt, options, .. } => {
                Some((prompt.as_str(), options.clone()))
            }
            _ => None,
        })
    }

    #[test]
    fn strips_csi_and_osc() {
        let raw = b"\x1b[1;32mhello\x1b[0m \x1b]0;title\x07world\r\n";
        assert_eq!(strip_ansi(raw), "hello world\n");
    }

    #[test]
    fn detects_claude_numbered_prompt() {
        let mut d = Detector::new();
        // Establish the agent first.
        let _ = d.feed(b"Welcome to Claude Code! Using model claude-opus-4-8\n");
        let prompt = "Do you want to make this edit to app.rs?\n\
                      ❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, tell Claude what to do\n";
        let events = d.feed(prompt.as_bytes());
        let (q, opts) = perm(&events).expect("permission request emitted");
        assert!(q.contains("make this edit"), "question: {q}");
        assert_eq!(opts.len(), 3);
        assert_eq!(opts[0], "Yes");
        assert_eq!(opts[2], "No, tell Claude what to do");

        // Same prompt again → no duplicate event.
        let again = d.feed(prompt.as_bytes());
        assert!(perm(&again).is_none(), "duplicate prompt should not re-emit");
    }

    #[test]
    fn detects_kind_model_and_yes_no() {
        let mut d = Detector::new();
        let events = d.feed(b"claude-sonnet-4-6 ready\nProceed with deletion? (y/n)\n");
        let statuses = agent_kind(&events);
        assert!(
            statuses.iter().any(|s| s.kind == AgentKind::ClaudeCode),
            "should detect Claude Code"
        );
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-4-6"));
        let (_, opts) = perm(&events).expect("y/n prompt emitted");
        assert_eq!(opts, vec!["yes".to_string(), "no".to_string()]);
        assert_eq!(d.state, AgentState::WaitingInput);
    }

    #[test]
    fn no_prompt_when_just_output() {
        let mut d = Detector::new();
        let events = d.feed(b"$ ls -la\ntotal 0\ndrwxr-xr-x  2 user staff\n");
        assert!(perm(&events).is_none());
    }
}
