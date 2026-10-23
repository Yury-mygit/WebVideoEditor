import { sceneTimeline } from './project';
import type { AudioCut, Cue, Project, Scene } from './types';

/**
 * Вырезы: кусок убирается из ролика целиком — из звука, сцен и субтитров.
 * Звуковой файл не меняется: в проекте хранится список вырезанных кусков по времени записи,
 * а сцены, реплики и длительность ролика сдвигаются сразу, при вырезании.
 */

/** Сортирует и склеивает пересекающиеся и соседние куски. */
export function normalizeCuts(cuts: readonly AudioCut[]): AudioCut[] {
  const sorted = cuts.filter((c) => c.endMs > c.startMs).sort((a, b) => a.startMs - b.startMs);
  const result: AudioCut[] = [];
  for (const c of sorted) {
    const last = result[result.length - 1];
    if (last && c.startMs <= last.endMs) last.endMs = Math.max(last.endMs, c.endMs);
    else result.push({ startMs: Math.max(0, c.startMs), endMs: c.endMs });
  }
  return result;
}

/** Сколько всего вырезано из первых limitMs записи. */
export function cutTotalMs(cuts: readonly AudioCut[], limitMs = Infinity): number {
  return cuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.endMs, limitMs) - c.startMs), 0);
}

/** Время записи → время ролика; момент внутри выреза попадает на место склейки. */
export function audioToVideoMs(cuts: readonly AudioCut[], audioMs: number): number {
  return audioMs - cutTotalMs(cuts, audioMs);
}

/** Время ролика → время записи; на месте склейки — продолжение после выреза. */
export function videoToAudioMs(cuts: readonly AudioCut[], videoMs: number): number {
  let a = videoMs;
  for (const c of cuts) {
    if (c.startMs > a) break;
    a += c.endMs - c.startMs;
  }
  return a;
}

/** Куски записи, из которых складывается звук отрезка ролика [fromMs, fromMs + durationMs). */
export function audioPieces(cuts: readonly AudioCut[], fromMs: number, durationMs: number): AudioCut[] {
  const pieces: AudioCut[] = [];
  let a = videoToAudioMs(cuts, fromMs);
  let rest = durationMs;
  for (const c of cuts) {
    if (rest <= 0) break;
    if (c.endMs <= a) continue;
    const len = Math.min(c.startMs - a, rest);
    if (len > 0) pieces.push({ startMs: a, endMs: a + len });
    rest -= len;
    a = c.endMs;
  }
  if (rest > 0) pieces.push({ startMs: a, endMs: a + rest });
  return pieces;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Убирает из реплик отрезок ролика [from, to): реплики внутри пропадают, задетые укорачиваются, следующие сдвигаются. */
function cutCues(cues: readonly Cue[], from: number, to: number): Cue[] {
  const len = to - from;
  const shift = (ms: number) => (ms <= from ? ms : ms >= to ? ms - len : from);
  return cues.map((c) => ({ ...c, startMs: shift(c.startMs), endMs: shift(c.endMs) })).filter((c) => c.endMs > c.startMs);
}

/** Укорачивает сцены на их часть внутри отрезка [from, to); сцены целиком внутри пропадают. */
function cutScenes(scenes: readonly Scene[], from: number, to: number): Scene[] {
  return sceneTimeline(scenes)
    .map((t) => ({ ...t.scene, durationMs: t.scene.durationMs - overlap(t.startMs, t.endMs, from, to) }))
    .filter((s) => s.durationMs > 0);
}

/**
 * Вырезает кусок [startMs, endMs) по времени записи: он пропадает из звука, субтитров и сцен,
 * ролик становится короче. Уже вырезанные места повторно не считаются.
 */
export function cutProject(project: Project, startMs: number, endMs: number): Project {
  const cuts = project.audioCuts;
  const from = audioToVideoMs(cuts, Math.max(0, startMs));
  const to = audioToVideoMs(cuts, endMs);
  if (to <= from) return project;
  const { durationMs } = project.output;
  return {
    ...project,
    output: { ...project.output, durationMs: durationMs - overlap(0, durationMs, from, to) },
    scenes: cutScenes(project.scenes, from, to),
    subtitles: cutCues(project.subtitles, from, to),
    audioCuts: normalizeCuts([...cuts, { startMs: Math.max(0, startMs), endMs }]),
  };
}

/** Места склеек во времени ролика. */
export function cutMarksMs(cuts: readonly AudioCut[]): number[] {
  return cuts.map((c) => audioToVideoMs(cuts, c.startMs));
}
