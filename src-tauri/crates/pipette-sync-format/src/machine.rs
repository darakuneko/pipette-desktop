// SPDX-License-Identifier: GPL-2.0-or-later
//! The analytics machine hash (`src/main/typing-analytics/machine-hash.ts`)
//! and the raw machine id it is built from.
//!
//! The TypeScript side takes the raw id from `node-machine-id` 1.1.12,
//! `machineId(true)`, which runs one shell command per platform and strips
//! its output. [`machine_id_original`] reproduces both steps. The output
//! parsers (`expose_*`) are plain functions compiled on every platform so
//! they are unit tested everywhere; only the command each platform runs is
//! platform specific.
//!
//! | Platform | Command (`node-machine-id`) | Kept |
//! |---|---|---|
//! | Linux | `( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null \|\| hostname ) \| head -n 1 \|\| :` | whole output |
//! | Windows | `%windir%\System32\REG.exe QUERY HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography /v MachineGuid` | after the first `REG_SZ` |
//! | macOS | `ioreg -rd1 -c IOPlatformExpertDevice` | the rest of the first `IOPlatformUUID` line, without `=` and `"` |
//!
//! Every platform then removes all whitespace (JavaScript's `\s`) and
//! lowercases. Other targets return [`MachineIdError::UnsupportedPlatform`].
//!
//! On Linux, Windows and macOS the result is compared with node-machine-id's
//! on the same machine by tests/node_identity.rs of pipette-typing-analytics.

use std::sync::OnceLock;

use crate::content_hash::sha256_hex;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MachineIdError {
    /// The platform command could not be started or exited unsuccessfully
    /// (`node-machine-id` rejects in the same cases).
    #[error("machine id command failed: {0}")]
    Command(String),
    /// The command output lacks the marker the id follows (`REG_SZ` on
    /// Windows, `IOPlatformUUID` on macOS).
    #[error("machine id not found in the command output")]
    NotFound,
    #[error("machine id is not supported on this platform")]
    UnsupportedPlatform,
}

/// The anonymized machine hash: lowercase hex SHA-256 of the UTF-8 machine
/// id immediately followed by the UTF-8 installation id, no separator.
pub fn machine_hash(machine_id: &str, installation_id: &str) -> String {
    sha256_hex(&[machine_id.as_bytes(), installation_id.as_bytes()])
}

/// JavaScript's `\s` (WhiteSpace and LineTerminator). Differs from
/// `char::is_whitespace` in U+FEFF (included) and U+0085 (excluded).
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

fn strip_and_lowercase(text: &str, also_remove: &[char]) -> String {
    text.chars()
        .filter(|c| !is_js_whitespace(*c) && !also_remove.contains(c))
        .collect::<String>()
        .to_lowercase()
}

/// `text.split(marker)[1]`: the text between the first and the second
/// occurrence of `marker` (or the end).
fn second_split_segment<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let rest = text.split_once(marker)?.1;
    Some(rest.split_once(marker).map_or(rest, |(segment, _)| segment))
}

/// Linux: the whole command output.
pub fn expose_linux(output: &str) -> String {
    strip_and_lowercase(output, &[])
}

/// Windows: the `REG.exe QUERY … /v MachineGuid` output after `REG_SZ`.
pub fn expose_windows(output: &str) -> Result<String, MachineIdError> {
    second_split_segment(output, "REG_SZ")
        .map(|s| strip_and_lowercase(s, &[]))
        .ok_or(MachineIdError::NotFound)
}

/// macOS: the rest of the `ioreg` line holding `IOPlatformUUID`.
pub fn expose_macos(output: &str) -> Result<String, MachineIdError> {
    let segment = second_split_segment(output, "IOPlatformUUID").ok_or(MachineIdError::NotFound)?;
    let line = segment.split('\n').next().unwrap_or("");
    Ok(strip_and_lowercase(line, &['=', '"']))
}

/// The bytes `( cat A B 2> /dev/null || hostname ) | head -n 1` prints:
/// the readable files concatenated, followed by the hostname output when
/// any file could not be read (cat then exits non-zero), cut after the
/// first newline.
pub fn linux_first_line(files: &[Option<Vec<u8>>], hostname_output: impl FnOnce() -> Vec<u8>) -> Vec<u8> {
    let mut stream: Vec<u8> = files.iter().flatten().flatten().copied().collect();
    if files.iter().any(Option::is_none) {
        stream.extend(hostname_output());
    }
    if let Some(end) = stream.iter().position(|b| *b == b'\n') {
        stream.truncate(end + 1);
    }
    stream
}

/// Paths `node-machine-id` reads on Linux, in order.
pub const LINUX_MACHINE_ID_PATHS: [&str; 2] = ["/var/lib/dbus/machine-id", "/etc/machine-id"];

#[cfg(target_os = "linux")]
fn platform_machine_id() -> Result<String, MachineIdError> {
    let files: Vec<Option<Vec<u8>>> = LINUX_MACHINE_ID_PATHS.iter().map(|p| std::fs::read(p).ok()).collect();
    // `hostname` failing to start leaves stdout empty in the shell pipeline.
    let hostname =
        || std::process::Command::new("hostname").output().map(|output| output.stdout).unwrap_or_default();
    let line = linux_first_line(&files, hostname);
    Ok(expose_linux(&String::from_utf8_lossy(&line)))
}

/// Runs `program` with `args` and returns its stdout; a start failure or a
/// non-zero exit is an error, as with Node's `exec`.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run(program: &str, args: &[&str]) -> Result<String, MachineIdError> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| MachineIdError::Command(format!("{program}: {e}")))?;
    if !output.status.success() {
        return Err(MachineIdError::Command(format!("{program}: {}", output.status)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `node-machine-id` runs `REG.exe` from
/// `%windir%\System32`, or through `%windir%\sysnative` when a 32-bit Node
/// runs on 64-bit Windows so the 64-bit registry view is read; `Sysnative`
/// gives a 32-bit process the same view.
#[cfg(target_os = "windows")]
fn platform_machine_id() -> Result<String, MachineIdError> {
    let windir =
        std::env::var("windir").map_err(|_| MachineIdError::Command("%windir% is not set".into()))?;
    let wow64 = cfg!(target_pointer_width = "32") && std::env::var_os("PROCESSOR_ARCHITEW6432").is_some();
    let dir = if wow64 { "Sysnative" } else { "System32" };
    let reg = format!(r"{windir}\{dir}\REG.exe");
    let output =
        run(&reg, &["QUERY", r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])?;
    expose_windows(&output)
}

#[cfg(target_os = "macos")]
fn platform_machine_id() -> Result<String, MachineIdError> {
    expose_macos(&run("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn platform_machine_id() -> Result<String, MachineIdError> {
    Err(MachineIdError::UnsupportedPlatform)
}

/// The value `node-machine-id`'s `machineId(true)` returns on this machine.
///
/// The first successful result is cached for the lifetime of the process,
/// as `getMachineHash` (`src/main/typing-analytics/machine-hash.ts`) caches
/// its hash. A failure is not cached, so the next call runs the platform
/// query again. Callers racing the first call may each run the query; all
/// of them get the value stored first.
pub fn machine_id_original() -> Result<String, MachineIdError> {
    static CACHED: OnceLock<String> = OnceLock::new();
    if let Some(id) = CACHED.get() {
        return Ok(id.clone());
    }
    let id = platform_machine_id()?;
    Ok(CACHED.get_or_init(|| id).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_machine_and_installation_id_without_separator() {
        assert_eq!(machine_hash("ab", "c"), sha256_hex(&[b"abc"]));
    }

    #[test]
    fn linux_output_loses_all_whitespace_and_case() {
        assert_eq!(expose_linux("  ABC def\r\n"), "abcdef");
        assert_eq!(expose_linux("a\u{FEFF}b\u{85}"), "ab\u{85}");
    }

    #[test]
    fn linux_takes_the_first_readable_line() {
        let host = || b"host\n".to_vec();
        let both = [Some(b"dbus\n".to_vec()), Some(b"etc\n".to_vec())];
        assert_eq!(linux_first_line(&both, || panic!("hostname not run")), b"dbus\n");
        assert_eq!(linux_first_line(&[None, Some(b"etc\n".to_vec())], host), b"etc\n");
        assert_eq!(linux_first_line(&[Some(b"dbus\n".to_vec()), None], host), b"dbus\n");
        assert_eq!(linux_first_line(&[None, None], host), b"host\n");
        // Empty or newline-less files run into the next file's bytes.
        assert_eq!(linux_first_line(&[Some(Vec::new()), Some(b"etc\n".to_vec())], host), b"etc\n");
        assert_eq!(linux_first_line(&[Some(b"db".to_vec()), Some(b"us\n".to_vec())], host), b"dbus\n");
        assert_eq!(linux_first_line(&[None, Some(b"etc".to_vec())], host), b"etchost\n");
    }

    #[test]
    fn windows_takes_the_text_after_reg_sz() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    \
                      1A2B3C4D-0000-1111-2222-333344445555\r\n\r\n";
        assert_eq!(expose_windows(output).as_deref(), Ok("1a2b3c4d-0000-1111-2222-333344445555"));
        assert_eq!(expose_windows("no marker"), Err(MachineIdError::NotFound));
    }

    #[test]
    fn macos_takes_the_uuid_line() {
        let output = "+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"X\"\n      \
                      \"IOPlatformUUID\" = \"AAAABBBB-CCCC-DDDD-EEEE-FFFF00001111\"\n      \"other\" = 1\n    }\n";
        assert_eq!(expose_macos(output).as_deref(), Ok("aaaabbbb-cccc-dddd-eeee-ffff00001111"));
        assert_eq!(expose_macos("nothing"), Err(MachineIdError::NotFound));
    }

    /// The pure Rust pipeline gives what the shell command itself prints.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_matches_the_shell_command() {
        let output = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :",
            ])
            .output()
            .unwrap();
        assert_eq!(platform_machine_id().unwrap(), expose_linux(&String::from_utf8_lossy(&output.stdout)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cached_id_is_the_platform_id() {
        let first = machine_id_original().unwrap();
        assert_eq!(first, platform_machine_id().unwrap());
        assert_eq!(machine_id_original().unwrap(), first);
    }
}
