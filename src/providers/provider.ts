import type { AssistantMessage, JSONSchema, Message, Usage } from '../core/types';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  reasoningEffort?: string;
  /** 指定すると、応答をこのJSONスキーマに従うJSON文字列にする (エージェント本体のループでは使わない)。 */
  jsonSchema?: { name: string; schema: JSONSchema };
  signal?: AbortSignal;
}

export type StreamEvent = { type: 'text'; delta: string };

export interface CompletionResult {
  message: AssistantMessage;
  usage?: Usage;
}

/** LLMバックエンドの抽象。新しいAPI/ベンダーはこれを実装して ProviderRegistry に登録する。 */
export interface LLMProvider {
  readonly id: string;
  complete(req: CompletionRequest, onEvent: (e: StreamEvent) => void): Promise<CompletionResult>;
}

export interface ProviderOptions {
  apiKey: string;
  baseUrl: string;
}

export type ProviderFactory = (opts: ProviderOptions) => LLMProvider;

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>();

  register(id: string, factory: ProviderFactory): void {
    this.factories.set(id, factory);
  }

  create(id: string, opts: ProviderOptions): LLMProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`不明なプロバイダです: "${id}" (利用可能: ${[...this.factories.keys()].join(', ')})`);
    }
    return factory(opts);
  }
}
