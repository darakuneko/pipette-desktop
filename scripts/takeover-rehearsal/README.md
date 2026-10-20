# Takeover rehearsal

A distributed release of this build takes the 0.4 build's data over
where it is (`pipette-desktop` in the OS configuration directory) and points
the autostart entry at itself. Before a user's first launch, the rehearsal
starts the release on a **copy** of that data and checks that nothing is lost
or corrupted.

**Never start a Pipette AppImage outside the rehearsal.** Any AppImage run as
an AppImage counts as a distributed release, a locally built one and
`dist/Pipette-linux-x86_64.AppImage` included: it opens the real
`~/.config/pipette-desktop` and takes the real autostart entry over. Start
one only through `rehearsal.ts`, which gives it a temporary `HOME` and XDG
directories.

The scripts never copy, move or delete data. The copy is made beforehand by
the user, or with the user's permission.

## What is checked

- **(a) Launch only**: start, look at the window, quit, with no operation.
  Every file under the rehearsal home is compared by SHA-256 before and after.
  The only changes allowed are: new log files or lines appended to a log,
  `windowState` in `config.json` and the defaults the config store writes
  for keys the file lacks (every other key keeps its value), the analytics cache
  (`local/typing-analytics.db` and its `-wal` / `-shm`), the quit marker
  `quit-pending.json`, the autostart entry `pipette.desktop`, Chromium's
  `lockfile` on Windows. Changes outside `.config` (the caches and data the
  WebView and the toolkit keep under `.cache` and `.local`) and new files
  anywhere outside the userData and autostart directories are listed only.
  Nothing may be removed from the data, except the `-wal` / `-shm` journal
  and the quit marker.
- **(b) With operations**: start, go through every keyboard, snapshot,
  favorite, setting, language and theme pack, Key Label, Analyze and Typing
  Test, quit, then start again. Every file that is new or changed in the data
  must be readable: JSON parses, JSON Lines parse line by line, the analytics
  cache opens and passes SQLite's integrity check. Removals are listed, to be
  matched against what was removed on purpose. The ERROR and WARN lines of the
  second launch are listed for review.

Exit codes: 0 passed, 1 findings to look at, 2 refused before anything ran.

What a rehearsal cannot check: the key in the real OS key store (its name
depends on the userData path, so the copy gets another one; signing in is not
part of the rehearsal), Windows' `lockfile` against a running 0.4 build,
and the macOS privacy permissions (Accessibility, Screen Recording).

## Linux

1. Quit the 0.4 build (from the tray, not just the window).
2. Make two copies, one for (a) and one for (b), without the `Singleton*`
   files ((b) must not start from what (a) changed):

   ```sh
   for run in a b; do
     T=/tmp/pipette-rehearsal-$run
     mkdir -p "$T/home/.config/autostart"
     rsync -a --exclude 'Singleton*' ~/.config/pipette-desktop/ "$T/home/.config/pipette-desktop/"
     cp -p ~/.config/autostart/pipette.desktop "$T/home/.config/autostart/" 2>/dev/null || true
   done
   ```

3. Run (a) on the first copy and (b) on the second:

   ```sh
   npx tsx scripts/takeover-rehearsal/rehearsal.ts launch-only --root /tmp/pipette-rehearsal-a --app /path/to/Pipette-linux-x86_64.AppImage
   npx tsx scripts/takeover-rehearsal/rehearsal.ts operate     --root /tmp/pipette-rehearsal-b --app /path/to/Pipette-linux-x86_64.AppImage
   ```

   `--firejail` runs the app under `firejail --noprofile --net=none` (with
   `--appimage` for an AppImage), cutting the network off. It has not been
   tried on a machine with firejail; without it, the rehearsal relies on not
   signing in and on the loopback destinations below.

The script refuses (exit 2) when the rehearsal root is inside or holds a real
home directory, when the rehearsal home, userData or autostart directory
resolves into a real home or configuration directory, when the copy holds a
symbolic link, a file with another hard link or a `Singleton*` file, or when
there is no copy.

The app runs with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`
and `XDG_STATE_HOME` under the rehearsal home, so its userData directory is
`<root>/home/.config/pipette-desktop` and its autostart directory
`<root>/home/.config/autostart`; no `PIPETTE_*` variable is inherited (so the
userData directory and the autostart entry are resolved as for the user);
`PIPETTE_HUB_TEST=1` with `PIPETTE_HUB_URL=http://127.0.0.1:9` and
`PIPETTE_E2E=1` keep the Hub and the startup notices off the network; and the
session bus address points at nothing, so the app does not hand over to a
Pipette already running and does not reach the user's keyring or tray. The
app's output and a JSON report go to `<root>/reports`.

## Windows and macOS

Changing `HOME` or `APPDATA` does not separate the login item, the Run key or
the Keychain, so the rehearsal runs as a **temporary OS user** created for it
and deleted afterwards. Its own userData directory then holds the copy.

1. Quit the 0.4 build. Create a standard (not administrator) local user,
   for example `pipette-rehearsal`, and sign in to it once.
2. As the real user, copy the userData directory into the temporary user's,
   without `lockfile` (Windows) or the `Singleton*` files (macOS):
   - Windows: `%APPDATA%\pipette-desktop` →
     `C:\Users\pipette-rehearsal\AppData\Roaming\pipette-desktop`
     (`robocopy "%APPDATA%\pipette-desktop" "C:\Users\pipette-rehearsal\AppData\Roaming\pipette-desktop" /E /COPY:DAT /XF lockfile`),
     then give the temporary user ownership of the copy.
   - macOS: `~/Library/Application Support/pipette-desktop` →
     `/Users/pipette-rehearsal/Library/Application Support/pipette-desktop`
     (`sudo rsync -a --exclude 'Singleton*'` …), then
     `sudo chown -R pipette-rehearsal` on the copy.
3. Sign in as the temporary user. To rehearse the autostart takeover, turn
   the 0.4 build's autostart on there first: install Pipette 0.4 for that
   user, start it once on the copy with **Start at login** as the real user
   has it, and quit it. (Windows: this writes the 0.4 Run value. macOS:
   this registers the login item.)
4. Install the release for that user only:
   - Windows: run `Pipette-win-x64.exe` as the temporary user (it installs per
     user and removes that user's Pipette 0.4).
   - macOS: put `Pipette.app` in `/Users/pipette-rehearsal/Applications`, not
     in `/Applications` (that one is shared with the real user).
5. With the repository and Node.js available to the temporary user, record
   the data before the launch:

   ```sh
   npx tsx scripts/takeover-rehearsal/data-dir.ts snapshot --data "<userData>" --out "<dir>/before-a.json"
   ```

6. (a) Start Pipette, look at the window, quit from the tray. Then:

   ```sh
   npx tsx scripts/takeover-rehearsal/data-dir.ts compare --data "<userData>" --before "<dir>/before-a.json"
   ```

   Also check by hand that one autostart item is left and it starts the
   release: Windows: `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
   (one value `Pipette` with the quoted path of `pipette.exe`, no other value
   whose data is a path to `Pipette.exe`) and no value for the 0.4
   build left under `Explorer\StartupApproved\Run`; macOS 13+: System Settings › General ›
   Login Items. Record the name of the 0.4 value that was removed.
7. (b) As the real user, replace the temporary user's copy with a fresh one
   (step 2 again: delete the old copy first), so (b) does not start from what
   (a) changed. As the temporary user, take a new snapshot
   (`--out "<dir>/before-b.json"`), start Pipette, go through everything as in
   the Linux (b), quit, then:

   ```sh
   npx tsx scripts/takeover-rehearsal/data-dir.ts compare --data "<userData>" --before "<dir>/before-b.json" --operate
   ```

   Start Pipette once more and check that everything done is there.
8. Sign out, delete the temporary user and its home directory.

`<userData>` is `C:\Users\pipette-rehearsal\AppData\Roaming\pipette-desktop`
on Windows and `/Users/pipette-rehearsal/Library/Application Support/pipette-desktop`
on macOS; `<dir>` is any directory of the temporary user outside it.
