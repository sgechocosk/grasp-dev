import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/** 画面のスクリプト (media/main.js) から、Markdown の描画部分だけを取り出して動かす */
function loadRenderer(): (src: string) => string {
  const src = fs.readFileSync(path.join(process.cwd(), 'media/main.js'), 'utf8');
  const from = src.indexOf('  const esc =');
  const to = src.indexOf('  // ---------- rendering ----------');
  assert.ok(from > 0 && to > from, 'media/main.js の Markdown 描画部分が見つからない');
  return new Function(`${src.slice(from, to)}\nreturn renderMarkdown;`)() as (src: string) => string;
}

test('Markdown: 字下げされた見出しなど、どんな入力でも描画が終わる', () => {
  const render = loadRenderer();
  // 以前は、箇条書きの中の字下げされた見出しで描画が終わらず、画面が固まってスクロールできなくなった
  assert.equal(
    render('1. 手順\n   ### 見出し\n   本文'),
    '<div class="li" style="margin-left:0em"><span class="bullet">1.</span><span>手順</span></div><h3>見出し</h3><p>   本文</p>',
  );
  assert.equal(render('  # 字下げ'), '<h1>字下げ</h1>');
  // どの種類にも当てはまらない行があっても、1行ずつ必ず進む
  for (const line of ['#', '   #x', '-', ' 1.', '|', '>', '```', '\t#\t', '####### 7', '- \n  #']) {
    assert.equal(typeof render(`前\n${line}\n後`), 'string');
  }
});
