import { formatHms } from './time';
import { sortCues, totalScenesMs } from './project';
import { layoutSegments } from './segments';
import type { Cue, Project } from './types';

export const MIN_CUE_MS = 1000;
export const MAX_LINE_CHARS = 60;

export type CueIssueKind = 'overlap' | 'short' | 'long-line' | 'out-of-range' | 'empty' | 'inverted';

export const CUE_ISSUE_LABELS: Record<CueIssueKind, string> = {
  overlap: 'Пересекается со следующей репликой',
  short: `Показ короче ${MIN_CUE_MS / 1000} с`,
  'long-line': `Строка длиннее ${MAX_LINE_CHARS} символов`,
  'out-of-range': 'За пределами длительности ролика',
  empty: 'Пустой текст',
  inverted: 'Конец раньше начала',
};

/** ФТ-26: проверки реплик. Возвращает проблемы по id реплики. */
export function cueIssues(cues: readonly Cue[], durationMs: number): Map<string, CueIssueKind[]> {
  const result = new Map<string, CueIssueKind[]>();
  const add = (id: string, kind: CueIssueKind) => {
    const list = result.get(id);
    if (list) list.push(kind);
    else result.set(id, [kind]);
  };
  const sorted = sortCues(cues);
  sorted.forEach((c, i) => {
    if (c.endMs <= c.startMs) add(c.id, 'inverted');
    else if (c.endMs - c.startMs < MIN_CUE_MS) add(c.id, 'short');
    if (!c.text.trim()) add(c.id, 'empty');
    if (c.text.split('\n').some((l) => l.length > MAX_LINE_CHARS)) add(c.id, 'long-line');
    if (c.endMs > durationMs) add(c.id, 'out-of-range');
    const next = sorted[i + 1];
    if (next && next.startMs < c.endMs) add(c.id, 'overlap');
  });
  return result;
}

export interface ProjectIssue {
  level: 'error' | 'warning';
  message: string;
}

/** ФТ-66: проверка проекта перед рендером (без проверки файлов — её делает сервер). */
export function validateProject(project: Project): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const { output, scenes } = project;
  const frameMs = 1000 / output.fps;
  if (output.durationMs <= 0) issues.push({ level: 'error', message: 'Не задана длительность ролика' });
  if (!scenes.length) issues.push({ level: 'error', message: 'Нет ни одной сцены' });
  scenes.forEach((s, i) => {
    if (s.durationMs <= 0) issues.push({ level: 'error', message: `Сцена ${i + 1}: нулевая длительность` });
  });
  const total = totalScenesMs(scenes);
  if (scenes.length && Math.abs(total - output.durationMs) >= frameMs) {
    issues.push({
      level: 'warning',
      message: `Сумма сцен (${formatHms(total)}) не совпадает с длительностью ролика (${formatHms(output.durationMs)})`,
    });
  }
  const { shortened } = layoutSegments(project);
  if (shortened.length) {
    issues.push({
      level: 'warning',
      message: `Сцены короче своих переходов (${shortened.join(', ')}) — переходы будут укорочены`,
    });
  }
  const byKind = new Map<string, number>();
  for (const kinds of cueIssues(project.subtitles, output.durationMs).values()) {
    for (const k of kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) {
    issues.push({ level: 'warning', message: `${CUE_ISSUE_LABELS[kind as keyof typeof CUE_ISSUE_LABELS]}: ${count} реплик(и)` });
  }
  return issues;
}
