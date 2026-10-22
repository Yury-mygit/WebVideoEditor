import { sceneTimeline } from './project';
import { msToFrame } from './time';
import type { Project, Scene, Transition } from './types';

/**
 * ФТ-16: раскладка ролика на отрезки — единственное место, где считаются переходы.
 * По ней собирается видео, режется тестовый фрагмент и рисуется превью.
 *
 * still — картинка без изменений; mix — смешивание from → to (null — чёрный кадр),
 * на k-м кадре отрезка доля to равна p0 + step·k. Всё считается в кадрах,
 * поэтому границы сцен остаются точными до кадра, а переходы их не сдвигают.
 */
export type Segment =
  | { kind: 'still'; scene: Scene; frames: number }
  | { kind: 'mix'; from: Scene | null; to: Scene | null; frames: number; p0: number; step: number };

export interface SegmentLayout {
  segments: Segment[];
  /** Номера сцен (с 1), которые короче своих переходов: переходы пришлось укоротить. */
  shortened: number[];
}

const CUT: Transition = { type: 'cut', durationMs: 0 };

/** Переход после сцены; не задан — резкая смена. */
export function sceneTransition(scene: Scene): Transition {
  return scene.transition ?? CUT;
}

export function layoutSegments(project: Project): SegmentLayout {
  const { fps, durationMs } = project.output;
  const toFrames = (ms: number) => Math.max(0, msToFrame(ms, fps));
  // Сцены за концом ролика обрезаются: затемнение всегда приходится на его настоящий конец.
  const items = sceneTimeline(project.scenes)
    .map((t) => ({
      scene: t.scene,
      index: t.index,
      len: msToFrame(Math.min(t.endMs, durationMs), fps) - msToFrame(t.startMs, fps),
    }))
    .filter((s) => s.len > 0);
  const n = items.length;
  if (!n) return { segments: [], shortened: [] };

  // Сколько кадров перехода приходится на начало (inc) и конец (out) каждой сцены.
  // Переход между сценами делится пополам относительно границы.
  const inc = new Array<number>(n).fill(0);
  const out = new Array<number>(n).fill(0);
  inc[0] = toFrames(project.transitions.fadeInMs);
  out[n - 1] = toFrames(project.transitions.fadeOutMs);
  for (let i = 0; i < n - 1; i++) {
    const t = sceneTransition(items[i].scene);
    const d = t.type === 'cut' ? 0 : toFrames(t.durationMs);
    out[i] = Math.floor(d / 2);
    inc[i + 1] = d - out[i];
  }
  const shortened: number[] = [];
  for (let i = 0; i < n; i++) {
    const need = inc[i] + out[i];
    if (need <= items[i].len) continue;
    inc[i] = Math.floor((items[i].len * inc[i]) / need);
    out[i] = items[i].len - inc[i];
    shortened.push(items[i].index + 1);
  }

  const segments: Segment[] = [];
  const still = (scene: Scene, frames: number) => frames > 0 && segments.push({ kind: 'still', scene, frames });
  const mix = (from: Scene | null, to: Scene | null, frames: number, p0: number, step: number) =>
    frames > 0 && segments.push({ kind: 'mix', from, to, frames, p0, step });

  // Проявление: первый кадр ролика чёрный.
  mix(null, items[0].scene, inc[0], 0, 1 / inc[0]);
  for (let i = 0; i < n; i++) {
    const { scene, len } = items[i];
    still(scene, len - inc[i] - out[i]);
    if (i === n - 1) break;
    const next = items[i + 1].scene;
    const a = out[i];
    const b = inc[i + 1];
    if (sceneTransition(scene).type === 'crossfade') {
      // Ни один кадр перехода не совпадает с соседними статичными — доли от 1/(d+1) до d/(d+1).
      mix(scene, next, a + b, 1 / (a + b + 1), 1 / (a + b + 1));
    } else {
      // Через чёрный: последний кадр первой половины и первый кадр второй — чёрные.
      mix(scene, null, a, 1 / a, 1 / a);
      mix(null, next, b, 0, 1 / b);
    }
  }
  // Затемнение: последний кадр ролика чёрный.
  const last = out[n - 1];
  mix(items[n - 1].scene, null, last, 1 / last, 1 / last);
  return { segments, shortened };
}

export function buildSegments(project: Project): Segment[] {
  return layoutSegments(project).segments;
}

export function segmentsFrames(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + s.frames, 0);
}

/** ФТ-64: кадры [fromFrame, toFrame) для тестового фрагмента; переход, попавший на край, продолжается с нужной доли. */
export function sliceSegments(segments: readonly Segment[], fromFrame: number, toFrame: number): Segment[] {
  const result: Segment[] = [];
  let pos = 0;
  for (const s of segments) {
    const a = Math.max(pos, fromFrame);
    const b = Math.min(pos + s.frames, toFrame);
    if (b > a) result.push(s.kind === 'mix' ? { ...s, frames: b - a, p0: s.p0 + s.step * (a - pos) } : { ...s, frames: b - a });
    pos += s.frames;
  }
  return result;
}

export interface FrameLook {
  /** Нижний слой (null — чёрный). */
  from: Scene | null;
  /** Верхний слой (null — чёрный), рисуется с непрозрачностью p. */
  to: Scene | null;
  p: number;
}

/** Что видно на кадре с номером frame (за концом ролика — последний кадр). */
export function frameAt(segments: readonly Segment[], frame: number): FrameLook | null {
  let pos = 0;
  for (const s of segments) {
    if (frame < pos + s.frames || s === segments[segments.length - 1]) {
      const k = Math.min(Math.max(0, frame - pos), s.frames - 1);
      return s.kind === 'still'
        ? { from: s.scene, to: null, p: 0 }
        : { from: s.from, to: s.to, p: Math.min(1, Math.max(0, s.p0 + s.step * k)) };
    }
    pos += s.frames;
  }
  return null;
}
