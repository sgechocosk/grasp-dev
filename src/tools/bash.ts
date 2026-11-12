import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Tool } from './tool';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

interface Input { command: string; timeout?: number; description?: string }

/** ロケールから推定した、Windows の従来の文字コード (コンソールの出力が UTF-8 でないときに使う) */
function legacyEncoding(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (locale.startsWith('ja')) return 'shift_jis';
  if (locale.startsWith('ko')) return 'euc-kr';
  if (locale.startsWith('zh')) return /tw|hk|hant/.test(locale) ? 'big5' : 'gbk';
  return 'windows-1252';
}

/**
 * コマンドの出力を文字列にする。UTF-8 として読めなければ、Windows では従来の文字コード (日本語なら Shift_JIS) として読む。
 * cmd.exe や Java・Maven の出力は UTF-8 とは限らず、そのまま読むとエラーの文面が文字化けしてモデルが原因を読み取れない。
 */
export function decodeOutput(buf: Buffer, platform: string = process.platform, encoding: string = legacyEncoding()): string {
  try {
    // stream: true で、上限で切った末尾の不完全な文字を誤りにしない
    return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
  } catch {
    if (platform !== 'win32') return buf.toString('utf8');
  }
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

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
        windowsHide: true,
        env: { ...process.env, CI: process.env.CI ?? '1', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
      });

      // 文字の途中で区切られても化けないよう、バイト列のまま集めて最後に文字列にする
      const chunks: Buffer[] = [];
      let bytes = 0;
      let dropped = 0;
      const onData = (d: Buffer) => {
        const room = Math.max(0, MAX_OUTPUT * 4 - bytes);
        const part = d.length <= room ? d : d.subarray(0, room);
        if (part.length) chunks.push(part);
        bytes += part.length;
        dropped += d.length - part.length;
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
        let output = decodeOutput(Buffer.concat(chunks));
        if (output.length > MAX_OUTPUT) {
          dropped += output.length - MAX_OUTPUT;
          output = output.slice(0, MAX_OUTPUT);
        }
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
