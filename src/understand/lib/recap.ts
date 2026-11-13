import { declarationsOf, enclosingDeclaration, type DeclKind } from './declarations';
import { shuffle, splitLines } from './text';

/**
 * まとめ (仕組みの説明の空欄)。
 * 「部品の役割と、そのつながりを自分で再構成できること」を確かめるため、仕組みを説明する文章の中の
 * 部品の名前 (関数・型・ファイル) を空欄にして、選択肢から選んでもらう。全部を埋めた文章は、人に説明する材料として残る。
 *
 * 空欄の場所と選択肢は、モデルに決めさせず、コードから機械的に決める。
 * - 空欄にするのは、実際のコードに宣言がある名前だけ
 * - 違う選択肢にするのは、文章に出てくるどの部品とも、コードの上でつながりの無い部品だけ
 *   (つながりのある部品は、文章の書き方しだいで当てはまりうるので、違うとは言い切れない)
 */

export interface Component {
  /** 関数・型などの名前、またはファイルのパス */
  name: string;
  kind: 'decl' | 'file';
  /** 宣言の種類 (関数・型など) */
  declKind?: DeclKind;
  path: string;
  /** 宣言の行 (1始まり。ファイルは 1) */
  line: number;
  /** この部品が宣言している名前 */
  declares: Set<string>;
  /** この部品の中に出てくる名前 */
  words: Set<string>;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const SKIP_NAMES = new Set(['constructor', 'default', 'index', 'main']);

function wordsIn(lines: string[]): Set<string> {
  const text = lines.join('\n').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  return new Set(text.match(IDENT_RE) ?? []);
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** ファイルの内容から、部品 (宣言とファイル) を取り出す。複数の場所で宣言されている名前は、どれを指すか決まらないので除く */
export function componentsOf(files: Array<{ path: string; text: string }>): Component[] {
  const decls: Component[] = [];
  const out: Component[] = [];
  const bases = new Map<string, number>();
  for (const f of files) bases.set(baseName(f.path), (bases.get(baseName(f.path)) ?? 0) + 1);
  for (const f of files) {
    const lines = splitLines(f.text);
    const all = declarationsOf(lines);
    for (const d of all) {
      if (d.name.length < 3 || SKIP_NAMES.has(d.name)) continue;
      const end = enclosingDeclaration(lines, d.line, d.line)?.end ?? d.headerEnd;
      decls.push({ name: d.name, kind: 'decl', declKind: d.kind, path: f.path, line: d.line + 1, declares: new Set([d.name]), words: wordsIn(lines.slice(d.line, end + 1)) });
    }
    if (bases.get(baseName(f.path)) === 1) {
      out.push({ name: f.path, kind: 'file', path: f.path, line: 1, declares: new Set(all.map((d) => d.name)), words: wordsIn(lines) });
    }
  }
  const count = new Map<string, number>();
  for (const d of decls) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  return [...decls.filter((d) => count.get(d.name) === 1), ...out];
}

/** コードの上でつながりがあるか (一方が、もう一方の宣言している名前を使っている) */
export function related(a: Component, b: Component): boolean {
  if (a === b) return true;
  for (const n of b.declares) if (a.words.has(n)) return true;
  for (const n of a.declares) if (b.words.has(n)) return true;
  return false;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文章の中で、その部品を指している箇所 */
function mentionsOf(text: string, c: Component): Array<[number, number]> {
  const re =
    c.kind === 'decl'
      ? new RegExp(`(?<![\\w$])${escapeRe(c.name)}(?![\\w$])`, 'g')
      : // ファイルは、パスの途中から書かれていても (price.ts / src/price.ts) 同じものとして拾う
        new RegExp(`(?<![\\w.-])(?:[\\w.-]+/)*${escapeRe(baseName(c.path))}(?![\\w-])`, 'g');
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}

export interface RecapBlank {
  answer: string;
  /** 選択肢 (表示順) */
  options: string[];
  /** その部品がある場所 (答え合わせで示す) */
  where: { path: string; line: number };
}

export interface Recap {
  /** 文章を、そのまま見せる部分 (文字列) と空欄 (blanks の番号) に分けたもの。同じ部品が何度も出てくれば、同じ番号が並ぶ */
  segments: Array<string | number>;
  blanks: RecapBlank[];
  /** 空欄を埋めた全文 */
  full: string;
}

export interface RecapOptions {
  /** 空欄の上限 */
  max: number;
  /** 選択肢の数 (当てはまるものを含む) */
  optionCount: number;
  rng: () => number;
}

/** 説明の文章から、まとめの問いを作る。空欄にできる部品が無ければ undefined (文章をそのまま見せる) */
export function buildRecap(text: string, components: Component[], opts: RecapOptions): Recap | undefined {
  const full = (text ?? '').trim();
  if (!full || opts.max <= 0) return undefined;
  const mentioned = components.map((c) => ({ c, spans: mentionsOf(full, c) })).filter((m) => m.spans.length > 0);
  if (mentioned.length === 0) return undefined;
  const inText = mentioned.map((m) => m.c);
  const outside = components.filter((c) => !inText.includes(c) && !inText.some((m) => related(c, m)));

  // 関数・型の名前を先に、同じ種類の中では文章に出てくる順に、空欄にする
  const order = [...mentioned].sort((x, y) => Number(x.c.kind === 'file') - Number(y.c.kind === 'file') || x.spans[0]![0] - y.spans[0]![0]);
  const chosen: Array<{ c: Component; spans: Array<[number, number]>; options: string[] }> = [];
  const taken: Array<[number, number]> = [];
  for (const m of order) {
    if (chosen.length >= opts.max) break;
    if (m.spans.some(([s, e]) => taken.some(([ts, te]) => s < te && ts < e))) continue;
    const pool = shuffle(outside.filter((c) => c.kind === m.c.kind).map((c) => c.name), opts.rng);
    const wrong = [...new Set(pool)].slice(0, opts.optionCount - 1);
    // 違う選択肢が2つに満たなければ、その部品は空欄にしない (二択にはしない)
    if (wrong.length < 2) continue;
    chosen.push({ ...m, options: shuffle([m.c.name, ...wrong], opts.rng) });
    taken.push(...m.spans);
  }
  if (chosen.length === 0) return undefined;

  // 空欄の番号は、文章に出てくる順に振る
  chosen.sort((x, y) => x.spans[0]![0] - y.spans[0]![0]);
  const cuts = chosen.flatMap((ch, k) => ch.spans.map(([s, e]) => ({ s, e, k }))).sort((x, y) => x.s - y.s);
  const segments: Array<string | number> = [];
  let at = 0;
  for (const cut of cuts) {
    if (cut.s > at) segments.push(full.slice(at, cut.s));
    segments.push(cut.k);
    at = cut.e;
  }
  if (at < full.length) segments.push(full.slice(at));
  return {
    segments,
    blanks: chosen.map((ch) => ({ answer: ch.c.name, options: ch.options, where: { path: ch.c.path, line: ch.c.line } })),
    full,
  };
}
