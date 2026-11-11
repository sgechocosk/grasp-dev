import type { Message, ToolCall, Usage } from '../core/types';
import { ApiError, postSSE } from './http';
import type { CompletionRequest, CompletionResult, LLMProvider, ProviderOptions, StreamEvent } from './provider';

/**
 * OpenAI Responses API。store:false のステートレス運用で、推論アイテムは
 * encrypted_content ごと履歴に保持して次のリクエストへ引き継ぐ。
 */
export class OpenAIResponsesProvider implements LLMProvider {
  readonly id = 'openai-responses';
  /** モデルが encrypted reasoning に非対応だった場合に false へ落とす */
  private includeReasoning = true;

  constructor(private opts: ProviderOptions) {}

  async complete(req: CompletionRequest, onEvent: (e: StreamEvent) => void): Promise<CompletionResult> {
    try {
      return await this.request(req, onEvent);
    } catch (e) {
      if (this.includeReasoning && e instanceof ApiError && e.status === 400 && /encrypted|include/i.test(e.message)) {
        this.includeReasoning = false;
        return this.request(req, onEvent);
      }
      throw e;
    }
  }

  private async request(req: CompletionRequest, onEvent: (e: StreamEvent) => void): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: this.toInput(req.messages),
      stream: true,
      store: false,
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false,
      }));
      body.parallel_tool_calls = true;
    }
    if (this.includeReasoning) body.include = ['reasoning.encrypted_content'];
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };

    const raw: any[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';
    let usage: Usage | undefined;

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/responses`;
    for await (const ev of postSSE(url, this.opts.apiKey, body, req.signal)) {
      switch (ev.type) {
        case 'response.output_text.delta':
          onEvent({ type: 'text', delta: ev.delta });
          break;
        case 'response.output_item.done': {
          const item = ev.item;
          raw.push(item);
          if (item.type === 'function_call') {
            toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments ?? '' });
          } else if (item.type === 'message') {
            for (const part of item.content ?? []) {
              if (part.type === 'output_text') text += part.text;
              else if (part.type === 'refusal') text += part.refusal;
            }
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          if (ev.response?.usage) {
            usage = { inputTokens: ev.response.usage.input_tokens ?? 0, outputTokens: ev.response.usage.output_tokens ?? 0 };
          }
          break;
        case 'response.failed':
          throw new Error(ev.response?.error?.message ?? 'レスポンスの生成に失敗しました');
        case 'error':
          throw new Error(ev.message ?? ev.error?.message ?? 'APIストリームエラー');
      }
    }
    return { message: { role: 'assistant', content: text, toolCalls, raw, providerId: this.id }, usage };
  }

  private toInput(messages: Message[]): unknown[] {
    const input: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        input.push({ role: 'user', content: m.content });
      } else if (m.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      } else if (m.raw && m.providerId === this.id) {
        for (const item of m.raw as any[]) {
          if (item.type === 'reasoning') {
            // 暗号化内容のない推論アイテムは store:false では参照できないので送らない
            if (this.includeReasoning && item.encrypted_content) input.push(item);
          } else {
            const { id: _id, ...rest } = item;
            input.push(rest);
          }
        }
      } else {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const c of m.toolCalls) {
          input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
        }
      }
    }
    return input;
  }
}
