// SPDX-License-Identifier: GPL-2.0-or-later
//! The current user's home directory in /etc/passwd, read without the C
//! library: a development directory is refused inside its autostart
//! directory even when `$HOME` points elsewhere. Users that only a
//! directory service knows have no line there, and their home is then
//! known through `$HOME` alone.

use std::path::PathBuf;

/// The home directory of this process's real user in /etc/passwd.
#[cfg(unix)]
pub(crate) fn home_of_process() -> Option<PathBuf> {
    let text = std::fs::read("/etc/passwd").ok()?;
    home_of(&text, rustix::process::getuid().as_raw())
}

#[cfg(not(unix))]
pub(crate) fn home_of_process() -> Option<PathBuf> {
    None
}

/// The home directory (the sixth field) of the first line of `passwd`
/// whose user id (the third field) is `uid`, when not empty.
#[cfg(unix)]
pub(crate) fn home_of(passwd: &[u8], uid: u32) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    passwd.split(|byte| *byte == b'\n').find_map(|line| {
        let fields: Vec<&[u8]> = line.split(|byte| *byte == b':').collect();
        let id = std::str::from_utf8(fields.get(2)?).ok()?.parse::<u32>().ok()?;
        let home = fields.get(5).filter(|home| !home.is_empty())?;
        (id == uid).then(|| PathBuf::from(OsStr::from_bytes(home)))
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn finds_the_home_of_the_user_id() {
        let passwd = b"root:x:0:0:root:/root:/bin/bash\n# comment\nbroken\nalice:x:1000:1000:Alice,,,:/home/alice:/bin/zsh\nbob:x:1001:1001::/home/bob:/bin/sh\nnohome:x:1002:1002:::/bin/sh\n";
        assert_eq!(home_of(passwd, 1000), Some(PathBuf::from("/home/alice")));
        assert_eq!(home_of(passwd, 0), Some(PathBuf::from("/root")));
        assert_eq!(home_of(passwd, 1002), None);
        assert_eq!(home_of(passwd, 4242), None);
    }
}
