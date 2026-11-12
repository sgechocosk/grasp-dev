import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG } from '../config';
import { Agent } from '../core/agent';
import { PermissionManager, type PermissionDecision, type PermissionMode } from '../core/permissions';
import { buildSystemPrompt } from '../core/systemPrompt';
import { createConversationState, type AgentEvent, type ConversationState } from '../core/types';
import type { ProviderRegistry } from '../providers/provider';
import { resolvePath, ToolRegistry } from '../tools/tool';
import { ASK_INSTRUCTIONS, createAskUserTool, type AskQuestion } from '../understand/askUser';
import { coerceLevel, type LearnerLevel } from '../understand/lib/level';
import { createAsker } from '../understand/llm';
import { UnderstandSession, type WalkMessage } from '../understand/session';
import { renderHtml } from './html';
import type { HostMessage, ToolItem, TranscriptItem, ViewState, WebviewMessage } from './protocol';

const SECRET_KEY = 'graspDev.openaiApiKey';
const MODE_KEY = 'graspDev.permissionMode';
const UNDERSTAND_KEY = 'graspDev.understand';
const LEVEL_KEY = 'graspDev.level';
/** ワークスペース内の編集は常に確認なし (変更は取り置かれ、たどり終えてから反映するため)。選べるのはコマンド実行の確認だけ */
const MODES: PermissionMode[] = ['acceptEdits', 'bypassPermissions'];
const MAX_SELECTION_CHARS = 4000;
/** 表示用に保持するツール出力の上限 (モデルに渡す履歴は別管理) */
const MAX_TRANSCRIPT_OUTPUT = 8000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'graspDev.chat';

  private view?: vscode.WebviewView;
  /** 会話はメモリ上にのみ保持し、ウィンドウを閉じると破棄される */
  private state: ConversationState = createConversationState();
  private transcript: TranscriptItem[] = [];
  private abort?: AbortController;
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private permissions: PermissionManager;
  private rgPath = findBundledRipgrep();
  /** 取り置きと、たどる手順の進行役 (ワークスペースごと) */
  private session?: UnderstandSession;
  /** 実行中、作業の中身 (編集内容・途中の文章) を画面に出さずに控えているか */
  private hiding = false;
  /** 控えている作業の記録。手順をたどり終えたら開示する */
  private heldItems: TranscriptItem[] = [];
  /** 控えずに画面へ出したツール (許可の確認が要るもの) */
  private shownTools = new Set<string>();
  private runFailed = false;
  /** 利用者の回答を待っている質問 */
  private pendingAsks = new Map<string, (answers: string[] | undefined) => void>();
  private askCount = 0;

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
          resolve(d);
        };
        signal.addEventListener('abort', () => {
          this.post({ type: 'permission_cancel', toolCallId: req.toolCallId });
          finish({ behavior: 'deny' });
        }, { once: true });
        this.pendingPermissions.set(req.toolCallId, finish);
        this.showHeldTool(req.toolCallId);
        this.post({ type: 'permission_request', toolCallId: req.toolCallId, key: req.key });
        // サイドバーが閉じていると確認に気づけないので前面に出す
        this.view?.show?.(true);
      }),
    );

    context.subscriptions.push(
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
      case 'setUnderstand':
        await this.context.globalState.update(UNDERSTAND_KEY, !!m.on);
        return this.postState();
      case 'setLevel':
        await this.context.globalState.update(LEVEL_KEY, coerceLevel(m.level));
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
        this.session?.answer(m.index, { blanks: m.blanks, next: m.next });
        return;
      case 'walk_next':
        this.session?.next();
        return;
      case 'walk_apply':
        if (!this.abort) await this.session?.apply().catch((e) => this.onAgentEvent({ type: 'error', message: `反映に失敗しました: ${(e as Error).message}` }));
        return this.postState();
      case 'walk_discard':
        if (!this.abort) await this.session?.discard();
        return this.postState();
      case 'permission_response':
        this.pendingPermissions.get(m.toolCallId)?.(m.decision);
        return;
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
      provider = this.providers.create(CONFIG.provider, { apiKey, baseUrl: CONFIG.baseUrl });
    } catch (e) {
      return this.onAgentEvent({ type: 'error', message: (e as Error).message });
    }

    const run = new AbortController();
    this.abort = run;
    this.transcript.push({ kind: 'user', text });
    this.post({ type: 'user', text });
    await this.postState();

    // 理解モード、または取り置き中・手順の途中なら、進行役を通す
    const session = this.understand() || this.session?.holding || this.session?.walking ? this.sessionFor(cwd) : undefined;
    try {
      if (session) {
        try {
          await session.beginRun();
        } catch (e) {
          return this.onAgentEvent({ type: 'error', message: (e as Error).message });
        }
      }
      this.hiding = !!session;
      this.runFailed = false;
      // 理解モードでは、受け入れ条件が一つに決まらないときに利用者へ尋ねる道具と指示を足す
      const instructions = [CONFIG.customInstructions, session ? ASK_INSTRUCTIONS : ''].filter((t) => t.trim()).join('\n\n');

      const agent = new Agent({
        provider,
        tools: session ? this.toolsWithAsk() : this.tools,
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
      const note = session?.takeNote();
      await agent.run((note ? `${note}\n\n` : '') + text + ideContext(), run.signal);

      if (session) {
        // 実行を止めたあとでも、変更の取り置きは最後まで行う
        const after = new AbortController();
        this.abort = after;
        this.post({ type: 'status', text: '変更を確認しています…' });
        const system = await buildSystemPrompt({ cwd, model: CONFIG.model, customInstructions: instructions });
        const asker = createAsker({ provider, model: CONFIG.model, reasoningEffort: CONFIG.reasoningEffort, system, messages: () => this.state.messages });
        const started = await session
          .endRun({ request: text, asker, level: this.level(), signal: after.signal, failed: this.runFailed })
          .catch((e) => {
            this.onAgentEvent({ type: 'error', message: `変更の取り置きに失敗しました: ${(e as Error).message}` });
            return false;
          });
        if (!started) this.revealHeld(true);
      }
    } finally {
      this.hiding = false;
      this.abort = undefined;
      this.post({ type: 'status', text: '' });
      await this.postState();
    }
  }

  private sessionFor(cwd: string): UnderstandSession {
    this.session ??= new UnderstandSession({
      cwd,
      state: this.state,
      rgPath: this.rgPath,
      post: (m) => this.onWalk(m),
      status: (text) => this.post({ type: 'status', text }),
    });
    return this.session;
  }

  private onWalk(message: WalkMessage): void {
    this.transcript.push({ kind: 'walk', message });
    this.post({ type: 'walk', message });
    // たどり終えた (反映・破棄・回答の開示) ら、控えていた作業の記録を見せる
    // 質問への回答はそのまま見せる。実装の報告は、利用者が主体の手順のあとに並べず、記録の中に入れる
    if (message.type === 'walk_done' && message.outcome !== 'continued') this.revealHeld(message.outcome === 'read');
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

  /** 控えていた作業の記録を画面に出す。showAnswer なら、最後の応答 (質問への回答) は記録の外にそのまま出す */
  private revealHeld(showAnswer: boolean): void {
    const items = this.heldItems;
    this.heldItems = [];
    this.shownTools.clear();
    if (items.length === 0) return;
    let answer: TranscriptItem | undefined;
    const last = items[items.length - 1];
    if (showAnswer && last.kind === 'assistant') answer = items.pop();
    if (items.length > 0) {
      this.transcript.push({ kind: 'record', items });
      this.post({ type: 'record', items });
    }
    if (answer?.kind === 'assistant') {
      this.transcript.push(answer);
      this.post({ type: 'event', event: { type: 'assistant_end', text: answer.text } });
    }
  }

  /** 控えているツールのうち、許可の確認が要るものは画面に出す */
  private showHeldTool(id: string): void {
    if (!this.hiding || this.shownTools.has(id)) return;
    const item = this.heldItems.find((t): t is ToolItem => t.kind === 'tool' && t.id === id);
    if (!item) return;
    this.shownTools.add(id);
    this.post({ type: 'event', event: { type: 'tool_start', id: item.id, name: item.name, input: item.input, summary: item.summary } });
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === 'error' || event.type === 'aborted') this.runFailed = true;
    if (this.hiding) return this.onHiddenEvent(event);
    switch (event.type) {
      case 'assistant_end':
        if (event.text) this.transcript.push({ kind: 'assistant', text: event.text });
        break;
      case 'tool_start':
        this.transcript.push({ kind: 'tool', id: event.id, name: event.name, input: event.input, summary: event.summary, done: false });
        break;
      case 'tool_end': {
        const item = this.transcript.find((t) => t.kind === 'tool' && t.id === event.id);
        if (item?.kind === 'tool') Object.assign(item, { output: event.output.slice(0, MAX_TRANSCRIPT_OUTPUT), isError: event.isError, done: true });
        break;
      }
      case 'info':
      case 'error':
        this.transcript.push({ kind: event.type, text: event.message });
        break;
      case 'aborted':
        this.transcript.push({ kind: 'info', text: '中断しました。' });
        break;
    }
    this.post({ type: 'event', event });
  }

  /**
   * 理解モードの実行中。作業の中身 (編集内容・途中の文章・コマンドの出力) は答えを含みうるので、
   * 記録に控えるだけにして、画面には進み具合だけを出す。
   */
  private onHiddenEvent(event: AgentEvent): void {
    this.session?.record(event);
    switch (event.type) {
      case 'assistant_end':
        if (event.text) this.heldItems.push({ kind: 'assistant', text: event.text });
        return;
      case 'tool_start':
        this.heldItems.push({ kind: 'tool', id: event.id, name: event.name, input: event.input, summary: event.summary, done: false });
        // コマンドは、何を実行するかが見えるようにする (出力は控える)
        if (event.name === 'Bash') this.showHeldTool(event.id);
        return;
      case 'tool_end': {
        const item = this.heldItems.find((t) => t.kind === 'tool' && t.id === event.id);
        if (item?.kind === 'tool') Object.assign(item, { output: event.output.slice(0, MAX_TRANSCRIPT_OUTPUT), isError: event.isError, done: true });
        if (this.shownTools.has(event.id)) {
          this.post({ type: 'event', event: { ...event, output: '' } });
          // 失敗したコマンドは、原因 (環境の不備など) を確かめられるよう、出力を開けるようにする
          if (event.isError) this.post({ type: 'tool_failure', id: event.id, output: event.output.slice(-MAX_TRANSCRIPT_OUTPUT) });
        }
        this.post({ type: 'progress', counts: this.session?.counts ?? { read: 0, search: 0, edit: 0, command: 0 } });
        return;
      }
      case 'assistant_start':
      case 'text_delta':
      case 'done':
        return;
      case 'info':
      case 'error':
        this.transcript.push({ kind: event.type, text: event.message });
        break;
      case 'aborted':
        this.transcript.push({ kind: 'info', text: '中断しました。' });
        break;
    }
    this.post({ type: 'event', event });
  }

  private async viewState(): Promise<ViewState> {
    return {
      hasKey: !!(await this.context.secrets.get(SECRET_KEY)),
      busy: !!this.abort,
      permissionMode: this.permissionMode(),
      hasWorkspace: !!this.cwd(),
      understand: this.understand(),
      level: this.level(),
      holding: !!this.session?.holding,
    };
  }

  private async postInit(): Promise<void> {
    this.post({ type: 'init', state: await this.viewState(), transcript: this.transcript });
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

  /** 変更を取り置いて、たどり終えてから反映するか (オフにすると、従来どおりすぐファイルに書く) */
  private understand(): boolean {
    return this.context.globalState.get<boolean>(UNDERSTAND_KEY, CONFIG.understand);
  }

  private level(): LearnerLevel {
    return coerceLevel(this.context.globalState.get<string>(LEVEL_KEY, CONFIG.level));
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
