import { newId } from './id';
import { msToFrame } from './time';
import {
  PROJECT_FORMAT_VERSION,
  type Cue,
  type OutputSettings,
  type Project,
  type RenderRange,
  type Scene,
  type SubtitleStyle,
  type Transition,
  type TransitionSettings,
} from './types';

export const DEFAULT_DURATION_MS = 90 * 60 * 1000;

export const RESOLUTIONS = [
  { label: '1920×1080 (Full HD)', width: 1920, height: 1080 },
  { label: '1280×720 (HD)', width: 1280, height: 720 },
  { label: '3840×2160 (4K)', width: 3840, height: 2160 },
] as const;

export const DEFAULT_STYLE: SubtitleStyle = {
  fontFamily: 'PT Sans',
  fontSize: 54,
  bold: false,
  italic: false,
  color: '#ffffff',
  outlineWidth: 3,
  outlineColor: '#000000',
  shadow: 1,
  shadowColor: '#000000',
  boxEnabled: false,
  boxColor: '#000000',
  boxOpacity: 0.5,
  boxPadding: 10,
  position: 'bottom',
  marginV: 60,
  align: 'center',
  maxWidthPct: 85,
};

export const DEFAULT_OUTPUT: OutputSettings = {
  width: 1920,
  height: 1080,
  fps: 25,
  durationMs: DEFAULT_DURATION_MS,
};

/** По умолчанию переходов нет — старые проекты собираются как раньше. */
export const DEFAULT_TRANSITIONS: TransitionSettings = {
  fadeInMs: 0,
  fadeOutMs: 0,
  fadeAudio: true,
};

export function createProject(name: string): Project {
  return {
    meta: { formatVersion: PROJECT_FORMAT_VERSION, name, updatedAt: new Date().toISOString() },
    output: { ...DEFAULT_OUTPUT },
    scenes: [],
    transitions: { ...DEFAULT_TRANSITIONS },
    audio: null,
    style: { ...DEFAULT_STYLE },
    subtitles: [],
  };
}

/** Дополняет загруженный проект значениями по умолчанию (на случай старого формата). */
export function normalizeProject(p: Partial<Project> & { meta?: Partial<Project['meta']> }): Project {
  const base = createProject(p.meta?.name ?? 'Без названия');
  // Ранний формат хранил общий переход между сценами — переносим его в сцены, у которых своего нет.
  const { between, ...transitions } = (p.transitions ?? {}) as Partial<TransitionSettings> & { between?: Transition };
  const scenes = (p.scenes ?? []).map((s, i, all) =>
    between && between.type !== 'cut' && !s.transition && i < all.length - 1 ? { ...s, transition: { ...between } } : s,
  );
  return {
    meta: { ...base.meta, ...p.meta },
    output: { ...base.output, ...p.output },
    scenes,
    transitions: { ...base.transitions, ...transitions },
    audio: p.audio ?? null,
    style: { ...base.style, ...p.style },
    subtitles: p.subtitles ?? [],
  };
}

export function createScene(image: string, durationMs: number): Scene {
  return { id: newId(), image, durationMs, fit: 'cover', padColor: '#000000' };
}

export interface TimedScene {
  scene: Scene;
  index: number;
  startMs: number;
  endMs: number;
}

export function sceneTimeline(scenes: readonly Scene[]): TimedScene[] {
  let t = 0;
  return scenes.map((scene, index) => {
    const startMs = t;
    t += scene.durationMs;
    return { scene, index, startMs, endMs: t };
  });
}

export function totalScenesMs(scenes: readonly Scene[]): number {
  return scenes.reduce((sum, s) => sum + s.durationMs, 0);
}

export function sceneAt(scenes: readonly Scene[], timeMs: number): TimedScene | null {
  const tl = sceneTimeline(scenes);
  return tl.find((t) => timeMs >= t.startMs && timeMs < t.endMs) ?? tl[tl.length - 1] ?? null;
}

/** ФТ-13: поделить длительность ролика поровну между сценами (с точностью до кадра). */
export function splitEvenly(scenes: readonly Scene[], output: OutputSettings): Scene[] {
  const n = scenes.length;
  if (!n) return [];
  const totalFrames = msToFrame(output.durationMs, output.fps);
  let prevMs = 0;
  return scenes.map((s, i) => {
    const endFrame = Math.round((totalFrames * (i + 1)) / n);
    const endMs = i === n - 1 ? output.durationMs : Math.round((endFrame * 1000) / output.fps);
    const durationMs = endMs - prevMs;
    prevMs = endMs;
    return { ...s, durationMs };
  });
}

/** ФТ-14: подогнать последнюю сцену так, чтобы сумма совпала с длительностью ролика. */
export function fitLastScene(scenes: readonly Scene[], durationMs: number): Scene[] {
  if (!scenes.length) return [];
  const rest = totalScenesMs(scenes.slice(0, -1));
  const last = scenes[scenes.length - 1];
  return [...scenes.slice(0, -1), { ...last, durationMs: Math.max(0, durationMs - rest) }];
}

export function cueAt(cues: readonly Cue[], timeMs: number): Cue[] {
  return cues.filter((c) => timeMs >= c.startMs && timeMs < c.endMs);
}

export function sortCues(cues: readonly Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * ФТ-64: «вырезает» из проекта фрагмент для тестового рендера —
 * сцены обрезаются по границам фрагмента, реплики сдвигаются к нулю.
 */
export function sliceProject(project: Project, range: RenderRange): Project {
  const from = Math.max(0, range.startMs);
  const to = Math.min(project.output.durationMs, from + range.durationMs);
  const scenes: Scene[] = [];
  for (const t of sceneTimeline(project.scenes)) {
    const s = Math.max(t.startMs, from);
    const e = Math.min(t.endMs, to);
    if (e > s) scenes.push({ ...t.scene, durationMs: e - s });
  }
  const subtitles = project.subtitles
    .filter((c) => c.endMs > from && c.startMs < to)
    .map((c) => ({ ...c, startMs: Math.max(0, c.startMs - from), endMs: Math.min(to, c.endMs) - from }));
  return { ...project, output: { ...project.output, durationMs: to - from }, scenes, subtitles };
}
