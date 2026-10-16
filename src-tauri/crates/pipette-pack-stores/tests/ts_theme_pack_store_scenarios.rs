// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the theme pack scenarios recorded from the real handlers of
//! src/main/theme-pack-ipc.ts (scripts/pack-store-fixtures/
//! record-theme-pack-store-fixtures.test.ts) through the handlers of this
//! crate (common/replay.rs).
//!
//! A pack that fails the page's check (`validateThemePack`) never reaches
//! the backend: its step answers what the shim answers, `INVALID_FILE`
//! with the check's errors, which must be the handler's answer. A step
//! whose handler broadcasts `theme-pack:changed` is one whose command
//! sends the event: a successful rename, reorder, delete, Hub link or
//! import.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use common::replay::{answer_outcome, export_choice, export_outcome, raw_of, replay};
use pipette_js_json::{Object, Value};
use pipette_pack_stores::theme_handlers as handlers;
use pipette_pack_stores::{ErrorCode, PackError};

#[test]
fn the_theme_pack_handlers_answer_and_write_as_the_typescript_ones() {
    replay("ts_theme_pack_store_scenarios.json", &mut |h, op, step, effects| {
        let user_data = h.user_data().to_path_buf();
        let arg = |key: &str| step.get(key);
        let ctx = &h.ctx;
        let changing = match op {
            "list" => return answer_outcome(handlers::list(ctx), &user_data),
            "get" => return answer_outcome(handlers::get(ctx, arg("id")), &user_data),
            "hasName" => {
                return answer_outcome(handlers::has_name(ctx, arg("name"), arg("excludeId")), &user_data);
            }
            "rename" => handlers::rename(ctx, arg("id"), arg("name")),
            "reorder" => handlers::reorder(ctx, arg("ids")),
            "delete" => handlers::delete(ctx, arg("id")),
            "hubPostId" => handlers::set_hub_post_id(
                ctx,
                arg("id"),
                arg("hubPostId"),
                arg("uploaderName"),
                arg("hubUpdatedAt"),
            ),
            "importApply" => match arg("pageError") {
                Some(Value::String(error)) => {
                    return answer_outcome(
                        Err(PackError::new(ErrorCode::InvalidFile, error.to_string_lossy())),
                        &user_data,
                    );
                }
                _ => {
                    let raw = raw_of(arg("raw").unwrap().as_object().unwrap(), &user_data);
                    // The preload passes `options ?? {}`.
                    let options = arg("options").cloned().unwrap_or_else(|| Value::Object(Object::new()));
                    handlers::import_apply(ctx, raw.as_ref(), Some(&options))
                }
            },
            "export" => {
                let chosen = export_choice(step, &user_data);
                let exported = handlers::export(ctx, arg("id"), |name| {
                    effects.default_path = name.into();
                    chosen
                });
                return export_outcome(exported, &user_data);
            }
            other => panic!("unknown step {other}"),
        };
        effects.changed = changing.changed();
        answer_outcome(changing.0, &user_data)
    });
}
