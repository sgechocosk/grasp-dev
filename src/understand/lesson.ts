import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileChange } from './changeSet';
import { analyzeImpact, PATTERNS, placeLabel, subjectPattern, type Obligation, type Site, type WorkspaceView } from './impact';
import { eliminationHint } from './lib/choices';
import { declarationAt, declarationsOf, enclosingDeclaration } from './lib/declarations';
import { diffHunks, diffStat } from './lib/diff';
import { valueQuestion } from './lib/evaluate';
import { revealsAnswer } from './lib/leak';
import { levelGuide, levelProfile, levelStyle, type LearnerLevel, type LevelProfile } from './lib/level';
import { changedLineIndexes, compactItem, foldRanges, gradeBlanks, limitItem, validateRawItem, type RawBlank, type RawItem } from './lib/quiz';
import { buildRecap, componentsOf, type Component, type Recap } from './lib/recap';
import { makeRng, numberLines, sha1, shuffle, splitLines, truncate } from './lib/text';
import type { NewName, QuizItem } from './lib/types';
import type { Asker } from './llm';
import {
  BLANKS_SCHEMA, checkItemRefs, distractorRules, INPUTS_SCHEMA, itemSlots, leakRules, NEW_NAMES_SCHEMA, proposedInputs, quizLeakTargets, removeAnswerLeaks, rewriteReports,
  withoutMentions, type LeakTarget, type RawInput, type TextSlot,
} from './quizCommon';
import type { CommandRecord, Recorder } from './recorder';
import { buildSteps, condense, isTestPath, reorderByCause, STEP_KIND_LABEL, type Step } from './steps';

/**
 * 確定した変更 (エージェントが実装と検証を終えたもの) を、順を追ってたどれる手順にする。
 * - ステップと影響の及ぶ場所は、差分と作業の記録から機械的に求める
 * - 理由 (なぜ変えたか / なぜ変えなかったか) は、作業したエージェント自身の会話に聞く
 * - 問いのコードは確定した変更後のコードから組み立て、LLM には空欄の場所だけを決めさせる
 *
 * 利用者が読む量を抑えるため、答える前に見せるのは「目的1行 + コード + 問い」だけにし、
 * 解説は、予想が外れたとき (または「わからない」を選んだとき) にだけ開いて見せる。
 * 問いの数・形・見せる情報は、経験レベル (lib/level.ts の LevelProfile) で変える。
 */

const MAX_DIFF_CHARS = 2500;
/** 聞き取りに載せる差分全体の目安 (変更が多いときは、1か所あたりを短くする) */
const DIFF_BUDGET_CHARS = 60_000;

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

/** 判断を求める場所 (エージェントが変えなかった場所) */
export interface ReviewSite {
  label: string;
  path: string;
  line: number;
  /** その場所の行 */
  code: string;
  /** 何を使っている場所か (変わった名前・キー) */
  subject: string;
  /** エージェントがその行を読んだか */
  read: boolean;
  /** 変えなかった理由 (読んでいなければ空) */
  reason: string;
}

/** review での判断。正誤は無く、「妥当」以外を選んだ場所を、気になった場所として最後に残す */
export const REVIEW_PICKS = ['妥当', '変更が要る', '確認が足りない'] as const;

/** 変更の影響の問い。形は経験レベルで変わる */
export type ImpactQuestion =
  | { form: 'places'; prompt: string; options: string[]; correct: number[]; hint: string; secret: ImpactSecret }
  | { form: 'lines'; prompt: string; options: Array<{ path: string; line: number; code: string }>; correct: number[]; hint: string; secret: ImpactSecret }
  | { form: 'review'; prompt: string; sites: ReviewSite[] };

/** 答える前の文章に出てはいけない、影響の問いの答え (関数などの名前と、ファイル) */
interface ImpactSecret {
  names: string[];
  paths: string[];
}

export interface LessonStep {
  step: Step;
  item?: QuizItem;
  /** 変更の影響の問い */
  question?: ImpactQuestion;
  /** 答える前に見せる文章 (これから考えてもらうことを先に言っていたら、書き直すか、その文を除いたもの) */
  display: { label: string; purpose: string };
}

/** 利用者が「妥当」以外を選んだ場所 */
export interface Concern {
  label: string;
  path: string;
  line: number;
  pick: string;
}

export interface Lesson {
  kind: 'lesson';
  /** 依頼をどう理解したか */
  goal: string;
  criteria: string[];
  /** 変更全体の流れ */
  overall: string;
  /** 動作をどう確かめたか・何が確かめられていないか */
  verification: string;
  steps: LessonStep[];
  obligations: Obligation[];
  changes: FileChange[];
  unheld: string[];
  commands: CommandRecord[];
  /** 手順を組み立てられなかった理由 (あれば、差分だけを見せる) */
  notice?: string;
  profile: LevelProfile;
  /** まとめ (変更の流れの説明の空欄)。作れなければ無い */
  recap?: Recap;
}

export interface LessonDeps {
  cwd: string;
  request: string;
  changes: FileChange[];
  unheld: string[];
  recorder: Recorder;
  view: WorkspaceView;
  asker: Asker;
  level: LearnerLevel;
  signal: AbortSignal;
  onStatus?: (message: string) => void;
}

/**
 * 変更前後の差分を、変えた行の前後 context 行だけに絞って返す。
 * 各行の先頭は " "(同じ) / "-"(削除) / "+"(追加) / "…"(省略)。大きなファイルでも重くならないよう、行の対応づけ (Myers) から作る。
 */
export function showDiff(before: string, after: string, context = 2): string {
  // 空のファイル (新規作成の変更前・削除の変更後) は、0行として扱う
  const a = before === '' ? [] : splitLines(before);
  const b = after === '' ? [] : splitLines(after);
  const out: string[] = [];
  let at = 0; // 変更前の、まだ出していない行
  const same = (from: number, to: number, head: boolean, tail: boolean): void => {
    // from〜to (to は含まない) の変わっていない行。前の変更の直後と、次の変更の直前だけを残す
    const keepHead = head ? Math.min(context, to - from) : 0;
    const keepTail = tail ? Math.min(context, to - from - keepHead) : 0;
    for (let i = from; i < from + keepHead; i++) out.push(`  ${a[i]}`);
    const skipped = to - from - keepHead - keepTail;
    if (skipped > 0) out.push(`… (${skipped}行省略)`);
    for (let i = to - keepTail; i < to; i++) out.push(`  ${a[i]}`);
  };
  const hunks = diffHunks(a, b);
  hunks.forEach((h, n) => {
    same(at, h.oldStart, n > 0, true);
    for (let i = h.oldStart; i < h.oldStart + h.oldCount; i++) out.push(`- ${a[i]}`);
    for (let j = h.newStart; j < h.newStart + h.newCount; j++) out.push(`+ ${b[j]}`);
    at = h.oldStart + h.oldCount;
  });
  if (hunks.length > 0) same(at, a.length, true, false);
  return out.join('\n');
}

// ---------- 聞き取り (理由・受け入れ条件) ----------

const INTERVIEW_SCHEMA = {
  name: 'change_interview',
  schema: {
    type: 'object',
    properties: {
      understanding: STRING,
      acceptanceCriteria: { type: 'array', items: STRING },
      overall: STRING,
      verification: STRING,
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: STRING, label: STRING, why: STRING, criterion: INTEGER, contract: STRING },
          required: ['id', 'label', 'why', 'criterion', 'contract'],
          additionalProperties: false,
        },
      },
      sites: {
        type: 'array',
        items: { type: 'object', properties: { id: STRING, reason: STRING }, required: ['id', 'reason'], additionalProperties: false },
      },
    },
    required: ['understanding', 'acceptanceCriteria', 'overall', 'verification', 'steps', 'sites'],
    additionalProperties: false,
  },
} as const;

interface RawInterview {
  understanding?: string;
  acceptanceCriteria?: string[];
  overall?: string;
  verification?: string;
  steps?: Array<{ id?: string; label?: string; why?: string; criterion?: number; contract?: string }>;
  sites?: Array<{ id?: string; reason?: string }>;
}

const VERDICT_LABEL = { changed: '変更が必要だった', checked: '読んだうえで変更不要とした', unseen: '作業中に一度も読んでいない' } as const;

function describeSteps(steps: Step[]): string {
  const count = steps.reduce((n, s) => n + s.edits.length, 0);
  const limit = Math.max(400, Math.min(MAX_DIFF_CHARS, Math.floor(DIFF_BUDGET_CHARS / Math.max(1, count))));
  return steps
    .map((s) => {
      const edits = s.edits.map((e) => {
        const head = `${e.path}${e.symbol ? ` の ${e.symbol}` : ''}(${e.created ? '新規作成' : e.deleted ? '削除' : `${e.startLine}行目付近`})`;
        return `${head}\n${truncate(showDiff(e.before, e.after), limit)}`;
      });
      return [`### ${s.id}(${STEP_KIND_LABEL[s.kind]})`, ...edits].join('\n');
    })
    .join('\n\n');
}

function interviewPrompt(deps: LessonDeps, steps: Step[], obligations: Obligation[]): string {
  const sites = obligations.flatMap((o) =>
    o.sites.map((p) => `- ${p.id}: ${placeLabel(p)}(${p.path}:${p.line})「${p.text}」 — ${o.step} で「${o.subject}」を変えたことの確認先。判定: ${VERDICT_LABEL[p.verdict]}`),
  );
  return [
    'ここまでの作業は完了しました。これ以上ツールは使わず、変更もしません。',
    'この変更は、まだ利用者のファイルには入っていません。これから利用者が、変更の理由と影響を自分で確かめながら、1ステップずつ実装として取り入れていきます。',
    'そのための手順書として、各変更の理由と判断を整理します。あなたの作業報告ではなく、利用者がこれから行う実装の説明として書いてください。指定のJSONで答えてください。',
    '',
    `【利用者の依頼】\n${deps.request}`,
    '',
    `【確定した変更(システムが差分から機械的に分けたステップ)】\n${describeSteps(steps)}`,
    '',
    sites.length > 0 ? `【変更の影響が及びうる場所(システムが検索で集めたもの)】\n${sites.join('\n')}` : '【変更の影響が及びうる場所】\n(なし)',
    '',
    '【書くこと】',
    '- understanding: この依頼で何を実現するかを1〜2文(「〜できるようにする」の形)。利用者が実装前に決めたことがあれば、それも含める。',
    '- acceptanceCriteria: 受け入れ条件を1〜5件。「〜のとき〜になる」のように、実装できたかを確かめられる振る舞いで書く。',
    '- steps: 上の各ステップについて1件ずつ(id はそのまま)。',
    '  - label: そのステップで何をするかの短い見出し(20文字程度。「〜する」の形。コードは書かない)。',
    '  - why: なぜその場所を、そう変える必要があるか。1〜2文。見出しや受け入れ条件の言い直しにしない。',
    '  - label は、このあと利用者が変更後のコードを自分で考える前に読む。変更後のコードの式・呼び出し・値をそのまま書かず、何をするのかを言葉で書く。',
    '  - criterion: 主にどの受け入れ条件のための変更か(1始まりの番号。特定の条件に結びつかなければ 0)。',
    '  - contract: この変更によって、ほかのコードから見た使い方がどう変わるか(関数の引数・戻り値・型の項目・メッセージの種類・設定キーなど)を1文。変わらなければ空文字。',
    '- sites: 上の各場所について1件ずつ(id はそのまま)。',
    '  - 「変更が必要だった」場所: なぜそこも変える必要があるか。変更後のコードそのものは書かない(その場所の変更は、あとのステップで利用者が考える)。',
    '  - 「読んだうえで変更不要とした」場所: なぜ変えなくてよいかを、その行のコードを根拠に。',
    '  - 「一度も読んでいない」場所: reason は空文字にする(確かめていないことを推測で書かない)。',
    '  - 理由は1文で、その場所に固有のことを書く。ほかの場所と同じ文にしない(同じ文は、判断の根拠にならないので表示しない)。',
    '- overall: 変更全体の流れ(どこから始めて、何に波及するか)を、変える関数・型の名前とファイル名を挙げて1〜2文。人にこの変更を説明するときの要約として書く。',
    '- verification: この変更が動くことを、何を実行してどこまで確かめてあるか(テスト・型検査・ビルドなど)と、まだ確かめられていないことを1〜3文。コマンド名だけでなく、それで何が分かるのかを書く。',
    '  何も実行していなければ、そのことと、反映後に何を実行すれば確かめられるかを書く。',
    '',
    `- ${levelStyle(deps.level)}`,
  ].join('\n');
}

// ---------- 問い (空欄の場所) ----------

const STEP_QUIZ_SCHEMA = {
  name: 'step_quiz',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { step: STRING, task: STRING, explanation: STRING, newNames: NEW_NAMES_SCHEMA, inputs: INPUTS_SCHEMA, blanks: BLANKS_SCHEMA },
          required: ['step', 'task', 'explanation', 'newNames', 'inputs', 'blanks'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
} as const;

interface RawStepItem {
  step?: string;
  task?: string;
  explanation?: string;
  newNames?: NewName[];
  inputs?: RawInput[];
  blanks?: RawBlank[];
}

function quizPrompt(deps: LessonDeps, targets: Step[]): string {
  const profile = levelProfile(deps.level);
  const sections = targets.map((s) => {
    const e = s.edits[0];
    return [
      `### ${s.id}: ${e.path}${e.symbol ? ` の ${e.symbol}` : ''}(${e.created ? '新規作成' : `${e.startLine}〜${e.endLine}行目を置き換え`})`,
      `変更前:\n${e.created ? '(新しいファイル)' : numberLines(splitLines(e.before), e.startLine)}`,
      `変更後(blanks の line はこの番号):\n${numberLines(splitLines(e.after), 1)}`,
      `差分:\n${showDiff(e.before, e.after)}`,
    ].join('\n');
  });
  return [
    'ここまでの作業は完了しました。これ以上ツールは使わず、変更もしません。',
    'この変更は、これから利用者が1ステップずつ自分で実装として取り入れていきます。',
    '利用者がこの変更の考えどころを自分で考えられるように、ステップごとに、変更後のコードの「考えどころ」を空欄にした選択式の問いを作ります。',
    `変更後のコードは確定済みです。書き換えずに、空欄にする場所だけを指定します。空欄は選択式(正解1つ + 誤答${profile.optionCount - 1}つ)。指定のJSONで答えてください。`,
    '',
    '【items】',
    '- 下に示すステップのうち、考えどころがあるものについて1件ずつ。step にステップの id を入れる。',
    '- task(答える前に表示): このステップで何を実現するかを1文で。利用者が答える前に読む文章はこれだけなので、短く、答えのコードは書かない。',
    '- explanation(答え合わせの後に表示): この変更の役割と、ほかのファイル・処理との関係(誰が呼び、何を呼ぶか)を1〜2文で。',
    '- newNames: このステップで新しく作るメソッド・関数・変数・引数・フィールドなどの名前と役割。名前そのものは空欄にしない。',
    profile.values
      ? '- inputs: 空欄を含む関数の、数値の引数に入れる具体的な値の例(name は引数名、value は数値)。現実的で計算しやすい値にする(金額なら 100、割合なら 0.1 など)。数値の引数が無ければ空配列。'
      : '- inputs: 空配列にする。',
    '',
    '【空欄 blanks の指定】',
    '- line: 変更後のコード(行番号付きで示す)の中での行番号(1始まり)。',
    '- target: その行に逐語で含まれる、空欄にする部分(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値など意味のある単位。',
    '- 少なくとも1つは、変更・追加した行(差分の + の行)に置く。「なぜその場所をそう変えるのか」「何に合わせるのか」が問われる箇所を選ぶ。',
    `- 個数と難しさは下の【利用者のレベル】に従う(1ステップあたり最大${profile.maxBlanks}個)。`,
    '',
    ...distractorRules(profile.optionCount - 1),
    '',
    ...leakRules('task・concept・2段階の手がかり・clueNote'),
    '',
    levelGuide(deps.level),
    '',
    `【ステップ】\n${sections.join('\n\n')}`,
  ].join('\n');
}

/** ワークスペース内のパスに直す (絶対パスで返ってきても扱えるように)。外なら undefined */
export function toRel(cwd: string, p: string): string | undefined {
  const rel = path.relative(cwd, path.resolve(cwd, p));
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
}

/** 利用者が今エディタで開ける内容 (取り置いている間のディスク = 変更前) から、参考コードの場所を読む */
export function refReader(cwd: string): (ref: string) => Promise<{ path: string; text: string } | undefined> {
  return async (ref) => {
    const rel = toRel(cwd, ref);
    if (!rel) return undefined;
    const text = await fs.readFile(path.resolve(cwd, rel), 'utf8').catch(() => undefined);
    return text === undefined ? undefined : { path: rel, text };
  };
}

/**
 * 問いにするステップ。上限を超えるときは、影響の及ぶ場所が多い変更 (誤ると高くつく分かれ目) を先に選ぶ。
 * 選ばなかったステップは、差分と1行の理由で見せる。
 */
export function quizTargets(steps: Step[], obligations: Obligation[], max: number): Step[] {
  const reach = (s: Step): number => obligations.filter((o) => o.step === s.id).reduce((n, o) => n + o.sites.length + o.more, 0);
  const candidates = steps.filter((s) => s.quizzable && s.edits.length === 1);
  const chosen = new Set(
    candidates
      .map((s, i) => ({ s, i, r: reach(s) }))
      .sort((x, y) => y.r - x.r || x.i - y.i)
      .slice(0, max)
      .map((x) => x.s.id),
  );
  return candidates.filter((s) => chosen.has(s.id));
}

/** テストに書かれた呼び出しを、具体的な値の例として使うための、テストファイルの内容 */
function testTexts(view: WorkspaceView): string[] {
  return view.files().filter(isTestPath).map((rel) => view.lines(rel).join('\n'));
}

/**
 * 問いを、レベルに合った量と形にする。
 * 「具体的な値で問う」レベルでは、計算で確かめられる空欄に、値の選択肢を添える (確かめられなければ、コードの選択肢のまま)。
 */
export function shapeItem(item: QuizItem, profile: LevelProfile, sample: { tests?: string[]; inputs?: RawInput[] } = {}): QuizItem {
  const shaped = limitItem(item, profile.maxBlanks, profile.optionCount);
  if (profile.values && shaped.blanks.length === 1) {
    const b = shaped.blanks[0];
    const value = valueQuestion({
      path: shaped.path, code: shaped.quizCode, options: (b.choices ?? []).map((c) => c.code), answer: b.answer,
      tests: sample.tests, proposed: proposedInputs(sample.inputs),
    });
    if (value) b.value = value;
  }
  return compactItem(shaped);
}

/**
 * モデルが問いを作れなかったステップの代わりに、「この行が呼んでいる関数はどれか」を機械的に作る (1画面に問いは1つのレベル用)。
 * 答えも選択肢も、実際のコードにある関数だけから決める: 変えた行で呼ばれていて、宣言の場所が1つに決まる関数を答えにし、
 * 同じファイルに出てくる別の関数を、違う選択肢にする。
 */
export function calleeItem(step: Step, components: Component[], profile: LevelProfile, knownText: string): QuizItem | undefined {
  const edit = step.edits[0];
  const funcs = new Map(components.filter((c) => c.kind === 'decl' && (c.declKind === 'function' || c.declKind === 'method')).map((c) => [c.name, c]));
  const after = splitLines(edit.after);
  const before = edit.created ? [] : splitLines(edit.before);
  const changed = changedLineIndexes(before, after);
  const where = (c: Component): string => `${c.path}:${c.line}`;
  for (const i of [...changed].sort((a, b) => a - b)) {
    const line = after[i];
    const declared = declarationAt(line)?.name;
    const callee = [...line.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).find((n) => funcs.has(n) && n !== declared);
    if (!callee) continue;
    const inFile = new Set(edit.fileAfter.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const others = [...funcs.values()].filter((c) => c.name !== callee && inFile.has(c.name)).slice(0, profile.optionCount - 1);
    if (others.length < 2) return undefined;
    const target = funcs.get(callee)!;
    const beforeLines = splitLines(edit.before);
    const raw: RawItem = {
      kind: 'change', path: edit.path, startLine: edit.startLine, endLine: edit.created ? 1 : edit.endLine,
      firstLine: edit.created ? '' : (beforeLines[0] ?? ''), lastLine: edit.created ? '' : (beforeLines[beforeLines.length - 1] ?? ''),
      task: '', newCode: edit.after, refs: [], newNames: [], explanation: '',
      blanks: [{
        line: i + 1, target: callee, concept: '呼び出す関数',
        hintConcept: 'ここでは、別の場所に書かれた関数を呼んでいる。',
        hintApproach: 'この変更の目的に合う処理をする関数を、同じファイルで使われている関数の中から探す。',
        why: `${callee} は ${where(target)} にある関数。この行から呼ばれて、次に動く。`,
        distractors: others.map((c) => ({ code: c.name, whyWrong: `${c.name} は ${where(c)} にある、別の処理をする関数。` })),
        cluePath: '', clueLine: 0, clueNote: '',
      }],
    };
    const verdict = validateRawItem(raw, edit.fileBefore, { knownText, allowLong: true });
    return verdict.ok ? shapeItem(verdict.item, { ...profile, values: false }) : undefined;
  }
  return undefined;
}

async function buildItems(deps: LessonDeps, targets: Step[]): Promise<Map<string, QuizItem>> {
  const items = new Map<string, QuizItem>();
  if (targets.length === 0) return items;
  const profile = levelProfile(deps.level);
  const knownText = [deps.recorder.seenText(), ...deps.changes.map((c) => c.after ?? '')].join('\n');
  const tests = profile.values ? testTexts(deps.view) : [];
  let prompt = quizPrompt(deps, targets);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.asker.fork<{ items?: RawStepItem[] }>(prompt, STEP_QUIZ_SCHEMA, deps.signal);
    const reasons: string[] = [];
    for (const raw of res.items ?? []) {
      const step = targets.find((s) => s.id === raw.step);
      if (!step || items.has(step.id)) continue;
      const edit = step.edits[0];
      const beforeLines = splitLines(edit.before);
      const rawItem: RawItem = {
        kind: 'change',
        path: edit.path,
        startLine: edit.startLine,
        endLine: edit.created ? 1 : edit.endLine,
        firstLine: edit.created ? '' : (beforeLines[0] ?? ''),
        lastLine: edit.created ? '' : (beforeLines[beforeLines.length - 1] ?? ''),
        task: raw.task ?? '',
        newCode: edit.after,
        blanks: Array.isArray(raw.blanks) ? raw.blanks : [],
        refs: [],
        newNames: Array.isArray(raw.newNames) ? raw.newNames : [],
        explanation: raw.explanation ?? '',
      };
      const verdict = validateRawItem(rawItem, edit.fileBefore, { knownText, allowLong: true });
      if (!verdict.ok) {
        reasons.push(`${step.id}: ${verdict.reason}`);
        continue;
      }
      await checkItemRefs(refReader(deps.cwd), verdict.item);
      items.set(step.id, shapeItem(verdict.item, profile, { tests, inputs: raw.inputs }));
    }
    // 上級では「分かれ目の無い変更には問いを作らない」ので、指定が無いステップは、検証で落ちたものだけを聞き直す
    if (targets.every((s) => items.has(s.id)) || reasons.length === 0) break;
    prompt = [
      quizPrompt(deps, targets.filter((s) => !items.has(s.id))),
      '',
      '【前回の指定が検証で通らなかった理由】',
      ...reasons.map((r) => `- ${r}`),
      '空欄の target は、変更後のコードのその行に実際に書かれている文字列をそのまま写してください。',
    ].join('\n');
  }
  return items;
}

// ---------- 変更の影響の問い ----------

/** 影響の問いの選択肢になる場所 (利用者が今のコードで探せるもの) */
interface Place {
  label: string;
  path: string;
  /** その場所を代表する行 (1始まり) と、その内容 */
  line: number;
  code: string;
  /** その場所のコード全体 (変わった名前を使っていないことの確認に使う) */
  text: string;
}

/** 選択肢の候補: 変えたファイル (変更前の内容)・読んだファイル・確認先のファイルにある関数 */
function placePool(deps: LessonDeps, obligations: Obligation[]): Place[] {
  const out: Place[] = [];
  const add = (rel: string, text: string): void => {
    const lines = splitLines(text);
    const decls = declarationsOf(lines).filter((d) => (d.kind === 'function' || d.kind === 'method') && d.name !== 'constructor');
    const names = new Set<string>();
    for (const [n, d] of decls.entries()) {
      if (names.has(d.name)) continue;
      names.add(d.name);
      const end = decls[n + 1]?.line ?? lines.length;
      // 代表の行は、宣言の中の最初の文 (括弧だけの行は飛ばす)。1行で書かれた宣言は、その行
      const bodyEnd = Math.min(end - 1, enclosingDeclaration(lines, d.line, d.line)?.end ?? d.headerEnd);
      let at = d.headerEnd + 1;
      while (at <= bodyEnd && /^[\s{}()\[\];,]*$/.test(lines[at] ?? '')) at++;
      if (at > bodyEnd) at = d.line;
      out.push({ label: `${rel} の ${d.name}`, path: rel, line: at + 1, code: lines[at]!.trim().slice(0, 120), text: lines.slice(d.line, end).join('\n') });
    }
    if (names.size === 0) {
      const at = Math.max(0, lines.findIndex((l) => l.trim() !== ''));
      out.push({ label: rel, path: rel, line: at + 1, code: (lines[at] ?? '').trim().slice(0, 120), text });
    }
  };
  const seen = new Set<string>();
  for (const c of deps.changes) {
    seen.add(c.rel);
    if (c.before !== null) add(c.rel, c.before);
  }
  const others = [...deps.recorder.reads.keys()].map((f) => toRel(deps.cwd, f)).concat(obligations.flatMap((o) => o.sites.map((s) => s.path)));
  for (const rel of others) {
    if (!rel || seen.has(rel) || !deps.view.has(rel)) continue;
    seen.add(rel);
    add(rel, deps.view.lines(rel).join('\n'));
  }
  return out;
}

/** 変更が必要だった場所の、変更前の行 (利用者が今のファイルで見られる行)。変更前にその名前が無ければ undefined */
function lineBefore(site: Site, o: Obligation, steps: Step[]): { line: number; code: string } | undefined {
  const re = subjectPattern(o);
  for (const e of steps.find((s) => s.id === site.step)?.edits ?? []) {
    if (e.path !== site.path || e.created) continue;
    const lines = splitLines(e.before);
    const at = lines.findIndex((l) => re.test(l) && !/^\s*(\/\/|\/\*|\*|#|import\b)/.test(l) && declarationAt(l)?.name !== o.subject);
    if (at >= 0) return { line: e.startLine + at, code: lines[at]!.trim().slice(0, 120) };
  }
  return undefined;
}

/**
 * 「この変更に合わせて、ほかに変更が必要になる場所はどこか」の予想 (lines / places)。
 * 実際に変更が必要だった場所があるステップにだけ出す (答えがコードで確かめられるものに限る)。
 * 違う選択肢にするのは、変わった名前をどこにも使っていない場所だけ。変更が不要だった場所・読まれていない場所は、
 * 選択肢に入れない (必要とも不要とも言い切れないため)。
 * lines では、候補を場所の名前ではなく実際の行で見せ、その中から選ぶ (知らないファイル名から選ばせない)。
 */
export function impactQuestion(step: Step, steps: Step[], obligations: Obligation[], pool: Place[], rng: () => number, profile: LevelProfile): ImpactQuestion | undefined {
  const mine = obligations.filter((o) => o.step === step.id);
  const own = new Set<string>();
  for (const e of step.edits) {
    own.add(e.path);
    for (const d of declarationsOf(splitLines(e.after))) own.add(`${e.path} の ${d.name}`);
  }
  const related = new Set(mine.flatMap((o) => o.sites.map(placeLabel)));
  const changed = mine.flatMap((o) => o.sites.filter((s) => s.verdict === 'changed' && !own.has(placeLabel(s))).map((site) => ({ o, site })));
  if (changed.length === 0) return undefined;
  const subjects = mine.map(subjectPattern);
  const unrelated = [...new Map(pool.map((p) => [p.label, p])).values()].filter(
    (p) => !related.has(p.label) && !own.has(p.label) && !subjects.some((re) => re.test(p.text)),
  );
  const patterns = [...new Set(changed.map((c) => c.o.pattern))];
  const hint = patterns.map((p) => `${PATTERNS[p].name}: ${PATTERNS[p].howToFind}`).join('\n');
  const secretOf = (sites: Site[]): ImpactSecret => ({
    names: [...new Set(sites.map((s) => s.symbol).filter((n): n is string => !!n))],
    paths: [...new Set(sites.map((s) => s.path))].filter((p) => !step.edits.some((e) => e.path === p)),
  });

  if (profile.impact === 'lines') {
    const first = changed.map((c) => ({ ...c, at: lineBefore(c.site, c.o, steps) })).find((c) => c.at);
    const wrong = shuffle(unrelated.filter((p) => p.code), rng).slice(0, profile.optionCount - 1);
    if (first?.at && wrong.length === profile.optionCount - 1) {
      const answer = { path: first.site.path, line: first.at.line, code: first.at.code };
      const options = shuffle([answer, ...wrong.map((p) => ({ path: p.path, line: p.line, code: p.code }))], rng);
      return {
        form: 'lines', prompt: 'この変更に合わせて、ほかに変える必要があるのはどの行ですか?', options, correct: [options.indexOf(answer)], hint,
        secret: secretOf([first.site]),
      };
    }
  }

  const labels = [...new Set(changed.map((c) => placeLabel(c.site)))].slice(0, profile.impact === 'lines' ? 1 : 2);
  const distractors = shuffle(unrelated.map((p) => p.label), rng).slice(0, profile.optionCount - labels.length);
  if (distractors.length < 2) return undefined;
  const options = shuffle([...labels, ...distractors], rng);
  return {
    form: 'places',
    prompt:
      labels.length > 1
        ? `この変更に合わせて、ほかに変更が必要になる場所をすべて選んでください(該当は${labels.length}か所)。`
        : 'この変更に合わせて、ほかに変更が必要になる場所はどこですか?',
    options,
    correct: labels.map((c) => options.indexOf(c)).sort((a, b) => a - b),
    hint,
    secret: secretOf(changed.filter((c) => labels.includes(placeLabel(c.site))).map((c) => c.site)),
  };
}

/** 1ステップで判断を求める場所の上限 */
const MAX_REVIEWS_PER_STEP = 2;

/**
 * エージェントが変えなかった場所の扱いが妥当かの判断 (review)。
 * 変えなかった判断が正しいかどうかは、機械的には確かめられない。そのため正誤は付けず、その行と、エージェントの扱い
 * (読んだうえで変えなかった理由 / 読んでいないこと) を見せて、利用者に判断してもらう。
 * 一度も読まれていない場所 (追従漏れになりうる) を先に取り上げる。
 */
export function reviewQuestion(step: Step, obligations: Obligation[], budget: number): ImpactQuestion | undefined {
  const sites = obligations
    .filter((o) => o.step === step.id)
    .flatMap((o) => o.sites.filter((s) => s.verdict !== 'changed').map((s) => ({ o, s })))
    .sort((x, y) => Number(y.s.verdict === 'unseen') - Number(x.s.verdict === 'unseen'))
    .slice(0, Math.min(budget, MAX_REVIEWS_PER_STEP));
  if (sites.length === 0) return undefined;
  return {
    form: 'review',
    prompt: 'エージェントは、次の場所を変更していません。その扱いは妥当ですか?',
    sites: sites.map(({ o, s }) => ({ label: placeLabel(s), path: s.path, line: s.line, code: s.text, subject: o.subject, read: s.verdict === 'checked', reason: s.reason })),
  };
}

// ---------- 組み立て ----------

/** この変更がどこから来たか (短い札): どの受け入れ条件のためか、どのステップの変更に合わせるのか */
function originTag(step: Step, steps: Step[], profile: LevelProfile): string {
  const cause = step.causedBy ? steps.find((s) => s.id === step.causedBy!.step) : undefined;
  if (cause) return `ステップ${cause.number}に合わせる`;
  return profile.criteria && step.criterion >= 1 ? `条件${step.criterion}のため` : '';
}

/** 問いを作らず、差分だけを見せる形 (中断・失敗したとき) */
export function plainLesson(deps: Pick<LessonDeps, 'changes' | 'unheld' | 'recorder' | 'request'>, notice: string): Lesson {
  return {
    kind: 'lesson', goal: deps.request, criteria: [], overall: '', verification: '', steps: [], obligations: [],
    changes: deps.changes, unheld: deps.unheld, commands: deps.recorder.commands, notice, profile: levelProfile('intermediate'),
  };
}

/** まとめの問いの材料にする部品: 変えたファイル (変更後)・読んだファイル・確認先のファイルにある宣言 */
function lessonComponents(deps: LessonDeps, obligations: Obligation[]): Component[] {
  const rels = new Set<string>(deps.changes.filter((c) => c.after !== null).map((c) => c.rel));
  for (const f of deps.recorder.reads.keys()) {
    const rel = toRel(deps.cwd, f);
    if (rel) rels.add(rel);
  }
  for (const o of obligations) for (const s of o.sites) rels.add(s.path);
  return componentsOf([...rels].filter((rel) => deps.view.has(rel)).map((rel) => ({ path: rel, text: deps.view.lines(rel).join('\n') })));
}

export async function buildLesson(deps: LessonDeps): Promise<Lesson> {
  const status = deps.onStatus ?? (() => undefined);
  const profile = levelProfile(deps.level);
  let steps = buildSteps(deps.changes);
  const obligations = analyzeImpact(steps, deps.changes, deps.view, deps.recorder);
  steps = reorderByCause(steps);
  const targetIds = new Set(quizTargets(steps, obligations, profile.maxQuizSteps).map((s) => s.id));
  steps = condense(steps, obligations, targetIds);
  const targets = steps.filter((s) => targetIds.has(s.id));

  status('変更の手順を組み立てています…');
  // 理由の聞き取りと、問いの場所の指定は、どちらも作業した会話の続きとして並行に聞く
  const [interview, items] = await Promise.all([
    deps.asker.fork<RawInterview>(interviewPrompt(deps, steps, obligations), INTERVIEW_SCHEMA, deps.signal).catch((e) => {
      if (deps.signal.aborted) throw e;
      return {} as RawInterview;
    }),
    buildItems(deps, targets).catch((e) => {
      if (deps.signal.aborted) throw e;
      return new Map<string, QuizItem>();
    }),
  ]);

  const components = lessonComponents(deps, obligations);
  if (profile.oneAtATime) {
    // モデルが問いを作れなかったステップには、「この行が呼んでいる関数はどれか」を機械的に作る
    const knownText = [deps.recorder.seenText(), ...deps.changes.map((c) => c.after ?? '')].join('\n');
    for (const s of targets) {
      const item = items.has(s.id) ? undefined : calleeItem(s, components, profile, knownText);
      if (item) items.set(s.id, item);
    }
  }

  const criteria = (interview.acceptanceCriteria ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 5);
  for (const s of steps) {
    const r = (interview.steps ?? []).find((x) => x.id === s.id);
    if (!r) continue;
    s.label = r.label?.trim() || s.label;
    s.why = r.why?.trim() ?? '';
    s.contract = r.contract?.trim() ?? '';
    s.criterion = Number.isInteger(r.criterion) && r.criterion! >= 1 && r.criterion! <= criteria.length ? r.criterion! : 0;
  }
  const allSites = obligations.flatMap((o) => o.sites);
  for (const site of allSites) {
    // 読んでいない場所の理由は、推測で書かれていても採らない
    site.reason = site.verdict === 'unseen' ? '' : ((interview.sites ?? []).find((x) => x.id === site.id)?.reason?.trim() ?? '');
  }
  // どの場所にも同じ文が付いた理由は、判断を分けた根拠にならないので見せない
  const reasonCount = new Map<string, number>();
  for (const site of allSites) if (site.reason) reasonCount.set(site.reason, (reasonCount.get(site.reason) ?? 0) + 1);
  for (const site of allSites) if ((reasonCount.get(site.reason) ?? 0) > 1) site.reason = '';
  // 変えた場所の理由は、その場所のステップより前に見せる。そのステップで考えてもらうコードを言っていたら、見せない
  for (const site of allSites) {
    const later = site.verdict === 'changed' && site.step ? items.get(site.step) : undefined;
    const shown = new Set((later?.newNames ?? []).map((n) => n.name));
    if (later?.blanks.some((b) => revealsAnswer(site.reason, b.answer, shown))) site.reason = '';
  }

  const visible = { goal: interview.understanding?.trim() || deps.request, items: steps.map((s) => items.get(s.id)).filter((i): i is QuizItem => !!i) };
  const overall = { text: interview.overall?.trim() ?? '' };
  // 作業を済ませたという報告の形の文章は、利用者がこれから実装する手順としての言い方に直す
  const slots: TextSlot[] = [
    { get: () => visible.goal, set: (t) => (visible.goal = t) },
    { get: () => overall.text, set: (t) => (overall.text = t) },
    ...criteria.map((_, i) => ({ get: () => criteria[i], set: (t: string) => (criteria[i] = t) })),
    ...steps.flatMap((s) => [
      { get: () => s.label, set: (t: string) => (s.label = t) },
      { get: () => s.why, set: (t: string) => (s.why = t) },
      { get: () => s.contract, set: (t: string) => (s.contract = t) },
    ]),
    ...allSites.map((p) => ({ get: () => p.reason, set: (t: string) => (p.reason = t) })),
    ...visible.items.flatMap(itemSlots),
  ];
  await rewriteReports(deps.asker, deps.level, slots, deps.signal);

  // 変更の影響の問い。形はレベルで変わる
  const pool = placePool(deps, obligations);
  const rng = makeRng(parseInt(sha1(deps.request + steps.map((s) => s.id + s.edits.map((e) => e.path).join()).join()).slice(0, 8), 16));
  let reviews = profile.maxReviews;
  const questions = new Map<string, ImpactQuestion>();
  for (const s of steps) {
    const q = profile.impact === 'review' ? reviewQuestion(s, obligations, reviews) : impactQuestion(s, steps, obligations, pool, rng, profile);
    if (!q) continue;
    if (q.form === 'review') reviews -= q.sites.length;
    questions.set(s.id, q);
  }

  // 答える前に見せる文章 (見出しと、目的の1行) は、答え合わせのあとに見せる全文とは別に持つ。
  // これから考えてもらうこと (空欄に入るコード・影響の及ぶ場所) を先に言っている文章は、書き直させる (それでも残れば、その文だけを除く。伏せ字にはしない)
  const displays = new Map(steps.map((s) => [s.id, { label: s.label, purpose: items.get(s.id)?.task || s.why }]));
  // 目的の1行は displays に移したので、問いの側の課題文は使わない (同じ文章を二重に確認しない)
  for (const item of visible.items) item.task = '';
  const targetsToCheck: LeakTarget[] = quizLeakTargets(visible);
  for (const s of steps) {
    const item = items.get(s.id);
    const q = questions.get(s.id);
    const d = displays.get(s.id)!;
    const labelSlot: TextSlot = { get: () => d.label, set: (t) => (d.label = t) };
    const purposeSlot: TextSlot = { get: () => d.purpose, set: (t) => (d.purpose = t) };
    if (item) {
      const base = { answers: item.blanks.map((b) => b.answer), shown: new Set((item.newNames ?? []).map((n) => n.name)), code: item.quizCode };
      targetsToCheck.push({ ...base, label: 'ステップの見出し', slot: labelSlot }, { ...base, label: 'このステップの目的', slot: purposeSlot });
    }
    if (q && q.form !== 'review' && q.secret.names.length > 0) {
      // 影響の問いの答えになる場所の名前も、先に言わない
      const base = { answers: q.secret.names };
      targetsToCheck.push({ ...base, label: 'ステップの見出し', slot: labelSlot }, { ...base, label: 'このステップの目的', slot: purposeSlot });
      for (const b of item?.blanks ?? []) {
        b.hints.forEach((_, k) => targetsToCheck.push({ ...base, label: '考える材料', slot: { get: () => b.hints[k], set: (t) => (b.hints[k] = t) } }));
      }
    }
  }
  if (visible.items.length > 0 || questions.size > 0) {
    status('説明文を確認しています…');
    await removeAnswerLeaks(deps.asker, deps.level, targetsToCheck, deps.signal);
  }
  for (const s of steps) {
    const q = questions.get(s.id);
    const item = items.get(s.id);
    const d = displays.get(s.id)!;
    if (!q || q.form === 'review') continue;
    // 影響の及ぶファイルの名前を挙げている文と、そのファイルを指す手がかりは、機械的に除く
    d.label = withoutMentions(d.label, q.secret.paths);
    d.purpose = withoutMentions(d.purpose, q.secret.paths);
    for (const b of item?.blanks ?? []) {
      b.hints = b.hints.map((h) => withoutMentions(h, q.secret.paths));
      if (b.clue && q.secret.paths.includes(b.clue.path)) delete b.clue;
    }
  }

  const recap = buildRecap(overall.text, components, { max: profile.recapBlanks, optionCount: profile.optionCount, rng });
  const lessonSteps: LessonStep[] = steps.map((step) => {
    const d = displays.get(step.id)!;
    return { step, item: items.get(step.id), question: questions.get(step.id), display: { label: d.label || `ステップ${step.number}`, purpose: d.purpose } };
  });
  return {
    kind: 'lesson', goal: visible.goal, criteria, overall: overall.text, verification: interview.verification?.trim() ?? '', steps: lessonSteps, obligations,
    changes: deps.changes, unheld: deps.unheld, commands: deps.recorder.commands, profile, recap,
  };
}

// ---------- 画面に渡す形 ----------

/** 「わからない」を選んだことを表す、選択肢の番号 */
export const UNKNOWN = -2;

/** 問い (正解・解説を含まない形) */
export function itemPayload(item: QuizItem): Record<string, unknown> {
  return {
    kind: item.kind,
    path: item.path,
    startLine: item.startLine,
    code: item.quizCode,
    // 空欄・変更行から離れた行は折りたたんで表示する
    folds: foldRanges(item),
    // 選択肢は表示順のコードだけを渡す (どれが正解か・解説は答え合わせまで渡さない)
    blanks: item.blanks.map((b) => ({
      concept: b.concept,
      hints: b.hints.filter(Boolean),
      clue: b.clue,
      options: (b.choices ?? []).map((c) => c.code),
      // 具体的な値で問うときは、問いの文と、選択肢ごとの値 (options と同じ並び)
      ask: b.value?.ask,
      labels: b.value?.labels,
      eliminate: eliminationHint(b.choices ?? [], b.answer),
    })),
  };
}

/** そのステップに、利用者が答える問いがあるか */
export function hasQuestion(ls: LessonStep): boolean {
  return !!ls.item || !!ls.question;
}

export function startPayload(lesson: Lesson): Record<string, unknown> {
  return {
    kind: 'lesson',
    goal: lesson.goal,
    criteria: lesson.profile.criteria ? lesson.criteria : [],
    notice: lesson.notice,
    steps: lesson.steps.length,
    questions: lesson.steps.filter(hasQuestion).length,
    files: lesson.changes.length,
  };
}

/** 答える前に見せるステップ: 見出し・目的の1行・コード・問い */
export function stepPayload(lesson: Lesson, index: number): Record<string, unknown> {
  const ls = lesson.steps[index];
  const s = ls.step;
  const q = ls.question;
  return {
    index,
    number: s.number,
    total: lesson.steps.length,
    label: ls.display.label,
    kind: STEP_KIND_LABEL[s.kind],
    origin: originTag(s, lesson.steps.map((x) => x.step), lesson.profile),
    purpose: ls.display.purpose,
    files: s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, line: e.startLine })),
    item: ls.item ? itemPayload(ls.item) : undefined,
    // 問いにしなかった変更は差分のまま見せる
    diffs: ls.item ? [] : s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, diff: showDiff(e.before, e.after) })),
    question: !q
      ? undefined
      : q.form === 'review'
        ? { form: q.form, prompt: q.prompt, sites: q.sites, picks: REVIEW_PICKS }
        : { form: q.form, prompt: q.prompt, options: q.options, multi: q.correct.length > 1, hint: q.hint },
    oneAtATime: lesson.profile.oneAtATime,
    // 問いの無いステップを、止まらずに続けて見せるか
    flow: lesson.profile.flow && !hasQuestion(ls),
  };
}

export interface StepAnswer {
  /** 空欄ごとに選んだ選択肢の番号 (未選択は -1、「わからない」は UNKNOWN) */
  blanks: number[];
  /** 影響の予想で選んだ選択肢の番号 */
  next: number[];
  /** 影響の予想で「わからない」を選んだ */
  nextUnknown?: boolean;
  /** review: 場所ごとの判断 (REVIEW_PICKS の番号) */
  review?: number[];
}

/** 空欄ごとの答え合わせ (picks: 選んだ選択肢の番号。未選択は -1、「わからない」は UNKNOWN) */
export function blankResults(item: QuizItem, chosen: number[]): Array<Record<string, unknown>> {
  const picks = item.blanks.map((_, k) => chosen[k] ?? -1);
  const grades = gradeBlanks(item, item.blanks.map((b, k) => b.choices?.[picks[k]]?.code ?? ''));
  return item.blanks.map((b, k) => ({
    correct: grades[k].correct,
    unknown: picks[k] === UNKNOWN,
    answer: b.answer,
    chosen: picks[k],
    // 選択肢の中で、このコードになるもの (答え合わせのあとに示す)
    correctIndex: (b.choices ?? []).findIndex((c) => c.code === b.answer),
    why: b.why ?? '',
    // 自分が選んだ誤答が「なぜ違うか」だけを見せる
    note: grades[k].correct ? '' : (b.choices?.[picks[k]]?.note ?? ''),
    // 値で問うたときの、計算の確かめ
    calc: b.value?.calc ?? '',
  }));
}

/** review で、利用者が「妥当」以外を選んだ場所 */
export function concernsOf(lesson: Lesson, index: number, answer: StepAnswer): Concern[] {
  const q = lesson.steps[index]?.question;
  if (!q || q.form !== 'review') return [];
  return q.sites.flatMap((s, k) => {
    const pick = REVIEW_PICKS[answer.review?.[k] ?? -1];
    return pick && pick !== REVIEW_PICKS[0] ? [{ label: s.label, path: s.path, line: s.line, pick }] : [];
  });
}

/**
 * 答え合わせ。見せるのは、予想が外れたことを正す情報だけにする。
 * - 空欄が違った・「わからない」のとき: その空欄の理由 (と、選んだ誤答が違う理由) を、その場に出す (画面側)
 * - 影響の予想が違った・「わからない」のとき: 影響の確認を開いて見せる (checksOpen)
 * それ以外の解説 (変更の理由・役割・差分) は、いつでも開けるよう折りたたんで添える (detail)。
 */
export function revealPayload(lesson: Lesson, index: number, answer: StepAnswer): Record<string, unknown> {
  const ls = lesson.steps[index];
  const s = ls.step;
  const numberOf = (id?: string): number | undefined => lesson.steps.find((x) => x.step.id === id)?.step.number;
  const item = ls.item;
  const blanks = item ? blankResults(item, answer.blanks) : [];
  const q = ls.question;
  let question: Record<string, unknown> | undefined;
  let predicted = true;
  if (q && q.form === 'review') {
    question = { form: q.form, picks: q.sites.map((_, k) => answer.review?.[k] ?? -1), concerns: concernsOf(lesson, index, answer).length };
  } else if (q) {
    const picked = answer.nextUnknown ? [] : [...new Set(answer.next)].filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length).sort((a, b) => a - b);
    predicted = picked.length === q.correct.length && picked.every((c, k) => c === q.correct[k]);
    question = { form: q.form, correct: predicted, unknown: !!answer.nextUnknown, correctIndexes: q.correct, chosen: picked };
  }
  const checks = lesson.obligations
    .filter((o) => o.step === s.id)
    .map((o) => ({
      pattern: PATTERNS[o.pattern].name,
      subject: o.subject,
      criterion: PATTERNS[o.pattern].criterion,
      results: o.sites
        .filter((p) => p.verdict !== 'unseen')
        // 変えなかった場所は、判断の根拠になる行そのものを見せる。変えた場所の行は、そのステップで考えてもらうので、ここでは見せない
        .map((p) => ({ path: p.path, line: p.line, label: placeLabel(p), code: p.verdict === 'checked' ? p.text : '', verdict: p.verdict, reason: p.reason, step: numberOf(p.step) })),
      // 作業の中で読まれなかった場所は、判断が無いので、一覧だけを添える
      others: o.sites.filter((p) => p.verdict === 'unseen').map((p) => ({ path: p.path, line: p.line, label: placeLabel(p) })),
      more: o.more,
    }));
  return {
    index,
    label: s.label,
    blanks,
    question,
    detail: item
      ? { why: s.why, explanation: item.explanation, diffs: s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, diff: showDiff(e.before, e.after) })) }
      : undefined,
    // 影響の確認: この変更で変わったものを使っている場所と、それぞれ変更が要るかどうかの判断
    contract: checks.length > 0 ? s.contract : '',
    checks,
    checksOpen: !!q && q.form !== 'review' && !predicted,
    last: index === lesson.steps.length - 1,
    recap: !!lesson.recap,
    flow: lesson.profile.flow && !hasQuestion(ls),
  };
}

/** まとめの問い (答えを含まない形) */
export function recapPayload(recap: Recap, kind: 'lesson' | 'reading'): Record<string, unknown> {
  return { kind, segments: recap.segments, blanks: recap.blanks.map((b) => ({ options: b.options })) };
}

/** まとめの答え合わせ (picks: 空欄ごとに選んだ選択肢の番号。「わからない」は UNKNOWN) */
export function recapRevealPayload(recap: Recap, picks: number[], kind: 'lesson' | 'reading'): Record<string, unknown> {
  return {
    kind,
    blanks: recap.blanks.map((b, k) => {
      const chosen = Number.isInteger(picks[k]) ? picks[k] : -1;
      const correctIndex = b.options.indexOf(b.answer);
      return { correct: chosen === correctIndex, unknown: chosen === UNKNOWN, chosen, correctIndex, answer: b.answer, where: b.where };
    }),
  };
}

/** 最後のまとめ (反映前の確認材料) */
export function finalPayload(lesson: Lesson, concerns: Concern[] = []): Record<string, unknown> {
  const steps = lesson.steps.map((x) => x.step);
  // 同じコマンドを何度も実行していれば、最後の結果だけを見せる
  const last = new Map<string, CommandRecord>();
  for (const c of lesson.commands) {
    last.delete(c.command);
    last.set(c.command, c);
  }
  return {
    // 変更の流れは、まとめの問いで見せていれば繰り返さない
    overall: lesson.recap ? '' : lesson.overall,
    notice: lesson.notice,
    // 受け入れ条件と、それを満たすためのステップ
    criteria: lesson.profile.criteria ? lesson.criteria.map((text, i) => ({ text, steps: steps.filter((s) => s.criterion === i + 1).map((s) => s.number) })) : [],
    files: lesson.changes.map((c) => ({
      path: c.rel,
      created: c.before === null,
      deleted: c.after === null,
      ...diffStat(c.before ?? '', c.after ?? ''),
      // 手順を組み立てられなかったときは、ここで差分を見せる
      diff: lesson.steps.length === 0 ? truncate(showDiff(c.before ?? '', c.after ?? ''), 6000) : undefined,
    })),
    // 動作確認: 何をどこまで確かめてあるか (文章) と、実行したコマンドの結果
    verification: lesson.verification,
    commands: [...last.values()].map((c) => ({ command: truncate(c.command, 200), description: c.description, ok: c.ok })),
    // 利用者が「妥当」以外を選んだ場所 (反映の前に確かめる材料)
    concerns,
    unheld: lesson.unheld,
  };
}
