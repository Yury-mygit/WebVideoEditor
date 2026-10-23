import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSegments,
  CUT_FADES_MS,
  cutAt,
  finalDurationMs,
  formatHms,
  normalizeCuts,
  sceneTimeline,
  type Cut,
  type Project,
} from '@wve/shared';
import { assetLabel } from '../audio';
import type { UpdateProject } from '../editor';
import { TimeInput } from './TimeInput';

interface Props {
  project: Project;
  timeMs: number;
  onSeek: (ms: number) => void;
  selectedIds: ReadonlySet<string>;
  issueIds: ReadonlySet<string>;
  audioDurationMs: number | null;
  update: UpdateProject;
}

const ZOOMS = [
  { label: 'Весь ролик', ms: 0 },
  { label: '10 мин', ms: 600_000 },
  { label: '2 мин', ms: 120_000 },
  { label: '30 с', ms: 30_000 },
];

const SCENE_COLORS = ['#3b6ea8', '#5a8f4e', '#a8823b', '#8a4fa0', '#3b9a9a', '#a04f5e'];
const ROW_SCENES = 22;
const ROW_AUDIO = 16;
const ROW_CUES = 30;
const BASE_HEIGHT = 8 + ROW_SCENES + 6 + ROW_CUES + 18;

/** Текст, обрезанный по ширине блока (а не сжатый, как при fillText с maxWidth). */
function clippedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillText(text, x, y + h / 2);
  ctx.restore();
}

/** Штриховка выреза: косые линии поверх затемнения. */
function hatch(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.fillStyle = 'rgba(20,20,20,0.55)';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(255,210,74,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = x0 - h; d < x0 + w; d += 8) {
    ctx.moveTo(d, y0 + h);
    ctx.lineTo(d + h, y0);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * ФТ-51: полоса сцен, звуковая дорожка (если есть) и полоса реплик; клик перемещает позицию.
 * Вырезы заштрихованы поверх всех дорожек; начало и конец выреза ставятся по курсору кнопками над лентой.
 */
export function Timeline({ project, timeMs, onSeek, selectedIds, issueIds, audioDurationMs, update }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(ZOOMS[0].ms);
  const [width, setWidth] = useState(800);
  /** Начало нового выреза, пока не поставлен конец. */
  const [cutStart, setCutStart] = useState<number | null>(null);
  /** Выбранный вырез — по его началу (начала у вырезов не повторяются). */
  const [selectedCut, setSelectedCut] = useState<number | null>(null);
  const { cuts } = project;
  const selected = cuts.find((c) => c.startMs === selectedCut) ?? null;
  const total = Math.max(1, project.output.durationMs);
  const audioRow = project.audio ? ROW_AUDIO + 4 : 0;
  const height = BASE_HEIGHT + audioRow;
  const segments = useMemo(() => buildSegments(project), [project.scenes, project.transitions, project.output]);

  // Видимое окно: весь ролик или окно вокруг текущей позиции.
  const span = zoom && zoom < total ? zoom : total;
  const viewStart = span === total ? 0 : Math.min(Math.max(0, timeMs - span / 2), total - span);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const x = (ms: number) => ((ms - viewStart) / span) * width;
    const viewEnd = viewStart + span;

    const yScenes = 8;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const t of sceneTimeline(project.scenes)) {
      if (t.endMs < viewStart || t.startMs > viewEnd) continue;
      const x0 = Math.max(0, x(t.startMs));
      const x1 = Math.min(width, x(t.endMs));
      ctx.fillStyle = SCENE_COLORS[t.index % SCENE_COLORS.length];
      ctx.fillRect(x0, yScenes, Math.max(1, x1 - x0 - 1), ROW_SCENES);
      ctx.fillStyle = '#fff';
      if (x1 - x0 > 30) clippedText(ctx, `Сцена ${t.index + 1}`, x0 + 6, yScenes, x1 - x0 - 10, ROW_SCENES);
    }

    // Переходы поверх сцен: плавный — светлая полоса, через чёрный — затемнение к чёрному краю.
    const { fps } = project.output;
    let frame = 0;
    for (const s of segments) {
      const startMs = (frame * 1000) / fps;
      frame += s.frames;
      const endMs = (frame * 1000) / fps;
      if (s.kind !== 'mix' || endMs < viewStart || startMs > viewEnd) continue;
      const x0 = x(startMs);
      const w = Math.max(2, x(endMs) - x0);
      if (s.from && s.to) ctx.fillStyle = 'rgba(255,255,255,0.4)';
      else {
        const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
        g.addColorStop(0, `rgba(0,0,0,${s.from ? 0 : 0.8})`);
        g.addColorStop(1, `rgba(0,0,0,${s.to ? 0 : 0.8})`);
        ctx.fillStyle = g;
      }
      ctx.fillRect(x0, yScenes, w, ROW_SCENES);
    }

    // Звук начинается с нуля; пока длина файла неизвестна, рисуем его на весь ролик.
    if (project.audio) {
      const yAudio = yScenes + ROW_SCENES + 4;
      const end = Math.min(total, audioDurationMs ?? total);
      const x0 = Math.max(0, x(0));
      const x1 = Math.min(width, x(end));
      if (x1 > x0) {
        ctx.fillStyle = '#7a5fa8';
        ctx.fillRect(x0, yAudio, x1 - x0, ROW_AUDIO);
        ctx.fillStyle = '#fff';
        clippedText(ctx, `♪ ${assetLabel(project.audio)}`, x0 + 6, yAudio, x1 - x0 - 10, ROW_AUDIO);
      }
    }

    const yCues = yScenes + ROW_SCENES + 6 + audioRow;
    ctx.fillStyle = 'rgba(127,127,127,0.12)';
    ctx.fillRect(0, yCues, width, ROW_CUES);
    for (const c of project.subtitles) {
      if (c.endMs < viewStart || c.startMs > viewEnd) continue;
      const x0 = x(c.startMs);
      const w = Math.max(1, x(c.endMs) - x0);
      ctx.fillStyle = selectedIds.has(c.id) ? '#e0a020' : issueIds.has(c.id) ? '#d05050' : '#4a90d9';
      ctx.fillRect(x0, yCues + 2, Math.max(1, w - (w > 3 ? 1 : 0)), ROW_CUES - 4);
      if (w > 40) {
        ctx.fillStyle = '#fff';
        clippedText(ctx, c.text.replace(/\n/g, ' '), x0 + 3, yCues, w - 6, ROW_CUES);
      }
    }

    // Шкала времени
    const yAxis = yCues + ROW_CUES + 2;
    const steps = [1, 5, 10, 30, 60, 300, 600, 1800, 3600].map((s) => s * 1000);
    const step = steps.find((s) => (s / span) * width > 90) ?? 3_600_000;
    ctx.fillStyle = '#888';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) {
      const px = x(t);
      ctx.fillRect(px, yAxis, 1, 4);
      ctx.fillText(formatHms(t), px + 3, yAxis + 2);
    }

    // Вырезы поверх всех дорожек; выбранный обведён.
    for (const c of cuts) {
      if (c.endMs < viewStart || c.startMs > viewEnd) continue;
      const x0 = x(c.startMs);
      const w = Math.max(2, x(c.endMs) - x0);
      hatch(ctx, x0, 0, w, yAxis);
      // Затухание у границ — к чёрному снаружи выреза, на полосе сцен.
      const d = c.fadeMs ?? 0;
      if (d) {
        for (const [a, b, darkAtStart] of [[c.startMs - d, c.startMs, false], [c.endMs, c.endMs + d, true]] as const) {
          const gx0 = x(a);
          const gx1 = x(b);
          const g = ctx.createLinearGradient(gx0, 0, gx1, 0);
          g.addColorStop(0, `rgba(0,0,0,${darkAtStart ? 0.85 : 0})`);
          g.addColorStop(1, `rgba(0,0,0,${darkAtStart ? 0 : 0.85})`);
          ctx.fillStyle = g;
          ctx.fillRect(gx0, yScenes, Math.max(1, gx1 - gx0), ROW_SCENES);
        }
      }
      if (c.startMs === selectedCut) {
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, 1, w - 2, yAxis - 2);
      }
    }
    // Начало будущего выреза — пунктир.
    if (cutStart !== null) {
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x(cutStart), 0);
      ctx.lineTo(x(cutStart), yAxis);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Курсор
    const px = x(timeMs);
    ctx.fillStyle = '#ff4040';
    ctx.fillRect(px - 1, 0, 2, height);
  }, [project.scenes, project.subtitles, project.audio, cuts, cutStart, selectedCut, project.output, segments, audioDurationMs, total, height, audioRow, timeMs, width, span, viewStart, selectedIds, issueIds]);

  const seekFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = viewStart + ((e.clientX - rect.left) / rect.width) * span;
    const t = Math.min(total, Math.max(0, Math.round(ms)));
    onSeek(t);
    return t;
  };

  const setCuts = (fn: (c: Cut[]) => Cut[]) => update((p) => ({ ...p, cuts: normalizeCuts(fn(p.cuts)) }));
  const finishCut = () => {
    if (cutStart === null || cutStart === timeMs) return;
    const cut = { startMs: Math.min(cutStart, timeMs), endMs: Math.max(cutStart, timeMs) };
    setCuts((c) => [...c, cut]);
    setCutStart(null);
    setSelectedCut(cut.startMs);
  };
  const changeSelected = (patch: Partial<Cut>) => {
    if (!selected) return;
    const next = { ...selected, ...patch };
    if (next.endMs <= next.startMs) return;
    setCuts((c) => [...c.filter((x) => x.startMs !== selected.startMs), next]);
    setSelectedCut(next.startMs);
  };
  const removeSelected = () => {
    if (!selected) return;
    setCuts((c) => c.filter((x) => x.startMs !== selected.startMs));
    setSelectedCut(null);
  };
  const finalMs = finalDurationMs(cuts, project.output.durationMs);

  return (
    <div className="timeline">
      <div className="timeline-zoom">
        {ZOOMS.map((z) => (
          <button key={z.ms} className={`small ${zoom === z.ms ? 'active' : ''}`} onClick={() => setZoom(z.ms)}>
            {z.label}
          </button>
        ))}
        <span className="timeline-cuts">
          {cutStart === null ? (
            <button className="small" onClick={() => setCutStart(timeMs)} title="Поставить начало выреза там, где курсор">
              ✂ Начало выреза
            </button>
          ) : (
            <>
              <span className="muted small-text">вырез с {formatHms(cutStart)}</span>
              <button
                className="small primary"
                onClick={finishCut}
                disabled={cutStart === timeMs}
                title="Поставить конец выреза там, где курсор"
              >
                ✂ Конец выреза
              </button>
              <button className="small" onClick={() => setCutStart(null)} title="Не вырезать">
                ×
              </button>
            </>
          )}
          {selected && (
            <>
              <span className="small-text">Вырез с</span>
              <TimeInput format="hms" valueMs={selected.startMs} onCommit={(ms) => changeSelected({ startMs: ms })} />
              <span className="small-text">до</span>
              <TimeInput format="hms" valueMs={selected.endMs} onCommit={(ms) => changeSelected({ endMs: ms })} />
              <select
                value={selected.fadeMs ?? 0}
                onChange={(e) => changeSelected({ fadeMs: Number(e.target.value) || undefined })}
                title="Картинка гаснет в чёрный перед вырезом и проявляется после — снаружи выреза, длина видео не меняется"
              >
                {CUT_FADES_MS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms ? `затухание ${String(ms / 1000).replace('.', ',')} с` : 'резко'}
                  </option>
                ))}
              </select>
              <button className="small danger" onClick={removeSelected}>
                Убрать вырез
              </button>
            </>
          )}
          {cuts.length > 0 && (
            <span className="muted small-text" title="Длина собранного видео: вырезанные куски пропускаются">
              Видео без вырезов: {formatHms(finalMs)}
            </span>
          )}
        </span>
      </div>
      <div ref={wrapRef} className="timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          onMouseDown={(e) => setSelectedCut(cutAt(cuts, seekFromEvent(e))?.startMs ?? null)}
          onMouseMove={(e) => e.buttons === 1 && seekFromEvent(e)}
        />
      </div>
    </div>
  );
}
