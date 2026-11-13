import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listFiles } from '../tools/search';
import type { FileChange } from './changeSet';
import { keyDelta, quotedLiteralPattern } from './lib/coupling';
import { declarationAt, declarationsOf, enclosingDeclaration, inHeader } from './lib/declarations';
import { changedCurrentLines, diffHunks } from './lib/diff';
import { splitLines } from './lib/text';
import type { Recorder } from './recorder';
import { extOf, isCodePath, type Step, type StepEdit } from './steps';

/** 変更の種類ごとの「確認が必要になる場所」の探し方 (変更伝播パターン) */
export type PatternId = 'callers' | 'behavior' | 'shape' | 'keys' | 'usage';

export interface PatternInfo {
  name: string;
  trigger: string;
  howToFind: string;
  criterion: string;
}

export const PATTERNS: Record<PatternId, PatternInfo> = {
  callers: {
    name: '呼び出し元の追従',
    trigger: '関数・メソッドの引数や戻り値(シグネチャ)を変えた、または削除した',
    howToFind: 'その名前を使っている場所(呼び出し元)を、単語で検索してすべて探す',
    criterion: '新しい引数を渡しているか、戻り値の使い方が新しい形に合っているか',
  },
  behavior: {
    name: '振る舞いの変化の確認',
    trigger: '関数の中身を変えた(戻り値の意味や、エラーになる条件が変わりうる)',
    howToFind: '呼び出し元を検索し、戻り値や例外で分岐している箇所を見る',
    criterion: '呼び出し元が、変更前の振る舞いを前提にしていないか',
  },
  shape: {
    name: 'データ形状の追従',
    trigger: '型・インターフェース・列挙の中身を足した/変えた/消した',
    howToFind: 'その型を使っている場所(値を作る・読み書きする・種類で分岐する箇所)を探す',
    criterion: '新しい項目を設定・読み取り・分岐する必要があるか',
  },
  keys: {
    name: 'キーの対応(送る側と受ける側)',
    trigger: 'メッセージの種類・設定キー・イベント名などの文字列キーを足した/消した',
    howToFind: '同じキーを文字列として検索する(名前の参照をたどっても見つからない結びつき)',
    criterion: '送る側と受ける側、登録する側と使う側がそろっているか',
  },
  usage: {
    name: '新しい定義の利用',
    trigger: '関数・型などを新しく追加した',
    howToFind: '追加した名前を使っている場所を、単語で検索する',
    criterion: '追加した定義が実際に使われているか、使い方が定義に合っているか',
  },
};

/** changed: 今回変更した / checked: 読んだうえで変更しなかった / unseen: 一度も見ていない */
export type Verdict = 'changed' | 'checked' | 'unseen';

export interface Site {
  id: string;
  path: string;
  /** 変更後の内容での行 (1始まり) */
  line: number;
  text: string;
  symbol?: string;
  verdict: Verdict;
  /** changed のとき、その変更を含むステップ */
  step?: string;
  /** なぜ変えたか / なぜ変えなかったか (エージェントへの聞き取りで埋める) */
  reason: string;
}

export interface Obligation {
  id: string;
  /** きっかけになったステップ */
  step: string;
  pattern: PatternId;
  /** 変わった名前・キー */
  subject: string;
  sites: Site[];
  /** 上限を超えて表示しなかった場所の数 */
  more: number;
}

export const MAX_SITES = 6;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 300_000;
const SEARCH_EXT = new Set(['json', 'html', 'htm', 'css', 'scss', 'less', 'yaml', 'yml', 'md']);
const SKIP_NAMES = new Set(['constructor', 'default', 'index', 'main']);
const VERDICT_RANK: Record<Verdict, number> = { changed: 0, checked: 1, unseen: 2 };

function searchable(rel: string): boolean {
  return isCodePath(rel) || (SEARCH_EXT.has(extOf(rel)) && !/(^|\/)(package-lock\.json|[^/]*\.lock)$/.test(rel));
}

/** 変更後のワークスペースの内容 (変えたファイルは変更後、それ以外はディスクの内容)。検索に使う */
export class WorkspaceView {
  private readonly texts = new Map<string, string>();
  private readonly lineCache = new Map<string, string[]>();

  private constructor(readonly cwd: string) {}

  static async load(cwd: string, changes: FileChange[], opts: { rgPath?: string | null; signal: AbortSignal }): Promise<WorkspaceView> {
    const view = new WorkspaceView(cwd);
    const files = await listFiles(cwd, { cwd, signal: opts.signal, fileState: new Map(), rgPath: opts.rgPath }).catch(() => [] as string[]);
    let count = 0;
    for (const file of files) {
      const rel = path.relative(cwd, file).split(path.sep).join('/');
      if (!searchable(rel) || count >= MAX_FILES) continue;
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined || text.includes('\0')) continue;
      view.texts.set(rel, text);
      count++;
    }
    for (const c of changes) {
      if (c.after === null) view.texts.delete(c.rel);
      else if (searchable(c.rel)) view.texts.set(c.rel, c.after);
    }
    return view;
  }

  files(): string[] {
    return [...this.texts.keys()];
  }

  lines(rel: string): string[] {
    let l = this.lineCache.get(rel);
    if (!l) this.lineCache.set(rel, (l = splitLines(this.texts.get(rel) ?? '')));
    return l;
  }

  has(rel: string): boolean {
    return this.texts.has(rel);
  }
}

interface Subject {
  pattern: PatternId;
  name: string;
  /** 文字列キーとして探すか (false なら単語として探す) */
  literal: boolean;
}

const wordRe = (name: string): RegExp => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
const IMPORT_LINE = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b)|\brequire\s*\(/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/;

/** 1つの書き換えから、ほかの場所に影響しうる「変わったもの」を取り出す */
export function subjectsOf(edit: StepEdit): Subject[] {
  if (!isCodePath(edit.path) || edit.deleted) {
    return edit.deleted ? [] : keySubjects(edit);
  }
  const out: Subject[] = [];
  const add = (pattern: PatternId, name: string): void => {
    if (name.length >= 3 && !SKIP_NAMES.has(name) && !out.some((s) => s.name === name && !s.literal)) out.push({ pattern, name, literal: false });
  };
  const beforeLines = splitLines(edit.before);
  const afterLines = splitLines(edit.after);
  const before = edit.created ? [] : declarationsOf(beforeLines);
  const after = declarationsOf(afterLines);
  const fileBeforeNames = new Set(edit.created ? [] : declarationsOf(splitLines(edit.fileBefore)).map((d) => d.name));
  const fileAfterNames = new Set(declarationsOf(splitLines(edit.fileAfter)).map((d) => d.name));

  for (const d of after) {
    const old = before.find((b) => b.name === d.name);
    if (old && old.header !== d.header) add('callers', d.name);
    else if (!old && !fileBeforeNames.has(d.name)) add('usage', d.name);
  }
  for (const d of before) {
    if (!after.some((x) => x.name === d.name) && !fileAfterNames.has(d.name)) add('callers', d.name);
  }
  // 中身だけが変わった宣言
  for (const h of diffHunks(beforeLines, afterLines)) {
    const start = Math.min(h.newStart, afterLines.length - 1);
    const end = h.newCount > 0 ? h.newStart + h.newCount - 1 : start;
    const decl = enclosingDeclaration(afterLines, start, end);
    if (!decl || inHeader(decl, start) || out.some((s) => s.name === decl.name)) continue;
    if (!before.some((b) => b.name === decl.name)) continue;
    if (decl.kind === 'function' || decl.kind === 'method') add('behavior', decl.name);
    else if (decl.kind === 'interface' || decl.kind === 'type' || decl.kind === 'enum') add('shape', decl.name);
  }
  return [...out, ...keySubjects(edit)];
}

/** 足した・消した文字列キー */
function keySubjects(edit: StepEdit): Subject[] {
  const a = splitLines(edit.before);
  const b = splitLines(edit.after);
  const removed: string[] = [];
  const added: string[] = [];
  for (const h of diffHunks(a, b)) {
    removed.push(...a.slice(h.oldStart, h.oldStart + h.oldCount));
    added.push(...b.slice(h.newStart, h.newStart + h.newCount));
  }
  const delta = keyDelta(removed, added);
  return [...delta.added, ...delta.removed].slice(0, 4).map((k) => ({ pattern: 'keys' as const, name: k.literal, literal: true }));
}

/**
 * 確定した変更から、影響が及びうる場所を機械的に集め、それぞれを
 * 「今回変更した / 読んだうえで変更しなかった / 一度も見ていない」に分ける。
 * 変更に引きずられたステップには causedBy を付ける。
 */
export function analyzeImpact(steps: Step[], changes: FileChange[], view: WorkspaceView, recorder: Recorder): Obligation[] {
  const changedLines = new Map<string, Set<number>>();
  for (const c of changes) {
    if (c.after !== null) changedLines.set(c.rel, changedCurrentLines(c.before ?? '', c.after));
  }
  const edits = steps.flatMap((s) => s.edits.map((e) => ({ step: s, edit: e, end: e.afterStart + splitLines(e.after).length - 1 })));
  const editAt = (rel: string, line: number) => edits.find((x) => x.edit.path === rel && !x.edit.deleted && line >= x.edit.afterStart && line <= x.end);

  const obligations: Obligation[] = [];
  let siteCount = 0;
  for (const step of steps) {
    for (const edit of step.edits) {
      for (const subject of subjectsOf(edit)) {
        if (obligations.some((o) => o.subject === subject.name && o.pattern === subject.pattern)) continue;
        const re = subject.literal ? quotedLiteralPattern(subject.name) : wordRe(subject.name);
        // 同じ宣言の中の複数の出現は1か所として扱う (いちばん強い判定を採る)
        const found = new Map<string, Site>();
        for (const rel of view.files()) {
          const lines = view.lines(rel);
          for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            if (!re.test(text) || COMMENT_LINE.test(text)) continue;
            const line = i + 1;
            if (!subject.literal && (IMPORT_LINE.test(text) || declarationAt(text)?.name === subject.name)) continue;
            const at = editAt(rel, line);
            // 自分の書き換えの中の出現は「ほかの場所」ではない
            if (at?.edit === edit) continue;
            const isChanged = changedLines.get(rel)?.has(line) ?? false;
            const verdict: Verdict = isChanged ? 'changed' : at || recorder.hasSeen(path.resolve(view.cwd, rel), text) ? 'checked' : 'unseen';
            const symbol = isCodePath(rel) ? enclosingDeclaration(lines, i, i)?.name : undefined;
            const key = `${rel}#${symbol ?? line}`;
            const prev = found.get(key);
            if (!prev || VERDICT_RANK[verdict] < VERDICT_RANK[prev.verdict]) {
              found.set(key, { id: '', path: rel, line, text: text.trim().slice(0, 200), symbol, verdict, step: isChanged ? at?.step.id : undefined, reason: '' });
            }
          }
        }
        if (found.size === 0) continue;
        const all = [...found.values()].sort((x, y) => VERDICT_RANK[x.verdict] - VERDICT_RANK[y.verdict]);
        const sites = all.slice(0, MAX_SITES);
        sites.forEach((s) => (s.id = `p${++siteCount}`));
        obligations.push({ id: `o${obligations.length + 1}`, step: step.id, pattern: subject.pattern, subject: subject.name, sites, more: all.length - sites.length });
      }
    }
  }

  for (const o of obligations) {
    for (const site of o.sites) {
      const target = site.step && site.step !== o.step ? steps.find((s) => s.id === site.step) : undefined;
      // 互いに引きずり合う形 (循環) にはしない
      if (target && !target.causedBy && steps.find((s) => s.id === o.step)?.causedBy?.step !== target.id) {
        target.causedBy = { step: o.step, pattern: PATTERNS[o.pattern].name, subject: o.subject };
      }
    }
  }
  return obligations;
}

/** その確認先を探すのに使った、名前・キーの出現のパターン */
export function subjectPattern(o: Pick<Obligation, 'pattern' | 'subject'>): RegExp {
  return o.pattern === 'keys' ? quotedLiteralPattern(o.subject) : wordRe(o.subject);
}

export function placeLabel(site: Pick<Site, 'path' | 'symbol'>): string {
  return site.symbol ? `${site.path} の ${site.symbol}` : site.path;
}
