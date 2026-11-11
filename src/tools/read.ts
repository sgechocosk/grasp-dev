import * as fs from 'node:fs/promises';
import { displayPath, err, resolvePath, type Tool } from './tool';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 20 * 1024 * 1024;

interface Input { file_path: string; offset?: number; limit?: number }

export const readTool: Tool<Input> = {
  name: 'Read',
  description: `Reads a text file from the local filesystem.
- file_path should be an absolute path (relative paths resolve against the workspace root).
- By default reads up to ${MAX_LINES} lines from the start of the file. For long files pass offset (1-based line number) and limit to read a specific range.
- Output is in \`cat -n\` format: each line is prefixed with its line number and a tab. The prefix is not part of the file.
- Lines longer than ${MAX_LINE_LENGTH} characters are truncated.
- This tool reads files only, not directories. To list a directory use Glob or \`ls\` via Bash.
- You must Read a file before you Edit or overwrite it.`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
  permission: 'none',
  summarize: (i, ctx) => displayPath(ctx.cwd, i.file_path) + (i.offset ? `:${i.offset}` : ''),

  async execute(input, ctx) {
    const file = resolvePath(ctx.cwd, input.file_path);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return err(`File does not exist: ${file}`);
    }
    if (stat.isDirectory()) return err(`${file} is a directory, not a file. Use Glob or \`ls\` via Bash to list it.`);
    if (stat.size > MAX_BYTES) return err(`File is too large to read (${stat.size} bytes). Use Grep to search it instead.`);

    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return err(`${file} appears to be a binary file and cannot be read as text.`);
    ctx.fileState.set(file, stat.mtimeMs);

    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (buf.length === 0) return { content: '(The file exists but is empty.)' };

    const start = Math.max(1, Math.floor(input.offset ?? 1));
    const limit = Math.max(1, Math.floor(input.limit ?? MAX_LINES));
    if (start > lines.length) return err(`offset ${start} is beyond the end of the file (${lines.length} lines).`);
    const slice = lines.slice(start - 1, start - 1 + limit);
    let out = slice
      .map((l, i) => {
        const text = l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '… [line truncated]' : l;
        return `${String(start + i).padStart(6)}\t${text}`;
      })
      .join('\n');
    const end = start + slice.length - 1;
    if (start > 1 || end < lines.length) {
      out += `\n\n(Showing lines ${start}-${end} of ${lines.length}. Use offset/limit to read other parts.)`;
    }
    return { content: out };
  },
};
