export const PROJECT_FORMAT_VERSION = 1;

/** Режим подгонки изображения под кадр (ФТ-15). */
export type FitMode = 'contain' | 'cover' | 'stretch';

/** ФТ-16: резкая смена, плавное перетекание одной картинки в другую или смена через чёрный. */
export type TransitionType = 'cut' | 'crossfade' | 'dip';

export interface Transition {
  type: TransitionType;
  /** Полная длительность перехода; он идёт симметрично относительно границы сцен. */
  durationMs: number;
}

export interface Scene {
  id: string;
  /** Имя файла в папке assets проекта. */
  image: string;
  durationMs: number;
  fit: FitMode;
  /** Цвет полей для режима contain, #rrggbb. */
  padColor: string;
  /** Переход к следующей сцене; не задан — переход проекта по умолчанию. */
  transition?: Transition;
}

export interface TransitionSettings {
  /** Переход между сценами по умолчанию. */
  between: Transition;
  /** Проявление из чёрного в начале ролика, мс (0 — нет). */
  fadeInMs: number;
  /** Затемнение в чёрный в конце ролика, мс (0 — нет). */
  fadeOutMs: number;
  /** Звук нарастает и затихает вместе с проявлением и затемнением. */
  fadeAudio: boolean;
}

/** Реплика субтитров. Перенос строки в тексте — '\n'. */
export interface Cue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export type VerticalPosition = 'bottom' | 'middle' | 'top';
export type HorizontalAlign = 'left' | 'center' | 'right';

export interface SubtitleStyle {
  fontFamily: string;
  /** Размер шрифта в пикселях кадра (как Fontsize в ASS при PlayResY = высоте кадра). */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  outlineWidth: number;
  outlineColor: string;
  shadow: number;
  shadowColor: string;
  /** Полупрозрачная подложка вместо обводки (ASS BorderStyle=3). */
  boxEnabled: boolean;
  boxColor: string;
  /** 0..1 */
  boxOpacity: number;
  boxPadding: number;
  position: VerticalPosition;
  /** Отступ от края кадра по вертикали, px. */
  marginV: number;
  align: HorizontalAlign;
  /** Максимальная ширина текста в % от ширины кадра. */
  maxWidthPct: number;
}

export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export interface ProjectMeta {
  formatVersion: number;
  name: string;
  updatedAt: string;
}

export interface Project {
  meta: ProjectMeta;
  output: OutputSettings;
  scenes: Scene[];
  transitions: TransitionSettings;
  /** Имя аудиофайла в assets; звук идёт с начала ролика. */
  audio: string | null;
  style: SubtitleStyle;
  subtitles: Cue[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/** Фрагмент для тестового рендера (ФТ-64). */
export interface RenderRange {
  startMs: number;
  durationMs: number;
}

export type RenderStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface RenderJobInfo {
  id: string;
  projectId: string;
  status: RenderStatus;
  /** 0..1 */
  progress: number;
  etaSec: number | null;
  elapsedSec: number;
  error: string | null;
  fileName: string | null;
  range: RenderRange | null;
}
