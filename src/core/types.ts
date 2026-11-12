/** プロバイダ非依存の会話データ型。core/ 以下は vscode に依存しない。 */

export interface ToolCall {
  id: string;
  name: string;
  /** モデルが生成したJSON文字列のままの引数 */
  arguments: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
  /** プロバイダ固有の生データ (推論アイテム等)。同じプロバイダへ再送するときだけ使う。 */
  raw?: unknown[];
  providerId?: string;
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** 入力のうち、プロンプトキャッシュに当たったトークン数 (API が返した場合) */
  cachedTokens?: number;
}

export type JSONSchema = Record<string, unknown>;

/** 会話1本ぶんの状態。Agent は実行のたびに作り直し、状態はここに残す。 */
export interface ConversationState {
  messages: Message[];
  /** Read 済みファイル → 読んだ時点の mtime。Edit/Write の事前Readチェックに使う。 */
  fileState: Map<string, number>;
}

export function createConversationState(messages: Message[] = []): ConversationState {
  return { messages, fileState: new Map() };
}

export type AgentEvent =
  | { type: 'assistant_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'assistant_end'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; summary: string }
  | { type: 'tool_end'; id: string; output: string; isError: boolean }
  | { type: 'usage'; usage: Usage }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  | { type: 'done' };
