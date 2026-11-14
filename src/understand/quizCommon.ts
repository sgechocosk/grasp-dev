import { levelStyle, soundsLikeReport, type LearnerLevel } from './lib/level';
import { distinctiveWords, revealsAnswer } from './lib/leak';
import { splitLines } from './lib/text';
import type { CodeRef, QuizItem } from './lib/types';
import type { Asker } from './llm';

// 問いの作り方の決まりと、答え漏れの確認。quiz-based-support の src/core/agent.ts から移植。

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;

/** 空欄の指定 (どの行のどの部分を空欄にするか、だけを LLM に決めさせる) */
export const BLANKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      line: INTEGER,
      target: STRING,
      concept: STRING,
      hintConcept: STRING,
      hintApproach: STRING,
      why: STRING,
      distractors: {
        type: 'array',
        items: {
          type: 'object',
          properties: { code: STRING, whyWrong: STRING },
          required: ['code', 'whyWrong'],
          additionalProperties: false,
        },
      },
      cluePath: STRING,
      clueLine: INTEGER,
      clueNote: STRING,
    },
    required: ['line', 'target', 'concept', 'hintConcept', 'hintApproach', 'why', 'distractors', 'cluePath', 'clueLine', 'clueNote'],
    additionalProperties: false,
  },
} as const;

/** 具体的な値で問うための、引数に入れる値の例 (答えはシステムが計算で求める) */
export const INPUTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: STRING, value: { type: 'number' } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
} as const;

export interface RawInput {
  name?: string;
  value?: number;
}

export function proposedInputs(inputs: RawInput[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of Array.isArray(inputs) ? inputs : []) {
    if (typeof i?.name === 'string' && typeof i.value === 'number' && Number.isFinite(i.value)) out.set(i.name.trim(), i.value);
  }
  return out;
}

export const NEW_NAMES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: STRING, role: STRING },
    required: ['name', 'role'],
    additionalProperties: false,
  },
} as const;

/** 選択肢 (誤答) の作り方 */
export function distractorRules(count = 3): string[] {
  return [
    `【選択肢 distractors(誤答を${count}つ)】`,
    '- 目的は「コードベースを読んで根拠を確かめないと選べない」こと。勘や見た目で消去できる誤答は作らない。',
    '- 良い誤答: 実在する似た名前の別の関数・変数・フィールド(責務が違う)/ 引数の取り違え・順序違い / 境界条件の違い(< と <=)/ 条件の反転 /',
    '  同じファイルの別の箇所にある似た式 / 呼ぶ順序や呼ぶ相手を間違えたもの。どれもこのコードベースで実際に書かれうるもの。',
    '- 誤答には、あなたが読んだコードに無い名前を使わない(存在しない名前は見ただけで誤りと分かる)。新しく作る名前(newNames)は使ってよい。',
    '- 正解と書き方が違うだけで同じ動作になるもの(等価な書き換え)は誤答にしない。',
    '- 正解と長さ・形をそろえる(正解だけが長い・具体的、などで見分けられないように)。各誤答は1行・60文字以内。',
    '- whyWrong(答え合わせの後に表示): なぜ誤りかを、根拠のファイル名:行と仕組みで1〜2文。正解のコードは書かない。',
  ];
}

/** 答え漏れを防ぐ決まり。visible は答える前に利用者に見える項目 */
export function leakRules(visible: string): string[] {
  return [
    '【答えを漏らさない(最重要)】',
    `答える前に見えるのは ${visible}。これらには、どの空欄の答えのコード片も、答えの識別子の組み合わせも書かない。`,
    '- hintConcept: どんな概念・仕組みが関わるか(例: 「非同期処理の完了を待つ必要がある」)。',
    '- hintApproach: どこを見て、どう考えれば選択肢を絞れるか(例: 「この関数の戻り値の型と、呼び出し元での使われ方を見比べる」)。',
    '- cluePath/clueLine/clueNote: 答えを導く根拠になる「別の場所」(呼び出す関数の定義・型定義・手本になる類似コードなど)。変更前から在るコードの行を指定し、',
    '  その行自体に答えが書かれていてはいけない。適切な場所が無ければ cluePath は空文字、clueLine は0。',
  ];
}

/** 手がかり・参考コードの場所が実在し、その行に答えが書かれていないことを確かめる (満たさないものは外す) */
export async function checkItemRefs(read: (ref: string) => Promise<{ path: string; text: string } | undefined>, item: QuizItem): Promise<void> {
  const cache = new Map<string, { path: string; lines: string[] } | undefined>();
  const answers = item.blanks.map((b) => b.answer.replace(/\s+/g, '')).filter((a) => a.length >= 2);
  const verify = async (ref: CodeRef | undefined): Promise<CodeRef | undefined> => {
    if (!ref || !ref.path) return undefined;
    if (!cache.has(ref.path)) {
      const got = await read(ref.path).catch(() => undefined);
      cache.set(ref.path, got ? { path: got.path, lines: splitLines(got.text) } : undefined);
    }
    const file = cache.get(ref.path);
    const text = file?.lines[ref.line - 1];
    if (!file || text === undefined || text.trim() === '') return undefined;
    const squashed = text.replace(/\s+/g, '');
    if (answers.some((a) => squashed.includes(a))) return undefined;
    return { ...ref, path: file.path };
  };
  for (const b of item.blanks) {
    const clue = await verify(b.clue);
    if (clue) b.clue = clue;
    else delete b.clue;
  }
  const refs: CodeRef[] = [];
  for (const r of (item.refs ?? []).slice(0, 3)) {
    const ok = await verify(r);
    if (ok) refs.push(ok);
  }
  item.refs = refs;
}

// ---------- 答え漏れの検出と修正 ----------

/** 文章の置き場所 (読む・書き戻す) */
export interface TextSlot {
  get: () => string;
  set: (text: string) => void;
}

/** 答える前に利用者へ見せる文章の1つと、そこに出てはいけない答え */
export interface LeakTarget {
  /** 何の文章か (書き直しを頼むときに伝える) */
  label: string;
  slot: TextSlot;
  answers: string[];
  /** 答える前に明示している名前 (新しく追加する変数など)。答えを特定する材料に数えない */
  shown?: ReadonlySet<string>;
  /** 書き直しの参考に見せる、空欄つきのコード */
  code?: string;
  /** 短い名詞のタグか (書き直せなければ汎用のタグにする) */
  tag?: boolean;
}

function leaking(t: LeakTarget): string[] {
  return t.answers.filter((a) => revealsAnswer(t.slot.get(), a, t.shown));
}

/** 問いの中の、答える前に見える文章 (目標・課題文・参考コードの説明・概念タグ・手がかり) */
export function quizLeakTargets(quiz: { goal: string; items: QuizItem[] }): LeakTarget[] {
  // 別の問いの答えも、同じ画面に並ぶので漏れになる
  const answers = quiz.items.flatMap((it) => it.blanks.map((b) => b.answer));
  const shown = new Set(quiz.items.flatMap((it) => (it.newNames ?? []).map((n) => n.name)));
  const out: LeakTarget[] = [{ label: '目標', slot: { get: () => quiz.goal, set: (t) => (quiz.goal = t) }, answers, shown }];
  for (const item of quiz.items) {
    const base = { answers, shown, code: item.quizCode };
    out.push({ ...base, label: '課題文', slot: { get: () => item.task ?? '', set: (t) => (item.task = t) } });
    for (const r of item.refs ?? []) out.push({ ...base, label: '参考コードの説明', slot: { get: () => r.note, set: (t) => (r.note = t) } });
    for (const b of item.blanks) {
      out.push({ ...base, label: '概念タグ(短い名詞)', tag: true, slot: { get: () => b.concept, set: (t) => (b.concept = t) } });
      b.hints.forEach((_, k) =>
        out.push({ ...base, label: k === 0 ? '考える材料1(どんな概念・仕組みが関わるか)' : '考える材料2(どこを見てどう考えるか)', slot: { get: () => b.hints[k], set: (t) => (b.hints[k] = t) } }),
      );
      const clue = b.clue;
      if (clue) out.push({ ...base, label: '参考にする場所の説明', slot: { get: () => clue.note, set: (t) => (clue.note = t) } });
    }
  }
  return out;
}

const LEAK_FIX_SCHEMA = {
  name: 'leak_fix',
  schema: {
    type: 'object',
    properties: {
      fixes: {
        type: 'array',
        items: { type: 'object', properties: { id: STRING, text: STRING }, required: ['id', 'text'], additionalProperties: false },
      },
    },
    required: ['fixes'],
    additionalProperties: false,
  },
} as const;

/**
 * 答えを含む文だけを取り除く (伏せ字にはしない: 伏せ字の多い文章は、理由を理解する妨げになる)。
 * 文単位で落とし、それでも答えの識別子がそろって残るなら、その識別子を含む文も落とす。
 */
export function withoutLeaks(text: string, answers: string[], shown: ReadonlySet<string> = new Set()): string {
  const reveals = (t: string): boolean => answers.some((a) => revealsAnswer(t, a, shown));
  let sentences = (text ?? '').split(/(?<=[。\n])/).filter((s) => !reveals(s));
  if (reveals(sentences.join(''))) {
    const words = new Set(answers.flatMap(distinctiveWords).filter((w) => !shown.has(w)));
    sentences = sentences.filter((s) => ![...words].some((w) => new RegExp(`(?<![\\w$])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(s)));
  }
  const out = sentences.join('').trim();
  return reveals(out) ? '' : out;
}

/**
 * ファイルの名前 (パス、またはその末尾のファイル名) を挙げている文を取り除く。
 * 影響の及ぶ場所を予想してもらう前に、そのファイルを文章で言ってしまわないために使う。
 */
export function withoutMentions(text: string, paths: string[]): string {
  const needles = [...new Set(paths.flatMap((p) => [p, p.slice(p.lastIndexOf('/') + 1)]))].filter(Boolean);
  if (needles.length === 0) return text ?? '';
  return (text ?? '').split(/(?<=[。\n])/).filter((s) => !needles.some((n) => s.includes(n))).join('').trim();
}

/**
 * 答える前に見える文章の答え漏れを LLM に書き直させ、それでも残るものは、答えを含む文を取り除く。
 * 「答えを書かない」という指示だけでは守られないので、機械的に確かめて必ず塞ぐ。
 */
export async function removeAnswerLeaks(asker: Asker, level: LearnerLevel, targets: LeakTarget[], signal: AbortSignal): Promise<void> {
  const leaks = targets.filter((t) => leaking(t).length > 0);
  if (leaks.length === 0) return;
  try {
    const res = await asker.fresh<{ fixes?: Array<{ id: string; text: string }> }>(
      [
        'あなたはコードの理解を支援する文章の編集者です。以下の文章は、利用者が自分で考える前に見せるのに、考えてもらうコード(空欄に入るコード)を先に言ってしまっています。',
        '各 id について、そのコード片も、そこに含まれる識別子の組み合わせも使わずに、同じ役割の文章へ書き直してください。',
        'コードを言う代わりに、何のために変えるのか・何に合わせるのか・見るべき場所・考え方を言葉で示します。伏せ字(〇〇・***・…)は使いません。日本語で、元と同じくらいの長さにします。',
        levelStyle(level),
      ].join('\n'),
      leaks
        .map((t, i) =>
          [`id: f${i}`, `種類: ${t.label}`, `現在の文章: ${t.slot.get()}`, `先に言ってしまっているコード: ${leaking(t).join(' / ')}`, t.code ? `コード(___BLANK___が空欄):\n${t.code}` : '']
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n'),
      LEAK_FIX_SCHEMA,
      signal,
    );
    leaks.forEach((t, i) => {
      const fix = (res.fixes ?? []).find((f) => f.id === `f${i}`)?.text?.trim();
      if (fix && !/〇〇|○○|\*\*\*/.test(fix) && !t.answers.some((a) => revealsAnswer(fix, a, t.shown))) t.slot.set(fix);
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // 書き直しに失敗しても、下で必ず塞ぐ
  }
  for (const t of leaks) {
    if (leaking(t).length > 0) t.slot.set(t.tag ? 'コード理解' : withoutLeaks(t.slot.get(), t.answers, t.shown));
  }
}

// ---------- 利用者が主体の言い方にそろえる ----------

const VOICE_FIX_SCHEMA = { name: 'voice_fix', schema: LEAK_FIX_SCHEMA.schema } as const;

/**
 * 「実装しました」のように、作業を済ませたという報告の形になっている文章を、
 * 利用者がこれから実装する手順としての言い方に書き直させる。指示だけでは守られないので、機械的に見つけて直す。
 */
export async function rewriteReports(asker: Asker, level: LearnerLevel, slots: TextSlot[], signal: AbortSignal): Promise<void> {
  const targets = slots.filter((s) => soundsLikeReport(s.get()));
  if (targets.length === 0) return;
  try {
    const res = await asker.fresh<{ fixes?: Array<{ id: string; text: string }> }>(
      [
        'あなたはコードの理解を支援する文章の編集者です。以下の文章は、作業を済ませたという報告の形(「〜しました」「〜済みです」)で書かれています。',
        '利用者がこれから自分の判断で実装していく手順として読めるように、内容は変えずに言い方だけを書き直してください。',
        '「〜するために、〜を〜に変える」「〜する必要がある」「〜を追加する」のように、これから行うこととその理由を述べます。コードについて確かめた事実は現在形で述べます。',
        '各 id について書き直した文章を返します。意味・固有の名前・ファイル名:行はそのまま残します。',
        levelStyle(level),
      ].join('\n'),
      targets.map((s, i) => `id: v${i}\n現在の文章: ${s.get()}`).join('\n\n'),
      VOICE_FIX_SCHEMA,
      signal,
    );
    targets.forEach((slot, i) => {
      const fix = (res.fixes ?? []).find((f) => f.id === `v${i}`)?.text?.trim();
      if (fix && !soundsLikeReport(fix)) slot.set(fix);
    });
  } catch (error) {
    if (signal.aborted) throw error;
    // 書き直せなくても、内容は正しいのでそのまま使う
  }
}

/** 問いの中の、利用者に見せる文章の置き場所 */
export function itemSlots(item: QuizItem): TextSlot[] {
  const slots: TextSlot[] = [
    { get: () => item.task ?? '', set: (t) => (item.task = t) },
    { get: () => item.explanation, set: (t) => (item.explanation = t) },
  ];
  for (const b of item.blanks) {
    slots.push({ get: () => b.why ?? '', set: (t) => (b.why = t) });
    b.hints.forEach((_, k) => slots.push({ get: () => b.hints[k], set: (t) => (b.hints[k] = t) }));
    for (const c of b.choices ?? []) slots.push({ get: () => c.note, set: (t) => (c.note = t) });
  }
  return slots;
}
