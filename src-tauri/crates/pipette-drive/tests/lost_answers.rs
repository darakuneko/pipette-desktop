// SPDX-License-Identifier: GPL-2.0-or-later
//! An upload whose answer is lost (it times out or the connection drops
//! after Drive did the work) fails here although Drive has the new
//! content. The caller records no revision for a failed upload, so the
//! next pass sees the revision as a change of another machine and merges
//! it, which changes nothing; a lost create is not resent, and the create
//! of the next pass leaves a second copy of the name, which the choice of
//! one copy and the trash then settle.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::TestEnv;
use pipette_drive::DriveError;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::fake::{DriveOp, InMemoryDrive, LOST_ANSWER};

fn client(drive: &Arc<InMemoryDrive>) -> (DriveClient, Arc<TestEnv>) {
    let env = TestEnv::new(0, 0.0);
    (DriveClient::new(Arc::clone(drive) as _, env.clone()), env)
}

#[tokio::test]
async fn a_lost_update_is_resent_and_lands_once() {
    let drive = Arc::new(InMemoryDrive::new());
    let (client, env) = client(&drive);
    let first = client.upload_file("a.enc", "v1", None, false).await.unwrap();
    drive.lose_answers(DriveOp::Update, 1);

    let second = client.upload_file("a.enc", "v2", Some(&first.id), false).await.unwrap();

    assert_eq!(env.sleeps().len(), 1);
    assert_eq!(second.id, first.id);
    let files = drive.files();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].content, b"v2");
    // The answer is the revision of the resent update, the one Drive keeps.
    assert_eq!(files[0].file.modified_time, second.modified_time);
}

#[tokio::test]
async fn an_update_whose_every_answer_is_lost_fails_although_drive_has_it() {
    let drive = Arc::new(InMemoryDrive::new());
    let (client, _) = client(&drive);
    let first = client.upload_file("a.enc", "v1", None, false).await.unwrap();
    drive.lose_answers(DriveOp::Update, 5);

    let err = client.upload_file("a.enc", "v2", Some(&first.id), false).await.unwrap_err();

    assert_eq!(err.error, DriveError::Network(LOST_ANSWER.into()));
    // The next pass lists a revision it never recorded: a change to merge.
    let listing = client.list_files(None).await.unwrap();
    assert_eq!(listing.len(), 1);
    assert_ne!(listing[0].modified_time, first.modified_time);
    assert_eq!(client.download(&first.id).await.unwrap(), b"v2");
}

#[tokio::test]
async fn a_lost_create_is_not_resent_and_the_next_create_leaves_a_copy_to_settle() {
    let drive = Arc::new(InMemoryDrive::new());
    let (client, env) = client(&drive);
    drive.lose_answers(DriveOp::Create, 1);

    let err = client.upload_file("favorites_macro.enc", "v1", None, false).await.unwrap_err();
    assert_eq!(err.error, DriveError::Network(LOST_ANSWER.into()));
    assert!(env.sleeps().is_empty());
    assert_eq!(drive.files().len(), 1);

    // The next pass does not know the file and creates it again.
    let second = client.upload_file("favorites_macro.enc", "v2", None, false).await.unwrap();
    let listing = Listing::new(client.list_files(None).await.unwrap());
    assert_eq!(listing.duplicated_names(), ["favorites_macro.enc"]);
    assert_eq!(listing.pick_canonical("favorites_macro.enc").unwrap().id, second.id);

    let extras: Vec<_> = listing
        .files_named("favorites_macro.enc")
        .into_iter()
        .filter(|file| file.id != second.id)
        .cloned()
        .collect();
    let moved = client.move_files_to_trash(&extras, 1_800_000_000_000, &|_| {}).await;
    assert_eq!((moved.attempted, moved.failed), (1, 0));
    let listing = Listing::new(client.list_files(None).await.unwrap());
    assert!(listing.duplicated_names().is_empty());
    assert_eq!(listing.pick_canonical("favorites_macro.enc").unwrap().id, second.id);
    assert_eq!(listing.trash_copies_of("favorites_macro.enc").len(), 1);
}

#[tokio::test]
async fn a_lost_raw_create_is_not_resent() {
    let drive = Arc::new(InMemoryDrive::new());
    let (client, _) = client(&drive);
    drive.lose_answers(DriveOp::Create, 1);
    assert!(client.create_raw_file("password-change-lock.json", "{}").await.is_err());
    assert_eq!(drive.files().len(), 1);
}
