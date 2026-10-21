const pad = (n: number, len = 2) => String(n).padStart(len, '0');

function split(ms: number) {
  const total = Math.max(0, Math.round(ms));
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor((total % 3_600_000) / 60_000),
    s: Math.floor((total % 60_000) / 1000),
    ms: total % 1000,
  };
}

/** 01:02:03 */
export function formatHms(ms: number): string {
  const t = split(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
}

/** 01:02:03,456 — формат SRT. */
export function formatSrtTime(ms: number): string {
  const t = split(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)},${pad(t.ms, 3)}`;
}

/** 1:02:03.45 — формат ASS (сотые доли). */
export function formatAssTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/**
 * Разбирает время в форматах «чч:мм:сс[,.]ммм», «мм:сс», «сс», «1:02:03.45».
 * Возвращает null, если строка не похожа на время.
 */
export function parseTime(input: string): number | null {
  const str = input.trim().replace(',', '.');
  if (!str) return null;
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/.exec(str);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, mi, s] = parts;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((h * 60 + mi) * 60 + s) * 1000 + frac;
}

/** Номер кадра, на который попадает момент времени. */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms * fps) / 1000);
}
