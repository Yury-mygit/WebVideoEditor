import { formatAssTime } from './time';
import type { Cue, OutputSettings, SubtitleStyle } from './types';

/** #rrggbb + прозрачность (0 — непрозрачно, 1 — прозрачно) → &HAABBGGRR */
export function assColor(hex: string, transparency = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = m ? [m[1], m[2], m[3]] : ['ff', 'ff', 'ff'];
  const a = Math.round(Math.min(1, Math.max(0, transparency)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

export function assAlignment(style: SubtitleStyle): number {
  const row = { bottom: 0, middle: 3, top: 6 }[style.position];
  const col = { left: 1, center: 2, right: 3 }[style.align];
  return row + col;
}

/** Боковые поля, задающие максимальную ширину текста (ФТ-32). */
export function horizontalMargin(style: SubtitleStyle, width: number): number {
  const pct = Math.min(100, Math.max(10, style.maxWidthPct));
  return Math.round((width * (100 - pct)) / 200);
}

/** Экранирует текст реплики: фигурные скобки и обратный слэш иначе трактуются как разметка ASS. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '⧵')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Генерирует ASS-файл из данных проекта. PlayRes совпадает с разрешением вывода,
 * поэтому все размеры стиля — в пикселях итогового кадра. WrapStyle=1 — перенос по
 * концу строки (жадный), его же повторяет превью.
 */
export function buildAss(cues: readonly Cue[], style: SubtitleStyle, output: OutputSettings, title = 'SlideSub'): string {
  const margin = horizontalMargin(style, output.width);
  const box = style.boxEnabled;
  const fields = [
    'Default',
    style.fontFamily.replace(/,/g, ' '),
    style.fontSize,
    assColor(style.color),
    assColor(style.color),
    box ? assColor(style.boxColor, 1 - style.boxOpacity) : assColor(style.outlineColor),
    box ? assColor(style.boxColor, 1 - style.boxOpacity) : assColor(style.shadowColor, 0.4),
    style.bold ? -1 : 0,
    style.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    0,
    0,
    box ? 3 : 1,
    box ? style.boxPadding : style.outlineWidth,
    box ? 0 : style.shadow,
    assAlignment(style),
    margin,
    margin,
    style.marginV,
    1,
  ];
  const events = [...cues]
    .filter((c) => c.endMs > c.startMs && c.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((c) => `Dialogue: 0,${formatAssTime(c.startMs)},${formatAssTime(c.endMs)},Default,,0,0,0,,${escapeAssText(c.text)}`);

  return [
    '[Script Info]',
    `Title: ${title.replace(/[\r\n]/g, ' ')}`,
    'ScriptType: v4.00+',
    'WrapStyle: 1',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${fields.join(',')}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
