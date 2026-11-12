import type { FileChange } from './changeSet';
import { enclosingDeclaration, type DeclKind } from './lib/declarations';
import { diffHunks, matchedLines } from './lib/diff';
import { splitLines } from './lib/text';

/** ステップの種類。依存される側から順に並べるのに使う */
export type StepKind = 'data' | 'core' | 'caller' | 'ui' | 'test' | 'config' | 'doc';

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  data: 'データ・型',
  core: '中核の処理',
  caller: '呼び出し元',
  ui: '画面',
  test: 'テスト',
  config: '設定',
  doc: '説明文',
};

const KIND_RANK: Record<StepKind, number> = { data: 0, core: 1, caller: 2, ui: 3, test: 4, config: 5, doc: 6 };

/** 確定した変更のうち、ひとまとまりの書き換え (1つの宣言、または近くの数行) */
export interface StepEdit {
  /** 表示用のパス */
  path: string;
  /** 絶対パス */
  file: string;
  created: boolean;
  deleted: boolean;
  /** 変更前のファイルでの範囲 (1始まり、両端含む) */
  startLine: number;
  endLine: number;
  /** 変更後のファイルでの先頭行 (1始まり) */
  afterStart: number;
  before: string;
  after: string;
  fileBefore: string;
  fileAfter: string;
  /** この範囲を含む宣言 (関数・クラス・型など) */
  symbol?: string;
  symbolKind?: DeclKind;
}

export interface Step {
  id: string;
  number: number;
  kind: StepKind;
  label: string;
  edits: StepEdit[];
  /** 考えどころを問いにできるか (できないものは差分だけを見せる) */
  quizzable: boolean;
  /** なぜこの変更が必要か */
  why: string;
  /** 変わる約束 (引数・型・メッセージの種類など) */
  contract: string;
  /** どの受け入れ条件のためか (1始まり。無ければ 0) */
  criterion: number;
  /** どのステップの変更に引きずられたか */
  causedBy?: { step: string; pattern: string; subject: string };
}

const CODE_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'java', 'py', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'kt', 'swift', 'rb', 'php', 'vue', 'sh', 'sql',
]);
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.map)$/;
/** 宣言全体をひとまとまりにする上限 (これより長い宣言は、変えた行の周りだけにする) */
const MAX_REGION_LINES = 80;
const CONTEXT = 3;
/** 問いにする変更後コードの上限 */
const MAX_QUIZ_LINES = 200;

export function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isCodePath(p: string): boolean {
  return CODE_EXT.has(extOf(p)) && !GENERATED.test(p);
}

export function isTestPath(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)\//.test(p) || /\.(test|spec)\.[^/]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);
}

const TRIVIAL_LINE = /^\s*(import\b.*|export\s+(\*|\{[^}]*\})\s+from\b.*|(const|let|var)\s+[^=]+=\s*require\(.*|from\s+\S+\s+import\b.*|#include\b.*|using\s+[\w.]+;|package\s+[\w.]+;?|\/\/.*|\/\*.*|\*.*|#.*|[{}()\[\];,]*)$/;

/** 変えた行が import・コメント・空行・括弧だけか (考えどころの無い変更) */
function isTrivial(before: string, after: string): boolean {
  const a = splitLines(before);
  const b = splitLines(after);
  for (const h of diffHunks(a, b)) {
    for (const l of [...a.slice(h.oldStart, h.oldStart + h.oldCount), ...b.slice(h.newStart, h.newStart + h.newCount)]) {
      if (!TRIVIAL_LINE.test(l)) return false;
    }
  }
  return true;
}

interface Unit {
  as: number;
  ae: number;
  bs: number;
  be: number;
  symbol?: string;
  symbolKind?: DeclKind;
}

/** 1ファイルの変更を、宣言ごと (宣言の外は近くの数行ごと) のまとまりに分ける */
export function editsOf(change: FileChange): StepEdit[] {
  const base = { path: change.rel, file: change.path, fileBefore: change.before ?? '', fileAfter: change.after ?? '' };
  if (change.before === null || change.after === null) {
    return [{
      ...base, created: change.before === null, deleted: change.after === null,
      startLine: 1, endLine: change.before === null ? 1 : splitLines(change.before).length, afterStart: 1,
      before: change.before ?? '', after: change.after ?? '',
    }];
  }
  const a = splitLines(change.before);
  const b = splitLines(change.after);
  const whole: StepEdit = {
    ...base, created: false, deleted: false, startLine: 1, endLine: a.length, afterStart: 1, before: change.before, after: change.after,
  };
  const hunks = diffHunks(a, b);
  const pairs = matchedLines(a, b);
  const matched = new Map(pairs.map(([i, j]) => [j, i]));

  // 変えた行を含む宣言 (無ければ前後数行) を、変更後の行番号 (0始まり) で求める
  let units: Unit[] = [];
  for (const h of hunks) {
    const ns = Math.min(h.newStart, b.length - 1);
    const ne = h.newCount > 0 ? h.newStart + h.newCount - 1 : ns;
    const decl = enclosingDeclaration(b, ns, ne);
    const fits = decl && decl.end - decl.line + 1 <= MAX_REGION_LINES;
    units.push({
      as: fits ? decl.line : Math.max(0, ns - CONTEXT),
      ae: fits ? decl.end : Math.min(b.length - 1, ne + CONTEXT),
      bs: 0, be: 0, symbol: decl?.name, symbolKind: decl?.kind,
    });
  }
  const merge = (list: Unit[], overlaps: (x: Unit, y: Unit) => boolean): Unit[] => {
    const out: Unit[] = [];
    for (const u of [...list].sort((x, y) => x.as - y.as)) {
      const last = out[out.length - 1];
      if (last && overlaps(last, u)) {
        last.ae = Math.max(last.ae, u.ae);
        last.be = Math.max(last.be, u.be);
        if (last.symbol !== u.symbol) last.symbol ??= u.symbol;
      } else out.push({ ...u });
    }
    return out;
  };
  units = merge(units, (x, y) => y.as <= x.ae + 1);

  // 範囲の両端を、変更前後で対応する行 (変わっていない行) に合わせ、変更前の範囲を決める
  for (const u of units) {
    while (u.as > 0 && !matched.has(u.as)) u.as--;
    while (u.ae < b.length - 1 && !matched.has(u.ae)) u.ae++;
    let prev = -1;
    let next = a.length;
    for (const [i, j] of pairs) {
      if (j < u.as) prev = i;
      if (j > u.ae) { next = i; break; }
    }
    u.bs = u.as === 0 ? 0 : prev + 1;
    u.be = u.ae === b.length - 1 ? a.length - 1 : next - 1;
  }
  units = merge(units, (x, y) => y.as <= x.ae || y.bs <= x.be);

  // 変更前の各範囲を変更後の各範囲で置き換えると、変更後のファイルになることを確かめる (ならなければファイル全体を1つとして扱う)
  const rebuilt: string[] = [];
  let at = 0;
  for (const u of units) {
    if (u.bs < at || u.be < u.bs - 1) return [whole];
    rebuilt.push(...a.slice(at, u.bs), ...b.slice(u.as, u.ae + 1));
    at = u.be + 1;
  }
  rebuilt.push(...a.slice(at));
  if (rebuilt.join('\n') !== b.join('\n')) return [whole];

  return units.map((u) => ({
    ...base, created: false, deleted: false,
    startLine: u.bs + 1, endLine: Math.max(u.be, u.bs) + 1, afterStart: u.as + 1,
    before: a.slice(u.bs, u.be + 1).join('\n'), after: b.slice(u.as, u.ae + 1).join('\n'),
    symbol: u.symbol, symbolKind: u.symbolKind,
  }));
}

function kindOf(edit: StepEdit): StepKind {
  const p = edit.path;
  const ext = extOf(p);
  if (isTestPath(p)) return 'test';
  if (['md', 'txt', 'rst', 'adoc'].includes(ext)) return 'doc';
  if (!isCodePath(p)) return ['css', 'scss', 'less', 'html', 'htm', 'svg'].includes(ext) ? 'ui' : 'config';
  if (edit.symbolKind === 'interface' || edit.symbolKind === 'type' || edit.symbolKind === 'enum') return 'data';
  if (/(^|\/)(types?|models?|schemas?|entities|dto)(\/|\.[^/]+$)/i.test(p)) return 'data';
  if (['tsx', 'jsx', 'vue'].includes(ext) || /(^|\/)(ui|views?|components?|pages?|webview|media|public)\//i.test(p)) return 'ui';
  return 'core';
}

function canQuiz(edit: StepEdit): boolean {
  return (
    isCodePath(edit.path) &&
    !edit.deleted &&
    splitLines(edit.after).length <= MAX_QUIZ_LINES &&
    edit.after.trim() !== '' &&
    !isTrivial(edit.before, edit.after)
  );
}

function defaultLabel(edit: StepEdit): string {
  if (edit.created) return `${edit.path} を追加`;
  if (edit.deleted) return `${edit.path} を削除`;
  return edit.symbol ? `${edit.path} の ${edit.symbol} を変更` : `${edit.path} を変更`;
}

/**
 * 確定した変更をステップに分ける。問いにできる変更は1つずつ、差分だけを見せる変更は同じファイル・同じ種類でまとめる。
 * 並びは依存される側から (データ・型 → 中核の処理 → 呼び出し元 → 画面 → テスト → 設定 → 説明文)。
 */
export function buildSteps(changes: FileChange[]): Step[] {
  const steps: Step[] = [];
  for (const change of changes) {
    let plain: Step | undefined;
    for (const edit of editsOf(change)) {
      const quizzable = canQuiz(edit);
      const kind = kindOf(edit);
      if (!quizzable && plain && plain.kind === kind) {
        plain.edits.push(edit);
        plain.label = `${edit.path} を変更`;
        continue;
      }
      const step: Step = { id: '', number: 0, kind, label: defaultLabel(edit), edits: [edit], quizzable, why: '', contract: '', criterion: 0 };
      steps.push(step);
      if (!quizzable) plain = step;
    }
  }
  return renumber(steps.map((s, i) => ({ s, i })).sort((x, y) => KIND_RANK[x.s.kind] - KIND_RANK[y.s.kind] || x.i - y.i).map((x) => x.s), true);
}

/** 並び順どおりに番号を振る。assignIds は最初の1回だけ (id は以後変えない) */
function renumber(steps: Step[], assignIds = false): Step[] {
  steps.forEach((s, i) => {
    s.number = i + 1;
    if (assignIds) s.id = `s${i + 1}`;
  });
  return steps;
}

/**
 * 影響の解析で分かった「引きずられた変更」を、元の変更の後に並べ直す。
 * 呼び出し元の追従で変わった中核の処理は、種類を「呼び出し元」にする。
 */
export function reorderByCause(steps: Step[]): Step[] {
  for (const s of steps) {
    if (s.causedBy && s.kind === 'core') s.kind = 'caller';
  }
  const sorted = steps.map((s, i) => ({ s, i })).sort((x, y) => KIND_RANK[x.s.kind] - KIND_RANK[y.s.kind] || x.i - y.i).map((x) => x.s);
  // 元の変更より前に来てしまったものは、元の変更の直後へ移す (循環していても必ず終わるよう回数を限る)
  for (let pass = 0; pass < sorted.length; pass++) {
    let moved = false;
    for (let i = 0; i < sorted.length; i++) {
      const cause = sorted[i].causedBy?.step;
      const at = cause ? sorted.findIndex((s) => s.id === cause) : -1;
      if (at > i) {
        const [s] = sorted.splice(i, 1);
        sorted.splice(at, 0, s);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return renumber(sorted);
}

/** これより多いステップは、問いにしないものをファイルごとにまとめる (一度に追う量を抑える) */
export const MAX_STEPS = 10;

/**
 * ステップが多いとき、問いにするステップ (keep) 以外を、ファイルごとに1つのステップへまとめる。
 * まとめたステップは差分だけを見せる。影響の記録 (どのステップがきっかけか・どのステップで変えたか) も、まとめた先に付け替える。
 */
export function condense(steps: Step[], obligations: Array<{ step: string; sites: Array<{ step?: string }> }>, keep: ReadonlySet<string>): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  const out: Step[] = [];
  const byPath = new Map<string, Step>();
  const moved = new Map<string, string>();
  for (const s of steps) {
    if (keep.has(s.id)) {
      out.push(s);
      continue;
    }
    const path = s.edits[0].path;
    const into = byPath.get(path);
    if (!into) {
      s.quizzable = false;
      byPath.set(path, s);
      out.push(s);
      continue;
    }
    into.edits.push(...s.edits);
    into.edits.sort((a, b) => a.startLine - b.startLine);
    into.label = `${path} を変更`;
    into.causedBy ??= s.causedBy;
    moved.set(s.id, into.id);
  }
  const at = (id: string): string => moved.get(id) ?? id;
  for (const s of out) {
    if (s.causedBy) s.causedBy.step = at(s.causedBy.step);
    if (s.causedBy?.step === s.id) delete s.causedBy;
  }
  for (const o of obligations) {
    o.step = at(o.step);
    for (const site of o.sites) if (site.step) site.step = at(site.step);
  }
  return renumber(out);
}
