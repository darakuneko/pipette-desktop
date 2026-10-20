// SPDX-License-Identifier: GPL-2.0-or-later
//! The language pack handlers: each checks its arguments, then runs the store operation and answers
//! its `data`. An argument is a JSON value, `None` for `undefined`.

use std::path::PathBuf;

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;

pub use crate::handlers::{Answer, Arg};
use crate::handlers::{ExportName, caught, entries, id_arg, name_arg, options_arg, ordered_ids_arg, string};
use crate::i18n::{self, Cached, CoverageValues, SavePackInput};
use crate::pack_store::Field;
use crate::result::{ErrorCode, PackError};

/// The `i18n_pack_store_list` command: the live metas.
pub fn list(ctx: &StoreContext) -> Answer {
    Ok(Some(entries(i18n::list_metas(ctx).map_err(caught)?)))
}

/// The `i18n_pack_store_has_name` command.
pub fn has_name(ctx: &StoreContext, name: Arg<'_>, exclude_id: Arg<'_>) -> Answer {
    let name = name_arg(name)?;
    let exists = i18n::has_active_name(ctx, name, string(exclude_id)).map_err(caught)?;
    Ok(Some(exists.into()))
}

/// The `i18n_pack_store_get` command: `{meta, pack}`.
pub fn get(ctx: &StoreContext, id: Arg<'_>) -> Answer {
    Ok(Some(i18n::get_pack(ctx, id_arg(id)?)?.into()))
}

/// The `i18n_pack_store_rename` command.
pub fn rename(ctx: &StoreContext, id: Arg<'_>, new_name: Arg<'_>) -> Answer {
    let id = id_arg(id)?;
    let new_name = name_arg(new_name)?;
    Ok(Some(i18n::rename_pack(ctx, id, new_name)?.into()))
}

/// The `i18n_pack_store_set_enabled` command.
pub fn set_enabled(ctx: &StoreContext, id: Arg<'_>, enabled: Arg<'_>) -> Answer {
    let id = id_arg(id)?;
    let Some(&Value::Bool(enabled)) = enabled else {
        return Err(PackError::new(ErrorCode::InvalidFile, "enabled must be boolean"));
    };
    Ok(Some(i18n::set_enabled(ctx, id, enabled)?.into()))
}

fn object(arg: Arg<'_>) -> Option<&Object> {
    match arg {
        Some(Value::Object(object)) => Some(object),
        _ => None,
    }
}

/// The `i18n_pack_store_refresh_coverage` command.
pub fn refresh_coverage(ctx: &StoreContext, id: Arg<'_>, values: Arg<'_>) -> Answer {
    let id = id_arg(id)?;
    let field = |object: Option<&Object>, key: &str| object.and_then(|object| object.get(key)).cloned();
    let values = object(values);
    let coverage = field(values, "coverage");
    let coverage = object(coverage.as_ref());
    let checked = match (
        field(values, "matchedBaseVersion"),
        field(coverage, "totalKeys"),
        field(coverage, "coveredKeys"),
        field(values, "measuredBodyClock"),
    ) {
        (
            Some(Value::String(base)),
            Some(Value::Number(total)),
            Some(Value::Number(covered)),
            Some(Value::String(clock)),
        ) => CoverageValues {
            matched_base_version: base,
            total_keys: total,
            covered_keys: covered,
            measured_body_clock: clock,
        },
        _ => return Err(PackError::new(ErrorCode::InvalidFile, "Invalid coverage")),
    };
    Ok(Some(i18n::refresh_coverage(ctx, id, checked)?.into()))
}

/// The `i18n_pack_store_reorder` command.
pub fn reorder(ctx: &StoreContext, ordered_ids: Arg<'_>) -> Answer {
    i18n::reorder_active(ctx, &ordered_ids_arg(ordered_ids)?)?;
    Ok(None)
}

/// The `i18n_pack_store_delete` command.
pub fn delete(ctx: &StoreContext, id: Arg<'_>) -> Answer {
    i18n::delete_pack(ctx, id_arg(id)?)?;
    Ok(None)
}

/// The `i18n_pack_store_set_hub_post_id` command: a post id that is not a string
/// unlinks; an uploader name or Hub time that is not a string is left alone.
pub fn set_hub_post_id(
    ctx: &StoreContext,
    id: Arg<'_>,
    hub_post_id: Arg<'_>,
    uploader_name: Arg<'_>,
    hub_updated_at: Arg<'_>,
) -> Answer {
    let id = id_arg(id)?;
    let cached = |arg: Arg<'_>| string(arg).map_or(Cached::Keep, |value| Cached::Set(Some(value.clone())));
    let meta =
        i18n::set_hub_post_id(ctx, id, string(hub_post_id), cached(uploader_name), cached(hub_updated_at))?;
    Ok(Some(meta.into()))
}

/// The options of the `i18n_pack_import_apply` command as the handler reads them.
fn save_input(raw: Arg<'_>, options: Arg<'_>) -> SavePackInput {
    let opts = options_arg(options);
    let text = |key: &str| string(opts.get(key)).cloned();
    let text_field = |key: &str| text(key).map_or(Field::Inherit, Field::Set);
    let matched_base_version = match opts.get("matchedBaseVersion") {
        Some(Value::Null) => Field::Clear,
        Some(Value::String(s)) => Field::Set(s.clone()),
        _ => Field::Inherit,
    };
    let coverage = match opts.get("coverage") {
        Some(Value::Null) => Field::Clear,
        Some(Value::Object(c)) => match (c.get("totalKeys"), c.get("coveredKeys")) {
            (Some(total @ Value::Number(_)), Some(covered @ Value::Number(_))) => {
                let mut coverage = Object::new();
                coverage.insert("totalKeys", total.clone());
                coverage.insert("coveredKeys", covered.clone());
                Field::Set(coverage)
            }
            _ => Field::Inherit,
        },
        _ => Field::Inherit,
    };
    let dangerous_key_count = match opts.get("dangerousKeyCount") {
        Some(Value::Null) => Field::Clear,
        Some(Value::Number(n)) => Field::Set(*n),
        _ => Field::Inherit,
    };
    SavePackInput {
        id: text("id"),
        pack: raw.cloned(),
        enabled: Some(!matches!(opts.get("enabled"), Some(Value::Bool(false)))),
        hub_post_id: text_field("hubPostId"),
        hub_updated_at: text_field("hubUpdatedAt"),
        uploader_name: text_field("uploaderName"),
        app_version_at_import: text("appVersionAtImport"),
        matched_base_version,
        coverage,
        dangerous_key_count,
        unattended: false,
    }
}

/// The `i18n_pack_import_apply` command: saves the pack `raw` the page checked.
pub fn import_apply(ctx: &StoreContext, raw: Arg<'_>, options: Arg<'_>) -> Answer {
    Ok(Some(i18n::save_pack(ctx, save_input(raw, options))?.into()))
}

/// The `i18n_pack_export` command: writes the live pack `id` where `choose` answers,
/// given the default file name (`i18n-packs-{safe name}.json`); `None`
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
    let file = ExportName { prefix: "i18n-packs", fallback: "language-pack" };
    crate::handlers::export(i18n::export_text(ctx, id), &file, choose)
}

#[cfg(test)]
mod tests {
    use pipette_js_json::JsString;

    use super::*;

    fn parse(text: &str) -> Value {
        pipette_js_json::parse(text).unwrap()
    }

    #[test]
    fn import_options_read_as_the_handler_reads_them() {
        let options = parse(
            r#"{"enabled":false,"hubPostId":"","uploaderName":5,"id":"x","matchedBaseVersion":null,
                "coverage":{"totalKeys":3,"coveredKeys":"2"},"dangerousKeyCount":0}"#,
        );
        let input = save_input(None, Some(&options));
        assert_eq!(input.enabled, Some(false));
        assert_eq!(input.hub_post_id, Field::Set(JsString::from("")));
        assert_eq!(input.uploader_name, Field::Inherit);
        assert_eq!(input.id, Some(JsString::from("x")));
        assert_eq!(input.matched_base_version, Field::Clear);
        assert_eq!(input.coverage, Field::Inherit);
        assert_eq!(input.dangerous_key_count, Field::Set(0.0));
        assert_eq!(save_input(None, Some(&parse("[]"))).enabled, Some(true));
    }
}
