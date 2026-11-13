import * as fs from 'node:fs/promises';
import type { AgentEvent, ConversationState } from '../core/types';
import { Baseline, staleFiles, writeState, type FileChange } from './changeSet';
import { WorkspaceView } from './impact';
import { buildLesson, finalPayload, plainLesson, revealPayload, startPayload, stepPayload, type Lesson, type StepAnswer } from './lesson';
import type { LearnerLevel } from './lib/level';
import type { Asker } from './llm';
import { buildReading, readingRevealPayload, readingStartPayload, readingStepPayload, type Reading } from './reading';
import { Recorder } from './recorder';

/** 画面へ送る、たどる手順の1コマ。walk は手順ごとの通し番号 */
export type WalkMessage =
  | { type: 'walk_start'; walk: number; view: Record<string, unknown> }
  | { type: 'walk_step'; walk: number; view: Record<string, unknown> }
  | { type: 'walk_reveal'; walk: number; view: Record<string, unknown> }
  | { type: 'walk_final'; walk: number; view: Record<string, unknown> }
  | { type: 'walk_error'; walk: number; message: string }
  | { type: 'walk_done'; walk: number; outcome: 'applied' | 'discarded' | 'read' | 'continued'; message: string };

export interface SessionOptions {
  cwd: string;
  state: ConversationState;
  rgPath?: string | null;
  post: (message: WalkMessage) => void;
  status: (text: string) => void;
}

export interface EndRunOptions {
  /** 利用者の依頼文 */
  request: string;
  asker: Asker;
  level: LearnerLevel;
  signal: AbortSignal;
  /** 中断・エラーで作業が途中で止まった */
  failed: boolean;
}

interface Walk {
  id: number;
  content: Lesson | Reading;
  index: number;
  answered: boolean;
  final: boolean;
}

/**
 * 「実装は今までどおり最後まで行い、確定した変更を取り置いて、利用者がたどり終えてから反映する」流れの進行役。
 * - 実行前: 変更前の状態を控える (取り置き中の変更があれば戻してから続ける)
 * - 実行中: Agent のイベントを記録するだけ (エージェントの入力・ツール・ループには関わらない)
 * - 実行後: 変わったファイルを集めて変更前に戻し、手順と問いを組み立てて提示する
 * - たどり終えたら: 取り置いた変更をまとめて反映する
 */
export class UnderstandSession {
  private baseline?: Baseline;
  private recorder?: Recorder;
  private held?: { changes: FileChange[]; unheld: string[] };
  private walk?: Walk;
  private walkCount = 0;
  private note = '';

  constructor(private o: SessionOptions) {}

  /** 取り置いている変更があるか */
  get holding(): boolean {
    return !!this.held;
  }

  /** たどっている途中の手順があるか */
  get walking(): boolean {
    return !!this.walk;
  }

  /** 次の依頼の前に、モデルへ伝えること (変更を破棄したとき)。読むと消える */
  takeNote(): string {
    const n = this.note;
    this.note = '';
    return n;
  }

  /** 実行の前に呼ぶ。続けられないときは例外 (その理由を利用者に見せる) */
  async beginRun(): Promise<void> {
    if (this.walk && this.walk.content.kind === 'reading') this.finishReading('問いを途中で終えて、回答を表示します。');
    if (this.held) {
      // モデルは「変更済み」のつもりで続きを書くので、取り置いた変更を戻してから実行する
      const stale = await staleFiles(this.held.changes, 'before');
      if (stale.length > 0) {
        throw new Error(`取り置いた変更の対象ファイルが、その後に書き換えられています: ${stale.join(', ')}。元に戻すか、取り置いた変更を破棄してから続けてください。`);
      }
      await writeState(this.held.changes, 'after');
      await this.syncFileState(this.held.changes);
      this.held = undefined;
      if (this.walk) this.closeWalk('continued', '作業を続けます。終わったら、変更全体をあらためてたどります。');
    }
    this.baseline ??= await Baseline.capture(this.o.cwd);
    const baseline = this.baseline;
    this.recorder = new Recorder(this.o.cwd, (file) => baseline.note(file));
  }

  /** Agent のイベントを記録する */
  record(e: AgentEvent): void {
    this.recorder?.onEvent(e);
  }

  get counts() {
    return this.recorder?.counts;
  }

  /**
   * 実行の後に呼ぶ。たどる手順を始めたら true。
   * false のときは見せるものが無い (変更も、読んだコードも無い) ので、回答をそのまま表示する。
   */
  async endRun(opts: EndRunOptions): Promise<boolean> {
    const { baseline, recorder } = this;
    if (!baseline || !recorder) return false;
    const { changes, unheld, committed } = await baseline.collect();
    if (changes.length === 0) {
      this.baseline = undefined;
      if (opts.failed) return false;
      const reading = await buildReading({ cwd: this.o.cwd, request: opts.request, recorder, asker: opts.asker, level: opts.level, signal: opts.signal, onStatus: this.o.status })
        .catch(() => undefined);
      if (!reading) return false;
      this.walk = { id: ++this.walkCount, content: reading, index: 0, answered: false, final: false };
      this.o.post({ type: 'walk_start', walk: this.walk.id, view: readingStartPayload(reading) });
      this.postStep();
      return true;
    }

    await writeState(changes, 'before');
    this.held = { changes, unheld };
    const base = { cwd: this.o.cwd, request: opts.request, changes, unheld, recorder };
    let lesson: Lesson;
    if (opts.failed) {
      lesson = plainLesson(base, '作業が途中で止まったため、手順は組み立てていません。ここまでの変更を確認して、反映するか破棄するかを選んでください。');
    } else {
      try {
        const view = await WorkspaceView.load(this.o.cwd, changes, { rgPath: this.o.rgPath, signal: opts.signal });
        lesson = await buildLesson({ ...base, view, asker: opts.asker, level: opts.level, signal: opts.signal, onStatus: this.o.status });
      } catch (e) {
        lesson = plainLesson(base, `手順を組み立てられなかったため、変更の差分をそのまま示します(${(e as Error)?.message ?? e})。`);
      }
    }
    if (committed) {
      lesson.notice = [lesson.notice, '作業の中でコミットが行われています。変更を破棄しても、そのコミットは残ります。'].filter(Boolean).join('\n');
    }
    this.walk = { id: ++this.walkCount, content: lesson, index: 0, answered: false, final: false };
    this.o.post({ type: 'walk_start', walk: this.walk.id, view: startPayload(lesson) });
    if (lesson.steps.length > 0) this.postStep();
    else this.postFinal();
    return true;
  }

  private total(walk: Walk): number {
    return walk.content.kind === 'lesson' ? walk.content.steps.length : walk.content.items.length;
  }

  private postStep(): void {
    const walk = this.walk!;
    const c = walk.content;
    walk.answered = false;
    this.o.post({ type: 'walk_step', walk: walk.id, view: c.kind === 'lesson' ? stepPayload(c, walk.index) : readingStepPayload(c, walk.index) });
    // 問いの無いステップ (差分だけ見せるもの) は、そのまま影響の追い方まで見せる
    if (c.kind === 'lesson' && !c.steps[walk.index].item && !c.steps[walk.index].question) this.answer(walk.index, { blanks: [], next: [] });
  }

  private postFinal(): void {
    const walk = this.walk!;
    walk.final = true;
    if (walk.content.kind === 'lesson') this.o.post({ type: 'walk_final', walk: walk.id, view: finalPayload(walk.content) });
  }

  /** 利用者の答えを受けて、答え合わせを見せる */
  answer(index: number, answer: StepAnswer): void {
    const walk = this.walk;
    if (!walk || walk.final || walk.answered || index !== walk.index) return;
    walk.answered = true;
    const a: StepAnswer = { blanks: Array.isArray(answer?.blanks) ? answer.blanks.map(Number) : [], next: Array.isArray(answer?.next) ? answer.next.map(Number) : [] };
    const c = walk.content;
    this.o.post({ type: 'walk_reveal', walk: walk.id, view: c.kind === 'lesson' ? revealPayload(c, index, a) : readingRevealPayload(c, index, a) });
  }

  /** 答え合わせのあと、次のステップ (無ければまとめ) へ進む */
  next(): void {
    const walk = this.walk;
    if (!walk || walk.final || !walk.answered) return;
    walk.index++;
    if (walk.index < this.total(walk)) this.postStep();
    else if (walk.content.kind === 'lesson') this.postFinal();
    else this.finishReading('');
  }

  private finishReading(message: string): void {
    this.closeWalk('read', message);
  }

  private closeWalk(outcome: 'applied' | 'discarded' | 'read' | 'continued', message: string): void {
    const walk = this.walk;
    if (!walk) return;
    this.walk = undefined;
    this.o.post({ type: 'walk_done', walk: walk.id, outcome, message });
  }

  /** たどり終えた変更を、まとめてファイルに反映する */
  async apply(): Promise<void> {
    const walk = this.walk;
    if (!walk || !this.held || !walk.final) return;
    const stale = await staleFiles(this.held.changes, 'before');
    if (stale.length > 0) {
      this.o.post({ type: 'walk_error', walk: walk.id, message: `手順を作ったあとに書き換えられたファイルがあるため、反映しませんでした: ${stale.join(', ')}。元に戻してからもう一度反映するか、破棄してください。` });
      return;
    }
    const { changes } = this.held;
    await writeState(changes, 'after');
    await this.syncFileState(changes);
    this.held = undefined;
    this.baseline = undefined;
    this.closeWalk('applied', `${changes.length}個のファイルに変更を反映しました。`);
  }

  /** 取り置いた変更を捨てる (ファイルは変更前のまま) */
  async discard(): Promise<void> {
    if (!this.held) return;
    for (const c of this.held.changes) this.o.state.fileState.delete(c.path);
    this.note =
      'Note: the user reviewed and DISCARDED all file changes made in the previous task. The workspace files are back in their original state, ' +
      'so those changes do not exist. Read files again before editing them.';
    this.held = undefined;
    this.baseline = undefined;
    this.closeWalk('discarded', '変更を破棄しました。');
  }

  /**
   * 書き戻したファイルは更新日時が変わる。内容はモデルが最後に見たものと同じなので、
   * 「読んだあとに外から変更された」と誤って判定されないよう、読んだ時点の記録を合わせる。
   */
  private async syncFileState(changes: FileChange[]): Promise<void> {
    const { fileState } = this.o.state;
    for (const c of changes) {
      if (!fileState.has(c.path)) continue;
      const stat = c.after === null ? undefined : await fs.stat(c.path).catch(() => undefined);
      if (stat) fileState.set(c.path, stat.mtimeMs);
      else fileState.delete(c.path);
    }
  }
}
