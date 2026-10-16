// SPDX-License-Identifier: GPL-2.0-or-later
//! The native file dialogs of the file commands (file_commands.rs) and of the
//! favorite export and import (store_commands/favorites.rs). A command
//! describes its dialog in a [`DialogRequest`] and gets back the paths the
//! user chose; the page never names a path itself. Which provider answers is
//! managed state ([`Dialogs`]): the system's dialogs in the app
//! ([`SystemDialogs`]), a queue in front of them in builds with the
//! development tools (dev_commands/tools.rs), and scripted answers in the
//! tests.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{AppHandle, Wry};

/// A filter of the dialog's file list, as Electron's `FileFilter`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

impl FileFilter {
    pub fn new(name: &str, extensions: &[&str]) -> Self {
        Self { name: name.to_owned(), extensions: extensions.iter().map(|&ext| ext.to_owned()).collect() }
    }

    /// The `All Files` filter every dialog of the Electron main process ends
    /// its list with.
    pub fn all_files() -> Self {
        Self::new("All Files", &["*"])
    }

    /// Whether the filter lets every file through: Electron's `*` extension.
    fn matches_any_file(&self) -> bool {
        self.extensions.iter().any(|ext| ext == "*")
    }
}

/// The filters to hand to rfd: none when every filter lets every file
/// through. rfd turns the `*` extension into the pattern `*.*`, which hides
/// the files without an extension that Electron's `*` shows; a list of
/// `*` filters alone (the typing test text import's) filters nothing, so
/// leaving it out shows every file, as Electron does. A list that also has
/// a real filter keeps its `All Files` as `*.*`.
fn native_filters(filters: &[FileFilter]) -> &[FileFilter] {
    if filters.iter().all(FileFilter::matches_any_file) { &[] } else { filters }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogKind {
    /// Choose where to save a file, starting with `default_name`.
    SaveFile { default_name: String },
    /// Choose an existing file.
    OpenFile,
    /// Choose one or more existing files (Electron's `multiSelections`).
    OpenMany,
    /// Choose a directory; the dialog can create one.
    OpenFolder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub title: String,
    pub filters: Vec<FileFilter>,
}

/// Shows a file dialog and returns the chosen paths, none when the user
/// cancels it: one at most, except for [`DialogKind::OpenMany`]. Called on a
/// blocking-task thread, never on the main thread.
pub trait DialogProvider: Send + Sync {
    fn show(&self, request: DialogRequest) -> Vec<PathBuf>;
}

/// A closure answers with an `Option<PathBuf>` for a dialog of one path or
/// a `Vec<PathBuf>`.
impl<F, R> DialogProvider for F
where
    F: Fn(DialogRequest) -> R + Send + Sync,
    R: IntoIterator<Item = PathBuf>,
{
    fn show(&self, request: DialogRequest) -> Vec<PathBuf> {
        self(request).into_iter().collect()
    }
}

/// The provider the file commands ask, as managed state.
#[derive(Clone)]
pub struct Dialogs(Arc<dyn DialogProvider>);

impl Dialogs {
    pub fn new(provider: impl DialogProvider + 'static) -> Self {
        Self(Arc::new(provider))
    }

    /// The path chosen in a dialog of one path, `None` when cancelled.
    pub fn show(&self, request: DialogRequest) -> Option<PathBuf> {
        debug_assert!(request.kind != DialogKind::OpenMany, "an OpenMany dialog goes through show_many");
        let paths = self.0.show(request);
        debug_assert!(paths.len() <= 1, "a dialog of one path answered {paths:?}");
        paths.into_iter().next()
    }

    /// The paths chosen in a [`DialogKind::OpenMany`] dialog, none when
    /// cancelled.
    pub fn show_many(&self, request: DialogRequest) -> Vec<PathBuf> {
        debug_assert!(request.kind == DialogKind::OpenMany, "show_many shows OpenMany dialogs only");
        self.0.show(request)
    }
}

/// The system's file dialogs (the GTK file chooser on Linux), shown the way
/// tauri-plugin-dialog shows them: built on the main thread and awaited on a
/// thread of their own. They are parented to the main window on Windows and
/// macOS; rfd's GTK backend opens them without a parent, so on Linux the
/// main window stays usable while one is open.
pub struct SystemDialogs {
    app: AppHandle<Wry>,
}

type PendingChoice = Pin<Box<dyn Future<Output = Vec<PathBuf>> + Send>>;

impl SystemDialogs {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

impl DialogProvider for SystemDialogs {
    fn show(&self, request: DialogRequest) -> Vec<PathBuf> {
        let (chosen, choice) = std::sync::mpsc::channel();
        let app = self.app.clone();
        let scheduled = self.app.run_on_main_thread(move || {
            let mut dialog =
                rfd::AsyncFileDialog::new().set_title(&request.title).set_can_create_directories(true);
            for filter in native_filters(&request.filters) {
                dialog = dialog.add_filter(&filter.name, &filter.extensions);
            }
            if let Some(window) = crate::main_window::main_window(&app) {
                dialog = dialog.set_parent(&window);
            }
            let pending: PendingChoice = match request.kind {
                DialogKind::SaveFile { default_name } => {
                    let save = dialog.set_file_name(default_name).save_file();
                    Box::pin(async move { paths(save.await) })
                }
                DialogKind::OpenFile => {
                    let pick = dialog.pick_file();
                    Box::pin(async move { paths(pick.await) })
                }
                DialogKind::OpenMany => {
                    let pick = dialog.pick_files();
                    Box::pin(async move { paths(pick.await.into_iter().flatten()) })
                }
                DialogKind::OpenFolder => {
                    let pick = dialog.pick_folder();
                    Box::pin(async move { paths(pick.await) })
                }
            };
            std::thread::spawn(move || {
                let paths = tauri::async_runtime::block_on(pending);
                // The receiver only goes away if the command was dropped.
                let _ = chosen.send(paths);
            });
        });
        if let Err(err) = scheduled {
            log::error!("failed to show a file dialog: {err}");
            return Vec::new();
        }
        choice.recv().unwrap_or_default()
    }
}

fn paths(handles: impl IntoIterator<Item = rfd::FileHandle>) -> Vec<PathBuf> {
    handles.into_iter().map(|handle| handle.path().to_path_buf()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: DialogKind) -> DialogRequest {
        DialogRequest { kind, title: "Import".to_owned(), filters: Vec::new() }
    }

    #[test]
    fn a_filter_list_of_any_file_filters_alone_reaches_rfd_as_no_filter() {
        let text = [FileFilter::new("UTF-8 text", &["*"])];
        assert!(native_filters(&text).is_empty());
        assert!(native_filters(&[FileFilter::all_files()]).is_empty());
        assert!(native_filters(&[]).is_empty());

        let json = [FileFilter::new("JSON", &["json"]), FileFilter::all_files()];
        assert_eq!(native_filters(&json), json);
    }

    fn answering(paths: &'static [&'static str]) -> Dialogs {
        Dialogs::new(move |_: DialogRequest| paths.iter().map(PathBuf::from).collect::<Vec<_>>())
    }

    #[test]
    fn a_dialog_of_one_path_takes_its_answer_and_open_many_takes_all() {
        assert_eq!(
            answering(&["/one.json"]).show(request(DialogKind::OpenFile)),
            Some(PathBuf::from("/one.json"))
        );
        assert_eq!(
            answering(&["/a.json", "/b.json"]).show_many(request(DialogKind::OpenMany)),
            [PathBuf::from("/a.json"), PathBuf::from("/b.json")]
        );
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "a dialog of one path answered"))]
    fn a_dialog_of_one_path_answered_with_more_is_a_bug() {
        let chosen = answering(&["/one.json", "/two.json"]).show(request(DialogKind::OpenFile));
        assert_eq!(chosen, Some(PathBuf::from("/one.json")));
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "goes through show_many"))]
    fn show_refuses_open_many_dialogs() {
        answering(&[]).show(request(DialogKind::OpenMany));
    }

    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "OpenMany dialogs only"))]
    fn show_many_refuses_dialogs_of_one_path() {
        answering(&[]).show_many(request(DialogKind::OpenFile));
    }

    #[test]
    fn no_answer_is_a_cancel() {
        let dialogs = Dialogs::new(|_: DialogRequest| None);
        assert_eq!(dialogs.show(request(DialogKind::OpenFile)), None);
        assert!(dialogs.show_many(request(DialogKind::OpenMany)).is_empty());
    }
}
