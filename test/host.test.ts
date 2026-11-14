import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CONFIG } from '../src/config';
import type { AssistantMessage, ToolCall } from '../src/core/types';
import type { CompletionRequest } from '../src/providers/provider';
import { ProviderRegistry } from '../src/providers/provider';
import { createDefaultToolRegistry } from '../src/tools';
import { ChatViewProvider, describeActivity } from '../src/ui/chatViewProvider';
import type { HostMessage, WebviewMessage } from '../src/ui/protocol';
import { answers as dialogAnswers, dialogs, output, saveAnswers, saveDialogs, state as vscodeState } from './stubs/vscode';

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const reply = (content: string, toolCalls: ToolCall[] = []): AssistantMessage => ({ role: 'assistant', content, toolCalls });

const ORIGINAL = 'export function double(n: number): number {\n  return n * 2;\n}\n';
const EMPTY = { understanding: '', acceptanceCriteria: [], overall: '', verification: '', steps: [], sites: [], items: [], fixes: [] };

/** 画面のホストを、台本どおりに応答するプロバイダと、テスト用の画面で動かす */
function harness(settings: Record<string, unknown> = {}, opts: { ask?: boolean; question?: boolean } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-host-'));
  fs.writeFileSync(path.join(cwd, 'calc.ts'), ORIGINAL);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  vscodeState.folder = cwd;
  output.length = 0;
  dialogs.length = 0;
  dialogAnswers.length = 0;
  saveAnswers.length = 0;
  saveDialogs.length = 0;

  const file = path.join(cwd, 'calc.ts');
  const script = opts.question
    ? [reply('こんにちは。')]
    : [
        reply('読みます', [call('r1', 'Read', { file_path: file })]),
        ...(opts.ask
          ? [reply('', [call('q1', 'AskUser', { questions: [{ question: 'どう計算しますか', why: '書き方が複数ある', options: [{ label: '加算(推奨)', detail: 'n + n' }, { label: 'シフト', detail: 'n << 1' }] }] })])]
          : []),
        reply('直します', [call('e1', 'Edit', { file_path: file, old_string: 'n * 2', new_string: 'n + n' })]),
        reply('', [call('b1', 'Bash', { command: 'echo secret-output && exit 2' })]),
        reply('足し算に変えました。'),
      ];
  let i = 0;
  const seen: CompletionRequest[] = [];
  const providers = new ProviderRegistry();
  providers.register(CONFIG.provider, () => ({
    id: 'scripted',
    async complete(req, onEvent) {
      if (req.jsonSchema) return { message: reply(JSON.stringify(EMPTY)), usage: { inputTokens: 1200, outputTokens: 30, cachedTokens: 1024 } };
      seen.push({ ...req, messages: [...req.messages] });
      const message = script[i++];
      if (message.content) onEvent({ type: 'text', delta: message.content });
      return { message, usage: { inputTokens: 3310, outputTokens: 48, cachedTokens: 2816 } };
    },
  }));

  const store = new Map<string, unknown>(Object.entries(settings));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-storage-'));
  const context: any = {
    extensionUri: { fsPath: process.cwd() },
    globalStorageUri: { fsPath: storage },
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
        // 実装の前の質問には、最初の案を選んで答える
        if (m.type === 'ask') receive({ type: 'ask_response', id: m.id, answers: m.questions.map((q) => q.options[0].label) });
        return true;
      },
      onDidReceiveMessage: (fn: (m: WebviewMessage) => void) => { receive = fn; },
    },
    onDidDispose: () => undefined,
    show: () => undefined,
  } as any);
  const send = (m: WebviewMessage) => (host as any).onMessage(m) as Promise<void>;
  return { cwd, file, posted, send, seen, storage };
}

const activities = (posted: HostMessage[]) => posted.flatMap((m) => (m.type === 'activity' && m.text ? [m.text] : []));

test('実行中: コマンドや編集は会話に出さず、作業の内容を入力欄の上に1行で示す', async () => {
  const h = harness();
  await h.send({ type: 'send', text: '足し算にして' });

  // 会話に届くのは、利用者の文と手順だけ (ツールの呼び出し・途中の文章・実装の報告は届かない)
  assert.deepEqual([...new Set(h.posted.map((m) => m.type))].sort(), ['activity', 'event', 'permission_request', 'state', 'user', 'walk']);
  assert.deepEqual([...new Set(h.posted.flatMap((m) => (m.type === 'event' ? [m.event.type] : [])))], ['usage']);
  assert.ok(!JSON.stringify(h.posted.filter((m) => m.type !== 'walk')).includes('n + n'));
  // コマンドの出力は届かない (コマンドの文と、失敗したことだけを伝える)
  assert.ok(!JSON.stringify(h.posted).includes('secret-output\\n'));
  assert.ok(!JSON.stringify(h.posted).includes('足し算に変えました'));

  // 作業の内容は1行の文で伝える。編集は、どこを変えたかを書かない
  assert.deepEqual(activities(h.posted), [
    '次の作業を考えています…',
    'ファイルを読んでいます: calc.ts',
    '次の作業を考えています…',
    'コードを書き換えています',
    '次の作業を考えています…',
    'コマンドを実行しています: echo secret-output && exit 2',
    'コマンドが失敗しました: echo secret-output && exit 2(Exit code: 2)',
    '次の作業を考えています…',
    '変更内容をまとめています…',
    '変更の手順を組み立てています…',
  ]);

  // 編集に許可は求めない。コマンドは、入力欄の上で確認する
  const perms = h.posted.filter((m) => m.type === 'permission_request') as any[];
  assert.deepEqual(perms.map((m) => [m.toolCallId, m.title, m.detail]), [['b1', 'このコマンドを実行しますか?', 'echo secret-output && exit 2']]);

  // 変更は取り置かれ、たどり終えてから反映する
  assert.equal(fs.readFileSync(h.file, 'utf8'), ORIGINAL);
  await h.send({ type: 'walk_apply' });
  assert.equal(fs.readFileSync(h.file, 'utf8'), ORIGINAL);
  await h.send({ type: 'walk_next' });
  await h.send({ type: 'walk_apply' });
  assert.match(fs.readFileSync(h.file, 'utf8'), /n \+ n/);
});

test('出力パネル: API を呼ぶたびに、モデル・入出力トークン数・キャッシュを1行で記録する', async () => {
  const h = harness();
  await h.send({ type: 'send', text: '足し算にして' });
  const lines = output.map((l) => l.replace(/^\S+( [AP]M)? /, ''));
  assert.equal(lines.filter((l) => l === `${CONFIG.model} 入力3,310(キャッシュ2,816) 出力48`).length, 4);
  assert.ok(lines.includes(`${CONFIG.model} 入力1,200(キャッシュ1,024) 出力30`));
  // 送った内容やツールの使用は記録しない
  assert.ok(lines.every((l) => l.startsWith(CONFIG.model)));
  assert.equal(dialogs.length, 0);
});

test('テストモード: API を呼ぶ前に目的・モデル・想定トークン数を確認し、処理の中の確認を省ける', async () => {
  const h = harness({ 'graspDev.testMode': true });
  dialogAnswers.push('実行', 'この処理では以降確認しない');
  await h.send({ type: 'send', text: '足し算にして' });
  // 1回目と2回目だけ確認し、以降はこの処理が終わるまで確認しない
  assert.deepEqual(dialogs.map((d) => d.message), ['API を呼び出します: 調査と実装(1回目の応答)', 'API を呼び出します: 調査と実装(2回目の応答)']);
  assert.match(dialogs[0].detail!, new RegExp(`^モデル: ${CONFIG.model}\\n想定入力トークン数: 約[\\d,]+$`));
  assert.deepEqual(dialogs[0].items, ['実行', 'この処理では以降確認しない']);
  assert.ok(h.posted.some((m) => m.type === 'walk'));
  // テストモードでも、出力パネルに残すのは OpenAI API の記録だけ (ツールの使用は残さない)
  assert.ok(output.length > 0 && output.every((l) => l.replace(/^\S+( [AP]M)? /, '').startsWith(CONFIG.model)));

  // 次の処理では、また確認する。取り消すと API を呼ばずに止まる
  dialogs.length = 0;
  const before = h.seen.length;
  await h.send({ type: 'send', text: 'もう一度' });
  assert.equal(dialogs.length, 1);
  assert.equal(h.seen.length, before);
  assert.ok(h.posted.some((m) => m.type === 'event' && m.event.type === 'error' && /取り消しました/.test(m.event.message)));
});

test('テストモード: 会話全体の画像を、選んだ場所に保存する。次は前回のフォルダーから選べる', async () => {
  const h = harness({ 'graspDev.testMode': true });
  await h.send({ type: 'capture_request' });
  const capture = h.posted.find((m) => m.type === 'capture') as any;
  assert.match(capture.css, /#messages/);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = { type: 'capture_result', dataUrl: `data:image/png;base64,${png.toString('base64')}` } as const;

  // 1回目: 初期位置は拡張機能の保存領域。選んだ場所 (拡張子なしでも .png を付ける) に保存する
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-shots-'));
  saveAnswers.push(path.join(chosen, 'my-chat'));
  await h.send(result);
  assert.match(saveDialogs[0].defaultPath!, new RegExp(`^${h.storage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/screenshots/chat-\\d{8}-\\d{6}\\.png$`));
  assert.deepEqual(saveDialogs[0].filters, { 'PNG 画像': ['png'] });
  assert.deepEqual(fs.readFileSync(path.join(chosen, 'my-chat.png')), png);
  assert.match(dialogs[dialogs.length - 1].message, /画面を保存しました: .*my-chat\.png/);

  // 2回目: 前回保存したフォルダーが初期位置になる。取り消せば何も保存しない
  dialogs.length = 0;
  await h.send(result);
  assert.equal(path.dirname(saveDialogs[1].defaultPath!), chosen);
  assert.deepEqual(fs.readdirSync(chosen), ['my-chat.png']);
  assert.equal(dialogs.length, 0);

  // テストモードでなければ、保存しない
  const off = harness();
  await off.send({ type: 'capture_request' });
  assert.ok(!off.posted.some((m) => m.type === 'capture'));
});

test('受け入れ条件が一つに決まらないときは、実装の前に利用者へ尋ねる', async () => {
  const h = harness({}, { ask: true });
  await h.send({ type: 'send', text: '2倍の計算を直して' });
  // 尋ねる道具と指示が加わり、質問は編集の前に画面へ出る
  assert.ok(h.seen[0].tools.some((t) => t.name === 'AskUser'));
  assert.match(h.seen[0].system, /Decisions that belong to the user/);
  const ask = h.posted.find((m) => m.type === 'ask') as any;
  assert.equal(ask.questions[0].question, 'どう計算しますか');
  // 先頭の案には画面が「おすすめ」の札を付けるので、モデルが書いた「(推奨)」は取り除く
  assert.deepEqual(ask.questions[0].options.map((o: any) => o.label), ['加算', 'シフト']);
  // 利用者の決定がモデルに渡り、そのあとで実装が続く
  const answer = h.seen[2].messages.find((m) => m.role === 'tool' && m.toolCallId === 'q1') as any;
  assert.match(answer.content, /どう計算しますか\n {3}→ 加算/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), ORIGINAL);
  assert.ok(h.posted.some((m) => m.type === 'walk' && m.message.type === 'walk_start'));
});

test('変更も読んだコードも無い応答は、そのまま会話に出す', async () => {
  const h = harness({}, { question: true });
  await h.send({ type: 'send', text: 'こんにちは' });
  const texts = h.posted.flatMap((m) => (m.type === 'event' && m.event.type === 'assistant_end' ? [m.event.text] : []));
  assert.deepEqual(texts, ['こんにちは。']);
  assert.ok(!h.posted.some((m) => m.type === 'walk'));
});

test('以前の設定「編集・実行前に確認」は、コマンド実行前の確認として扱う。作業の表示は道具ごとに決まっている', async () => {
  const h = harness({ 'graspDev.permissionMode': 'default' });
  await h.send({ type: 'ready' });
  assert.equal((h.posted[0] as any).state.permissionMode, 'acceptEdits');
  assert.equal((h.posted[0] as any).state.testMode, false);
  assert.equal(describeActivity('Grep', { pattern: 'calcPrice\\(' }, '/w'), 'コードを検索しています: calcPrice\\(');
  assert.equal(describeActivity('Write', { file_path: '/w/a.ts' }, '/w'), 'コードを書き換えています');
  assert.equal(describeActivity('TodoWrite', {}, '/w'), '作業の段取りを整理しています');
});
