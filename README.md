# GraspDev

VS Code のサイドバーで動くコーディングエージェントです。コードベースを自分で調査し、質問への回答や指示された変更の実装を行います。モデルは OpenAI API の `gpt-6-luna` を使用します。

## 使い方

Node.js 20 以上が必要です。

```bash
npm install
npm run build
```

1. VS Code でこのフォルダを開いて `F5` (Run Extension)。拡張機能を読み込んだ別ウィンドウが開きます。
2. そのウィンドウで対象のフォルダを開き、アクティビティバーの吹き出しアイコンから GraspDev を開きます。
3. 初回は設定パネルが表示されるので OpenAI API キーを入力して保存します (VS Code の SecretStorage に保存)。
   あとから変更するときは、ビュー右上の歯車ボタンで同じパネルを開きます。
4. 質問や指示を送信します。

会話はメモリ上にのみ保持され、保存されません。ウィンドウを閉じる (または再読み込みする) と破棄されます。

## 機能

| ツール | 内容 | 確認 |
|---|---|---|
| `Read` | 行番号付きでファイルを読む (範囲指定可) | 不要 |
| `Glob` | glob でファイルを探す (更新日時順、.gitignore 尊重) | 不要 |
| `Grep` | ripgrep による正規表現検索 (VS Code 同梱の rg を使用) | 不要 |
| `Edit` | 完全一致の文字列置換。事前の Read と一意性を要求 | 必要 |
| `Write` | ファイルの作成・上書き | 必要 |
| `Bash` | シェルコマンド実行 (タイムアウト付き) | 必要 |
| `TodoWrite` | 作業のタスクリスト表示 | 不要 |

- 読み取り専用ツールだけの呼び出しは並列実行されます。
- 権限モード (入力欄下のセレクタ): 編集・実行前に確認 / ワークスペース内の編集を自動許可 / すべて自動許可。
  確認時に「このセッション中は常に許可」を選ぶと、ツール単位 (Bash はコマンドの先頭語単位) で記憶します。
- ワークスペース直下の `AGENTS.md` (無ければ `CLAUDE.md`) をプロジェクト指示として読み込みます。
- 開いているファイルと選択範囲を文脈としてモデルに渡します。
- 入力トークンが閾値を超えると会話履歴を自動で要約します。

## 設定

ユーザーが変更できるのは API キーと権限モードだけです。それ以外 (モデル、API方式、最大ターン数など) は
`src/config.ts` の固定値で動作します。挙動を変える場合はこのファイルを書き換えてビルドし直します。

## 設計

```
src/
  config.ts    固定の動作設定
  core/        vscode 非依存のエージェント本体 (Node 単体でテスト可能)
    agent.ts         モデル呼び出し → ツール実行のループ、中断、自動要約
    permissions.ts   権限モードと許可判定 (UI は ask 関数を渡すだけ)
    systemPrompt.ts  システムプロンプトの組み立て
    types.ts         プロバイダ非依存のメッセージ/イベント型
  providers/   LLM バックエンド (LLMProvider を実装して ProviderRegistry に登録)
  tools/       ツール (Tool を実装して ToolRegistry に登録)
  ui/          VS Code 側: WebviewViewProvider、Webview との通信プロトコル
  extension.ts 起動処理と公開 API
media/         Webview の JS/CSS、アイコン (依存ライブラリなし)
test/          node:test によるテスト (ツール、エージェントループ、モックAPIに対するプロバイダ)
```

### 拡張ポイント

- **ツールを追加**: `src/tools/` に `Tool` を実装し、`src/tools/index.ts` の一覧に足します。
  `permission` (`none` / `edit` / `execute`) で確認の要否と並列実行の可否が決まります。
- **モデル/APIを追加**: `LLMProvider.complete()` を実装して `src/providers/index.ts` で登録し、`src/config.ts` の `provider` にIDを指定します。
- **別の拡張機能から**: `activate()` の戻り値で同じことができます。

```ts
const grasp = vscode.extensions.getExtension('local.grasp-dev')?.exports;
grasp.registerTool({
  name: 'OpenIssue', description: '…', permission: 'none',
  parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  async execute(input, ctx) { return { content: '…' }; },
});
```

- **UIを差し替え**: `core/` は `AgentEvent` を emit するだけなので、CLI など別のフロントエンドからも `Agent` をそのまま使えます。

## 開発

```bash
npm run watch      # ビルド (監視)
npm run typecheck
npm test
```
