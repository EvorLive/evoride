//! Rendering: paint the vt100 screen grid into the ratatui buffer, plus a
//! status bar showing the sync state, session id, and key hints.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::app::App;

pub fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(f.area());

    render_grid(f, app, chunks[0]);
    render_status(f, app, chunks[1]);
}

/// Write each emulator cell directly into the frame buffer, preserving
/// colors and attributes from the underlying terminal output.
fn render_grid(f: &mut Frame, app: &App, area: Rect) {
    let screen = app.screen();
    let buf = f.buffer_mut();

    for row in 0..area.height {
        for col in 0..area.width {
            let cell = match screen.cell(row, col) {
                Some(c) => c,
                None => continue,
            };
            let x = area.x + col;
            let y = area.y + row;
            let target = &mut buf[(x, y)];

            let contents = cell.contents();
            if contents.is_empty() {
                target.set_symbol(" ");
            } else {
                target.set_symbol(&contents);
            }

            let mut style = Style::default()
                .fg(conv_color(cell.fgcolor(), Color::Reset))
                .bg(conv_color(cell.bgcolor(), Color::Reset));
            if cell.bold() {
                style = style.add_modifier(Modifier::BOLD);
            }
            if cell.italic() {
                style = style.add_modifier(Modifier::ITALIC);
            }
            if cell.underline() {
                style = style.add_modifier(Modifier::UNDERLINED);
            }
            if cell.inverse() {
                style = style.add_modifier(Modifier::REVERSED);
            }
            target.set_style(style);
        }
    }

    // Place the hardware cursor where the emulator says it is.
    if !screen.hide_cursor() {
        let (crow, ccol) = screen.cursor_position();
        if crow < area.height && ccol < area.width {
            f.set_cursor_position((area.x + ccol, area.y + crow));
        }
    }
}

fn render_status(f: &mut Frame, app: &App, area: Rect) {
    let (label, color) = if app.sync_on {
        (" ● SYNC ON ", Color::Black)
    } else {
        (" ○ SYNC OFF ", Color::White)
    };
    let badge_bg = if app.sync_on { Color::Green } else { Color::DarkGray };

    let mut spans = vec![
        Span::styled(
            label,
            Style::default()
                .bg(badge_bg)
                .fg(color)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" eterm  session:{} ", app.session_id),
            Style::default().fg(Color::Gray),
        ),
    ];
    // When syncing, show the control token the dashboard needs to send input.
    if app.sync_on {
        spans.push(Span::styled(
            format!(" control-token:{} ", app.control_token),
            Style::default().fg(Color::Cyan),
        ));
    }
    spans.push(Span::styled(
        " [Ctrl-S sync]  [Ctrl-Q quit] ",
        Style::default().fg(Color::DarkGray),
    ));
    let line = Line::from(spans);

    f.render_widget(
        Paragraph::new(line).style(Style::default().bg(Color::Reset)),
        area,
    );
}

/// Map a vt100 color into a ratatui color, falling back for the default slot.
fn conv_color(c: vt100::Color, default: Color) -> Color {
    match c {
        vt100::Color::Default => default,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}
