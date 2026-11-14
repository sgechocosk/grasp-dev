import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { levelGuide, levelProfile, type LearnerLevel, type LevelProfile } from './lib/level';
import { validateRawItem, type RawBlank, type RawItem } from './lib/quiz';
import { buildRecap, componentsOf, type Recap } from './lib/recap';
import { makeRng, sha1 } from './lib/text';
import type { QuizItem } from './lib/types';
import { blankResults, itemPayload, refReader, shapeItem, toRel, type StepAnswer } from './lesson';
import type { Asker } from './llm';
import { BLANKS_SCHEMA, checkItemRefs, distractorRules, INPUTS_SCHEMA, itemSlots, leakRules, quizLeakTargets, removeAnswerLeaks, rewriteReports, type RawInput } from './quizCommon';
import type { Recorder } from './recorder';

/**
 * 仕組みについての質問への応答。エージェントの回答は先に見せず、
 * 回答の根拠になったコード (実際に読んだ範囲だけ) の要所を空欄にした問いをたどり、
 * 最後に、仕組みの説明の中の部品の名前を選んで埋めて (まとめ) から、回答を開示する。
 */

/** 範囲のうちこの割合以上を実際に読んでいれば、読んだコードとして問いにできる */
const GROUNDED_RATIO = 0.5;

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

const READING_SCHEMA = {
  name: 'reading_quiz',
  schema: {
    type: 'object',
    properties: {
      goal: STRING,
      summary: STRING,
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: STRING, startLine: INTEGER, endLine: INTEGER, firstLine: STRING, lastLine: STRING,
            task: STRING, explanation: STRING, inputs: INPUTS_SCHEMA, blanks: BLANKS_SCHEMA,
          },
          required: ['path', 'startLine', 'endLine', 'firstLine', 'lastLine', 'task', 'explanation', 'inputs', 'blanks'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal', 'summary', 'items'],
    additionalProperties: false,
  },
} as const;

interface RawReadItem {
  path?: string;
  startLine?: number;
  endLine?: number;
  firstLine?: string;
  lastLine?: string;
  task?: string;
  explanation?: string;
  inputs?: RawInput[];
  blanks?: RawBlank[];
}

export interface Reading {
  kind: 'reading';
  goal: string;
  items: QuizItem[];
  /** 問いをたどり終えるまで見せない、エージェントの回答 */
  answer: string;
  profile: LevelProfile;
  /** まとめ (仕組みの説明の空欄)。作れなければ無い */
  recap?: Recap;
}

export interface ReadingDeps {
  cwd: string;
  request: string;
  recorder: Recorder;
  asker: Asker;
  level: LearnerLevel;
  signal: AbortSignal;
  onStatus?: (message: string) => void;
}

function readingPrompt(deps: ReadingDeps, ranges: string[]): string {
  const profile = levelProfile(deps.level);
  return [
    'あなたの直前の回答は、まだ利用者に見せていません。これ以上ツールは使いません。',
    '回答をそのまま渡す前に、利用者が自分でコードを読んで仕組みを確かめられるよう、回答の根拠になったコードの要所を空欄にした選択式の問いを作ります。',
    '空欄にする場所だけを指定してください(コードはシステムが実際のファイルから組み立てます)。指定のJSONで答えてください。',
    '',
    `【利用者の質問】\n${deps.request}`,
    '',
    `【あなたが実際に読んだ範囲(問いにできるのはこの範囲だけ)】\n${ranges.join('\n')}`,
    '',
    `【items(1〜${profile.maxReadItems}件)】`,
    '- path/startLine/endLine: 問いにする範囲。回答の中心になる処理を選ぶ。空欄を含む関数・ブロックの必要最小限(目安15〜25行)。',
    '- firstLine/lastLine: 範囲の最初と最後の行を、読んだとおりに一字一句そのまま(行番号は付けない)。',
    '- task(答える前に表示): この範囲がシステムの中で何を担うかを1文で。利用者が答える前に読む文章はこれだけなので、短く、答えのコードは書かない。',
    '- explanation(答え合わせの後に表示): この範囲の役割と、ほかのファイルとの関係(誰が呼び、何を呼ぶか)を1〜2文で。',
    profile.values
      ? '- inputs: 空欄を含む関数の、数値の引数に入れる具体的な値の例(name は引数名、value は数値)。現実的で計算しやすい値にする(金額なら 100、割合なら 0.1 など)。数値の引数が無ければ空配列。'
      : '- inputs: 空配列にする。',
    '- goal: この問いで何を理解してほしいかを1文。答えは含めない。',
    '- summary(問いをたどり終えたあとに表示): 質問への答えになる仕組みを、関わる関数・型の名前とファイル名を挙げて1〜2文で。人にこの仕組みを説明するときの要約として書く(例: 「A が B を呼んで〜を計算し、結果を C に渡す」)。',
    '',
    '【空欄 blanks の指定】',
    '- line: ファイルの行番号。',
    '- target: その行に逐語で含まれる、空欄にする部分(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値・型など意味のある単位。',
    `- 個数と難しさは下の【利用者のレベル】に従う(1件あたり最大${profile.maxBlanks}個)。周囲のコードと手がかりから一つに絞れる箇所を選ぶ。`,
    '',
    ...distractorRules(profile.optionCount - 1),
    '',
    ...leakRules('goal・task・concept・2段階の手がかり・clueNote'),
    '',
    levelGuide(deps.level),
  ].join('\n');
}

/** 読んだコードから問いを作る。作れなければ undefined (回答をそのまま見せる) */
export async function buildReading(deps: ReadingDeps): Promise<Reading | undefined> {
  const ranges = deps.recorder
    .readRanges()
    .map(({ file, ranges: r }) => ({ rel: toRel(deps.cwd, file), r }))
    .filter((x) => x.rel)
    .map((x) => `- ${x.rel}: ${x.r.map(([s, e]) => `L${s}-${e}`).join(', ')}`);
  if (ranges.length === 0 || !deps.recorder.finalText.trim()) return undefined;
  deps.onStatus?.('回答の根拠になるコードを整理しています…');

  const profile = levelProfile(deps.level);
  const MAX_ITEMS = profile.maxReadItems;
  const items: QuizItem[] = [];
  let goal = '';
  let summary = '';
  let prompt = readingPrompt(deps, ranges);
  const knownText = deps.recorder.seenText();
  for (let attempt = 0; attempt < 2 && items.length < MAX_ITEMS; attempt++) {
    const res = await deps.asker.fork<{ goal?: string; summary?: string; items?: RawReadItem[] }>(prompt, READING_SCHEMA, deps.signal);
    goal ||= res.goal?.trim() ?? '';
    summary ||= res.summary?.trim() ?? '';
    const reasons: string[] = [];
    for (const raw of res.items ?? []) {
      if (items.length >= MAX_ITEMS) break;
      const rel = toRel(deps.cwd, raw.path ?? '');
      const file = rel ? path.resolve(deps.cwd, rel) : '';
      const text = rel ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
      if (!rel || text === undefined) {
        reasons.push(`${raw.path}: ファイルを読めません`);
        continue;
      }
      const rawItem: RawItem = {
        kind: 'read', path: rel, startLine: Number(raw.startLine) || 1, endLine: Number(raw.endLine) || 1,
        firstLine: raw.firstLine ?? '', lastLine: raw.lastLine ?? '', task: raw.task ?? '', newCode: '',
        blanks: Array.isArray(raw.blanks) ? raw.blanks : [], refs: [], newNames: [],
        explanation: raw.explanation ?? '',
      };
      const verdict = validateRawItem(rawItem, text, { knownText });
      if (!verdict.ok) {
        reasons.push(verdict.reason);
        continue;
      }
      // 実際に読んだコードだけを根拠にする
      if (deps.recorder.coverage(file, verdict.item.startLine, verdict.item.endLine) < GROUNDED_RATIO) {
        reasons.push(`${rel}:${verdict.item.startLine}-${verdict.item.endLine} は読んでいない範囲です。読んだ範囲から選んでください`);
        continue;
      }
      if (items.some((it) => it.path === rel && it.startLine <= verdict.item.endLine && verdict.item.startLine <= it.endLine)) continue;
      await checkItemRefs(refReader(deps.cwd), verdict.item);
      items.push(shapeItem(verdict.item, profile, { inputs: raw.inputs }));
    }
    if (items.length > 0 || reasons.length === 0) break;
    prompt = [
      readingPrompt(deps, ranges),
      '',
      '【前回の指定が検証で通らなかった理由】',
      ...reasons.map((r) => `- ${r}`),
      'firstLine と target は、ファイルに実際に書かれている文字列をそのまま写してください。',
    ].join('\n');
  }
  if (items.length === 0) return undefined;
  const quiz = { goal: goal || deps.request, summary, items };
  await rewriteReports(
    deps.asker, deps.level,
    [{ get: () => quiz.goal, set: (t) => (quiz.goal = t) }, { get: () => quiz.summary, set: (t) => (quiz.summary = t) }, ...items.flatMap(itemSlots)],
    deps.signal,
  );
  await removeAnswerLeaks(deps.asker, deps.level, quizLeakTargets(quiz), deps.signal);

  // まとめの材料にする部品は、エージェントが実際に読んだファイルにある宣言だけ
  const files: Array<{ path: string; text: string }> = [];
  for (const file of deps.recorder.reads.keys()) {
    const rel = toRel(deps.cwd, file);
    const text = rel ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
    if (rel && text !== undefined) files.push({ path: rel, text });
  }
  const rng = makeRng(parseInt(sha1(deps.request + items.map((it) => `${it.path}:${it.startLine}`).join()).slice(0, 8), 16));
  const recap = buildRecap(quiz.summary, componentsOf(files), { max: profile.recapBlanks, optionCount: profile.optionCount, rng });
  return { kind: 'reading', goal: quiz.goal, items, answer: deps.recorder.finalText, profile, recap };
}

// ---------- 画面に渡す形 (実装の手順と同じ形にそろえる) ----------

export function readingStartPayload(reading: Reading): Record<string, unknown> {
  return { kind: 'reading', goal: reading.goal, criteria: [], map: reading.items.map((it, i) => ({ number: i + 1, label: `${it.path}:${it.startLine}`, kind: '読み解き', question: true })), files: 0 };
}

export function readingStepPayload(reading: Reading, index: number): Record<string, unknown> {
  const item = reading.items[index];
  return {
    index, number: index + 1, total: reading.items.length, label: item.path, kind: '読み解き', origin: '', purpose: item.task ?? '',
    files: [{ path: item.path, created: false, deleted: false, line: item.startLine }], item: itemPayload(item), diffs: [],
    oneAtATime: reading.profile.oneAtATime, flow: false,
  };
}

export function readingRevealPayload(reading: Reading, index: number, answer: StepAnswer): Record<string, unknown> {
  const item = reading.items[index];
  return {
    index, label: item.path, blanks: blankResults(item, answer.blanks),
    detail: { explanation: item.explanation, diffs: [] }, contract: '', checks: [],
    last: index === reading.items.length - 1, recap: !!reading.recap, flow: false,
  };
}
