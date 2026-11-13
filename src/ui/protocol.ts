import type { PermissionDecision } from '../core/permissions';
import type { AgentEvent } from '../core/types';
import type { AskQuestion } from '../understand/askUser';
import type { WalkMessage } from '../understand/session';

/** 画面に表示する会話ログの1項目。Webview が再生成されたときの復元に使う (メモリ上のみ)。 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'info' | 'error'; text: string }
  /** 実装の前に利用者へ尋ねたこと (answers があれば回答済み) */
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] }
  /** たどる手順の1コマ */
  | { kind: 'walk'; message: WalkMessage };

export interface ViewState {
  hasKey: boolean;
  busy: boolean;
  permissionMode: string;
  hasWorkspace: boolean;
  /** 利用者の経験レベル (beginner / intermediate / advanced) */
  level: string;
  /** テストモード (API を呼ぶ前の確認と、画面の保存ボタン) */
  testMode: boolean;
}

/** 許可の確認 (入力欄の上に出す) */
export interface PermissionView {
  toolCallId: string;
  /** 「常に許可」で記憶される単位 */
  key: string;
  /** 何の確認か */
  title: string;
  /** 実行するコマンド・書き込み先など */
  detail: string;
}

export type HostMessage =
  | { type: 'init'; state: ViewState; transcript: TranscriptItem[] }
  | { type: 'state'; state: ViewState }
  | { type: 'toggle_settings' }
  | { type: 'user'; text: string }
  /** 会話に出すもの: 応答の文章・お知らせ・エラー・トークン数。ツールの呼び出しは送らない */
  | { type: 'event'; event: AgentEvent }
  | { type: 'walk'; message: WalkMessage }
  /** いま行っている作業 (入力欄の上に1行で出す)。空なら既定の表示に戻す */
  | { type: 'activity'; text: string }
  | { type: 'ask'; id: string; questions: AskQuestion[] }
  | { type: 'ask_cancel'; id: string }
  | ({ type: 'permission_request' } & PermissionView)
  | { type: 'permission_cancel'; toolCallId: string }
  /** 画面の保存: スタイルシートの本文を渡して、Webview に画像を作らせる */
  | { type: 'capture'; css: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'setApiKey'; key: string }
  | { type: 'setMode'; mode: string }
  | { type: 'setLevel'; level: string }
  | { type: 'setTestMode'; on: boolean }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'walk_answer'; index: number; blanks: number[]; next: number[] }
  | { type: 'walk_next' }
  | { type: 'ask_response'; id: string; answers: string[] }
  | { type: 'walk_apply' }
  | { type: 'walk_discard' }
  | { type: 'permission_response'; toolCallId: string; decision: PermissionDecision }
  /** 画面の保存を始める / 作った画像 (PNG の data URL) を渡す */
  | { type: 'capture_request' }
  | { type: 'capture_result'; dataUrl?: string; error?: string };
