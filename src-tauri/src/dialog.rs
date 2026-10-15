// SPDX-License-Identifier: GPL-2.0-or-later
//! The native file dialogs of the file commands (file_commands.rs). A command
//! describes its dialog in a [`DialogRequest`] and gets back the path the
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogKind {
    /// Choose where to save a file, starting with `default_name`.
    SaveFile { default_name: String },
    /// Choose an existing file.
    OpenFile,
    /// Choose a directory; the dialog can create one.
    OpenFolder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub title: String,
    pub filters: Vec<FileFilter>,
}

/// Shows a file dialog and returns the chosen path, or `None` when the user
/// cancels it. Called on a blocking-task thread, never on the main thread.
pub trait DialogProvider: Send + Sync {
    fn show(&self, request: DialogRequest) -> Option<PathBuf>;
}

impl<F: Fn(DialogRequest) -> Option<PathBuf> + Send + Sync> DialogProvider for F {
    fn show(&self, request: DialogRequest) -> Option<PathBuf> {
        self(request)
    }
}

/// The provider the file commands ask, as managed state.
#[derive(Clone)]
pub struct Dialogs(Arc<dyn DialogProvider>);

impl Dialogs {
    pub fn new(provider: impl DialogProvider + 'static) -> Self {
        Self(Arc::new(provider))
    }

    pub fn show(&self, request: DialogRequest) -> Option<PathBuf> {
        self.0.show(request)
    }
}

/// The system's file dialogs (the GTK file chooser on Linux), parented to
/// the main window, shown the way tauri-plugin-dialog shows them: built on
/// the main thread and awaited on a thread of their own.
pub struct SystemDialogs {
    app: AppHandle<Wry>,
}

type PendingChoice = Pin<Box<dyn Future<Output = Option<rfd::FileHandle>> + Send>>;

impl SystemDialogs {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

impl DialogProvider for SystemDialogs {
    fn show(&self, request: DialogRequest) -> Option<PathBuf> {
        let (chosen, choice) = std::sync::mpsc::channel();
        let app = self.app.clone();
        let scheduled = self.app.run_on_main_thread(move || {
            let mut dialog =
                rfd::AsyncFileDialog::new().set_title(&request.title).set_can_create_directories(true);
            for filter in &request.filters {
                dialog = dialog.add_filter(&filter.name, &filter.extensions);
            }
            if let Some(window) = crate::main_window::main_window(&app) {
                dialog = dialog.set_parent(&window);
            }
            let pending: PendingChoice = match request.kind {
                DialogKind::SaveFile { default_name } => {
                    Box::pin(dialog.set_file_name(default_name).save_file())
                }
                DialogKind::OpenFile => Box::pin(dialog.pick_file()),
                DialogKind::OpenFolder => Box::pin(dialog.pick_folder()),
            };
            std::thread::spawn(move || {
                let path = tauri::async_runtime::block_on(pending).map(|handle| handle.path().to_path_buf());
                // The receiver only goes away if the command was dropped.
                let _ = chosen.send(path);
            });
        });
        if let Err(err) = scheduled {
            log::error!("failed to show a file dialog: {err}");
            return None;
        }
        choice.recv().ok().flatten()
    }
}
