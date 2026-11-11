import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { err, resolvePath, type Tool, type ToolContext } from './tool';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_WALK_FILES = 50_000;

/** rg の終了コード1は「一致なし」なのでエラー扱いしない。 */
function runRg(rg: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(rg, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error || (error as any).code === 1) resolve(stdout);
      else reject(new Error(stderr.trim() || error.message));
    });
  });
}

let pathRg: Promise<string | null> | undefined;

/** 使える ripgrep を返す。指定パス → PATH 上の rg → null (JS実装へフォールバック)。 */
export async function findRg(ctx: ToolContext): Promise<string | null> {
  if (ctx.rgPath !== undefined) return ctx.rgPath;
  pathRg ??= new Promise((resolve) => execFile('rg', ['--version'], (e) => resolve(e ? null : 'rg')));
  return pathRg;
}

async function walk(dir: string, out: string[], signal: AbortSignal): Promise<void> {
  if (out.length >= MAX_WALK_FILES || signal.aborted) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(full, out, signal);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

/** dir 以下のファイルを絶対パスで列挙する。rg があれば .gitignore を尊重する。 */
export async function listFiles(dir: string, ctx: ToolContext): Promise<string[]> {
  const rg = await findRg(ctx);
  if (rg) {
    const out = await runRg(rg, ['--files', '--hidden', '--glob', '!.git'], dir, ctx.signal);
    return out.split('\n').filter(Boolean).map((f) => path.resolve(dir, f));
  }
  const files: string[] = [];
  await walk(dir, files, ctx.signal);
  return files;
}

/** glob を正規表現に変換する。`/` を含まないパターンは gitignore と同じく任意の階層のファイル名に一致。 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth++; re += '(?:'; }
    else if (c === '}' && depth > 0) { depth--; re += ')'; }
    else if (c === ',' && depth > 0) re += '|';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close < 0) re += '\\[';
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
        re += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body) + ']';
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
  }
  const prefix = glob.includes('/') ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${re}$`);
}

const toPosix = (p: string) => (path.sep === '\\' ? p.replace(/\\/g, '/') : p);

interface GlobInput { pattern: string; path?: string }
const GLOB_LIMIT = 100;

export const globTool: Tool<GlobInput> = {
  name: 'Glob',
  description: `Fast file pattern matching that works with any codebase size.
- Supports glob patterns like "**/*.ts", "src/**/*.{js,jsx}" or "*.md" (a pattern without "/" matches at any depth).
- Returns matching absolute file paths sorted by modification time (most recent first), up to ${GLOB_LIMIT} results.
- Respects .gitignore. Use this to find files by name; use Grep to search file contents.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the workspace root.' },
    },
    required: ['pattern'],
  },
  permission: 'none',
  summarize: (i) => i.pattern + (i.path ? ` in ${i.path}` : ''),

  async execute(input, ctx) {
    const dir = resolvePath(ctx.cwd, input.path ?? '.');
    if (!(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) return err(`Directory does not exist: ${dir}`);
    const re = globToRegExp(input.pattern.replace(/^\.\//, ''));
    const matches = (await listFiles(dir, ctx)).filter((f) => re.test(toPosix(path.relative(dir, f))));
    if (!matches.length) return { content: 'No files found' };

    const withTime = await Promise.all(
      matches.map(async (f) => ({ f, t: await fs.stat(f).then((s) => s.mtimeMs, () => 0) })),
    );
    withTime.sort((a, b) => b.t - a.t);
    const shown = withTime.slice(0, GLOB_LIMIT).map((x) => x.f);
    const note = matches.length > GLOB_LIMIT
      ? `\n(Results truncated: showing ${GLOB_LIMIT} of ${matches.length}. Use a more specific pattern or path.)`
      : '';
    return { content: shown.join('\n') + note };
  },
};

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'files_with_matches' | 'content' | 'count';
  case_insensitive?: boolean;
  context?: number;
  multiline?: boolean;
  head_limit?: number;
}

export const grepTool: Tool<GrepInput> = {
  name: 'Grep',
  description: `Searches file contents with regular expressions (ripgrep).
- pattern is a Rust-style regex, e.g. "log.*Error" or "function\\s+\\w+". Escape literal braces and parentheses.
- Filter files with glob (e.g. "*.ts", "**/*.{ts,tsx}") or type (e.g. "js", "py", "rust").
- output_mode: "files_with_matches" (default) lists paths only; "content" shows matching lines with line numbers; "count" shows match counts per file.
- context adds lines before and after each match (content mode only). multiline lets patterns span lines.
- Results are limited to head_limit lines (default 250). Respects .gitignore.
- Always use this instead of running grep or rg through Bash.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search in. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Glob to filter files, e.g. "*.ts"' },
      type: { type: 'string', description: 'ripgrep file type, e.g. "js", "py", "go"' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
      context: { type: 'number', description: 'Lines of context around each match (content mode)' },
      multiline: { type: 'boolean', description: 'Allow patterns to match across lines' },
      head_limit: { type: 'number', description: 'Maximum number of output lines (default 250)' },
    },
    required: ['pattern'],
  },
  permission: 'none',
  summarize: (i) => `"${i.pattern}"` + (i.glob ? ` ${i.glob}` : '') + (i.path ? ` in ${i.path}` : ''),

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, input.path ?? '.');
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return err(`Path does not exist: ${target}`);
    const mode = input.output_mode ?? 'files_with_matches';
    const limit = Math.max(1, input.head_limit ?? 250);

    const rg = await findRg(ctx);
    let lines: string[];
    if (rg) {
      const args = ['--hidden', '--glob', '!.git', '--no-heading', '--color', 'never', '--max-columns', '500'];
      if (input.case_insensitive) args.push('-i');
      if (input.multiline) args.push('-U', '--multiline-dotall');
      if (input.glob) args.push('--glob', input.glob);
      if (input.type) args.push('--type', input.type);
      if (mode === 'files_with_matches') args.push('-l');
      else if (mode === 'count') args.push('-c', '--with-filename');
      else {
        args.push('-n', '--with-filename');
        if (input.context) args.push('-C', String(Math.floor(input.context)));
      }
      args.push('-e', input.pattern, target);
      try {
        lines = (await runRg(rg, args, ctx.cwd, ctx.signal)).split('\n').filter(Boolean);
      } catch (e) {
        return err(`grep failed: ${(e as Error).message}`);
      }
    } else {
      lines = await jsGrep(input, target, stat.isDirectory(), mode, ctx);
    }

    if (!lines.length) return { content: 'No matches found' };
    const note = lines.length > limit
      ? `\n(Output truncated: showing ${limit} of ${lines.length} lines. Narrow the search or raise head_limit.)`
      : '';
    return { content: lines.slice(0, limit).join('\n') + note };
  },
};

/** ripgrep が無い環境向けの簡易実装 (context と type は非対応)。 */
async function jsGrep(input: GrepInput, target: string, isDir: boolean, mode: string, ctx: ToolContext): Promise<string[]> {
  const re = new RegExp(input.pattern, (input.case_insensitive ? 'i' : '') + (input.multiline ? 'gs' : ''));
  const globRe = input.glob ? globToRegExp(input.glob) : null;
  const files = isDir ? await listFiles(target, { ...ctx, rgPath: null }) : [target];
  const out: string[] = [];
  for (const file of files) {
    if (ctx.signal.aborted) break;
    if (globRe && !globRe.test(toPosix(path.relative(isDir ? target : path.dirname(target), file)))) continue;
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf || buf.subarray(0, 8192).includes(0)) continue;
    const text = buf.toString('utf8');
    let matched: { n: number; line: string }[];
    if (input.multiline) {
      matched = [...text.matchAll(re)].map((m) => ({ n: text.slice(0, m.index).split('\n').length, line: m[0].split('\n')[0] }));
    } else {
      matched = [];
      text.split(/\r?\n/).forEach((line, i) => { if (re.test(line)) matched.push({ n: i + 1, line }); });
    }
    if (!matched.length) continue;
    if (mode === 'files_with_matches') out.push(file);
    else if (mode === 'count') out.push(`${file}:${matched.length}`);
    else for (const m of matched) out.push(`${file}:${m.n}:${m.line.slice(0, 500)}`);
  }
  return out;
}
