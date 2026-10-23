import type { Cue, Cut } from './types';

/**
 * Вырезы — отметки на ленте поверх всех дорожек. Сцены, звук и субтитры остаются как есть;
 * в превью курсор перескакивает вырез, при сборке вырезанное пропускается и ролик становится короче.
 * Время ленты — время звуковой записи; «итоговое» время — время в собранном видео.
 */

/** Длительности затухания у границ выреза, мс; 0 — резко. */
export const CUT_FADES_MS = [0, 500, 1000, 2000, 5000];

/** Сортирует и склеивает пересекающиеся и соседние вырезы; у склеенного — большее затухание. */
export function normalizeCuts(cuts: readonly Cut[]): Cut[] {
  const sorted = cuts
    .map((c): Cut => ({
      startMs: Math.max(0, Math.round(c.startMs)),
      endMs: Math.round(c.endMs),
      ...(c.fadeMs ? { fadeMs: Math.round(c.fadeMs) } : {}),
    }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const result: Cut[] = [];
  for (const c of sorted) {
    const last = result[result.length - 1];
    if (last && c.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, c.endMs);
      const fade = Math.max(last.fadeMs ?? 0, c.fadeMs ?? 0);
      if (fade) last.fadeMs = fade;
    } else result.push(c);
  }
  return result;
}

/**
 * Яркость картинки (0..1) в момент ленты из-за затухания у вырезов:
 * перед вырезом гаснет до чёрного, после — проявляется. Субтитров это не касается.
 */
export function cutFadeLevel(cuts: readonly Cut[], ms: number): number {
  let level = 1;
  for (const c of cuts) {
    const d = c.fadeMs ?? 0;
    if (!d) continue;
    if (ms >= c.startMs - d && ms < c.startMs) level = Math.min(level, (c.startMs - ms) / d);
    else if (ms >= c.endMs && ms < c.endMs + d) level = Math.min(level, (ms - c.endMs) / d);
    else if (ms >= c.startMs && ms < c.endMs) level = 0;
  }
  return level;
}

/** Сколько вырезано из первых limitMs ленты. */
export function cutTotalMs(cuts: readonly Cut[], limitMs = Infinity): number {
  return cuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.endMs, limitMs) - c.startMs), 0);
}

/** Длина собранного видео. */
export function finalDurationMs(cuts: readonly Cut[], durationMs: number): number {
  return durationMs - cutTotalMs(cuts, durationMs);
}

/** Вырез, внутри которого момент ленты (конец выреза уже не внутри). */
export function cutAt(cuts: readonly Cut[], ms: number): Cut | null {
  return cuts.find((c) => ms >= c.startMs && ms < c.endMs) ?? null;
}

/** Время ленты → время в видео; момент внутри выреза попадает на место склейки. */
export function toFinalMs(cuts: readonly Cut[], ms: number): number {
  return ms - cutTotalMs(cuts, ms);
}

/** Время в видео → время ленты; на месте склейки — продолжение после выреза. */
export function fromFinalMs(cuts: readonly Cut[], finalMs: number): number {
  let a = finalMs;
  for (const c of cuts) {
    if (c.startMs > a) break;
    a += c.endMs - c.startMs;
  }
  return a;
}

/** Куски ленты, из которых складывается отрезок видео [fromFinalMs, fromFinalMs + durationMs). */
export function keptPieces(cuts: readonly Cut[], fromFinal: number, durationMs: number): Cut[] {
  const pieces: Cut[] = [];
  let a = fromFinalMs(cuts, fromFinal);
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

/** Реплики во времени видео: внутри выреза пропадают, задетые укорачиваются, следующие сдвигаются. */
export function cuesAfterCuts(cues: readonly Cue[], cuts: readonly Cut[]): Cue[] {
  if (!cuts.length) return [...cues];
  return cues
    .map((c) => ({ ...c, startMs: toFinalMs(cuts, c.startMs), endMs: toFinalMs(cuts, c.endMs) }))
    .filter((c) => c.endMs > c.startMs);
}
