import type { PermissionDecision } from '../core/permissions';
import type { AgentEvent } from '../core/types';

/** 画面に表示する会話ログの1項目。Webview が再生成されたときの復元に使う (メモリ上のみ)。 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; summary: string; output?: string; isError?: boolean; done: boolean }
  | { kind: 'info' | 'error'; text: string };

export interface ViewState {
  hasKey: boolean;
  busy: boolean;
  permissionMode: string;
  hasWorkspace: boolean;
}

export type HostMessage =
  | { type: 'init'; state: ViewState; transcript: TranscriptItem[] }
  | { type: 'state'; state: ViewState }
  | { type: 'toggle_settings' }
  | { type: 'user'; text: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'permission_request'; toolCallId: string; key: string }
  | { type: 'permission_cancel'; toolCallId: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'setApiKey'; key: string }
  | { type: 'setMode'; mode: string }
  | { type: 'openFile'; path: string }
  | { type: 'permission_response'; toolCallId: string; decision: PermissionDecision };
