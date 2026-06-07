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
                        i += 2;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1;
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

/// Signals that an agent is blocking on user input (permission prompt, y/n, …).
const PROMPT_SIGS: &[&str] = &[
    "❯",
    "(y/n)",
    "(Y/n)",
    "(y/N)",
    "[y/n]",
    "[Y/n]",
    "[y/N]",
    "Do you want",
    "Continue?",
    "Proceed?",
    "Overwrite?",
    "Press enter",
    "press Enter",
    "Press Enter",
    "to continue",
];

/// Heuristic: is the TAIL of this output a prompt waiting for user input?
/// Only the last stretch matters — a prompt sits at the end of the stream.
pub fn has_input_prompt(text: &str) -> bool {
    let start = text.len().saturating_sub(400);
    let start = (start..=text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0);
    let tail = &text[start..];
    PROMPT_SIGS.iter().any(|s| tail.contains(s))
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
}
