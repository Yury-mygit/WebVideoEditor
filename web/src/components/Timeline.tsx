import { useEffect, useRef, useState } from 'react';
import { formatHms, sceneTimeline, type Project } from '@wve/shared';
import { assetLabel } from '../audio';

interface Props {
  project: Project;
  timeMs: number;
  onSeek: (ms: number) => void;
  selectedIds: ReadonlySet<string>;
  issueIds: ReadonlySet<string>;
  audioDurationMs: number | null;
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

/** ФТ-51: полоса сцен, звуковая дорожка (если есть) и полоса реплик; клик перемещает позицию. */
export function Timeline({ project, timeMs, onSeek, selectedIds, issueIds, audioDurationMs }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(ZOOMS[0].ms);
  const [width, setWidth] = useState(800);
  const total = Math.max(1, project.output.durationMs);
  const audioRow = project.audio ? ROW_AUDIO + 4 : 0;
  const height = BASE_HEIGHT + audioRow;

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

    // Курсор
    const px = x(timeMs);
    ctx.fillStyle = '#ff4040';
    ctx.fillRect(px - 1, 0, 2, height);
  }, [project.scenes, project.subtitles, project.audio, audioDurationMs, total, height, audioRow, timeMs, width, span, viewStart, selectedIds, issueIds]);

  const seekFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = viewStart + ((e.clientX - rect.left) / rect.width) * span;
    onSeek(Math.min(total, Math.max(0, Math.round(ms))));
  };

  return (
    <div className="timeline">
      <div className="timeline-zoom">
        {ZOOMS.map((z) => (
          <button key={z.ms} className={`small ${zoom === z.ms ? 'active' : ''}`} onClick={() => setZoom(z.ms)}>
            {z.label}
          </button>
        ))}
      </div>
      <div ref={wrapRef} className="timeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          onMouseDown={seekFromEvent}
          onMouseMove={(e) => e.buttons === 1 && seekFromEvent(e)}
        />
      </div>
    </div>
  );
}
