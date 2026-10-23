import { useEffect, useState } from 'react';
import { finalDurationMs, formatHms, RESOLUTIONS, type Project, type ProjectIssue, type RenderJobInfo } from '@wve/shared';
import { api, renderFileUrl, watchRender } from '../api';
import type { UpdateProject } from '../editor';

interface Props {
  projectId: string;
  project: Project;
  update: UpdateProject;
  timeMs: number;
  /** Сохраняет проект на сервер; рендер всегда идёт по сохранённой версии. */
  flushSave: () => Promise<void>;
  onClose: () => void;
}

const TEST_FRAGMENT_MS = 60_000;

const STATUS_LABELS: Record<RenderJobInfo['status'], string> = {
  queued: 'В очереди',
  running: 'Сборка…',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

export function RenderDialog({ projectId, project, update, timeMs, flushSave, onClose }: Props) {
  const [issues, setIssues] = useState<ProjectIssue[] | null>(null);
  const [jobs, setJobs] = useState<RenderJobInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { output } = project;

  // ФТ-66: проверка проекта перед рендером.
  useEffect(() => {
    let alive = true;
    flushSave()
      .then(() => api.checkProject(projectId))
      .then((r) => alive && setIssues(r))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [projectId, project, flushSave]);

  // Подхватываем незавершённые задания (например, после перезагрузки страницы).
  useEffect(() => {
    api.listRenders(projectId).then((list) => {
      setJobs(list.reverse());
      list.filter((j) => ['queued', 'running'].includes(j.status)).forEach((j) => watch(j.id));
    }, () => {});
  }, [projectId]);

  function watch(jobId: string) {
    watchRender(jobId, (job) => setJobs((list) => list.map((j) => (j.id === job.id ? job : j))));
  }

  async function start(test: boolean) {
    setError(null);
    try {
      await flushSave();
      const startMs = Math.min(timeMs, Math.max(0, output.durationMs - TEST_FRAGMENT_MS));
      const job = await api.startRender(projectId, test ? { startMs, durationMs: TEST_FRAGMENT_MS } : null);
      setJobs((list) => [job, ...list]);
      watch(job.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const hasErrors = issues?.some((i) => i.level === 'error') ?? true;
  const busy = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  const resKey = `${output.width}x${output.height}`;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal render-dialog">
        <div className="modal-title">
          Сборка видео
          <button className="small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="row wrap">
          <label className="field">
            <span>Разрешение</span>
            <select
              value={resKey}
              onChange={(e) => {
                const r = RESOLUTIONS.find((x) => `${x.width}x${x.height}` === e.target.value)!;
                update((p) => ({ ...p, output: { ...p.output, width: r.width, height: r.height } }));
              }}
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.width}x${r.height}`}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Кадров в секунду</span>
            <select
              value={output.fps}
              onChange={(e) => update((p) => ({ ...p, output: { ...p.output, fps: Number(e.target.value) } }))}
            >
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Формат</span>
            <div className="muted">MP4 (H.264), субтитры вшиты</div>
          </div>
          <div className="field">
            <span>Длительность</span>
            <div className="mono">
              {formatHms(finalDurationMs(project.cuts, output.durationMs))}
              {project.cuts.length > 0 && <span className="muted"> без вырезов</span>}
            </div>
          </div>
        </div>

        <div className="issues">
          {issues === null && !error && <div className="muted">Проверка проекта…</div>}
          {issues?.length === 0 && <div className="ok">Проверка пройдена, замечаний нет</div>}
          {issues?.map((i, n) => (
            <div key={n} className={i.level}>
              {i.level === 'error' ? '⛔' : '⚠'} {i.message}
            </div>
          ))}
          {error && <div className="error">⛔ {error}</div>}
        </div>

        <div className="row">
          <button className="primary" disabled={hasErrors || busy} onClick={() => start(false)}>
            Собрать видео
          </button>
          <button disabled={hasErrors || busy} onClick={() => start(true)} title="ФТ-64: быстрый рендер для проверки">
            Тестовый фрагмент: 1 мин с {formatHms(Math.min(timeMs, Math.max(0, output.durationMs - TEST_FRAGMENT_MS)))}
          </button>
        </div>

        {jobs.length > 0 && (
          <div className="jobs">
            {jobs.map((j) => (
              <div key={j.id} className={`job ${j.status}`}>
                <div className="row">
                  <b>{j.range ? 'Тестовый фрагмент' : 'Полный ролик'}</b>
                  <span>{STATUS_LABELS[j.status]}</span>
                  <span className="muted mono">
                    {Math.floor(j.progress * 100)}%{j.status === 'running' && j.etaSec !== null ? `, осталось ~${formatHms(j.etaSec * 1000)}` : ''}
                    {j.status === 'done' ? `, за ${formatHms(j.elapsedSec * 1000)}` : ''}
                  </span>
                  <span className="sep" />
                  {(j.status === 'running' || j.status === 'queued') && (
                    <button className="small danger" onClick={() => api.cancelRender(j.id)}>
                      Отмена
                    </button>
                  )}
                  {j.status === 'done' && (
                    <a className="button small primary" href={renderFileUrl(j.id)} download={j.fileName ?? undefined}>
                      Скачать {j.fileName}
                    </a>
                  )}
                </div>
                {(j.status === 'running' || j.status === 'queued') && (
                  <div className="progress">
                    <div style={{ width: `${j.progress * 100}%` }} />
                  </div>
                )}
                {j.error && <div className="error small-text">{j.error}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
