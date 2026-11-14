import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG } from '../config';
import { Agent } from '../core/agent';
import { PermissionManager, type PermissionDecision, type PermissionMode } from '../core/permissions';
import { buildSystemPrompt } from '../core/systemPrompt';
import { createConversationState, type AgentEvent, type ConversationState } from '../core/types';
import { observeProvider, type CallInfo } from '../providers/observe';
import type { ProviderRegistry } from '../providers/provider';
import { displayPath, resolvePath, ToolRegistry } from '../tools/tool';
import { ASK_INSTRUCTIONS, createAskUserTool, type AskQuestion } from '../understand/askUser';
import { coerceLevel, type LearnerLevel } from '../understand/lib/level';
import { createAsker } from '../understand/llm';
import { UnderstandSession, type WalkMessage } from '../understand/session';
import { renderHtml } from './html';
import type { HostMessage, PermissionView, TranscriptItem, ViewState, WebviewMessage } from './protocol';

const SECRET_KEY = 'graspDev.openaiApiKey';
const MODE_KEY = 'graspDev.permissionMode';
const LEVEL_KEY = 'graspDev.level';
const TEST_MODE_KEY = 'graspDev.testMode';
/** 画面の画像を最後に保存したフォルダー (次に保存するときの初期位置) */
const CAPTURE_DIR_KEY = 'graspDev.captureDir';
/** ワークスペース内の編集は常に確認なし (変更は取り置かれ、たどり終えてから反映するため)。選べるのはコマンド実行の確認だけ */
const MODES: PermissionMode[] = ['acceptEdits', 'bypassPermissions'];
const MAX_SELECTION_CHARS = 4000;
const RUN = '実行';
const RUN_ALL = 'この処理では以降確認しない';

const short = (text: string, max = 70): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
};

/**
 * いま行っている作業を、1行の文にする (入力欄の上に出す)。
 * ツールの呼び出しそのものは会話に出さない。編集は、どこを変えたかが答えの手がかりになるので場所を書かない。
 */
export function describeActivity(name: string, input: any, cwd: string): string {
  const file = typeof input?.file_path === 'string' ? displayPath(cwd, input.file_path) : '';
  switch (name) {
    case 'Read': return `ファイルを読んでいます: ${file}`;
    case 'Grep': return `コードを検索しています: ${short(String(input?.pattern ?? ''), 40)}`;
    case 'Glob': return `ファイルを探しています: ${short(String(input?.pattern ?? ''), 40)}`;
    case 'Edit':
    case 'Write': return 'コードを書き換えています';
    case 'Bash': return `コマンドを実行しています: ${short(String(input?.command ?? ''))}`;
    case 'TodoWrite': return '作業の段取りを整理しています';
    case 'AskUser': return '実装の前に決めることを確認しています';
    default: return `${name} を実行しています`;
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'graspDev.chat';

  private view?: vscode.WebviewView;
  /** 会話はメモリ上にのみ保持し、ウィンドウを閉じると破棄される */
  private state: ConversationState = createConversationState();
  private transcript: TranscriptItem[] = [];
  private abort?: AbortController;
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  /** 利用者の返事を待っている許可の確認 (画面が作り直されたときに出し直す) */
  private permissionView?: PermissionView;
  private permissions: PermissionManager;
  private rgPath = findBundledRipgrep();
  /** 取り置きと、たどる手順の進行役 */
  private session?: UnderstandSession;
  /** 実行中のツール呼び出し (許可の確認と、作業の表示に使う) */
  private calls = new Map<string, { name: string; input: any }>();
  /** 最後の応答の文章 (質問への回答として、問いをたどり終えてから見せる) */
  private lastAnswer = '';
  private runFailed = false;
  /** 利用者の回答を待っている質問 */
  private pendingAsks = new Map<string, (answers: string[] | undefined) => void>();
  private askCount = 0;
  /** 出力パネル「GraspDev」: OpenAI API を呼ぶたびの記録 (モデル・入出力トークン数・キャッシュ)。ツールの使用は記録しない */
  private readonly output = vscode.window.createOutputChannel('GraspDev');
  /** テストモードで「この処理では以降確認しない」を選んだか (依頼ごとに戻す) */
  private skipConfirm = false;

  constructor(
    private context: vscode.ExtensionContext,
    private tools: ToolRegistry,
    private providers: ProviderRegistry,
  ) {
    this.permissions = new PermissionManager(
      () => this.permissionMode(),
      (req, signal) => new Promise((resolve) => {
        const finish = (d: PermissionDecision) => {
          this.pendingPermissions.delete(req.toolCallId);
          if (this.permissionView?.toolCallId === req.toolCallId) this.permissionView = undefined;
          resolve(d);
        };
        signal.addEventListener('abort', () => {
          this.post({ type: 'permission_cancel', toolCallId: req.toolCallId });
          finish({ behavior: 'deny' });
        }, { once: true });
        this.pendingPermissions.set(req.toolCallId, finish);
        const call = this.calls.get(req.toolCallId);
        const cwd = this.cwd() ?? '';
        this.permissionView = {
          toolCallId: req.toolCallId,
          key: req.key,
          title: call?.name === 'Bash' ? 'このコマンドを実行しますか?' : call?.name === 'Edit' || call?.name === 'Write' ? 'ワークスペースの外のファイルを書き換えますか?' : `${req.toolName} を実行しますか?`,
          detail: call?.name === 'Bash' ? String(call.input?.command ?? '') : typeof call?.input?.file_path === 'string' ? displayPath(cwd, call.input.file_path) : '',
        };
        this.post({ type: 'permission_request', ...this.permissionView });
        // サイドバーが閉じていると確認に気づけないので前面に出す
        this.view?.show?.(true);
      }),
    );

    context.subscriptions.push(
      this.output,
      context.secrets.onDidChange((e) => { if (e.key === SECRET_KEY) void this.postState(); }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = renderHtml({
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css')).toString(),
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString('hex'),
    });
    view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m));
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
  }

  // ---- コマンドから呼ばれる操作 ----

  /** タイトルバーの設定ボタン: サイドバー内の設定パネルを開閉する。 */
  async toggleSettings(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.post({ type: 'toggle_settings' });
  }

  // ---- Webview とのやり取り ----

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready': return this.postInit();
      case 'send': return this.send(m.text);
      case 'stop': this.abort?.abort(); return;
      case 'setMode':
        if (MODES.includes(m.mode as PermissionMode)) await this.context.globalState.update(MODE_KEY, m.mode);
        return this.postState();
      case 'setApiKey':
        if (m.key.trim()) await this.context.secrets.store(SECRET_KEY, m.key.trim());
        return this.postState();
      case 'setLevel':
        await this.context.globalState.update(LEVEL_KEY, coerceLevel(m.level));
        return this.postState();
      case 'setTestMode':
        await this.context.globalState.update(TEST_MODE_KEY, !!m.on);
        return this.postState();
      case 'openFile': {
        const cwd = this.cwd();
        if (!cwd) return;
        const uri = vscode.Uri.file(resolvePath(cwd, m.path));
        const line = Number.isInteger(m.line) && m.line! > 0 ? m.line! - 1 : undefined;
        const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
        await vscode.window.showTextDocument(uri, { preview: true, selection }).then(undefined, () => undefined);
        return;
      }
      case 'ask_response':
        this.pendingAsks.get(m.id)?.(Array.isArray(m.answers) ? m.answers.map(String) : []);
        return;
      case 'walk_answer':
        this.session?.answer(m.index, { blanks: m.blanks, next: m.next, nextUnknown: m.nextUnknown, review: m.review });
        return;
      case 'walk_recap_answer':
        this.session?.answerRecap(m.picks);
        return;
      case 'walk_next':
        this.session?.next();
        return;
      case 'walk_apply':
        if (!this.abort) await this.session?.apply(!!m.overwrite).catch((e) => this.onAgentEvent({ type: 'error', message: `反映に失敗しました: ${(e as Error).message}` }));
        return this.postState();
      case 'walk_discard':
        if (!this.abort) await this.session?.discard();
        return this.postState();
      case 'permission_response':
        this.pendingPermissions.get(m.toolCallId)?.(m.decision);
        return;
      case 'capture_request':
        if (!this.testMode()) return;
        return this.post({ type: 'capture', css: await fs.readFile(path.join(this.context.extensionUri.fsPath, 'media', 'main.css'), 'utf8').catch(() => '') });
      case 'capture_result':
        return this.saveCapture(m.dataUrl, m.error);
    }
  }

  private async send(text: string): Promise<void> {
    text = text.trim();
    if (!text || this.abort) return;
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    const cwd = this.cwd();
    if (!apiKey || !cwd) return this.postState();

    let provider;
    try {
      provider = observeProvider(this.providers.create(CONFIG.provider, { apiKey, baseUrl: CONFIG.baseUrl }), {
        log: (line) => this.writeLog(line),
        confirm: (info) => this.confirmCall(info),
      });
    } catch (e) {
      return this.onAgentEvent({ type: 'error', message: (e as Error).message });
    }

    const run = new AbortController();
    this.abort = run;
    this.skipConfirm = false;
    this.transcript.push({ kind: 'user', text });
    this.post({ type: 'user', text });
    await this.postState();

    const session = this.sessionFor(cwd);
    try {
      try {
        await session.beginRun();
      } catch (e) {
        return this.onAgentEvent({ type: 'error', message: (e as Error).message });
      }
      this.runFailed = false;
      this.lastAnswer = '';
      this.calls.clear();
      // 受け入れ条件が一つに決まらないときに利用者へ尋ねる道具と、その使い方の指示を足す
      const instructions = [CONFIG.customInstructions, ASK_INSTRUCTIONS].filter((t) => t.trim()).join('\n\n');

      const agent = new Agent({
        provider,
        tools: this.toolsWithAsk(),
        permissions: this.permissions,
        state: this.state,
        cwd,
        model: CONFIG.model,
        reasoningEffort: CONFIG.reasoningEffort,
        customInstructions: instructions,
        maxTurns: CONFIG.maxTurns,
        autoCompactTokens: CONFIG.autoCompactTokens,
        rgPath: this.rgPath,
        emit: (e) => this.onAgentEvent(e),
      });
      const note = session.takeNote();
      await agent.run((note ? `${note}\n\n` : '') + text + ideContext(), run.signal);

      // 実行を止めたあとでも、変更の取り置きは最後まで行う
      const after = new AbortController();
      this.abort = after;
      this.post({ type: 'activity', text: '変更内容をまとめています…' });
      const system = await buildSystemPrompt({ cwd, model: CONFIG.model, customInstructions: instructions });
      const asker = createAsker({ provider, model: CONFIG.model, reasoningEffort: CONFIG.reasoningEffort, system, messages: () => this.state.messages });
      const started = await session
        .endRun({ request: text, asker, level: this.level(), signal: after.signal, failed: this.runFailed })
        .catch((e) => {
          this.onAgentEvent({ type: 'error', message: `変更をまとめられませんでした: ${(e as Error).message}` });
          return false;
        });
      // 見せる手順が無い (変更も、読んだコードも無い) ときは、応答をそのまま見せる
      if (!started) this.showAnswer();
    } finally {
      this.abort = undefined;
      this.post({ type: 'activity', text: '' });
      await this.postState();
    }
  }

  private sessionFor(cwd: string): UnderstandSession {
    this.session ??= new UnderstandSession({
      cwd,
      state: this.state,
      rgPath: this.rgPath,
      post: (m) => this.onWalk(m),
      status: (text) => this.post({ type: 'activity', text }),
    });
    return this.session;
  }

  private onWalk(message: WalkMessage): void {
    this.transcript.push({ kind: 'walk', message });
    this.post({ type: 'walk', message });
    // 質問への回答は、問いをたどり終えてから見せる。実装の報告は見せない (手順そのものが説明になっている)
    if (message.type === 'walk_done' && message.outcome === 'read') this.showAnswer();
  }

  /** 最後の応答の文章を会話に出す */
  private showAnswer(): void {
    const text = this.lastAnswer;
    this.lastAnswer = '';
    if (!text) return;
    this.transcript.push({ kind: 'assistant', text });
    this.post({ type: 'event', event: { type: 'assistant_end', text } });
  }

  /** 利用者に質問を見せて、回答を待つ (AskUser ツールから呼ばれる) */
  private askUser(questions: AskQuestion[], signal: AbortSignal): Promise<string[] | undefined> {
    const id = `ask${++this.askCount}`;
    const item: TranscriptItem = { kind: 'ask', id, questions };
    this.transcript.push(item);
    return new Promise((resolve) => {
      const finish = (answers: string[] | undefined) => {
        if (!this.pendingAsks.delete(id)) return;
        if (answers) item.answers = answers;
        else this.post({ type: 'ask_cancel', id });
        resolve(answers);
      };
      this.pendingAsks.set(id, finish);
      signal.addEventListener('abort', () => finish(undefined), { once: true });
      this.post({ type: 'ask', id, questions });
      this.view?.show?.(true);
    });
  }

  /** いつもの道具に、利用者へ尋ねる道具を足したもの */
  private toolsWithAsk(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of this.tools.list()) registry.register(tool);
    registry.register(createAskUserTool((questions, signal) => this.askUser(questions, signal)));
    return registry;
  }

  /**
   * エージェントのイベント。ツールの呼び出し・編集内容・途中の文章は会話に出さず、
   * いま何をしているかだけを入力欄の上に1行で出す (中身は答えを含みうるうえ、読んでも作業の理解につながらないため)。
   */
  private onAgentEvent(event: AgentEvent): void {
    this.session?.record(event);
    switch (event.type) {
      case 'assistant_start':
        this.post({ type: 'activity', text: '次の作業を考えています…' });
        return;
      case 'assistant_end':
        if (event.text.trim()) this.lastAnswer = event.text;
        return;
      case 'tool_start':
        this.calls.set(event.id, { name: event.name, input: event.input });
        this.post({ type: 'activity', text: describeActivity(event.name, event.input, this.cwd() ?? '') });
        return;
      case 'tool_end': {
        const call = this.calls.get(event.id);
        if (call?.name === 'Bash' && event.isError) {
          const status = event.output.trim().split('\n').pop() ?? '';
          this.post({ type: 'activity', text: `コマンドが失敗しました: ${short(String(call.input?.command ?? ''), 40)}(${short(status, 40)})` });
        }
        return;
      }
      case 'text_delta':
      case 'done':
        return;
      case 'error':
        this.runFailed = true;
        this.transcript.push({ kind: 'error', text: event.message });
        break;
      case 'info':
        this.transcript.push({ kind: 'info', text: event.message });
        break;
      case 'aborted':
        this.runFailed = true;
        this.transcript.push({ kind: 'info', text: '中断しました。' });
        break;
    }
    this.post({ type: 'event', event });
  }

  // ---- 出力パネルとテストモード ----

  /** 出力パネル「GraspDev」に1行足す (時刻つき) */
  private writeLog(line: string): void {
    this.output.appendLine(`${new Date().toLocaleTimeString()} ${line}`);
  }

  /** テストモード: API を呼ぶ前に、目的・モデル・想定トークン数を見せて確認する */
  private async confirmCall(info: CallInfo): Promise<boolean> {
    if (!this.testMode() || this.skipConfirm) return true;
    const choice = await vscode.window.showInformationMessage(
      `API を呼び出します: ${info.purpose}`,
      { modal: true, detail: `モデル: ${info.model}\n想定入力トークン数: 約${info.estimatedTokens.toLocaleString('en-US')}` },
      RUN,
      RUN_ALL,
    );
    if (choice === RUN_ALL) this.skipConfirm = true;
    return choice === RUN || choice === RUN_ALL;
  }

  /**
   * テストモード: Webview が作った会話全体の画像を、利用者が選んだ場所に保存する。
   * 初期位置は前回保存したフォルダー (初回は拡張機能の保存領域の screenshots)。
   */
  private async saveCapture(dataUrl: string | undefined, error: string | undefined): Promise<void> {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl ?? '');
    if (!m) {
      void vscode.window.showErrorMessage(`画面を保存できませんでした: ${error ?? '画像を作れませんでした'}`);
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dir = this.context.globalState.get<string>(CAPTURE_DIR_KEY) || path.join(this.context.globalStorageUri.fsPath, 'screenshots');
    const picked = await vscode.window.showSaveDialog({
      title: '会話の画像を保存',
      saveLabel: '保存',
      defaultUri: vscode.Uri.file(path.join(dir, `chat-${stamp}.png`)),
      filters: { 'PNG 画像': ['png'] },
    });
    if (!picked) return; // 取り消した
    const file = /\.png$/i.test(picked.fsPath) ? picked.fsPath : `${picked.fsPath}.png`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(m[1], 'base64'));
    } catch (e) {
      void vscode.window.showErrorMessage(`画面を保存できませんでした: ${(e as Error).message}`);
      return;
    }
    await this.context.globalState.update(CAPTURE_DIR_KEY, path.dirname(file));
    const open = 'フォルダーを開く';
    void vscode.window.showInformationMessage(`画面を保存しました: ${file}`, open).then((choice) => {
      if (choice === open) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    });
  }

  private async viewState(): Promise<ViewState> {
    return {
      hasKey: !!(await this.context.secrets.get(SECRET_KEY)),
      busy: !!this.abort,
      permissionMode: this.permissionMode(),
      hasWorkspace: !!this.cwd(),
      level: this.level(),
      testMode: this.testMode(),
    };
  }

  private async postInit(): Promise<void> {
    this.post({ type: 'init', state: await this.viewState(), transcript: this.transcript });
    if (this.permissionView) this.post({ type: 'permission_request', ...this.permissionView });
  }

  private async postState(): Promise<void> {
    this.post({ type: 'state', state: await this.viewState() });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** 入力欄下のセレクタで選んだ権限モード。未選択なら CONFIG の既定値。 */
  private permissionMode(): PermissionMode {
    const mode = this.context.globalState.get<PermissionMode>(MODE_KEY, CONFIG.permissionMode);
    return MODES.includes(mode) ? mode : 'acceptEdits';
  }

  private level(): LearnerLevel {
    return coerceLevel(this.context.globalState.get<string>(LEVEL_KEY, CONFIG.level));
  }

  private testMode(): boolean {
    return this.context.globalState.get<boolean>(TEST_MODE_KEY, false);
  }

  private cwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}

/** アクティブなエディタと選択範囲を、モデル向けの付加情報として返す。 */
function ideContext(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return '';
  const file = editor.document.uri.fsPath;
  let info = `The user currently has this file open in the editor: ${file}`;
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const text = editor.document.getText(sel);
    info += `\nThey have lines ${sel.start.line + 1}-${sel.end.line + 1} selected`;
    info += text.length <= MAX_SELECTION_CHARS ? `:\n${text}` : ' (selection too long to include; Read the file if needed).';
  }
  return `\n\n<ide_context>\n${info}\nThis is background context and may or may not be related to the request.\n</ide_context>`;
}

/** VS Code に同梱されている ripgrep を探す。 */
function findBundledRipgrep(): string | undefined {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of ['node_modules/@vscode/ripgrep/bin', 'node_modules.asar.unpacked/@vscode/ripgrep/bin', 'node_modules/vscode-ripgrep/bin']) {
    const candidate = path.join(vscode.env.appRoot, dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
