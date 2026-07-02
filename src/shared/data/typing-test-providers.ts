// SPDX-License-Identifier: GPL-2.0-or-later
//
// Bundled default typing-test word datasets, one entry per provider.
// These are the fallback values shipped with the app; the Hub
// (`GET /api/typing-test/datasets/:provider`) can override version /
// downloadUrlBase / languages at runtime when the upstream source moves.
//
// To support another provider, add an entry here with its own manifest —
// the rest of the pipeline (language store, Hub sync) is provider-agnostic.
//
// NOTE: for monkeytype the commit hash appears in BOTH `version` and
// `downloadUrlBase`. Bump them together (mirrors the Hub-side note), which
// is why the commit is a single constant interpolated into both.

import type { LanguageManifestEntry, TypingTestProviderDefault } from '../types/language-store'
import monkeytypeLanguages from './language-manifest.json'

const MONKEYTYPE_COMMIT = '629c82e112a2db2122c789dc6abe970b82c3f8c5'

/** Provider used by the typing test today. */
export const DEFAULT_TYPING_TEST_PROVIDER = 'monkeytype'

export const TYPING_TEST_PROVIDER_DEFAULTS: readonly TypingTestProviderDefault[] = [
  {
    provider: 'monkeytype',
    version: MONKEYTYPE_COMMIT,
    downloadUrlBase: `https://github.com/monkeytypegame/monkeytype/raw/${MONKEYTYPE_COMMIT}/frontend/static/languages`,
    bundledLanguages: ['english'],
    languages: monkeytypeLanguages as LanguageManifestEntry[],
  },
  // Tatoeba is a Hub-only provider: no data ships with the app. The bundled
  // default is an empty placeholder — version, downloadUrlBase and the
  // language list are all supplied by the Hub override at runtime
  // (`GET /api/typing-test/datasets/tatoeba`). With an empty bundled version,
  // the first version check always reports an update so packs are fetched to
  // install. `bundledLanguages` is empty because nothing is baked in.
  {
    provider: 'tatoeba',
    version: '',
    downloadUrlBase: '',
    bundledLanguages: [],
    languages: [],
  },
  // Aozora is a Hub-only catalog provider (see typing-test-datasets.ts on the
  // Hub side): each language entry is a whole downloadable work rather than a
  // sampled word/sentence pack, so `model: 'catalog'` is baked into the
  // placeholder itself — resolveProvider() must never fall through to the
  // pack-shaped monkeytype default for this provider. Otherwise mirrors the
  // tatoeba placeholder: nothing ships with the app, everything comes from
  // the Hub override at runtime.
  {
    provider: 'aozora',
    version: '',
    downloadUrlBase: '',
    model: 'catalog',
    bundledLanguages: [],
    languages: [],
  },
]

export function getProviderDefault(provider: string): TypingTestProviderDefault | undefined {
  return TYPING_TEST_PROVIDER_DEFAULTS.find((p) => p.provider === provider)
}
