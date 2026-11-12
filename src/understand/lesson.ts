import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileChange } from './changeSet';
import { analyzeImpact, PATTERNS, placeLabel, type Obligation, type Site, type WorkspaceView } from './impact';
import { eliminationHint } from './lib/choices';
import { declarationsOf } from './lib/declarations';
import { diffHunks, diffStat } from './lib/diff';
import { maskAnswers, revealsAnswer } from './lib/leak';
import { levelGuide, levelStyle, type LearnerLevel } from './lib/level';
import { compactItem, foldRanges, gradeBlanks, validateRawItem, type RawBlank, type RawItem, type RawRef } from './lib/quiz';
import { makeRng, numberLines, sha1, shuffle, splitLines, truncate } from './lib/text';
import type { McqQuestion, NewName, QuizItem } from './lib/types';
import type { Asker } from './llm';
import { BLANKS_SCHEMA, checkItemRefs, distractorRules, leakRules, NEW_NAMES_SCHEMA, REFS_SCHEMA, removeAnswerLeaks } from './quizCommon';
import type { CommandRecord, Recorder } from './recorder';
import { buildSteps, condense, reorderByCause, STEP_KIND_LABEL, type Step } from './steps';

/**
 * 確定した変更 (エージェントが実装と検証を終えたもの) を、順を追ってたどれる手順にする。
 * - ステップと影響の及ぶ場所は、差分と作業の記録から機械的に求める
 * - 理由 (なぜ変えたか / なぜ変えなかったか) は、作業したエージェント自身の会話に聞く
 * - 問いのコードは確定した変更後のコードから組み立て、LLM には空欄の場所だけを決めさせる
 */

/** 問いにするステップの上限 (多すぎると負荷が高い) */
const MAX_QUIZ_STEPS = 6;
const MAX_DIFF_CHARS = 2500;
/** 聞き取りに載せる差分全体の目安 (変更が多いときは、1か所あたりを短くする) */
const DIFF_BUDGET_CHARS = 60_000;

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

export interface LessonStep {
  step: Step;
  item?: QuizItem;
  /** 次に確認すべき場所の予想 */
  question?: McqQuestion & { hint: string };
  /** 答える前に見せる文章 (答えが出ていたら伏せたもの) */
  display: { label: string; why: string; contract: string };
}

export interface Lesson {
  kind: 'lesson';
  /** 依頼をどう理解したか */
  goal: string;
  criteria: string[];
  overall: string;
  steps: LessonStep[];
  obligations: Obligation[];
  changes: FileChange[];
  unheld: string[];
  commands: CommandRecord[];
  /** 手順を組み立てられなかった理由 (あれば、差分だけを見せる) */
  notice?: string;
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
    required: ['understanding', 'acceptanceCriteria', 'overall', 'steps', 'sites'],
    additionalProperties: false,
  },
} as const;

interface RawInterview {
  understanding?: string;
  acceptanceCriteria?: string[];
  overall?: string;
  steps?: Array<{ id?: string; label?: string; why?: string; criterion?: number; contract?: string }>;
  sites?: Array<{ id?: string; reason?: string }>;
}

const VERDICT_LABEL = { changed: '今回変更した', checked: '読んだが変更していない', unseen: '作業中に一度も読んでいない' } as const;

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
    '利用者がこの変更を自分で確かめながら受け入れられるように、あなたが行った変更の理由と判断を整理します。指定のJSONで答えてください。',
    '',
    `【利用者の依頼】\n${deps.request}`,
    '',
    `【確定した変更(システムが差分から機械的に分けたステップ)】\n${describeSteps(steps)}`,
    '',
    sites.length > 0 ? `【変更の影響が及びうる場所(システムが検索で集めたもの)】\n${sites.join('\n')}` : '【変更の影響が及びうる場所】\n(なし)',
    '',
    '【書くこと】',
    '- understanding: 依頼をどう理解したかを1〜2文。',
    '- acceptanceCriteria: 受け入れ条件を1〜5件。「〜のとき〜になる」のように、実装できたかを確かめられる振る舞いで書く。',
    '- steps: 上の各ステップについて1件ずつ(id はそのまま)。',
    '  - label: そのステップで何をするかの短い見出し(20文字程度。コードは書かない)。',
    '  - why: なぜその場所を、そう変える必要があったか。ほかのステップの変更に合わせたものなら、どの変更に合わせたかを書く。2〜3文。',
    '  - criterion: 主にどの受け入れ条件のための変更か(1始まりの番号。特定の条件に結びつかなければ 0)。',
    '  - contract: この変更で変わる約束(関数の引数・戻り値・型の項目・メッセージの種類・設定キーなど)を1文。変わらなければ空文字。',
    '- sites: 上の各場所について1件ずつ(id はそのまま)。',
    '  - 「今回変更した」場所: なぜ変更が必要だったか。',
    '  - 「読んだが変更していない」場所: なぜ変更が不要と判断したかを、その行のコードを根拠に。',
    '  - 「一度も読んでいない」場所: reason は空文字にする(確かめていないことを推測で書かない)。',
    '- overall: 変更全体の流れ(どこから始めて、何に波及したか)を、ファイル名を挙げて3〜5文。',
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
          properties: { step: STRING, task: STRING, explanation: STRING, newNames: NEW_NAMES_SCHEMA, refs: REFS_SCHEMA, blanks: BLANKS_SCHEMA },
          required: ['step', 'task', 'explanation', 'newNames', 'refs', 'blanks'],
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
  refs?: RawRef[];
  blanks?: RawBlank[];
}

function quizPrompt(deps: LessonDeps, targets: Step[]): string {
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
    '利用者がこの変更の考えどころを自分で考えられるように、ステップごとに、変更後のコードの「考えどころ」を空欄にした選択式の問いを作ります。',
    '変更後のコードは確定済みです。書き換えずに、空欄にする場所だけを指定します。空欄は選択式(正解1つ + 誤答3つ)。指定のJSONで答えてください。',
    '',
    '【items】',
    '- 下に示すステップのうち、考えどころがあるものについて1件ずつ。step にステップの id を入れる。',
    '- task(答える前に表示): このステップで、何を実現するために、どこを、どう変えるか(仕様)を1〜2文。答えのコードは書かない。',
    '- explanation(答え合わせの後に表示): この変更の役割と、ほかのファイル・処理との関係を具体的に。',
    '- newNames: このステップで新しく作るメソッド・関数・変数・引数・フィールドなどの名前と役割(答える前に表示)。名前そのものは空欄にしない。',
    '- refs(答える前に表示, 0〜2件): 読むと考えやすくなる、変更前から在るコードの場所(手本になる似た実装・使う関数の定義など)。path はワークスペースからの相対パス。',
    '',
    '【空欄 blanks の指定】',
    '- line: 変更後のコード(行番号付きで示す)の中での行番号(1始まり)。',
    '- target: その行に逐語で含まれる、空欄にする部分(1行以内・60文字以内)。行全体ではなく、条件式・呼び出し・引数・代入値など意味のある単位。',
    '- 少なくとも1つは、変更・追加した行(差分の + の行)に置く。「なぜその場所をそう変えるのか」「何に合わせるのか」が問われる箇所を選ぶ。',
    '- 個数と難しさは下の【利用者のレベル】に従う(ただし1ステップあたり最大4個)。',
    '',
    ...distractorRules(),
    '',
    ...leakRules('task・refs・concept・2段階の手がかり・clueNote'),
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

/** 問いにするステップ (並び順で先のものから上限まで) */
function quizTargets(steps: Step[]): Step[] {
  return steps.filter((s) => s.quizzable && s.edits.length === 1).slice(0, MAX_QUIZ_STEPS);
}

async function buildItems(deps: LessonDeps, steps: Step[]): Promise<Map<string, QuizItem>> {
  const items = new Map<string, QuizItem>();
  const targets = quizTargets(steps);
  if (targets.length === 0) return items;
  const knownText = [deps.recorder.seenText(), ...deps.changes.map((c) => c.after ?? '')].join('\n');
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
        refs: Array.isArray(raw.refs) ? raw.refs : [],
        newNames: Array.isArray(raw.newNames) ? raw.newNames : [],
        explanation: raw.explanation ?? '',
      };
      const verdict = validateRawItem(rawItem, edit.fileBefore, { knownText, allowLong: true });
      if (!verdict.ok) {
        reasons.push(`${step.id}: ${verdict.reason}`);
        continue;
      }
      await checkItemRefs(refReader(deps.cwd), verdict.item);
      items.set(step.id, compactItem(verdict.item));
    }
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

// ---------- 次に確認すべき場所の予想 ----------

/** 予想の誤答に使う場所の候補: 変えたファイル・読んだファイル・確認先のファイルにある関数 (利用者が今のコードで探せるもの) */
function placePool(deps: LessonDeps, obligations: Obligation[]): string[] {
  const out: string[] = [];
  const add = (rel: string, text: string): void => {
    const names = [...new Set(declarationsOf(splitLines(text)).filter((d) => d.kind === 'function' || d.kind === 'method').map((d) => d.name))];
    if (names.length === 0) out.push(rel);
    for (const n of names.filter((n) => n !== 'constructor')) out.push(`${rel} の ${n}`);
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

/** 「この変更のあと、確認が必要になる場所はどこか」の予想 */
export function nextCheckQuestion(step: Step, obligations: Obligation[], pool: string[], rng: () => number): (McqQuestion & { hint: string }) | undefined {
  const mine = obligations.filter((o) => o.step === step.id);
  // 変更が必要だった場所を優先して正解にする
  const places = new Map<string, boolean>();
  for (const o of mine) {
    for (const s of o.sites) places.set(placeLabel(s), (places.get(placeLabel(s)) ?? false) || s.verdict === 'changed');
  }
  const own = new Set<string>();
  for (const e of step.edits) {
    own.add(e.path);
    for (const d of declarationsOf(splitLines(e.after))) own.add(`${e.path} の ${d.name}`);
  }
  const correct = [...places]
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([label]) => label)
    .filter((label) => !own.has(label))
    .slice(0, 2);
  if (correct.length === 0) return undefined;
  const distractors = shuffle([...new Set(pool)].filter((l) => !places.has(l) && !own.has(l)), rng).slice(0, 4 - correct.length);
  if (distractors.length < 2) return undefined;
  const options = shuffle([...correct, ...distractors], rng);
  const patterns = [...new Set(mine.map((o) => o.pattern))];
  return {
    id: `next:${step.id}`,
    prompt:
      correct.length > 1
        ? `この変更のあと、確認が必要になる場所をすべて選んでください(該当は${correct.length}か所)。`
        : 'この変更のあと、確認が必要になる場所はどこですか?',
    options,
    correct: correct.map((c) => options.indexOf(c)).sort((a, b) => a - b),
    explanation: '',
    concept: PATTERNS[patterns[0]].name,
    hint: patterns.map((p) => `${PATTERNS[p].name}: ${PATTERNS[p].howToFind}`).join('\n'),
  };
}

// ---------- 組み立て ----------

function whyText(step: Step, steps: Step[], criteria: string[]): string {
  const lines: string[] = [];
  const cause = step.causedBy ? steps.find((s) => s.id === step.causedBy!.step) : undefined;
  if (cause) lines.push(`ステップ${cause.number}「${cause.label}」の変更に合わせるため(${step.causedBy!.pattern})。`);
  else if (step.criterion >= 1 && criteria[step.criterion - 1]) lines.push(`受け入れ条件 ${step.criterion}「${criteria[step.criterion - 1]}」を満たすため。`);
  if (step.why) lines.push(step.why);
  return lines.join('\n');
}

function overallText(lesson: Pick<Lesson, 'goal' | 'steps' | 'obligations'>, summary: string): string {
  const lines: string[] = [];
  if (summary) lines.push(summary, '');
  lines.push('手順:');
  for (const { step: s } of lesson.steps) {
    const cause = s.causedBy ? lesson.steps.find((x) => x.step.id === s.causedBy!.step)?.step : undefined;
    const origin = cause ? `ステップ${cause.number}の変更に合わせる(${s.causedBy!.pattern})` : '依頼を満たすための変更';
    lines.push(`${s.number}. ${s.label} — ${[...new Set(s.edits.map((e) => e.path))].join(', ')}(${origin})`);
  }
  const sites = lesson.obligations.flatMap((o) => o.sites);
  if (sites.length > 0) {
    const count = (v: Site['verdict']) => sites.filter((s) => s.verdict === v).length;
    lines.push(
      `影響の確認: ${lesson.obligations.length}件の変更について${sites.length}か所を調べ、${count('changed')}か所を変更、` +
        `${count('checked')}か所は読んだうえで変更なし、${count('unseen')}か所は未確認です。`,
    );
  }
  return lines.join('\n');
}

/** 問いを作らず、差分だけを見せる形 (中断・失敗したとき) */
export function plainLesson(deps: Pick<LessonDeps, 'changes' | 'unheld' | 'recorder' | 'request'>, notice: string): Lesson {
  return {
    kind: 'lesson', goal: deps.request, criteria: [], overall: '', steps: [], obligations: [],
    changes: deps.changes, unheld: deps.unheld, commands: deps.recorder.commands, notice,
  };
}

export async function buildLesson(deps: LessonDeps): Promise<Lesson> {
  const status = deps.onStatus ?? (() => undefined);
  let steps = buildSteps(deps.changes);
  const obligations = analyzeImpact(steps, deps.changes, deps.view, deps.recorder);
  steps = reorderByCause(steps);
  steps = condense(steps, obligations, new Set(quizTargets(steps).map((s) => s.id)));

  status('変更の理由と考えどころを整理しています…');
  // 理由の聞き取りと、問いの場所の指定は、どちらも作業した会話の続きとして並行に聞く
  const [interview, items] = await Promise.all([
    deps.asker.fork<RawInterview>(interviewPrompt(deps, steps, obligations), INTERVIEW_SCHEMA, deps.signal).catch((e) => {
      if (deps.signal.aborted) throw e;
      return {} as RawInterview;
    }),
    buildItems(deps, steps).catch((e) => {
      if (deps.signal.aborted) throw e;
      return new Map<string, QuizItem>();
    }),
  ]);

  const criteria = (interview.acceptanceCriteria ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 5);
  for (const s of steps) {
    const r = (interview.steps ?? []).find((x) => x.id === s.id);
    if (!r) continue;
    s.label = r.label?.trim() || s.label;
    s.why = r.why?.trim() ?? '';
    s.contract = r.contract?.trim() ?? '';
    s.criterion = Number.isInteger(r.criterion) && r.criterion! >= 1 && r.criterion! <= criteria.length ? r.criterion! : 0;
  }
  for (const site of obligations.flatMap((o) => o.sites)) {
    // 読んでいない場所の理由は、推測で書かれていても採らない
    site.reason = site.verdict === 'unseen' ? '' : ((interview.sites ?? []).find((x) => x.id === site.id)?.reason?.trim() ?? '');
  }

  const visible = { goal: interview.understanding?.trim() || deps.request, items: steps.map((s) => items.get(s.id)).filter((i): i is QuizItem => !!i) };
  if (visible.items.length > 0) {
    status('手がかりの文章を点検しています…');
    await removeAnswerLeaks(deps.asker, deps.level, visible, deps.signal);
  }

  const pool = placePool(deps, obligations);
  const rng = makeRng(parseInt(sha1(deps.request + steps.map((s) => s.id + s.label).join()).slice(0, 8), 16));
  const lessonSteps: LessonStep[] = steps.map((step) => {
    const item = items.get(step.id);
    const display = { label: step.label, why: whyText(step, steps, criteria), contract: step.contract };
    if (item) {
      // 聞き取りで得た文章 (見出し・理由・約束の変化) に、このステップの答えが出ていれば、答える前は伏せる
      const answers = item.blanks.map((b) => b.answer);
      const shown = new Set((item.newNames ?? []).map((n) => n.name));
      for (const field of ['label', 'why', 'contract'] as const) {
        const hit = answers.filter((a) => revealsAnswer(display[field], a, shown));
        if (hit.length > 0) display[field] = maskAnswers(display[field], hit);
      }
    }
    return { step, item, question: nextCheckQuestion(step, obligations, pool, rng), display };
  });
  const lesson: Lesson = {
    kind: 'lesson', goal: visible.goal, criteria, overall: '', steps: lessonSteps, obligations,
    changes: deps.changes, unheld: deps.unheld, commands: deps.recorder.commands,
  };
  lesson.overall = overallText(lesson, interview.overall?.trim() ?? '');
  return lesson;
}

// ---------- 画面に渡す形 ----------

/** 問い (正解・解説を含まない形) */
export function itemPayload(item: QuizItem): Record<string, unknown> {
  return {
    kind: item.kind,
    path: item.path,
    startLine: item.startLine,
    code: item.quizCode,
    // 空欄・変更行から離れた行は折りたたんで表示する
    folds: foldRanges(item),
    task: item.task ?? '',
    refs: item.refs ?? [],
    newNames: item.newNames ?? [],
    // 選択肢は表示順のコードだけを渡す (どれが正解か・解説は答え合わせまで渡さない)
    blanks: item.blanks.map((b) => ({
      concept: b.concept,
      hints: b.hints.filter(Boolean),
      clue: b.clue,
      options: (b.choices ?? []).map((c) => c.code),
      eliminate: eliminationHint(b.choices ?? [], b.answer),
    })),
  };
}

export function startPayload(lesson: Lesson): Record<string, unknown> {
  return {
    kind: 'lesson',
    goal: lesson.goal,
    criteria: lesson.criteria,
    notice: lesson.notice,
    map: lesson.steps.map((ls) => ({ number: ls.step.number, label: ls.display.label, kind: STEP_KIND_LABEL[ls.step.kind] })),
    files: lesson.changes.length,
  };
}

/** 答える前に見せるステップ */
export function stepPayload(lesson: Lesson, index: number): Record<string, unknown> {
  const ls = lesson.steps[index];
  const s = ls.step;
  return {
    index,
    number: s.number,
    total: lesson.steps.length,
    label: ls.display.label,
    kind: STEP_KIND_LABEL[s.kind],
    why: ls.display.why,
    contract: ls.display.contract,
    files: s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, line: e.startLine })),
    item: ls.item ? itemPayload(ls.item) : undefined,
    // 問いにしなかった変更は差分のまま見せる
    diffs: ls.item ? [] : s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, diff: showDiff(e.before, e.after) })),
    question: ls.question
      ? { prompt: ls.question.prompt, options: ls.question.options, multi: ls.question.correct.length > 1, hint: ls.question.hint }
      : undefined,
  };
}

export interface StepAnswer {
  /** 空欄ごとに選んだ選択肢の番号 (未選択は -1) */
  blanks: number[];
  /** 予想で選んだ選択肢の番号 */
  next: number[];
}

/** 空欄ごとの答え合わせ (picks: 選んだ選択肢の番号。未選択は -1) */
export function blankResults(item: QuizItem, chosen: number[]): Array<Record<string, unknown>> {
  const picks = item.blanks.map((_, k) => chosen[k] ?? -1);
  const grades = gradeBlanks(item, item.blanks.map((b, k) => b.choices?.[picks[k]]?.code ?? ''));
  return item.blanks.map((b, k) => ({
    correct: grades[k].correct,
    answer: b.answer,
    chosen: picks[k],
    why: b.why ?? '',
    // 自分が選んだ誤答が「なぜ違うか」だけを見せる
    note: grades[k].correct ? '' : (b.choices?.[picks[k]]?.note ?? ''),
  }));
}

/** 答え合わせ: 採点の結果と、理由の全文・差分・影響の追い方 (見つけ方と判断) */
export function revealPayload(lesson: Lesson, index: number, answer: StepAnswer): Record<string, unknown> {
  const ls = lesson.steps[index];
  const s = ls.step;
  const numberOf = (id?: string): number | undefined => lesson.steps.find((x) => x.step.id === id)?.step.number;
  const item = ls.item;
  const blanks = item ? blankResults(item, answer.blanks) : [];
  const q = ls.question;
  const picked = q ? [...new Set(answer.next)].filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length).sort((a, b) => a - b) : [];
  return {
    index,
    label: s.label,
    why: whyText(s, lesson.steps.map((x) => x.step), lesson.criteria),
    contract: s.contract,
    explanation: item?.explanation ?? '',
    blanks,
    diffs: s.edits.map((e) => ({ path: e.path, created: e.created, deleted: e.deleted, diff: showDiff(e.before, e.after) })),
    question: q ? { correct: picked.length === q.correct.length && picked.every((c, k) => c === q.correct[k]), correctIndexes: q.correct, chosen: picked } : undefined,
    checks: lesson.obligations
      .filter((o) => o.step === s.id)
      .map((o) => ({
        pattern: PATTERNS[o.pattern].name,
        trigger: PATTERNS[o.pattern].trigger,
        subject: o.subject,
        howToFind: PATTERNS[o.pattern].howToFind,
        criterion: PATTERNS[o.pattern].criterion,
        more: o.more,
        results: o.sites.map((p) => ({ path: p.path, line: p.line, text: p.text, label: placeLabel(p), verdict: p.verdict, reason: p.reason, step: numberOf(p.step) })),
      })),
    last: index === lesson.steps.length - 1,
  };
}

/** 最後のまとめ (反映前の確認材料) */
export function finalPayload(lesson: Lesson): Record<string, unknown> {
  const unseen = lesson.obligations.flatMap((o) =>
    o.sites.filter((p) => p.verdict === 'unseen').map((p) => ({ path: p.path, line: p.line, label: placeLabel(p), subject: o.subject, pattern: PATTERNS[o.pattern].name })),
  );
  return {
    overall: lesson.overall,
    criteria: lesson.criteria,
    notice: lesson.notice,
    files: lesson.changes.map((c) => ({
      path: c.rel,
      created: c.before === null,
      deleted: c.after === null,
      ...diffStat(c.before ?? '', c.after ?? ''),
      // 手順を組み立てられなかったときは、ここで差分を見せる
      diff: lesson.steps.length === 0 ? truncate(showDiff(c.before ?? '', c.after ?? ''), 6000) : undefined,
    })),
    commands: lesson.commands.map((c) => ({ command: truncate(c.command, 200), ok: c.ok })),
    unseen,
    unseenMore: lesson.obligations.reduce((n, o) => n + o.more, 0),
    unheld: lesson.unheld,
  };
}
