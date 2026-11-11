import type { LLMProvider } from '../providers/provider';
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '../tools/tool';
import type { PermissionManager } from './permissions';
import { buildSystemPrompt } from './systemPrompt';
import type { AgentEvent, ConversationState, ToolCall, ToolMessage } from './types';

const MAX_TOOL_OUTPUT = 30_000;

const COMPACT_PROMPT = `The conversation is about to be compacted. Write a summary that will replace the entire history above, so that you can continue the work with no other context. Include:
1. The user's requests and intent, in order, quoting important instructions verbatim.
2. What you learned about the codebase: relevant files (absolute paths), key functions, and how they fit together.
3. Every change made so far (file and what changed) and commands run with their notable results.
4. Errors hit and how they were resolved; any user feedback or corrections.
5. The current state of the work and the exact next steps still to do.
Be specific and complete. Do not call tools; reply with the summary only.`;

export interface AgentOptions {
  provider: LLMProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  state: ConversationState;
  cwd: string;
  model: string;
  reasoningEffort?: string;
  customInstructions?: string;
  maxTurns?: number;
  /** 入力トークンがこの値を超えたら履歴を要約する。0/未指定で無効。 */
  autoCompactTokens?: number;
  rgPath?: string;
  emit: (event: AgentEvent) => void;
}

/**
 * エージェントループ本体: モデル呼び出し → ツール実行 → 結果を履歴に追加、を
 * モデルがツールを呼ばなくなるまで繰り返す。
 */
export class Agent {
  constructor(private o: AgentOptions) {}

  /** modelText はモデルに渡す文面 (エディタの文脈などを付加したもの)。 */
  async run(modelText: string, signal: AbortSignal): Promise<void> {
    const { state, emit, provider } = this.o;
    state.messages.push({ role: 'user', content: modelText });
    try {
      const system = await buildSystemPrompt(this.o);
      const maxTurns = this.o.maxTurns ?? 100;
      for (let turn = 0; ; turn++) {
        if (turn >= maxTurns) {
          emit({ type: 'info', message: `最大ターン数 (${maxTurns}) に達したため停止しました。続けるには指示を送ってください。` });
          break;
        }
        signal.throwIfAborted();
        emit({ type: 'assistant_start' });
        const res = await provider.complete(
          {
            model: this.o.model,
            system,
            messages: state.messages,
            tools: this.o.tools.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            reasoningEffort: this.o.reasoningEffort || undefined,
            signal,
          },
          (e) => emit({ type: 'text_delta', delta: e.delta }),
        );
        state.messages.push(res.message);
        emit({ type: 'assistant_end', text: res.message.content });
        if (res.usage) emit({ type: 'usage', usage: res.usage });

        if (!res.message.toolCalls.length) break;
        await this.runTools(res.message.toolCalls, signal);
        signal.throwIfAborted();

        if (this.o.autoCompactTokens && res.usage && res.usage.inputTokens > this.o.autoCompactTokens) {
          await this.compact(system, signal);
        }
      }
    } catch (e) {
      if (signal.aborted) emit({ type: 'aborted' });
      else emit({ type: 'error', message: (e as Error)?.message ?? String(e) });
    } finally {
      emit({ type: 'done' });
    }
  }

  /**
   * ツール呼び出しを実行して結果を履歴へ追加する。読み取り専用のみのバッチは並列、
   * それ以外は順次。中断されても全呼び出しに結果を残し、履歴の整合性を保つ。
   */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    const results: (ToolResult | undefined)[] = calls.map(() => undefined);
    const runOne = async (i: number) => { results[i] = await this.runTool(calls[i], signal); };
    try {
      const allReadOnly = calls.every((c) => this.o.tools.get(c.name)?.permission === 'none');
      if (allReadOnly) await Promise.all(calls.map((_, i) => runOne(i)));
      else for (let i = 0; i < calls.length && !signal.aborted; i++) await runOne(i);
    } finally {
      calls.forEach((call, i) => {
        const r = results[i] ?? { content: 'Tool call was interrupted by the user before it ran.', isError: true };
        if (!results[i]) this.o.emit({ type: 'tool_end', id: call.id, output: r.content, isError: true });
        const msg: ToolMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError };
        this.o.state.messages.push(msg);
      });
    }
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const { emit, cwd } = this.o;
    const tool = this.o.tools.get(call.name);
    let input: any = {};
    let parseError: string | undefined;
    try {
      input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch (e) {
      parseError = `Invalid JSON in tool arguments: ${(e as Error).message}`;
    }

    emit({ type: 'tool_start', id: call.id, name: call.name, input, summary: safeSummary(tool, input, cwd) });
    const result = await this.execute(tool, call, input, parseError, signal);
    if (result.content.length > MAX_TOOL_OUTPUT) {
      result.content = result.content.slice(0, MAX_TOOL_OUTPUT) + `\n… [truncated: ${result.content.length - MAX_TOOL_OUTPUT} more characters]`;
    }
    emit({ type: 'tool_end', id: call.id, output: result.content, isError: !!result.isError });
    return result;
  }

  private async execute(tool: Tool | undefined, call: ToolCall, input: any, parseError: string | undefined, signal: AbortSignal): Promise<ToolResult> {
    if (!tool) {
      return { content: `Unknown tool: ${call.name}. Available tools: ${this.o.tools.list().map((t) => t.name).join(', ')}`, isError: true };
    }
    if (parseError) return { content: parseError, isError: true };
    if (typeof input !== 'object' || input === null) return { content: 'Tool arguments must be a JSON object.', isError: true };
    const missing = ((tool.parameters.required as string[] | undefined) ?? []).filter((k) => input[k] === undefined);
    if (missing.length) return { content: `Missing required parameter(s): ${missing.join(', ')}`, isError: true };

    try {
      const decision = await this.o.permissions.check(tool, input, call.id, this.o.cwd, signal);
      if (decision.behavior === 'deny') {
        const why = decision.message ? ` The user said: ${decision.message}` : '';
        return { content: `The user denied this tool call, so it was not executed.${why} Do not retry it as is.`, isError: true };
      }
      const ctx: ToolContext = { cwd: this.o.cwd, signal, fileState: this.o.state.fileState, rgPath: this.o.rgPath };
      return await tool.execute(input, ctx);
    } catch (e) {
      if (signal.aborted) return { content: 'Tool call was interrupted by the user.', isError: true };
      return { content: `Tool failed: ${(e as Error)?.message ?? String(e)}`, isError: true };
    }
  }

  /** 履歴をモデル自身に要約させ、要約1件に置き換える。 */
  private async compact(system: string, signal: AbortSignal): Promise<void> {
    const { state, provider, emit } = this.o;
    const res = await provider.complete(
      { model: this.o.model, system, messages: [...state.messages, { role: 'user', content: COMPACT_PROMPT }], tools: [], signal },
      () => {},
    );
    if (!res.message.content.trim()) return;
    state.messages = [{
      role: 'user',
      content: `This session continues from an earlier conversation that was compacted to save context. Summary of everything so far:\n\n${res.message.content}\n\nContinue the work from where it left off without asking the user to repeat anything. Files must be Read again before editing.`,
    }];
    state.fileState.clear();
    emit({ type: 'info', message: 'コンテキストが長くなったため、会話履歴を要約しました。' });
  }
}

function safeSummary(tool: Tool | undefined, input: unknown, cwd: string): string {
  try {
    return tool?.summarize?.(input, { cwd }) ?? '';
  } catch {
    return '';
  }
}
