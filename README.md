# Hybrid Subagents

役割ごとに異なるモデル・プロバイダーを組み合わせて使う専門Agent集です。Pi向けパッケージ **`pi-hybrid-subagents`** と、herdr上のClaude Code・Codex・GitHub Copilot CLIで使うプラグイン **`hybrid-subagents`**（下記「herdr版」）を提供します。

Pi版は、通常のPiをMainにして、4種類の専門Agentを必要に応じて使い分ける軽量パッケージです。OMPの委任・レビュー方針を参考にし、起動、並列実行、結果回収、セッション継続は **pi-subagents** に任せます。

旧称はHyAgentsです。既存設定・保持セッションとの互換性のため、コマンド `/hyagents`、Agent名 `hyagents.*`、Skill名 `hyagents`は維持します。モデル・Thinkingの既存設定もそのまま使えます。Fastの旧独自設定については下記の更新時の注意を参照してください。

## Agent構成

以下は**初期値**です。4役割のモデル・Thinking・Fastモードは `/hyagents models` で変更できます。Workerの `max` も変更可能です。Fastモードの初期値は全役割でoffです。

| Agent | PiのモデルID | Thinking | 担当 |
| --- | --- | --- | --- |
| Main | Piで選択中のモデル | 現在の設定 | 対話、計画、委任、統合、最終判断 |
| `hyagents.worker` | `openai-codex/gpt-6-luna` | `max` | 実装、修正、周辺調査、局所テスト |
| `hyagents.scout` | `openai-codex/gpt-6-luna` | `xhigh` | 対象ファイルが不明な読み取り探索 |
| `hyagents.reviewer` | `openai-codex/gpt-6.1-sol` | `high` | 変更によって導入された具体的な不具合の検出 |
| `hyagents.designer` | `anthropic/claude-opus-5-5` | `high` | UI/UX設計、画面・コンポーネント実装 |

Opus 5.5のPiネイティブIDは `claude-opus-5-5` です。初期設定ではOpenAI側は `openai-codex`、Designerは `anthropic` を使用します。ユーザーが別のPiプロバイダー／モデルを選択できます。暗黙の切り替えは行いません。

## インストール

検証対象: **Pi 1.1.0 / pi-subagents 0.76.1 / Node.js 22.19以上**。旧 `@mariozechner/*` 世代のPiは対象外です。

Piが未導入なら、先に導入します。

```sh
npm install -g @earendil-works/pi-coding-agent@1.1.0
```

次の2つをPiパッケージとして登録してください。

```sh
pi install npm:pi-subagents@0.76.1
pi install npm:pi-hybrid-subagents
```

未公開の最新版を試す場合は、`npm:pi-hybrid-subagents` の代わりに `git:github.com/phni3j9a/hybrid-subagents` を指定します。Pi 1.2では、Hybrid Subagentsだけを更新する場合は `pi update npm:pi-hybrid-subagents`、全パッケージを更新する場合は `pi update --extensions` を使います（`pi update` 単独はPi本体の更新です）。

旧リポジトリ名で導入したGitHub版からnpm版へ切り替える場合は、二重に読み込まれないよう、先に元のソース指定で登録を外してください。モデル・Thinkingの保存済み設定はそのまま使えます。旧独自Fast設定は下記の手順で再設定してください。

```sh
pi remove git:github.com/phni3j9a/HyAgents
pi install npm:pi-hybrid-subagents
```

起動中なら `/reload`、そうでなければ通常どおり `pi` を起動します。**毎回 `/hyagents` やSkillを呼び出す必要はありません。** 4つのAgentはパッケージのmanifestから発見され、Mainへ委任方針が自動適用されます。

`pi-subagents` はHybrid Subagentsの依存パッケージにも含まれますが、これは設定の解決APIと設定エディターを読み込むためです。依存関係のインストールだけでは `subagent` ツールが有効にならないため、上記の `pi install npm:pi-subagents@0.76.1` も必要です。二重にExtensionを読み込ませる必要はありません。

各プロバイダーの認証はPiの通常の方法で設定してください。Hybrid Subagentsは認証情報を管理しません。モデル設定はユーザーが保存操作を行った場合にだけ更新します。

確認用コマンド:

```text
/hyagents
/subagents-models hyagents.worker
```

`/hyagents` は登録モデルと認証設定の準備状況を表示します。APIへの試験リクエストは送らないため、利用権限、期限切れの認証、利用枠の最終確認は実際の子Agent起動時に行われます。モデルが見つからなければPiやモデルカタログを更新してください。

プロジェクト限定で使用する場合は、両方の `pi install` に `--local` を付け、Piの通常のプロジェクト信頼設定に従ってください。

## 普段の使い方

普通に作業を依頼します。

```text
この不具合の原因を調べて修正してください。
この画面をスマホで使いやすくしてください。
この変更をレビューしてください。
```

Mainは小さな作業を直接処理できます。ファイルが不明な読み取り探索はScout、調査から編集まで一続きの仕事はWorker、UI/UXはDesignerへ委任します。Reviewerの起動と再レビューはMainの完全裁量です。

- 並列作業ではファイルの担当と共有インターフェースを先に決めます。
- Worker／Designerは担当範囲の小さなテストを実行できます。
- 全体Build・Lint・Formatter・結合テストは、並列編集の統合後にMainが調整します。
- Reviewerは証拠のある新規不具合だけを報告し、原則として編集しません。
- Planner専用Agent、必須レビュー、合格までの反復、指摘台帳、独自Checkpointはありません。

Scout／Reviewerの非編集方針はプロンプトによる役割定義です。4つのAgentには独自のツール許可リスト・禁止リストを設定しておらず、Pi／OS／既存Extensionの権限設定はそのまま適用されます。

## モデルとThinkingの選択

```text
/hyagents models
/hyagents models worker
/hyagents models scout
/hyagents models reviewer
/hyagents models designer
/hyagents models reset
```

引数なしの `models` は4役割の現在の設定を表示します（Fast有効時は末尾に `fast`）。役割を選んだ後、**プロバイダー → モデル → Thinking → Fast（legacyの `openai-codex` のみ） → 保存先**の順に選択します。`models worker` などではその役割の設定を直接開きます。途中でEscなどでキャンセルすると保存しません。

- モデル候補はPiで認証設定済みのプロバイダーの登録モデルです。実際の利用権限・利用枠は起動時に確認されます。
- Thinkingには、そのモデルが対応する値だけを表示します。推論非対応モデルは `off` です。
- `User — all projects` はユーザー共通設定、`Project — this project only` はプロジェクト設定へ保存します。未信頼プロジェクトでは後者を表示しません。
- プロジェクト設定が優先されます。ユーザー共通設定を変更してもプロジェクト設定が優先される場合は、その旨と実効値を表示します。
- 保存後、**新しく起動する子Agentから反映**されます。設定変更のたびに `/reload` を実行する必要はありません。ほかのPiプロセスの表示は再読込まで古い場合があります。
- 実行中の子Agentは変更しません。保持セッションの再開はpi-subagents標準の動作に従います。新設定を使うには新しい子Agentを開始してください。
- `reset` は保存先を選んで確認した後、4役割のモデル・Thinkingを上表の初期値に戻し、Fastをoffにします。他の設定は維持します。

### Fastモード

**legacyの `openai-codex` プロバイダーに限り**、Fastモードのon/offを選べます。認証方式ではなく、選択モデルのプロバイダー名で判定します。pi-subagents標準の `fast: true` が子のリクエストに `service_tier: "priority"` を付けます。優先処理の利用可否・速度・利用枠や費用への影響はプロバイダー側の扱いに依存します。

- Pi 1.2の `openai`（Sign in with ChatGPTを含む）やAnthropicなどではFast選択を表示せず、offとして保存します。認証やモデルをlegacyへ自動変更しません。
- モデル・Thinking・Fastは、pi-subagents標準の `subagents.agentOverrides` にまとめて保存します。独自のリクエスト書き換えや子拡張はありません。
- 保持セッションの設定はpi-subagentsに任せます。新設定を確実に適用するには新しい子Agentを開始してください。

**v0.3.0からv0.4.0へ更新する場合:** 旧 `~/.pi/agent/hyagents.json`／プロジェクトの `.pi/hyagents.json` は読み書きしません。自動移行・自動削除もしません。Fastが必要なら `/hyagents models` で `openai-codex` のモデルを選んで再保存してください。既存のネイティブ `fast` 設定はそのまま有効です。旧版で作成した保持セッションにもFastや検証拡張の互換性は保証しないため、更新後は新しい子Agentを開始してください。旧ファイルは他の用途に使っていないことを確認してから手動で削除できます。

ユーザー設定は通常 `~/.pi/agent/settings.json`、プロジェクト設定はpi-subagentsが解決するプロジェクトの `.pi/settings.json` です。未信頼プロジェクトの設定は読みません。設定ルートがない場合、プロジェクト保存時に現在のディレクトリへ `.pi` を作成します。パッケージ内のAgent定義を直接編集する必要はありません。

例（Workerだけを変更）:

```json
{
  "subagents": {
    "agentOverrides": {
      "hyagents.worker": {
        "model": "openai-codex/gpt-6.1-sol:high",
        "thinking": "high",
        "fast": true
      }
    }
  }
}
```

通常はコマンドから3項目をまとめて設定してください。手動設定でも `model` のThinking suffixと `thinking` を一致させます。ヘッドレス実行ではこの設定ファイルを利用してください。選択メニューはTUIと選択ダイアログ対応のRPCクライアントで利用できます。

### 起動時のモデル解決

モデル・Thinking・Fastの解決、per-run override、保持セッションの再開はpi-subagentsに任せます。Hybrid Subagents独自のモデル・Thinking一致検証や起動拒否はありません。Mainのモデル／Thinkingは変更しません。設定画面と `/hyagents` では引き続き設定・モデル登録・認証の準備状況を診断します。

既存の `subagents.modelScope` や `maxThinking` など、pi-subagents自身の制限は維持されます。Hybrid Subagentsはそれらを自動で緩めません。provider別overrideも標準の優先順位で解決します。Mainへの委任方針ではユーザーの選択を尊重するよう求めますが、これは独自の起動時ガードではありません。

## Reviewerの出力

`agents/reviewer.md` の `outputSchema` をpi-subagentsへ渡し、ネイティブ `structured_output` で検証します。

```json
{
  "overall_correctness": "correct",
  "explanation": "修正が必要な新規不具合は見つかりませんでした。",
  "confidence": 0.9,
  "findings": []
}
```

指摘には `title`、`body`（問題・発生条件・影響）、P0〜P3に対応する `priority`（0〜3）、`confidence`、`file_path`、`line_start`、`line_end` が入ります。行範囲の差分との対応など意味的な条件はReviewerの指示に含めています。スキーマだけでコード上の主張の正しさまで証明するものではありません。

## herdr版（Claude Code / Codex / GitHub Copilot CLI）

[herdr](https://herdr.dev) のペインで動くClaude Code・Codex・GitHub Copilot CLIのどれをMainにしても、4種類の専門Agentを使い分けられるプラグインです。専門Agentは、役割ごとに指定したCLIを隣のペインで対話モード・フルアクセスで起動します。ベンダーの混在は「役割ごとにどのCLIを使うか」で実現し、各CLIのログイン・サブスクリプションをそのまま使います。設計の詳細は [docs/herdr-plugin-design.md](docs/herdr-plugin-design.md) を参照してください。

### 必要なもの

- herdr 0.9.5以上。Mainはherdrのペイン内で起動します。
- Node.js 22.19以上。ヘルパーはTypeScriptのままビルドせずに実行します。
- 役割に割り当てたCLI（`claude`／`codex`／`copilot`）がPATH上にあり、ログイン済みであること。
- 推奨: `herdr integration install claude`（`codex`、`copilot` も同様）。herdr再起動後のセッション復帰に使われます。

### インストール

| ホスト | 手順 |
| --- | --- |
| Claude Code | `/plugin install hybrid-subagents --marketplace phni3j9a/hybrid-subagents`（2.1.275以上）。または `/plugin marketplace add phni3j9a/hybrid-subagents` の後に `/plugin install hybrid-subagents@hybrid-subagents` |
| Codex | `codex plugin marketplace add phni3j9a/hybrid-subagents` の後に `codex plugin add hybrid-subagents@hybrid-subagents` |
| GitHub Copilot CLI | `copilot plugin marketplace add phni3j9a/hybrid-subagents` の後に `copilot plugin install hybrid-subagents@hybrid-subagents` |

インストール後は新しいセッションを開始します。プラグインには2つのSkillが入ります。

- `hyagents`: 委任方針。herdr内で委任が役立つときと、完了通知が届いたときに使われます。
- `hyagents-models`: 役割ごとのCLI・モデル・推論強度・Fastの表示と変更。

Claude Codeでは `/hybrid-subagents:hyagents` のように、プラグイン名付きで表示されます。

### 役割と初期値

| 役割 | 担当 | CLI | モデル | 推論強度 |
| --- | --- | --- | --- | --- |
| worker | 実装、修正、周辺調査、局所テスト | codex | `gpt-6-luna` | `max` |
| scout | 対象ファイルが不明な読み取り探索 | codex | `gpt-6-luna` | `xhigh` |
| reviewer | 変更によって導入された具体的な不具合の検出 | codex | `gpt-6.1-sol` | `high` |
| designer | UI/UX設計、画面・コンポーネント実装 | claude | `claude-opus-5-5` | `high` |

どの役割にも、どのCLI・モデルでも割り当てられます。Fastの初期値は全役割offです。

### 普段の使い方

herdrのペインでMainを起動し、普段どおり依頼します。Mainは委任が役立つと判断すると、ヘルパーで専門Agentを起動します。

- **配置**: 最初の専門Agentを起動すると、Mainのペインが左40%・右60%に分かれます。専門Agentは右側に縦に積まれ、数の上限はなく、高さは均等にそろえます。閉じると残りの高さをそろえ直し、全部閉じるとMainが全幅に戻ります。
- **完了通知**: Mainは専門Agentの起動後、待機や状態確認を繰り返さずにターンを終えます。見張り役のプロセスがherdrのイベントを購読し（ポーリングなし）、専門Agentが報告を書いて終わると、Mainが待機状態のときに `[hybrid-subagents]` で始まる1行の通知をMainに送ります。同時に終わった分は1回にまとめます。
- **報告**: 指示書と報告はリポジトリの外、`~/.local/state/hybrid-subagents/`（`XDG_STATE_HOME` に従う）に置きます。Reviewerの報告はPi版と同じスキーマのJSONで、ヘルパーが検証します。報告がない・不正な場合は、同じ専門Agentに1回だけ再依頼します。
- **起動時の確認画面**: フォルダ信頼、Claude Codeのフルアクセス警告、Codexの更新案内は自動で承諾します。知らない画面で止まった場合はペインを残してMainに知らせます。
- **後片付け**: 不要になった専門AgentはMainが閉じます。タスクがすべて終わるとMainが全ペインを閉じ、実行用ファイルも削除します。Mainが終了した場合も、見張り役が専門Agentをすべて閉じます。

専門AgentはPi版と同じくフルアクセスで動き、Scout／Reviewerが編集しないのは役割指示によるものです。委任方針はSkillとして提供するため、ホストがSkillを使わなかった場面では「hybrid subagentsで」と頼んでください。

### モデルの設定

チャットで「workerのモデルを変えたい」のように頼むと、`hyagents-models` SkillがCLI・モデル・推論強度・Fast・保存先を順に確認して保存します。設定ファイルを直接編集することもできます。

- ユーザー共通: `~/.config/hybrid-subagents/config.json`（`XDG_CONFIG_HOME` に従う）
- プロジェクト: リポジトリの `.agents/hybrid-subagents.json`。プロジェクト設定が項目ごとに優先されます。

```json
{
  "roles": {
    "worker": { "runtime": "claude", "model": "claude-opus-5-5", "effort": "max", "fast": false, "args": [] }
  }
}
```

- `effort` を `null` にすると、CLIの既定値を使います。有効な値はCLIごとに検証し、モデルが対応しているかは起動時にCLIが確認します。
- Fastは `claude`（`--settings {"fastMode":true}`）と `codex`（`service_tier="fast"`）だけで有効です。
- `args` はCLIに追加で渡す引数です。
- 変更は、次に起動する専門Agentから反映されます。

### ヘルパーと診断

ヘルパーは `plugins/hybrid-subagents/skills/hyagents/scripts/hyagents.ts` です（インストール後は各ホストのプラグインキャッシュ内）。主にMainが使いますが、人が直接実行することもできます。結果はJSONで出力します。

```text
node <skill-dir>/scripts/hyagents.ts doctor        環境・設定・CLIの診断
node <skill-dir>/scripts/hyagents.ts list          このMainの専門Agent一覧
node <skill-dir>/scripts/hyagents.ts close --all   すべての専門Agentを閉じる
node <skill-dir>/scripts/hyagents.ts config show   役割ごとの実効設定
```

### 制約

- ログイン済みのCLIを使った実機での通し確認は継続中です。確認画面の自動承諾は、画面の文言に基づくベストエフォートです。
- Mainの入力欄に入力途中の文字があると、通知がその後ろにつながって送信されることがあります。通知はMainが待機状態のときだけ送ります。
- Windowsには対応していません。

アンインストールは、Claude Codeが `/plugin uninstall hybrid-subagents@hybrid-subagents`、Codexが `codex plugin remove hybrid-subagents@hybrid-subagents`、Copilot CLIが `copilot plugin uninstall hybrid-subagents` です。設定ファイルは手動で削除してください。

## 構成と互換性

| 場所 | 内容 |
| --- | --- |
| `agents/` | 名前空間付きの4つのネイティブAgent定義 |
| `skills/hyagents/SKILL.md` | 短い委任方針。Extensionもこの本文を読み、重複した方針を持たない |
| `extensions/hyagents.ts` | Mainへの自動適用、コマンド登録と準備状況の診断 |
| `src/models.ts` | 推奨初期値、モデル表現とFast対応判定 |
| `src/model-command.ts` | 役割別のモデル・Thinking・Fast選択メニュー |
| `src/native-settings.ts` | ネイティブ設定の読み取りと保存 |
| `plugins/hybrid-subagents/` | herdr版プラグイン。`plugin.json`（Codex・Copilot CLI）と `.claude-plugin/plugin.json`（Claude Code）、Skill、役割の指示書、ヘルパー |
| `.claude-plugin/`、`.agents/plugins/`、`.github/plugin/` | Claude Code・Codex・Copilot CLI向けのマーケットプレイス |

herdr版プラグインはnpmで配布するPi版パッケージには含めません。

Mainへの適用にはPiの構造化prompt sectionを使い、他のExtensionの指示やprompt cacheを維持します。子AgentへMain用ポリシーを再注入しません。組み込みの `worker`、`scout`、`reviewer` は上書きしません。

Hybrid Subagentsは必須子拡張を登録しません。他のホストExtensionの登録を奪わず、bili等の子拡張・圧縮設定も変更しません。

設定の保存では、固定依存のpi-subagents 0.76.1が使う内部設定エディターを1つのadapterから呼び出します。ファイルロック・原子的保存・他フィールドの維持・プロジェクトルート解決を共有するためです。依存バージョンを更新するときはこのadapterの互換性も確認してください。

セッション復帰の可否・保持期間・並列実行・Fleet UIはpi-subagents側の仕様と設定に従います。プロセス終了後の復帰をHybrid Subagentsが独自に保証するものではありません。FleetView等のUIは別途利用でき、Hybrid Subagentsには同梱しません。

アンインストール:

```sh
pi remove npm:pi-hybrid-subagents
```

GitHubから導入した場合は `pi remove git:github.com/phni3j9a/hybrid-subagents` です。旧名で登録した場合は `pi remove git:github.com/phni3j9a/HyAgents` を使ってください。GitHubの旧URLは新URLへリダイレクトされますが、Piの登録ソース文字列は自動で変わりません。

その後 `/reload` またはPiを再起動します。pi-subagentsは他の用途に引き続き使えます。

## 開発・検証

```sh
npm ci
npm run check
npm pack --dry-run
```

テストは一時ディレクトリを使い、実際のPi／pi-subagentsのAgent発見、起動前の契約解決、子セッション起動、標準Fastのpriority付与と他ホスト拡張との共存、per-run overrideの受け入れ、保持セッションの再オープン、ReviewerのJSON Schemaを確認します。通常のテストは外部モデルへリクエストを送らず、ユーザーの認証・Pi設定を変更しません。

実モデルの応答品質、費用、プロバイダーの認証成功、実作業を伴う並列実行／Resumeは、認証済み環境で別途確認してください。

herdr版のテストは、メモリ上の擬似herdrと偽の `herdr` コマンド・ソケットを使います。対象は、設定の解決、各CLIの起動引数、ペイン配置、起動・追加指示・終了、見張り役の通知と後片付け、herdrとの通信形式、マニフェストの整合性です。マニフェストは `claude plugin validate --strict` でも確認できます。

参考: [Pi](https://github.com/earendil-works/pi)、[pi-subagents](https://github.com/nicobailon/pi-subagents)、[Oh My Pi](https://github.com/can1357/oh-my-pi)。由来とライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
