import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { bashTool, decodeOutput } from '../src/tools/bash';
import { shellNote } from '../src/core/systemPrompt';
import { editTool, writeTool } from '../src/tools/edit';
import { readTool } from '../src/tools/read';
import { globToRegExp, globTool, grepTool } from '../src/tools/search';
import type { ToolContext } from '../src/tools/tool';

function setup(): ToolContext {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grasp-test-'));
  fs.mkdirSync(path.join(cwd, 'src/sub'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'export const a = 1;\nexport function hello() {}\n');
  fs.writeFileSync(path.join(cwd, 'src/sub/b.ts'), 'import { a } from "../a";\nconsole.log(a);\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# readme\nhello world\n');
  return { cwd, signal: new AbortController().signal, fileState: new Map() };
}

test('Read: cat -n 形式と範囲指定', async () => {
  const ctx = setup();
  const all = await readTool.execute({ file_path: 'src/a.ts' }, ctx);
  assert.equal(all.content, '     1\texport const a = 1;\n     2\texport function hello() {}');
  const part = await readTool.execute({ file_path: 'src/a.ts', offset: 2, limit: 1 }, ctx);
  assert.match(part.content, /^ {5}2\texport function hello/);
  assert.match(part.content, /Showing lines 2-2 of 2/);
  assert.ok((await readTool.execute({ file_path: 'nope.ts' }, ctx)).isError);
  assert.ok((await readTool.execute({ file_path: 'src' }, ctx)).isError);
});

test('Edit: 事前Read必須・一意性・replace_all・外部変更検知', async () => {
  const ctx = setup();
  const file = path.join(ctx.cwd, 'src/a.ts');
  const unread = await editTool.execute({ file_path: file, old_string: 'a = 1', new_string: 'a = 2' }, ctx);
  assert.match(unread.content, /has not been read/);

  await readTool.execute({ file_path: file }, ctx);
  const ok = await editTool.execute({ file_path: file, old_string: 'a = 1', new_string: 'a = 2' }, ctx);
  assert.ok(!ok.isError, ok.content);
  assert.match(fs.readFileSync(file, 'utf8'), /a = 2/);

  const dup = await editTool.execute({ file_path: file, old_string: 'export', new_string: 'EXPORT' }, ctx);
  assert.match(dup.content, /occurs 2 times/);
  const all = await editTool.execute({ file_path: file, old_string: 'export', new_string: 'EXPORT', replace_all: true }, ctx);
  assert.ok(!all.isError);
  assert.equal(fs.readFileSync(file, 'utf8').match(/EXPORT/g)?.length, 2);

  const missing = await editTool.execute({ file_path: file, old_string: 'zzz', new_string: 'y' }, ctx);
  assert.match(missing.content, /not found/);

  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const stale = await editTool.execute({ file_path: file, old_string: 'a = 2', new_string: 'a = 3' }, ctx);
  assert.match(stale.content, /modified since/);
});

test('Edit: CRLF ファイルでも LF の old_string で置換でき改行を保つ', async () => {
  const ctx = setup();
  const file = path.join(ctx.cwd, 'crlf.txt');
  fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n');
  await readTool.execute({ file_path: file }, ctx);
  const r = await editTool.execute({ file_path: file, old_string: 'one\ntwo', new_string: 'ONE\nTWO' }, ctx);
  assert.ok(!r.isError, r.content);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ONE\r\nTWO\r\nthree\r\n');
});

test('Write: 新規作成と、既存ファイルの上書きにはReadが必要', async () => {
  const ctx = setup();
  const created = await writeTool.execute({ file_path: 'new/dir/x.txt', content: 'hi' }, ctx);
  assert.ok(!created.isError);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'new/dir/x.txt'), 'utf8'), 'hi');
  // 自分で書いたファイルは続けて上書きできる
  assert.ok(!(await writeTool.execute({ file_path: 'new/dir/x.txt', content: 'hi2' }, ctx)).isError);
  assert.ok((await writeTool.execute({ file_path: 'README.md', content: 'x' }, ctx)).isError);
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('**/*.ts').test('a.ts'));
  assert.ok(globToRegExp('**/*.ts').test('src/sub/b.ts'));
  assert.ok(globToRegExp('*.ts').test('src/sub/b.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/sub/b.ts'));
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y.tsx'));
  assert.ok(!globToRegExp('**/*.ts').test('a.tsx'));
  assert.ok(globToRegExp('[ab].ts').test('a.ts'));
});

for (const mode of ['ripgrep', 'js-fallback']) {
  test(`Glob / Grep (${mode})`, async () => {
    const ctx = setup();
    if (mode === 'js-fallback') ctx.rgPath = null;
    const g = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    assert.deepEqual(g.content.split('\n').sort(), [path.join(ctx.cwd, 'src/a.ts'), path.join(ctx.cwd, 'src/sub/b.ts')]);
    assert.equal((await globTool.execute({ pattern: '*.py' }, ctx)).content, 'No files found');

    const files = await grepTool.execute({ pattern: 'hello' }, ctx);
    assert.deepEqual(files.content.split('\n').sort(), [path.join(ctx.cwd, 'README.md'), path.join(ctx.cwd, 'src/a.ts')]);
    const content = await grepTool.execute({ pattern: 'function\\s+\\w+', output_mode: 'content', glob: '*.ts' }, ctx);
    assert.equal(content.content, `${path.join(ctx.cwd, 'src/a.ts')}:2:export function hello() {}`);
    const count = await grepTool.execute({ pattern: 'HELLO', case_insensitive: true, output_mode: 'count', path: 'src' }, ctx);
    assert.equal(count.content, `${path.join(ctx.cwd, 'src/a.ts')}:1`);
    assert.equal((await grepTool.execute({ pattern: 'zzzz' }, ctx)).content, 'No matches found');
  });
}

test('Bash: 出力・終了コード・タイムアウト・許可キー', async () => {
  const ctx = setup();
  assert.equal((await bashTool.execute({ command: 'echo hi && pwd' }, ctx)).content, `hi\n${fs.realpathSync(ctx.cwd)}`);
  const fail = await bashTool.execute({ command: 'echo oops >&2; exit 3' }, ctx);
  assert.ok(fail.isError);
  assert.equal(fail.content, 'oops\nExit code: 3');
  const slow = await bashTool.execute({ command: 'sleep 30', timeout: 1000 }, ctx);
  assert.match(slow.content, /timed out/);

  assert.equal(bashTool.permissionKey!({ command: 'npm test -- --watch' }), 'Bash(npm test *)');
  assert.equal(bashTool.permissionKey!({ command: 'ls -la' }), 'Bash(ls *)');
  assert.equal(bashTool.permissionKey!({ command: 'git status && rm -rf /' }), 'Bash(git status && rm -rf /)');
});

test('Bash: Windows の従来の文字コードの出力を読める。Windows ではシェルの書き方を伝える', () => {
  // 「エラー: JAVA_HOME が見つかりません」を Shift_JIS にしたバイト列
  const sjis = Buffer.from('83478389815b3a204a4156415f484f4d452082aa8ca982c282a982e882dc82b982f1', 'hex');
  assert.equal(decodeOutput(sjis, 'win32', 'shift_jis'), 'エラー: JAVA_HOME が見つかりません');
  assert.equal(decodeOutput(Buffer.from('ビルド成功', 'utf8'), 'win32', 'shift_jis'), 'ビルド成功');
  // 上限で切れて末尾の文字が不完全でも、UTF-8 として読む
  assert.equal(decodeOutput(Buffer.from('成功', 'utf8').subarray(0, 4), 'win32', 'shift_jis'), '成');
  assert.equal(shellNote('linux'), '');
  assert.match(shellNote('win32'), /cmd\.exe/);
});
