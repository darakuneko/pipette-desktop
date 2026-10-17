// SPDX-License-Identifier: GPL-2.0-or-later
//! The automatic tidying of names with several copies (trash::tidy), the
//! cases of src/main/sync/__tests__/sync-trash.test.ts on a Drive whose
//! files the test names and dates itself.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::retry::{RetryEnv, SleepFuture};
use pipette_drive::trash_names::{TRASH_QUARANTINE_MS, trash_file_name};
use pipette_drive::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_sync::trash::tidy::{TRASH_NAMES_PER_PASS, Tidy, TidyContext};
use pipette_sync_runtime::SyncRuntime;

const DAY: i64 = 24 * 60 * 60 * 1000;
/// 2026-10-09T00:00:00.000Z.
const NOW: i64 = 1_791_504_000_000;
const OWN: &str = "hash-own";
const DATE: &str = "2026-10-01T00:00:00.000Z";

struct NoWaits;

impl RetryEnv for NoWaits {
    fn is_quitting(&self) -> bool {
        false
    }

    fn now_ms(&self) -> i64 {
        0
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn sleep(&self, _: Duration) -> SleepFuture<'_> {
        Box::pin(std::future::ready(()))
    }
}

/// Files by id, changed by renames and deletes as Drive would, so a test
/// can run several passes on fresh listings.
#[derive(Default)]
struct MapDrive {
    files: Mutex<BTreeMap<String, DriveFile>>,
    /// Renames of this id fail with a 503.
    failing_rename: Mutex<Option<String>>,
    renames: Mutex<Vec<(String, String)>>,
    deletes: Mutex<Vec<String>>,
    lists: Mutex<usize>,
}

fn ready<'a, T: Send + 'a>(value: Result<T, DriveError>) -> DriveFuture<'a, T> {
    Box::pin(std::future::ready(value))
}

fn unused<'a, T: Send + 'a>() -> DriveFuture<'a, T> {
    ready(Err(DriveError::Network("not used by the tidying".into())))
}

impl DriveApi for MapDrive {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        *self.lists.lock().unwrap() += 1;
        let files = self
            .files
            .lock()
            .unwrap()
            .values()
            .filter(|f| query.name_contains.as_ref().is_none_or(|n| f.name.contains(n.as_str())))
            .cloned()
            .collect();
        ready(Ok(FileList { files, next_page_token: None }))
    }

    fn download(&self, _: String) -> DriveFuture<'_, Vec<u8>> {
        unused()
    }

    fn create(&self, _: String, _: String) -> DriveFuture<'_, UploadedFile> {
        unused()
    }

    fn create_raw(&self, _: String, _: String) -> DriveFuture<'_, String> {
        unused()
    }

    fn update(&self, _: String, _: String) -> DriveFuture<'_, UploadedFile> {
        unused()
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        if self.failing_rename.lock().unwrap().as_deref() == Some(id.as_str()) {
            return ready(Err(DriveError::Status { status: 503, body: String::new(), retry_after: None }));
        }
        self.renames.lock().unwrap().push((id.clone(), name.clone()));
        let mut files = self.files.lock().unwrap();
        ready(match files.get_mut(&id) {
            Some(file) => {
                file.name = name;
                Ok(file.clone())
            }
            None => Err(DriveError::Status { status: 404, body: String::new(), retry_after: None }),
        })
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.deletes.lock().unwrap().push(id.clone());
        self.files.lock().unwrap().remove(&id);
        ready(Ok(()))
    }
}

struct World {
    drive: Arc<MapDrive>,
    client: DriveClient,
    runtime: SyncRuntime,
    local: HashSet<String>,
}

impl World {
    fn new() -> Self {
        let drive = Arc::new(MapDrive::default());
        let client = DriveClient::new(drive.clone(), Arc::new(NoWaits));
        Self { drive, client, runtime: SyncRuntime::new(), local: ["uid1".to_owned()].into() }
    }

    fn add(&self, id: &str, name: &str, modified_time: &str) {
        let file = DriveFile {
            id: id.into(),
            name: name.into(),
            modified_time: modified_time.into(),
            created_time: None,
        };
        self.drive.files.lock().unwrap().insert(id.into(), file);
    }

    /// A trash file of `name` renamed at `renamed_at_ms`.
    fn add_trash(&self, id: &str, name: &str, renamed_at_ms: i64, modified_time: &str) {
        self.add(id, &trash_of(id, name, modified_time, renamed_at_ms), modified_time);
    }

    fn listing(&self) -> Listing {
        Listing::new(self.drive.files.lock().unwrap().values().cloned().collect())
    }

    fn names(&self) -> BTreeMap<String, String> {
        self.drive.files.lock().unwrap().iter().map(|(id, f)| (id.clone(), f.name.clone())).collect()
    }

    fn name_of(&self, id: &str) -> Option<String> {
        self.drive.files.lock().unwrap().get(id).map(|f| f.name.clone())
    }

    fn renamed_ids(&self) -> Vec<String> {
        self.drive.renames.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
    }

    async fn tidy_on(&self, listing: &Listing) {
        let ctx = TidyContext { local_keyboard_uids: &self.local, own_hash: OWN, now_ms: NOW };
        Tidy { drive: &self.client, runtime: &self.runtime }.tidy_duplicate_copies(listing, &ctx).await;
    }

    async fn tidy(&self) {
        let listing = self.listing();
        self.tidy_on(&listing).await;
    }
}

fn trash_of(id: &str, name: &str, modified_time: &str, renamed_at_ms: i64) -> String {
    let file = DriveFile {
        id: id.into(),
        name: name.into(),
        modified_time: modified_time.into(),
        created_time: None,
    };
    trash_file_name(&file, renamed_at_ms).unwrap()
}

fn ms(time: &str) -> i64 {
    pipette_time::parse_date_time_string(time).unwrap()
}

#[tokio::test]
async fn renames_every_copy_but_the_chosen_one() {
    let w = World::new();
    w.add("old", "favorites_macro.enc", "2026-10-01T00:00:00.000Z");
    w.add("new", "favorites_macro.enc", "2026-10-03T00:00:00.000Z");
    w.add("mid", "favorites_macro.enc", "2026-10-02T00:00:00.000Z");
    w.runtime.remote().remember_created_file("favorites_macro.enc", "mid");

    w.tidy().await;

    let old = format!("favorites_macro.enc.trash.{NOW}.{}.old", ms("2026-10-01T00:00:00.000Z"));
    let mid = format!("favorites_macro.enc.trash.{NOW}.{}.mid", ms("2026-10-02T00:00:00.000Z"));
    let want: BTreeMap<String, String> =
        [("old".into(), old), ("new".into(), "favorites_macro.enc".into()), ("mid".into(), mid)].into();
    assert_eq!(w.names(), want);
    assert_eq!(w.runtime.remote().created_file_id("favorites_macro.enc"), None);
}

#[tokio::test]
async fn leaves_a_single_copy_alone() {
    let w = World::new();
    w.add("a", "favorites_macro.enc", DATE);
    w.tidy().await;
    assert!(w.drive.renames.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deletes_trash_kept_for_the_quarantine_while_the_name_has_a_copy() {
    let w = World::new();
    w.add("live", "favorites_macro.enc", DATE);
    w.add_trash("old", "favorites_macro.enc", NOW - TRASH_QUARANTINE_MS, DATE);
    w.add_trash("young", "favorites_macro.enc", NOW - TRASH_QUARANTINE_MS + 1, DATE);

    w.tidy().await;

    assert_eq!(*w.drive.deletes.lock().unwrap(), ["old"]);
    assert!(w.name_of("young").is_some());
    assert!(w.drive.renames.lock().unwrap().is_empty());
}

#[tokio::test]
async fn never_deletes_the_last_copy_and_renames_expired_trash_back() {
    let w = World::new();
    w.add_trash("old", "favorites_macro.enc", NOW - 40 * DAY, DATE);
    w.tidy().await;
    assert!(w.drive.deletes.lock().unwrap().is_empty());
    assert_eq!(w.name_of("old").unwrap(), "favorites_macro.enc");
}

#[tokio::test]
async fn renames_the_trash_with_the_newest_content_back() {
    let w = World::new();
    w.add_trash("older", "favorites_macro.enc", NOW - DAY, "2026-10-01T00:00:00.000Z");
    w.add_trash("newer", "favorites_macro.enc", NOW - 2 * DAY, "2026-10-02T00:00:00.000Z");

    w.tidy().await;

    assert_eq!(*w.drive.renames.lock().unwrap(), [("newer".to_owned(), "favorites_macro.enc".to_owned())]);
    assert!(w.name_of("older").unwrap().contains(".trash."));
}

#[tokio::test]
async fn never_renames_this_machines_own_day_back() {
    let w = World::new();
    w.add_trash("t", &format!("keyboards_uid1_devices_{OWN}_days_2026-10-01.enc"), NOW - DAY, DATE);
    w.tidy().await;
    assert!(w.drive.renames.lock().unwrap().is_empty());
}

#[tokio::test]
async fn two_machines_that_renamed_each_others_copy_away_converge() {
    let w = World::new();
    w.add_trash("a", "favorites_macro.enc", NOW, "2026-10-02T00:00:00.000Z");
    w.add_trash("b", "favorites_macro.enc", NOW, "2026-10-01T00:00:00.000Z");

    w.tidy().await;
    w.tidy().await;

    assert_eq!(w.name_of("a").unwrap(), "favorites_macro.enc");
    assert!(w.name_of("b").unwrap().contains(".trash."));
}

#[tokio::test]
async fn an_expired_delete_meeting_the_copy_renamed_away_keeps_the_trash() {
    let w = World::new();
    w.add("live", "favorites_macro.enc", "2026-10-02T00:00:00.000Z");
    w.add_trash("expired", "favorites_macro.enc", NOW - 31 * DAY, DATE);
    let first = w.listing();
    // Another machine renames the only copy away right after our listing.
    w.add(
        "live",
        &trash_of("live", "favorites_macro.enc", "2026-10-02T00:00:00.000Z", NOW),
        "2026-10-02T00:00:00.000Z",
    );

    w.tidy_on(&first).await;
    assert!(w.drive.deletes.lock().unwrap().is_empty());

    w.tidy().await;
    assert_eq!(w.name_of("live").unwrap(), "favorites_macro.enc");
    assert!(w.name_of("expired").is_some());
}

#[tokio::test]
async fn keeps_trash_another_machine_renamed_back_after_our_listing() {
    let w = World::new();
    w.add("live", "favorites_macro.enc", DATE);
    w.add_trash("expired", "favorites_macro.enc", NOW - 31 * DAY, DATE);
    let first = w.listing();
    w.add("live", &trash_of("live", "favorites_macro.enc", DATE, NOW), DATE);
    w.add("expired", "favorites_macro.enc", DATE);

    w.tidy_on(&first).await;

    assert!(w.drive.deletes.lock().unwrap().is_empty());
    assert_eq!(w.name_of("expired").unwrap(), "favorites_macro.enc");
}

#[tokio::test]
async fn lists_by_name_only_when_expired_trash_is_to_be_deleted() {
    let w = World::new();
    w.add("live", "favorites_macro.enc", DATE);
    w.add_trash("young", "favorites_macro.enc", NOW - DAY, DATE);
    w.tidy().await;
    assert_eq!(*w.drive.lists.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_pass_cut_short_after_some_renames_finishes_on_the_next_without_renaming_twice() {
    let w = World::new();
    w.add("keep", "favorites_macro.enc", "2026-10-03T00:00:00.000Z");
    w.add("d1", "favorites_macro.enc", "2026-10-01T00:00:00.000Z");
    w.add("d2", "favorites_macro.enc", "2026-10-02T00:00:00.000Z");
    *w.drive.failing_rename.lock().unwrap() = Some("d2".into());
    w.tidy().await;
    assert!(w.name_of("d1").unwrap().contains(".trash."));
    assert_eq!(w.name_of("d2").unwrap(), "favorites_macro.enc");

    *w.drive.failing_rename.lock().unwrap() = None;
    w.drive.renames.lock().unwrap().clear();
    w.tidy().await;
    w.tidy().await;

    assert_eq!(w.renamed_ids(), ["d2"]);
    assert_eq!(w.name_of("keep").unwrap(), "favorites_macro.enc");
}

#[tokio::test]
async fn a_rename_of_a_file_already_gone_counts_as_done() {
    let w = World::new();
    w.add("keep", "favorites_macro.enc", "2026-10-03T00:00:00.000Z");
    w.add("gone", "favorites_macro.enc", "2026-10-01T00:00:00.000Z");
    let first = w.listing();
    w.drive.files.lock().unwrap().remove("gone");

    w.tidy_on(&first).await;

    assert_eq!(w.names(), [("keep".to_owned(), "favorites_macro.enc".to_owned())].into());
}

#[tokio::test]
async fn leaves_other_keyboards_other_machines_days_and_non_data_names_alone() {
    let w = World::new();
    for (id, name) in [
        ("k1", "keyboards_uid2_settings.enc"),
        ("k2", "keyboards_uid2_settings.enc"),
        ("o1", "keyboards_uid1_devices_hash-other_days_2026-10-01.enc"),
        ("o2", "keyboards_uid1_devices_hash-other_days_2026-10-01.enc"),
        ("p1", "password-check.enc"),
        ("p2", "password-check.enc"),
        ("u1", "unknown.enc"),
        ("u2", "unknown.enc"),
        ("x1", "favorites_..enc"),
        ("x2", "favorites_..enc"),
    ] {
        w.add(id, name, DATE);
    }
    w.add_trash("ot", "keyboards_uid1_devices_hash-other_deleted-ranges.enc", NOW - DAY, DATE);

    w.tidy().await;

    // Only the other machine's deleted ranges: any machine writes to them.
    assert_eq!(
        *w.drive.renames.lock().unwrap(),
        [("ot".to_owned(), "keyboards_uid1_devices_hash-other_deleted-ranges.enc".to_owned())]
    );
}

#[tokio::test]
async fn tidies_own_days_except_while_an_analytics_sync_of_the_keyboard_runs() {
    let w = World::new();
    let day = format!("keyboards_uid1_devices_{OWN}_days_2026-10-01.enc");
    w.add("d1", &day, "2026-10-01T00:00:00.000Z");
    w.add("d2", &day, "2026-10-02T00:00:00.000Z");
    let writer = w.runtime.try_start_analytics_sync("uid1").unwrap();

    w.tidy().await;
    assert!(w.drive.renames.lock().unwrap().is_empty());

    drop(writer);
    w.tidy().await;
    assert_eq!(w.renamed_ids(), ["d1"]);
}

#[tokio::test]
async fn tidies_at_most_five_names_per_pass_and_stops_when_quitting() {
    let w = World::new();
    for i in 0..TRASH_NAMES_PER_PASS + 2 {
        w.add(&format!("a{i}"), &format!("favorites_t{i}.enc"), "2026-10-01T00:00:00.000Z");
        w.add(&format!("b{i}"), &format!("favorites_t{i}.enc"), "2026-10-02T00:00:00.000Z");
    }

    w.tidy().await;
    assert_eq!(w.drive.renames.lock().unwrap().len(), TRASH_NAMES_PER_PASS);

    w.runtime.set_quitting();
    w.tidy().await;
    assert_eq!(w.drive.renames.lock().unwrap().len(), TRASH_NAMES_PER_PASS);
}
