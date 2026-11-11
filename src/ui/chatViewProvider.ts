import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG } from '../config';
import { Agent } from '../core/agent';
import { PermissionManager, type PermissionDecision, type PermissionMode } from '../core/permissions';
import { createConversationState, type AgentEvent, type ConversationState } from '../core/types';
import type { ProviderRegistry } from '../providers/provider';
import { resolvePath, type ToolRegistry } from '../tools/tool';
import { renderHtml } from './html';
import type { HostMessage, TranscriptItem, ViewState, WebviewMessage } from './protocol';

const SECRET_KEY = 'graspDev.openaiApiKey';
const MODE_KEY = 'graspDev.permissionMode';
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
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
      case 'openFile': {
        const cwd = this.cwd();
        if (!cwd) return;
        const uri = vscode.Uri.file(resolvePath(cwd, m.path));
        await vscode.window.showTextDocument(uri, { preview: true }).then(undefined, () => undefined);
        return;
      }
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

    this.abort = new AbortController();
    this.transcript.push({ kind: 'user', text });
    this.post({ type: 'user', text });
    await this.postState();

    const agent = new Agent({
      provider,
      tools: this.tools,
      permissions: this.permissions,
      state: this.state,
      cwd,
      model: CONFIG.model,
      reasoningEffort: CONFIG.reasoningEffort,
      customInstructions: CONFIG.customInstructions,
      maxTurns: CONFIG.maxTurns,
      autoCompactTokens: CONFIG.autoCompactTokens,
      rgPath: this.rgPath,
      emit: (e) => this.onAgentEvent(e),
    });
    try {
      await agent.run(text + ideContext(), this.abort.signal);
    } finally {
      this.abort = undefined;
      await this.postState();
    }
  }

  private onAgentEvent(event: AgentEvent): void {
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

  private async viewState(): Promise<ViewState> {
    return {
      hasKey: !!(await this.context.secrets.get(SECRET_KEY)),
      busy: !!this.abort,
      permissionMode: this.permissionMode(),
      hasWorkspace: !!this.cwd(),
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
    return this.context.globalState.get<PermissionMode>(MODE_KEY, CONFIG.permissionMode);
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
