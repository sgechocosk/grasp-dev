export interface HtmlOptions {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
  nonce: string;
}

export function renderHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src data:; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${o.styleUri}" rel="stylesheet">
<title>GraspDev</title>
</head>
<body>
<div id="settings" class="panel" hidden>
  <h3>設定</h3>
  <label for="keyInput">OpenAI APIキー <span id="keyStatus"></span></label>
  <input id="keyInput" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
  <div class="row">
    <button id="keySave">保存</button>
    <button id="settingsClose" class="secondary">閉じる</button>
  </div>
  <label for="level">経験レベル</label>
  <select id="level">
    <option value="beginner">基本</option>
    <option value="intermediate">実務</option>
    <option value="advanced">上級</option>
  </select>
  <label class="toggle"><input id="testMode" type="checkbox">テストモード</label>
</div>
<div id="messages"></div>
<div id="status" hidden><span class="spinner"></span><span id="statusText">作業中…</span></div>
<div id="permission" hidden></div>
<div id="composer">
  <textarea id="input" rows="1" placeholder="質問や実装の指示を入力"></textarea>
  <div id="toolbar">
    <select id="mode" title="権限モード">
      <option value="acceptEdits">コマンド実行前に確認</option>
      <option value="bypassPermissions">すべて自動許可</option>
    </select>
    <span id="meta"></span>
    <button id="capture" class="secondary" title="会話全体を画像として保存します" hidden>画面を保存</button>
    <button id="send">送信</button>
  </div>
</div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
