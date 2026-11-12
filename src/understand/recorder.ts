import * as path from 'node:path';
import type { AgentEvent } from '../core/types';
import { resolvePath } from '../tools/tool';

/** 実行したコマンドと結果 (検証の根拠として最後に見せる) */
export interface CommandRecord {
  command: string;
  /** 何のためのコマンドか (モデルが添えた短い説明。無ければ空) */
  description: string;
  ok: boolean;
  /** 出力の末尾 */
  output: string;
}

export interface ToolCounts {
  read: number;
  search: number;
  edit: number;
  command: number;
}

const OUTPUT_TAIL = 1200;

/**
 * エージェントの作業の記録。Agent が出すイベントを横で聞くだけで、エージェントの動きには一切関わらない。
 * - 実際に読んだ行 (Read の出力、Grep の content 出力)
 * - 検索した内容、実行したコマンドと結果、編集したファイル
 * 「読んだうえで判断したか」をあとから機械的に確かめるための材料になる。
 */
export class Recorder {
  /** 絶対パス → 行番号 (1始まり) → 読んだ時点の内容 */
  readonly reads = new Map<string, Map<number, string>>();
  /** 絶対パス → 見たことのある行の内容 (前後の空白を除く)。編集で行番号がずれても照合できるよう内容で持つ */
  private readonly seen = new Map<string, Set<string>>();
  readonly searches: Array<{ tool: string; pattern: string }> = [];
  readonly commands: CommandRecord[] = [];
  readonly edited = new Set<string>();
  readonly counts: ToolCounts = { read: 0, search: 0, edit: 0, command: 0 };
  /** 最後の応答の文章 (作業の報告、または質問への回答) */
  finalText = '';
  private readonly pending = new Map<string, { name: string; input: any }>();

  /**
   * @param onBeforeWrite Edit / Write が実行される前に、書き込み先の絶対パスで呼ばれる (変更前の内容を控えるため)
   */
  constructor(private cwd: string, private onBeforeWrite?: (file: string) => void) {}

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'tool_start': {
        const input = e.input && typeof e.input === 'object' ? (e.input as any) : {};
        this.pending.set(e.id, { name: e.name, input });
        if ((e.name === 'Edit' || e.name === 'Write') && typeof input.file_path === 'string') {
          this.onBeforeWrite?.(resolvePath(this.cwd, input.file_path));
        }
        break;
      }
      case 'tool_end': {
        const call = this.pending.get(e.id);
        this.pending.delete(e.id);
        if (call) this.finish(call.name, call.input, e.output, e.isError);
        break;
      }
      case 'assistant_end':
        if (e.text.trim()) this.finalText = e.text;
        break;
    }
  }

  private finish(name: string, input: any, output: string, isError: boolean): void {
    switch (name) {
      case 'Read':
        this.counts.read++;
        if (!isError && typeof input.file_path === 'string') this.addRead(resolvePath(this.cwd, input.file_path), output);
        break;
      case 'Grep':
        this.counts.search++;
        this.searches.push({ tool: name, pattern: String(input.pattern ?? '') });
        if (!isError && input.output_mode === 'content') this.addGrep(output);
        break;
      case 'Glob':
        this.counts.search++;
        this.searches.push({ tool: name, pattern: String(input.pattern ?? '') });
        break;
      case 'Edit':
      case 'Write':
        this.counts.edit++;
        if (!isError && typeof input.file_path === 'string') {
          const file = resolvePath(this.cwd, input.file_path);
          this.edited.add(file);
          // 自分で書いた内容は「見た」ものとして扱う
          const text = name === 'Edit' ? String(input.new_string ?? '') : String(input.content ?? '');
          for (const line of text.split(/\r?\n/)) this.see(file, line);
        }
        break;
      case 'Bash':
        this.counts.command++;
        this.commands.push({ command: String(input.command ?? ''), description: String(input.description ?? '').trim(), ok: !isError, output: output.slice(-OUTPUT_TAIL) });
        break;
    }
  }

  /** Read の出力 (`     12\t内容`) から、読んだ行を取り出す */
  private addRead(file: string, output: string): void {
    let map = this.reads.get(file);
    if (!map) this.reads.set(file, (map = new Map()));
    for (const line of output.split('\n')) {
      const m = /^\s*(\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      map.set(Number(m[1]), m[2]);
      this.see(file, m[2]);
    }
  }

  /** Grep (content) の出力 (`パス:行:内容`、前後行は `パス-行-内容`) から、見た行を取り出す */
  private addGrep(output: string): void {
    for (const line of output.split('\n')) {
      const m = /^(.*?)[:-](\d+)[:-](.*)$/.exec(line);
      if (m && path.isAbsolute(m[1])) this.see(m[1], m[3]);
    }
  }

  private see(file: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    let set = this.seen.get(file);
    if (!set) this.seen.set(file, (set = new Set()));
    set.add(t);
  }

  /** その内容の行を、エージェントが見たことがあるか */
  hasSeen(file: string, text: string): boolean {
    return this.seen.get(file)?.has(text.trim()) ?? false;
  }

  /** 見たことのある行すべて (実在する名前かどうかの判定に使う) */
  seenText(): string {
    return [...this.seen.values()].map((s) => [...s].join('\n')).join('\n');
  }

  /** 読んだファイルと行範囲 (連続する行をまとめたもの) */
  readRanges(): Array<{ file: string; ranges: Array<[number, number]> }> {
    const out: Array<{ file: string; ranges: Array<[number, number]> }> = [];
    for (const [file, map] of this.reads) {
      const nums = [...map.keys()].sort((a, b) => a - b);
      const ranges: Array<[number, number]> = [];
      for (const n of nums) {
        const last = ranges[ranges.length - 1];
        if (last && n === last[1] + 1) last[1] = n;
        else ranges.push([n, n]);
      }
      if (ranges.length) out.push({ file, ranges });
    }
    return out;
  }

  /** 範囲 (1始まり、両端含む) のうち、読んだ行の割合 */
  coverage(file: string, start: number, end: number): number {
    const map = this.reads.get(file);
    if (!map || end < start) return 0;
    let hit = 0;
    for (let n = start; n <= end; n++) if (map.has(n)) hit++;
    return hit / (end - start + 1);
  }
}
