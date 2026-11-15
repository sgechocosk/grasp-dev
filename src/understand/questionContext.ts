import { showDiff, type Lesson } from './lesson';
import { truncate } from './lib/text';
import { BLANK, type QuizItem } from './lib/types';
import { blankedCode, emptySecrets, mergeSecrets, type QuestionSecrets, type QuestionTarget } from './question';
import type { Reading } from './reading';

/**
 * 質問に答えるための材料 (質問したカードに、いま画面で見えている内容) と、回答に出してはいけない答えを組み立てる。
 * まだ答え合わせをしていない問いについては、答える前に画面に出ているもの (空欄つきのコード・選択肢) だけを材料にする。
 */

/** 手順の進み具合 (どこまで答え合わせを見せたか) */
export interface WalkProgress {
  index: number;
  answered: boolean;
  final: boolean;
  recap?: 'asked' | 'shown';
}

export interface QuestionContext {
  material: string;
  /** 質問したカードの、まだ答え合わせをしていない問いの答え */
  secrets: QuestionSecrets;
  /** 手順全体の、まだ答え合わせをしていない問いの答え */
  historySecrets: QuestionSecrets;
}

const MAX_MATERIAL_CHARS = 12_000;
const MAX_DIFF_CHARS = 2_500;

/** そのステップ (読みどころ) の答え合わせを、もう見せたか */
export function isRevealed(p: WalkProgress, index: number): boolean {
  return p.final || !!p.recap || index < p.index || (index === p.index && p.answered);
}

/** 空欄に答えを入れたコード */
function filledCode(item: QuizItem): string {
  return item.quizCode.split(BLANK).map((part, i) => (i === 0 ? part : `${item.blanks[i - 1]?.answer ?? ''}${part}`)).join('');
}

function itemMaterial(item: QuizItem, revealed: boolean): string[] {
  const out = [`コード(${item.path}:${item.startLine}):`, revealed ? filledCode(item) : blankedCode(item.quizCode)];
  if (!revealed) {
    item.blanks.forEach((b, k) => {
      const options = (b.value?.labels ?? (b.choices ?? []).map((c) => c.code)).join(' / ');
      out.push(`［${k + 1}］の問い: ${b.value?.ask ?? `${b.concept}: ここに入るコードはどれか`}${options ? `(選択肢: ${options})` : ''}`);
    });
    return out;
  }
  item.blanks.forEach((b, k) => { if (b.why) out.push(`［${k + 1}］が ${b.answer} になる理由: ${b.why}`); });
  if (item.explanation) out.push(`このコードの役割: ${item.explanation}`);
  return out;
}

function itemSecrets(item: QuizItem): QuestionSecrets {
  return { answers: item.blanks.map((b) => b.answer), shown: new Set((item.newNames ?? []).map((n) => n.name)), paths: [] };
}

/** レッスン (変更をたどる手順) の1ステップの、答え合わせ前の答え */
function stepSecrets(lesson: Lesson, index: number): QuestionSecrets {
  const ls = lesson.steps[index];
  if (!ls) return emptySecrets();
  const out = ls.item ? itemSecrets(ls.item) : emptySecrets();
  const q = ls.question;
  if (q && q.form !== 'review') {
    out.answers.push(...q.secret.names);
    out.paths.push(...q.secret.paths);
    if (q.form === 'lines') out.answers.push(...q.correct.map((i) => q.options[i]?.code ?? '').filter(Boolean));
  }
  return out;
}

function stepMaterial(lesson: Lesson, index: number, revealed: boolean): string[] {
  const ls = lesson.steps[index];
  if (!ls) return [];
  const s = ls.step;
  const out = [`ステップ ${s.number}/${lesson.steps.length}: ${revealed ? s.label : ls.display.label}`];
  if (ls.display.purpose) out.push(`目的: ${ls.display.purpose}`);
  if (ls.item) out.push(...itemMaterial(ls.item, revealed));
  // 問いにしなかった変更は、答える前から差分を見せている。問いにした変更の差分 (変更前) は、答え合わせのあとにだけ見せている
  if (!ls.item || revealed) {
    for (const e of s.edits) out.push(`差分(${e.path}${e.created ? ' 新規' : e.deleted ? ' 削除' : ''}):`, truncate(showDiff(e.before, e.after), MAX_DIFF_CHARS));
  }
  const q = ls.question;
  if (q?.form === 'review') {
    out.push(`問い: ${q.prompt}`, ...q.sites.map((x) => `- ${x.label}(${x.path}:${x.line}): ${x.code}${x.why ? ` / 確かめる理由: ${x.why}` : ''}`));
  } else if (q) {
    const options = q.options.map((o) => (typeof o === 'string' ? o : `${o.path}:${o.line} ${o.code}`));
    out.push(`問い: ${q.prompt}`, ...options.map((o) => `- ${o}`));
    if (revealed && q.brief) out.push(`問いの解説: ${q.brief}`);
  }
  if (revealed && s.why) out.push(`変更の理由: ${s.why}`);
  return out;
}

function startMaterial(content: Lesson | Reading): string[] {
  if (content.kind === 'reading') {
    return [`何を理解するか: ${content.goal}`, '読みどころ:', ...content.items.map((it, i) => `${i + 1}. ${it.path}:${it.startLine}`)];
  }
  const out = [`要件: ${content.goal}`];
  if (content.profile.criteria && content.criteria.length) out.push('受け入れ条件:', ...content.criteria.map((c, i) => `${i + 1}. ${c}`));
  out.push('実装するステップ:', ...content.steps.map((ls) => `${ls.step.number}. ${ls.display.label}`));
  return out;
}

function recapMaterial(content: Lesson | Reading, shown: boolean): string[] {
  const recap = content.recap;
  if (!recap) return [];
  const head = content.kind === 'reading' ? '仕組みのまとめ' : '変更の流れのまとめ';
  if (shown) return [`${head}: ${recap.full}`];
  const text = recap.segments.map((seg) => (typeof seg === 'string' ? seg : `［${seg + 1}］`)).join('');
  return [`${head}: ${text}`, ...recap.blanks.map((b, k) => `［${k + 1}］に入る部品の選択肢: ${b.options.join(' / ')}`)];
}

function finalMaterial(lesson: Lesson): string[] {
  const out = ['変更の全体像'];
  if (lesson.overall) out.push(`変更の流れ: ${lesson.overall}`);
  if (lesson.profile.criteria && lesson.criteria.length) out.push('受け入れ条件:', ...lesson.criteria.map((c, i) => `${i + 1}. ${c}`));
  out.push('反映するファイル:', ...lesson.changes.map((c) => `- ${c.rel}${c.before === null ? ' (新規)' : c.after === null ? ' (削除)' : ''}`));
  if (lesson.verification) out.push(`動作確認: ${lesson.verification}`);
  for (const c of lesson.commands) out.push(`- ${c.ok ? '成功' : '失敗'}: ${c.command}${c.description ? ` (${c.description})` : ''}`);
  return out;
}

/** 質問したカードの材料と、回答に出してはいけない答え */
export function questionContext(content: Lesson | Reading, progress: WalkProgress, target: QuestionTarget): QuestionContext {
  const total = content.kind === 'lesson' ? content.steps.length : content.items.length;
  const secretsAt = (i: number): QuestionSecrets =>
    isRevealed(progress, i) ? emptySecrets() : content.kind === 'lesson' ? stepSecrets(content, i) : itemSecrets(content.items[i]!);
  const recapSecrets: QuestionSecrets =
    content.recap && progress.recap !== 'shown' && !progress.final
      ? { answers: content.recap.blanks.map((b) => b.answer), shown: new Set(), paths: content.recap.blanks.filter((b) => b.answer.includes('/')).map((b) => b.answer) }
      : emptySecrets();
  const historySecrets = mergeSecrets(...Array.from({ length: total }, (_, i) => secretsAt(i)), recapSecrets);

  let lines: string[];
  let secrets = emptySecrets();
  switch (target.kind) {
    case 'start':
      lines = startMaterial(content);
      break;
    case 'step': {
      const revealed = isRevealed(progress, target.index);
      lines =
        content.kind === 'lesson'
          ? [`依頼の要件: ${content.goal}`, ...stepMaterial(content, target.index, revealed)]
          : [`何を理解するか: ${content.goal}`, `読みどころ ${target.index + 1}/${total}: ${content.items[target.index]?.task ?? ''}`, ...itemMaterial(content.items[target.index]!, revealed)];
      secrets = secretsAt(target.index);
      break;
    }
    case 'recap':
      lines = recapMaterial(content, progress.recap === 'shown' || progress.final);
      // まとめの答え (部品の名前) は、ステップのカードではコードやファイル名として見えている。
      // それを説明しても答えにはならないので、伏せるのは、まとめのカードで聞かれたときだけにする
      secrets = recapSecrets;
      break;
    case 'final':
      lines = content.kind === 'lesson' ? finalMaterial(content) : [];
      break;
  }
  return { material: truncate(lines.join('\n'), MAX_MATERIAL_CHARS), secrets, historySecrets };
}

/** 画面から届いた質問の対象を確かめる (範囲外なら undefined) */
export function coerceTarget(value: unknown, content: Lesson | Reading): QuestionTarget | undefined {
  const v = value as { kind?: unknown; index?: unknown } | undefined;
  const total = content.kind === 'lesson' ? content.steps.length : content.items.length;
  switch (v?.kind) {
    case 'start':
    case 'recap':
      return { kind: v.kind };
    case 'final':
      return content.kind === 'lesson' ? { kind: 'final' } : undefined;
    case 'step': {
      const index = Number(v.index);
      return Number.isInteger(index) && index >= 0 && index < total ? { kind: 'step', index } : undefined;
    }
    default:
      return undefined;
  }
}
