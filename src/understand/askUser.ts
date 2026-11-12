import { err, type Tool } from '../tools/tool';

/** 実装の前に、利用者に決めてもらうこと */
export interface AskQuestion {
  question: string;
  /** なぜ決める必要があるか */
  why: string;
  options: Array<{ label: string; detail: string }>;
}

/** 質問を利用者に見せて、答え (質問ごとの文) を受け取る。中断されたら undefined */
export type AskHandler = (questions: AskQuestion[], signal: AbortSignal) => Promise<string[] | undefined>;

/**
 * 受け入れ条件が一つに決まらない依頼では、どう作るかをシステムが決めてしまわず、利用者に判断を委ねる。
 * 理解モードのときだけ、エージェントの道具に加える (下の指示とあわせて使う)。
 */
export const ASK_INSTRUCTIONS = `# Decisions that belong to the user
The user is the one developing this software; you carry out their decisions.
- After you have investigated enough to know the realistic options, and BEFORE changing any file, check whether the acceptance criteria of the request are uniquely determined.
- If there is more than one reasonable interpretation or design that would change observable behaviour, scope, data, or a public contract (function signatures, message types, setting keys, UI wording), call AskUser and wait for the answer. Do not pick one silently.
- Ask 1-3 questions. Each has 2-4 concrete options, the one you recommend first. Each option's detail says what would be built and what it touches (files, functions, behaviour).
- Do not ask about things you can determine from the code, or details with an obvious conventional default. If the request is already unambiguous, do not ask.
- Ask once per task; ask again only if the answer itself opens a new decision.
- Write the questions and options in the user's language, in plain words. Explain project-specific names when you mention them.`;

interface Input {
  questions: AskQuestion[];
}

export function createAskUserTool(ask: AskHandler): Tool<Input> {
  return {
    name: 'AskUser',
    description: `Asks the user to decide between options before you implement, and waits for the answer.
- Use it when the request's acceptance criteria are not uniquely determined: several reasonable interpretations or designs would lead to different behaviour, scope or contracts.
- 1-3 questions, each with 2-4 options (recommended option first). The user can also answer in their own words.
- Do not use it for things you can find out by reading the code.`,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'What needs to be decided, as one question' },
              why: { type: 'string', description: 'Why this must be decided before implementing' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short name of the option' },
                    detail: { type: 'string', description: 'What would be built and what it changes' },
                  },
                  required: ['label', 'detail'],
                },
              },
            },
            required: ['question', 'why', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    permission: 'none',
    summarize: (i) => (Array.isArray(i.questions) ? i.questions.map((q) => q?.question ?? '').join(' / ') : ''),

    async execute(input, ctx) {
      const questions = normalizeQuestions(input.questions);
      if (questions.length === 0) return err('questions must contain 1-3 questions, each with a question text and at least 2 options.');
      const answers = await ask(questions, ctx.signal);
      if (!answers) return err('The user did not answer (the request was interrupted).');
      return {
        content: [
          'The user decided:',
          ...questions.map((q, i) => `${i + 1}. ${q.question}\n   → ${answers[i]?.trim() || '(no answer; use your recommended option)'}`),
          'Implement according to these decisions.',
        ].join('\n'),
      };
    },
  };
}

/** モデルが返した質問を、見せられる形にそろえる (1〜3問、各2〜4択) */
export function normalizeQuestions(raw: unknown): AskQuestion[] {
  const out: AskQuestion[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    const question = String(q?.question ?? '').trim();
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({ label: String(o?.label ?? '').trim(), detail: String(o?.detail ?? '').trim() }))
      .filter((o: { label: string }) => o.label)
      .slice(0, 4);
    if (question && options.length >= 2) out.push({ question, why: String(q?.why ?? '').trim(), options });
  }
  return out.slice(0, 3);
}
