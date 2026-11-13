import type { ToolCall, Usage } from '../core/types';
import { postSSE } from './http';
import type { CompletionRequest, CompletionResult, LLMProvider, ProviderOptions, StreamEvent } from './provider';

/** OpenAI Chat Completions API (および互換エンドポイント)。 */
export class OpenAIChatProvider implements LLMProvider {
  readonly id = 'openai-chat';

  constructor(private opts: ProviderOptions) {}

  async complete(req: CompletionRequest, onEvent: (e: StreamEvent) => void): Promise<CompletionResult> {
    const messages: unknown[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null };
        if (m.toolCalls.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
          }));
        }
        messages.push(msg);
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    if (req.jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } };
    }

    let text = '';
    let usage: Usage | undefined;
    const calls: ToolCall[] = [];

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    for await (const ev of postSSE(url, this.opts.apiKey, body, req.signal)) {
      if (ev.error) throw new Error(ev.error.message ?? 'APIストリームエラー');
      if (ev.usage) {
        usage = {
          inputTokens: ev.usage.prompt_tokens ?? 0,
          outputTokens: ev.usage.completion_tokens ?? 0,
          cachedTokens: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const delta = ev.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        onEvent({ type: 'text', delta: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
    return { message: { role: 'assistant', content: text, toolCalls: calls.filter(Boolean), providerId: this.id }, usage };
  }
}
