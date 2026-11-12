import { levelStyle, soundsLikeReport, type LearnerLevel } from './lib/level';
import { maskAnswers, revealsAnswer } from './lib/leak';
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

export const REFS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { path: STRING, line: INTEGER, note: STRING },
    required: ['path', 'line', 'note'],
    additionalProperties: false,
  },
} as const;

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
export function distractorRules(): string[] {
  return [
    '【選択肢 distractors(誤答を3つ)】',
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

type LeakField = 'goal' | 'task' | 'refNote' | 'concept' | 'hint0' | 'hint1' | 'clueNote';

interface Leak {
  id: string;
  field: LeakField;
  text: string;
  answers: string[];
  item?: number;
  blank?: number;
  ref?: number;
}

/** 答える前に見える文章のうち、答えを漏らしているものを列挙する */
export function findLeaks(goal: string, items: QuizItem[]): Leak[] {
  const leaks: Leak[] = [];
  const answers = items.flatMap((it) => it.blanks.map((b) => b.answer));
  const shown = new Set(items.flatMap((it) => (it.newNames ?? []).map((n) => n.name)));
  const check = (leak: Omit<Leak, 'answers'>): void => {
    const hit = answers.filter((a) => revealsAnswer(leak.text, a, shown));
    if (hit.length > 0) leaks.push({ ...leak, answers: hit });
  };
  check({ id: 'goal', field: 'goal', text: goal });
  items.forEach((item, i) => {
    check({ id: `${i}.task`, field: 'task', text: item.task ?? '', item: i });
    (item.refs ?? []).forEach((r, k) => check({ id: `${i}.ref${k}`, field: 'refNote', text: r.note, item: i, ref: k }));
    item.blanks.forEach((b, k) => {
      check({ id: `${i}.${k}.concept`, field: 'concept', text: b.concept, item: i, blank: k });
      b.hints.forEach((h, level) => check({ id: `${i}.${k}.hint${level}`, field: `hint${level}` as LeakField, text: h, item: i, blank: k }));
      if (b.clue) check({ id: `${i}.${k}.clue`, field: 'clueNote', text: b.clue.note, item: i, blank: k });
    });
  });
  return leaks;
}

function applyLeakFix(goal: { value: string }, items: QuizItem[], leak: Leak, text: string): void {
  const item = leak.item !== undefined ? items[leak.item] : undefined;
  const blank = item && leak.blank !== undefined ? item.blanks[leak.blank] : undefined;
  if (leak.field === 'goal') goal.value = text;
  else if (leak.field === 'task') {
    if (item) item.task = text;
  } else if (leak.field === 'refNote') {
    if (item?.refs && leak.ref !== undefined && item.refs[leak.ref]) item.refs[leak.ref].note = text;
  } else if (leak.field === 'concept') {
    if (blank) blank.concept = text;
  } else if (leak.field === 'clueNote') {
    if (blank?.clue) blank.clue.note = text;
  } else if (blank) blank.hints[Number(leak.field.slice(4))] = text;
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

const FIELD_LABEL: Record<LeakField, string> = {
  goal: '目標',
  task: '課題文',
  refNote: '参考コードの説明',
  concept: '概念タグ(短い名詞)',
  hint0: '手がかり1(どんな概念・仕組みが関わるか)',
  hint1: '手がかり2(どこを見てどう考えるか)',
  clueNote: '手がかりの場所の説明',
};

/**
 * 答える前に見える文章の答え漏れを LLM に書き直させ、それでも残るものは伏せ字にする。
 * 「答えを書かない」という指示だけでは守られないので、機械的に確かめて必ず塞ぐ。
 */
export async function removeAnswerLeaks(
  asker: Asker,
  level: LearnerLevel,
  quiz: { goal: string; items: QuizItem[] },
  signal: AbortSignal,
): Promise<void> {
  const goal = { value: quiz.goal };
  let leaks = findLeaks(goal.value, quiz.items);
  if (leaks.length > 0) {
    try {
      const res = await asker.fresh<{ fixes?: Array<{ id: string; text: string }> }>(
        [
          'あなたはコードの理解を支援する文章の編集者です。以下の文章は、答える前に利用者へ見せるのに、答え(空欄に入るコード)を漏らしています。',
          '各 id について、答えのコード片も、答えに含まれる識別子の組み合わせも使わずに、同じ役割の文章へ書き直してください。',
          '答えを言う代わりに、関わる概念・見るべき場所・考え方・答えの形(言葉で)を示します。日本語で、元と同じくらいの長さにします。',
          levelStyle(level),
        ].join('\n'),
        leaks
          .map((l) => {
            const item = l.item !== undefined ? quiz.items[l.item] : undefined;
            return [
              `id: ${l.id}`,
              `種類: ${FIELD_LABEL[l.field]}`,
              `現在の文章: ${l.text}`,
              `漏れている答え: ${l.answers.join(' / ')}`,
              item ? `コード(___BLANK___が空欄):\n${item.quizCode}` : '',
            ]
              .filter(Boolean)
              .join('\n');
          })
          .join('\n\n'),
        LEAK_FIX_SCHEMA,
        signal,
      );
      for (const leak of leaks) {
        const fix = (res.fixes ?? []).find((f) => f.id === leak.id)?.text?.trim();
        if (fix && !leak.answers.some((a) => revealsAnswer(fix, a))) applyLeakFix(goal, quiz.items, leak, fix);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // 書き直しに失敗しても、下の伏せ字で必ず塞ぐ
    }
    leaks = findLeaks(goal.value, quiz.items);
    for (const leak of leaks) {
      applyLeakFix(goal, quiz.items, leak, leak.field === 'concept' ? 'コード理解' : maskAnswers(leak.text, leak.answers));
    }
  }
  quiz.goal = goal.value;
}

// ---------- 利用者が主体の言い方にそろえる ----------

/** 文章の置き場所 (読む・書き戻す) */
export interface TextSlot {
  get: () => string;
  set: (text: string) => void;
}

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
