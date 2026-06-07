//! Shared eterm core. Terminal-output hygiene and issue detection used by both
//! the standalone eterm TUI and the EvorIde backend, so "the terminal uses
//! eterm" — including the **fix this issue** feature — from one implementation.

/// Strip ANSI/VT escape sequences, keeping printable text and newlines so
/// matchers see clean lines.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            if let Some(&next) = bytes.get(i + 1) {
                match next {
                    b'[' => {
                        // CSI: ESC [ params... final(0x40..=0x7e). Most are dropped,
                        // but cursor-forward (`CSI nC`) is how TUIs (Claude's Ink
                        // menus) lay out spacing instead of literal spaces — drop it
                        // and adjacent words collide. Emit n spaces so labels read.
                        let params_start = i + 2;
                        let mut j = params_start;
                        while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                            j += 1;
                        }
                        if j < bytes.len() && bytes[j] == b'C' {
                            let n: usize = std::str::from_utf8(&bytes[params_start..j])
                                .ok()
                                .and_then(|s| s.trim().parse().ok())
                                .unwrap_or(1);
                            for _ in 0..n.min(200) {
                                out.push(b' ');
                            }
                        }
                        i = j + 1;
                        continue;
                    }
                    b']' => {
                        i += 2;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            } else {
                break;
            }
        }
        if b == b'\n' || b == b'\t' || b >= 0x20 {
            out.push(b);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Substrings that strongly indicate a command failed.
const ERROR_SIGS: &[&str] = &[
    "error[E",
    "panic",
    "Traceback (most recent call last)",
    "npm ERR!",
    "fatal:",
    "Error:",
    "error:",
    "Exception",
    "command not found",
    "No such file",
    "cannot find",
    "Cannot find",
    "Segmentation fault",
    "Build failed",
    "compilation failed",
    "FAILED",
];

/// Heuristic: does this output contain a failure signature?
pub fn has_error_signature(text: &str) -> bool {
    ERROR_SIGS.iter().any(|s| text.contains(s))
}

/// Unambiguous "y/n" prompt markers. Deliberately NARROW: prose like
/// "Do you want…" or "Press enter to continue" shows up in ordinary agent
/// summaries and caused false "needs you" flags, so only bracketed y/n markers
/// qualify — and only on the very last line (see `detect_prompt`).
const PROMPT_SIGS: &[&str] = &["(y/n)", "(Y/n)", "(y/N)", "[y/n]", "[Y/n]", "[y/N]"];

/// What an agent is blocking on. `options` holds the labels of a numbered
/// select menu (1-based order); empty for a plain y/n or free-text prompt.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PromptInfo {
    pub options: Vec<String>,
}

/// Interactive-select cursor glyphs (the highlighted row of a menu). Their
/// presence is what separates a *live* select menu from a printed numbered list
/// or a prose summary that merely happens to contain numbers.
const CURSOR_GLYPHS: &str = "❯›»▸▶";

/// Leading cursor/bullet/box-drawing glyphs that may precede a menu option.
fn is_menu_lead(c: char) -> bool {
    c.is_whitespace() || "│┃|❯>›●◯○•◦*▶▸→-".contains(c)
}

/// Parse one line as a numbered menu option (`❯ 1. Foo`, `  2) Bar`).
/// Returns (number, label, had_cursor) — `had_cursor` is true when a select
/// cursor glyph preceded the number on this line.
fn parse_menu_option(line: &str) -> Option<(u32, String, bool)> {
    let t = line.trim_start_matches(is_menu_lead).trim_start();
    let lead = &line[..line.len() - t.len()];
    let had_cursor = lead.chars().any(|c| CURSOR_GLYPHS.contains(c));
    let digits_end = t.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let num: u32 = t[..digits_end].parse().ok()?;
    let rest = &t[digits_end..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    // Collapse runs of whitespace (cursor-forward spacing can leave several) to
    // single spaces so labels read like a normal sentence.
    let label = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        return None;
    }
    Some((num, label, had_cursor))
}

/// Truncate to `max` chars on a word boundary where possible (no mid-word cuts).
fn truncate_label(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let trimmed = match cut.rsplit_once(' ') {
        Some((head, _)) if head.len() >= max / 2 => head.to_string(),
        _ => cut.trim_end().to_string(),
    };
    format!("{}…", trimmed.trim_end_matches([',', ';', ':', ' ']))
}

/// Heuristic: is the TAIL of this output a prompt currently waiting for user
/// input, and if it's a numbered menu, what are the choices?
///
/// Crucially, the prompt must be **anchored near the bottom** of the stream.
/// Output is append-only stripped text, so an *answered* menu still lingers in
/// the buffer — but once the agent prints its response, those option lines are
/// no longer near the end, so we correctly stop reporting "waiting". A tall
/// menu is still caught because its *last* option sits at the bottom even when
/// the `❯` cursor is on option 1 far above.
pub fn detect_prompt(text: &str) -> Option<PromptInfo> {
    let start = text.len().saturating_sub(2500);
    let start = (start..=text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0);
    let tail = &text[start..];

    // Cheap early-out: a prompt needs either a select cursor or a y/n marker.
    // Without one, skip the line-splitting/parsing entirely — this is the common
    // case for streaming build/log output and keeps the hot path fast.
    let maybe_prompt = CURSOR_GLYPHS.chars().any(|g| tail.contains(g))
        || PROMPT_SIGS.iter().any(|s| tail.contains(s));
    if !maybe_prompt {
        return None;
    }

    // Lines, with trailing blank lines trimmed so "near the bottom" is measured
    // from the last line that actually has content.
    let mut lines: Vec<&str> = tail.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return None;
    }
    let last = lines.len() - 1;

    // 1) Numbered select menu, deduped by number (menus redraw as the cursor
    // moves) and anchored to the bottom (the lowest option line is within a few
    // lines of the end — a footer/hint may follow). We also require a select
    // cursor (`❯`) on one of the option lines, which is what distinguishes a
    // live interactive menu from a printed numbered list or prose summary.
    let mut opts: Vec<(usize, u32, String)> = Vec::new();
    let mut cursor_seen = false;
    for (i, line) in lines.iter().enumerate() {
        if let Some((num, label, had_cursor)) = parse_menu_option(line) {
            if num == 0 || num > 20 {
                continue;
            }
            cursor_seen |= had_cursor;
            match opts.iter_mut().find(|(_, m, _)| *m == num) {
                Some(slot) => {
                    slot.0 = i;
                    slot.2 = label;
                }
                None => opts.push((i, num, label)),
            }
        }
    }
    if opts.len() >= 2 && cursor_seen {
        opts.sort_by_key(|(_, num, _)| *num);
        let contiguous = opts
            .iter()
            .enumerate()
            .all(|(k, (_, num, _))| *num as usize == k + 1);
        let lowest_opt_line = opts.iter().map(|(i, _, _)| *i).max().unwrap_or(0);
        // The lowest option must sit at the very bottom (a short hint/footer may
        // follow); more than that means the menu was answered and scrolled up.
        let near_bottom = last - lowest_opt_line <= 3;
        if contiguous && near_bottom {
            let options = opts
                .into_iter()
                .take(9)
                .map(|(_, _, l)| truncate_label(&l, 48))
                .collect();
            return Some(PromptInfo { options });
        }
    }

    // 2) Plain y/n — only on the last couple of lines, so a stale question
    // scrolled up by later output doesn't keep us "waiting".
    let from = lines.len().saturating_sub(2);
    let bottom = lines[from..].join("\n");
    if PROMPT_SIGS.iter().any(|s| bottom.contains(s)) {
        return Some(PromptInfo::default());
    }
    None
}

/// Is the agent blocking on user input? (Back-compat wrapper.)
pub fn has_input_prompt(text: &str) -> bool {
    detect_prompt(text).is_some()
}

/// Rolling tail of recent (stripped) output, with cheap issue detection.
pub struct OutputTail {
    buf: String,
    cap: usize,
}

impl OutputTail {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: String::new(),
            cap,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.push_str(&strip_ansi(bytes));
        if self.buf.len() > self.cap {
            let cut = self.buf.len() - self.cap;
            let cut = (cut..self.buf.len())
                .find(|&i| self.buf.is_char_boundary(i))
                .unwrap_or(self.buf.len());
            self.buf.drain(0..cut);
        }
    }

    pub fn text(&self) -> &str {
        &self.buf
    }

    pub fn has_error(&self) -> bool {
        has_error_signature(&self.buf)
    }
}

/// Build a prompt asking an agent to diagnose and fix a failing command.
pub fn fix_prompt(command: &str, exit_code: Option<i32>, output_tail: &str) -> String {
    let code = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "non-zero".into());
    let tail: String = {
        let t = output_tail.trim();
        let start = t.len().saturating_sub(3000);
        let start = (start..=t.len())
            .find(|&i| t.is_char_boundary(i))
            .unwrap_or(0);
        t[start..].to_string()
    };
    format!(
        "The command `{command}` failed (exit {code}). Here is the terminal output:\n\n```\n{tail}\n```\n\nPlease diagnose the root cause and fix it — make the necessary code/config changes, then re-run to confirm it works."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_and_detects() {
        assert_eq!(strip_ansi(b"\x1b[31mhi\x1b[0m\r\n"), "hi\n");
        assert!(has_error_signature("error[E0382]: borrow of moved value"));
        assert!(has_error_signature("npm ERR! missing script: dev"));
        assert!(!has_error_signature("Compiling fine, all good"));
    }

    #[test]
    fn cursor_forward_becomes_spaces() {
        // TUIs space words with `CSI nC` rather than literal spaces; dropping it
        // collides words ("Yes,and" instead of "Yes, and").
        assert_eq!(strip_ansi(b"Yes,\x1b[1Cand\x1b[1Cdon't"), "Yes, and don't");
        assert_eq!(strip_ansi(b"a\x1b[3Cb"), "a   b");
    }

    #[test]
    fn menu_label_spacing_is_clean() {
        // Mirrors production: bytes are stripped (OutputTail) before detection.
        let stripped = strip_ansi(
            b"Do you want to proceed?\n\xe2\x9d\xaf 1. Yes\n  2. Yes,\x1b[1Cand\x1b[1Cdon't\x1b[1Cask\x1b[1Cagain\n  3. No\n",
        );
        let info = detect_prompt(&stripped).unwrap();
        assert_eq!(info.options[1], "Yes, and don't ask again");
    }

    #[test]
    fn tail_caps_and_flags() {
        let mut t = OutputTail::new(32);
        t.push(b"some output that is fairly long and exceeds cap");
        assert!(t.text().len() <= 32);
        t.push(b"\npanic: boom");
        assert!(t.has_error());
    }

    #[test]
    fn fix_prompt_includes_context() {
        let p = fix_prompt("cargo run", Some(101), "thread panicked at foo");
        assert!(p.contains("cargo run"));
        assert!(p.contains("101"));
        assert!(p.contains("panicked"));
    }

    #[test]
    fn detects_tall_select_menu_above_the_fold() {
        // A long numbered menu whose `❯` cursor sits on option 1, far above the
        // end of the stream — the old 400-char tail missed this entirely.
        let menu = "What should I build/do next?\n\
            ❯ 1. Fix the URL nit\n\
            \x20    Quick: set NEXT_PUBLIC_APP_URL to :3001 so it prints right.\n\
            \x20 2. Gmail OAuth\n\
            \x20    Drop-in adapter for the existing inbound pipeline.\n\
            \x20 3. Interview analyzer\n\
            \x20    Paste notes, AI extracts signals and prep gaps.\n\
            \x20 4. Market intelligence\n\
            \x20    Aggregate pipeline + JD data for demand signals.\n\
            \x20 5. Type something.\n\
            \x20 6. Chat about this\n";
        let info = detect_prompt(menu).expect("should detect the menu");
        assert_eq!(info.options.len(), 6);
        assert_eq!(info.options[0], "Fix the URL nit");
        assert_eq!(info.options[4], "Type something.");
    }

    #[test]
    fn detects_claude_permission_menu() {
        let p = "Do you want to proceed?\n\
            ❯ 1. Yes\n  2. Yes, and don't ask again this session\n  3. No, and tell Claude what to do differently\n";
        let info = detect_prompt(p).unwrap();
        assert_eq!(info.options, vec!["Yes", "Yes, and don't ask again this session", "No, and tell Claude what to do differently"]);
    }

    #[test]
    fn yes_no_prompt_has_no_options() {
        let info = detect_prompt("Overwrite the file? (y/n) ").unwrap();
        assert!(info.options.is_empty());
    }

    #[test]
    fn plain_output_is_not_a_prompt() {
        assert!(detect_prompt("Compiling project... done in 2.3s\n").is_none());
        // A lone number in prose must not look like a 1-item menu.
        assert!(detect_prompt("We saw 2024 and 2025 builds pass.\n").is_none());
    }

    #[test]
    fn printed_numbered_list_without_cursor_is_not_a_menu() {
        // A finished agent's summary with numbered/bulleted lines must NOT be
        // mistaken for a live select menu — no `❯` cursor means not interactive.
        let summary = "Done. Intents added:\n\
            - vision.md — what/why, 5 core principles\n\
            1. First we scanned the codebase\n\
            2. Then filled file-intents\n\
            3. Finally validated\n\
            intentflow validate → ok. Zero placeholders remaining.\n";
        assert!(detect_prompt(summary).is_none());
    }

    #[test]
    fn idle_input_box_is_not_waiting() {
        // Claude's normal idle prompt — must NOT be flagged as needing input,
        // or every idle agent shows "needs you" forever.
        assert!(detect_prompt("\n╭─────────────╮\n│ > try \"fix the bug\"      │\n╰─────────────╯\n❯ \n").is_none());
        assert!(detect_prompt("user@host project % ").is_none());
    }

    #[test]
    fn answered_menu_clears_once_scrolled_up() {
        // The menu was shown then answered; the agent has since printed several
        // lines of work. The option lines linger in the append-only buffer but
        // are no longer near the bottom, so we must NOT still report waiting.
        let answered = "❯ 1. Fix the URL nit\n  2. Gmail OAuth\n  3. Interview analyzer\n\
            You chose option 1.\nEditing .env... done.\nRunning build...\n\
            ✓ built in 1.2s\nAll set — the webhook URL now prints :3001.\nWhat else would you like?\n";
        assert!(detect_prompt(answered).is_none());
    }
}
