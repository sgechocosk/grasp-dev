import { isInside, type Tool } from '../tools/tool';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export interface PermissionRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** 「常に許可」を選んだときに記憶される単位 (UI表示用にも使う) */
  key: string;
}

export interface PermissionDecision {
  behavior: 'allow' | 'always' | 'deny';
  /** 拒否時にモデルへ伝える理由 */
  message?: string;
}

export type AskPermission = (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;

/** ツール実行前の許可判定。UIからは ask を差し替えるだけでよい。 */
export class PermissionManager {
  private sessionAllowed = new Set<string>();

  constructor(private getMode: () => PermissionMode, private ask: AskPermission) {}

  reset(): void {
    this.sessionAllowed.clear();
  }

  async check(tool: Tool, input: unknown, toolCallId: string, cwd: string, signal: AbortSignal): Promise<PermissionDecision> {
    if (tool.permission === 'none') return { behavior: 'allow' };
    const mode = this.getMode();
    if (mode === 'bypassPermissions') return { behavior: 'allow' };
    if (mode === 'acceptEdits' && tool.permission === 'edit') {
      const target = tool.targetPath?.(input, { cwd });
      if (target && isInside(cwd, target)) return { behavior: 'allow' };
    }
    const key = tool.permissionKey?.(input) ?? tool.name;
    if (this.sessionAllowed.has(key)) return { behavior: 'allow' };

    const decision = await this.ask({ toolCallId, toolName: tool.name, input, key }, signal);
    if (decision.behavior === 'always') this.sessionAllowed.add(key);
    return decision;
  }
}
