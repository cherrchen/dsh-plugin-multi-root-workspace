<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | [English](./README.en.md) | 日本語 | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)

</div>

## プロジェクト概要

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) は、既定では新しいワークスペースを作成するディレクトリをエージェントのプライマリディレクトリとして扱い、既定のワークスペース読み書きモード（`workspace-write`）では、サンドボックスの読み書き範囲もその 1 ディレクトリだけに限定されます。本プラグインは DSH のワークスペース範囲を「1 つのプライマリルート + 複数の追加ルート」に拡張します。

すべてのプロジェクトが monorepo というわけではありません。実際の開発プロジェクトは複数の独立した Git リポジトリからなることが多く、リポジトリをまたいで作業するにはセッションを何度も切り替える必要がありました。同種のハーネスはすでに 1 つのワークスペースに複数のフォルダーを追加できます。本プラグインは同じ機能を DSH にもたらします。ほかのリポジトリを追加ルートとして登録し、読み取り専用・読み書き・現在のセッション権限への追従のいずれかに設定すれば、エージェントはその付与範囲内で作業できます。

- **ネイティブツールをそのまま使用**：ローカルワークスペースでは、エージェントは従来どおりネイティブの `read` / `write` / `edit` / `bash` を使い、アクセスできるディレクトリが増えるだけです。
- **実効性のある権限**：各追加ルートは読み取り専用・読み書き・現在のセッション権限への追従のいずれかに設定できます。制限はプロンプトでモデルに注意を促すのではなく、システムサンドボックスが実際に適用します。エージェントのファイル操作と bash コマンドには同じ認可が適用されます。ほかのプラグインが独自に起動したプロセスはこの保証の対象外です。
- **Files タブで追加ルートを閲覧**：Files タブの上部でプライマリルートと任意の追加ルートを切り替えられます。追加ルートでも、ディレクトリツリー、ファイルを開く、外部アプリで開く、右クリックメニュー、自動更新、検索はプライマリルートと同じように動作し、ファイルプレビューのディレクトリナビゲーションもファイルが属するルートを開きます。ホストのバージョンが古い場合、これらの UI 操作の一部は利用できませんが、追加ルートはホスト本来の表示のままです。
- **追加ルートの Skills**：追加ルート内の `.dsh/skills` と `.agents/skills` を自動検出し、`/alias:skill-name` で呼び出せます。ルートごとに個別のスイッチがあり、既定では有効です。
- **Auto Review（実験的、既定では無効）**：プラグインマネージャーで手動で有効にすると、自動レビューも追加ルートのディレクトリ構造、アクセスレベル、指示ファイルを参照し、追加ルートをレビュー対象に含めます。
- **Worktree の提案（実験的、既定では無効）**：プライマリルートが Git worktree の場合、同じリポジトリのほかの worktree を追加ルートとして追加するよう提案します。確認するまで登録されず、自動で追加・削除されることもありません。
- **SSH リモート環境（実験的、既定では無効）**：プラグインの詳細画面で個人用 SSH を有効にすると、登録済みのリモートディレクトリに対して `remote_copy` と `remote_bash` を利用できます。接続とワークスペースのバインドは別々に管理され、呼び出しごとに Registry が許可を判定します。
- **未登録なら未インストール時と同じ**：追加ルートが 1 つも登録されていなければ、動作はプラグイン未インストール時と完全に同じです。設定に誤りがあればエラーを報告し、黙って機能を落とすことはありません。

現在のリリースバージョンは `v0.1.24` です。各バージョンのユーザーに見える変更は [CHANGELOG](./CHANGELOG.en.md)、進捗とリリース状態は[ロードマップ §進捗台帳](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账)を参照してください。

## クイックスタート

プラグインは [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace) で公開されています。CLI プロファイル（`web` / `headless` など）では 2 つのコマンドでインストールできます。

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # 起動方法に合わせて --profile を選択（値は DSH のドキュメントを参照）
```

**DSH Desktop ユーザー**：**プラグイン** ページで `@dsh-electron/dsh-plugin-multi-root-workspace` を入力してインストールします。起動時にエラーが報告される場合は、DeepSeek Harness Desktop を再起動してください。

tarball、GitHub、ローカルソースなどのほかのインストール方法は[インストール](#インストール)を参照してください。

インストール後、セッションで追加ルートを登録します。

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## 動作環境

**プラグインを利用する場合**：以下の表に記載された DSH バージョンのいずれか（範囲指定ではなく完全一致）が必要です。インストールは `dsh plugin` が行うため、ローカルの Node ツールチェーンは不要です。

| DSH 系列 | 対応バージョン |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`、`0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`、`0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`、`0.2.2-rc.4`、`0.2.2-rc.5` |
| `0.2.3` | `0.2.3-alpha.2` |

DSH のバージョンが表にない場合、または `@deepseek-ai/dsh-*` 各パッケージのバージョンが一致しない場合、プラグインは起動しません。動作は未インストール時と同じです。

**ソースからのビルド / コントリビューション**：Node.js `^22.19.0 || >=24`、pnpm `11.25.0`（corepack 経由での有効化を推奨）。開発用に固定している DSH は `0.2.3-alpha.2`（Node ≥24.22.3）です。

**対応プラットフォーム**：macOS（Seatbelt）、Linux（bwrap / Landlock）、Windows（root-set ACL runner）。

## インストール

インストール方法は、コマンドライン（CLI）から行う方法と、Web / Desktop の GUI プラグイン管理から行う方法の 2 つです。どちらか一方で完了します。

### CLI からインストール

`dsh plugin` は 4 種類のインストール元に対応しています。以下では `web` プロファイルを例にしますが、`headless` などの CLI プロファイルも同様です。**DSH Desktop ユーザー**：`desktop` プロファイルは DeepSeek Harness Desktop 内蔵の `dsh` CLI で管理する必要があります。手順は本節の末尾を参照してください。

| インストール元 | コマンド | 説明 |
| --- | --- | --- |
| npm レジストリ（推奨） | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | ビルド済み成果物。すぐに使えます |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | インストール時にソースから自動ビルド。`allowBuilds` に本パッケージの exact key が必要。バージョン固定を推奨 |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | ビルド済みのオフラインパッケージ。社内ネットワークやオフライン環境に適しています |
| ソースから | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm の `link:` でローカル checkout をリンク。開発・デバッグ向け。`allowBuilds` は不要 |

#### npm からインストール（推奨）

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

ビルド済みの成果物がインストールされます。

#### tarball からインストール

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# または GitHub Release のアセットからダウンロード（例）：
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.24/dsh-electron-dsh-plugin-multi-root-workspace-0.1.24.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.24.tgz
```

こちらもビルド済みで、社内ネットワークやオフライン環境への配布に適しています。

#### GitHub からインストール

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

GitHub からのインストールではソースコードを取得し、`add` 時に自動でビルドするため、手動でのビルドは不要です。pnpm は本パッケージ自身の `prepare` をブロックし、exact key（インストール元と commit を含む）を 1 行出力します。その行をそのまま `allowBuilds` に記述して `add` を再実行してください。

```yaml
allowBuilds:
  # キーと値は pnpm のエラーにある「Add the package to allowBuilds」の例から取得。
  # パッケージ名だけを書き、インストール元と commit を付けないキーは git ソースには効かない。
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

バージョンを固定する（例：`#v0.1.24`）ことを推奨します。後からの push によって実際に動作する内容が黙って変わるのを防げます。

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.24
```

#### ローカルソースからインストール

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> `dsh` が PATH にない場合（DSH をソースチェックアウトから実行している場合など）は、コマンド内の `dsh` を `pnpm dsh` に置き換えてください。

<details>
<summary>実行方法</summary>

開発時のセルフチェック：

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

DSH ランタイムにインストールし、構成を確認します。

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

期待される出力：

```text
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true
--
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
--
# == @dsh-electron/dsh-plugin-multi-root-workspace
- id: multi-root-compat
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/compat'
- id: multi-root-fs
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
- id: multi-root-sandbox
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
- id: multi-root-providers
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/providers'
- id: multi-root-scope
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  config:
    toolAccess: {}
- id: multi-root-registry
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
- id: multi-root-instructions
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/instructions'
  config:
    maxBytes: 65536
- id: multi-root-lsp
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/lsp'
- id: multi-root-workspace-files
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/workspace-files'
- id: multi-root-command
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
- id: multi-root-client
  name: '@dsh-electron/dsh-plugin-multi-root-workspace'
```

上流の `fs-sandbox` と `sandbox` の 2 行が無効化され、プラグインの同名サービスが引き継ぎます。プラグイン自身の `multi-root-*` 行はすべてマウントされます。起動後、サイドバー下部に **フォルダー** アクション（workspace tree のグリフ）が表示されます。DSH `0.2.1-alpha.3` 以降のランタイムでは、新規セッションページのワークスペース行の右端にも同じ入口が表示されます。

</details>

#### DeepSeek Harness Desktop 内蔵 CLI からインストール

DeepSeek Harness Desktop では、アプリケーションメニューの「dsh コマンドの管理…」からグローバルな `dsh` コマンドをインストールできます。`desktop` プロファイルはこのコマンドで管理してください。

1. トレイアイコンを含め、Desktop を完全に終了します。
2. 新規インストール：
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24
   ```
3. インストール済みだが bundle 登録がない場合：`remove` してから `add` します（`add` だけを再実行しても登録は補われません）。
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24
   ```
4. `$DSH_HOME/profiles/desktop/package.json`（`DSH_HOME` が未設定の場合は通常 `~/.dsh/profiles/desktop/package.json`）を開き、`dsh.profile.bundles` に本パッケージが含まれていることを確認します。
5. Desktop を再度起動します（コールドスタート）。

`add` が終了コード 0 で終わったのにプラグインが `dsh.profile.bundles` に入らない場合は、`remove` + `add` を実行してください。ホット有効化の競合の原因、再現記録、実際の書き込み主体の調査は[トラブルシューティング](./docs/troubleshooting/desktop-install-missing-bundle.md)（中国語）を参照してください。

### Web / Desktop の GUI プラグイン管理からインストール

Web と Desktop はどちらもサイドバーの **プラグイン** ページからインストールします。「プラグインを追加」を選び、入力欄に `@dsh-electron/dsh-plugin-multi-root-workspace` を入力してインストールします。インストール後に「今すぐ有効化」を選んでください。インストールだけでは本プラグインは有効になりません。**プラグイン** ページに「プラグインを追加」の入口がない場合は、前述の CLI でインストールしてください。

インストールまたは有効化の後は、DeepSeek Harness アプリを再起動してください。Desktop はトレイアイコンを含めて完全に終了してから再度開きます。Web は `dsh web` プロセスを再起動します。実行中のアプリで本プラグインをホット有効化すると、`fs` / `sandbox` の重複登録でエラーになることがあります。再起動すれば正常に読み込まれます。

## 使い方

### コマンド

```text
/workspace-folders [list]                                                   # プライマリルートと追加ルートを一覧表示（各ルートの権限と状態を含む）
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # パスを省略するとシステムのディレクトリ選択ダイアログを開く。新規登録の既定は inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # /workspace-folders add のショートカット
/workspace-folders access <order|path> inherit|read-only|read-write         # アクセスレベルを切り替え（権限の拡大にはそのルートが現時点で利用可能であることが必要）
/workspace-folders skills <order|path> on|off                               # そのルートの Skills を個別に開閉（書き込み権限は変更しない）
/workspace-folders alias-id <order|path> <kebab-case>                        # 安定した Skill 名前空間を編集
/workspace-folders alias <order|path> [alias]                               # エイリアスを省略すると既存のエイリアスをクリア
/workspace-folders remove <order|path>                                      # 番号は list 出力の番号
/workspace-folders reveal <order|path>                                      # ファイルマネージャーで表示
/workspace-folders isolate-profiles [--apply]                               # 確認（--apply なら書き込み）profile の依存関係インポート方式
/workspace-folders help                                                     # コマンドのヘルプを表示
```

- パスは引用符で囲むこともでき、`~` は展開されます。重複したパス、既存ルートの内側に入れ子になったパス、プライマリルート自身、`$DSH_HOME` / レジストリのストレージディレクトリなどの保護されたパスは拒否されます。
- `remove` / `access` / `alias` / `reveal` は「番号またはパス」を受け付けます。`add` でパスを省略するとシステムのディレクトリ選択ダイアログを開きます（ホストが提供している場合）。権限フラグだけを指定することもできます。
- `list` は各ルートの権限と状態を表示します。ディレクトリが一時的に存在しない場合（`missing`）や、別の場所を指すリンクに置き換えられた場合（`redirected`）は、登録は保持されますが付与は行われません。ディレクトリが復元した後、`list` を 1 回実行するか「ワークスペースフォルダー」を更新すれば自動的に復旧します。
- `isolate-profiles` は Windows の制限付き Full-access 向けの事前確認です。既定では `$DSH_HOME` 配下の各プロファイルの `packageImportMethod` を確認するだけで、`--apply` を指定すると `copy` 設定を書き込みます。`node_modules` の削除や既存依存関係の変更は行いません。

### アクセスレベル

| アクセスレベル | `workspace-write` セッション | `read-only` セッション | `danger-full-access` セッション |
| --- | --- | --- | --- |
| `inherit`（新規登録の既定） | 書き込み可 | 書き込み拒否 | 制限なし |
| `read-only` | 書き込み拒否 | 書き込み拒否 | 書き込み拒否（Full-access を含む） |
| `read-write` | 書き込み可 | 書き込み可 | 書き込み可 |

- 新規登録の既定は `inherit` です。権限の変更は以降の呼び出しと新しいプロセスにのみ適用されます。起動済みのプロセスと永続ターミナルは、起動時の権限を保持します。
- ユーザーが単一の呼び出しに対して承認した `danger-full-access` の一時的な昇格は、その呼び出しに限り読み取り専用ルートとツール単位の上限による拒否を解除します。`$DSH_HOME` と Registry Authority が利用できない場合の降格は引き続き適用されます。
- 1 つのプライマリルートに登録できる追加ルートは最大 16 個です（`maxAdditionalRoots` で最大 64 まで引き上げ可能）。ホストは `multi-root-scope` の `toolAccess` を使って、特定のツールをすべての追加ルートに対して恒久的に制限できます。たとえば `{ bash: 'read-only' }` を指定すると、bash はどの追加ルートにも書き込めなくなります（プライマリルートには引き続き書き込めます）。

### 追加ルートの Skills

- 各追加フォルダーの `.dsh/skills` と `.agents/skills` が自動検出されます。名前と説明は最初のモデルステップの前に確認でき、本文は必要に応じて読み込まれます。
- プライマリルートでは `/skill-name`、追加ルートでは `/alias-id:skill-name` を使います（スラッシュメニューで補完可能）。モデルはネイティブの `skill` ツール経由で呼び出すため、ツールログには内部 ID が表示されることがあります。
- 新規登録の `inherit` / `read-write` ルートでは Skills が既定で有効、`read-only` ルートでは無効です。ダイアログではルートごとのスイッチと `aliasId` の編集ができます（表示用の Alias を変更しても `aliasId` は変わりません）。読み取り専用ルートで Skills を有効にしても書き込み権限は付与されません。
- サイドバーの **プラグイン** ページで Multi-root Workspace の詳細ページを開きます。設定カードの **追加ルートの Skills を有効にする** はすべての追加ルートに作用し、既定では有効です。無効にすると新しい検出と呼び出しが停止しますが、各ルートの選択は保持されます。プライマリルートの Skills、指示、LSP、ファイル閲覧、サンドボックス権限には影響しません。

### Worktree 追加ルートの提案（実験的、既定では無効）

プライマリルートが Git worktree のルートである場合、プラグインは同じリポジトリのほかの worktree を候補として 1 つの提案カードにまとめて表示します。これには以前にターミナル、IDE、forge で作成された worktree も含まれます。セッション自体が `workspace-write` の linked worktree である場合は、そのリポジトリのメイン checkout も候補になります。検出は Git のメタデータを読むだけで、Git のサブプロセスは起動しません。**ルートを自動で追加・削除することはありません**。`danger-full-access` のセッションでは提案を表示しません。サイドバーの **プラグイン** ページで Multi-root Workspace の詳細ページを開き、設定カードの **Worktree の追加ルート提案を有効にする**（既定では無効）をオンにすると有効になります。

提案は常設カードです。「表示」または「後で通知」（新しい worktree が現れるまで / 7 日後 / 30 日後）を選べます。右上の閉じるボタンは今回の通知を閉じるだけで、再起動後に再び表示されます。閉じた後は、「ワークスペースフォルダー」ダイアログの「再試行」の横にある「Worktree の提案」から開き直せます。確認ダイアログには各候補のパス、ブランチ、権限（既定は `inherit`、読み取り専用または読み書きに変更可能）が 1 行ずつ表示され、候補が複数ある場合はチェックボックスで選択できます。メイン checkout の行にはその範囲（メイン checkout のソースツリー、共有の config/hooks/refs/objects、すべての worktree の管理データ）が追加で説明され、同じリポジトリのほかの checkout に影響する可能性があります。登録はワークスペース単位であるため、**ほかの読み書きセッションも選択した権限を取得します**。確認時に各行が再度検証され、その間に変更があればその行は無効になります。ダイアログでは「今後表示しない」を選ぶこともできます。

worktree が削除または移動されると、ダイアログにバッジが表示されますが、**自動でクリーンアップされることはありません**。ディレクトリが存在しないことが確認され、かつ登録時の同一性が一致した場合にのみ（一括または行単位で）クリーンアップの入口が提供され、その上に重なる確認ダイアログで確定します。クリーンアップ前に同じパスへ新しいディレクトリが現れると、古い認可を継承する可能性があり、確認ダイアログはそのリスクを明示します。

### Auto Review 連携（実験的、既定では無効）

複数ルートのレビューコンテキストが必要な場合は、サイドバーの **プラグイン** ページにある Multi-root Workspace の詳細ページで、コンポーネント一覧の既定で無効の Auto Review 行を有効にします。同じ設定カードにある「マルチルート Auto Review（実験的）」スイッチも同等で、こちらも既定では無効です。通常のインストールでは Auto Review の有効化や選択は行われません。この連携は、それを提供する DSH の完全一致バージョンでのみ利用できます。

### SSH リモート環境（実験的、既定では無効）

Issue #32 で現在利用できるのは個人用 SSH のみです。プラグインの設定で **SSH リモート環境** を有効にし、リスクを確認してください。SSH 認証情報はローカルの DSH Host が保持し、同じ OS アカウントで動くプロセスからアクセスできる場合があります。設定の「リモート SSH → 管理」または Workspace Folders の「SSH リモートを管理」から接続を管理できます。

**個人モード**。「SSH リモートを管理」→「接続を追加」を開き、ホストと認証情報を入力し、ホスト鍵を確認して接続を保存します。ステップ 2 で Node を検出し、Helper をインストールしてから、「コマンド実行を許可」を選び、「完了」を押して保存します。Workspace Folders に戻り、「リモートルートのバインドを管理」で接続とディレクトリを選んで権限を設定し、リモート作業ディレクトリの行にある「…」から登録します。同じ接続に複数のディレクトリをバインドできます。

ツールを利用するには互換性のある SSH ランタイムが必要です。Registry は呼び出しごとに、現在のワークスペースに登録されているディレクトリへのアクセスを許可するか判定します。SSH を無効にすると、ツールがアンロードされ、リモート制御プレーンが停止します。詳しい手順は [SSH リモート環境ガイド](./docs/guide/user/ssh-remote-environments.en.md)（英語）を参照してください。

### UI の入口

- **サイドバーと新規セッションページ**：サイドバー下部の **ワークスペースフォルダー** アクションで「ワークスペースフォルダー」ダイアログを開きます。DSH `0.2.1-alpha.3` 以降では、新規セッションページのワークスペース行の右端にも同じ入口があります（シェブロンなし、狭いウィンドウではアイコンのみ）。ダイアログではルートの追加・削除、エイリアスと権限の編集、ルートごとの Skills の開閉、パスのコピー、ファイルマネージャーでの表示、一覧を更新する「再試行」と「Worktree の提案」の入口を利用できます。
- **ワークスペース行のメニュー**：ワークスペース行の `…` メニューと右クリックメニューに「ワークスペースフォルダーを管理…」があります。現在のセッションがそのワークスペースに属していれば直接開き、そうでなければまずそのワークスペースの空白ページを開くか再利用し、そのセッションが現在のセッションになってから開きます。
- **Files タブ**：ヘッダーのルートスイッチャーでプライマリルートと追加ルートを切り替えられます。追加ルートを選択すると、ディレクトリツリー、ファイルを開く、アプリで開く、右クリックメニュー、自動更新、ワークスペース検索がすべてそのルートに従い、プライマリルートに戻すとネイティブの表示に復帰します。

### モデル側

追加ルートのトポロジーはシステムプロンプトに注入され、認可が変わると更新されます。新しいツールは不要です。追加ルート自身の `AGENTS.md` / `CLAUDE.md` も必要に応じてコンテキストに入ります。ルート直下のファイルはセッションの最初のステップより前に、サブディレクトリのファイルは本セッションがそのディレクトリで正常に作業した後に注入されます。

機能ごとのより詳しい操作方法は[ユーザーガイド](./docs/guide/user/README.en.md)を参照してください。

## プロジェクト構成

```text
.
├── src/
│   ├── roots.ts                      純粋なルール層：canonical 化、競合検証、登録状態の分類（available/missing/redirected/invalid）
│   ├── registry.ts                   ルートレジストリ：dsh-storage-domain による永続化、単一のストレージコアと Host facade、store-wide な admission/変更の順序付け
│   ├── registry-lease.ts             プロセス間 Registry Authority：POSIX flock（プロセス終了時はカーネルが解放）
│   ├── registry-lease-win32.ts       同上、Windows named semaphore 実装
│   ├── scope.ts                      ctx.multiRootScope：唯一の認可ソース。モデルに公開されるトポロジースナップショットも発行
│   ├── fs.ts                         マルチルートのファイルシステム provider（プロセス内 fence、上流の LocalFileSystem を継承）
│   ├── sandbox.ts                    マルチルートのカーネルサンドボックス provider（上流の LocalSandboxProvider を継承）
│   ├── dialects.ts                   Seatbelt / bwrap / Landlock プロファイルの認識と追加 grant の組み立て（未知の形式は明示的にエラー）
│   ├── windows-*.ts                  Windows root-set ACL runner と restricted-token 実行
│   ├── containment.ts                パス包含判定（字句的な高速パス + dev/ino エイリアスへのフォールバック）
│   ├── instructions.ts               追加ルートの AGENTS.md / CLAUDE.md の検出、増分配信、予算、撤回（直下 + 本セッションが触れたサブディレクトリ、agent/pre-step から注入）
│   ├── lsp.ts                        追加ルートごとに、そのルートを基準とした独立した LSP workspace を初期化
│   ├── workspace-files.ts            Files タブの追加ルートファイル閲覧に対する host 側のルーティングと封じ込め
│   ├── compat.ts                     multi-root-compat の起動ゲート（バージョン allowlist と混在インストール判定）
│   ├── compat/                       バージョン差異の適応層：dsh-version / sandbox-confine / agent-instructions / llm-message など（オプション peer は必要に応じて読み込み）
│   ├── command.ts                    /workspace-folders コマンドとパネル RPC の host 側
│   ├── worktrees.ts                 Worktree 追加ルート提案行：検出/有効化/watcher、prompt キューと待機側、確認と明示的なクリーンアップ
│   ├── worktrees/                   制御された Git メタデータスナップショット（config/HEAD/index/祖先チェーン）、inventory、sidecar と owner の再検証（Git は起動しない）
│   ├── worktrees-contract.ts         Worktree エンドポイントの両端で厳格な契約（判別可能なユニオン、retry フィールド禁止）
│   ├── contract.ts                   パネルのワイヤプロトコル（zod による両端検証、ブラウザ bundle にインライン化可能）
│   └── client/                       ブラウザ側：サイドバーアクション、フォルダーダイアログ、Files タブのルートスイッチャー、DSH の 8 言語の辞書
├── tests/                            差分 parity、方言の実実行マトリクス、契約のラウンドトリップ、コンポーネントと locale のゲート、プロセス間 lease e2e、指示注入
├── scripts/                          スモーク（compose / behavior / journey）、ドキュメントとカーネル runner のチェック、互換性契約チェック、アップグレード手順
└── docs/                             要件、アーキテクチャ、意思決定記録（ADR）、計画、開発ワークフロー
```

## コントリビューション

Issue と Pull Request を歓迎します。

1. まず [`AGENTS.md`](./AGENTS.md)（リポジトリ全体のルール）と[開発ワークフロー](./docs/development/plugin-development-workflow.md)（環境、コマンド、ランタイムのサポートマトリクス、アップグレード手順）を読んでください。
2. `main` からブランチを作成してください。コミットメッセージは conventional commits（`feat` / `fix` / `perf` / `refactor` + scope）に従います。既存の履歴を参照してください。
3. PR の前に、以下がすべてローカルで成功している必要があります：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm docs:check`、`pnpm smoke`（CI も同じ順序で実行し、build の後に test を行います）。
4. 動作を変える変更では、同じ変更の中で `docs/` 配下の対応するドキュメントも更新してください。ルート README は 8 言語版を同期させてください（中国語版が正です）。トレードオフを伴うエンジニアリング上の決定は ADR として記録してください。
5. 厳格な制約：**上流リポジトリ（deepseek-harness）のいかなるパッケージも変更しないこと**。プラグインは out-of-tree の拡張に留まります。

詳細なルールは[CONTRIBUTING.md](./CONTRIBUTING.md)を参照してください。

## 既知の制限

### プラグイン機能

- 追加ルートの指示ファイルは必要に応じてモデルに届きます。ルート直下のファイルはセッションの最初のステップより前に注入され、サブディレクトリのファイルは本セッションがそのディレクトリで**正常に**作業した後に注入されます。ネストしたファイルは、そのディレクトリが確認対象になったときにのみ再確認されます（ルート直下は毎ステップ、サブディレクトリは配信済みであるか新しいタッチがあった場合）。配信状態はプロセス内に保持されるため、resume 後に再度通知されることがあります。公式に認識されるのは `read` / `write` / `edit` で、OPS 互換モードを有効にすると OPS ツールも live な証拠によって同様に配信を駆動します（resume 後、live な証拠を欠く OPS 履歴は配信に関与しません）。プライマリルートと user-global の指示チェーンは引き続き上流の責務であり、本プラグインが重複して注入することはありません（[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)）。
- 複数の Host が 1 つの登録サービスを共有します。ストレージを管理する Host は 1 つだけで、各インスタンスは操作ごとに認可を取得します。接続が切れると新しい追加ルートの付与は停止し、Registry Authority プロセスが終了するとカーネルリースに従って後継が引き継ぎます。共有は同一マシン・同一ユーザー・同一ロック名前空間に限られ、Linux では SO_PEERPIDFD が必要で、Windows では同一ログオンセッションに限定されます。既存のプロセスと PTY は起動時のスナップショットを保持します（[共有アーキテクチャ](./docs/architecture/registry-authority-service.md)、中国語）。
- サポートマトリクスは完全一致バージョンの allowlist です。ホストのバージョンが一覧にない場合、またはコアパッケージが異なるバージョンで混在している場合、`fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` の 6 行は**起動せず**、構成は「このプラグインが未インストール」の状態に縮退します（[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。
- Windows のマルチルート runner は、上流の部分的な強制適用、呼び出し元所有ディレクトリの要件、private temp の分離条件を継承します。起動済みのプロセスは起動時のルート集合を保持し、以降のプロセスは更新後の集合を使用します（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows ではネットワークパスとデバイスパスを追加ルートにできません**：UNC（`\\server\share`）、`\\?\`、`\\.\`、およびマップされたネットワークドライブは、登録時に `unsupported-path` で拒否されます。restricted token の capability SID は SMB アクセスにバインドできることを示せないためです（[ADR-0011 改訂](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows の制限付きシェルは pwsh で、Git Bash は含まれません**：MSYS は書き込み制限付きの Low-integrity token では起動できません（上流 runner とプラグイン runner で同じ挙動であり、上流の制限です）。また、上流の confined 子プロセスは runner の ignore-Ctrl+C フラグを継承するため Ctrl+C を受け取れません。プラグイン runner では子プロセスが Ctrl+C を受け取り、runner がその終了コードを反映します。
- 追加ルートのアクセスレベルは 3 状態です。新規登録の既定は `inherit`（セッションモードに追従）で、`--read-only` はどのモードでも書き込みを拒否します（Full-access を含む。唯一の例外は、ユーザーが単一の呼び出しに対して承認した一時的な昇格です — [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)）。固定の `--read-write` は読み取り専用セッションでも書き込み可能なままで、これは書き込み権限の問題であり、読み取りの封じ込めではありません（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。起動済みのプロセスと永続ターミナルは起動時の deny 集合を保持します。あるルートが読み取り専用になる前に起動したターミナルは、再起動するまで制限されないままです。cap/access の変更は以降の呼び出しと新しいプロセスにのみ適用されます（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)）。workingDirectory を提供するホストは、追加ルートを後続ツールの実行ディレクトリとして使用できますが、セッションの元のプロジェクトと登録 ID は変わりません（[ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)）。
- **上流が Landlock を選択する Linux ホストでは、制限付き Full-access に bwrap が必要です**：Landlock の allowlist では「これらのルートを除くすべてを書き込み可能」と表現できないため、この組み合わせでは bubblewrap を選択して拒否境界を組み立てます。利用可能な bwrap がないホスト（未インストール、または非特権ユーザー名前空間が無効）では、拒否境界（読み取り専用ルートまたは保護された `$DSH_HOME`）を伴う Full-access コマンドは起動前にフェイルクローズします。bwrap を有効にするか、そのホストでは Full-access 下で明示的な読み取り専用ルートを使用しないでください（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- 追加ルートのファイルツリーは **Files タブのルートスイッチャー** が担います。ヘッダーの入口にはプライマリルートとすべての追加ルートが一覧表示され、その横には選択中のルートの完全なパスが引き続き表示されます。追加ルートを選択すると、上流の Files ツリーをバイト単位で再現したツリー本体がツリー領域を引き継ぎます（ディレクトリの遅延読み込み、ネイティブの行とアイコン、watch による自動更新、ファイルクリックでホストのビューアーを開く、ヘッダーの元の位置での手動更新）。ヘッダー右側の「アプリで開く」ボタンも上流のコントロールをバイト単位で再現したものに置き換わり、プライマリルートではなく選択中のルートに対して開きます。プライマリルートに戻すとネイティブの表示に復帰し、ダイアログは純粋な管理機能に戻ります。追加ルートの行には、プライマリルートと同じ行の右クリックメニュー（ファイル行、ディレクトリ行。ファイルプレビューの Folder ナビゲーションツリーでも同様に有効）と、選択中のルートに対するワークスペース検索（ヘッダーの検索ボタン、検索バー、ヒットを強調する結果ツリー、設定ポップオーバー、非表示項目のフィルター）も提供されます。どちらもホストが対応する構造を公開している場合にのみ表示されます。行の右クリックメニューには `useContextMenu`（`0.2.2-alpha.3` 以降）、検索には `workspaceFiles.search`（`0.2.2-rc.2` 以降）が必要で、それより古いホストでは行メニューをバインドせず検索入口も描画せず、表示は変わりません。この引き継ぎは上流の `data-*` DOM フックに依存しており、フックが一致しなくなるとネイティブの見た目に静かに退化します（[ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)）。LSP は追加ファイルが属するルートを基準に独立した workspace を初期化します。ホスト側で対応する言語サーバーの設定が必要です（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。既知の境界：ネイティブの Files ショートカット **Cmd+P** は引き継ぎで隠れているネイティブの検索ボックスにフォーカスするため、ネイティブのショートカットを追加ルート検索の入口としては扱いません。Files ページとプレビューナビゲーションツリーの検索面はどちらもこれに応答しません（[ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md)、[ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)）。プレビューナビゲーションツリーの検索履歴は `(pane, root)` 単位で保存され、Files ページの `(tab, root)` とは分かれているため、同じ pane の Files ページのクエリがプレビューに持ち込まれることはありません。結果の現在行はマークされるだけで自動スクロールせず、Folder を閉じるか同じ pane でルートを切り替えると、未保存の設定ドラフトは破棄されます（[ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)）。
- サードパーティのプラグインが Files タブ全体を引き継いだ場合（`priority: "extension"` で `files` kind を登録）、ルートスイッチャーと追加ルートの閲覧は利用できません。プラグインはホスト標準の info レベルの一時通知を 1 回表示し、引き継ぎが解除されると再度表示できるようになります。ルートの管理はサイドバーの「ワークスペースフォルダー」と `/workspace-folders` から引き続き行えます（[Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)）。
- コマンドの出力文言は英語です（host 側ハンドラーには参照できるアクティブなロケールがないため）。パネルの文言は UI の言語に追従し、DSH が提供する 8 言語に対応します。
- ワークスペースフォルダーパネルは「サイドバー下部のアクション + ダイアログ」であり、独立した全画面パネルではありません。`sidebar.footer.action` はすべてのサポート対象バージョンが提供するスロットですが、`sidebar.panellist`/`main` はそうではありません。DSH `0.2.1-alpha.3` 以降では、新規セッションページの `conversation.hero.options` スロットにも追加の入口が取り付きます。これは隣接するワークスペース/モードセレクターと同じジオメトリを持ち、シェブロンなしで、ワークスペース行内で実測した余剰スペースに応じて縮小し、余剰が 88px 未満になると 28×28 のアイコンボタンに退化します（上流の options コンテナは `flex: none` のため、プラグインは DSH を変更せず、余剰を測って自身をクランプします。プローブが行構造を認識できない場合は 560px ビューポートのフォールバックに切り替わります）。このスロットが古いランタイムで存在しない場合、登録は静かに行われず、サイドバーの入口には影響しません（[ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)）。サイドバー入口の rail（折りたたみ状態）の角丸には、独自のより早い境界 `0.1.6-alpha.2` があります。23 個のサポート対象バージョンではホストと同じ 12px の角丸四角ですが、最も古い 2 バージョン（`0.1.5-rc.2`、`0.1.6-alpha.1`）ではホストが円を描き、プラグインは 12px の角丸四角を描きます。これは記録済みの角丸のずれです（ink/レイアウトへの影響なし）。`@media (hover: hover)` のラップは新しいジオメトリの 6 バージョンにのみ存在し、プラグインはラップしないままなので、タッチデバイスではこれらのバージョンと hover フィードバックが異なります（[ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）。サイドバー入口の高さは同じ列の設定行の占有要素に従い、アカウントランチャーの `data-signed-out` 構造マーカーに依存します（CSS の `:has()` 依存であり、スロットの契約ではありません）。`0.1.7-rc.2` 以前の 7 バージョンは 42px の設定トリガー高を踏襲し、`0.2.0-rc.1` 以降は未ログイン 32px / ログイン済み 44px、rail は固定 36px です。マーカーの名前が変わったり消失したりした場合は 42px にフォールバックし（誤ったサイズにはなりません）、影響するのは高さだけです（[ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）。

### OPS 連携

現在の実装は **OPS 互換モード（実験的、既定では無効、制限がある場合があります）** として提供されています。`設定 → プラグイン → Multi-root Workspace` で `multi-root-ops-compatibility.enabled` を設定します。既定は `false` で、明示的に有効化する必要があります。この機能は既存の完全一致サポートマトリクス内の DSH `0.2.*` でのみ有効にできます。`0.1.*` では手動で `enabled: true` を設定しても無効のままで、旧版の Settings UI も提供されません（[バージョン範囲の決定](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)、中国語）。設定画面から有効にする場合は、公式のリスクダイアログを読み、制限を理解したことを確認して再度確定する必要があります。確定するまで無効のままで、キャンセル、ダイアログを閉じる、Esc のいずれでも有効化設定は保存されません。

- **有効時**：OPS の実行保護、リアルタイムアクティビティ、Review 拡張を有効にします。Full-access（`danger-full-access`）では、検証済みの macOS/Linux プラットフォームでカーネルによる封じ込めにより明示的な RO/cap の拒否境界を適用します。Windows では、deny を伴う OPS 実行呼び出し（読み取りを含む）を Worker の準備前に保守的に拒否します。この組み合わせでの保護された準備と正当な書き込みはまだサポートされていません。WW/RO では、書き込み不可の追加ルートまたはツールの書き込み上限が 1 つでもあると、読み取り/page を含む OPS 実行呼び出し全体が準備と実行の前に拒否されます。すべてのモードで、Registry Authority が利用できない場合は OPS 実行呼び出しを拒否します（純粋な検出/公開は除く）。実行ドメインまたはその時点で有効なプロファイルによる証明がないサブプロセス起動も拒否され、バックグラウンドのクリーンアップが境界を迂回するのを防ぎます。これによりサードパーティのバックグラウンドプロセスも拒否されることがありますが、パネル内のユーザー自身のターミナルは対象外です。
- **無効時**：この適応前の OPS の動作に戻り、これらのセーフガードは提供されません。**明示的な読み取り専用の追加ルートに OPS が書き込む可能性があります**。通常のマルチルート機能、ネイティブツールのフェンス、Auto Review 自体のスイッチには影響しません。配信済みの指示が遡って消去されることはなく、保護された実行ドメインに入った呼び出しと起動済みのプロセスは元のスナップショットを保持します。無効化後に開始される新しい呼び出しは、この適応を有効化しません。
- **実験上の制限**：Phase A の live アクティビティインデックスのみを提供し、永続イベントブリッジはありません。有効時は、resume 後に live な証拠を欠く OPS 履歴や動的な pending（replace/batch/result/bash/unknown）により、Review が技術的に失敗します。ホワイトリスト外の診断（`ops_status` など）もこの保守的なルールの対象です。

具体的な既知のギャップ：

- **dsh-ops による読み取り専用制限の迂回（F01、過去のベースライン）**：監査対象バージョンでは、Full-access 下で OPS Native の `ops_write_file` が明示的な読み取り専用の追加ルートに実際に書き込み、同じ実行のネイティブ fs 対照は拒否されていました。OPS 互換モードを有効にすると、今回の限定的な適応により、Full-access 下でも OPS Native と実際の PTC に対して明示的な RO/cap の拒否境界が有効になります（deny 実行の再検証は[監査 §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)）。バージョン、テスト範囲、元の証拠は[互換性監査](./docs/reviews/dsh-ops-compatibility-audit.md)（中国語）を参照してください。
- **dsh-ops における正当な追加ルート書き込みとサブディレクトリ指示のギャップ（F04/F05、過去のベースライン）**：WW 下の `inherit`/固定読み書きの追加ルート、および RO 下の固定読み書きの追加ルートが OPS の事前チェックで書き込み拒否される問題は未解決です（F04）。OPS の読み取りがサブディレクトリ指示の検出をトリガーしない問題（F05）は、有効モードでの今回の live インデックス + 実際の AgentLoop により復旧が再検証されています（Native と PTC が正常にタッチしたサブディレクトリの指示が次のモデルリクエストに入ります。[監査 §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)を参照）。検証済みのルート直下の指示と Skills の経路には影響しません。
- **Linux bwrap における WW の batch/result の劣化（F07）**：監査対象の共有レジストリ構成では、起動分岐に到達して有効なキャッシュを取得したすべての `ops_batch` / `ops_result`（`page` を含む）が、封じ込め後に OPS が bind を追加することで argv の帰属証明を失います。ソースパスは Worker の起動を `EXECUTOR_UNAVAILABLE` で拒否します。関数レベルの競合は再現済みですが、Linux でのエンドツーエンド実行は未検証です。通常の RO、Landlock、キャッシュなしの対照はこの結論の対象外です。封じ込め前にキャッシュ要件を宣言する OPS のインターフェースが必要で、現時点で検証済みの MR 単独の緩和策はありません。[監査 F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突)を参照してください。
- **そのほかの OPS 可用性の境界**：共有 WW 下では、ディスパッチ外の purge は有効な admission がないため拒否され、結果キャッシュが残って警告が出ることがあります。ネストした PTC 呼び出しやバックグラウンド Bash も、証明の不一致や期限切れにより拒否されるリスクがあります。今回、保守的な拒否境界の 3 プラットフォームでの検証は完了しています。通常のバックグラウンド実行とクリーンアップは引き続き利用できず、無期限に延期されています。[ADR-0029 の最終範囲](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05)を参照してください。

P5 の本リポジトリ側セーフガードは OPS を変更しません。正当な追加ルートへの書き込みが誤って拒否される可能性は残り、クリーンアップが拒否されると結果キャッシュが残留することがあります。共有レジストリを使わない legacy モードでは、WW/RO の PTC もコードプロセスの起動前に拒否されることがあります。永続アクティビティは引き続き無効です。DSH の `appendPluginRecord` は外部プラグインからの呼び出しを明示的に禁止しており、通常のイベントやログへの直接書き込みで代替することはできません。P6 は限定された範囲で技術的受け入れを完了しています。P5 の残りの機能と OPS 完全互換の受け入れは**無期限に延期**され、今回の受け入れ条件には含まれません。将来復旧する場合も実験的な機能としてのみ提供されます。延期リストは [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源)、受け入れ範囲は[完了済み計画](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md)（中国語）を参照してください。

今回の実験的な保守的セーフガードは `v0.1.15` でリリースされました。OPS の完全互換を主張するものではなく、サポートバージョンを拡張するものでもありません。監査 §16 の過去の再検証はこのスイッチが追加される前に行われたもので、有効化した場合の経路に対応します。再実行する際は明示的に `enabled: true` を指定する必要があります。

## ドキュメント

プロジェクトの長期ドキュメントは [`docs/`](./docs/README.md) にあります。

- [バージョン変更履歴（CHANGELOG）](./CHANGELOG.en.md)
- [ユーザーガイド](./docs/guide/README.en.md)
- [要件](./docs/requirements/multi-root-workspace.md)
- [目標アーキテクチャ](./docs/architecture/multi-root-workspace.md)
- [上流調査](./docs/reference/multi-root-workspace-research.md)
- [意思決定記録（ADR）](./docs/decisions/README.md)
- [計画](./docs/plans/README.md)
- [開発ワークフロー](./docs/development/plugin-development-workflow.md)
- [トラブルシューティング](./docs/troubleshooting/README.md)

Coding Agent 向けのリポジトリ全体のルールは [`AGENTS.md`](./AGENTS.md) に定義されています。

## ライセンス

[MIT](./LICENSE)

サードパーティライセンス：[THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
