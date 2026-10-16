// SPDX-License-Identifier: GPL-2.0-or-later
//! The active application on GNOME Shell, which keeps window focus from other
//! clients on Wayland: the `Get` method of the FocusedWindow extension
//! (`/org/gnome/shell/extensions/FocusedWindow`), called through `gdbus`.
//! The reply is a GVariant tuple holding the window as a JSON text,
//! `('{"wm_class":"org.gnome.Nautilus",…}',)`, and the name is the last
//! `.`-separated part of `wm_class`.
//!
//! Without the extension, on another Wayland compositor, without a session
//! bus or without `gdbus`, the command fails and there is no name.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use pipette_js_json::{JsString, Value};

use crate::normalize::{js_trim, normalize};

/// The program and arguments of the query.
pub const GDBUS_COMMAND: [&str; 9] = [
    "gdbus",
    "call",
    "--session",
    "--dest",
    "org.gnome.Shell",
    "--object-path",
    "/org/gnome/shell/extensions/FocusedWindow",
    "--method",
    "org.gnome.shell.extensions.FocusedWindow.Get",
];

/// How long the query may take before it is killed and gives no name.
pub const GDBUS_TIMEOUT: Duration = Duration::from_millis(500);

/// Runs a command and gives its standard output when it exits with success
/// within `timeout`; `None` when it cannot start, fails or runs too long.
pub trait CommandRunner: Send {
    fn run(&self, program: &str, args: &[&str], timeout: Duration) -> Option<String>;
}

/// The FocusedWindow query, with the runner that starts `gdbus`.
pub struct GnomeFocusedWindow {
    runner: Box<dyn CommandRunner>,
}

impl GnomeFocusedWindow {
    pub fn new(runner: Box<dyn CommandRunner>) -> Self {
        Self { runner }
    }

    /// The query through the real `gdbus` on the session bus.
    pub fn system() -> Self {
        Self::new(Box::new(SystemCommandRunner))
    }

    /// The normalized name of the focused window's application. Blocks for
    /// up to [`GDBUS_TIMEOUT`].
    pub fn app_name(&self) -> Option<JsString> {
        let [program, args @ ..] = GDBUS_COMMAND;
        parse_focused_window_reply(&self.runner.run(program, &args, GDBUS_TIMEOUT)?)
    }
}

/// The name in `gdbus`'s output, read as the Electron build reads it: trim,
/// drop the first 2 and the last 3 UTF-16 code units (`('` and `',)`),
/// `JSON.parse` the rest, and take the last `.`-separated part of a
/// non-empty `wm_class` string. Anything else gives `None`, as does a reply
/// whose JSON has a `'` (in the title, say): gdbus then quotes it with `"`
/// and escapes each `"` inside, which is not JSON.
pub fn parse_focused_window_reply(stdout: &str) -> Option<JsString> {
    let units: Vec<u16> = stdout.encode_utf16().collect();
    let trimmed = js_trim(&units);
    if trimmed.len() < 5 {
        return None;
    }
    // A cut through a surrogate pair leaves a lone surrogate at an end of
    // the text, which no JSON text starts or ends with: JSON.parse rejects it.
    let json = String::from_utf16(&trimmed[2..trimmed.len() - 3]).ok()?;
    let value = pipette_js_json::parse(&json).ok()?;
    // Only a non-empty string has a name: an empty one is falsy, and other
    // values have no `split`.
    let Some(Value::String(class)) = value.as_object()?.get("wm_class") else {
        return None;
    };
    if class.is_empty() {
        return None;
    }
    let class = class.utf16_units();
    normalize(class.rsplit(|&unit| unit == u16::from(b'.')).next()?)
}

/// The largest standard output read. The FocusedWindow reply is a few
/// hundred bytes; past this the command counts as failed.
const MAX_STDOUT_BYTES: u64 = 1024 * 1024;

/// Starts the program directly (no shell) with no standard input and the
/// standard error discarded, and kills it at the timeout.
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, program: &str, args: &[&str], timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let output = read_stdout(&mut child, deadline);
        let status = output.as_ref().and_then(|_| wait_until(&mut child, deadline));
        if status.is_none() {
            // Kill fails only when the child has already exited.
            let _ = child.kill();
            let _ = child.wait();
        }
        let output = output?;
        status?.success().then(|| String::from_utf8_lossy(&output).into_owned())
    }
}

/// The child's standard output up to its end, read on a thread so the wait
/// can stop at `deadline`. `None` past the deadline or the size limit.
fn read_stdout(child: &mut Child, deadline: Instant) -> Option<Vec<u8>> {
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    // The thread ends when the pipe closes, at the latest when the child is
    // killed.
    thread::spawn(move || {
        let mut buf = Vec::new();
        let read = stdout.take(MAX_STDOUT_BYTES + 1).read_to_end(&mut buf);
        let _ = sender.send(read.map(|_| buf));
    });
    let buf = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()?.ok()?;
    (buf.len() as u64 <= MAX_STDOUT_BYTES).then_some(buf)
}

/// The child's exit status, if it exits by `deadline`.
fn wait_until(child: &mut Child, deadline: Instant) -> Option<ExitStatus> {
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
#[path = "gnome_tests.rs"]
mod tests;
