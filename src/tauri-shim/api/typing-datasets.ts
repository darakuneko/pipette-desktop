// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Typing Test word lists and their datasets for
// the Tauri build (src-tauri/src/typing_dataset_commands.rs). None of them
// waits for another: the Electron handlers take no lock either. The word
// list entries and a word list cross as JSON text the backend writes, so
// their fields keep the order of the files they come from.

import type { LanguageListEntry } from '../../shared/types/language-store'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { LanguageActionResult } from '../generated/LanguageActionResult'
import type { TypingDatasetCheckResult } from '../generated/TypingDatasetCheckResult'

type DatasetUpdateResult = Awaited<ReturnType<VialAPI['updateTypingDataset']>>

export const typingDatasetsApi = {
  langList: (provider) => call<LanguageListEntry[]>('lang_list', { provider }),
  langGet: (name, provider) => call<unknown>('lang_get', { name, provider }),
  langDownload: (name, provider) => call<LanguageActionResult>('lang_download', { name, provider }),
  langDelete: (name, provider) => call<LanguageActionResult>('lang_delete', { name, provider }),
  checkTypingDatasetUpdate: (provider) => call<TypingDatasetCheckResult>('typing_dataset_check', { provider }),
  updateTypingDataset: (provider) => call<DatasetUpdateResult>('typing_dataset_update', { provider }),
} satisfies Partial<VialAPI>
