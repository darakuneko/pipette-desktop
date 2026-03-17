# ボタンパターンガイド

新しいモーダル・ダイアログを作成する際のボタン配置・スタイル・ラベルの規約。

---

## ボタンスタイル

### モーダルフッターボタン

| 種別 | クラス |
|------|--------|
| プライマリ | `rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50` |
| セカンダリ | `rounded border border-edge px-4 py-2 text-sm hover:bg-surface-dim` |
| ConfirmButton | デフォルト: `rounded border px-4 py-2 text-sm` + 状態クラス (`ConfirmButton.tsx`) |

### ボタンラベル

| ラベル | 翻訳キー | 用途 |
|--------|---------|------|
| **Save** | `common.save` | プライマリアクション（デバイスへの保存、データの確定） |
| **Cancel** | `common.cancel` | モーダルを閉じる（変更破棄） |
| **Revert** | `common.revert` | 編集内容を元に戻す（モーダルは閉じない） |
| **Clear** | `common.clear` | 全内容をクリアする（モーダルは閉じない） |
| **Close** | `common.close` | ×ボタンの aria-label のみ（テキストボタンとしては未使用） |

---

## 配置パターン

### パターン A: 右寄せアクション

全ボタンを右寄せ。エントリ編集モーダルの標準パターン。

```tsx
<div className="flex justify-end gap-2">
  <ConfirmButton labelKey="common.clear" ... />
  <ConfirmButton labelKey="common.revert" ... />
  <button className="rounded bg-accent ...">{t('common.save')}</button>
</div>
```

使用例: KeycodeEntryModalShell, MacroEditor, MacroTextEditor

### パターン B: 左右分離

左側に補助アクション、右側にメインアクション。

```tsx
<div className="flex items-center">
  <button>{t('layoutStore.export')}</button>       {/* 左側 */}
  <div className="ml-auto flex gap-2">
    <button>{t('common.cancel')}</button>           {/* 右側 */}
    <button className="bg-accent">{t('common.save')}</button>
  </div>
</div>
```

使用例: JsonEditorModal

### パターン C: フォーム送信

入力フィールド + 送信ボタン。上書き時は ConfirmButton パターンに切り替わる。

```tsx
<form onSubmit={handleSubmit} className="flex gap-2">
  <input
    type="text"
    value={label}
    onChange={(e) => setLabel(e.target.value)}
    maxLength={200}
    className="flex-1 rounded border border-edge bg-surface px-3 py-2 text-sm"
  />
  {confirmOverwrite ? (
    <>
      <button type="submit" className="rounded bg-danger px-4 py-2 text-sm text-white">
        {t('xxx.confirmOverwrite')}
      </button>
      <button type="button" onClick={cancelOverwrite} className="rounded border border-edge px-4 py-2 text-sm">
        {t('common.cancel')}
      </button>
    </>
  ) : (
    <button type="submit" disabled={!label.trim()} className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50">
      {t('common.save')}
    </button>
  )}
</form>
```

使用例: LayoutStoreContent (Save), FavoriteStoreContent (Save)

---

## ヘッダー

### パターン D: タイトル + 閉じるボタン

全モーダル共通。左にタイトル、右に `ModalCloseButton`。

```tsx
<div className="flex items-center justify-between">
  <h3 className="text-lg font-semibold">{title}</h3>
  <ModalCloseButton testid="xxx-close" onClick={onClose} />
</div>
```

---

## 確認フロー

### ConfirmButton (同一スロット)

ボタンのラベルだけ変わる。**元に戻す系アクション向け** (Clear, Revert, Reset)。

```tsx
<ConfirmButton
  testId="xxx-clear"
  confirming={clearAction.confirming}
  onClick={() => clearAction.trigger()}
  labelKey="common.clear"
  confirmLabelKey="common.confirmClear"
/>
```

- 通常時: `border-edge hover:bg-surface-dim`
- 確認時: `border-danger text-danger hover:bg-danger/10`

### インライン状態切替 (ボタン入替)

Confirm + Cancel の2ボタンに変わる。**破壊的アクション向け** (Delete, Reset, Overwrite)。

```tsx
{confirming ? (
  <>
    <button className="bg-danger ...">{t('common.confirmDelete')}</button>
    <button>{t('common.cancel')}</button>
  </>
) : (
  <button>{t('common.delete')}</button>
)}
```

---

## 既存のボタンスタイル定数

### モーダルフッター用 (editors)

| 定数名 | 定義場所 | クラス |
|--------|---------|--------|
| `EXPORT_BTN` | store-modal-shared | フォーマット選択ボタン (`text-[11px]`) |
| `IMPORT_BTN` | store-modal-shared | インポートボタン |

### エントリ行用 (store-modal-shared.tsx)

| 定数名 | クラス |
|--------|--------|
| `ACTION_BTN` | `text-xs font-medium text-content bg-transparent border-none px-2 py-1 rounded` |
| `DELETE_BTN` | `text-xs font-medium text-danger bg-transparent border-none px-2 py-1 rounded` |
| `CONFIRM_DELETE_BTN` | `text-xs font-medium text-danger hover:bg-danger/10 px-2 py-1 rounded bg-transparent border-none` |

### 設定モーダル用 (settings-modal-shared.ts)

| 定数名 | クラス |
|--------|--------|
| `BTN_PRIMARY` | `rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50` |
| `BTN_SECONDARY` | `rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50` |
| `BTN_DANGER_OUTLINE` | `rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50` |

### Hub 用

| 定数名 | 定義場所 | クラス |
|--------|---------|--------|
| `HUB_BTN` | FavoriteHubActions / layout-store-types | `text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded` |

---

## 既存モーダル一覧

### フッターボタン

| コンポーネント | パターン | ボタン (左→右) |
|--------------|---------|--------------|
| KeycodeEntryModalShell | A (右寄せ) | Clear, Revert, **Save** |
| MacroEditor | A (右寄せ) | Clear, Revert, **Save** |
| MacroTextEditor | A (右寄せ) | Cancel, **Save** |
| JsonEditorModal | B (左右分離) | Export \| Cancel, **Save** |
| QmkSettings | A (右寄せ) | Reset, Revert, **Save** |
| RGBConfigurator | A (右寄せ) | Revert, **Save** |
| LayoutStoreContent (Save) | C (フォーム) | テキスト入力 + **Save** |
| FavoriteStoreContent (Save) | C (フォーム) | テキスト入力 + **Save** |
| FavoriteStoreContent (Footer) | A (右寄せ) | Import, Export All |

### 設定モーダル内コンテンツ

| コンポーネント | ボタン | 定数 |
|--------------|--------|------|
| LocalDataResetGroup | Delete Selected → Confirm + Cancel | BTN_DANGER_OUTLINE, BTN_SECONDARY |
| SyncDataResetSection | Delete Selected → Confirm + Cancel | BTN_DANGER_OUTLINE, BTN_SECONDARY |
| DisconnectConfirmButton | Disconnect → Confirm + Cancel | BTN_DANGER_OUTLINE, BTN_SECONDARY |
| PasswordSection | Set Password, Cancel | インライン (`px-4 py-1.5`) |
| HubDisplayNameField | Save | BTN_PRIMARY |
| DataModal (Application) | Import, Export | SETTINGS_BTN_SECONDARY |

### ヘッダーのみ (フッターボタンなし)

SettingsModal, FavoriteStoreModal, QmkSettingsModal, MacroModal, EditorSettingsModal, LayoutStoreModal, NotificationModal

### インライン行ボタン

| コンポーネント | 通常時 | 確認時 |
|--------------|--------|--------|
| LayoutStoreContent (Entry) | Load, Delete | Confirm Delete, Cancel |
| FavoriteStoreContent (Entry) | Load, Delete, Export | Confirm Delete, Cancel |
| FavoriteTabContent (Entry) | Delete | Confirm Delete, Cancel |
| KeyboardSavesContent | Delete All | Confirm Delete, Cancel |
| HubPostRow | Open, Delete | Confirm Delete, Cancel |
| LanguageSelectorModal | Download or Delete アイコン | — |
| FavoriteHubActions | Upload/Update/Remove | Confirm Remove, Cancel |
