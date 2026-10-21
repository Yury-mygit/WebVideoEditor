import { formatSrtTime, parseTime } from './time';
import type { Cue } from './types';

export type CueDraft = Omit<Cue, 'id'>;

const newId = () => globalThis.crypto.randomUUID();

export function withIds(drafts: CueDraft[]): Cue[] {
  return drafts.map((d) => ({ id: newId(), ...d }));
}

function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** ФТ-20: импорт SRT. Терпим к лишним пустым строкам и отсутствующим номерам. */
export function parseSrt(input: string): CueDraft[] {
  const blocks = normalizeNewlines(input).split(/\n{2,}/);
  const cues: CueDraft[] = [];
  const timing = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ''));
    const idx = lines.findIndex((l) => timing.test(l));
    if (idx < 0) continue;
    const m = timing.exec(lines[idx])!;
    const startMs = parseTime(m[1]);
    const endMs = parseTime(m[2]);
    if (startMs === null || endMs === null) continue;
    const text = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .trim();
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

export function serializeSrt(cues: readonly CueDraft[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}

/** ФТ-20: импорт ASS/SSA — берём строки Dialogue, убираем теги оформления. */
export function parseAss(input: string): CueDraft[] {
  const lines = normalizeNewlines(input).split('\n');
  let fields: string[] = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  let inEvents = false;
  const cues: CueDraft[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = line.toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    if (line.startsWith('Format:')) {
      fields = line.slice(7).split(',').map((f) => f.trim());
      continue;
    }
    if (!line.startsWith('Dialogue:')) continue;
    const values = line.slice(9).trim().split(',');
    const textIdx = fields.indexOf('Text');
    const head = values.slice(0, textIdx);
    const text = values.slice(textIdx).join(',');
    const startMs = parseTime(head[fields.indexOf('Start')] ?? '');
    const endMs = parseTime(head[fields.indexOf('End')] ?? '');
    if (startMs === null || endMs === null) continue;
    cues.push({
      startMs,
      endMs,
      text: text
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/gi, '\n')
        .replace(/\\h/g, ' ')
        .trim(),
    });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

export type TxtTimingMode = 'even' | 'chars';

/**
 * ФТ-20: импорт TXT — одна непустая строка = одна реплика.
 * Тайминги расставляются равномерно или пропорционально количеству символов.
 */
export function parseTxt(input: string, totalMs: number, mode: TxtTimingMode = 'chars', gapMs = 0): CueDraft[] {
  const texts = normalizeNewlines(input)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!texts.length || totalMs <= 0) return [];
  const weights = texts.map((t) => (mode === 'chars' ? Math.max(t.length, 1) : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return texts.map((text, i) => {
    const startMs = Math.round((acc / sum) * totalMs);
    acc += weights[i];
    const endMs = Math.round((acc / sum) * totalMs);
    return { startMs, endMs: Math.max(startMs, endMs - gapMs), text };
  });
}

export type SubtitleFormat = 'srt' | 'ass' | 'txt';

export function detectFormat(fileName: string, content: string): SubtitleFormat {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'srt' || ext === 'ass' || ext === 'ssa') return ext === 'ssa' ? 'ass' : ext;
  if (/^\s*\[Script Info\]/i.test(content)) return 'ass';
  if (/-->/.test(content)) return 'srt';
  return 'txt';
}
