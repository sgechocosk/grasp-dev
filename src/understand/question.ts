import { withoutLeaks, withoutMentions } from './quizCommon';
import { levelStyle, type LearnerLevel } from './lib/level';
import { BLANK } from './lib/types';
import type { Asker } from './llm';

/**
 * 手順の途中で、利用者が画面の一部を選んでする質問 (用語の確認・仕組みの解説)。
 * - 手順の進み方には関わらない: 答えるだけで、手順の状態もエージェントの会話も書き換えない
 * - コードは変えない: 道具を持たない問い合わせで答え、変更を求められても説明だけにする
 * - 問いの答えは言わない: プロンプトで禁じたうえで、まだ答え合わせをしていない問いの答えを含む文を機械的に除く
 * - 画面の材料だけで答える (fresh)。作業の経緯を知らないと答えられないときだけ、作業した本人の会話に聞く (fork)
 */

/** 質問の元になったカード */
export type QuestionTarget =
  | { kind: 'start' }
  | { kind: 'step'; index: number }
  | { kind: 'recap' }
  | { kind: 'final' };

/** まだ答え合わせをしていない問いの答え (回答に出してはいけないもの) */
export interface QuestionSecrets {
  /** コード片・名前 */
  answers: string[];
  /** 答える前に明示している名前 (答えを特定する材料に数えない) */
  shown: Set<string>;
  /** ファイルのパス (影響の問いの答えになる場所) */
  paths: string[];
}

export interface QuestionInput {
  asker: Asker;
  level: LearnerLevel;
  /** 画面に出ている内容 (答えを含まない形) */
  material: string;
  selection: string;
  question: string;
  /** 質問したカードの、まだ答え合わせをしていない問いの答え */
  secrets: QuestionSecrets;
  /**
   * 手順全体の、まだ答え合わせをしていない問いの答え。
   * 作業した本人の会話にはこのあとのステップのコードも入っているので、そこに聞いたときは、これも除く
   */
  historySecrets: QuestionSecrets;
  signal: AbortSignal;
}

const MAX_SELECTION_CHARS = 500;
const MAX_QUESTION_CHARS = 1000;

/** 質問が空のとき (選んだ部分の意味を聞いたものとする) */
export const DEFAULT_QUESTION = '選んだ部分は何を指していますか? 意味を教えてください。';

/** 答えを除いたら何も残らなかったとき */
export const WITHHELD_MESSAGE =
  'この質問に答えると、このあと考えてもらうコードや場所が分かってしまうため、ここでは説明を控えます。問いに答えたあとで、もう一度聞いてください。';

const QUESTION_SCHEMA = {
  name: 'step_question',
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      needsHistory: { type: 'boolean' },
    },
    required: ['answer', 'needsHistory'],
    additionalProperties: false,
  },
} as const;

const HISTORY_SCHEMA = {
  name: 'step_question_history',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
} as const;

/** 回答の決まりごと (fresh と fork で共通) */
function rules(level: LearnerLevel): string {
  return [
    '利用者は、コードの変更(または仕組み)を1ステップずつたどっている途中で、画面の一部を選んで質問しています。',
    '- 選んだ部分が何を指すか(用語の意味・コードの書き方・処理の仕組み)を、示した画面の内容に基づいて説明する。',
    '- ここではコードを変更できない。変更・修正・追加を求められたら、説明だけを行い、変更の依頼は手順をたどり終えてから入力欄で送れることを1文で伝える。修正したコードは書かない。',
    '- 画面の問い(［1］のような空欄に入るコード、ほかに変更が必要になる場所、まとめの文章に入る部品)の答えは言わない。答えを尋ねられたら、考えるときにどこを見ればよいかだけを示す。',
    '- 材料に無いことを推測で断定しない。分からないことは分からないと言う。',
    '- 短く答える(2〜5文)。インラインコード(`name`)は使ってよい。見出し・箇条書きの多用・長いコードブロックは使わない。',
    levelStyle(level),
  ].join('\n');
}

function prompt(input: Pick<QuestionInput, 'material' | 'selection' | 'question'>): string {
  const selection = input.selection.trim().slice(0, MAX_SELECTION_CHARS);
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS) || DEFAULT_QUESTION;
  return ['# 画面に出ている内容', input.material.trim() || '(なし)', '', '# 利用者が選んだ部分', `「${selection}」`, '', '# 質問', question].join('\n');
}

/** 回答から、まだ答え合わせをしていない問いの答えを含む文を除く。何も残らなければ、説明を控える旨を返す */
export function guardAnswer(text: string, secrets: QuestionSecrets): string {
  let out = (text ?? '').trim();
  if (!out) return '';
  if (secrets.answers.length > 0) out = withoutLeaks(out, secrets.answers, secrets.shown);
  if (secrets.paths.length > 0) out = withoutMentions(out, secrets.paths);
  return out.trim() || WITHHELD_MESSAGE;
}

/** 質問に答える。画面の材料だけで答えられなければ、作業した本人の会話に聞き直す */
export async function answerQuestion(input: QuestionInput): Promise<string> {
  const { asker, level, signal } = input;
  const first = await asker.fresh<{ answer?: string; needsHistory?: boolean }>(
    [
      'あなたは、コードの変更をたどる利用者の質問に答える案内役です。答えに使えるのは、示した画面の内容と、一般的なプログラミングの知識だけです。',
      rules(level),
      '- needsHistory: 「なぜこう変えたのか」「なぜ別の方法にしなかったのか」「なぜここは変えなかったのか」のように、作業の経緯(調査・判断・試したこと)を知らないと答えられないときだけ true にする(answer は空でよい)。それ以外は false にして answer に答えを書く。',
    ].join('\n'),
    prompt(input),
    QUESTION_SCHEMA,
    signal,
  );
  let answer = String(first.answer ?? '').trim();
  let secrets = input.secrets;
  if (first.needsHistory || !answer) {
    secrets = mergeSecrets(input.secrets, input.historySecrets);
    const res = await asker.fork<{ answer?: string }>(
      [
        'ここからは、これまでの作業についての、利用者からの質問です。これ以上ツールは使いません。あなたの調査と判断の経緯を踏まえて答えてください。',
        rules(level),
        '',
        prompt(input),
      ].join('\n'),
      HISTORY_SCHEMA,
      signal,
    );
    answer = String(res.answer ?? '').trim() || answer;
  }
  if (!answer) throw new Error('回答を作れませんでした。');
  return guardAnswer(answer, secrets);
}

export function emptySecrets(): QuestionSecrets {
  return { answers: [], shown: new Set(), paths: [] };
}

export function mergeSecrets(...list: QuestionSecrets[]): QuestionSecrets {
  return {
    answers: [...new Set(list.flatMap((s) => s.answers))],
    shown: new Set(list.flatMap((s) => [...s.shown])),
    paths: [...new Set(list.flatMap((s) => s.paths))],
  };
}

/** 空欄つきのコードを、画面と同じ ［1］ の形にする */
export function blankedCode(code: string): string {
  return code.split(BLANK).map((part, i) => (i === 0 ? part : `［${i}］${part}`)).join('');
}
