// SPDX-License-Identifier: GPL-2.0-or-later
//! The decisions of the in-app update that need no app: which manifest a
//! version reads, the release page of a version, whether a version the user
//! skipped is offered, which manifest address an override may name, and
//! whether this process updates itself at all.

use std::path::Path;

use pipette_fs::Platform;
use semver::Version;
use url::Url;

/// The repository the releases are published in.
pub const REPOSITORY_URL: &str = "https://github.com/darakuneko/pipette-desktop";

/// Where every asset of a release is downloaded from; the manifests live in
/// the fixed pre-release `updater-manifest` under it.
pub const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/darakuneko/pipette-desktop/releases/download/";

/// The tag of the pre-release that holds the channel manifests.
pub const MANIFEST_TAG: &str = "updater-manifest";

/// The public key value of src-tauri/tauri.conf.json until the release key
/// is generated. While it is there no update is offered: the key cannot
/// verify any signature, and the updater counts as not set up.
pub const PUBKEY_PLACEHOLDER: &str = "UPDATER-PUBLIC-KEY-PLACEHOLDER";

/// The manifest a version reads. A version with a pre-release part
/// (0.5.0-beta.2) reads the beta manifest, which also lists the stable
/// releases; one without reads the stable manifest only. The channel
/// follows the running version, so updating from a beta to a stable
/// release moves the app to the stable channel for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

pub fn channel_for(version: &Version) -> Channel {
    if version.pre.is_empty() { Channel::Stable } else { Channel::Beta }
}

/// The manifest of `channel`: `<channel>.json` of the `updater-manifest`
/// pre-release.
pub fn manifest_url(channel: Channel) -> String {
    format!("{RELEASE_DOWNLOAD_PREFIX}{MANIFEST_TAG}/{}.json", channel.name())
}

/// `version` without one leading `v`.
pub fn strip_v(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

/// The release page of `version` (its tag `v<version>`).
pub fn release_page_url(version: &str) -> String {
    format!("{REPOSITORY_URL}/releases/tag/v{}", strip_v(version))
}

/// Whether the update to `version` is offered at startup: not when it is
/// exactly the version the user skipped (both without a leading `v`). A
/// newer version than the skipped one is offered again.
pub fn should_offer(version: &str, skipped: Option<&str>) -> bool {
    skipped.is_none_or(|skipped| strip_v(skipped) != strip_v(version))
}

/// Whether `url` is http(s) on 127.0.0.1 or [::1], the addresses of the
/// fake update server of the tests.
fn is_loopback(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        && url.username().is_empty()
        && url.password().is_none()
}

/// Whether `url`, as parsed (dot segments resolved), lies under the
/// release downloads of the repository, with no user, port, query or
/// fragment.
fn is_release_download(url: &Url) -> bool {
    url.as_str().starts_with(RELEASE_DOWNLOAD_PREFIX)
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The manifest address `PIPETTE_UPDATER_MANIFEST_URL` names (`value`),
/// `None` when it is unset or empty. Every build accepts an https address
/// under the repository's release downloads (a staging manifest); a build
/// with the development tools also accepts one on the loopback interface.
pub fn manifest_override(value: Option<&str>, dev_tools: bool) -> Result<Option<Url>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = Url::parse(value).map_err(|err| format!("{value:?} is not a URL: {err}"))?;
    if is_release_download(&url) || (dev_tools && is_loopback(&url)) {
        Ok(Some(url))
    } else if dev_tools {
        Err(format!("{value:?} is neither under {RELEASE_DOWNLOAD_PREFIX} nor on the loopback interface"))
    } else {
        Err(format!("{value:?} is not under {RELEASE_DOWNLOAD_PREFIX}"))
    }
}

/// Whether a macOS app runs from where it cannot be replaced: a mounted
/// disk image (`/Volumes/`) or the read-only copy Gatekeeper's app
/// translocation runs a quarantined app from.
pub fn macos_app_location_blocked(exe: &Path) -> bool {
    exe.starts_with("/Volumes") || exe.components().any(|part| part.as_os_str() == "AppTranslocation")
}

/// What decides whether this process updates itself.
pub struct Conditions<'a> {
    /// A build with the development tools.
    pub dev_tools: bool,
    /// `crate::distributed_build`.
    pub distributed: bool,
    /// `PIPETTE_E2E` is in the environment (`crate::e2e_run::e2e_mark_present`).
    pub e2e_mark: bool,
    pub platform: Platform,
    /// The running executable.
    pub exe: &'a Path,
    /// `pipette_fs::is_appimage_run`.
    pub appimage_run: bool,
    /// `requireSignedVersion` of the updater's configuration.
    pub signed_version_required: bool,
    /// The public key the updater verifies with.
    pub pubkey: &'a str,
    /// The manifest override ([`manifest_override`]).
    pub manifest_override: Option<&'a Url>,
    /// The running version.
    pub version: &'a Version,
}

/// Where an enabled updater reads its manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enabled {
    pub manifest: Url,
}

/// Whether this process updates itself, and from which manifest; the
/// reason when it does not. Fails closed: without the version bound into
/// the signature or with the placeholder key, nothing is offered.
///
/// A build with the development tools updates only from a manifest on the
/// loopback interface (the fake update server). Any other build updates
/// when it is a distributed build outside an e2e run, run from where it can
/// be replaced: an AppImage the runtime started on Linux, an app outside a
/// disk image and app translocation on macOS, the installed app on Windows.
pub fn updater_enabled(conditions: &Conditions<'_>) -> Result<Enabled, &'static str> {
    if !conditions.signed_version_required {
        return Err("the updater does not require the version in the signature");
    }
    if conditions.pubkey.trim().is_empty() || conditions.pubkey == PUBKEY_PLACEHOLDER {
        return Err("the updater's public key is not set");
    }
    if conditions.dev_tools {
        return match conditions.manifest_override {
            Some(url) if is_loopback(url) => Ok(Enabled { manifest: url.clone() }),
            _ => Err(
                "a build with the development tools updates only from a manifest on the loopback interface",
            ),
        };
    }
    if !conditions.distributed {
        return Err("not a distributed build");
    }
    if conditions.e2e_mark {
        return Err("an e2e run");
    }
    match conditions.platform {
        Platform::Linux if !conditions.appimage_run => return Err("not run as an AppImage"),
        Platform::MacOs if macos_app_location_blocked(conditions.exe) => {
            return Err("run from a disk image or a translocated copy");
        }
        Platform::Other => return Err("no release for this system"),
        Platform::Linux | Platform::MacOs | Platform::Windows => {}
    }
    let manifest = match conditions.manifest_override {
        Some(url) => url.clone(),
        None => Url::parse(&manifest_url(channel_for(conditions.version)))
            .map_err(|_| "the manifest address does not parse")?,
    };
    Ok(Enabled { manifest })
}

/// Why an update step failed, for the renderer to put in words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UpdateErrorCode {
    /// The manifest or the update could not be fetched or read.
    Network,
    /// The signature does not verify, or does not carry the announced version.
    Signature,
    /// The app's location cannot be written, the administrator prompt of
    /// macOS refused included.
    Permission,
    /// The app started quitting before the update was applied.
    Cancelled,
    /// Another check or the update is running.
    Busy,
    Unknown,
}

/// The code of an updater error.
pub fn error_code(error: &tauri_plugin_updater::Error) -> UpdateErrorCode {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(_)
        | Error::Network(_)
        | Error::ReleaseNotFound
        | Error::Serialization(_)
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_)
        | Error::UrlParse(_) => UpdateErrorCode::Network,
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => UpdateErrorCode::Signature,
        Error::Io(err) if err.kind() == std::io::ErrorKind::PermissionDenied => UpdateErrorCode::Permission,
        Error::TempDirNotOnSameMountPoint => UpdateErrorCode::Permission,
        Error::AuthenticationFailed => UpdateErrorCode::Cancelled,
        _ => UpdateErrorCode::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn a_pre_release_reads_the_beta_manifest_and_a_release_the_stable_one() {
        assert_eq!(channel_for(&version("0.5.0-beta.2")), Channel::Beta);
        assert_eq!(channel_for(&version("0.5.0-rc.1")), Channel::Beta);
        assert_eq!(channel_for(&version("0.5.0")), Channel::Stable);
        // Build metadata is not a pre-release part.
        assert_eq!(channel_for(&version("0.5.0+build.7")), Channel::Stable);
        assert_eq!(
            manifest_url(Channel::Beta),
            "https://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/beta.json"
        );
        assert_eq!(
            manifest_url(Channel::Stable),
            "https://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/stable.json"
        );
    }

    #[test]
    fn the_release_page_is_the_tag_of_the_version() {
        let page = "https://github.com/darakuneko/pipette-desktop/releases/tag/v0.5.0-beta.2";
        assert_eq!(release_page_url("0.5.0-beta.2"), page);
        assert_eq!(release_page_url("v0.5.0-beta.2"), page);
    }

    #[test]
    fn only_the_exact_skipped_version_is_not_offered() {
        assert!(should_offer("0.5.0-beta.3", None));
        assert!(!should_offer("0.5.0-beta.3", Some("0.5.0-beta.3")));
        assert!(!should_offer("v0.5.0-beta.3", Some("0.5.0-beta.3")));
        assert!(!should_offer("0.5.0-beta.3", Some("v0.5.0-beta.3")));
        // A newer version than the skipped one, and an older one.
        assert!(should_offer("0.5.0-beta.4", Some("0.5.0-beta.3")));
        assert!(should_offer("0.5.0", Some("0.5.0-beta.3")));
        assert!(should_offer("0.5.0-beta.2", Some("0.5.0-beta.3")));
        // Not a semver comparison: a different spelling is another version.
        assert!(should_offer("0.5.0-beta.3", Some("0.5.0-beta.03")));
    }

    #[test]
    fn a_release_build_accepts_only_an_override_under_the_release_downloads() {
        let staging =
            "https://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/staging.json";
        assert_eq!(manifest_override(Some(staging), false).unwrap().unwrap().as_str(), staging);
        assert_eq!(manifest_override(None, false), Ok(None));
        assert_eq!(manifest_override(Some("  "), false), Ok(None));
        for refused in [
            "http://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/staging.json",
            "https://github.com/darakuneko/pipette-desktop/releases/download/../../other/releases/download/x.json",
            "https://github.com/darakuneko/pipette-desktop/releases/download/%2e%2e/%2e%2e/x/beta.json",
            "https://github.com/darakuneko/pipette-desktop-fork/releases/download/updater-manifest/beta.json",
            "https://github.com:8443/darakuneko/pipette-desktop/releases/download/updater-manifest/beta.json",
            "https://user@github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/beta.json",
            "https://github.com.evil.example/darakuneko/pipette-desktop/releases/download/x.json",
            "https://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/beta.json?x=1",
            "https://github.com/darakuneko/pipette-desktop/releases/download/updater-manifest/beta.json#x",
            "http://127.0.0.1:8080/beta.json",
            "not a url",
        ] {
            assert!(manifest_override(Some(refused), false).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_build_with_the_tools_also_accepts_the_loopback_interface() {
        for accepted in ["http://127.0.0.1:8080/beta.json", "https://[::1]:9/beta.json"] {
            assert!(manifest_override(Some(accepted), true).unwrap().is_some(), "{accepted}");
        }
        for refused in [
            "http://localhost:8080/beta.json",
            "http://10.0.0.1/beta.json",
            "http://u:p@127.0.0.1:8080/beta.json",
            "file:///tmp/beta.json",
        ] {
            assert!(manifest_override(Some(refused), true).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_disk_image_and_app_translocation_block_a_macos_update() {
        assert!(macos_app_location_blocked(Path::new("/Volumes/Pipette/Pipette.app/Contents/MacOS/pipette")));
        assert!(macos_app_location_blocked(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Pipette.app/Contents/MacOS/pipette"
        )));
        assert!(!macos_app_location_blocked(Path::new("/Applications/Pipette.app/Contents/MacOS/pipette")));
        assert!(!macos_app_location_blocked(Path::new(
            "/Users/u/Applications/Volumes.app/Contents/MacOS/pipette"
        )));
    }

    /// The conditions of an installed release on `platform`.
    struct Case {
        dev_tools: bool,
        distributed: bool,
        e2e_mark: bool,
        platform: Platform,
        exe: PathBuf,
        appimage_run: bool,
        signed_version_required: bool,
        pubkey: &'static str,
        manifest_override: Option<Url>,
        version: Version,
    }

    impl Case {
        fn release(platform: Platform) -> Self {
            Self {
                dev_tools: false,
                distributed: true,
                e2e_mark: false,
                platform,
                exe: PathBuf::from("/Applications/Pipette.app/Contents/MacOS/pipette"),
                appimage_run: true,
                signed_version_required: true,
                pubkey: "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu",
                manifest_override: None,
                version: version("0.5.0-beta.2"),
            }
        }

        fn enabled(&self) -> Result<Enabled, &'static str> {
            updater_enabled(&Conditions {
                dev_tools: self.dev_tools,
                distributed: self.distributed,
                e2e_mark: self.e2e_mark,
                platform: self.platform,
                exe: &self.exe,
                appimage_run: self.appimage_run,
                signed_version_required: self.signed_version_required,
                pubkey: self.pubkey,
                manifest_override: self.manifest_override.as_ref(),
                version: &self.version,
            })
        }
    }

    fn manifest(case: &Case) -> String {
        case.enabled().unwrap().manifest.to_string()
    }

    #[test]
    fn an_installed_release_reads_the_manifest_of_its_channel() {
        for platform in [Platform::Linux, Platform::MacOs, Platform::Windows] {
            assert_eq!(manifest(&Case::release(platform)), manifest_url(Channel::Beta));
        }
        let mut stable = Case::release(Platform::Windows);
        stable.version = version("0.5.0");
        assert_eq!(manifest(&stable), manifest_url(Channel::Stable));
        let mut staging = Case::release(Platform::Linux);
        let url =
            manifest_override(Some(&format!("{RELEASE_DOWNLOAD_PREFIX}{MANIFEST_TAG}/staging.json")), false)
                .unwrap()
                .unwrap();
        staging.manifest_override = Some(url.clone());
        assert_eq!(staging.enabled().unwrap().manifest, url);
    }

    #[test]
    fn the_updater_fails_closed() {
        let mut unsigned_version = Case::release(Platform::Windows);
        unsigned_version.signed_version_required = false;
        assert!(unsigned_version.enabled().is_err());
        let mut placeholder = Case::release(Platform::Windows);
        placeholder.pubkey = PUBKEY_PLACEHOLDER;
        assert!(placeholder.enabled().is_err());
        let mut empty = Case::release(Platform::Windows);
        empty.pubkey = " ";
        assert!(empty.enabled().is_err());
    }

    #[test]
    fn only_a_replaceable_distributed_release_outside_an_e2e_run_updates() {
        let mut built = Case::release(Platform::Windows);
        built.distributed = false;
        assert!(built.enabled().is_err());
        let mut e2e = Case::release(Platform::Windows);
        e2e.e2e_mark = true;
        assert!(e2e.enabled().is_err());
        let mut extracted = Case::release(Platform::Linux);
        extracted.appimage_run = false;
        assert!(extracted.enabled().is_err());
        let mut dmg = Case::release(Platform::MacOs);
        dmg.exe = PathBuf::from("/Volumes/Pipette/Pipette.app/Contents/MacOS/pipette");
        assert!(dmg.enabled().is_err());
        assert!(Case::release(Platform::Other).enabled().is_err());
    }

    #[test]
    fn a_build_with_the_tools_updates_only_from_the_loopback_interface() {
        let mut tools = Case::release(Platform::Linux);
        tools.dev_tools = true;
        tools.distributed = false;
        tools.e2e_mark = true;
        assert!(tools.enabled().is_err());
        tools.manifest_override = manifest_override(Some(&manifest_url(Channel::Beta)), true).unwrap();
        assert!(tools.enabled().is_err());
        let fake = manifest_override(Some("http://127.0.0.1:4/beta.json"), true).unwrap().unwrap();
        tools.manifest_override = Some(fake.clone());
        assert_eq!(tools.enabled().unwrap().manifest, fake);
        tools.pubkey = PUBKEY_PLACEHOLDER;
        assert!(tools.enabled().is_err());
    }
}
