// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded language pack scenarios through the handlers of
//! this crate (common/replay.rs).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use common::replay::{answer_outcome, export_choice, export_outcome, raw_of, replay};
use pipette_js_json::{Object, Value};
use pipette_pack_stores::i18n_handlers as handlers;

#[test]
fn the_language_pack_handlers_answer_and_write_as_recorded() {
    replay("ts_i18n_pack_store_scenarios.json", &mut |h, op, step, effects| {
        let user_data = h.user_data().to_path_buf();
        let arg = |key: &str| step.get(key);
        let ctx = &h.ctx;
        let answer = match op {
            "list" => handlers::list(ctx),
            "get" => handlers::get(ctx, arg("id")),
            "hasName" => handlers::has_name(ctx, arg("name"), arg("excludeId")),
            "rename" => handlers::rename(ctx, arg("id"), arg("name")),
            "setEnabled" => handlers::set_enabled(ctx, arg("id"), arg("enabled")),
            "refreshCoverage" => handlers::refresh_coverage(ctx, arg("id"), arg("values")),
            "reorder" => handlers::reorder(ctx, arg("ids")),
            "delete" => handlers::delete(ctx, arg("id")),
            "hubPostId" => handlers::set_hub_post_id(
                ctx,
                arg("id"),
                arg("hubPostId"),
                arg("uploaderName"),
                arg("hubUpdatedAt"),
            ),
            "importApply" => {
                let raw = raw_of(arg("raw").unwrap().as_object().unwrap(), &user_data);
                // The preload passes `options ?? {}`.
                let options = arg("options").cloned().unwrap_or_else(|| Value::Object(Object::new()));
                handlers::import_apply(ctx, raw.as_ref(), Some(&options))
            }
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
        answer_outcome(answer, &user_data)
    });
}
