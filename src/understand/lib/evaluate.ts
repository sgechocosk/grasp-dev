import { declarationAt } from './declarations';
import { BLANK } from './types';

/**
 * 「具体的な値で問う」ための計算。
 * 値の問いは、答えを機械的に確かめられるときにだけ出す (LLM に計算させると誤りうるため)。
 * 確かめられるのは、数値の引数だけを使った四則演算を、そのまま返す関数に限る。利用者のコードは実行しない
 * (下の小さな計算機で式を読むだけ)。それ以外は undefined を返し、呼び出し側はコードの問いのままにする。
 */

const MATH: Record<string, (...args: number[]) => number> = {
  round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, trunc: Math.trunc, max: Math.max, min: Math.min,
};
const TOKEN = /\s*(\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|[-+*/%(),.])/y;
const NUMBER = '-?\\d+(?:\\.\\d+)?';
const JS_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * 数値の四則演算 (+ - * / %、括弧、Math.round などの一部) を計算する。
 * それ以外の書き方 (関数呼び出し・比較・文字列・べき乗など) や、env に無い名前が出てきたら undefined。
 * 演算の意味は JavaScript / TypeScript のものなので、ほかの言語のコードには使わない。
 */
export function evalArithmetic(source: string, env: ReadonlyMap<string, number>): number | undefined {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(source);
    if (!m) return undefined;
    tokens.push(m[1]!);
    at = TOKEN.lastIndex;
  }
  let i = 0;
  const fail = (): never => {
    throw new Error('unsupported');
  };
  const expect = (t: string): void => {
    if (tokens[i++] !== t) fail();
  };
  const primary = (): number => {
    const t = tokens[i++];
    if (t === undefined) return fail();
    if (/^\d/.test(t)) return Number(t);
    if (t === '(') {
      const v = sum();
      expect(')');
      return v;
    }
    if (t === 'Math') {
      expect('.');
      const fn = MATH[tokens[i++] ?? ''];
      if (!fn) return fail();
      expect('(');
      const args = [sum()];
      while (tokens[i] === ',') {
        i++;
        args.push(sum());
      }
      expect(')');
      return fn(...args);
    }
    if (/^[A-Za-z_$]/.test(t) && env.has(t) && tokens[i] !== '(' && tokens[i] !== '.') return env.get(t)!;
    return fail();
  };
  const unary = (): number => {
    if (tokens[i] === '-') {
      i++;
      return -unary();
    }
    if (tokens[i] === '+') {
      i++;
      return unary();
    }
    return primary();
  };
  const product = (): number => {
    let v = unary();
    while (tokens[i] === '*' || tokens[i] === '/' || tokens[i] === '%') {
      const op = tokens[i++];
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = sum();
    return i === tokens.length && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 表示用の数値 (0.1 + 0.2 のような誤差を見せない) */
export function formatNumber(v: number): string {
  const n = Number(v.toPrecision(12));
  return String(Object.is(n, -0) ? 0 : n);
}

/** テストなどに書かれている、数値だけを渡した呼び出し。expected は同じ行で比べている値 (読み取れたときだけ) */
export interface SampleCall {
  args: number[];
  expected?: number;
}

/**
 * name(数値, 数値, ...) という呼び出しを探す。引数の数が arity と同じものだけを返す。
 * 具体的な値の例を、モデルに作らせずにプロジェクトの中から採るために使う。
 */
export function sampleCalls(texts: string[], name: string, arity: number): SampleCall[] {
  const out: SampleCall[] = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const call = new RegExp(`(?<![\\w$.])${escaped}\\(\\s*(${NUMBER}(?:\\s*,\\s*${NUMBER})*)\\s*\\)`, 'g');
  for (const text of texts) {
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(call)) {
        const args = m[1]!.split(',').map((a) => Number(a.trim()));
        if (args.length !== arity || args.some((a) => !Number.isFinite(a))) continue;
        const before = line.slice(0, m.index);
        const after = line.slice(m.index! + m[0].length);
        // expect(f(1)).toBe(2) / assert.equal(f(1), 2) / assertEquals(2, f(1))
        const expected =
          new RegExp(`^\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo)\\(\\s*(${NUMBER})\\s*[,)]`).exec(after)?.[1] ??
          (/(?:equal|strictEqual|deepEqual|deepStrictEqual|assertEquals|is)\(\s*$/i.test(before) ? new RegExp(`^\\s*,\\s*(${NUMBER})\\s*[,)]`).exec(after)?.[1] : undefined) ??
          (/^\s*[,)]/.test(after) ? new RegExp(`assertEquals\\(\\s*(${NUMBER})\\s*,\\s*$`).exec(before)?.[1] : undefined);
        out.push({ args, expected: expected === undefined ? undefined : Number(expected) });
      }
    }
  }
  return out;
}

export interface ValueQuestion {
  /** 問いの文 (例: 「amount が 100、rate が 0.1 のとき、calcPrice が返す値はどれですか?」) */
  ask: string;
  /** 選択肢ごとの値 (コードの選択肢と同じ並び) */
  labels: string[];
  /** 答え合わせで見せる計算 (例: 「amount * (1 + rate) に amount = 100、rate = 0.1 を入れると 110」) */
  calc: string;
}

export interface ValueQuestionInput {
  /** ファイルのパス (言語の判定に使う) */
  path: string;
  /** 空欄を1つだけ含むコード */
  code: string;
  /** 選択肢のコード (表示順) */
  options: string[];
  answer: string;
  /** テストなど、具体的な値での呼び出しが書かれているファイルの内容 */
  tests?: string[];
  /** モデルが挙げた、引数に入れる値の例。入力の値は任意なので誤りにならない (答えは計算で求める) */
  proposed?: ReadonlyMap<string, number>;
}

/** 関数の引数の名前。数値の引数だけの関数でなければ undefined */
function numberParams(header: string): string[] | undefined {
  const open = header.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  let close = -1;
  for (let c = open; c < header.length; c++) {
    if (header[c] === '(') depth++;
    else if (header[c] === ')' && --depth === 0) {
      close = c;
      break;
    }
  }
  if (close < 0 || !/^\s*(?::\s*[\w<>[\]| ]+)?\s*\{\s*$/.test(header.slice(close + 1))) return undefined;
  const inner = header.slice(open + 1, close).trim();
  if (!inner) return undefined;
  const names: string[] = [];
  for (const part of inner.split(',')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*(\w+))?\s*$/.exec(part);
    if (!m || (m[2] !== undefined && m[2] !== 'number') || names.includes(m[1]!)) return undefined;
    names.push(m[1]!);
  }
  return names;
}

/**
 * 空欄の選択肢を、具体的な値で問う形にできるか。
 * 条件: JS / TS で、空欄の行が「return 式;」、その関数の中身がその1行だけ、引数がすべて数値、
 * どの選択肢を入れても式が四則演算として計算でき、値がすべて異なる。
 * テストに同じ呼び出しがあり、そこに書かれた期待値と計算が食い違うときは、出さない。
 */
export function valueQuestion(input: ValueQuestionInput): ValueQuestion | undefined {
  if (!JS_EXT.test(input.path) || input.code.split(BLANK).length !== 2) return undefined;
  const lines = input.code.split('\n');
  const at = lines.findIndex((l) => l.includes(BLANK));
  const expr = /^\s*return\s+(.+?);?\s*$/.exec(lines[at] ?? '')?.[1];
  if (!expr) return undefined;
  const skip = (l: string | undefined): boolean => l !== undefined && (l.trim() === '' || /^\s*\/\//.test(l));
  let head = at - 1;
  while (skip(lines[head])) head--;
  let tail = at + 1;
  while (skip(lines[tail])) tail++;
  const decl = declarationAt(lines[head] ?? '');
  if (!decl || (decl.kind !== 'function' && decl.kind !== 'method') || !/^\s*\}/.test(lines[tail] ?? '')) return undefined;
  const params = numberParams(lines[head]!);
  if (!params) return undefined;

  const fromTest = sampleCalls(input.tests ?? [], decl.name, params.length)[0];
  const env = new Map<string, number>();
  for (const [k, p] of params.entries()) {
    const v = fromTest ? fromTest.args[k] : input.proposed?.get(p);
    if (v === undefined || !Number.isFinite(v)) return undefined;
    env.set(p, v);
  }
  const values = input.options.map((o) => evalArithmetic(expr.split(BLANK).join(o), env));
  if (values.some((v) => v === undefined)) return undefined;
  const labels = (values as number[]).map(formatNumber);
  if (new Set(labels).size !== labels.length) return undefined;
  const answerAt = input.options.indexOf(input.answer);
  if (answerAt < 0) return undefined;
  const answerValue = values[answerAt]!;
  if (fromTest?.expected !== undefined && Math.abs(fromTest.expected - answerValue) > 1e-9 * Math.max(1, Math.abs(answerValue))) return undefined;
  const given = params.map((p) => `${p} が ${formatNumber(env.get(p)!)}`).join('、');
  const assigned = params.map((p) => `${p} = ${formatNumber(env.get(p)!)}`).join('、');
  return {
    ask: `${given} のとき、${decl.name} が返す値はどれですか?`,
    labels,
    calc: `${expr.split(BLANK).join(input.answer)} に ${assigned} を入れると ${labels[answerAt]}`,
  };
}
