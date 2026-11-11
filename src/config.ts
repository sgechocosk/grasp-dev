import type { PermissionMode } from './core/permissions';

/**
 * 動作設定。ユーザーには公開せず固定値で運用する (UIから変更できるのはAPIキーのみ)。
 * 挙動を変えたい場合はここを書き換える。
 */
export const CONFIG = {
  /** モデルID */
  model: 'gpt-6-luna',
  /** プロバイダID: 'openai-responses' (Responses API) / 'openai-chat' (Chat Completions API) */
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  /** 推論モデルの reasoning effort。空ならモデルの既定値 */
  reasoningEffort: '',
  /** 権限モードの初期値 (入力欄下のセレクタで変更可)。default: 編集・コマンド実行の前に毎回確認する */
  permissionMode: 'default' as PermissionMode,
  /** 1回の指示でモデルを呼び出す最大回数 */
  maxTurns: 100,
  /** 入力トークンがこの値を超えたら会話履歴を自動要約する (0で無効) */
  autoCompactTokens: 200_000,
  /** システムプロンプトに追加する指示 */
  customInstructions: '',
};
