import { useEffect, useRef, useState } from 'react';
import { formatSrtTime, type Project } from '@wve/shared';
import { assetUrl } from '../api';
import { drawFrame } from '../preview/draw';

interface Props {
  projectId: string;
  project: Project;
  timeMs: number;
  onSeek: (ms: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
}

/** Кэш загруженных изображений сцен; version меняется, когда очередная картинка догрузилась. */
function useImages(projectId: string, names: string[]) {
  const cache = useRef(new Map<string, HTMLImageElement>());
  const [version, setVersion] = useState(0);
  const key = names.join('|');
  useEffect(() => {
    for (const name of names) {
      if (cache.current.has(name)) continue;
      const img = new Image();
      img.onload = () => setVersion((v) => v + 1);
      img.src = assetUrl(projectId, name);
      cache.current.set(name, img);
    }
  }, [projectId, key]);
  return { images: cache.current, version };
}

export function Preview({ projectId, project, timeMs, onSeek, playing, onTogglePlay }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { images, version } = useImages(
    projectId,
    project.scenes.map((s) => s.image),
  );
  const [fontsReady, setFontsReady] = useState(0);

  useEffect(() => {
    document.fonts.ready.then(() => setFontsReady((v) => v + 1));
  }, [project.style.fontFamily]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) drawFrame(ctx, project, timeMs, images);
  }, [project, timeMs, images, version, fontsReady]);

  const { width, height, durationMs, fps } = project.output;
  const frameMs = 1000 / fps;

  return (
    <div className="preview">
      <div className="preview-canvas-wrap">
        <canvas ref={canvasRef} width={width} height={height} style={{ aspectRatio: `${width} / ${height}` }} />
      </div>
      <div className="preview-controls">
        <button onClick={onTogglePlay} title="Пробел">
          {playing ? '❚❚ Пауза' : '▶ Пуск'}
        </button>
        <button onClick={() => onSeek(Math.max(0, timeMs - frameMs))} title="Кадр назад">
          ◀︎|
        </button>
        <button onClick={() => onSeek(Math.min(durationMs, timeMs + frameMs))} title="Кадр вперёд">
          |▶︎
        </button>
        <input
          type="range"
          min={0}
          max={durationMs}
          step={frameMs}
          value={Math.min(timeMs, durationMs)}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
        <span className="mono">
          {formatSrtTime(timeMs)} / {formatSrtTime(durationMs)}
        </span>
      </div>
    </div>
  );
}
