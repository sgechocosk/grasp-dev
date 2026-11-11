import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath, err, resolvePath, type Tool, type ToolContext, type ToolResult } from './tool';

/** 既存ファイルを書き換える前の共通チェック: Read 済みで、その後に外部変更がないこと。 */
async function checkFresh(file: string, ctx: ToolContext): Promise<ToolResult | undefined> {
  const stat = await fs.stat(file);
  const readAt = ctx.fileState.get(file);
  if (readAt === undefined) return err('File has not been read yet. Read it first before writing to it.');
  if (stat.mtimeMs > readAt) {
    return err('File has been modified since it was last read (by the user or another process). Read it again before writing to it.');
  }
  return undefined;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

async function writeAndTrack(file: string, content: string, ctx: ToolContext): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  ctx.fileState.set(file, (await fs.stat(file)).mtimeMs);
}

function snippet(content: string, index: number, length: number): string {
  const lines = content.split('\n');
  const startLine = content.slice(0, index).split('\n').length;
  const endLine = startLine + content.slice(index, index + length).split('\n').length - 1;
  const from = Math.max(1, startLine - 3);
  const to = Math.min(lines.length, endLine + 3);
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');
}

interface EditInput { file_path: string; old_string: string; new_string: string; replace_all?: boolean }

export const editTool: Tool<EditInput> = {
  name: 'Edit',
  description: `Performs an exact string replacement in a file.
- You must Read the file at least once in this conversation before editing it.
- old_string must match the file contents exactly, including whitespace and indentation. Do not include the line-number prefix from Read output.
- The edit fails if old_string is not found, or if it occurs more than once and replace_all is not set. Include more surrounding context to make it unique, or set replace_all to change every occurrence.
- To create a new file, use Write (or pass an empty old_string for a path that does not exist yet).
- Prefer editing existing files over creating new ones.`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify' },
      old_string: { type: 'string', description: 'The exact text to replace' },
      new_string: { type: 'string', description: 'The text to replace it with (must differ from old_string)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  permission: 'edit',
  summarize: (i, ctx) => displayPath(ctx.cwd, i.file_path),
  targetPath: (i, ctx) => resolvePath(ctx.cwd, i.file_path),

  async execute(input, ctx) {
    const file = resolvePath(ctx.cwd, input.file_path);
    let { old_string: oldStr, new_string: newStr } = input;
    if (oldStr === newStr) return err('old_string and new_string are identical; nothing to change.');

    if (!(await exists(file))) {
      if (oldStr !== '') return err(`File does not exist: ${file}`);
      await writeAndTrack(file, newStr, ctx);
      return { content: `Created new file ${file}.` };
    }
    const stale = await checkFresh(file, ctx);
    if (stale) return stale;
    if (oldStr === '') return err('old_string is empty but the file already exists. Provide the text to replace, or use Write to overwrite the file.');

    const content = await fs.readFile(file, 'utf8');
    // Read の出力は改行を LF に正規化しているので、CRLF ファイルでは検索文字列側を合わせる
    if (content.includes('\r\n') && !oldStr.includes('\r\n')) {
      oldStr = oldStr.replace(/\n/g, '\r\n');
      newStr = newStr.replace(/\r?\n/g, '\r\n');
    }
    const count = content.split(oldStr).length - 1;
    if (count === 0) return err('old_string was not found in the file. It must match exactly, including whitespace and indentation.');
    if (count > 1 && !input.replace_all) {
      return err(`old_string occurs ${count} times in the file. Add surrounding context to make it unique, or set replace_all to true.`);
    }
    const index = content.indexOf(oldStr);
    const updated = input.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
    await writeAndTrack(file, updated, ctx);

    const what = input.replace_all && count > 1 ? `${count} occurrences replaced` : 'updated';
    return { content: `The file ${file} has been ${what}. Snippet of the result:\n${snippet(updated, index, newStr.length)}` };
  },
};

interface WriteInput { file_path: string; content: string }

export const writeTool: Tool<WriteInput> = {
  name: 'Write',
  description: `Writes a file to the local filesystem, creating parent directories as needed.
- Overwrites the file if it already exists. An existing file must be Read first.
- Use this for new files or complete rewrites. For partial changes to an existing file use Edit instead.
- Do not create documentation files (README, *.md) unless the user asks for them.`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'The full content to write' },
    },
    required: ['file_path', 'content'],
  },
  permission: 'edit',
  summarize: (i, ctx) => displayPath(ctx.cwd, i.file_path),
  targetPath: (i, ctx) => resolvePath(ctx.cwd, i.file_path),

  async execute(input, ctx) {
    const file = resolvePath(ctx.cwd, input.file_path);
    const existed = await exists(file);
    if (existed) {
      if ((await fs.stat(file)).isDirectory()) return err(`${file} is a directory.`);
      const stale = await checkFresh(file, ctx);
      if (stale) return stale;
    }
    await writeAndTrack(file, input.content, ctx);
    return { content: existed ? `The file ${file} has been overwritten.` : `File created at ${file}.` };
  },
};
