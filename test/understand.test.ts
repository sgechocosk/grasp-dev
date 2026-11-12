import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/core/agent';
import { PermissionManager } from '../src/core/permissions';
import { createConversationState, type AgentEvent, type AssistantMessage, type ConversationState, type ToolCall } from '../src/core/types';
import type { CompletionRequest, LLMProvider } from '../src/providers/provider';
import { createDefaultToolRegistry } from '../src/tools';
import { Baseline, staleFiles, writeState } from '../src/understand/changeSet';
import { showDiff } from '../src/understand/lesson';
import { analyzeImpact, WorkspaceView } from '../src/understand/impact';
import { BLANK } from '../src/understand/lib/types';
import { createAsker } from '../src/understand/llm';
import { Recorder } from '../src/understand/recorder';
import { UnderstandSession, type WalkMessage } from '../src/understand/session';
import { buildSteps, condense, editsOf, MAX_STEPS, reorderByCause } from '../src/understand/steps';

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const reply = (content: string, toolCalls: ToolCall[] = []): AssistantMessage => ({ role: 'assistant', content, toolCalls });

const FILES: Record<string, string> = {
  'src/price.ts': [
    'export function calcPrice(amount: number): number {',
    '  return amount * 1.1;',
    '}',
    '',
    'export function formatPrice(value: number): string {',
    '  return `${value}円`;',
    '}',
    '',
  ].join('\n'),
  'src/cart.ts': [
    "import { calcPrice, formatPrice } from './price';",
    '',
    'export function cartTotal(items: number[]): string {',
    '  let sum = 0;',
    '  for (const item of items) {',
    '    sum += calcPrice(item);',
    '  }',
    '  return formatPrice(sum);',
    '}',
    '',
  ].join('\n'),
  'src/report.ts': ["import { calcPrice } from './price';", '', 'export function reportLine(amount: number): string {', '  return `total: ${calcPrice(amount)}`;', '}', ''].join('\n'),
  'src/unused.ts': ["import { calcPrice } from './price';", '', 'export function legacyTotal(amount: number): number {', '  return calcPrice(amount) * 2;', '}', ''].join('\n'),
  'src/util.ts': ['export function clamp(value: number): number {', '  return Math.max(0, value);', '}', '', 'export function roundYen(value: number): number {', '  return Math.round(value);', '}', ''].join('\n'),
  'README.md': '# shop\n',
};

function makeRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-understand-'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return cwd;
}

const read = (cwd: string, rel: string): string => fs.readFileSync(path.join(cwd, rel), 'utf8');
const status = (cwd: string): string => execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();

/** 税率を引数にする変更を行うエージェントの台本 (unused.ts は読まない) */
function changeScript(cwd: string): AssistantMessage[] {
  const p = (rel: string) => path.join(cwd, rel);
  return [
    reply('', [
      call('r1', 'Read', { file_path: p('src/price.ts') }),
      call('r2', 'Read', { file_path: p('src/cart.ts') }),
      call('r3', 'Read', { file_path: p('src/report.ts') }),
      call('r4', 'Read', { file_path: p('src/util.ts') }),
    ]),
    reply('', [
      call('e1', 'Edit', {
        file_path: p('src/price.ts'),
        old_string: 'export function calcPrice(amount: number): number {\n  return amount * 1.1;',
        new_string: 'export function calcPrice(amount: number, rate: number): number {\n  return amount * (1 + rate);',
      }),
    ]),
    reply('', [call('e2', 'Edit', { file_path: p('src/cart.ts'), old_string: 'sum += calcPrice(item);', new_string: 'sum += calcPrice(item, 0.1);' })]),
    reply('', [call('b1', 'Bash', { command: 'echo generated > gen.txt' })]),
    reply('税率を引数で渡すようにしました。'),
  ];
}

interface Scripted extends LLMProvider {
  seen: CompletionRequest[];
  asked: string[];
}

/** 台本どおりに応答するプロバイダ。JSONスキーマ付きの問い合わせには json で答える */
function scripted(steps: AssistantMessage[], json: (name: string, prompt: string) => unknown = () => ({})): Scripted {
  let i = 0;
  const seen: CompletionRequest[] = [];
  const asked: string[] = [];
  return {
    id: 'scripted',
    seen,
    asked,
    async complete(req, onEvent) {
      if (req.jsonSchema) {
        asked.push(req.jsonSchema.name);
        const last = req.messages[req.messages.length - 1];
        return { message: reply(JSON.stringify(json(req.jsonSchema.name, last.role === 'user' ? last.content : ''))) };
      }
      seen.push({ ...req, messages: [...req.messages] });
      const message = steps[i++];
      if (message.content) onEvent({ type: 'text', delta: message.content });
      return { message, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

function makeAgent(cwd: string, provider: LLMProvider, state: ConversationState, emit: (e: AgentEvent) => void): Agent {
  const permissions = new PermissionManager(() => 'bypassPermissions', async () => ({ behavior: 'allow' }));
  return new Agent({ provider, tools: createDefaultToolRegistry(), permissions, state, cwd, model: 'm', emit });
}

const signal = () => new AbortController().signal;

test('記録: 読んだ行・検索・コマンドを控え、記録の有無でモデルへの要求は変わらない', async () => {
  const cwd = makeRepo();
  const plain = scripted(changeScript(cwd));
  await makeAgent(cwd, plain, createConversationState(), () => {}).run('税率を引数にして', signal());

  execFileSync('git', ['checkout', '-q', '.'], { cwd });
  fs.rmSync(path.join(cwd, 'gen.txt'));
  const baseline = await Baseline.capture(cwd);
  const recorder = new Recorder(cwd, (f) => baseline.note(f));
  const recorded = scripted(changeScript(cwd));
  await makeAgent(cwd, recorded, createConversationState(), (e) => recorder.onEvent(e)).run('税率を引数にして', signal());

  const strip = (reqs: CompletionRequest[]) => JSON.parse(JSON.stringify(reqs.map(({ signal: _s, ...r }) => r)));
  assert.deepEqual(strip(recorded.seen), strip(plain.seen));

  assert.deepEqual(recorder.counts, { read: 4, search: 0, edit: 2, command: 1 });
  assert.equal(recorder.coverage(path.join(cwd, 'src/price.ts'), 1, 3), 1);
  assert.ok(recorder.hasSeen(path.join(cwd, 'src/report.ts'), '  return `total: ${calcPrice(amount)}`;'));
  assert.ok(!recorder.hasSeen(path.join(cwd, 'src/unused.ts'), '  return calcPrice(amount) * 2;'));
  assert.deepEqual(recorder.commands.map((c) => [c.command, c.ok]), [['echo generated > gen.txt', true]]);
  assert.equal(recorder.finalText, '税率を引数で渡すようにしました。');
});

test('取り置き: コマンドが作ったファイルも含めて集め、変更前に戻し、同じ内容で反映できる', async () => {
  const cwd = makeRepo();
  // 実行前から未コミットだった変更は、その内容が「変更前」になる
  fs.writeFileSync(path.join(cwd, 'README.md'), '# shop\nlocal note\n');
  const baseline = await Baseline.capture(cwd);
  assert.ok(baseline.usesGit);
  const recorder = new Recorder(cwd, (f) => baseline.note(f));
  const script = changeScript(cwd);
  script.splice(3, 0, reply('', [call('b0', 'Bash', { command: "printf '# shop\\nlocal note\\nmore\\n' > README.md && git add -A" })]));
  await makeAgent(cwd, scripted(script), createConversationState(), (e) => recorder.onEvent(e)).run('go', signal());

  const { changes, unheld } = await baseline.collect();
  assert.deepEqual(changes.map((c) => c.rel), ['README.md', 'gen.txt', 'src/cart.ts', 'src/price.ts']);
  assert.deepEqual(unheld, []);
  const byRel = Object.fromEntries(changes.map((c) => [c.rel, c]));
  assert.equal(byRel['README.md'].before, '# shop\nlocal note\n');
  assert.equal(byRel['gen.txt'].before, null);
  assert.equal(byRel['src/price.ts'].before, FILES['src/price.ts']);

  await writeState(changes, 'before');
  assert.equal(read(cwd, 'src/price.ts'), FILES['src/price.ts']);
  assert.equal(read(cwd, 'README.md'), '# shop\nlocal note\n');
  assert.ok(!fs.existsSync(path.join(cwd, 'gen.txt')));
  assert.deepEqual(await staleFiles(changes, 'before'), []);

  fs.writeFileSync(path.join(cwd, 'src/cart.ts'), FILES['src/cart.ts'] + '// edited by user\n');
  assert.deepEqual(await staleFiles(changes, 'before'), ['src/cart.ts']);
  fs.writeFileSync(path.join(cwd, 'src/cart.ts'), FILES['src/cart.ts']);

  await writeState(changes, 'after');
  assert.match(read(cwd, 'src/price.ts'), /rate: number/);
  assert.equal(read(cwd, 'gen.txt'), 'generated\n');
  assert.equal(read(cwd, 'README.md'), '# shop\nlocal note\nmore\n');
});

test('取り置き: git 管理でないフォルダでは Edit / Write の分を扱う', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-nogit-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
  const baseline = await Baseline.capture(cwd);
  assert.ok(!baseline.usesGit);
  baseline.note(path.join(cwd, 'a.txt'));
  baseline.note(path.join(cwd, 'new.txt'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'ALPHA\n');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'n\n');
  const { changes } = await baseline.collect();
  assert.deepEqual(changes.map((c) => [c.rel, c.before, c.after]), [['a.txt', 'alpha\n', 'ALPHA\n'], ['new.txt', null, 'n\n']]);
});

test('ステップ: 宣言ごとに分け、置き換えると変更後のファイルになる', () => {
  const before = FILES['src/price.ts'];
  const after = before.replace('amount: number)', 'amount: number, rate: number)').replace('amount * 1.1', 'amount * (1 + rate)').replace('`${value}円`', '`¥${value}`');
  const edits = editsOf({ path: '/x/src/price.ts', rel: 'src/price.ts', before, after });
  assert.deepEqual(edits.map((e) => e.symbol), ['calcPrice', 'formatPrice']);
  const lines = before.split('\n');
  for (const e of [...edits].reverse()) lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.after.split('\n'));
  assert.equal(lines.join('\n'), after);

  // import だけの変更は問いにしない。新しいファイルは1つのステップ
  const steps = buildSteps([
    { path: '/x/src/cart.ts', rel: 'src/cart.ts', before: FILES['src/cart.ts'], after: "import { roundYen } from './util';\n" + FILES['src/cart.ts'] },
    { path: '/x/src/tax.ts', rel: 'src/tax.ts', before: null, after: 'export const RATE = 0.1;\n' },
    { path: '/x/README.md', rel: 'README.md', before: '# shop\n', after: '# shop\n\nusage\n' },
  ]);
  assert.deepEqual(steps.map((s) => [s.edits[0].path, s.quizzable, s.kind]), [['src/cart.ts', false, 'core'], ['src/tax.ts', true, 'core'], ['README.md', false, 'doc']]);
});

test('ステップが多いときは、問いにしないものをファイルごとにまとめる', () => {
  const fns = (n: number, body: string) => Array.from({ length: n }, (_, i) => `export function f${i}(): number {\n  return ${body};\n}\n`).join('\n');
  const changes = ['a', 'b'].map((name) => ({ path: `/x/${name}.ts`, rel: `${name}.ts`, before: fns(8, '1'), after: fns(8, '2') }));
  const steps = buildSteps(changes);
  assert.equal(steps.length, 16);
  const obligations = [{ step: steps[5].id, sites: [{ step: steps[12].id }] }];
  const keep = new Set(steps.slice(0, 3).map((s) => s.id));
  const out = condense(steps, obligations, keep);
  assert.ok(out.length <= MAX_STEPS);
  assert.deepEqual(out.map((s) => [s.number, s.edits[0].path, s.edits.length, s.quizzable]), [
    [1, 'a.ts', 1, true], [2, 'a.ts', 1, true], [3, 'a.ts', 1, true], [4, 'a.ts', 5, false], [5, 'b.ts', 8, false],
  ]);
  assert.deepEqual(obligations, [{ step: out[3].id, sites: [{ step: out[4].id }] }]);
});

test('差分の表示: 変えた行の前後だけを残し、離れた行は省略する', () => {
  const before = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
  const after = before.replace('line2', 'LINE2').replace('line10\n', '');
  assert.deepEqual(showDiff(before, after).split('\n'), [
    '  line1', '- line2', '+ LINE2', '  line3', '  line4', '… (3行省略)', '  line8', '  line9', '- line10', '  line11', '  line12',
  ]);
  assert.equal(showDiff('', 'a\nb'), '+ a\n+ b');
  assert.equal(showDiff('same', 'same'), '');
});

async function runChange(cwd: string) {
  const baseline = await Baseline.capture(cwd);
  const recorder = new Recorder(cwd, (f) => baseline.note(f));
  await makeAgent(cwd, scripted(changeScript(cwd)), createConversationState(), (e) => recorder.onEvent(e)).run('go', signal());
  const { changes } = await baseline.collect();
  await writeState(changes, 'before');
  return { changes, recorder };
}

test('影響: 変わった宣言の参照先を、変更した / 読んで変更なし / 未確認 に分ける', async () => {
  const cwd = makeRepo();
  const { changes, recorder } = await runChange(cwd);
  const view = await WorkspaceView.load(cwd, changes, { signal: signal() });
  let steps = buildSteps(changes);
  const obligations = analyzeImpact(steps, changes, view, recorder);
  steps = reorderByCause(steps);

  const callers = obligations.find((o) => o.subject === 'calcPrice')!;
  assert.equal(callers.pattern, 'callers');
  assert.deepEqual(
    callers.sites.map((s) => [s.path, s.symbol, s.verdict]),
    [['src/cart.ts', 'cartTotal', 'changed'], ['src/report.ts', 'reportLine', 'checked'], ['src/unused.ts', 'legacyTotal', 'unseen']],
  );
  // 呼び出し元の変更は、元の変更の後に並び、「引きずられた変更」として記録される
  const price = steps.find((s) => s.edits[0].path === 'src/price.ts')!;
  const cart = steps.find((s) => s.edits[0].path === 'src/cart.ts')!;
  assert.ok(price.number < cart.number);
  assert.deepEqual(cart.causedBy, { step: price.id, pattern: '呼び出し元の追従', subject: 'calcPrice' });
  assert.equal(cart.kind, 'caller');
});

/** 聞き取り・問いの指定に答える台本 */
function lessonJson(name: string, prompt: string): unknown {
  if (name === 'change_interview') {
    const stepIds = [...prompt.matchAll(/^### (s\d+)/gm)].map((m) => m[1]);
    const siteIds = [...prompt.matchAll(/^- (p\d+):/gm)].map((m) => m[1]);
    return {
      understanding: '税率を呼び出し側から渡せるようにする',
      acceptanceCriteria: ['税率を渡すと、その税率で金額が計算される'],
      overall: 'price.ts の計算を変え、呼び出し元の cart.ts を合わせました。',
      steps: stepIds.map((id) => ({ id, label: `${id} の変更`, why: '税率を固定値から引数に変えるため amount * (1 + rate) にする。', criterion: 1, contract: 'calcPrice の引数が増える' })),
      sites: siteIds.map((id) => ({ id, reason: '読んで確かめた' })),
    };
  }
  if (name === 'step_quiz') {
    const ids = [...prompt.matchAll(/^### (s\d+): (\S+)/gm)];
    return {
      items: ids.map(([, step, file]) =>
        file.startsWith('src/price.ts')
          ? {
              step,
              task: '税率を引数で受け取り、その税率で計算する',
              explanation: 'calcPrice は cartTotal から呼ばれる',
              newNames: [{ name: 'rate', role: '税率' }],
              refs: [{ path: 'src/cart.ts', line: 6, note: '呼び出し元' }],
              blanks: [{
                line: 2, target: '(1 + rate)', concept: '税込み計算',
                hintConcept: '元の金額に税の分を足す', hintApproach: '(1 + rate) を掛ければよい', why: '税率を足した倍率を掛ける',
                distractors: [{ code: '(1 - rate)', whyWrong: '値引きになる' }, { code: '(amount + rate)', whyWrong: '金額に税率を足している' }, { code: '(madeUp + rate)', whyWrong: '存在しない名前' }],
                cluePath: 'src/util.ts', clueLine: 2, clueNote: '似た計算',
              }],
            }
          : {
              step, task: '呼び出し元を合わせる', explanation: '', newNames: [], refs: [],
              blanks: [{
                line: 99, target: 'no such text', concept: 'x', hintConcept: '', hintApproach: '', why: '', distractors: [], cluePath: '', clueLine: 0, clueNote: '',
              }],
            },
      ),
    };
  }
  if (name === 'voice_fix') {
    // 報告の形 (〜しました) の文章だけが、書き直しに回ってくる
    const ids = [...prompt.matchAll(/^id: (v\d+)\n現在の文章: (.*)$/gm)];
    return { fixes: ids.map(([, id, text]) => ({ id, text: text.replace('合わせました', '合わせる') })) };
  }
  return { fixes: [] };
}

function makeSession(cwd: string, state: ConversationState) {
  const posted: WalkMessage[] = [];
  const session = new UnderstandSession({ cwd, state, post: (m) => posted.push(m), status: () => {} });
  return { session, posted };
}

async function runWith(session: UnderstandSession, cwd: string, provider: Scripted, state: ConversationState, request: string, failed = false) {
  await session.beginRun();
  await makeAgent(cwd, provider, state, (e) => session.record(e)).run(session.takeNote() + request, signal());
  const asker = createAsker({ provider, model: 'm', system: 'sys', messages: () => state.messages });
  return session.endRun({ request, asker, level: 'intermediate', signal: signal(), failed });
}

test('実装の依頼: 変更を取り置き、確定したコードから問いを組み立て、たどり終えてから反映する', async () => {
  const cwd = makeRepo();
  const state = createConversationState();
  const provider = scripted(changeScript(cwd), lessonJson);
  const { session, posted } = makeSession(cwd, state);
  const historyBefore = () => JSON.stringify(state.messages);

  assert.equal(await runWith(session, cwd, provider, state, '税率を引数にして'), true);
  const history = historyBefore();

  // ファイルは変更前のまま。たどり終えるまで反映できない
  assert.equal(status(cwd), '');
  assert.ok(session.holding);
  await session.apply();
  assert.equal(status(cwd), '');

  const [start, step1] = posted as any[];
  assert.equal(start.type, 'walk_start');
  assert.equal(start.view.goal, '税率を呼び出し側から渡せるようにする');
  assert.equal(start.view.map.length, 3);
  assert.equal(step1.type, 'walk_step');

  // 問いのコードは確定した変更後のコードから作られ、答えは答え合わせまで渡らない
  const item = step1.view.item;
  assert.ok(item.code.includes(`amount * ${BLANK}`));
  // 実在しない名前を使った誤答 (madeUp) は捨て、正解の一部を入れ替えた誤答で補う
  assert.deepEqual([...item.blanks[0].options].sort(), ['(1 + rate)', '(1 - rate)', '(2 + rate)', '(amount + rate)']);
  const beforeAnswer = JSON.stringify({ ...step1.view, item: { ...item, blanks: item.blanks.map((b: any) => ({ ...b, options: [] })) } });
  assert.ok(!beforeAnswer.includes('1 + rate'), '答える前の文章に答えが含まれている');
  // 誤答が違う理由は、最後の手がかり (選択肢を1つ消す) の1件だけが渡る
  assert.equal(beforeAnswer.split('whyWrong').length, 1);
  assert.equal(item.blanks[0].options[item.blanks[0].eliminate.index] !== '(1 + rate)', true);
  assert.deepEqual(item.refs, [{ path: 'src/cart.ts', line: 6, note: '呼び出し元' }]);
  assert.equal(step1.view.question.multi, true);
  assert.ok(step1.view.question.options.includes('src/cart.ts の cartTotal'));

  // 誤答を選ぶ → 選んだ誤答が違う理由と、影響の追い方が示される
  const wrong = item.blanks[0].options.indexOf('(1 - rate)');
  session.answer(0, { blanks: [wrong], next: [step1.view.question.options.indexOf('src/cart.ts の cartTotal')] });
  const reveal = posted[2] as any;
  assert.equal(reveal.type, 'walk_reveal');
  const correctIndex = item.blanks[0].options.indexOf('(1 + rate)');
  assert.deepEqual(reveal.view.blanks, [{ correct: false, answer: '(1 + rate)', chosen: wrong, correctIndex, why: '税率を足した倍率を掛ける', note: '値引きになる' }]);
  assert.equal(reveal.view.question.correct, false);
  assert.match(reveal.view.why, /amount \* \(1 \+ rate\)/);
  const results = reveal.view.checks[0].results;
  assert.deepEqual(results.map((r: any) => [r.label, r.verdict, r.reason]), [
    ['src/cart.ts の cartTotal', 'changed', '読んで確かめた'],
    ['src/report.ts の reportLine', 'checked', '読んで確かめた'],
    ['src/unused.ts の legacyTotal', 'unseen', ''],
  ]);

  // 答え合わせの前には次へ進めない。問いにできなかったステップは差分と理由をそのまま示す
  session.next();
  const step2 = posted[3] as any;
  assert.equal(step2.type, 'walk_step');
  assert.equal(step2.view.item, undefined);
  assert.match(step2.view.diffs[0].diff, /\+ +sum \+= calcPrice\(item, 0\.1\);/);
  assert.match(step2.view.why, /ステップ1/);
  // 問いの無いステップは、影響の追い方まで続けて示される
  assert.equal(posted[4].type, 'walk_reveal');
  session.next();
  assert.deepEqual(posted.slice(5).map((m) => m.type), ['walk_step', 'walk_reveal']);
  session.next();

  const final = posted[posted.length - 1] as any;
  assert.equal(final.type, 'walk_final');
  assert.deepEqual(final.view.files.map((f: any) => [f.path, f.added, f.removed]), [['gen.txt', 1, 0], ['src/cart.ts', 1, 1], ['src/price.ts', 2, 2]]);
  assert.deepEqual(final.view.unseen.map((u: any) => u.label), ['src/unused.ts の legacyTotal']);
  assert.deepEqual(final.view.commands, [{ command: 'echo generated > gen.txt', ok: true }]);

  // 理解のための問い合わせは、エージェントの会話を書き換えない
  assert.equal(historyBefore(), history);
  assert.deepEqual(provider.asked.sort(), ['change_interview', 'leak_fix', 'step_quiz', 'step_quiz', 'voice_fix']);
  // 「〜しました」という報告の形は、これから実装する手順としての言い方に直される
  assert.match(final.view.overall, /呼び出し元の cart\.ts を合わせる。/);
  assert.ok(!/しました/.test(JSON.stringify(posted)));

  await session.apply();
  assert.equal(posted[posted.length - 1].type, 'walk_done');
  assert.match(read(cwd, 'src/price.ts'), /amount \* \(1 \+ rate\)/);
  assert.match(read(cwd, 'src/cart.ts'), /calcPrice\(item, 0\.1\)/);
  assert.equal(read(cwd, 'gen.txt'), 'generated\n');
  assert.ok(!session.holding);
});

test('取り置き中に続きを頼むと変更を戻して続け、破棄するとモデルに伝える', async () => {
  const cwd = makeRepo();
  const state = createConversationState();
  const price = path.join(cwd, 'src/price.ts');
  const script = [
    ...changeScript(cwd),
    // 続きの依頼: 読み直さずに、前の変更の続きを編集できる
    reply('', [call('e3', 'Edit', { file_path: price, old_string: '`${value}円`', new_string: '`¥${value}`' })]),
    reply('表記を変えました。'),
  ];
  const provider = scripted(script, lessonJson);
  const { session, posted } = makeSession(cwd, state);
  await runWith(session, cwd, provider, state, '税率を引数にして');
  assert.equal(read(cwd, 'src/price.ts'), FILES['src/price.ts']);

  await runWith(session, cwd, provider, state, '円の表記も変えて');
  assert.ok(posted.some((m) => m.type === 'walk_done' && m.outcome === 'continued'));
  const edit = state.messages.find((m) => m.role === 'tool' && m.toolCallId === 'e3');
  assert.ok(edit?.role === 'tool' && !edit.isError, edit?.role === 'tool' ? edit.content : '');
  // 取り置きは最初の状態からの変更全体になる
  assert.equal(status(cwd), '');
  const start = [...posted].reverse().find((m) => m.type === 'walk_start') as any;
  assert.equal(start.view.files, 3);

  await session.discard();
  assert.equal(status(cwd), '');
  assert.match(session.takeNote(), /DISCARDED/);
  assert.equal(session.takeNote(), '');
  assert.ok(!state.fileState.has(price));
});

test('途中で止まった作業は、問いを作らずに差分を示して反映か破棄を選べる', async () => {
  const cwd = makeRepo();
  const state = createConversationState();
  const provider = scripted(changeScript(cwd), () => { throw new Error('must not ask'); });
  const { session, posted } = makeSession(cwd, state);
  assert.equal(await runWith(session, cwd, provider, state, 'go', true), true);
  assert.deepEqual(posted.map((m) => m.type), ['walk_start', 'walk_final']);
  const final = posted[1] as any;
  assert.match(final.view.files.find((f: any) => f.path === 'src/price.ts').diff, /\+ +return amount \* \(1 \+ rate\);/);
  await session.apply();
  assert.match(read(cwd, 'src/price.ts'), /rate: number/);
});

test('仕組みの質問: 読んだコードだけから問いを作り、たどり終えてから回答を開示する', async () => {
  const cwd = makeRepo();
  const state = createConversationState();
  const p = (rel: string) => path.join(cwd, rel);
  const readItem = (file: string, startLine: number, endLine: number, firstLine: string, target: string, line: number) => ({
    path: file, startLine, endLine, firstLine, lastLine: '}', task: '金額の計算', explanation: '税込みにする', refs: [],
    blanks: [{
      line, target, concept: '計算', hintConcept: '倍率', hintApproach: '掛ける値を見る', why: '1割増し',
      distractors: [{ code: 'amount + 1.1', whyWrong: '足している' }, { code: 'value * 1.1', whyWrong: '別の変数' }],
      cluePath: '', clueLine: 0, clueNote: '',
    }],
  });
  const provider = scripted(
    [reply('', [call('r1', 'Read', { file_path: p('src/price.ts') })]), reply('calcPrice が金額を1.1倍しています。')],
    (name) =>
      name === 'reading_quiz'
        ? {
            goal: '金額がどこで計算されるか',
            items: [
              // 読んでいないファイルの範囲は問いにしない
              readItem('src/unused.ts', 3, 5, 'export function legacyTotal(amount: number): number {', 'calcPrice(amount) * 2', 4),
              readItem(p('src/price.ts'), 1, 3, 'export function calcPrice(amount: number): number {', 'amount * 1.1', 2),
            ],
          }
        : { fixes: [] },
  );
  const { session, posted } = makeSession(cwd, state);
  assert.equal(await runWith(session, cwd, provider, state, '金額はどこで計算している?'), true);
  assert.ok(!session.holding);
  assert.deepEqual(posted.map((m) => m.type), ['walk_start', 'walk_step']);
  const step = posted[1] as any;
  assert.equal(step.view.item.path, 'src/price.ts');
  assert.ok(step.view.item.code.includes(`return ${BLANK};`));

  const right = step.view.item.blanks[0].options.indexOf('amount * 1.1');
  session.answer(0, { blanks: [right], next: [] });
  assert.equal((posted[2] as any).view.blanks[0].correct, true);
  session.next();
  assert.deepEqual(posted[3], { type: 'walk_done', walk: 1, outcome: 'read', message: '' });
  assert.ok(!session.walking);
});

test('読んだコードも変更も無い応答は、そのまま表示する', async () => {
  const cwd = makeRepo();
  const state = createConversationState();
  const { session, posted } = makeSession(cwd, state);
  assert.equal(await runWith(session, cwd, scripted([reply('こんにちは。')]), state, 'こんにちは'), false);
  assert.deepEqual(posted, []);
});
