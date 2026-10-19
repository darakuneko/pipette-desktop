// SPDX-License-Identifier: GPL-2.0-or-later
//! The macOS application menu: the app menu (About, Hide, Hide Others, Show
//! All, Quit) and an Edit menu (Undo, Redo, Cut, Copy, Paste, Select All).
//! The Electron build sets no menu; this one gives macOS its standard
//! shortcuts, which the WebView's text fields need for ⌘C / ⌘V / ⌘Z, and ⌘Q.
//! Windows and Linux get no menu.
//!
//! Every item except Quit is a predefined item: AppKit sends its action
//! (`hide:`, `copy:`, `undo:` …) to the first responder or the application.
//! The predefined Quit sends `terminate:`, which tao's app delegate answers
//! without an exit request (it has no `applicationShouldTerminate:`), so it
//! would take the path of the Dock's Quit in src/lifecycle.rs. Quit is
//! therefore an item of its own with ⌘Q that requests the exit as the tray's
//! Quit does ([`crate::lifecycle::request_quit`]).
//!
//! The labels are English, as the tray's are; the predefined items carry
//! English titles too.
//!
//! A ⌘ shortcut reaches the page before the menu: a page keydown handler
//! that calls `preventDefault` keeps the menu item from running. The keymap
//! editor's ⌘Z / ⌘⇧Z (`use-keymap-history-actions.ts`) does so outside text
//! fields, so the menu's Undo / Redo run only for text fields, where that
//! handler steps aside.

/// The id of the app menu's Quit item.
pub const QUIT: &str = "app-menu-quit";

/// The shortcut of the app menu's Quit item.
const QUIT_ACCELERATOR: &str = "Cmd+Q";

/// One entry of the menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    About,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Separator,
}

/// The title of a submenu: the app menu, which macOS titles with the app's
/// name whatever it is given, or a fixed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Title {
    App,
    Fixed(&'static str),
}

/// The submenus, in order, with their entries.
const MENU: [(Title, &[Entry]); 2] = [
    (
        Title::App,
        &[
            Entry::About,
            Entry::Separator,
            Entry::Hide,
            Entry::HideOthers,
            Entry::ShowAll,
            Entry::Separator,
            Entry::Quit,
        ],
    ),
    (
        Title::Fixed("Edit"),
        &[
            Entry::Undo,
            Entry::Redo,
            Entry::Separator,
            Entry::Cut,
            Entry::Copy,
            Entry::Paste,
            Entry::SelectAll,
        ],
    ),
];

/// The label an entry gets, or `None` for the predefined item's own. The
/// entries that name the app get its name, so they read the same in a build
/// that is not bundled, where macOS would name the executable.
fn label(entry: Entry, app_name: &str) -> Option<String> {
    match entry {
        Entry::About => Some(format!("About {app_name}")),
        Entry::Hide => Some(format!("Hide {app_name}")),
        Entry::Quit => Some(format!("Quit {app_name}")),
        _ => None,
    }
}

/// Builds the menu and sets it as the application's menu, and handles its
/// Quit. Called from the app's setup hook, on the main thread; a failure is
/// logged and leaves the app without a menu.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::App<tauri::Wry>) {
    let result = build(app.handle()).and_then(|menu| app.set_menu(menu));
    if let Err(err) = result {
        log::error!("failed to set the application menu: {err}");
        return;
    }
    app.on_menu_event(|app, event| {
        if event.id() == QUIT {
            crate::lifecycle::request_quit(app);
        }
    });
}

#[cfg(target_os = "macos")]
fn build(app: &tauri::AppHandle<tauri::Wry>) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};

    let app_name = app.package_info().name.clone();
    let menu = Menu::new(app)?;
    for (title, entries) in MENU {
        let title = match title {
            Title::App => app_name.as_str(),
            Title::Fixed(title) => title,
        };
        let submenu = Submenu::new(app, title, true)?;
        for &entry in entries {
            let text = label(entry, &app_name);
            let text = text.as_deref();
            let item = match entry {
                Entry::Quit => MenuItemKind::MenuItem(MenuItem::with_id(
                    app,
                    QUIT,
                    text.unwrap_or_default(),
                    true,
                    Some(QUIT_ACCELERATOR),
                )?),
                Entry::About => MenuItemKind::Predefined(PredefinedMenuItem::about(app, text, None)?),
                Entry::Hide => MenuItemKind::Predefined(PredefinedMenuItem::hide(app, text)?),
                Entry::HideOthers => MenuItemKind::Predefined(PredefinedMenuItem::hide_others(app, text)?),
                Entry::ShowAll => MenuItemKind::Predefined(PredefinedMenuItem::show_all(app, text)?),
                Entry::Undo => MenuItemKind::Predefined(PredefinedMenuItem::undo(app, text)?),
                Entry::Redo => MenuItemKind::Predefined(PredefinedMenuItem::redo(app, text)?),
                Entry::Cut => MenuItemKind::Predefined(PredefinedMenuItem::cut(app, text)?),
                Entry::Copy => MenuItemKind::Predefined(PredefinedMenuItem::copy(app, text)?),
                Entry::Paste => MenuItemKind::Predefined(PredefinedMenuItem::paste(app, text)?),
                Entry::SelectAll => MenuItemKind::Predefined(PredefinedMenuItem::select_all(app, text)?),
                Entry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
            };
            submenu.append(&item)?;
        }
        menu.append(&submenu)?;
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use muda::accelerator::{Accelerator, Code, Modifiers};

    use super::*;

    #[test]
    fn the_app_menu_holds_about_hide_and_quit_and_the_edit_menu_the_editing_commands() {
        assert_eq!(
            MENU,
            [
                (
                    Title::App,
                    &[
                        Entry::About,
                        Entry::Separator,
                        Entry::Hide,
                        Entry::HideOthers,
                        Entry::ShowAll,
                        Entry::Separator,
                        Entry::Quit,
                    ][..],
                ),
                (
                    Title::Fixed("Edit"),
                    &[
                        Entry::Undo,
                        Entry::Redo,
                        Entry::Separator,
                        Entry::Cut,
                        Entry::Copy,
                        Entry::Paste,
                        Entry::SelectAll,
                    ][..],
                ),
            ]
        );
    }

    #[test]
    fn the_entries_naming_the_app_carry_its_name() {
        assert_eq!(label(Entry::About, "Pipette").as_deref(), Some("About Pipette"));
        assert_eq!(label(Entry::Hide, "Pipette").as_deref(), Some("Hide Pipette"));
        assert_eq!(label(Entry::Quit, "Pipette").as_deref(), Some("Quit Pipette"));
        for entry in [Entry::HideOthers, Entry::ShowAll, Entry::Undo, Entry::Copy, Entry::Separator] {
            assert_eq!(label(entry, "Pipette"), None);
        }
    }

    #[test]
    fn quit_is_command_q() {
        // Tauri drops an accelerator it cannot parse without an error.
        let accelerator: Accelerator = QUIT_ACCELERATOR.parse().expect("the Quit shortcut parses");
        assert_eq!(accelerator, Accelerator::new(Modifiers::META, Code::KeyQ));
    }

    #[test]
    fn there_is_one_quit_and_its_id_is_not_the_trays() {
        // Every menu handler sees every menu event: with the tray's id, one
        // click would request the exit twice, and the second request ends
        // the app without waiting for the quit sequence.
        let quits =
            MENU.iter().flat_map(|(_, entries)| entries.iter()).filter(|e| **e == Entry::Quit).count();
        assert_eq!(quits, 1);
        assert_ne!(QUIT, crate::tray::QUIT_ITEM);
    }
}
