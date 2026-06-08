//! Hidden "judge" helper. A one-shot `claude`/`codex` invocation that reads an
//! idle agent's terminal tail and classifies its state, so the IDE can tell
//! "actively needs you" from "just idle" far more reliably than the regex
//! heuristic. It runs as an EPHEMERAL subprocess — never a tracked, stored, or
//! resumable project agent — so it stays invisible in the agent list.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The judge's verdict for one agent.
#[derive(Serialize, Clone, Debug)]
pub struct Judgement {
    /// "working" | "waiting_passive" | "waiting_active"
    pub state: String,
    /// True when the user must act now (permission/menu/question).
    pub needs_input: bool,
    /// Very short human summary (e.g. "running tests", "asking to overwrite").
    pub summary: String,
    /// Choices to offer, when the agent is at a menu.
    pub options: Vec<String>,
    /// Which helper produced this (program name), for display/debug.
    pub helper: String,
}

enum Kind {
    Claude,
    Codex,
}

struct Helper {
    kind: Kind,
    program: String,
    /// Override args before the prompt (from ~/.evoride/helper.json).
    args: Vec<String>,
}

fn command_exists(prog: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {prog} >/dev/null 2>&1"))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve which helper to use: an explicit `~/.evoride/helper.json`
/// (`{"command":"claude","args":["-p"]}`) if present, else the first of
/// `claude` / `codex` found on PATH.
fn resolve() -> Option<Helper> {
    if let Some(home) = std::env::var_os("HOME") {
        let cfg = std::path::Path::new(&home).join(".evoride").join("helper.json");
        if let Ok(txt) = std::fs::read_to_string(&cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(cmd) = v.get("command").and_then(|c| c.as_str()) {
                    if !cmd.is_empty() {
                        let args = v
                            .get("args")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let kind = if cmd.contains("codex") { Kind::Codex } else { Kind::Claude };
                        return Some(Helper { kind, program: cmd.to_string(), args });
                    }
                }
            }
        }
    }
    for prog in ["claude", "codex"] {
        if command_exists(prog) {
            let kind = if prog == "codex" { Kind::Codex } else { Kind::Claude };
            return Some(Helper { kind, program: prog.to_string(), args: Vec::new() });
        }
    }
    None
}

/// Name of the configured/available helper, or `None` if neither is present.
pub fn helper_name() -> Option<String> {
    resolve().map(|h| h.program)
}

fn build_prompt(tail: &str) -> String {
    format!(
        "You are monitoring an autonomous coding agent's terminal. Read the recent \
output between the markers and decide its CURRENT state. Reply with ONE line of \
compact JSON and NOTHING else:\n\
{{\"state\":\"working|waiting_passive|waiting_active\",\"needs_input\":true|false,\
\"summary\":\"<=8 words\",\"options\":[\"...\"]}}\n\
Definitions:\n\
- working: still running a task or producing output; no user action needed.\n\
- waiting_passive: idle at its normal input box; the user MAY type but nothing is required.\n\
- waiting_active: needs the user NOW — blocking on a question, permission prompt, \
or numbered menu, OR the agent has finished/stalled and is asking what to do next \
or for direction (even without a formal prompt). Put the question or what it's \
asking in \"summary\", and any explicit choices in \"options\".\n\
Terminal tail:\n<<<\n{tail}\n>>>"
    )
}

/// Run a helper command, killing it if it exceeds `secs`. Returns stdout bytes.
fn run_with_timeout(mut cmd: Command, secs: u64) -> Option<Vec<u8>> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(secs) {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok().map(|o| o.stdout)
}

#[derive(serde::Deserialize, Default)]
struct Raw {
    #[serde(default)]
    state: String,
    #[serde(default)]
    needs_input: bool,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    options: Vec<String>,
}

/// Extract the first JSON object from helper stdout and normalize it.
fn parse_judgement(s: &str) -> Option<Judgement> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end < start {
        return None;
    }
    let raw: Raw = serde_json::from_str(&s[start..=end]).ok()?;
    let state = match raw.state.as_str() {
        "working" | "waiting_passive" | "waiting_active" => raw.state.clone(),
        _ if raw.needs_input => "waiting_active".to_string(),
        _ => "waiting_passive".to_string(),
    };
    let needs_input = raw.needs_input || state == "waiting_active";
    Some(Judgement {
        state,
        needs_input,
        summary: raw.summary,
        options: raw.options.into_iter().take(9).collect(),
        helper: String::new(),
    })
}

fn build_batch_prompt(items: &[(String, String)]) -> String {
    let mut p = String::from(
        "You are monitoring several autonomous coding agents. For EACH agent's \
terminal tail below, classify its CURRENT state. Reply with ONLY a JSON array of \
exactly N objects, in the SAME ORDER as the agents, each object:\n\
{\"state\":\"working|waiting_passive|waiting_active\",\"needs_input\":true|false,\
\"summary\":\"<=8 words\",\"options\":[\"...\"]}\n\
Definitions:\n\
- working: still running a task or producing output; no user action needed.\n\
- waiting_passive: idle at its normal input box; nothing required.\n\
- waiting_active: needs the user NOW — blocking on a question/permission/menu, OR \
the agent finished/stalled and is asking what to do next / for direction. Put what \
it's asking in \"summary\" and any explicit choices in \"options\".\n\n",
    );
    for (i, (_, tail)) in items.iter().enumerate() {
        p.push_str(&format!("Agent {} tail:\n<<<\n{}\n>>>\n\n", i + 1, tail));
    }
    p
}

/// Pull a JSON array of N verdicts out of helper stdout.
fn parse_batch(s: &str, n: usize, helper: &str) -> Vec<Option<Judgement>> {
    let none = || std::iter::repeat_with(|| None).take(n).collect::<Vec<_>>();
    let (Some(start), Some(end)) = (s.find('['), s.rfind(']')) else {
        return none();
    };
    if end < start {
        return none();
    }
    let Ok(raws) = serde_json::from_str::<Vec<Raw>>(&s[start..=end]) else {
        return none();
    };
    let mut out: Vec<Option<Judgement>> = raws
        .into_iter()
        .map(|raw| Some(normalize(raw, helper)))
        .collect();
    out.resize_with(n, || None);
    out
}

fn normalize(raw: Raw, helper: &str) -> Judgement {
    let state = match raw.state.as_str() {
        "working" | "waiting_passive" | "waiting_active" => raw.state.clone(),
        _ if raw.needs_input => "waiting_active".to_string(),
        _ => "waiting_passive".to_string(),
    };
    let needs_input = raw.needs_input || state == "waiting_active";
    Judgement {
        state,
        needs_input,
        summary: raw.summary,
        options: raw.options.into_iter().take(9).collect(),
        helper: helper.to_string(),
    }
}

/// Classify MANY agents in a single helper invocation (amortizes the multi-second
/// `claude -p` startup across all idle agents). Order matches the input; entries
/// are `None` when no helper is available or parsing failed.
pub fn classify_batch(items: &[(String, String)]) -> Vec<Option<Judgement>> {
    if items.is_empty() {
        return Vec::new();
    }
    let Some(helper) = resolve() else {
        return std::iter::repeat_with(|| None).take(items.len()).collect();
    };
    let prompt = build_batch_prompt(items);
    let mut cmd = Command::new(&helper.program);
    match helper.kind {
        Kind::Claude => {
            if helper.args.is_empty() {
                cmd.arg("-p");
            } else {
                cmd.args(&helper.args);
            }
            cmd.arg(&prompt);
        }
        Kind::Codex => {
            if helper.args.is_empty() {
                cmd.arg("exec");
            } else {
                cmd.args(&helper.args);
            }
            cmd.arg(&prompt);
        }
    }
    // A little more headroom than the single call — it's reasoning about N tails.
    match run_with_timeout(cmd, 35) {
        Some(stdout) => parse_batch(&String::from_utf8_lossy(&stdout), items.len(), &helper.program),
        None => std::iter::repeat_with(|| None).take(items.len()).collect(),
    }
}

/// Classify an agent's terminal `tail`. Returns `None` if no helper is available
/// or the helper failed/timed out (caller falls back to the regex heuristic).
pub fn classify(tail: &str) -> Option<Judgement> {
    let helper = resolve()?;
    let prompt = build_prompt(tail);
    let mut cmd = Command::new(&helper.program);
    match helper.kind {
        Kind::Claude => {
            if helper.args.is_empty() {
                cmd.arg("-p");
            } else {
                cmd.args(&helper.args);
            }
            cmd.arg(&prompt);
        }
        Kind::Codex => {
            if helper.args.is_empty() {
                cmd.arg("exec");
            } else {
                cmd.args(&helper.args);
            }
            cmd.arg(&prompt);
        }
    }
    let stdout = run_with_timeout(cmd, 25)?;
    let text = String::from_utf8_lossy(&stdout);
    let mut j = parse_judgement(&text)?;
    j.helper = helper.program;
    Some(j)
}
