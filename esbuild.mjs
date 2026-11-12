import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const production = args.includes('--production');

if (args.includes('--test')) {
  rmSync('dist-test', { recursive: true, force: true });
  await esbuild.build({
    entryPoints: readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: 'dist-test',
    sourcemap: 'inline',
    // 画面のホスト (ChatViewProvider) もテストできるよう、vscode はテスト用の代わりに差し替える
    alias: { vscode: './test/stubs/vscode.ts' },
  });
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    sourcemap: !production,
    minify: production,
  });
  if (args.includes('--watch')) {
    await ctx.watch();
    console.log('watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
