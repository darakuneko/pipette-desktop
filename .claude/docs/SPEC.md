# Pipette 仕様書

Pipette — Vial GUI (Python/Qt) 互換の TypeScript/Electron アプリケーション仕様

## 1. プロジェクト概要

### 1.1 目的

Vial GUI (Python/Qt) の機能を TypeScript/Electron で再実装し、Vial/VIA 対応キーボードのキーマップ編集・設定変更を行うデスクトップアプリケーションを提供する。

### 1.2 ライセンス

GPL-3.0-or-later

### 1.3 機能概要

- USB HID 経由でのキーボードとの通信
- キーマップの表示・編集 (レイヤー対応)
- 物理レイアウト切替
- マクロの編集・記録
- RGB ライティング設定
- Tap Dance / Combo / Key Override / Alt Repeat Key の設定
- QMK Settings の設定
- マトリクステスター
- ファームウェアフラッシャー (Vial Bootloader 対応)
- レイアウトの保存・復元 (.vil ファイル)

---

## 2. 技術スタック

| 項目 | 技術 |
|---|---|
| Runtime | Electron 40+ |
| Language | TypeScript (ESNext target) |
| Package Manager | pnpm |
| UI Framework | React 19 + Tailwind CSS v4 (renderer プロセス) |
| Build | electron-vite (Vite ベース) |
| USB HID | node-hid (main プロセスから直接アクセス、IPC 経由) |
| テスト | Vitest (unit), Playwright (E2E) |
| リンター | ESLint + Prettier |

#### 補足

- **node-hid**: Node.js ネイティブモジュール `node-hid` を使用。Main プロセスで HID デバイスに直接アクセスする。
  - Usage Page `0xFF60` / Usage `0x61` でフィルタリング
  - シリアル番号を直接取得可能（デバイス分類に使用）
  - ブラウザ権限ダイアログ不要（自動デバイス列挙）
  - NAPI ベースのプレビルドにより、ネイティブコンパイル不要
  - 32 バイトパケット通信は main の `hid-service.ts` で実装 (mutex + retry)
  - Preload は IPC ブリッジとして機能 (`hid-transport.ts` → `ipcRenderer.invoke`)

---

## 3. アーキテクチャ

### 3.1 プロセス構成

```
┌─────────────────────────────────────────────┐
│  Electron Main Process                      │
│  ┌────────────────┐  ┌──────────────────┐   │
│  │ HID Transport  │  │ ファイル I/O      │   │
│  │ (node-hid)     │  │ (.vil 読み書き)   │   │
│  └────────────────┘  └──────────────────┘   │
│  ┌────────────────────────────────────────┐  │
│  │ CSP / Security                         │  │
│  │ (動的CSP設定・ナビゲーション制限)          │  │
│  └────────────────────────────────────────┘  │
├───────────── contextBridge ─────────────────┤
│  Preload Process (sandbox: true)            │
│  ┌────────────────┐  ┌──────────────────┐   │
│  │ IPC Bridge     │  │ VIA/Vial Protocol│   │
│  │ (hid-transport) │  │ (protocol.ts)    │   │
│  └────────────────┘  └──────────────────┘   │
│  ┌────────────────────────────────────────┐  │
│  │ Keyboard State Manager                 │  │
│  │ (keyboard.ts + macro.ts + LZMA)        │  │
│  └────────────────────────────────────────┘  │
├───────────── contextBridge ─────────────────┤
│  Renderer Process (React + Tailwind CSS)    │
│  ┌────────────────┐  ┌──────────────────┐   │
│  │ Keymap Editor  │  │ Macro Editor     │   │
│  │ Layout Editor  │  │ RGB Configurator │   │
│  │ Tap Dance      │  │ Combo Editor     │   │
│  │ Key Override   │  │ Alt Repeat Key   │   │
│  │ QMK Settings   │  │ Matrix Tester    │   │
│  │ Firmware Flash  │  │                  │   │
│  └────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────┘
```

### 3.2 Main Process の責務

- node-hid HID トランスポート (hid-service.ts: デバイス列挙・接続・送受信)
- HID IPC ハンドラ (hid-ipc.ts: preload からの IPC 要求を処理)
- CSP の動的設定 (dev/prod 分離、`onHeadersReceived`)
- ナビゲーション制限 (`will-navigate`, `setWindowOpenHandler`)
- ファイルシステム操作 (.vil ファイル、ファームウェア) — IPC 経由

### 3.3 Preload Process の責務

- IPC ブリッジ (hid-transport.ts: main プロセスの node-hid への IPC 委譲)
- VIA/Vial プロトコルコマンド実装
- キーボード状態管理 (reload シーケンス、マクロ、Dynamic Entries)
- contextBridge 経由で Renderer に API を公開

### 3.4 Renderer Process の責務

- UI の描画と操作 (React + Tailwind CSS)
- キーコード管理・表示
- ユーザー入力の処理
- キーボードウィジェットの描画 (KLE フォーマット)

### 3.5 セキュリティ方針

Electron のセキュリティベストプラクティスに従い、以下の設定を必須とする。

#### BrowserWindow 設定

```typescript
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // preload と renderer のコンテキスト分離
    nodeIntegration: false,      // renderer での Node.js API 無効化
    sandbox: true,               // renderer のサンドボックス化
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

#### Content Security Policy (CSP)

CSP は Main プロセスの `onHeadersReceived` で動的に設定する。

**本番 CSP:**
```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'self'; object-src 'none'
```

**開発 CSP:**
```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:*; base-uri 'self'; object-src 'none'
```

- 本番では `unsafe-eval` および `unsafe-inline` は使用禁止
- 開発時のみ Vite HMR のために `unsafe-inline` と `ws://localhost:*` を許可

#### ファイル操作の制限

- ファームウェアフラッシュ (.vfw)、レイアウト保存/復元 (.vil) 等のファイル操作は Renderer プロセスから直接実行不可
- 全てのファイル操作は Main プロセスの IPC ハンドラ経由で実行する
- Main プロセス側でファイルパスの検証 (パストラバーサル防止) を行う

### 3.6 Preload API (contextBridge)

プロトコル操作は Preload プロセスが実行し、contextBridge 経由で Renderer に公開する。
HID I/O は Main プロセスの node-hid に IPC 経由で委譲する。
ファイル I/O も Main プロセスへ IPC 経由で委譲する。

```typescript
// preload.ts で定義する API
interface VialAPI {
  // デバイス管理
  listDevices(): Promise<DeviceInfo[]>;
  openDevice(path: string): Promise<void>;
  closeDevice(): Promise<void>;

  // プロトコル操作
  getProtocolVersion(): Promise<number>;
  getKeyboardId(): Promise<{ vialProtocol: number; keyboardId: string }>;
  getLayerCount(): Promise<number>;
  getKeymapBuffer(offset: number, size: number): Promise<Uint8Array>;
  setKeycode(layer: number, row: number, col: number, keycode: number): Promise<void>;
  getEncoder(layer: number, index: number): Promise<[number, number]>;
  setEncoder(layer: number, index: number, direction: number, keycode: number): Promise<void>;

  // Vial 固有
  getDefinition(): Promise<KeyboardDefinition>;
  getLayoutOptions(): Promise<number>;
  setLayoutOptions(options: number): Promise<void>;
  getUnlockStatus(): Promise<{ unlocked: boolean; inProgress: boolean; keys: [number, number][] }>;
  unlockStart(): Promise<void>;
  unlockPoll(): Promise<Uint8Array>;
  lock(): Promise<void>;

  // マクロ
  getMacroCount(): Promise<number>;
  getMacroBufferSize(): Promise<number>;
  getMacroBuffer(): Promise<Uint8Array>;
  setMacroBuffer(data: Uint8Array): Promise<void>;

  // ライティング
  getLightingValue(id: number): Promise<Uint8Array>;
  setLightingValue(id: number, ...args: number[]): Promise<void>;
  saveLighting(): Promise<void>;

  // Dynamic Entries
  getDynamicEntryCount(): Promise<DynamicEntryCounts>;
  getTapDance(index: number): Promise<TapDanceEntry>;
  setTapDance(index: number, entry: TapDanceEntry): Promise<void>;
  getCombo(index: number): Promise<ComboEntry>;
  setCombo(index: number, entry: ComboEntry): Promise<void>;
  getKeyOverride(index: number): Promise<KeyOverrideEntry>;
  setKeyOverride(index: number, entry: KeyOverrideEntry): Promise<void>;
  getAltRepeatKey(index: number): Promise<AltRepeatKeyEntry>;
  setAltRepeatKey(index: number, entry: AltRepeatKeyEntry): Promise<void>;

  // QMK Settings
  queryQmkSettings(startId: number): Promise<number[]>;
  getQmkSetting(qsid: number): Promise<Uint8Array>;
  setQmkSetting(qsid: number, data: Uint8Array): Promise<void>;
  resetQmkSettings(): Promise<void>;

  // Matrix Tester
  matrixPoll(): Promise<Uint8Array>;

  // ファイル操作
  saveLayout(data: Uint8Array): Promise<void>;
  loadLayout(): Promise<Uint8Array | null>;
  selectFirmwareFile(): Promise<string | null>;
  flashFirmware(path: string, enableInsecure: boolean): Promise<void>;

  // イベント (各メソッドは unsubscribe 関数を返す)
  onDeviceConnected(callback: (device: DeviceInfo) => void): () => void;
  onDeviceDisconnected(callback: () => void): () => void;
  onFlashProgress(callback: (progress: number) => void): () => void;
  onFlashLog(callback: (message: string) => void): () => void;
}
```

#### IPC 型定義の一元管理

IPC チャネル名と型定義は `shared/ipc/` に一元管理し、Main/Renderer 間の型安全性を保証する。

```typescript
// shared/ipc/channels.ts — IPC チャネル名の単一ソース
export const IpcChannels = {
  DEVICE_CONNECTED: 'device:connected',
  DEVICE_DISCONNECTED: 'device:disconnected',
  HID_LIST_DEVICES: 'hid:listDevices',
  // ... 全チャネル名を定数として定義
  SYNC_EXECUTE: 'sync:execute',
  SYNC_CHANGE_PASSWORD: 'sync:change-password',
  SYNC_LIST_UNDECRYPTABLE: 'sync:list-undecryptable',
  SYNC_DELETE_FILES: 'sync:delete-files',
  SYNC_CHECK_PASSWORD_EXISTS: 'sync:check-password-exists',
  // ...
} as const;

// shared/types/vial-api.ts — preload contextBridge の型定義
export interface VialAPI {
  listDevices(): Promise<DeviceInfo[]>;
  openDevice(vendorId: number, productId: number): Promise<boolean>;
  syncExecute(direction: 'download' | 'upload', scope?: SyncScope): Promise<...>;
  syncCheckPasswordExists(): Promise<boolean>;
  // ...
};
```

#### keyboardId の型

`keyboardId` は内部的には 64bit 整数だが、IPC シリアライズ (structured clone) で `bigint` が安全に転送できないケースがあるため、IPC 境界では 16 進文字列 (`string`) として受け渡す。Main プロセス内部での変換は `BigInt('0x' + id)` で行う。

#### イベント API の unsubscribe パターン

イベント API は登録解除関数を返す設計とし、React コンポーネントの `useEffect` クリーンアップで確実にリスナーを解除する。

```typescript
// preload.ts 実装例
onDeviceConnected: (callback: (device: DeviceInfo) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, device: DeviceInfo) => callback(device);
  ipcRenderer.on('device:connected', listener);
  return () => ipcRenderer.removeListener('device:connected', listener);
},
```

### 3.6 shared/ ディレクトリ

両プロセスで共有する型定義・定数を格納する。

```
shared/
  types/                  # 型定義
    index.ts              # 型 re-export
    protocol.ts           # プロトコル型 (DeviceInfo, KeyboardDefinition 等)
    sync.ts               # 同期型 (SyncEnvelope, SyncScope, UndecryptableFile, PasswordStrength 等)
    vial-api.ts           # preload 公開 API 型 (VialAPI)
    app-config.ts         # アプリ設定型 (AppConfig)
    snapshot-store.ts     # スナップショット型
    favorite-store.ts     # お気に入り型
    pipette-settings.ts   # デバイス設定型
    hub.ts                # Hub 連携型
    language-store.ts     # 言語パック型
    notification.ts       # 通知型
  constants/
    index.ts              # 定数 re-export
    protocol.ts           # プロトコル定数 + バージョンゲート + EMPTY_UID
    lighting.ts           # ライティング定数
  keycodes/
    keycodes.ts           # キーコード定義・ルックアップ
    keycodes-v5.ts        # v5 キーコードマッピング
    keycodes-v6.ts        # v6 キーコードマッピング
  kle/                    # KLE (Keyboard Layout Editor) パーサー
    index.ts              # KLE re-export
    kle-parser.ts         # KLE JSON パーサー
    layout-options.ts     # レイアウトオプション処理
    filter-keys.ts        # キーフィルタリング
    types.ts              # KLE 型定義
  data/
    language-manifest.json # タイピングテスト言語パック一覧
  ipc/
    channels.ts           # IPC チャネル名定数
  vil-file.ts             # .vil / .pipette ファイル形式
  vil-compat.ts           # .vil 互換性レイヤー
  favorite-data.ts        # お気に入りデータ操作
  keymap-export.ts        # keymap.c エクスポート
  pdf-export.ts           # PDF エクスポート
  layout-options.ts       # レイアウトオプションユーティリティ
  qmk-settings-defs.json  # QMK Settings 定義データ
```

### 3.7 TypeScript 設定

Main / Renderer / Shared でコンパイル対象と設定が異なるため、tsconfig をプロジェクト参照 (Project References) で分割する。

#### tsconfig.main.json (Main プロセス)

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2025"],
    "types": ["node", "electron"],
    "outDir": "dist/main",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/main/**/*"]
}
```

#### tsconfig.renderer.json (Renderer プロセス)

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2025", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "outDir": "dist/renderer",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/renderer/**/*"]
}
```

#### tsconfig.shared.json (共有コード)

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2025"],
    "outDir": "dist/shared",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true
  },
  "include": ["src/shared/**/*"]
}
```

#### tsconfig.json (ルート: Project References)

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.main.json" },
    { "path": "./tsconfig.renderer.json" },
    { "path": "./tsconfig.shared.json" }
  ]
}
```

### 3.7 ディレクトリ構成

```
src/
├── main/
│   ├── index.ts              # Electron main (CSP, ナビゲーション, アプリライフサイクル)
│   ├── hid-service.ts        # node-hid トランスポート (32バイト, mutex, リトライ)
│   ├── hid-ipc.ts            # HID 操作の IPC ハンドラー登録
│   └── logger.ts             # ローテーションファイルロガー
├── preload/
│   ├── index.ts              # contextBridge API (プロトコル関数)
│   ├── hid-transport.ts      # main プロセスへの IPC ブリッジ (node-hid)
│   ├── protocol.ts           # VIA/Vial プロトコルコマンド
│   ├── macro.ts              # マクロ v1/v2 シリアライゼーション
│   ├── keyboard.ts           # キーボード状態マネージャー + リロードシーケンス
│   └── lzma.d.ts             # LZMA 型宣言
├── renderer/
│   ├── index.html            # HTML エントリ (CSP meta なし — main で設定)
│   ├── index.tsx             # React エントリ + CSS インポート
│   ├── App.tsx               # ルートコンポーネント (Tailwind クラス)
│   ├── style.css             # Tailwind (@import "tailwindcss")
│   ├── env.d.ts              # Vite クライアント型定義
│   └── i18n/                 # 国際化
│       ├── index.ts          # i18n セットアップと t() エクスポート
│       └── locales/          # 翻訳ファイル
│           ├── en.json       # 英語 (デフォルト)
│           └── ja.json       # 日本語
└── shared/
    ├── constants/protocol.ts  # プロトコル定数 + バージョンゲート
    ├── types/
    │   ├── protocol.ts        # プロトコル TypeScript インターフェース
    │   ├── sync.ts            # 同期型 (SyncEnvelope, SyncScope, UndecryptableFile 等)
    │   ├── vial-api.ts        # preload 公開 API 型定義 (VialAPI)
    │   ├── app-config.ts      # アプリ設定型 (AppConfig)
    │   ├── snapshot-store.ts  # スナップショット型 (SnapshotIndex, SnapshotMeta)
    │   ├── favorite-store.ts  # お気に入り型 (FavoriteIndex, FavoriteType)
    │   ├── pipette-settings.ts # デバイス設定型 (PipetteSettings)
    │   ├── hub.ts             # Hub 連携型
    │   ├── language-store.ts  # 言語パック型
    │   └── notification.ts    # 通知型
    └── ipc/channels.ts        # IPC チャンネル名 (HID, ファイル I/O, 同期, Hub 等)
```

---

## 4. USB HID 通信プロトコル仕様

### 4.1 デバイス検出

#### HID パラメータ

| パラメータ | 値 |
|---|---|
| Usage Page | `0xFF60` |
| Usage | `0x61` |

#### デバイス種別判定

1. **Vial キーボード**: シリアルナンバーに `vial:f64c2b3c` を含む
2. **Vial ブートローダー**: シリアルナンバーに `vibl:d4f8159c` を含む
3. **VIA キーボード**: VIA Stack JSON の `definitions` に `VID*65536+PID` が存在する
4. **サイドロード**: 指定された VID/PID に一致するデバイス

#### サンプルキーボード UID (使用禁止)

以下の UID はサンプルキーボード用であり、再利用を禁止する:

- `0xD4A36200603E3007`
- `0x32F62BC2EEF2237B`
- `0x38CEA320F23046A5`
- `0xBED2D31EC59A0BD8`
- `0xA6867BDFD3B00F` で始まるもの

### 4.2 メッセージフォーマット

| 項目 | 値 |
|---|---|
| パケット長 | 32 バイト (`MSG_LEN = 32`) |
| バッファ読み書きチャンクサイズ | 28 バイト (`BUFFER_FETCH_CHUNK = 28`) |
| HID レポート ID | `0x00` (先頭に付加) |
| タイムアウト | 500ms (読み取り) |
| リトライ回数 | 通常 20 回 |

送信時: メッセージを 32 バイトにゼロパディングし、先頭に `0x00` (レポート ID) を付加して合計 33 バイトを write する。
受信時: 32 バイトを read する。

### 4.3 VIA プロトコルコマンド

| コマンド名 | コード | パック形式 | 説明 |
|---|---|---|---|
| `CMD_VIA_GET_PROTOCOL_VERSION` | `0x01` | `>B` → 応答 `>xH` (byte[1:3]) | VIA プロトコルバージョン取得 |
| `CMD_VIA_GET_KEYBOARD_VALUE` | `0x02` | `>BB{subcommand}` | キーボード値取得 |
| `CMD_VIA_SET_KEYBOARD_VALUE` | `0x03` | `>BB{subcommand}{value}` | キーボード値設定 |
| `CMD_VIA_GET_KEYCODE` | `0x04` | - | キーコード取得 (未使用) |
| `CMD_VIA_SET_KEYCODE` | `0x05` | `>BBBBH` (cmd, layer, row, col, keycode) | キーコード設定 |
| `CMD_VIA_LIGHTING_SET_VALUE` | `0x07` | `>BB{params}` | ライティング値設定 |
| `CMD_VIA_LIGHTING_GET_VALUE` | `0x08` | `>BB` → 応答 byte[2:] | ライティング値取得 |
| `CMD_VIA_LIGHTING_SAVE` | `0x09` | `>B` | ライティング設定保存 |
| `CMD_VIA_MACRO_GET_COUNT` | `0x0C` | `>B` → 応答 byte[1] = count | マクロ数取得 |
| `CMD_VIA_MACRO_GET_BUFFER_SIZE` | `0x0D` | `>B` → 応答 `>xH` (byte[1:3]) | マクロバッファサイズ取得 |
| `CMD_VIA_MACRO_GET_BUFFER` | `0x0E` | `>BHB` (cmd, offset, size) → 応答 byte[4:4+size] | マクロバッファ読取 |
| `CMD_VIA_MACRO_SET_BUFFER` | `0x0F` | `>BHB` + data (cmd, offset, size, data) | マクロバッファ書込 |
| `CMD_VIA_GET_LAYER_COUNT` | `0x11` | `>B` → 応答 byte[1] = count | レイヤー数取得 |
| `CMD_VIA_KEYMAP_GET_BUFFER` | `0x12` | `>BHB` (cmd, offset, size) → 応答 byte[4:4+size] | キーマップバッファ読取 |
| `CMD_VIA_VIAL_PREFIX` | `0xFE` | Vial コマンドのプレフィックス | Vial コマンドのラッパー |

#### GET/SET_KEYBOARD_VALUE サブコマンド

| サブコマンド名 | コード | 説明 |
|---|---|---|
| `VIA_LAYOUT_OPTIONS` | `0x02` | レイアウトオプション (32bit, big-endian) |
| `VIA_SWITCH_MATRIX_STATE` | `0x03` | スイッチマトリクス状態 |

#### ライティングサブコマンド

| サブコマンド名 | コード | 説明 |
|---|---|---|
| `QMK_BACKLIGHT_BRIGHTNESS` | `0x09` | バックライト明るさ |
| `QMK_BACKLIGHT_EFFECT` | `0x0A` | バックライトエフェクト |
| `QMK_RGBLIGHT_BRIGHTNESS` | `0x80` | RGBLight 明るさ |
| `QMK_RGBLIGHT_EFFECT` | `0x81` | RGBLight エフェクト |
| `QMK_RGBLIGHT_EFFECT_SPEED` | `0x82` | RGBLight エフェクト速度 |
| `QMK_RGBLIGHT_COLOR` | `0x83` | RGBLight カラー (H, S) |
| `VIALRGB_GET_INFO` | `0x40` | VialRGB 情報取得 |
| `VIALRGB_GET_MODE` | `0x41` | VialRGB モード取得 |
| `VIALRGB_GET_SUPPORTED` | `0x42` | VialRGB サポートエフェクト取得 |
| `VIALRGB_SET_MODE` | `0x41` | VialRGB モード設定 |

### 4.4 Vial プロトコルコマンド

全ての Vial コマンドは `CMD_VIA_VIAL_PREFIX (0xFE)` を先頭に付加して送信する。

| コマンド名 | コード | パック形式 | 説明 |
|---|---|---|---|
| `CMD_VIAL_GET_KEYBOARD_ID` | `0x00` | `BB` → 応答 `<IQ` (vial_protocol[4], keyboard_id[8]) | キーボード ID 取得 |
| `CMD_VIAL_GET_SIZE` | `0x01` | `BB` → 応答 `<I` (size) | 定義データサイズ取得 |
| `CMD_VIAL_GET_DEFINITION` | `0x02` | `<BBI` (prefix, cmd, block) → 応答 32 バイト | 定義データ取得 (ブロック単位) |
| `CMD_VIAL_GET_ENCODER` | `0x03` | `BBBB` (prefix, cmd, layer, idx) → 応答 `>HH` (cw, ccw) | エンコーダ値取得 |
| `CMD_VIAL_SET_ENCODER` | `0x04` | `>BBBBBH` (prefix, cmd, layer, idx, dir, keycode) | エンコーダ値設定 |
| `CMD_VIAL_GET_UNLOCK_STATUS` | `0x05` | `BB` → 応答 [unlocked, in_progress, key_pairs...] | ロック状態取得 |
| `CMD_VIAL_UNLOCK_START` | `0x06` | `BB` | アンロック開始 |
| `CMD_VIAL_UNLOCK_POLL` | `0x07` | `BB` → 応答 [unlocked, _, counter] | アンロック進捗確認 |
| `CMD_VIAL_LOCK` | `0x08` | `BB` | ロック |
| `CMD_VIAL_QMK_SETTINGS_QUERY` | `0x09` | `<BBH` (prefix, cmd, start_id) → 応答 [qsid pairs, 0xFFFF=終端] | QMK Settings ID 列挙 |
| `CMD_VIAL_QMK_SETTINGS_GET` | `0x0A` | `<BBH` (prefix, cmd, qsid) → 応答 [status, data...] | QMK Setting 値取得 |
| `CMD_VIAL_QMK_SETTINGS_SET` | `0x0B` | `<BBH` + serialized_data | QMK Setting 値設定 |
| `CMD_VIAL_QMK_SETTINGS_RESET` | `0x0C` | `BB` | QMK Settings リセット |
| `CMD_VIAL_DYNAMIC_ENTRY_OP` | `0x0D` | `BBB{subcmd}` | Dynamic Entry 操作 |

#### Dynamic Entry サブコマンド

| サブコマンド名 | コード | 説明 |
|---|---|---|
| `DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES` | `0x00` | エントリ数取得: 応答 [tap_dance, combo, key_override, alt_repeat_key] |
| `DYNAMIC_VIAL_TAP_DANCE_GET` | `0x01` | Tap Dance エントリ取得 (形式: `<HHHHH`) |
| `DYNAMIC_VIAL_TAP_DANCE_SET` | `0x02` | Tap Dance エントリ設定 |
| `DYNAMIC_VIAL_COMBO_GET` | `0x03` | Combo エントリ取得 (形式: `<HHHHH`) |
| `DYNAMIC_VIAL_COMBO_SET` | `0x04` | Combo エントリ設定 |
| `DYNAMIC_VIAL_KEY_OVERRIDE_GET` | `0x05` | Key Override エントリ取得 (形式: `<HHHBBBB`) |
| `DYNAMIC_VIAL_KEY_OVERRIDE_SET` | `0x06` | Key Override エントリ設定 |
| `DYNAMIC_VIAL_ALT_REPEAT_KEY_GET` | `0x07` | Alt Repeat Key エントリ取得 (形式: `<HHBB`) |
| `DYNAMIC_VIAL_ALT_REPEAT_KEY_SET` | `0x08` | Alt Repeat Key エントリ設定 |

### 4.5 プロトコルバージョン

#### VIA プロトコル

対応バージョン: `-1, 9`

- `-1`: VIA 未対応 (Vial 専用デバイス)
- `9`: 現行 VIA プロトコル

#### Vial プロトコル

対応バージョン: `-1, 0, 1, 2, 3, 4, 5, 6`

| バージョン | 機能 |
|---|---|
| `-1` | VIA のみ (Vial 非対応) |
| `0` | 基本 Vial 機能 |
| `1` | 基本 Vial 機能 |
| `2` | Advanced Macros (ディレイ対応マクロ) |
| `3` | Safe Matrix Tester (アンロック必要) |
| `4` | Dynamic Entries (Tap Dance, Combo), QMK Settings |
| `5` | Extended Macros (2 バイトキーコード対応), Key Override |
| `6` | 最新 |

#### 機能フラグ (Vial Protocol >= 4)

`DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES` 応答の最終バイトのビットで示される:

| ビット | 機能 |
|---|---|
| bit 0 | `caps_word` |
| bit 1 | `layer_lock` |

Vial Protocol >= 5 の場合、`persistent_default_layer` が無条件で有効。
`alt_repeat_key_count > 0` の場合、`repeat_key` が有効。

### 4.6 通信シーケンス

#### デバイス初期化フロー

```
1. GET_PROTOCOL_VERSION → via_protocol 取得
2. VIAL_GET_KEYBOARD_ID → vial_protocol, keyboard_id 取得
3. バージョン互換性チェック
4. VIAL_GET_SIZE → 定義データサイズ取得
5. VIAL_GET_DEFINITION × N ブロック → LZMA 圧縮定義データ取得
6. LZMA 解凍 → JSON パース → キーボード定義
7. GET_LAYER_COUNT → レイヤー数取得
8. マクロ情報取得 (count, buffer_size)
9. RGB 情報取得 (persistent)
10. RGB 状態取得
11. QMK Settings 取得 (vial_protocol >= 4)
12. Dynamic Entry 数取得 (vial_protocol >= 4)
13. キーコード配列再生成
14. KEYMAP_GET_BUFFER → キーマップ読込
15. マクロバッファ読込・デシリアライズ
16. Tap Dance / Combo / Key Override / Alt Repeat Key 読込
```

---

## 5. UI 画面仕様

### 5.1 Keymap Editor

メインのキーマップ編集画面。

#### 機能

- **キーボードウィジェット**: KLE フォーマットに基づく物理レイアウト表示
- **レイヤー切替**: レイヤー番号ボタン (0, 1, 2, ...) で表示レイヤーを切替
- **ズーム**: +/- ボタンでキーボード表示倍率を変更
- **キー選択**: キーをクリックして選択、選択中のキーにキーコードを割当
- **キーコードパレット**: タブ分けされたキーコード一覧 (Basic, Layers, Modifiers, etc.)
- **マスクキー対応**: `LT(n)(kc)` 等のマスクキーで内部キーコードのみの変更をサポート
- **Any キーコード**: ダイアログで QMK ID を直接入力
- **エンコーダ対応**: ロータリーエンコーダのキーマップ表示・編集 (CW/CCW)
- **次のキーへ自動移動**: キーコード設定後、次のキーへ自動選択移動
- **国別キーマップオーバーライド**: 表示ラベルを国別キーマップで上書き

#### キーボードウィジェット描画

- KLE (Keyboard Layout Editor) シリアルフォーマットでレイアウトを定義
- `labels[0]`: `row,col` 形式でマトリクス位置を指定
- `labels[4]`: `e` の場合エンコーダキー、`labels[0]` は `idx,direction` 形式
- `labels[8]`: `layout_index,layout_option` で物理レイアウトオプションに対応
- Decal キー: 装飾用 (マトリクス位置あり/なし)

### 5.2 Layout Editor

物理レイアウトの選択画面。

#### 機能

- **レイアウトオプション**: キーボード定義 JSON の `layouts.labels` に基づく
  - **Boolean 型**: チェックボックス (例: "Split Backspace")
  - **Select 型**: ドロップダウン (例: "Bottom Row" → ["ANSI", "Tsangan", "HHKB"])
- **プレビュー**: 選択に応じてキーボードウィジェットのプレビューを更新
- **レイアウトオプション値**: ビット列として 32bit 整数にパックし、VIA プロトコルで送信

#### レイアウトオプションのパッキング

VIA は逆順でビット列を格納する。各選択肢は必要なビット幅を占有する:
- Boolean: 1 ビット
- Select (N 選択肢): ceil(log2(N)) ビット

### 5.3 Macro Editor

マクロの編集・記録画面。

#### 機能

- **タブ形式**: マクロごとにタブ (M0, M1, M2, ...)
- **メモリ使用量表示**: 現在のマクロサイズ / 最大バッファサイズ
- **アクション追加**: Text, Tap, Down, Up, Delay (vial_protocol >= 2)
- **マクロレコーダー**: キーストローク記録 (Linux/Windows プラットフォーム別実装)
- **Save / Revert ボタン**: 変更の保存と巻き戻し
- **変更状態表示**: 未保存の変更があるタブにアスタリスク (*) 表示

#### マクロアクション種類

| アクション | タグ | 説明 |
|---|---|---|
| `ActionText` | `text` | テキスト文字列の入力 |
| `ActionTap` | `tap` | キーの Tap (押して離す) |
| `ActionDown` | `down` | キーの Press |
| `ActionUp` | `up` | キーの Release |
| `ActionDelay` | `delay` | ミリ秒単位の遅延 (vial_protocol >= 2) |

#### マクロシリアライズ形式

**Protocol v1 (vial_protocol < 2)**:
- 通常文字: ASCII バイトそのまま
- `SS_TAP_CODE (0x01)` + keycode (1byte): Tap
- `SS_DOWN_CODE (0x02)` + keycode (1byte): Down
- `SS_UP_CODE (0x03)` + keycode (1byte): Up
- マクロ間は NUL (`0x00`) で区切り

**Protocol v2 (vial_protocol >= 2)**:
- 通常文字: ASCII バイトそのまま
- `SS_QMK_PREFIX (0x01)` + action_code + keycode: キーアクション
  - `0x01` + keycode(1byte): Tap (1byte keycode)
  - `0x02` + keycode(1byte): Down (1byte keycode)
  - `0x03` + keycode(1byte): Up (1byte keycode)
  - `0x04` + delay_lo(1byte) + delay_hi(1byte): Delay (delay = (lo-1) + (hi-1)*255)
  - `0x05` + keycode(2byte LE): Tap (extended, 2byte keycode)
  - `0x06` + keycode(2byte LE): Down (extended, 2byte keycode)
  - `0x07` + keycode(2byte LE): Up (extended, 2byte keycode)
- 2byte keycode エンコーディング: `kc > 0xFF00` の場合 `kc = (kc & 0xFF) << 8`
- マクロ間は NUL (`0x00`) で区切り

### 5.4 RGB Configurator

RGB ライティングの設定画面。3 種類のハンドラーを持つ。

#### 5.4.1 QMK Backlight

キーボード定義の `lighting` が `qmk_backlight` または `qmk_backlight_rgblight` の場合に表示。

- **Brightness**: スライダー (0-255)
- **Breathing**: チェックボックス (effect = 0 or 1)

#### 5.4.2 QMK RGBLight

キーボード定義の `lighting` が `qmk_rgblight` または `qmk_backlight_rgblight` の場合に表示。

- **Underglow Effect**: ドロップダウン (37 エフェクト: All Off, Solid Color, Breathing 1-4, Rainbow Mood 1-3, Rainbow Swirl 1-6, Snake 1-6, Knight 1-3, Christmas, Gradient 1-10, RGB Test, Alternating)
- **Underglow Brightness**: スライダー (0-255)
- **Underglow Color**: カラーピッカー (HSV、エフェクトが color_picker 対応時のみ表示)

#### 5.4.3 VialRGB

キーボード定義の `lighting` が `vialrgb` の場合に表示。

- **RGB Effect**: ドロップダウン (サポートされるエフェクトのみ表示、最大 45 種類)
- **RGB Color**: カラーピッカー (HSV)
- **RGB Brightness**: スライダー (0 ~ maximum_brightness)
- **RGB Speed**: スライダー (0-255)
- **Save ボタン**: CMD_VIA_LIGHTING_SAVE で保存

VialRGB プロトコルバージョン: `1` のみサポート。

VialRGB エフェクト一覧 (index: name):
0: Disable, 1: Direct Control, 2: Solid Color, 3: Alphas Mods, 4: Gradient Up Down, 5: Gradient Left Right, 6: Breathing, 7-12: Band系, 13-20: Cycle系, 21: Dual Beacon, 22: Rainbow Beacon, 23: Rainbow Pinwheels, 24-25: Raindrops系, 26-28: Hue系, 29: Typing Heatmap, 30: Digital Rain, 31-38: Solid Reactive系, 39-42: Splash系, 43: Pixel Rain, 44: Pixel Fractal

### 5.5 Tap Dance Editor

Tap Dance の設定画面。vial_protocol >= 4 かつ tap_dance_count > 0 の場合に表示。

#### 機能

- **タブ形式**: エントリごとにタブ (0, 1, 2, ...)
- **エントリ構造** (各 5 フィールド、バイナリ形式 `<HHHHH`):
  - On Tap: キーコード (16bit)
  - On Hold: キーコード (16bit)
  - On Double Tap: キーコード (16bit)
  - On Tap + Hold: キーコード (16bit)
  - Tapping Term: ミリ秒 (16bit, 0-10000)
- **使い方**: キーマップで `TD(n)` キーコードを割り当てて使用
- **Save / Revert**: タイミング変更時のみ Save が必要、キー変更は即座に送信
- **変更状態表示**: 未保存タブにアスタリスク

### 5.6 Combo Editor

Combo (同時押し) の設定画面。vial_protocol >= 4 かつ combo_count > 0 の場合に表示。

#### 機能

- **タブ形式**: エントリごとにタブ
- **エントリ構造** (各 5 フィールド、バイナリ形式 `<HHHHH`):
  - Key 1-4: トリガーキー (16bit キーコード、未使用は `KC_NO`)
  - Output Key: 出力キー (16bit キーコード)
- **即時保存**: キー変更時に即座にデバイスへ送信
- **Settings: Configuration**: Combo タブ下部の Configuration ボタンから設定モーダルを開き、Combo 関連のタイムアウト設定（`COMBO_TERM` 等）を変更可能

### 5.7 Key Override Editor

Key Override の設定画面。vial_protocol >= 4 かつ key_override_count > 0 の場合に表示。

#### 機能

- **タブ形式**: エントリごとにタブ
- **エントリ構造** (バイナリ形式 `<HHHBBBB`):
  - Trigger Key: トリガーキーコード (16bit)
  - Replacement Key: 置換キーコード (16bit)
  - Layers: 有効レイヤー (16bit ビットマスク、各ビットが 1 レイヤー)
  - Trigger Mods: トリガーモディファイア (8bit ビットマスク)
  - Negative Mod Mask: 無効化モディファイア (8bit ビットマスク)
  - Suppressed Mods: 抑制モディファイア (8bit ビットマスク)
  - Options: オプションフラグ (8bit)

#### Key Override オプションフラグ

| ビット | フラグ | 説明 |
|---|---|---|
| 0 | `activation_trigger_down` | トリガーキー押下で発火 |
| 1 | `activation_required_mod_down` | 必要モディファイア押下で発火 |
| 2 | `activation_negative_mod_up` | ネガティブモディファイアリリースで発火 |
| 3 | `one_mod` | 単一モディファイアで発火 |
| 4 | `no_reregister_trigger` | 別キー押下でも無効化しない |
| 5 | `no_unregister_on_other_key_down` | オーバーライド解除後にトリガーを再登録しない |
| 7 | `enabled` | エントリ有効 |

#### モディファイアビットマスク

| ビット | モディファイア |
|---|---|
| 0 | LCtrl |
| 1 | LShift |
| 2 | LAlt |
| 3 | LGui |
| 4 | RCtrl |
| 5 | RShift |
| 6 | RAlt |
| 7 | RGui |

### 5.8 Alt Repeat Key Editor

Alt Repeat Key の設定画面。vial_protocol >= 4 かつ alt_repeat_key_count > 0 の場合に表示。

#### 機能

- **タブ形式**: エントリごとにタブ
- **エントリ構造** (バイナリ形式 `<HHBB`):
  - Last Key: トリガーとなる最後に押されたキー (16bit キーコード)
  - Alt Key: 代替出力キー (16bit キーコード)
  - Allowed Mods: 許可モディファイア (8bit ビットマスク)
  - Options: オプションフラグ (8bit)

#### Alt Repeat Key オプションフラグ

| ビット | フラグ | 説明 |
|---|---|---|
| 0 | `default_to_this_alt_key` | デフォルトの Alt Key として使用 |
| 1 | `bidirectional` | 双方向 |
| 2 | `ignore_mod_handedness` | モディファイアの左右を無視 |
| 3 | `enabled` | エントリ有効 |

### 5.9 QMK Settings

QMK ファームウェア設定の画面。vial_protocol >= 4 かつサポートされる設定が 1 つ以上ある場合に表示。

#### 機能

- **タブ形式**: カテゴリごとにタブ (定義は `qmk_settings.json`)
- **設定フィールド種類**:
  - **Boolean**: チェックボックス (ビットフィールド対応、同一 QSID に複数 Boolean)
  - **Integer**: スピンボックス (min, max, width 指定)
- **Save / Undo / Reset ボタン**
- **変更検知**: 変更のあるタブにアスタリスク表示

#### QMK Settings シリアライズ

- Boolean: `width` バイトの整数値 (little-endian)、`bit` フィールドでビット位置指定
- Integer: `width` バイトの整数値 (little-endian)

#### QMK Settings ID (QSID) 列挙

`CMD_VIAL_QMK_SETTINGS_QUERY` を `start_id=0` から送信し、応答の 2 バイトペアを取得。`0xFFFF` が終端。

### 5.10 Matrix Tester

スイッチマトリクスの動作確認画面。vial_protocol >= 3 の場合に表示。

#### 機能

- **リアルタイムポーリング**: 20ms 間隔で `CMD_VIA_GET_KEYBOARD_VALUE + VIA_SWITCH_MATRIX_STATE` を送信
- **アンロック必要**: vial_protocol >= 3 ではアンロック状態が必要
- **マトリクスサイズ制限**: `(cols / 8 + 1) * rows <= 28` (28 = BUFFER_FETCH_CHUNK)
- **キー状態表示**: 押下中のキーをハイライト、一度でも押されたキーは別色表示
- **Reset ボタン**: ハイライト状態のリセット
- **キーボードグラブ**: テスト中はキーボード入力をキャプチャ

#### マトリクスデータ形式

応答パケットの byte[2:] からマトリクスデータを取得:
- 各行は `ceil(cols / 8)` バイト
- 各バイト内のビットがキーの押下状態 (1 = 押下)
- バイト順序: 逆順 (最後のバイトが先頭のカラム群)

### 5.11 Firmware Flasher

Vial ブートローダー経由のファームウェア更新画面。

#### 表示条件

- `VialBootloader` デバイスが接続されている場合
- `VialKeyboard` で `vibl` フラグが true の場合

#### 機能

- **ファイル選択**: `.vfw` ファイルの選択
- **ログ表示**: フラッシュ進捗のログ
- **プログレスバー**: 進捗表示
- **レイアウト復元オプション**: フラッシュ後にキーマップを自動復元 (キーボード接続時のみ)

#### .vfw ファームウェアパッケージ形式

| オフセット | サイズ | 内容 |
|---|---|---|
| 0 | 8 | シグネチャ (`VIALFW00` or `VIALFW01`) |
| 8 | 8 | UID (キーボード固有 ID) |
| 16 | 8 | ビルドタイムスタンプ (uint64 LE, UNIX timestamp) |
| 24 | 8 | 予約 |
| 32 | 32 | SHA-256 ハッシュ (ペイロードの) |
| 64 | 可変 | ファームウェアペイロード |

#### ブートローダーコマンド

全て 64 バイトにゼロパディングして送信:

| コマンド | バイト列 | 説明 |
|---|---|---|
| Get Version | `VC\x00` | ブートローダーバージョン取得 (サポート: 0, 1) |
| Get UID | `VC\x01` | デバイス UID 取得 (8 バイト) |
| Flash Start | `VC\x02` + uint16 LE (chunk数) | フラッシュ開始 |
| Reboot | `VC\x03` | リブート |
| Enable Insecure | `VC\x04` | 初回起動時のアンロックモード有効化 |

#### フラッシュシーケンス

```
1. .vfw ファイル読込
2. シグネチャ検証 (VIALFW00/VIALFW01)
3. SHA-256 ハッシュ検証
4. ブートローダーバージョン確認 (VC\x00)
5. UID 一致確認 (VC\x01)
6. フラッシュ開始 (VC\x02 + チャンク数)
7. ペイロード送信 (64 バイトずつ)
8. レイアウト復元有効なら Enable Insecure (VC\x04)
9. リブート (VC\x03)
10. (レイアウト復元) デバイス再検出 → 保存レイアウト復元 → ロック
```

---

## 6. データフォーマット

### 6.1 キーボード定義 JSON

キーボードから LZMA 圧縮された JSON として取得される。

```typescript
interface KeyboardDefinition {
  // マトリクスサイズ
  matrix: {
    rows: number;
    cols: number;
  };

  // レイアウト情報
  layouts: {
    // KLE フォーマットのキーマップ配列
    keymap: any[];
    // レイアウトオプションラベル
    // string = Boolean, string[] = Select (先頭がラベル、残りが選択肢)
    labels?: (string | string[])[];
  };

  // ライティング設定
  lighting?: "qmk_backlight" | "qmk_rgblight" | "qmk_backlight_rgblight" | "vialrgb";

  // Vial 固有情報
  vial?: {
    vibl?: boolean;    // ブートローダー対応
    midi?: "basic" | "advanced" | null;  // MIDI キーコード
  };

  // カスタムキーコード
  customKeycodes?: Array<{
    name: string;
    shortName: string;
    title: string;
  }>;
}
```

### 6.2 .vil ファイルフォーマット (レイアウト保存)

JSON (UTF-8 エンコード) で以下の構造を持つ:

```typescript
interface VilFile {
  version: 1;
  uid: bigint;              // keyboard_id

  // キーマップ: layout[layer][row][col] = keycode (serialized string)
  layout: string[][][];

  // エンコーダ: encoder_layout[layer][encoder_index] = [cw_keycode, ccw_keycode]
  encoder_layout: [string, string][][];

  // レイアウトオプション
  layout_options: number;

  // マクロ: macro[macro_index] = [action, ...args][]
  macro: [string, ...any[]][][];

  // プロトコルバージョン
  vial_protocol: number;
  via_protocol: number;

  // Tap Dance: [on_tap, on_hold, on_double_tap, on_tap_hold, tapping_term][]
  tap_dance: [string, string, string, string, number][];

  // Combo: [key1, key2, key3, key4, output][]
  combo: [string, string, string, string, string][];

  // Key Override
  key_override: Array<{
    trigger: string;
    replacement: string;
    layers: number;
    trigger_mods: number;
    negative_mod_mask: number;
    suppressed_mods: number;
    options: number;
  }>;

  // Alt Repeat Key
  alt_repeat_key: Array<{
    keycode: string;
    alt_keycode: string;
    allowed_mods: number;
    options: number;
  }>;

  // QMK Settings: { qsid: value }
  settings: Record<number, number>;
}
```

### 6.3 QMK Settings JSON

`qmk_settings.json` はアプリケーションリソースとしてバンドルされ、タブ・フィールド構造を定義する。

```typescript
interface QmkSettingsDefinition {
  tabs: Array<{
    name: string;
    fields: Array<{
      qsid: number;
      title: string;
      type: "boolean" | "integer";
      bit?: number;         // boolean 型のビット位置
      width?: number;       // バイト幅 (デフォルト 1)
      min?: number;         // integer 型の最小値
      max?: number;         // integer 型の最大値
    }>;
  }>;
}
```

### 6.4 VIA Stack JSON

VIA 互換キーボードの定義を含む JSON:

```typescript
interface ViaStackJson {
  definitions: Record<string, any>;  // key = VID*65536+PID
}
```

---

## 7. キーコードシステム

### 7.1 キーコードエンコーディング

キーコードは 16bit 整数で表現される。文字列表現 (QMK ID) と整数値の相互変換を行う。

#### プロトコルバージョン別マッピング

- **v5** (`keycodes_v5`): 従来の QMK キーコード体系
- **v6** (`keycodes_v6`): 新しい QMK キーコード体系

Keycode.protocol フィールド (= vial_protocol の値) で切替。protocol == 6 で v6、それ以外で v5。

#### マスクキーコード

16bit キーコードの上位バイトと下位バイトが独立した意味を持つ場合、マスクキーコードと呼ぶ。

例:
- `LCTL(KC_A)` = `0x0100 | 0x04` = `0x0104`
- `LT0(KC_SPACE)` = `0x4000 | 0x002C` = `0x402C`

マスクキーコード一覧の `(kc)` を含む定義がマスクキーコードとして登録される。

#### serialize (整数 → 文字列)

```
1. (code & 0xFF00) がマスクセットに含まれるか確認
2. 含まれない場合: RAWCODES_MAP[code] を検索して qmk_id を返す
3. 含まれる場合: 上位 = RAWCODES_MAP[code & 0xFF00], 下位 = RAWCODES_MAP[code & 0x00FF]
   → outer.qmk_id の "kc" を inner.qmk_id で置換
4. 見つからない場合: hex(code) を返す
```

#### deserialize (文字列 → 整数)

```
1. qmk_id_to_keycode マップから直接検索
2. 見つからない場合: AnyKeycode デコーダーで解析
3. 失敗時: 0 を返す
```

### 7.2 キーコードカテゴリ

| カテゴリ | 説明 | 範囲例 (v5) |
|---|---|---|
| Basic | A-Z, 0-9, Enter, Space 等 | `0x04` - `0xFF` |
| Modifiers | LCtrl, RShift 等 | `0xE0` - `0xE7` |
| Shifted | KC_TILD, KC_EXLM 等 | `0x2xx` (LSFT マスク) |
| ISO | Non-US keys, JIS 特殊キー | `0x32`, `0x64`, `0x87`-`0x91` |
| Layer | MO(n), TG(n), LT(n)(kc) 等 | `0x51xx`, `0x53xx`, `0x4xxx` |
| Mod-Tap | LCTL_T(kc), MEH_T(kc) 等 | `0x6xxx`, `0x7xxx` |
| One-Shot | OSM(MOD_xxx), OSL(n) | `0x55xx`, `0x54xx` |
| Macro | M0-M255 | `0x5F12` + index |
| Tap Dance | TD(0)-TD(255) | `0x5700` + index |
| User | USER00-USER63 | `0x5F80` + index |
| Backlight | BL_TOGG, RGB_TOG 等 | `0x5Cxx` 範囲 |
| Media | Volume, Media keys 等 | `0xA8` - `0xBE` |
| Mouse | KC_MS_U, KC_BTN1 等 | `0xF0` - `0xFF` |
| MIDI | MI_C, MI_OCT_0 等 | `0x5C2F` - `0x5CBA` |
| Boot | QK_BOOT, QK_REBOOT | `0x5C00`, `0x5CDF` |
| Special | KC_NO, KC_TRNS | `0x00`, `0x01` |

### 7.3 特殊キーコード

| キーコード | 値 (v5) | 説明 |
|---|---|---|
| `QK_BOOT` | `0x5C00` | ブートローダーモードへ (アンロック必要) |
| `QK_REBOOT` | - | リブート |
| `QK_CLEAR_EEPROM` | `0x5CDF` | EEPROM クリア |
| `FN_MO13` | `0x5F10` | Fn1 (Fn3) レイヤー数 >= 4 |
| `FN_MO23` | `0x5F11` | Fn2 (Fn3) レイヤー数 >= 4 |
| `QK_CAPS_WORD_TOGGLE` | feature: caps_word | Caps Word トグル |
| `QK_REPEAT_KEY` | feature: repeat_key | リピートキー |
| `QK_ALT_REPEAT_KEY` | feature: repeat_key | Alt リピートキー |
| `QK_LAYER_LOCK` | feature: layer_lock | レイヤーロック |

### 7.4 カスタムキーコード

キーボード定義 JSON の `customKeycodes` フィールドで定義。USER00 から順にマッピングされる。

```typescript
interface CustomKeycode {
  name: string;       // フル名 (エイリアスとして使用、keymap.c エクスポート名)
  shortName: string;  // ボタンラベル
  title: string;      // ツールチップ
}
```

#### keymap.c エクスポート

`name` フィールドが定義されている場合、keymap.c エクスポートでは `USER00` の代わりにカスタム名を使用する。
また、keymaps 配列の前に `enum custom_keycodes` ブロックが生成される:

```c
enum custom_keycodes {
    CUSTOM_1 = QK_KB_0,
    CUSTOM_2,
};
```

### 7.5 動的キーコード生成

キーボード接続時に以下が動的に生成される:

- **レイヤーキー**: MO(0)-MO(N), DF(0)-DF(N), TG(0)-TG(N), TT(0)-TT(N), OSL(0)-OSL(N), TO(0)-TO(N), PDF(0)-PDF(N), LT0(kc)-LT15(kc)
- **マクロキー**: M0-M{macro_count-1}
- **Tap Dance キー**: TD(0)-TD{tap_dance_count-1}
- **User キーコード**: USER00-USER15 (またはカスタム定義)
- **MIDI キーコード**: midi 設定に基づき basic/advanced

---

## 8. セキュリティ

### 8.1 ロック/アンロック機構

Vial キーボードは、危険な操作 (ブートローダーへの移行、マクロ書込等) に対してアンロック機構を持つ。

#### アンロックフロー

```
1. get_unlock_status() でロック状態を確認
2. ロック中の場合、unlock_start() を送信
3. キーボードがランダムに選んだキーの組み合わせを返す
   - get_unlock_keys(): 応答 byte[2:] から (row, col) ペアを取得
   - 最大 15 ペア、(255, 255) は無効
4. ユーザーが指定されたキーを物理的に押し続ける
5. unlock_poll() を 200ms 間隔でポーリング
   - 応答 byte[0] = unlocked (1 = 完了)
   - 応答 byte[2] = カウンター (0 に近づくと完了)
6. unlocked == 1 でアンロック完了
```

#### アンロックが必要な操作

- `QK_BOOT` キーコードの設定
- マクロの書き込み (set_macro)
- マトリクステスター (vial_protocol >= 3)
- ファームウェアフラッシュ

#### ロック操作

`CMD_VIAL_LOCK (0x08)` を送信してキーボードをロック状態に戻す。
VIA キーボード (vial_protocol < 0) は常にアンロック状態。

### 8.2 ファームウェア署名検証

`.vfw` ファイルの整合性を以下で検証:

1. シグネチャチェック (`VIALFW00` or `VIALFW01`)
2. UID 一致確認 (ファームウェアの UID とブートローダーの UID)
3. SHA-256 ハッシュ検証 (ペイロードのハッシュ)

### 8.3 ブートローダー認証

- ブートローダーバージョン確認 (0 or 1 のみサポート)
- UID による対象デバイス確認
- `0xFF * 8` の UID は未設定を示す (警告表示)

---

## 9. プラットフォーム対応

### 9.1 対応 OS

| OS | 対応 |
|---|---|
| Linux | x86_64, ARM64 |
| Windows | x86_64 |
| macOS | x86_64, ARM64 (Universal) |

### 9.2 プラットフォーム固有処理

| 機能 | Linux | Windows | macOS |
|---|---|---|---|
| HID デバイス列挙 | node-hid (hidapi) | node-hid (hidapi) | node-hid (hidapi) |
| デバイスパーミッション | udev ルール必要 | 不要 | 不要 |
| デバイスオープン検証 | open_path でテスト | スキップ | スキップ |
| マクロレコーダー | /dev/input 読取 | Win32 API フック | 未実装 (要検討) |
| HID 再オープン | 可能 | 可能 | 不可 (既存を再利用) |

### 9.3 udev ルール (Linux)

```
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="*", ATTRS{idProduct}=="*", TAG+="uaccess"
```

---

## 10. 非機能要件

### 10.1 パフォーマンス要件

| 項目 | 要件 |
|---|---|
| デバイス検出 | 2 秒以内 |
| キーマップ読込 | 3 秒以内 (標準的なキーボード) |
| キーコード変更反映 | 100ms 以内 (ユーザー操作からデバイスへの送信) |
| マトリクステスター更新 | 20ms 間隔 (50Hz) |
| UI 初期描画 | 1 秒以内 |

### 10.2 セキュリティ要件

- Electron の contextIsolation を有効化
- nodeIntegration を無効化
- CSP (Content Security Policy) を適切に設定
- USB HID 通信は main プロセスのみで実行
- ファームウェアファイルの整合性検証を必須化
- ファームウェアサイズ上限: 10MB

### 10.3 互換性要件

| 項目 | 要件 |
|---|---|
| Vial プロトコル | v0-v6 の全バージョンと互換 |
| VIA プロトコル | v9 と互換 |
| .vil ファイル | 元の Vial GUI と相互読み書き可能 |
| キーボード定義 JSON | 元の Vial GUI と同一形式 |
| VIA Stack JSON | 元の VIA/Vial との互換 |

### 10.4 アクセシビリティ

- キーボードナビゲーション対応
- スクリーンリーダー対応 (ARIA ラベル)
- ハイコントラストモード対応

### 10.5 ログ

- ローテーションログファイル (最大 5MB x 5 世代)
- デバイス検出・接続・通信エラーのログ記録
- ユーザーデータ標準パスへの保存

---

## 付録 A: VIA/Vial コマンドコード一覧

### VIA コマンド

| 定数名 | コード (hex) |
|---|---|
| `CMD_VIA_GET_PROTOCOL_VERSION` | `0x01` |
| `CMD_VIA_GET_KEYBOARD_VALUE` | `0x02` |
| `CMD_VIA_SET_KEYBOARD_VALUE` | `0x03` |
| `CMD_VIA_GET_KEYCODE` | `0x04` |
| `CMD_VIA_SET_KEYCODE` | `0x05` |
| `CMD_VIA_LIGHTING_SET_VALUE` | `0x07` |
| `CMD_VIA_LIGHTING_GET_VALUE` | `0x08` |
| `CMD_VIA_LIGHTING_SAVE` | `0x09` |
| `CMD_VIA_MACRO_GET_COUNT` | `0x0C` |
| `CMD_VIA_MACRO_GET_BUFFER_SIZE` | `0x0D` |
| `CMD_VIA_MACRO_GET_BUFFER` | `0x0E` |
| `CMD_VIA_MACRO_SET_BUFFER` | `0x0F` |
| `CMD_VIA_GET_LAYER_COUNT` | `0x11` |
| `CMD_VIA_KEYMAP_GET_BUFFER` | `0x12` |
| `CMD_VIA_VIAL_PREFIX` | `0xFE` |

### VIA サブコマンド

| 定数名 | コード (hex) |
|---|---|
| `VIA_LAYOUT_OPTIONS` | `0x02` |
| `VIA_SWITCH_MATRIX_STATE` | `0x03` |

### ライティングサブコマンド

| 定数名 | コード (hex) |
|---|---|
| `QMK_BACKLIGHT_BRIGHTNESS` | `0x09` |
| `QMK_BACKLIGHT_EFFECT` | `0x0A` |
| `QMK_RGBLIGHT_BRIGHTNESS` | `0x80` |
| `QMK_RGBLIGHT_EFFECT` | `0x81` |
| `QMK_RGBLIGHT_EFFECT_SPEED` | `0x82` |
| `QMK_RGBLIGHT_COLOR` | `0x83` |
| `VIALRGB_GET_INFO` | `0x40` |
| `VIALRGB_GET_MODE` | `0x41` |
| `VIALRGB_GET_SUPPORTED` | `0x42` |
| `VIALRGB_SET_MODE` | `0x41` |

### Vial コマンド (CMD_VIA_VIAL_PREFIX + 以下)

| 定数名 | コード (hex) |
|---|---|
| `CMD_VIAL_GET_KEYBOARD_ID` | `0x00` |
| `CMD_VIAL_GET_SIZE` | `0x01` |
| `CMD_VIAL_GET_DEFINITION` | `0x02` |
| `CMD_VIAL_GET_ENCODER` | `0x03` |
| `CMD_VIAL_SET_ENCODER` | `0x04` |
| `CMD_VIAL_GET_UNLOCK_STATUS` | `0x05` |
| `CMD_VIAL_UNLOCK_START` | `0x06` |
| `CMD_VIAL_UNLOCK_POLL` | `0x07` |
| `CMD_VIAL_LOCK` | `0x08` |
| `CMD_VIAL_QMK_SETTINGS_QUERY` | `0x09` |
| `CMD_VIAL_QMK_SETTINGS_GET` | `0x0A` |
| `CMD_VIAL_QMK_SETTINGS_SET` | `0x0B` |
| `CMD_VIAL_QMK_SETTINGS_RESET` | `0x0C` |
| `CMD_VIAL_DYNAMIC_ENTRY_OP` | `0x0D` |

### Dynamic Entry サブコマンド

| 定数名 | コード (hex) |
|---|---|
| `DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES` | `0x00` |
| `DYNAMIC_VIAL_TAP_DANCE_GET` | `0x01` |
| `DYNAMIC_VIAL_TAP_DANCE_SET` | `0x02` |
| `DYNAMIC_VIAL_COMBO_GET` | `0x03` |
| `DYNAMIC_VIAL_COMBO_SET` | `0x04` |
| `DYNAMIC_VIAL_KEY_OVERRIDE_GET` | `0x05` |
| `DYNAMIC_VIAL_KEY_OVERRIDE_SET` | `0x06` |
| `DYNAMIC_VIAL_ALT_REPEAT_KEY_GET` | `0x07` |
| `DYNAMIC_VIAL_ALT_REPEAT_KEY_SET` | `0x08` |

---

## 付録 B: Vial プロトコルバージョン定数

| 定数名 | 値 | 説明 |
|---|---|---|
| `VIAL_PROTOCOL_ADVANCED_MACROS` | `2` | ディレイ付きマクロ対応 |
| `VIAL_PROTOCOL_MATRIX_TESTER` | `3` | アンロック付きマトリクステスター |
| `VIAL_PROTOCOL_DYNAMIC` | `4` | Dynamic Entry (Tap Dance, Combo) |
| `VIAL_PROTOCOL_QMK_SETTINGS` | `4` | QMK Settings |
| `VIAL_PROTOCOL_EXT_MACROS` | `5` | 2 バイトマクロキーコード |
| `VIAL_PROTOCOL_KEY_OVERRIDE` | `5` | Key Override |
