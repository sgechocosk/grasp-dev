import type { JSONSchema, Message } from '../core/types';
import type { LLMProvider } from '../providers/provider';
import { parseJson } from './lib/text';

export interface Schema {
  name: string;
  schema: JSONSchema;
}

/** 理解のための問い合わせ。エージェント本体の会話 (state.messages) は読むだけで、書き換えない。 */
export interface Asker {
  /**
   * エージェントの会話の複製に質問を足して、JSONで答えさせる。
   * 作業した本人 (その会話) に聞くので、実際に読んだコードと判断の経緯を踏まえた答えになる。
   */
  fork<T>(question: string, schema: Schema, signal: AbortSignal): Promise<T>;
  /** 会話を引き継がない小さな依頼 */
  fresh<T>(system: string, user: string, schema: Schema, signal: AbortSignal): Promise<T>;
}

export interface AskerOptions {
  provider: LLMProvider;
  model: string;
  reasoningEffort?: string;
  /** エージェントと同じシステムプロンプト (会話の続きとして聞くため) */
  system: string;
  /** 呼び出し時点の会話 */
  messages: () => Message[];
}

export function createAsker(o: AskerOptions): Asker {
  const ask = async <T>(system: string, messages: Message[], schema: Schema, signal: AbortSignal): Promise<T> => {
    const res = await o.provider.complete(
      { model: o.model, system, messages, tools: [], reasoningEffort: o.reasoningEffort || undefined, jsonSchema: schema, signal },
      () => {},
    );
    return parseJson<T>(res.message.content);
  };
  return {
    fork: (question, schema, signal) => ask(o.system, [...o.messages(), { role: 'user', content: question }], schema, signal),
    fresh: (system, user, schema, signal) => ask(system, [{ role: 'user', content: user }], schema, signal),
  };
}
