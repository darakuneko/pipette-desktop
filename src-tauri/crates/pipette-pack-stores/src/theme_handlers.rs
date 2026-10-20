// SPDX-License-Identifier: GPL-2.0-or-later
//! The theme pack handlers: each checks its arguments, then runs the store
//! operation and answers its `data`. An argument is a JSON value, `None`
//! for `undefined`.
//!
//! The handlers whose success is broadcast as `theme-pack:changed`
//! (rename, reorder, delete, the Hub link and the import) answer a
//! [`Changing`], which tells the commands to send that event.

use std::path::PathBuf;

use pipette_keyboard_stores::StoreContext;

pub use crate::handlers::{Answer, Arg};
use crate::handlers::{ExportName, caught, entries, id_arg, name_arg, options_arg, ordered_ids_arg, string};
use crate::pack_store::Field;
use crate::theme::{self, Cached, SaveThemeInput};

/// The answer of a handler whose success the pages hear of as
/// `theme-pack:changed`, the page that asked included.
#[derive(Debug, PartialEq)]
pub struct Changing(pub Answer);

impl Changing {
    /// Whether the change event follows the answer.
    pub fn changed(&self) -> bool {
        self.0.is_ok()
    }
}

/// The `theme_pack_store_list` command: the live metas.
pub fn list(ctx: &StoreContext) -> Answer {
    Ok(Some(entries(theme::list_metas(ctx).map_err(caught)?)))
}

/// The `theme_pack_store_has_name` command.
pub fn has_name(ctx: &StoreContext, name: Arg<'_>, exclude_id: Arg<'_>) -> Answer {
    let exists = theme::has_active_name(ctx, name_arg(name)?, string(exclude_id)).map_err(caught)?;
    Ok(Some(exists.into()))
}

/// The `theme_pack_store_get` command: `{meta, pack}`. Every failure past the id check
/// answers with the error of [`theme::get_pack`].
pub fn get(ctx: &StoreContext, id: Arg<'_>) -> Answer {
    Ok(Some(theme::get_pack(ctx, id_arg(id)?)?.into()))
}

/// The `theme_pack_store_rename` command.
pub fn rename(ctx: &StoreContext, id: Arg<'_>, new_name: Arg<'_>) -> Changing {
    let renamed = id_arg(id).and_then(|id| theme::rename_pack(ctx, id, name_arg(new_name)?));
    Changing(renamed.map(|meta| Some(meta.into())))
}

/// The `theme_pack_store_reorder` command.
pub fn reorder(ctx: &StoreContext, ordered_ids: Arg<'_>) -> Changing {
    Changing(ordered_ids_arg(ordered_ids).and_then(|ids| theme::reorder_active(ctx, &ids)).map(|()| None))
}

/// The `theme_pack_store_delete` command.
pub fn delete(ctx: &StoreContext, id: Arg<'_>) -> Changing {
    Changing(id_arg(id).and_then(|id| theme::delete_pack(ctx, id)).map(|()| None))
}

/// The `theme_pack_store_set_hub_post_id` command: a post id that is not a string
/// unlinks; an uploader name or Hub time that is not a string is left alone.
pub fn set_hub_post_id(
    ctx: &StoreContext,
    id: Arg<'_>,
    hub_post_id: Arg<'_>,
    uploader_name: Arg<'_>,
    hub_updated_at: Arg<'_>,
) -> Changing {
    let cached = |arg: Arg<'_>| string(arg).map_or(Cached::Keep, |value| Cached::Set(Some(value.clone())));
    let linked = id_arg(id).and_then(|id| {
        theme::set_hub_post_id(ctx, id, string(hub_post_id), cached(uploader_name), cached(hub_updated_at))
    });
    Changing(linked.map(|meta| Some(meta.into())))
}

/// The `theme_pack_import_apply` command: checks and saves the pack `raw`, with
/// the string options of `options` (anything else in it is ignored).
pub fn import_apply(ctx: &StoreContext, raw: Arg<'_>, options: Arg<'_>) -> Changing {
    let opts = options_arg(options);
    let text = |key: &str| string(opts.get(key)).cloned();
    let text_field = |key: &str| text(key).map_or(Field::Inherit, Field::Set);
    let input = SaveThemeInput {
        id: text("id"),
        pack: raw.cloned(),
        hub_post_id: text_field("hubPostId"),
        hub_updated_at: text_field("hubUpdatedAt"),
        uploader_name: text_field("uploaderName"),
    };
    Changing(theme::save_pack(ctx, input).map(|meta| Some(meta.into())))
}

/// The `theme_pack_export` command: writes the live pack `id` where `choose` answers,
/// given the default file name (`theme-packs-{safe name}.json`); `None`
/// cancels. `Err` is the error the handler throws (see
/// [`crate::handlers`]).
pub fn export(
    ctx: &StoreContext,
    id: Arg<'_>,
    choose: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Answer, String> {
    let id = match id_arg(id) {
        Ok(id) => id,
        Err(err) => return Ok(Err(err)),
    };
    let file = ExportName { prefix: "theme-packs", fallback: "theme-pack" };
    crate::handlers::export(theme::export_text(ctx, id), &file, choose)
}
