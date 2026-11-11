import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Tool } from './tool';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

interface Input { command: string; timeout?: number; description?: string }

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, 'SIGKILL');
  } catch { /* すでに終了している */ }
}

export const bashTool: Tool<Input> = {
  name: 'Bash',
  description: `Executes a shell command in the workspace root and returns its combined stdout and stderr.
- Use for builds, tests, git, package managers and other terminal operations.
- Do NOT use it to read, search or edit files: use Read, Grep, Glob, Edit and Write instead of cat, head, tail, grep, find, sed or echo redirection.
- Each call runs in a fresh shell; working directory changes and shell variables do not persist between calls. Use absolute paths or chain with &&.
- Commands are non-interactive (stdin is closed). Never run commands that wait for input, open an editor, or run forever (dev servers, watchers).
- timeout is in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}). Output longer than ${MAX_OUTPUT} characters is truncated.
- Quote paths that contain spaces. Avoid destructive commands unless the user explicitly asked for them.`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds' },
      description: { type: 'string', description: 'Short description of what the command does' },
    },
    required: ['command'],
  },
  permission: 'execute',
  summarize: (i) => i.command,
  permissionKey(i) {
    const cmd = i.command.trim();
    // 複合コマンドは前方一致で許可すると別コマンドを連結できてしまうので完全一致のみ
    if (/[;&|`\n<>]|\$\(/.test(cmd)) return `Bash(${cmd})`;
    const words = cmd.split(/\s+/);
    const prefix = words[1] && /^[a-z][\w-]*$/i.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
    return `Bash(${prefix} *)`;
  },

  execute(input, ctx) {
    const timeout = Math.min(Math.max(1000, input.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
    return new Promise((resolve) => {
      const unix = process.platform !== 'win32';
      const child = spawn(input.command, {
        cwd: ctx.cwd,
        shell: unix && existsSync('/bin/bash') ? '/bin/bash' : true,
        detached: unix,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: process.env.CI ?? '1', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
      });

      let output = '';
      let dropped = 0;
      const onData = (d: Buffer) => {
        const s = d.toString('utf8');
        const room = MAX_OUTPUT - output.length;
        if (room >= s.length) output += s;
        else { output += s.slice(0, Math.max(0, room)); dropped += s.length - Math.max(0, room); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      let reason: 'timeout' | 'abort' | undefined;
      const stop = (r: 'timeout' | 'abort') => { reason = r; if (child.pid) killTree(child.pid); };
      const timer = setTimeout(() => stop('timeout'), timeout);
      const onAbort = () => stop('abort');
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (tail: string, isError: boolean) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        if (dropped) output += `\n… [output truncated: ${dropped} more characters]`;
        const text = [output.trimEnd(), tail].filter(Boolean).join('\n');
        resolve({ content: text || '(no output)', isError });
      };
      child.on('error', (e) => finish(`Failed to start command: ${e.message}`, true));
      child.on('close', (code, sig) => {
        if (reason === 'timeout') finish(`Command timed out after ${timeout}ms and was killed.`, true);
        else if (reason === 'abort') finish('Command was interrupted by the user.', true);
        else if (code !== 0) finish(`Exit code: ${code ?? sig}`, true);
        else finish('', false);
      });
    });
  },
};
