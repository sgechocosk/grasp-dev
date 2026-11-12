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
  /** 権限モードの初期値 (入力欄下のセレクタで変更可)。acceptEdits: コマンド実行の前だけ確認する (ワークスペース内の編集は常に確認なし) */
  permissionMode: 'acceptEdits' as PermissionMode,
  /** 変更を取り置いて、利用者が手順をたどり終えてから反映するか (設定パネルで変更可) */
  understand: true,
  /** 利用者の経験レベルの初期値: beginner / intermediate / advanced (設定パネルで変更可) */
  level: 'intermediate',
  /** 1回の指示でモデルを呼び出す最大回数 */
  maxTurns: 100,
  /** 入力トークンがこの値を超えたら会話履歴を自動要約する (0で無効) */
  autoCompactTokens: 200_000,
  /** システムプロンプトに追加する指示 */
  customInstructions: '',
};
