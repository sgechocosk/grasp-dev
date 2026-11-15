import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { diffHunks, matchedLines } from './lib/diff';
import { detectEol, splitLines } from './lib/text';

/** 1ファイルの変更。before / after が null なら、そのファイルが無い (新規作成 / 削除)。 */
export interface FileChange {
  /** 絶対パス */
  path: string;
  /** 表示用のパス (ワークスペース内なら相対、外なら絶対)。区切りは / */
  rel: string;
  before: string | null;
  after: string | null;
  /** 実行権限など (新しく作ったファイルを戻すときに合わせる) */
  mode?: number;
}

export interface Collected {
  changes: FileChange[];
  /** 変わったが取り置けなかったファイル (バイナリ・大きすぎる・変更前の内容が分からない)。そのまま残す */
  unheld: string[];
  /** 作業の中でコミットが行われた (取り置いても破棄しても、コミットは残る) */
  committed: boolean;
}

const MAX_HELD_BYTES = 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const nul = (out: string): string[] => out.split('\0').filter(Boolean);
const toPosix = (p: string): string => (path.sep === '\\' ? p.replace(/\\/g, '/') : p);

/** ファイルの状態。テキストなら内容 (無ければ null)、テキストとして扱えなければ内容のハッシュ */
type FileState = { text: string | null } | { hash: string };

function stateOf(buf: Buffer | null): FileState {
  if (buf === null) return { text: null };
  if (buf.length <= MAX_HELD_BYTES && !buf.subarray(0, 8192).includes(0)) return { text: buf.toString('utf8') };
  return { hash: createHash('sha1').update(buf).digest('hex') };
}

async function readState(file: string): Promise<FileState> {
  // 大きなファイルは読み込まず、大きさと更新日時で変わったかどうかだけを見る
  const stat = await fsp.stat(file).catch(() => undefined);
  if (stat && stat.size > MAX_HELD_BYTES) return { hash: `big:${stat.size}:${stat.mtimeMs}` };
  return stateOf(await fsp.readFile(file).catch(() => null));
}

/**
 * 実行前の状態の控え。エージェントは実ワークスペースでそのまま作業し (テストやビルドを実環境で回せる)、
 * 終わったあとに、この控えと比べて「何が変わったか」を取り出す。
 * - Edit / Write で書くファイルは、書く直前の内容を控える (note)
 * - git 管理下なら、コマンドが直接書き換えたファイルも拾う (開始時点のインデックスと、未コミットだったファイルの内容を控えておく)
 */
export class Baseline {
  /** 絶対パス → 開始時点の状態 */
  private readonly snapshots = new Map<string, FileState>();
  private tree?: string;
  private prefix = '';
  private head = '';

  private constructor(readonly cwd: string) {}

  static async capture(cwd: string): Promise<Baseline> {
    const b = new Baseline(cwd);
    try {
      b.prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).trim();
      // 開始時点のインデックスをツリーとして控える (作業ツリーにもインデックスにも触れない)
      const tree = (await git(cwd, ['write-tree'])).trim();
      // インデックスと違う内容のファイル・未追跡のファイルは、今の内容を控える
      for (const rel of nul(await git(cwd, ['ls-files', '-z', '-m', '-o', '-d', '--exclude-standard']))) {
        const file = path.resolve(cwd, rel);
        b.snapshots.set(file, await readState(file));
      }
      b.tree = tree;
      b.head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then((o) => o.trim(), () => '');
    } catch {
      // git が無い・リポジトリでない・マージ中など: Edit / Write の分だけを扱う
      b.tree = undefined;
    }
    return b;
  }

  get usesGit(): boolean {
    return this.tree !== undefined;
  }

  /** Edit / Write が書く前に呼ぶ。まだ控えていなければ、今の内容を控える (同期) */
  note(file: string): void {
    if (this.snapshots.has(file)) return;
    let buf: Buffer | null = null;
    try {
      buf = fs.readFileSync(file);
    } catch {
      // 無いファイル (これから作られる)
    }
    this.snapshots.set(file, stateOf(buf));
  }

  /** 開始時点の状態 */
  private async original(file: string): Promise<FileState> {
    const snap = this.snapshots.get(file);
    if (snap) return snap;
    const rel = toPosix(path.relative(this.cwd, file));
    try {
      return stateOf(await gitBuffer(this.cwd, ['show', `${this.tree}:${this.prefix}${rel}`]));
    } catch {
      return { text: null }; // 開始時点のインデックスに無い = 新しく作られた
    }
  }

  /** 開始時点から変わったファイルを集める */
  async collect(): Promise<Collected> {
    const candidates = new Set<string>(this.snapshots.keys());
    if (this.tree) {
      try {
        const add = (out: string) => nul(out).forEach((rel) => candidates.add(path.resolve(this.cwd, rel)));
        add(await git(this.cwd, ['diff', '--name-only', '-z', '--relative', this.tree, '--', '.']));
        add(await git(this.cwd, ['ls-files', '-z', '-o', '--exclude-standard']));
      } catch {
        // 取れなければ Edit / Write の分だけ
      }
    }
    const changes: FileChange[] = [];
    const unheld: string[] = [];
    for (const file of [...candidates].sort()) {
      const before = await this.original(file);
      const after = await readState(file);
      const relative = path.relative(this.cwd, file);
      const rel = relative.startsWith('..') || path.isAbsolute(relative) ? file : toPosix(relative);
      if ('hash' in before || 'hash' in after) {
        // 内容として持てないファイル (バイナリ・大きすぎる)。変わっていれば、取り置けなかったものとして知らせる
        if (!('hash' in before && 'hash' in after && before.hash === after.hash)) unheld.push(rel);
        continue;
      }
      if (before.text === after.text) continue;
      const mode = after.text === null ? undefined : await fsp.stat(file).then((s) => s.mode & 0o777, () => undefined);
      changes.push({ path: file, rel, before: before.text, after: after.text, mode });
    }
    const head = this.tree ? await git(this.cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then((o) => o.trim(), () => '') : '';
    return { changes, unheld, committed: head !== this.head };
  }
}

/** ファイルを変更前 (before) または変更後 (after) の内容にする */
export async function writeState(changes: FileChange[], which: 'before' | 'after'): Promise<void> {
  for (const c of changes) {
    const content = c[which];
    if (content === null) {
      await fsp.rm(c.path, { force: true });
      continue;
    }
    await fsp.mkdir(path.dirname(c.path), { recursive: true });
    await fsp.writeFile(c.path, content, 'utf8');
    if (which === 'after' && c.mode !== undefined) await fsp.chmod(c.path, c.mode).catch(() => undefined);
  }
}

/** 期待した内容と違っているファイル (取り置いている間に、利用者や他のプロセスが変えたもの) */
export async function staleFiles(changes: FileChange[], expect: 'before' | 'after'): Promise<string[]> {
  const out: string[] = [];
  for (const c of changes) {
    const now = await readState(c.path);
    if ('hash' in now || now.text !== c[expect]) out.push(c.rel);
  }
  return out;
}

/**
 * 変更前 (base) → 変更後 (after) の書き換えを、いまの内容 (current) に重ねる。
 * 取り置いている間に利用者がそのファイルの別の場所を編集していても、両方の変更を残して反映するために使う。
 * 書き換える行とその前後の行が、いまの内容でもそのまま残っているときだけ重ねる。
 * 同じ場所が書き換えられていて決められなければ undefined (どちらを残すかは利用者が決める)。
 */
export function mergeText(base: string, after: string, current: string): string | undefined {
  const a = splitLines(base);
  const o = splitLines(after);
  const c = splitLines(current);
  const at = new Map(matchedLines(a, c));
  const edits: Array<{ start: number; count: number; lines: string[] }> = [];
  for (const h of diffHunks(a, o)) {
    const first = h.oldStart;
    const last = h.oldStart + h.oldCount - 1;
    // 書き換える範囲と、その前後の1行ずつが、いまの内容でも同じ並びで残っていること
    const from = Math.max(0, first - 1);
    const to = Math.min(a.length - 1, last + 1);
    for (let k = from; k <= to; k++) {
      if (!at.has(k) || (k > from && at.get(k) !== at.get(k - 1)! + 1)) return undefined;
    }
    // ファイルの先頭・末尾に接する書き換えは、いまの内容でも先頭・末尾であること
    if (first === 0 && at.get(from) !== 0) return undefined;
    if (last === a.length - 1 && at.get(to) !== c.length - 1) return undefined;
    const start = h.oldCount > 0 ? at.get(first)! : first > 0 ? at.get(first - 1)! + 1 : 0;
    edits.push({ start, count: h.oldCount, lines: o.slice(h.newStart, h.newStart + h.newCount) });
  }
  const out = c.slice();
  for (const e of edits.sort((x, y) => y.start - x.start)) out.splice(e.start, e.count, ...e.lines);
  return out.join(detectEol(current));
}

export interface ApplyPlan {
  /** 書き込む内容 (null はファイルを消す) */
  writes: Array<{ change: FileChange; content: string | null }>;
  /** 取り置いている間に書き換えられていて、その内容と合わせて反映するファイル */
  merged: string[];
  /** 同じ場所が書き換えられていて、合わせられないファイル */
  conflicts: string[];
}

/**
 * 取り置いた変更を、いまのファイルに反映する計画を立てる (書き込みはしない)。
 * - 変更前のままのファイル: 変更後の内容にする
 * - 取り置いている間に書き換えられたファイル: 重ならなければ、両方の変更を残した内容にする (merged)。重なっていれば conflicts
 * overwrite なら、conflicts のファイルも変更後の内容にする (あとから書き換えた内容は失われる)。
 */
export async function planApply(changes: FileChange[], overwrite = false): Promise<ApplyPlan> {
  const plan: ApplyPlan = { writes: [], merged: [], conflicts: [] };
  for (const change of changes) {
    const now = await readState(change.path);
    const text = 'hash' in now ? undefined : now.text;
    if (text === change.after) continue;
    if (text === change.before) {
      plan.writes.push({ change, content: change.after });
      continue;
    }
    const merged = typeof text === 'string' && change.before !== null && change.after !== null ? mergeText(change.before, change.after, text) : undefined;
    if (merged !== undefined) {
      plan.merged.push(change.rel);
      plan.writes.push({ change, content: merged });
    } else {
      plan.conflicts.push(change.rel);
      if (overwrite) plan.writes.push({ change, content: change.after });
    }
  }
  return plan;
}

export async function writePlan(plan: ApplyPlan): Promise<void> {
  for (const { change, content } of plan.writes) {
    if (content === null) {
      await fsp.rm(change.path, { force: true });
      continue;
    }
    await fsp.mkdir(path.dirname(change.path), { recursive: true });
    await fsp.writeFile(change.path, content, 'utf8');
    if (change.mode !== undefined) await fsp.chmod(change.path, change.mode).catch(() => undefined);
  }
}
