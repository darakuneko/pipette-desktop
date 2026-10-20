// SPDX-License-Identifier: GPL-2.0-or-later
//! The in-app update, behind the shim's update members
//! (src/tauri-shim/api/update.ts): check the manifest of the running
//! version's channel, download the update and verify its minisign
//! signature, then apply it through the quit sequence of src/lifecycle.rs
//! so nothing pending is lost.
//!
//! tauri-plugin-updater does the fetching, the verification and the
//! replacement; the page is granted none of its own commands. The signature
//! must carry the version it was signed for (`requireSignedVersion` in
//! tauri.conf.json): the manifest itself is not signed, so without that a
//! tampered manifest could offer an older signed release as a newer one.
//!
//! The order of an update, the same on every system: download and verify,
//! claim the quit (refused once a quit has started, and then nothing is
//! applied), run the quit sequence, save the window state, install, then
//! start the new app: `open -n` of the bundle on macOS, Tauri's restart on
//! Linux, the installer itself on Windows (NSIS, passive, which ends this
//! process and starts the app again when done). Nothing runs alongside the
//! replacement, so a quit cannot cut it short. When the install fails the
//! process exits all the same, and the next launch shows the failure
//! (`update_take_failure`): the app never goes back to normal operation
//! with its files half replaced.
//!
//! The policy (which builds update, from which manifest) is in
//! updater/policy.rs. A build with the development tools reads three
//! variables for the tests: `PIPETTE_UPDATER_MANIFEST_URL` may then name a
//! manifest on the loopback interface, `PIPETTE_DEV_UPDATER_PUBKEY`
//! replaces the public key, and `PIPETTE_DEV_UPDATER_FAKE_INSTALL` names a
//! file the update is recorded in instead of being installed.

mod policy;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

pub use policy::UpdateErrorCode;
use policy::{error_code, release_page_url, should_offer};

use crate::lifecycle::{self, AfterQuit, Ending};

/// `IpcChannels.UPDATE_PROGRESS`: the download's progress (`UpdateProgress`).
pub const UPDATE_PROGRESS: &str = "update:progress";

/// A staging manifest (src/updater/policy.rs `manifest_override`).
const MANIFEST_URL_ENV: &str = "PIPETTE_UPDATER_MANIFEST_URL";

/// Builds with the development tools: the public key the tests sign with.
#[cfg(feature = "dev-tools")]
const DEV_PUBKEY_ENV: &str = "PIPETTE_DEV_UPDATER_PUBKEY";

/// Builds with the development tools: the file a fake install writes.
#[cfg(feature = "dev-tools")]
const DEV_FAKE_INSTALL_ENV: &str = "PIPETTE_DEV_UPDATER_FAKE_INSTALL";

/// The failure an update left for the next launch to show, in `local/` of
/// the userData directory (Windows, when the installer could not start).
pub const FAILURE_FILE: &str = "update-failed.json";

/// How long the manifest request may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// How often the download's progress is sent at most.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateCheckResult {
    /// This build does not update itself.
    Disabled,
    UpToDate,
    /// `skipped`: the user chose to skip exactly this version, so it is not
    /// offered at startup.
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        current_version: String,
        release_url: String,
        skipped: bool,
    },
    Failed {
        code: UpdateErrorCode,
    },
}

/// What applying the update answered. On success the app is quitting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateInstallResult {
    Restarting,
    #[serde(rename_all = "camelCase")]
    Failed {
        code: UpdateErrorCode,
        release_url: String,
    },
}

/// The download's progress, in bytes; `total` is null when the server does
/// not send the size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct UpdateProgress {
    pub downloaded: f64,
    pub total: Option<f64>,
}

/// The failure an update left for the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateFailure {
    pub version: String,
    pub code: UpdateErrorCode,
    pub release_url: String,
    /// Where the previous app was kept when it could not be put back
    /// (`previousAppNotRestored`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub backup_path: Option<String>,
}

/// How this process updates itself.
struct Setup {
    manifest: url::Url,
    /// The public key replacing the configured one (development tools).
    pubkey: Option<String>,
    /// Where a fake install is recorded (development tools).
    fake_install: Option<PathBuf>,
}

/// Where the update is.
enum Phase {
    Idle,
    Checking,
    /// A check found this update, which the page may apply.
    Ready(Box<Update>),
    /// The update is being downloaded or applied.
    Applying,
}

/// The managed state: whether the updater is enabled, where the update is,
/// and how the quit is requested.
pub struct UpdaterState {
    setup: Result<Setup, String>,
    phase: Mutex<Phase>,
    user_data: PathBuf,
    quit_for_update: Box<dyn Fn(AfterQuit) -> bool + Send + Sync>,
}

impl UpdaterState {
    fn phase(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Settles whether this process updates itself, and manages the state.
/// Called from the app's setup hook.
pub fn manage(app: &AppHandle<Wry>, user_data: &Path) {
    let setup = resolve_setup(app);
    match &setup {
        Ok(setup) => log::info!("[update] enabled; manifest {}", setup.manifest),
        Err(reason) => log::info!("[update] disabled: {reason}"),
    }
    let handle = app.clone();
    app.manage(Arc::new(UpdaterState {
        setup,
        phase: Mutex::new(Phase::Idle),
        user_data: user_data.to_path_buf(),
        quit_for_update: Box::new(move |after| lifecycle::quit_for_update(&handle, after)),
    }));
}

fn resolve_setup<R: Runtime>(app: &AppHandle<R>) -> Result<Setup, String> {
    let dev_tools = cfg!(feature = "dev-tools");
    let manifest_override =
        policy::manifest_override(std::env::var(MANIFEST_URL_ENV).ok().as_deref(), dev_tools)
            .map_err(|err| format!("{MANIFEST_URL_ENV} ignored: {err}"))?;
    // The updater's configuration in tauri.conf.json (`plugins.updater`).
    let config = app.config().plugins.0.get("updater");
    let configured_pubkey = config.and_then(|c| c.get("pubkey")).and_then(|v| v.as_str()).unwrap_or("");
    let signed_version_required =
        config.and_then(|c| c.get("requireSignedVersion")).and_then(|v| v.as_bool()) == Some(true);
    let dev_pubkey = dev_pubkey();
    let pubkey = dev_pubkey.as_deref().unwrap_or(configured_pubkey);
    let exe = std::env::current_exe().unwrap_or_default();
    let manifest = policy::updater_enabled(&policy::Conditions {
        dev_tools,
        distributed: crate::distributed_build(),
        e2e_mark: crate::e2e_run::e2e_mark_present(),
        platform: pipette_fs::Platform::current(),
        exe: &exe,
        appimage_run: pipette_fs::is_appimage_run(),
        signed_version_required,
        pubkey,
        manifest_override: manifest_override.as_ref(),
        version: &app.package_info().version,
    })?;
    Ok(Setup { manifest, pubkey: dev_pubkey, fake_install: fake_install_path() })
}

#[cfg(feature = "dev-tools")]
fn dev_pubkey() -> Option<String> {
    std::env::var(DEV_PUBKEY_ENV).ok().filter(|key| !key.trim().is_empty())
}

#[cfg(not(feature = "dev-tools"))]
fn dev_pubkey() -> Option<String> {
    None
}

#[cfg(feature = "dev-tools")]
fn fake_install_path() -> Option<PathBuf> {
    std::env::var_os(DEV_FAKE_INSTALL_ENV).filter(|path| !path.is_empty()).map(PathBuf::from)
}

#[cfg(not(feature = "dev-tools"))]
fn fake_install_path() -> Option<PathBuf> {
    None
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<UpdaterState>> {
    app.try_state::<Arc<UpdaterState>>().map(|state| Arc::clone(&state))
}

/// The version the user chose to skip (`updateSkippedVersion`).
fn skipped_version<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let config = app.try_state::<crate::app_config::AppConfig>()?;
    match config.get("updateSkippedVersion") {
        Ok(value) => value.as_ref().and_then(|value| value.as_str()).map(str::to_owned),
        Err(err) => {
            log::warn!("[update] failed to read updateSkippedVersion: {err}");
            None
        }
    }
}

/// Checks the manifest. A check while another runs or the update is being
/// applied answers `busy`.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> UpdateCheckResult {
    let Some(state) = state(&app) else { return UpdateCheckResult::Disabled };
    let Ok(setup) = &state.setup else { return UpdateCheckResult::Disabled };
    {
        let mut phase = state.phase();
        if matches!(*phase, Phase::Checking | Phase::Applying) {
            return UpdateCheckResult::Failed { code: UpdateErrorCode::Busy };
        }
        *phase = Phase::Checking;
    }
    let found = check(&app, setup).await;
    let mut phase = state.phase();
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            *phase = Phase::Ready(Box::new(update));
            drop(phase);
            let skipped = !should_offer(&version, skipped_version(&app).as_deref());
            log::info!("[update] {version} is available (running {current_version}, skipped: {skipped})");
            UpdateCheckResult::Available {
                release_url: release_page_url(&version),
                version,
                current_version,
                skipped,
            }
        }
        Ok(None) => {
            *phase = Phase::Idle;
            UpdateCheckResult::UpToDate
        }
        Err(err) => {
            *phase = Phase::Idle;
            log::warn!("[update] check failed: {err}");
            UpdateCheckResult::Failed { code: error_code(&err) }
        }
    }
}

async fn check<R: Runtime>(
    app: &AppHandle<R>,
    setup: &Setup,
) -> tauri_plugin_updater::Result<Option<Update>> {
    let mut builder = app
        .updater_builder()
        .endpoints(vec![setup.manifest.clone()])?
        .timeout(CHECK_TIMEOUT)
        .restart_after_install(true);
    if let Some(pubkey) = &setup.pubkey {
        builder = builder.pubkey(pubkey.clone());
    }
    builder.build()?.check().await
}

/// Downloads, verifies and applies the update a check found, when it is
/// still `version`. On success the app is quitting and starts again as the
/// new version.
#[tauri::command]
pub async fn update_install<R: Runtime>(app: AppHandle<R>, version: String) -> UpdateInstallResult {
    let failed = |code| UpdateInstallResult::Failed { code, release_url: release_page_url(&version) };
    let Some(state) = state(&app) else { return failed(UpdateErrorCode::Unknown) };
    let update = {
        let mut phase = state.phase();
        match std::mem::replace(&mut *phase, Phase::Applying) {
            Phase::Ready(update) if update.version == version => update,
            other => {
                let busy = matches!(other, Phase::Checking | Phase::Applying);
                *phase = other;
                return failed(if busy { UpdateErrorCode::Busy } else { UpdateErrorCode::Unknown });
            }
        }
    };
    match apply(&app, &state, &update).await {
        Ok(()) => UpdateInstallResult::Restarting,
        Err(code) => {
            // A failed update can be tried again, unless the app is quitting.
            *state.phase() = Phase::Ready(update);
            failed(code)
        }
    }
}

async fn apply<R: Runtime>(
    app: &AppHandle<R>,
    state: &UpdaterState,
    update: &Update,
) -> Result<(), UpdateErrorCode> {
    if lifecycle::is_quitting(app) {
        log::warn!("[update] the app started quitting; the update is not applied");
        return Err(UpdateErrorCode::Cancelled);
    }
    log::info!("[update] downloading {}", update.version);
    let bytes = update.download(progress_sender(app), || {}).await.map_err(|err| {
        log::warn!("[update] download or verification failed: {err}");
        error_code(&err)
    })?;
    log::info!("[update] {} downloaded and verified ({} bytes)", update.version, bytes.len());
    let setup = state.setup.as_ref().map_err(|_| UpdateErrorCode::Unknown)?;
    let user_data = state.user_data.clone();
    let install: Box<dyn FnOnce() -> Ending + Send> = match setup.fake_install.clone() {
        Some(record) => {
            let installer = FakeInstaller { version: update.version.clone(), record };
            Box::new(move || install_after_quit(&installer, &bytes, &user_data))
        }
        None => {
            let update = update.clone();
            Box::new(move || install_after_quit(&update, &bytes, &user_data))
        }
    };
    request_quit(state, AfterQuit::Install(install))
}

/// What installs a downloaded, verified update once the quit sequence has
/// ended: the plugin's [`Update`], or the fake of the tests.
trait Installer {
    fn version(&self) -> &str;
    /// Replaces the app (macOS, Linux) or starts the installer, which ends
    /// the process (Windows).
    fn install(&self, bytes: &[u8]) -> tauri_plugin_updater::Result<()>;
    /// How the app ends once installed.
    fn ending(&self) -> Ending;
}

impl Installer for Update {
    fn version(&self) -> &str {
        &self.version
    }

    fn install(&self, bytes: &[u8]) -> tauri_plugin_updater::Result<()> {
        Update::install(self, bytes)
    }

    /// Windows' installer starts the app again itself; elsewhere the app
    /// starts the replaced app.
    fn ending(&self) -> Ending {
        if cfg!(target_os = "windows") { Ending::Exit } else { Ending::Relaunch }
    }
}

/// Records the update in a file instead of installing it, and exits
/// (development tools).
struct FakeInstaller {
    version: String,
    record: PathBuf,
}

impl Installer for FakeInstaller {
    fn version(&self) -> &str {
        &self.version
    }

    fn install(&self, bytes: &[u8]) -> tauri_plugin_updater::Result<()> {
        let text = serde_json::json!({ "version": self.version, "size": bytes.len() }).to_string();
        pipette_fs::write_file_atomic(&self.record, text.as_bytes())?;
        log::info!("[update] recorded the fake install of {} in {}", self.version, self.record.display());
        Ok(())
    }

    fn ending(&self) -> Ending {
        Ending::Exit
    }
}

/// Installs after the quit sequence. A failure is written for the next
/// launch and the app exits: it never goes back to normal operation.
fn install_after_quit(installer: &dyn Installer, bytes: &[u8], user_data: &Path) -> Ending {
    let version = installer.version();
    log::info!("[update] installing {version}");
    log::logger().flush();
    match installer.install(bytes) {
        Ok(()) => {
            log::info!("[update] installed {version}");
            installer.ending()
        }
        Err(err) => {
            log::error!("[update] installing {version} failed: {err}");
            let backup_path = match &err {
                tauri_plugin_updater::Error::PreviousAppNotRestored(path) => Some(path.display().to_string()),
                _ => None,
            };
            write_failure(
                user_data,
                &UpdateFailure {
                    version: version.to_owned(),
                    code: error_code(&err),
                    release_url: release_page_url(version),
                    backup_path,
                },
            );
            Ending::Exit
        }
    }
}

/// Requests the quit that applies the update; refused once the app is
/// already quitting.
fn request_quit(state: &UpdaterState, after: AfterQuit) -> Result<(), UpdateErrorCode> {
    if (state.quit_for_update)(after) {
        Ok(())
    } else {
        log::warn!("[update] the app is already quitting; it will not start again on its own");
        Err(UpdateErrorCode::Cancelled)
    }
}

/// The download's progress callback: sends `update:progress`, at most every
/// `PROGRESS_INTERVAL` and for the last chunk.
fn progress_sender<R: Runtime>(app: &AppHandle<R>) -> impl FnMut(usize, Option<u64>) + use<R> {
    let app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_sent: Option<Instant> = None;
    move |chunk, total| {
        downloaded += chunk as u64;
        let done = total.is_some_and(|total| downloaded >= total);
        if done || last_sent.is_none_or(|sent| sent.elapsed() >= PROGRESS_INTERVAL) {
            last_sent = Some(Instant::now());
            let progress =
                UpdateProgress { downloaded: downloaded as f64, total: total.map(|total| total as f64) };
            crate::events::emit_all(&app, UPDATE_PROGRESS, progress);
        }
    }
}

fn failure_path(user_data: &Path) -> PathBuf {
    user_data.join("local").join(FAILURE_FILE)
}

fn write_failure(user_data: &Path, failure: &UpdateFailure) {
    let path = failure_path(user_data);
    let written = serde_json::to_vec(failure).map_err(std::io::Error::other).and_then(|text| {
        std::fs::create_dir_all(user_data.join("local"))?;
        pipette_fs::write_file_atomic(&path, &text)
    });
    if let Err(err) = written {
        log::error!("[update] failed to write {}: {err}", path.display());
    }
}

/// Takes the failure the last update left: answers it once and removes
/// the file. A file that does not parse is removed and answers nothing.
#[tauri::command]
pub async fn update_take_failure<R: Runtime>(app: AppHandle<R>) -> Option<UpdateFailure> {
    let user_data = app.try_state::<crate::UserDataDir>()?.0.clone();
    tauri::async_runtime::spawn_blocking(move || take_failure(&user_data)).await.ok().flatten()
}

fn take_failure(user_data: &Path) -> Option<UpdateFailure> {
    let path = failure_path(user_data);
    let text = std::fs::read(&path).ok()?;
    if let Err(err) = std::fs::remove_file(&path) {
        log::warn!("[update] failed to remove {}: {err}", path.display());
    }
    serde_json::from_slice(&text)
        .inspect_err(|err| log::warn!("[update] ignoring {}: {err}", path.display()))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_is_answered_once() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(take_failure(dir.path()), None);
        let failure = UpdateFailure {
            version: "0.5.0-beta.3".into(),
            code: UpdateErrorCode::Permission,
            release_url: release_page_url("0.5.0-beta.3"),
            backup_path: None,
        };
        write_failure(dir.path(), &failure);
        let text = std::fs::read_to_string(failure_path(dir.path())).unwrap();
        assert_eq!(
            text,
            r#"{"version":"0.5.0-beta.3","code":"permission","releaseUrl":"https://github.com/darakuneko/pipette-desktop/releases/tag/v0.5.0-beta.3"}"#
        );
        assert_eq!(take_failure(dir.path()), Some(failure));
        assert_eq!(take_failure(dir.path()), None);
    }

    #[test]
    fn a_failure_that_does_not_parse_is_removed() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("local")).unwrap();
        std::fs::write(failure_path(dir.path()), b"{").unwrap();
        assert_eq!(take_failure(dir.path()), None);
        assert!(!failure_path(dir.path()).exists());
    }

    #[test]
    fn the_results_serialize_as_the_shim_reads_them() {
        let available = UpdateCheckResult::Available {
            version: "0.5.0-beta.3".into(),
            current_version: "0.5.0-beta.2".into(),
            release_url: "u".into(),
            skipped: false,
        };
        assert_eq!(
            serde_json::to_string(&available).unwrap(),
            r#"{"status":"available","version":"0.5.0-beta.3","currentVersion":"0.5.0-beta.2","releaseUrl":"u","skipped":false}"#
        );
        assert_eq!(serde_json::to_string(&UpdateCheckResult::UpToDate).unwrap(), r#"{"status":"upToDate"}"#);
        assert_eq!(
            serde_json::to_string(&UpdateInstallResult::Failed {
                code: UpdateErrorCode::Signature,
                release_url: "u".into()
            })
            .unwrap(),
            r#"{"status":"failed","code":"signature","releaseUrl":"u"}"#
        );
    }

    #[test]
    fn the_configuration_requires_the_signed_version_and_installs_passively() {
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap(),
        )
        .unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["requireSignedVersion"], serde_json::json!(true));
        assert_eq!(updater["windows"]["installMode"], serde_json::json!("passive"));
        assert!(updater["pubkey"].is_string());
        // The endpoints come from the running version (updater/policy.rs).
        assert!(updater.get("endpoints").is_none());
    }

    /// An installer that answers `result` and records that it ran.
    struct ScriptedInstaller {
        result: fn() -> tauri_plugin_updater::Result<()>,
        ending: Ending,
        ran: Mutex<usize>,
    }

    impl Installer for ScriptedInstaller {
        fn version(&self) -> &str {
            "0.5.0-beta.3"
        }

        fn install(&self, _bytes: &[u8]) -> tauri_plugin_updater::Result<()> {
            *self.ran.lock().unwrap() += 1;
            (self.result)()
        }

        fn ending(&self) -> Ending {
            self.ending
        }
    }

    /// The step that follows the quit sequence with `installer`, as
    /// src/lifecycle.rs runs it, and whether the window state was saved
    /// before the install.
    fn after_quit_with(installer: Arc<ScriptedInstaller>, user_data: &Path) -> (Ending, bool) {
        let saved = Arc::new(Mutex::new(false));
        let saved_before = Arc::new(Mutex::new(false));
        let user_data = user_data.to_path_buf();
        let (seen, check) = (Arc::clone(&saved), Arc::clone(&saved_before));
        let install = Box::new(move || {
            *check.lock().unwrap() = *seen.lock().unwrap();
            install_after_quit(&*installer, b"update", &user_data)
        });
        let ending = lifecycle::ending_after(AfterQuit::Install(install), || *saved.lock().unwrap() = true);
        let before = *saved_before.lock().unwrap();
        (ending, before)
    }

    fn scripted(result: fn() -> tauri_plugin_updater::Result<()>, ending: Ending) -> Arc<ScriptedInstaller> {
        Arc::new(ScriptedInstaller { result, ending, ran: Mutex::new(0) })
    }

    #[test]
    fn an_install_after_the_quit_starts_the_app_again_or_exits_as_the_system_does() {
        for ending in [Ending::Relaunch, Ending::Exit] {
            let dir = tempfile::TempDir::new().unwrap();
            let installer = scripted(|| Ok(()), ending);
            assert_eq!(after_quit_with(Arc::clone(&installer), dir.path()), (ending, true));
            assert_eq!(*installer.ran.lock().unwrap(), 1);
            assert_eq!(take_failure(dir.path()), None);
        }
    }

    #[test]
    fn a_failed_install_after_the_quit_is_written_for_the_next_launch_and_exits() {
        let dir = tempfile::TempDir::new().unwrap();
        let denied = scripted(
            || Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into()),
            Ending::Relaunch,
        );
        assert_eq!(after_quit_with(denied, dir.path()), (Ending::Exit, true));
        assert_eq!(
            take_failure(dir.path()),
            Some(UpdateFailure {
                version: "0.5.0-beta.3".into(),
                code: UpdateErrorCode::Permission,
                release_url: release_page_url("0.5.0-beta.3"),
                backup_path: None,
            })
        );

        let lost = scripted(
            || {
                Err(tauri_plugin_updater::Error::PreviousAppNotRestored(PathBuf::from(
                    "/tmp/tauri_current_app1/Pipette.app",
                )))
            },
            Ending::Relaunch,
        );
        assert_eq!(after_quit_with(lost, dir.path()), (Ending::Exit, true));
        let failure = take_failure(dir.path()).unwrap();
        assert_eq!(failure.code, UpdateErrorCode::PreviousAppNotRestored);
        assert_eq!(failure.backup_path.as_deref(), Some("/tmp/tauri_current_app1/Pipette.app"));
        let text = serde_json::to_string(&failure).unwrap();
        assert!(
            text.contains(r#""code":"previousAppNotRestored""#) && text.contains(r#""backupPath":"#),
            "{text}"
        );
    }

    #[test]
    fn a_fake_install_records_the_version_and_size_and_exits() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = dir.path().join("installed.json");
        let fake = FakeInstaller { version: "0.5.0-beta.3".into(), record: record.clone() };
        assert_eq!(install_after_quit(&fake, &[0; 12], dir.path()), Ending::Exit);
        assert_eq!(std::fs::read_to_string(&record).unwrap(), r#"{"size":12,"version":"0.5.0-beta.3"}"#);
        // A record that cannot be written is a failure of the install.
        let unwritable =
            FakeInstaller { version: "0.5.0-beta.3".into(), record: dir.path().join("missing/dir/x.json") };
        assert_eq!(install_after_quit(&unwritable, &[0; 12], dir.path()), Ending::Exit);
        assert!(take_failure(dir.path()).is_some());
    }
}
