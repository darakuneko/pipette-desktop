// SPDX-License-Identifier: GPL-2.0-or-later
//! The timing cases of the preflight parts that the recorded scenarios
//! (ts_preflight.rs) cannot reach: work that finishes after a sign-out,
//! refreshes that overlap a block or a clear, sets and creations that run
//! at once, a sign-in change during a set, a replace or a password-check
//! creation, and a password that cannot be stored (src/main/sync/__tests__/sync-format.test.ts,
//! sync-format-status.test.ts and sync-password-guard.test.ts).

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;

use std::sync::{Arc, Mutex};

use pipette_drive::fake::DriveOp;
use pipette_sync::format::{SYNC_FORMAT_VERSION, SyncFormatStatus, marker_content};
use pipette_sync::password::guard::SyncBlockReason;
use pipette_sync::preflight::PreflightError;
use pipette_sync_runtime::{SyncDirection, SyncStatus};
use preflight_harness::{Harness, Stored};

const OWN: &str = "sync-format-v2.json";

/// Waits for work on other tasks or blocking threads (the key store and
/// the key derivation run on blocking threads, which a slow machine may
/// not schedule within any fixed number of yields).
async fn wait_until(condition: impl Fn() -> bool) {
    let waited = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    });
    waited.await.expect("the condition never held");
}

fn creates(events: &[String]) -> usize {
    events.iter().filter(|event| event.starts_with("create:sync-format")).count()
}

#[tokio::test]
async fn a_marker_create_that_finishes_after_sign_out_is_not_remembered() {
    let h = Harness::new();
    h.drive.hide_new(true);
    h.drive.hold(DriveOp::Create, None);
    let generation = h.preflight.sync_format_generation();
    let preflight = Arc::clone(&h.preflight);
    let pass = tokio::spawn(async move { preflight.ensure_sync_format_marker(&[], generation).await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();
    pass.await.unwrap().unwrap();

    assert_eq!(h.preflight.runtime().credentials().sync_format().created_at_ms, None);
    h.drive.take_events();
    let generation = h.preflight.sync_format_generation();
    h.preflight.ensure_sync_format_marker(&[], generation).await.unwrap();
    assert_eq!(creates(&h.drive.take_events()), 1, "the next account gets its own marker");
}

#[tokio::test]
async fn a_marker_listing_that_returns_after_sign_out_is_not_remembered_as_seen() {
    let h = Harness::new();
    h.drive.seed(OWN, &marker_content()).await;
    h.drive.hold(DriveOp::List, Some(Some("sync-format-v")));
    let preflight = Arc::clone(&h.preflight);
    let known = tokio::spawn(async move { preflight.ensure_sync_format_marker_known().await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();
    known.await.unwrap().unwrap();

    assert_eq!(h.preflight.runtime().credentials().sync_format().seen_at_ms, None);
    // An unfiltered listing taken before the sign-out records nothing either.
    let generation = h.preflight.sync_format_generation();
    let listing = h.list_all().await;
    h.preflight.forget_account();
    h.preflight.ensure_sync_format_marker(&listing, generation).await.unwrap();
    assert_eq!(h.preflight.runtime().credentials().sync_format().seen_at_ms, None);
}

#[tokio::test]
async fn refreshes_in_flight_share_one_listing_and_a_clear_drops_their_result() {
    let h = Harness::new();
    h.drive.seed(OWN, &marker_content()).await;
    h.drive.hold(DriveOp::List, None);
    let (a, b) = (Arc::clone(&h.preflight), Arc::clone(&h.preflight));
    let first = tokio::spawn(async move { a.refresh_sync_format_status().await });
    let second = tokio::spawn(async move { b.refresh_sync_format_status().await });
    wait_until(|| h.drive.held() == 1).await;
    tokio::task::yield_now().await;
    h.preflight.clear_sync_format_status();
    h.drive.open_gate();
    assert_eq!((first.await.unwrap(), second.await.unwrap()), (None, None));
    assert_eq!(h.drive.take_events(), ["list:sync-format-v"]);
    assert_eq!(h.preflight.cached_sync_format_status(), None);
    assert_eq!(*h.format_events.lock().unwrap(), []);

    // The next refresh lists again and stores its result.
    let current = SyncFormatStatus {
        required: Some(SYNC_FORMAT_VERSION),
        supported: SYNC_FORMAT_VERSION,
        update_required: false,
    };
    assert_eq!(h.preflight.refresh_sync_format_status().await, Some(current));
    assert_eq!(*h.format_events.lock().unwrap(), [Some(current)]);
}

#[tokio::test]
async fn a_refresh_that_started_before_a_block_does_not_overwrite_it() {
    let h = Harness::new();
    h.drive.hold(DriveOp::List, None);
    let preflight = Arc::clone(&h.preflight);
    let refresh = tokio::spawn(async move { preflight.refresh_sync_format_status().await });
    wait_until(|| h.drive.held() == 1).await;
    let generation = h.preflight.sync_format_generation();
    h.preflight.note_sync_format_update_required(Some(9), generation);
    h.drive.open_gate();

    let blocked =
        SyncFormatStatus { required: Some(9), supported: SYNC_FORMAT_VERSION, update_required: true };
    assert_eq!(refresh.await.unwrap(), Some(blocked));
    assert_eq!(*h.format_events.lock().unwrap(), [Some(blocked)]);
}

#[tokio::test]
async fn a_block_noted_by_a_pass_from_before_sign_out_is_ignored() {
    let h = Harness::new();
    let generation = h.preflight.sync_format_generation();
    h.preflight.forget_account();
    h.preflight.note_sync_format_update_required(Some(9), generation);
    assert_eq!(h.preflight.cached_sync_format_status(), None);
    // The clear itself reported nothing: the status was already unknown.
    assert_eq!(*h.format_events.lock().unwrap(), []);
}

#[tokio::test]
async fn a_blocked_pass_reports_the_reason_as_its_last_progress() {
    let h = Harness::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    h.preflight.runtime().progress().set(move |progress| sink.lock().unwrap().push(progress.clone()));
    h.preflight.emit_sync_blocked(SyncDirection::Upload, SyncBlockReason::BlockedLocal);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].direction, seen[0].status), (SyncDirection::Upload, SyncStatus::Error));
    assert_eq!(seen[0].message.as_deref(), Some("sync.passwordChange.blockedLocal"));
}

#[tokio::test]
async fn the_password_change_operations_check_only_the_format() {
    let h = Harness::new();
    h.local_state(Some("{}"));
    h.drive.seed("password-change-lock.json", "{}").await;
    assert_eq!(h.preflight.sync_block(None).await.unwrap(), Some(SyncBlockReason::BlockedLocal));
    h.preflight.assert_sync_format_supported(None).await.unwrap();
    let listing = h.list_all().await;
    h.preflight.assert_sync_format_supported(Some((&listing, 0))).await.unwrap();
    h.drive.seed("sync-format-v3.json", "{}").await;
    assert_eq!(
        h.preflight.assert_sync_format_supported(None).await,
        Err(PreflightError::Blocked(SyncBlockReason::UpdateRequired))
    );
}

#[tokio::test]
async fn a_replace_whose_store_fails_keeps_no_validation() {
    let h = Harness::new();
    h.passwords.set(Stored::Readable("old".into()));
    h.drive.seed_password_check("new").await;
    // A key store that goes away after the check: the store fails.
    let preflight = Arc::clone(&h.preflight);
    let passwords = Arc::clone(&h.passwords);
    h.drive.hold(DriveOp::List, None);
    let replace = tokio::spawn(async move { preflight.replace_password_and_validate("new").await });
    wait_until(|| h.drive.held() == 1).await;
    passwords.set(Stored::KeystoreUnavailable);
    h.drive.open_gate();
    let result = replace.await.unwrap();

    assert_eq!(result, Err(PreflightError::Other("OS keychain encryption is not available".into())));
    assert_eq!(h.validated(), None);
}

#[tokio::test]
async fn an_answer_that_is_not_json_fails_and_json_that_is_not_an_envelope_does_not_open() {
    let h = Harness::new();
    h.drive.seed("password-check.enc", "not json").await;
    let listing = h.list_all().await;
    let err = h.preflight.validate_password_check("pw", &listing, 0).await.unwrap_err();
    assert!(matches!(err, PreflightError::Other(_)), "{err:?}");

    let h = Harness::new();
    h.drive.seed("password-check.enc", "{}").await;
    let listing = h.list_all().await;
    assert_eq!(
        h.preflight.validate_password_check("pw", &listing, 0).await,
        Err(PreflightError::PasswordMismatch)
    );
}

#[tokio::test]
async fn the_credentials_need_the_sign_in_then_the_password() {
    let h = Harness::new();
    h.passwords.set(Stored::Readable("pw".into()));
    assert_eq!(h.preflight.require_sync_credentials().await.unwrap().as_str(), "pw");
    h.sign_in.0.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        h.preflight.require_sync_credentials().await.err(),
        Some(pipette_sync_runtime::SyncCredentialFailureReason::Unauthenticated)
    );
    assert_eq!(
        PreflightError::Credential(pipette_sync_runtime::SyncCredentialFailureReason::Unauthenticated)
            .to_string(),
        "sync.changePasswordError.unauthenticated"
    );
}

fn password_check_creates(events: &[String]) -> usize {
    events.iter().filter(|event| *event == "create:password-check.enc").count()
}

fn password_checks_on_drive(h: &Harness) -> usize {
    h.drive.names().iter().filter(|name| *name == "password-check.enc").count()
}

#[tokio::test]
async fn a_sign_in_change_before_the_upload_sends_no_password_check() {
    let h = Harness::new();
    let generation = h.preflight.sync_format_generation();
    // The creation lists the markers before it encrypts and uploads.
    h.drive.hold(DriveOp::List, Some(Some("sync-format-v")));
    let preflight = Arc::clone(&h.preflight);
    let validate =
        tokio::spawn(async move { preflight.validate_password_check("pw", &[], generation).await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();

    assert_eq!(validate.await.unwrap(), Err(PreflightError::AccountChanged));
    assert_eq!(password_check_creates(&h.drive.take_events()), 0);
    assert_eq!(password_checks_on_drive(&h), 0);
    assert_eq!(h.validated(), None);
}

#[tokio::test]
async fn a_password_check_uploaded_across_a_sign_in_change_is_deleted_and_not_remembered() {
    let h = Harness::new();
    h.drive.seed(OWN, &marker_content()).await;
    let generation = h.preflight.sync_format_generation();
    h.drive.hold(DriveOp::Create, None);
    let preflight = Arc::clone(&h.preflight);
    let validate =
        tokio::spawn(async move { preflight.validate_password_check("pw", &[], generation).await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();

    assert_eq!(validate.await.unwrap(), Err(PreflightError::AccountChanged));
    let events = h.drive.take_events();
    assert_eq!(password_check_creates(&events), 1);
    assert!(events.iter().any(|event| event.starts_with("delete:")), "{events:?}");
    assert_eq!(password_checks_on_drive(&h), 0);
    assert_eq!(h.validated(), None);

    // The next account's first validation creates its own password-check.
    let generation = h.preflight.sync_format_generation();
    h.preflight.validate_password_check("pw", &[], generation).await.unwrap();
    assert_eq!(password_check_creates(&h.drive.take_events()), 1);
    assert_eq!(password_checks_on_drive(&h), 1);
}

#[tokio::test]
async fn a_set_across_a_sign_in_change_creates_nothing_and_keeps_no_password() {
    let h = Harness::new();
    h.drive.hold(DriveOp::List, Some(None));
    let preflight = Arc::clone(&h.preflight);
    let set = tokio::spawn(async move { preflight.set_password_and_validate("pw").await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();

    assert_eq!(set.await.unwrap(), Err(PreflightError::AccountChanged));
    assert_eq!(password_checks_on_drive(&h), 0);
    assert_eq!(h.passwords.get(), Stored::None);
}

#[tokio::test]
async fn a_validation_after_a_finished_creation_opens_it_instead_of_creating_another() {
    let h = Harness::new();
    h.drive.seed(OWN, &marker_content()).await;
    let generation = h.preflight.sync_format_generation();
    h.drive.hold(DriveOp::Create, None);
    let (a, b) = (Arc::clone(&h.preflight), Arc::clone(&h.preflight));
    let first = tokio::spawn(async move { a.validate_password_check("pw", &[], generation).await });
    wait_until(|| h.drive.held() == 1).await;
    // Arrives while the creation is in flight or once it ended: it joins
    // the run or opens the created file, and never creates another.
    let joined = tokio::spawn(async move { b.validate_password_check("pw", &[], generation).await });
    tokio::task::yield_now().await;
    h.drive.open_gate();
    first.await.unwrap().unwrap();
    joined.await.unwrap().unwrap();
    // After the run ended, a listing that lags opens the created file.
    assert_eq!(
        h.preflight.validate_password_check("other", &[], generation).await,
        Err(PreflightError::PasswordMismatch)
    );
    let events = h.drive.take_events();
    assert_eq!(password_check_creates(&events), 1, "{events:?}");
    assert_eq!(password_checks_on_drive(&h), 1);
}

#[tokio::test]
async fn sets_at_once_store_and_create_only_the_first_password() {
    let h = Harness::new();
    h.drive.seed(OWN, &marker_content()).await;
    // Both would list Drive after finding no stored password.
    h.drive.hold(DriveOp::List, Some(None));
    let (a, b) = (Arc::clone(&h.preflight), Arc::clone(&h.preflight));
    let first = tokio::spawn(async move { a.set_password_and_validate("a").await });
    wait_until(|| h.drive.held() == 1).await;
    let second = tokio::spawn(async move { b.set_password_and_validate("b").await });
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(h.drive.held(), 1, "the second set waits before it reads the stored password");
    h.drive.open_gate();

    assert_eq!(first.await.unwrap(), Ok(()));
    assert_eq!(second.await.unwrap(), Err(PreflightError::PasswordAlreadySet));
    assert_eq!(password_check_creates(&h.drive.take_events()), 1);
    assert_eq!(password_checks_on_drive(&h), 1);
    assert_eq!(h.passwords.get(), Stored::Readable("a".into()));
}

#[tokio::test]
async fn a_replace_validated_before_a_sign_in_change_stores_nothing() {
    let h = Harness::new();
    h.passwords.set(Stored::Readable("old".into()));
    h.drive.seed_password_check("new").await;
    h.drive.hold(DriveOp::List, Some(None));
    let preflight = Arc::clone(&h.preflight);
    let replace = tokio::spawn(async move { preflight.replace_password_and_validate("new").await });
    wait_until(|| h.drive.held() == 1).await;
    h.preflight.forget_account();
    h.drive.open_gate();

    assert_eq!(replace.await.unwrap(), Err(PreflightError::AccountChanged));
    assert_eq!(h.passwords.get(), Stored::Readable("old".into()));
    assert_eq!(h.validated(), None);
}

#[test]
fn a_clear_during_a_reported_block_is_reported_after_it_and_wins() {
    use std::sync::mpsc;

    let h = Harness::new();
    let (entered_tx, entered) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(Some(released));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    // The first report waits inside the listener until released, then
    // records; the later ones record at once.
    h.preflight.set_sync_format_status_listener(move |status| {
        if let Some(released) = released.lock().unwrap().take() {
            entered_tx.send(()).unwrap();
            released.recv().unwrap();
        }
        sink.lock().unwrap().push(status);
    });
    let generation = h.preflight.sync_format_generation();
    let blocking = Arc::clone(&h.preflight);
    let block = std::thread::spawn(move || blocking.note_sync_format_update_required(Some(9), generation));
    entered.recv().unwrap();
    let clearing = Arc::clone(&h.preflight);
    let clear = std::thread::spawn(move || clearing.forget_account());
    // A block noted by a pass of the previous account records nothing.
    let late = Arc::clone(&h.preflight);
    let stale = std::thread::spawn(move || late.note_sync_format_update_required(Some(9), generation));
    release.send(()).unwrap();
    block.join().unwrap();
    clear.join().unwrap();
    stale.join().unwrap();

    let blocked =
        SyncFormatStatus { required: Some(9), supported: SYNC_FORMAT_VERSION, update_required: true };
    let events = events.lock().unwrap();
    assert_eq!(events.first(), Some(&Some(blocked)));
    assert_eq!(events.last(), Some(&None), "{events:?}");
    assert_eq!(h.preflight.cached_sync_format_status(), None);
}
