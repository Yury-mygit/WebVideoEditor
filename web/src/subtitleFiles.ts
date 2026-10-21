import {
  buildAss,
  detectFormat,
  parseAss,
  parseSrt,
  parseTxt,
  serializeSrt,
  sortCues,
  withIds,
  type Cue,
  type Project,
} from '@wve/shared';

/** Русские SRT часто сохранены в Windows-1251: если UTF-8 не читается, пробуем её. */
export async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

export async function importSubtitles(file: File, durationMs: number): Promise<Cue[]> {
  const text = await readTextFile(file);
  const format = detectFormat(file.name, text);
  const drafts = format === 'srt' ? parseSrt(text) : format === 'ass' ? parseAss(text) : parseTxt(text, durationMs, 'chars', 200);
  return sortCues(withIds(drafts));
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = (p: Project) => p.meta.name.replace(/[\\/:*?"<>|]+/g, '_') || 'subtitles';

export function exportSrt(project: Project) {
  download(`${baseName(project)}.srt`, '﻿' + serializeSrt(project.subtitles), 'application/x-subrip;charset=utf-8');
}

export function exportAss(project: Project) {
  download(
    `${baseName(project)}.ass`,
    '﻿' + buildAss(project.subtitles, project.style, project.output, project.meta.name),
    'text/plain;charset=utf-8',
  );
}
