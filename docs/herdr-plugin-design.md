# Hybrid Subagents for herdr 設計書

状態: v0.1.0 として実装済み。2026-10-26 時点の相談結果と、実装中の検証で分かった事実を反映しています。

確認したバージョン: herdr 0.9.5 / Claude Code 2.1.310 / Codex CLI 0.164.0 / GitHub Copilot CLI 1.0.103 / Node.js 22.19以上。

## 1. 目的と範囲

Pi版と同じく、役割ごとに別ベンダー・別モデルの専門Agentを使い分けられるようにします。herdr上で、Claude Code・Codex・GitHub Copilot CLIのどれをMainにしても同じように動き、それぞれのプラグインとして読み込めるようにします。

範囲に含めないもの:

- Windows
- Pi（Mainとしても子としても対象外。Pi向けは既存の `pi-hybrid-subagents` が担います）
- herdrの外での委任
- 各ホストの内蔵サブエージェントの利用
- hook（委任方針はSkillに任せます）
- 安全のための追加制限（Pi版と同じ扱いにします）

## 2. 全体像

```
herdr のタブ
┌────────────── 40% ──────────────┬──────────── 60% ────────────┐
│ Main: claude / codex / copilot  │ worker-1   (codex  …)       │
│   + hybrid-subagents プラグイン │─────────────────────────────│
│     ・Skill hyagents（委任方針）│ designer-1 (claude …)       │
│     ・Skill hyagents-models     │─────────────────────────────│
│     ・ヘルパー hyagents.ts      │ reviewer-1 (codex  …)       │
└─────────────────────────────────┴─────────────────────────────┘
       ▲ 完了通知（1行）                  │ herdrのイベント
       └──── 見張り役（Mainごとに1プロセス）◄┘
```

- 子Agentは、役割ごとに指定されたCLIを、隣のherdrペインで**対話モード・フルアクセス**で起動します。
- 指示と報告は、リポジトリ外の実行用ディレクトリにあるファイルで受け渡します。
- Mainは子を起動したらターンを終えます。待機や状態確認を繰り返すことはしません。子が終わると、見張り役がMainのペインに1行の通知を入力して送ります。

## 3. 役割と初期値

| 役割 | 担当 | 初期ランタイム | 初期モデル | 推論強度 |
| --- | --- | --- | --- | --- |
| worker | 実装・修正・周辺調査・局所テスト | codex | gpt-6-luna | max |
| scout | 対象ファイルが不明なときの読み取り調査 | codex | gpt-6-luna | xhigh |
| reviewer | 変更で入った具体的な不具合の検出 | codex | gpt-6.1-sol | high |
| designer | UI/UXの設計と実装 | claude | claude-opus-5-5 | high |

- Pi版と同じ初期値です。相談時点では「Codex CLIの推論強度はxhighが上限」としてWorkerをxhighにしていましたが、これは誤りでした。Codex 0.164のモデル一覧では、gpt-6-lunaが `max` まで、gpt-6.1-solが `ultra` まで対応しているため、Pi版と同じ `max` に戻しています。
- どの役割にも、どのランタイム（claude / codex / copilot）・どのモデルでも割り当てられます。
- Fastは初期状態で全役割offです。
- Scout・Reviewerが編集しないのはPi版と同じく役割指示によるもので、起動フラグでは制限しません。

## 4. 配布構成

Pi版はリポジトリのルートに残し、プラグインは `plugins/hybrid-subagents/` に置きます。ルートをプラグインにすると、Claude CodeがPi用の `agents/*.md` と `skills/hyagents` まで読み込んでしまうためです。

```
.claude-plugin/marketplace.json        Claude Code 用マーケットプレイス
.agents/plugins/marketplace.json       Codex 用マーケットプレイス
.github/plugin/marketplace.json        Copilot CLI 用マーケットプレイス
plugins/hybrid-subagents/
  plugin.json                          Agent Plugins 1.0 形式（Codex・Copilot が読む）
  .claude-plugin/plugin.json           Claude Code 用マニフェスト
  skills/hyagents/
    SKILL.md                           委任方針
    roles/{worker,scout,reviewer,designer}.md
    schemas/review.schema.json         Reviewer の報告スキーマ（Pi版と同一）
    scripts/hyagents.ts                ヘルパー（エントリポイント）
    scripts/lib/*.ts                   ヘルパーの内部モジュール
  skills/hyagents-models/SKILL.md      役割ごとのモデル設定
```

- 3つのホストに共通するのは `skills/<名前>/SKILL.md` です。
- ルートの `plugin.json` は、CodexとCopilotが優先して読みます。Claude Codeは `.claude-plugin/plugin.json` だけを読みます。
- プラグインは外部パッケージに依存しません。ホストはプラグインをコピーするだけで `npm install` を実行しないためです。
- npmで配布するPi版（`package.json` の `files`）には、`plugins/` を含めません。

インストール手順（マーケットプレイス名は `hybrid-subagents`）:

| ホスト | 手順 |
| --- | --- |
| Claude Code | `/plugin install hybrid-subagents --marketplace phni3j9a/hybrid-subagents`（2.1.275以上）、または `/plugin marketplace add phni3j9a/hybrid-subagents` → `/plugin install hybrid-subagents@hybrid-subagents` |
| Codex | `codex plugin marketplace add phni3j9a/hybrid-subagents` → `codex plugin add hybrid-subagents@hybrid-subagents`（または `/plugins`） |
| Copilot CLI | `copilot plugin marketplace add phni3j9a/hybrid-subagents` → `copilot plugin install hybrid-subagents@hybrid-subagents` |

3つのCLIそれぞれで、ローカルのマーケットプレイスからのインストールを確かめています（16章）。

前提条件:

- herdr 0.9.5以上（ホストはherdrのペイン内で起動していること）
- Node.js 22.19以上（`.ts` をビルドせずにそのまま実行するため）
- 割り当てたランタイムのCLIがインストール済みで、ログイン済みであること
- `herdr integration install <claude|codex|copilot>` は、herdrの再起動後に子のセッションを復帰させるための推奨設定です。

## 5. 設定

保存先と優先順位:

- ユーザー共通: `~/.config/hybrid-subagents/config.json`（`XDG_CONFIG_HOME` があればそれに従います）
- プロジェクト: `<project>/.agents/hybrid-subagents.json`
- 優先順位はプロジェクト → ユーザー共通 → 初期値です。役割ごと・項目ごとに上書きされます。

```json
{
  "roles": {
    "worker":   { "runtime": "codex",  "model": "gpt-6-luna",      "effort": "max",   "fast": false, "args": [] },
    "designer": { "runtime": "claude", "model": "claude-opus-5-5", "effort": "high" }
  }
}
```

| 項目 | 内容 |
| --- | --- |
| `runtime` | `claude` / `codex` / `copilot` |
| `model` | 各CLIにそのまま渡すモデルID。実在するかは起動時にCLIが判断します |
| `effort` | 省略するとCLIの既定値。有効な値はランタイムごとに検証します（6章） |
| `fast` | 対応しているランタイムだけで有効。copilotでは警告を出して無視します |
| `args` | CLIに追加で渡す引数の配列。制御文字は使えません |

設定は2通りの方法で変更できます。

- `hyagents-models` Skill: Mainがチャットで役割・ランタイム・モデル・推論強度・Fast・保存先を順に聞き、ヘルパーで保存します。
- JSONファイルの直接編集

変更は、次に起動する子から反映されます。実行中の子には影響しません。

## 6. ランタイムごとの起動引数

| | claude | codex | copilot |
| --- | --- | --- | --- |
| herdrの `--kind` | `claude` | `codex` | `copilot` |
| モデル | `--model M` | `-m M` | `--model M` |
| 推論強度 | `--effort E` | `-c model_reasoning_effort="E"` | `--reasoning-effort E` |
| 推論強度の有効値 | low, medium, high, xhigh, max, ultracode | none, minimal, low, medium, high, xhigh, max, ultra | none, minimal, low, medium, high, xhigh, max |
| フルアクセス | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |
| Fast | `--settings {"fastMode":true}` | `-c service_tier="fast"`（Codexが `priority` として送信） | 非対応 |

- 推論強度の有効値は、各CLIが受け付ける値の一覧です。そのモデルが実際に対応しているかは、起動時にCLIが判断します。

- 起動コマンドは `herdr agent start <名前> --kind <kind> --pane <id> -- <引数…>` です。herdrは各引数をPOSIX形式でクォートしてシェルに入力します。ただし、制御文字（改行など）を含む引数は受け付けません。そのため、長い指示は引数ではなく `brief.md` で渡します。
- Claude Codeは、Linux/macOSでroot権限のときフルアクセスでの起動を拒否します。組織の管理設定でフルアクセスが禁止されている場合もあります。どちらも診断（14章）で知らせます。
- Claude CodeのFastは、Opus系モデルかつ使用量クレジットが有効なときだけ使えます。

## 7. ヘルパー CLI（`hyagents.ts`）

呼び出し方は `node <skillディレクトリ>/scripts/hyagents.ts <コマンド>` です。Claude CodeではSkillの本文に `${CLAUDE_SKILL_DIR}` と書けばパスに置き換わります。CodexとCopilotでは、ホストが示すSKILL.mdの場所からパスを組み立てます。出力はすべて短いJSONです。

| コマンド | 役割 |
| --- | --- |
| `start --role R [--name N] [--cwd D]` | 子を1つ起動してすぐ戻ります。タスク本文は標準入力から受け取ります（heredocを使えばクォートの問題が起きません） |
| `send <name>` | 待機中の子に追加の指示を送ります（本文は標準入力から）。起動時の画面で止まった子には、最初のタスクを届けます |
| `close <name>` / `close --all` | 子のペインを閉じます。`--all` はこのMainのすべての子を閉じ、実行用ディレクトリも削除します |
| `list` | このMainの子と、その状態を表示します |
| `doctor` | 環境・設定・CLIの状態を診断します |
| `config show \| set \| reset` | 設定を表示・保存・初期化します（`--scope user\|project`） |
| `watch` | 見張り役。内部用で、`start` が自動的に起動します |

共通のルール:

- `HERDR_ENV=1` でなければ、何もせずにエラーを返します。
- `HYAGENTS_ROLE` が設定されている（つまり自分が子である）場合は、委任を拒否します。
- Mainの特定には、ヘルパーが受け継いだ `HERDR_PANE_ID` を使います。
- herdrとの通信: 単発の操作には `herdr` CLIを使います（`agent start` の準備完了待ちはCLI側の処理なので、ソケットでは代替しません）。イベントの購読と配置の変更には、`HERDR_SOCKET_PATH` のソケットAPIを使います。
- 子への操作（指示、状態の取得、キー入力）は、名前ではなくペインIDを指定します。herdrは起動がタイムアウトすると名前を手放すことがあるためです。名前は表示用に付け直します。

## 8. 起動の流れ（`start`）

1. 環境と設定を検証します。
2. 子の名前を `<role>-<n>` の形で付けます。herdrのサーバー全体で重複しないよう、`agent list` を見て番号を進めます。名前は `[a-z][a-z0-9_-]{0,31}` の形式です。
3. 実行用ディレクトリ `${XDG_STATE_HOME:-~/.local/state}/hybrid-subagents/<mainKey>/<name>/` を作ります。`mainKey` は、ソケットのパスとMainのペインIDから作るハッシュです。中に次の2つを書きます。
   - `brief.md`: 役割の指示、タスク本文、報告の書き方、報告ファイルのパス
   - `state.json`: 子の状態の記録
4. ペインを作ります（9章）。作るときに `--cwd <Mainの作業ディレクトリ> --no-focus --env HYAGENTS_ROLE=<role> --env HYAGENTS_MAIN=<MainのペインID>` を付けます。
   - 1〜4は、Mainごとのロックの中で行います。時間のかかる5以降はロックの外で行うので、複数の子を続けて起動できます。
5. `herdr agent start` で子を起動します（6章の引数を使います）。
6. 起動時の確認画面への対応: `agent_not_ready`（入力待ち）か `timeout` で戻ってきたら、画面（`visible`）を読みます。
   - フォルダ信頼の確認、Claude Codeのフルアクセス警告、Codexの更新案内など、既知の画面ならキーを送って承諾します。選択肢は選択中の行を見て1キーずつ動かし、決まった回数まで繰り返します。
   - 知らない画面なら、画面の抜粋を付けて `startup_blocked` を返します。ペインは残すので、ユーザーが直接操作できます（ログインなど）。その後 `send <name>` で最初のタスクを届けます。
   - それ以外の起動失敗では、ペインと記録を消し、画面の抜粋を付けてエラーを返します。
7. 直前の `state_change_seq` を記録してから、`herdr agent prompt <pane> "<1行の指示: brief.md を読み、報告を <path> に書く>"` で指示を送ります。完了は待ちません。
8. このMainの見張り役が動いていなければ起動し、動いていればSIGHUPで再読み込みさせます（pidファイルで1つに保ちます）。子の名前・ペイン・報告のパスを返して終了します。

## 9. ペインの配置

- 最初の子は `pane split <Main> --direction right --ratio 0.4` で作ります。`--ratio` は分割元（左側）の割合なので、Mainが40%、子の領域が60%になります（herdrのソースで確認済み）。
- 2つ目以降の子は、右側の領域で最も浅い位置にあるペインを `--direction down` で分割します。こうすると分割の木が偏らず、縦に積む形になります。上限は設けません。
- 子を足したり閉じたりするたびに、右側の領域にある縦方向の分割それぞれに `ratio = 前半のペイン数 / 全体のペイン数` を設定します。これで全ての子の高さがそろいます。
  - 設定には、ソケットAPIの `layout.export` と `layout.set_split_ratio` を使います。`path` は真偽値の配列で、`false` が前半（first）、`true` が後半（second）を表します。
  - herdrは比率を0.1〜0.9の範囲に丸めます。分割の木が偏らなければ、この範囲に収まります。
- 子のペインを閉じると、herdrが分割を自動で畳みます。最後の子を閉じると、Mainが全幅に戻ります。
- 触るのは、Mainのペインから作った領域だけです。ユーザーが手で変えたサイズは、次に子を足すか閉じるまでそのまま残ります。

## 10. 完了通知（見張り役）

見張り役は、Mainごとに1つ、Mainの操作から切り離して動くNodeプロセスです。herdrのソケットで `events.subscribe` を行い、次のイベントを受け取ります。ポーリングはしません。

- 子とMainの `pane.agent_status_changed`
- `pane.exited`
- `pane.closed`

`events_lost` を受け取ったら、購読し直し、`agent get` で現在の状態と突き合わせます。

子の状態の遷移と対応:

| 状況 | 対応 |
| --- | --- |
| 作業を終えて待機状態（idle / done）になり、報告がある | 完了として通知を予約します。Reviewerの場合は、JSONの検証に通ることが条件です |
| 待機状態になったが報告がない | 子に「報告を <path> に書いて」と1回だけ促します。次に待機状態になっても報告がなければ、「報告なしで停止」として通知を予約します |
| ReviewerのJSONが不正 | 1回だけ修正を頼みます。それでも不正なら、エラーとして通知を予約します |
| 入力待ちで止まった | 既知の確認画面なら自動で承諾します。それ以外は、画面の抜粋（5行以内）を付けて「入力待ち」の通知を予約します |
| ペインが予期せず終了した | 「終了」として通知を予約します |
| CLIだけが終了してシェルが残った | 少し待ってもエージェントが検出されなければ、「終了」として通知を予約します |

- 「作業を終えた」かどうかは、プロンプト送信前に記録した `state_change_seq` より状態が進んでいるかで判定します。見張り役の起動前に子が終わっていても取りこぼしません。

Mainへの通知の届け方:

- Mainが待機状態（idle / done）のときだけ届けます。Mainが作業中や入力待ちの間は保留し、作業の途中に割り込むことはしません。
- 予約した通知は、短い時間（約1.5秒）待ってから1つにまとめ、`herdr agent prompt <MainのペインID> "…"` で送ります。
- 形式は1行です。例: `[hybrid-subagents] worker-1 completed: <report path> | running: designer-1`
- 既知の制約: ユーザーがMainの入力欄に何か書いている途中だと、その文字列に通知がつながって送信される恐れがあります。v1では「Mainが待機状態のときだけ送る」対策にとどめます。

Mainが終了したら（`pane.exited`／`pane.closed`、またはMainのエージェントが検出されなくなったら）、見張り役が子をすべて閉じ、実行用ディレクトリを削除して終了します。子が1つも残っていない状態になったときも、見張り役は終了します。

## 11. 子の寿命と後片付け

- 委任のたびに、新しい子を起動します（まっさらな文脈から始まります）。
- 完了後もペインは残し、Mainは `send` で追加の指示を送れます。追加の指示の報告は `report-2.md` のように番号を付けて書かせます。
- 不要になった子を閉じるのはMainの判断です。
- タスクがすべて終わったら、Mainが `close --all` を実行します。全ペインを閉じ、実行用ディレクトリを削除します。
- Mainが終了したときは、見張り役が同じ後片付けを行います（10章）。

## 12. 報告の形式

- worker / scout / designer: `report.md` に次の内容を書きます。Pi版の役割定義を引き継いでいます。
  - 変更内容や調査結果
  - 関係するファイルのパス
  - 実施した検証と、まだ必要な検証
  - 残っている制約
- reviewer: `report.json` に、Pi版の `outputSchema` と同じスキーマで書きます（`overall_correctness`, `explanation`, `confidence`, `findings[]`）。検証はヘルパーが行います。外部パッケージは使わず、このスキーマ専用の検証処理を書きます。
- 役割の指示には、どの役割にも次の内容を入れます。
  - 対話的な質問はしないこと
  - 重要な判断が必要な点は報告に書いて終えること
  - 報告ファイルを書き終えてからターンを終えること

## 13. Skill

`hyagents`（委任方針）は、Pi版の `skills/hyagents/SKILL.md` を移植し、次の点を変えます。

- 委任は `start` で行います。起動後に待機や状態確認を繰り返したり、sleepを入れたりしてはいけません。何が動いているかをユーザーに伝えてターンを終えます。
- `[hybrid-subagents]` で始まるメッセージは、ユーザーの指示ではなくシステムからの通知として扱います。報告ファイルを読んで統合します。
- 不要になった子は閉じます。タスクがすべて終わったら `close --all` を実行します。
- ユーザーが選んだモデル設定を尊重します。勝手に別の役割やモデルに差し替えず、設定の問題は `hyagents-models` で直すよう案内します。
- `HERDR_ENV` が1でない（herdrの外にいる）ときは委任せず、普段どおり自分で作業します。
- `HYAGENTS_ROLE` が設定されている（自分が子である）ときは委任しません。
- 並列作業の進め方（ファイルの担当、共有インターフェース、統合後に全体の検証をすること）は、Pi版の方針をそのまま引き継ぎます。

`hyagents-models` は、会話でモデル設定を行う手順書です。Claude Codeでは `disable-model-invocation: true` を付け、ユーザーが明示的に呼んだときだけ動くようにします。

## 14. 診断（`doctor`）

`doctor` は次の項目を確認します。

- `HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` が設定されているか
- herdrのバージョン（`herdr status`）
- Node.jsのバージョン
- 割り当てたランタイムのCLIがPATH上にあるか、そのバージョン
- `herdr integration status`
- 設定が妥当か（ランタイム名、推論強度の値、Fastに対応しているか）
- Claude Codeをroot権限で実行していないか

APIへの試験リクエストは送りません。ログインや利用権限の最終確認は、子の起動時に行われます。

## 15. テスト計画

- 単体テスト（`node:test`、herdr不要）:
  - 設定のマージと検証
  - 起動引数の組み立て
  - 配置の計算（分割の木、高さの比率、パス）
  - 通知のまとめ方と形式
  - Reviewerの報告の検証
  - 確認画面の判定
  - 名前の付け方
- 擬似herdrによるテスト: 偽の `herdr` コマンドと偽のUnixソケットサーバーを用意し、`start` / `close` / `watch` の流れを確かめます。
- 手元での通しの確認（ログイン済みのCLIが必要）:
  - 3つのランタイムそれぞれをMainにし、それぞれを子にする組み合わせ
  - 起動時の確認画面
  - 完了通知
  - `close --all`
  - Mainが終了したときの後片付け
- CI: 既存のワークフロー（Node 22 / 24）で、プラグインのテストも実行します。

## 16. 検証状況

確認済み（Claude Code 2.1.310 / Codex CLI 0.164.0 / Copilot CLI 1.0.103）:

- 2種類のマニフェストを1つのディレクトリに置いた構成で、3つのCLIがそれぞれローカルのマーケットプレイスからインストールでき、2つのSkillを認識すること
  - Claude Code: `claude plugin validate --strict` がプラグイン・マーケットプレイスとも合格。キャッシュにコピーされたヘルパーがそのまま動作
  - Codex: `.agents/plugins/marketplace.json` を読み、`codex plugin add hybrid-subagents@hybrid-subagents` で有効化。モデルに `hybrid-subagents:hyagents` などとして見える
  - Copilot CLI: ルートの `plugin.json`（Agent Plugins 1.0）で読み込み、「Installed 2 skills」
- Codexのモデル一覧に初期値のモデル（gpt-6-luna、gpt-6.1-sol）があり、推論強度の対応範囲（gpt-6-lunaはmaxまで）
- herdr 0.9.5のソースで確認した仕様: `--ratio` は分割元の割合、比率は0.1〜0.9に丸められる、`--kind copilot` は `copilot` を起動する、イベントとCLI出力の形式
- 見張り役を切り離したプロセスとして起動し、本物のクライアント経由でソケット購読を始めること（偽のherdrソケットで確認）

未検証（実際のherdrとログイン済みCLIが必要）:

- 各CLIの起動時の確認画面の実際の文言と、自動承諾の動作
- 各ホストのシェル実行から起動した見張り役が、コマンドの終了後も生き残るか（新しいプロセスグループにして切り離しています）
- herdrの `--kind copilot` で起動した子が、対話モードで正しく状態検出されるか
- Mainへの通知の入力が、3つのCLIそれぞれで期待どおりに新しいターンとして扱われるか

## 17. Pi版との対応

| Pi版 | herdr版 |
| --- | --- |
| pi-subagentsが子Piをプロセス内で起動 | 各CLIをherdrのペインで対話モードで起動 |
| Piのプロバイダーでベンダーを混在させる | 役割ごとにCLIを選んでベンダーを混在させる |
| `/hyagents models` メニュー | `hyagents-models` Skill＋JSON |
| `subagents.agentOverrides` | `~/.config/hybrid-subagents/config.json` / `.agents/hybrid-subagents.json` |
| ReviewerのoutputSchema | `report.json`をヘルパーが同じスキーマで検証 |
| 結果の自動配信（バックグラウンド） | 見張り役がMainのペインに1行で通知 |
| 保持セッションへの追加指示 | 残したペインへの `send` |
| `PI_SUBAGENT_CHILD` による再帰防止 | `HYAGENTS_ROLE` による再帰防止 |
| Mainへの方針の自動適用 | Skillの自動起動に任せる |

## 18. 実装の順序

1. 済: プラグインの骨組み（マニフェスト2種類、マーケットプレイス3つ、Skill 2つ、役割の指示書、スキーマ）
2. 済: ヘルパーの中核（設定、ランタイムごとの引数、herdrとの通信、`start` / `send` / `close` / `list` / `doctor` / `config`）
3. 済: 配置の計算と、高さをそろえる処理
4. 済: 見張り役（イベント購読、状態の遷移、通知、Main終了時の後片付け）
5. 済: 単体テストと擬似herdrによるテスト、READMEへの追記
6. 未: 手元での通しの確認を経て、配布の準備
