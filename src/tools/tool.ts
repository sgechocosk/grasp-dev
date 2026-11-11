import * as os from 'node:os';
import * as path from 'node:path';
import type { JSONSchema } from '../core/types';

export interface ToolContext {
  /** ワークスペースのルート。相対パスの基準であり Bash の作業ディレクトリ。 */
  cwd: string;
  signal: AbortSignal;
  fileState: Map<string, number>;
  /** ripgrep 実行ファイルのパス (VS Code 同梱のもの等)。未指定なら PATH 上の rg → JS実装の順にフォールバック。null は JS実装を強制。 */
  rgPath?: string | null;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * - none:    読み取り専用。確認不要で、同一ターン内の他の none ツールと並列実行される。
 * - edit:    ファイルを書き換える。
 * - execute: 任意コマンドを実行する。
 */
export type PermissionKind = 'none' | 'edit' | 'execute';

/** エージェントが使うツール。これを実装して ToolRegistry に登録すれば機能を追加できる。 */
export interface Tool<I = any> {
  name: string;
  description: string;
  parameters: JSONSchema;
  permission: PermissionKind;
  /** UIに出す1行の要約 */
  summarize?(input: I, ctx: Pick<ToolContext, 'cwd'>): string;
  /** 「このセッション中は常に許可」の単位。既定はツール名。 */
  permissionKey?(input: I): string;
  /** 書き込み先。acceptEdits モードでワークスペース外への書き込みを確認対象にするために使う。 */
  targetPath?(input: I, ctx: Pick<ToolContext, 'cwd'>): string;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

export function resolvePath(cwd: string, p: string): string {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

export function displayPath(cwd: string, p: string): string {
  const abs = resolvePath(cwd, p);
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const err = (content: string): ToolResult => ({ content, isError: true });
