import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/core/agent';
import { PermissionManager, type PermissionDecision, type PermissionMode } from '../src/core/permissions';
import { createConversationState, type AgentEvent, type AssistantMessage, type ToolCall } from '../src/core/types';
import { OpenAIChatProvider } from '../src/providers/openaiChat';
import { OpenAIResponsesProvider } from '../src/providers/openaiResponses';
import type { CompletionRequest, LLMProvider } from '../src/providers/provider';
import { createDefaultToolRegistry } from '../src/tools';

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const reply = (content: string, toolCalls: ToolCall[] = []): AssistantMessage => ({ role: 'assistant', content, toolCalls });

/** 台本どおりに応答するプロバイダ */
function scripted(steps: AssistantMessage[], seen: CompletionRequest[] = []): LLMProvider {
  let i = 0;
  return {
    id: 'scripted',
    async complete(req, onEvent) {
      seen.push({ ...req, messages: [...req.messages] });
      const message = steps[i++];
      if (message.content) onEvent({ type: 'text', delta: message.content });
      return { message, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

function harness(provider: LLMProvider, mode: PermissionMode, decide?: () => PermissionDecision) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-agent-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta\n');
  const events: AgentEvent[] = [];
  const asked: string[] = [];
  const state = createConversationState();
  const permissions = new PermissionManager(() => mode, async (req) => {
    asked.push(req.key);
    return decide ? decide() : { behavior: 'allow' };
  });
  const agent = new Agent({ provider, tools: createDefaultToolRegistry(), permissions, state, cwd, model: 'm', emit: (e) => events.push(e) });
  return { agent, cwd, events, asked, state };
}

test('調査→編集→回答のループが回り、履歴とイベントが整合する', async () => {
  const seen: CompletionRequest[] = [];
  const h = harness(scripted([], seen), 'default');
  const file = path.join(h.cwd, 'a.txt');
  (h.agent as any).o.provider = scripted([
    reply('', [call('c1', 'Read', { file_path: file }), call('c2', 'Read', { file_path: path.join(h.cwd, 'b.txt') })]),
    reply('editing', [call('c3', 'Edit', { file_path: file, old_string: 'alpha', new_string: 'ALPHA' })]),
    reply('done'),
  ], seen);

  await h.agent.run('change it', new AbortController().signal);

  assert.equal(fs.readFileSync(file, 'utf8'), 'ALPHA\n');
  assert.deepEqual(h.asked, ['Edit']);
  assert.deepEqual(h.state.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant']);
  assert.equal(seen.length, 3);
  assert.match(seen[0].system, /GraspDev/);
  assert.ok(seen[0].tools.some((t) => t.name === 'Grep'));
  const types = h.events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'tool_start').length, 3);
  assert.equal(types.filter((t) => t === 'tool_end').length, 3);
  assert.equal(types.at(-1), 'done');
  assert.ok(!types.includes('error'));
});

test('拒否されたツールは実行されず、モデルにその旨が返る', async () => {
  const h = harness(scripted([reply('', [call('c1', 'Bash', { command: 'touch pwned' })]), reply('ok')]), 'default', () => ({ behavior: 'deny', message: 'no' }));
  await h.agent.run('x', new AbortController().signal);
  assert.ok(!fs.existsSync(path.join(h.cwd, 'pwned')));
  const tool = h.state.messages[2];
  assert.ok(tool.role === 'tool' && tool.isError && /denied/.test(tool.content) && /no/.test(tool.content));
});

test('権限モード: acceptEdits はワークスペース内の編集のみ自動許可、always は記憶される', async () => {
  const outside = path.join(os.tmpdir(), `grasp-outside-${Date.now()}.txt`);
  const h = harness(scripted([
    reply('', [call('c1', 'Write', { file_path: 'in.txt', content: '1' })]),
    reply('', [call('c2', 'Write', { file_path: outside, content: '1' })]),
    reply('', [call('c3', 'Bash', { command: 'echo 1' })]),
    reply('', [call('c4', 'Bash', { command: 'echo 2' })]),
    reply('end'),
  ]), 'acceptEdits', () => ({ behavior: 'always' }));
  await h.agent.run('x', new AbortController().signal);
  assert.deepEqual(h.asked, ['Write', 'Bash(echo *)']);
  fs.rmSync(outside, { force: true });
});

test('不正な引数・未知のツールはエラー結果になりループは続く', async () => {
  const h = harness(scripted([
    reply('', [{ id: 'c1', name: 'Read', arguments: '{bad' }, call('c2', 'Nope', {}), call('c3', 'Read', {})]),
    reply('recovered'),
  ]), 'default');
  await h.agent.run('x', new AbortController().signal);
  const tools = h.state.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 3);
  assert.match(tools[0].content, /Invalid JSON/);
  assert.match(tools[1].content, /Unknown tool/);
  assert.match(tools[2].content, /Missing required/);
  assert.equal(h.state.messages.at(-1)?.content, 'recovered');
});

test('許可待ち中に中断しても、全ツール呼び出しに結果が残る', async () => {
  const ac = new AbortController();
  const h = harness(scripted([reply('', [call('c1', 'Bash', { command: 'echo 1' }), call('c2', 'Bash', { command: 'echo 2' })])]), 'default');
  (h.agent as any).o.permissions = new PermissionManager(() => 'default', (_req, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ behavior: 'deny' }));
    setTimeout(() => ac.abort(), 10);
  }));
  await h.agent.run('x', ac.signal);
  assert.deepEqual(h.state.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.ok(h.events.some((e) => e.type === 'aborted'));
});

test('入力トークンが閾値を超えると履歴が要約に置き換わる', async () => {
  const h = harness(scripted([reply('', [call('c1', 'Read', { file_path: 'a.txt' })]), reply('SUMMARY'), reply('final')]), 'default');
  (h.agent as any).o.autoCompactTokens = 5;
  await h.agent.run('x', new AbortController().signal);
  assert.equal(h.state.messages.length, 2);
  assert.match(h.state.messages[0].content, /SUMMARY/);
  assert.equal(h.state.messages[1].content, 'final');
});

// ---- 実際のHTTP/SSE経路をモックサーバーで検証 ----

async function mockServer(handler: (path: string, body: any) => { status?: number; events?: unknown[]; error?: string }) {
  const requests: { path: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      requests.push({ path: req.url!, body });
      const r = handler(req.url!, body);
      if (r.error) {
        res.writeHead(r.status ?? 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: r.error } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // チャンク境界がイベント途中に来ても正しくパースできることを確かめるため細切れに送る
      const payload = r.events!.map((e) => `event: x\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\n\n';
      for (let i = 0; i < payload.length; i += 37) res.write(payload.slice(i, i + 37));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { baseUrl, requests, close: () => server.close() };
}

test('Responses API: ストリーム解析、推論アイテムの引き継ぎ、include 非対応時のフォールバック', async () => {
  let n = 0;
  const srv = await mockServer((_p, body) => {
    if (body.include && n++ === 0) return { error: 'Encrypted content is not supported with this model.' };
    if (!body.input.some((i: any) => i.type === 'function_call_output')) {
      return { events: [
        { type: 'response.output_text.delta', delta: 'Let me ' },
        { type: 'response.output_text.delta', delta: 'look.' },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' } },
        { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] } },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.txt"}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
      ] };
    }
    return { events: [
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It says alpha.' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 150, output_tokens: 5 } } },
    ] };
  });
  try {
    // 1回目: include を拒否される → include なしで再試行
    const fallback = new OpenAIResponsesProvider({ apiKey: 'k', baseUrl: srv.baseUrl });
    const h1 = harness(fallback, 'default');
    await h1.agent.run('what is in a.txt?', new AbortController().signal);
    assert.equal(h1.state.messages.at(-1)?.content, 'It says alpha.');
    assert.ok(srv.requests[0].body.include && !srv.requests[1].body.include);
    // include なしでは推論アイテムを送り返さない
    assert.ok(!srv.requests[2].body.input.some((i: any) => i.type === 'reasoning'));

    // 2回目: include が通る → 推論アイテムを encrypted_content ごと送り返す
    srv.requests.length = 0;
    const h2 = harness(new OpenAIResponsesProvider({ apiKey: 'k', baseUrl: srv.baseUrl }), 'default');
    await h2.agent.run('what is in a.txt?', new AbortController().signal);
    const [first, second] = srv.requests.map((r) => r.body);
    assert.equal(first.model, 'm');
    assert.equal(first.store, false);
    assert.match(first.instructions, /GraspDev/);
    assert.deepEqual(first.tools[0], { type: 'function', name: 'Read', description: first.tools[0].description, parameters: first.tools[0].parameters, strict: false });
    assert.deepEqual(second.input.map((i: any) => i.type ?? i.role), ['user', 'reasoning', 'message', 'function_call', 'function_call_output']);
    assert.equal(second.input[1].encrypted_content, 'ENC');
    assert.equal(second.input[3].id, undefined);
    assert.match(second.input[4].output, /alpha/);
    const text = h2.events.filter((e) => e.type === 'text_delta').map((e: any) => e.delta).join('');
    assert.equal(text, 'Let me look.');
    assert.deepEqual(h2.events.filter((e) => e.type === 'usage').map((e: any) => e.usage.inputTokens), [100, 150]);
  } finally {
    srv.close();
  }
});

test('Chat Completions API: 分割されたツール呼び出しの組み立てと履歴変換', async () => {
  const srv = await mockServer((_p, body) => {
    if (body.messages.at(-1).role !== 'tool') {
      return { events: [
        { choices: [{ delta: { role: 'assistant', content: 'Hm' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Glob', arguments: '{"pattern":"*.txt"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ] };
    }
    return { events: [{ choices: [{ delta: { content: 'alpha!' } }] }] };
  });
  try {
    const h = harness(new OpenAIChatProvider({ apiKey: 'k', baseUrl: srv.baseUrl }), 'default');
    await h.agent.run('q', new AbortController().signal);
    assert.equal(h.state.messages.at(-1)?.content, 'alpha!');
    const second = srv.requests[1].body;
    assert.equal(srv.requests[1].path, '/v1/chat/completions');
    assert.deepEqual(second.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool', 'tool']);
    assert.equal(second.messages[2].tool_calls[0].function.arguments, '{"file_path":"a.txt"}');
    assert.match(second.messages[3].content, /alpha/);
    assert.match(second.messages[4].content, /a\.txt/);
  } finally {
    srv.close();
  }
});

test('APIエラーはメッセージ付きで error イベントになる', async () => {
  const srv = await mockServer(() => ({ status: 401, error: 'Incorrect API key provided' }));
  try {
    const h = harness(new OpenAIResponsesProvider({ apiKey: 'bad', baseUrl: srv.baseUrl }), 'default');
    await h.agent.run('q', new AbortController().signal);
    const error = h.events.find((e) => e.type === 'error') as any;
    assert.match(error.message, /401.*Incorrect API key/);
  } finally {
    srv.close();
  }
});
