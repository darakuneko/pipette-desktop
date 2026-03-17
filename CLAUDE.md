# プロジェクトガイドライン

## 開発ワークフロー

**原則:** フィーチャーブランチ必須、TDD、`main` 直接コミット禁止。
テストは仕様と実装の間の契約 — テストのないコードは未完成とみなす。
プラン完了時にpushoverを呼ぶ

1. **計画記録** — `.claude/tasks/backlog` に保存
2. **チーム編成** — impl/review/PM で役割分担、単独作業は禁止
3. **ブランチ作成** — `git checkout -b feature/<name> main`
4. **仕様** — Python リファレンス確認（`.claude/docs/REFERENCE-INDEX.md`）
5. **テスト** — 仕様をアサーションとしてエンコードするテストを記述
6. **テストレビュー** — Codex でテストをレビュー
7. **実装** — テストをパスするコードを記述、アトミックコミット
8. **検証** — `pnpm test` / `pnpm build` / `pnpm lint` / `pnpm test:e2e` パス
9. **アプリ検証** — `pnpm dev:linux` でアプリ起動し動作確認、終了時はElectronプロセス終了を確認
10. **開発検証** — `pnpm test:e2e:dev` パス（dev実行中）、アプリ検証未実施なら必ず実施
11. **Codex レビュー** — 実装をレビューに提出
12. **マージ** — `main` にスカッシュマージ
13. **マージ後確認** — マージ後の状態が動作することを確認
14. **結果記録** — `.claude/tasks/done` に追記
15. **コンテキスト整理** — `/clear` でリセットし次のタスクへ

**TDD ルール:**
- 新機能は **テストファースト** — マージ前にテストがパスすること
- バグ修正には **回帰テスト** が必要
- `pnpm test` が **CI ゲート** — 全ての PR とマージでパスすること

## アーキテクチャ

```
src/
├── main/        # Electron メインプロセス（IPC, HID, ストア, Hub同期）
├── preload/     # プリロードスクリプト（プロトコル, キーボード通信）
├── renderer/    # React UI（コンポーネント, フック, i18n）
└── shared/      # プロセス共有（型定義, キーコード, エクスポート）
```

**ビルド:** `electron-vite` — main/preload は CJS 出力、renderer は Vite + React

## 言語ポリシー

- **コード/コミット:** 英語、**ドキュメント (`.claude/docs/`):** 日本語
- **UI テキスト:** 全て `t('key')` 経由 — ハードコード禁止（詳細: `.claude/rules/coding-ui.md`）

## Git ルール

**ブランチ:** `main ← feature/<issue#>-<description>` / `fix/<issue#>-<description>`

**コミット:** Conventional Commits — `<type>(<scope>): <description>`
- タイプ: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- スコープ: `protocol`, `ui`, `hid`, `keymap`, `build`, `macro`, `config`

**PR:** 500行以下推奨、CI パス必須、force-push 禁止（リベース時を除く）、**英語で記述**

PR 本文フォーマット:
```
## Summary
- Bullet points describing changes (1-3 items)

## Root Cause (for fix PRs)
Brief explanation of the root cause

## Changes
- Bullet points of changed files and what was modified

## Test Plan
- [ ] Checklist of test items

Closes #<issue number>
```

**マージ手順・GitHub ルールセット:** `.claude/rules/github-ruleset.md` を参照

## コンテキスト管理

- 無関係な新規作業を始める前に `/clear` を実行
- 無関係なタスク間では頻繁に `/clear` を実行してコンテキストウィンドウをリセット
- 古い履歴はトークンを消費し、パフォーマンスを低下させる

## ドキュメント管理

**権威の所在:**
- `CLAUDE.md` — アーキテクチャと運用ルール
- `.claude/docs/WORKFLOW.md` — 開発フェーズとチーム役割

**タスク記録 (`.claude/tasks/`):**
- `backlog/` — 未完了、`done/` — 完了
- ファイル名: `P{0-3}-<説明>.md`（P0: Critical〜P3: Low）
- 完了時はユーザに移動確認を取り、承認後に `done/` へ移動

**仕様変更:** 乖離を発見した場合は即座に報告

| ドキュメント | パス | 内容 |
|-------------|------|------|
| セットアップ | `.claude/docs/SETUP.md` | 環境セットアップ、コマンド一覧、E2E テストモード |
| ワークフロー | `.claude/docs/WORKFLOW.md` | 開発フェーズ、チーム役割、コーディング規約 |
| リファレンス | `.claude/docs/REFERENCE-INDEX.md` | Python vial-gui モジュールインデックスと TS マッピング |
| テストポリシー | `.claude/docs/TESTING-POLICY.md` | 実機テストの見落とし分析と対策 |
| リリースノート | `.claude/docs/RELEASE.md` | リリース履歴と変更ログ |
| Hub 連携 | `.claude/docs/HUB-INTEGRATION.md` | Pipette Hub アップロード、ローカルテスト手順 |
| データ棚卸 | `.claude/docs/DATA-INVENTORY.md` | データ構造とストア一覧 |
| キーコードパターン | `.claude/docs/KEYCODE-PATTERNS.md` | キーコードのパターンと分類 |
| シンボル定義 | `.claude/docs/SYMBOLS.md` | シンボル定義一覧 |
| ボタンパターン | `.claude/docs/BUTTON-PATTERNS.md` | モーダルのボタン配置・スタイル・ラベル規約 |

## コーディング規約

**パッケージマネージャー:** `pnpm` 必須（`packageManager` フィールドで固定）

**TypeScript:** ESNext, strict, `any` 禁止（`unknown` を使用）、未使用インポート即削除

| 対象 | 規約 | 例 |
|------|------|-----|
| ファイル | kebab-case | `hid-transport.ts` |
| クラス/型 | PascalCase | `KeyboardDevice` |
| 関数/変数 | camelCase | `getKeymap()` |
| 定数 | UPPER_SNAKE_CASE | `MAX_LAYERS` |

**UI:** Tailwind v4 クラス使用、インラインスタイル禁止（詳細: `.claude/rules/coding-ui.md`）

**LLM 痕跡排除:** コミット対象に AI 共著タグ・AI 生成コメント・LLM 名称への言及を残さない
- 対象外: `.claude/` 配下、ログ出力、テストアサーション

**セキュリティ:** `contextIsolation: true`, `sandbox: true`, 厳格な CSP（詳細: `.claude/rules/security.md`）

## 参照インデックス

| rules ファイル | 内容 |
|---------------|------|
| `.claude/rules/team-workflow.md` | エージェントチーム、Codex、MCP、PM 進行管理 |
| `.claude/rules/testing.md` | テストレイヤー、カバレッジ目標、開発フェーズ |
| `.claude/rules/reference.md` | Python リファレンスルール |
| `.claude/rules/coding-ui.md` | Tailwind CSS、i18n 詳細設定 |
| `.claude/rules/security.md` | Electron セキュリティ設定 |
| `.claude/rules/file-splitting.md` | ファイル分割基準、行数目安、違反ファイル一覧 |
| `.claude/rules/github-ruleset.md` | GitHub ブランチ保護ルールセット |
