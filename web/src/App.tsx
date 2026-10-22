import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cueIssues, type Project } from '@wve/shared';
import { api } from './api';
import { AUTHORIZED_EVENT, useAuth } from './auth';
import { useEditor } from './editor';
import { CueTable } from './components/CueTable';
import { Preview } from './components/Preview';
import { ProjectPicker } from './components/ProjectPicker';
import { RenderDialog } from './components/RenderDialog';
import { ScenesPanel } from './components/ScenesPanel';
import { StylePanel } from './components/StylePanel';
import { Timeline } from './components/Timeline';
import { exportAss, exportSrt, importSubtitles } from './subtitleFiles';

const AUTOSAVE_DELAY_MS = 1500;
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const idFromHash = () => /^#\/p\/([0-9a-f-]{36})$/i.exec(location.hash)?.[1] ?? null;

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  return el.closest('input, textarea, select, [contenteditable]') !== null;
}

export function App() {
  const [projectId, setProjectId] = useState<string | null>(idFromHash);
  const { project, load, update, undo, redo, canUndo, canRedo } = useEditor();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [showRender, setShowRender] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const importInput = useRef<HTMLInputElement>(null);
  const auth = useAuth();

  const showError = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- Загрузка проекта ----------
  useEffect(() => {
    const onHash = () => setProjectId(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const savedRef = useRef<Project | null>(null);
  useEffect(() => {
    setLoadError(null);
    load(null);
    savedRef.current = null;
    if (!projectId) return;
    api.loadProject(projectId).then(
      (p) => {
        savedRef.current = p;
        load(p);
        setTimeMs(0);
        setSelectedIds(new Set());
        setSaveState('saved');
      },
      (e) => setLoadError(e.message),
    );
  }, [projectId, load]);

  const openProject = (id: string) => {
    location.hash = `#/p/${id}`;
    setShowPicker(false);
  };

  // ---------- Автосохранение (ФТ-4) ----------
  const projectRef = useRef(project);
  projectRef.current = project;
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flushSave = useCallback(async () => {
    clearTimeout(timer.current);
    const run = async () => {
      const p = projectRef.current;
      if (!projectId || !p || p === savedRef.current) return;
      setSaveState('saving');
      try {
        await api.saveProject(projectId, p);
        savedRef.current = p;
        setSaveState(projectRef.current === p ? 'saved' : 'dirty');
      } catch (e) {
        setSaveState('error');
        throw e;
      }
    };
    saveChain.current = saveChain.current.catch(() => {}).then(run);
    return saveChain.current;
  }, [projectId]);

  useEffect(() => {
    if (!project || project === savedRef.current) return;
    setSaveState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flushSave().catch((e) => showError(`Не удалось сохранить: ${e.message}`)), AUTOSAVE_DELAY_MS);
  }, [project, flushSave, showError]);

  // После повторного входа дописываем то, что не удалось сохранить.
  useEffect(() => {
    const onAuthorized = () => flushSave().catch((e) => showError(`Не удалось сохранить: ${e.message}`));
    window.addEventListener(AUTHORIZED_EVENT, onAuthorized);
    return () => window.removeEventListener(AUTHORIZED_EVENT, onAuthorized);
  }, [flushSave, showError]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (projectRef.current && projectRef.current !== savedRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ---------- Воспроизведение превью (ФТ-53, без аудио) ----------
  const durationMs = project?.output.durationMs ?? 0;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setTimeMs((t) => {
        const next = t + dt;
        if (next >= durationMs) {
          setPlaying(false);
          return durationMs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);

  const seek = useCallback((ms: number) => setTimeMs(Math.max(0, ms)), []);
  const togglePlay = useCallback(() => setPlaying((p) => !p), []);

  // ---------- Горячие клавиши (ФТ-5) ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay]);

  const issues = useMemo(
    () => (project ? cueIssues(project.subtitles, project.output.durationMs) : new Map()),
    [project?.subtitles, project?.output.durationMs],
  );
  const issueIds = useMemo(() => new Set(issues.keys()), [issues]);

  async function onImport(file: File) {
    if (!project) return;
    try {
      const cues = await importSubtitles(file, project.output.durationMs);
      if (!cues.length) {
        showError(`В файле ${file.name} не найдено ни одной реплики`);
        return;
      }
      if (project.subtitles.length && !confirm(`Заменить ${project.subtitles.length} текущих реплик на ${cues.length} из файла?`)) return;
      update((p) => ({ ...p, subtitles: cues }));
      setSelectedIds(new Set());
      setToast(`Импортировано реплик: ${cues.length}`);
    } catch (e) {
      showError((e as Error).message);
    }
  }

  if (!projectId) return <ProjectPicker onOpen={openProject} />;
  if (loadError)
    return (
      <div className="center-message">
        <p className="error">{loadError}</p>
        <button onClick={() => (location.hash = '')}>К списку проектов</button>
      </div>
    );
  if (!project) return <div className="center-message muted">Загрузка проекта…</div>;

  const saveLabel = { saved: 'Сохранено', dirty: 'Есть изменения', saving: 'Сохранение…', error: 'Ошибка сохранения' }[saveState];

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={() => setShowPicker(true)}>☰ Проекты</button>
        <input
          className="project-name"
          value={project.meta.name}
          onChange={(e) => update((p) => ({ ...p, meta: { ...p.meta, name: e.target.value } }), 'name')}
        />
        <button onClick={undo} disabled={!canUndo} title="Отменить (Ctrl+Z)">
          ↶
        </button>
        <button onClick={redo} disabled={!canRedo} title="Повторить (Ctrl+Y)">
          ↷
        </button>
        <span className="sep" />
        <button onClick={() => importInput.current?.click()}>Импорт субтитров</button>
        <button onClick={() => exportSrt(project)} disabled={!project.subtitles.length}>
          Экспорт SRT
        </button>
        <button onClick={() => exportAss(project)} disabled={!project.subtitles.length}>
          Экспорт ASS
        </button>
        <span className="sep grow" />
        <a className="button" href="/instruction" target="_blank" rel="noreferrer" title="Инструкция в картинках">
          ? Инструкция
        </a>
        <span className={`save-state ${saveState}`}>{saveLabel}</span>
        {auth.required && (
          <button onClick={auth.logout} title="Выйти">
            Выйти
          </button>
        )}
        <button className="primary" onClick={() => setShowRender(true)}>
          🎬 Собрать видео
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".srt,.ass,.ssa,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
            e.target.value = '';
          }}
        />
      </header>

      <main className="workspace">
        <ScenesPanel
          projectId={projectId}
          project={project}
          update={update}
          onSeek={seek}
          currentMs={timeMs}
          onError={showError}
        />
        <Preview
          projectId={projectId}
          project={project}
          timeMs={timeMs}
          onSeek={seek}
          playing={playing}
          onTogglePlay={togglePlay}
        />
        <StylePanel style={project.style} update={update} />
      </main>

      <section className="bottom">
        <Timeline project={project} timeMs={timeMs} onSeek={seek} selectedIds={selectedIds} issueIds={issueIds} />
        <CueTable
          project={project}
          update={update}
          timeMs={timeMs}
          onSeek={seek}
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
          issues={issues}
          follow={playing}
        />
      </section>

      {showPicker && <ProjectPicker onOpen={openProject} onClose={() => setShowPicker(false)} />}
      {showRender && (
        <RenderDialog
          projectId={projectId}
          project={project}
          update={update}
          timeMs={timeMs}
          flushSave={flushSave}
          onClose={() => setShowRender(false)}
        />
      )}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
