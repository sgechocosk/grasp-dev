import type { PermissionDecision } from '../core/permissions';
import type { AgentEvent } from '../core/types';
import type { ToolCounts } from '../understand/recorder';
import type { WalkMessage } from '../understand/session';

/** 画面に表示する会話ログの1項目。Webview が再生成されたときの復元に使う (メモリ上のみ)。 */
export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  summary: string;
  output?: string;
  isError?: boolean;
  done: boolean;
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | ToolItem
  | { kind: 'info' | 'error'; text: string }
  /** たどる手順の1コマ */
  | { kind: 'walk'; message: WalkMessage }
  /** 手順をたどり終えてから開示する、作業の記録 */
  | { kind: 'record'; items: TranscriptItem[] };

export interface ViewState {
  hasKey: boolean;
  busy: boolean;
  permissionMode: string;
  hasWorkspace: boolean;
  /** 変更を取り置いて、たどり終えてから反映するか */
  understand: boolean;
  /** 利用者の経験レベル (beginner / intermediate / advanced) */
  level: string;
  /** 取り置いている変更があるか */
  holding: boolean;
}

export type HostMessage =
  | { type: 'init'; state: ViewState; transcript: TranscriptItem[] }
  | { type: 'state'; state: ViewState }
  | { type: 'toggle_settings' }
  | { type: 'user'; text: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'walk'; message: WalkMessage }
  | { type: 'record'; items: TranscriptItem[] }
  | { type: 'progress'; counts: ToolCounts }
  | { type: 'status'; text: string }
  | { type: 'permission_request'; toolCallId: string; key: string }
  | { type: 'permission_cancel'; toolCallId: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'setApiKey'; key: string }
  | { type: 'setMode'; mode: string }
  | { type: 'setUnderstand'; on: boolean }
  | { type: 'setLevel'; level: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'walk_answer'; index: number; blanks: number[]; next: number[] }
  | { type: 'walk_next' }
  | { type: 'walk_apply' }
  | { type: 'walk_discard' }
  | { type: 'permission_response'; toolCallId: string; decision: PermissionDecision };
