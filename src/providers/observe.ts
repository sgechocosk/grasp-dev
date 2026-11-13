import type { CompletionRequest, CompletionResult, LLMProvider, StreamEvent } from './provider';

/** これから行う API 呼び出しの概要 (テストモードの確認に使う) */
export interface CallInfo {
  /** 何のための呼び出しか */
  purpose: string;
  model: string;
  /** 入力トークン数の見積もり */
  estimatedTokens: number;
}

export interface ObserveOptions {
  /** API を呼ぶたびに1行: 「モデル 入力(キャッシュ) 出力」、失敗は「モデル エラー 理由」。送った内容は含めない */
  log: (line: string) => void;
  /** 呼び出しの前に確認する。false なら呼び出さずに中止する */
  confirm?: (info: CallInfo) => Promise<boolean>;
}

const PURPOSES: Record<string, string> = {
  change_interview: '変更の理由と受け入れ条件の整理',
  step_quiz: 'ステップごとの問いの作成',
  reading_quiz: '読んだコードからの問いの作成',
  leak_fix: '答えを含む説明文の書き直し',
  voice_fix: '説明文の言い回しの書き直し',
};

/** 大まかなトークン数 (ASCII は約3.5文字で1トークン、日本語などは1文字で1トークン) */
export function estimateTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x2e80) wide++;
  return Math.ceil((text.length - wide) / 3.5 + wide);
}

export function estimateRequestTokens(req: CompletionRequest): number {
  const messages = req.messages.map((m) => (m.role === 'assistant' ? m.content + m.toolCalls.map((c) => c.name + c.arguments).join('') : m.content)).join('\n');
  return estimateTokens(req.system) + estimateTokens(messages) + estimateTokens(JSON.stringify(req.tools)) + estimateTokens(JSON.stringify(req.jsonSchema ?? ''));
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * プロバイダを包んで、API 呼び出しを記録する (テストモードでは事前に確認する)。
 * 要求の中身には触れないので、モデルへ送る内容は包む前と変わらない。
 */
export function observeProvider(inner: LLMProvider, o: ObserveOptions): LLMProvider {
  let turn = 0;
  const purposeOf = (req: CompletionRequest): string => {
    if (req.jsonSchema) return PURPOSES[req.jsonSchema.name] ?? req.jsonSchema.name;
    if (req.tools.length === 0) return '会話履歴の要約';
    return `調査と実装(${++turn}回目の応答)`;
  };
  return {
    id: inner.id,
    async complete(req: CompletionRequest, onEvent: (e: StreamEvent) => void): Promise<CompletionResult> {
      const purpose = purposeOf(req);
      if (o.confirm && !(await o.confirm({ purpose, model: req.model, estimatedTokens: estimateRequestTokens(req) }))) {
        throw new Error('API の実行を取り消しました。');
      }
      try {
        const res = await inner.complete(req, onEvent);
        const u = res.usage;
        o.log(u ? `${req.model} 入力${fmt(u.inputTokens)}(キャッシュ${fmt(u.cachedTokens ?? 0)}) 出力${fmt(u.outputTokens)}` : `${req.model} (トークン数の報告なし)`);
        return res;
      } catch (e) {
        if (!req.signal?.aborted) o.log(`${req.model} エラー ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        throw e;
      }
    },
  };
}
