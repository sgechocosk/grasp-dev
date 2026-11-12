import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CONFIG } from '../src/config';
import type { AssistantMessage, ToolCall } from '../src/core/types';
import { ProviderRegistry } from '../src/providers/provider';
import { createDefaultToolRegistry } from '../src/tools';
import { ChatViewProvider } from '../src/ui/chatViewProvider';
import type { HostMessage, WebviewMessage } from '../src/ui/protocol';
import { state as vscodeState } from './stubs/vscode';

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const reply = (content: string, toolCalls: ToolCall[] = []): AssistantMessage => ({ role: 'assistant', content, toolCalls });

const ORIGINAL = 'export function double(n: number): number {\n  return n * 2;\n}\n';

/** 画面のホストを、台本どおりに応答するプロバイダと、テスト用の画面で動かす */
function harness(settings: Record<string, unknown>, json: (name: string) => unknown = () => ({})) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-host-'));
  fs.writeFileSync(path.join(cwd, 'calc.ts'), ORIGINAL);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  vscodeState.folder = cwd;

  const file = path.join(cwd, 'calc.ts');
  const script = [
    reply('読みます', [call('r1', 'Read', { file_path: file })]),
    reply('直します', [call('e1', 'Edit', { file_path: file, old_string: 'n * 2', new_string: 'n + n' })]),
    reply('', [call('b1', 'Bash', { command: 'echo secret-output' })]),
    reply('足し算に変えました。'),
  ];
  let i = 0;
  const providers = new ProviderRegistry();
  providers.register(CONFIG.provider, () => ({
    id: 'scripted',
    async complete(req, onEvent) {
      if (req.jsonSchema) return { message: reply(JSON.stringify(json(req.jsonSchema.name))) };
      const message = script[i++];
      if (message.content) onEvent({ type: 'text', delta: message.content });
      return { message };
    },
  }));

  const store = new Map<string, unknown>(Object.entries(settings));
  const context: any = {
    extensionUri: { fsPath: '/ext' },
    subscriptions: [],
    secrets: { get: async () => 'key', store: async () => undefined, onDidChange: () => ({ dispose() {} }) },
    globalState: { get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => void store.set(k, v) },
  };
  const host = new ChatViewProvider(context, createDefaultToolRegistry(), providers);
  const posted: HostMessage[] = [];
  let receive: (m: WebviewMessage) => void = () => {};
  host.resolveWebviewView({
    webview: {
      options: {}, html: '', cspSource: '', asWebviewUri: (u: unknown) => u,
      postMessage: async (m: HostMessage) => {
        posted.push(m);
        // 許可の確認には、画面の代わりに「許可」と答える
        if (m.type === 'permission_request') receive({ type: 'permission_response', toolCallId: m.toolCallId, decision: { behavior: 'allow' } });
        return true;
      },
      onDidReceiveMessage: (fn: (m: WebviewMessage) => void) => { receive = fn; },
    },
    onDidDispose: () => undefined,
    show: () => undefined,
  } as any);
  const send = (m: WebviewMessage) => (host as any).onMessage(m) as Promise<void>;
  return { cwd, file, posted, send };
}

const events = (posted: HostMessage[]) => posted.flatMap((m) => (m.type === 'event' ? [m.event] : []));

test('理解モード: 実行中は作業の中身を出さず、たどり終えてから反映し、記録と報告を開示する', async () => {
  const h = harness({}, (name) => (name === 'change_interview' ? { understanding: '足し算にする', acceptanceCriteria: [], overall: '', steps: [], sites: [] } : { items: [], fixes: [] }));
  await h.send({ type: 'send', text: '足し算にして' });

  // 編集に許可は求めない。コマンドは実行前に確認する
  assert.deepEqual(h.posted.filter((m) => m.type === 'permission_request').map((m: any) => m.toolCallId), ['b1']);
  // 実行中に画面へ出るのは、コマンドのカード (出力なし) と進み具合だけ
  const live = events(h.posted);
  assert.deepEqual(live.filter((e) => e.type === 'tool_start').map((e: any) => e.name), ['Bash']);
  assert.deepEqual(live.filter((e) => e.type === 'tool_end').map((e: any) => e.output), ['']);
  assert.ok(!live.some((e) => e.type === 'text_delta' || e.type === 'assistant_end'));
  assert.ok(!JSON.stringify(h.posted.filter((m) => m.type !== 'walk')).includes('n + n'));
  assert.deepEqual((h.posted.filter((m) => m.type === 'progress').pop() as any).counts, { read: 1, search: 0, edit: 1, command: 1 });

  // 変更は取り置かれ、ファイルは変更前のまま
  assert.equal(fs.readFileSync(h.file, 'utf8'), ORIGINAL);
  const walk = h.posted.flatMap((m) => (m.type === 'walk' ? [m.message] : []));
  assert.deepEqual(walk.map((m) => m.type), ['walk_start', 'walk_step', 'walk_reveal']);
  assert.equal((h.posted.filter((m) => m.type === 'state').pop() as any).state.holding, true);

  await h.send({ type: 'walk_apply' }); // たどり終える前は反映しない
  assert.equal(fs.readFileSync(h.file, 'utf8'), ORIGINAL);
  await h.send({ type: 'walk_next' });
  await h.send({ type: 'walk_apply' });
  assert.match(fs.readFileSync(h.file, 'utf8'), /n \+ n/);

  // 反映のあとに、控えていた作業の記録と報告が出る
  const record = h.posted.find((m) => m.type === 'record') as any;
  assert.deepEqual(record.items.map((t: any) => t.name ?? t.kind), ['assistant', 'Read', 'assistant', 'Edit', 'Bash']);
  assert.match(record.items[4].output, /secret-output/);
  const lastEvent = events(h.posted).pop() as any;
  assert.deepEqual([lastEvent.type, lastEvent.text], ['assistant_end', '足し算に変えました。']);
  assert.equal((h.posted.filter((m) => m.type === 'state').pop() as any).state.holding, false);
});

test('理解モードをオフにすると、従来どおりすぐファイルに書き、作業をそのまま表示する', async () => {
  const h = harness({ 'graspDev.understand': false });
  await h.send({ type: 'send', text: '足し算にして' });
  assert.match(fs.readFileSync(h.file, 'utf8'), /n \+ n/);
  const live = events(h.posted);
  assert.deepEqual(live.filter((e) => e.type === 'tool_start').map((e: any) => e.name), ['Read', 'Edit', 'Bash']);
  assert.ok(live.some((e) => e.type === 'assistant_end' && e.text === '足し算に変えました。'));
  assert.ok(!h.posted.some((m) => m.type === 'walk' || m.type === 'record'));
  assert.deepEqual(h.posted.filter((m) => m.type === 'permission_request').map((m: any) => m.toolCallId), ['b1']);
});

test('以前の設定「編集・実行前に確認」は、コマンド実行前の確認として扱う', async () => {
  const h = harness({ 'graspDev.permissionMode': 'default', 'graspDev.understand': false });
  await h.send({ type: 'ready' });
  assert.equal((h.posted[0] as any).state.permissionMode, 'acceptEdits');
});
