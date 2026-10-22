import { useRef, useState } from 'react';
import {
  createScene,
  fitLastScene,
  formatHms,
  msToFrame,
  sceneTimeline,
  splitEvenly,
  totalScenesMs,
  type FitMode,
  type Project,
  type Scene,
  type TransitionSettings,
  type TransitionType,
} from '@wve/shared';
import { api, assetUrl } from '../api';
import { AUDIO_ACCEPT, assetLabel, isAudioFile } from '../audio';
import type { UpdateProject } from '../editor';
import { TimeInput } from './TimeInput';

interface Props {
  projectId: string;
  project: Project;
  update: UpdateProject;
  onSeek: (ms: number) => void;
  currentMs: number;
  onError: (msg: string) => void;
  /** Длительность звуковой дорожки, когда она известна. */
  audioDurationMs: number | null;
}

const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp';
const FIT_LABELS: Record<FitMode, string> = { cover: 'Обрезать', contain: 'Вписать', stretch: 'Растянуть' };
const TRANSITION_LABELS: Record<TransitionType, string> = { cut: 'Резко', crossfade: 'Плавно', dip: 'Через чёрный' };
const DURATIONS_MS = [0.5, 1, 1.5, 2, 3, 5, 10, 15, 20, 30, 60, 120, 180, 300, 600].map((s) => s * 1000);
const durationLabel = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} мин` : `${String(ms / 1000).replace('.', ',')} с`;

/** Длительность перехода из готового списка (значение, заданное через MCP, тоже показывается). */
function DurationSelect(props: { valueMs: number; onChange: (ms: number) => void; allowZero?: boolean; title?: string }) {
  const { valueMs, onChange, allowZero, title } = props;
  const known = DURATIONS_MS.includes(valueMs) || (allowZero && valueMs === 0);
  const options = known ? DURATIONS_MS : [...DURATIONS_MS, valueMs].sort((a, b) => a - b);
  return (
    <select value={valueMs} title={title} onChange={(e) => onChange(Number(e.target.value))}>
      {allowZero && <option value={0}>нет</option>}
      {options.map((ms) => (
        <option key={ms} value={ms}>
          {durationLabel(ms)}
        </option>
      ))}
    </select>
  );
}

export function ScenesPanel({ projectId, project, update, onSeek, currentMs, onError, audioDurationMs }: Props) {
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);

  const { scenes, output } = project;
  const total = totalScenesMs(scenes);
  const mismatch = scenes.length > 0 && msToFrame(total, output.fps) !== msToFrame(output.durationMs, output.fps);
  const timeline = sceneTimeline(scenes);
  const currentIdx = timeline.findIndex((t) => currentMs >= t.startMs && currentMs < t.endMs);

  const setScene = (id: string, patch: Partial<Scene>, key?: string) =>
    update((p) => ({ ...p, scenes: p.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }), key);

  // ФТ-16: проявление и затемнение ролика; переходы между сценами задаются у каждой сцены.
  const { transitions } = project;
  const setTransitions = (patch: Partial<TransitionSettings>) =>
    update((p) => ({ ...p, transitions: { ...p.transitions, ...patch } }));

  // Звуковая дорожка: идёт с начала ролика, всё, что длиннее ролика, при сборке отрезается.
  async function setAudioFile(file: File) {
    setBusy(true);
    try {
      const name = await api.uploadAsset(projectId, file);
      update((p) => ({ ...p, audio: name }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ФТ-10: добавление файлов выбором или перетаскиванием.
  async function addFiles(files: File[]) {
    const audio = files.find((f) => isAudioFile(f.name));
    if (audio) await setAudioFile(audio);
    const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
    if (!images.length) return;
    setBusy(true);
    try {
      const names: string[] = [];
      for (const f of images) names.push(await api.uploadAsset(projectId, f));
      update((p) => {
        const added = names.map((n) => createScene(n, 0));
        const all = [...p.scenes, ...added];
        // Новые сцены получают равные доли оставшегося времени; если места нет — делим всё поровну.
        const rest = p.output.durationMs - totalScenesMs(p.scenes);
        if (rest > 0 && p.scenes.length) {
          const each = Math.floor(rest / added.length);
          added.forEach((s, i) => (s.durationMs = i === added.length - 1 ? rest - each * i : each));
          return { ...p, scenes: all };
        }
        return { ...p, scenes: splitEvenly(all, p.output) };
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ФТ-11: замена картинки без потери тайминга.
  async function replaceFile(file: File) {
    const id = replaceTarget.current;
    if (!id) return;
    setBusy(true);
    try {
      const name = await api.uploadAsset(projectId, file);
      setScene(id, { image: name });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ФТ-12: перестановка перетаскиванием.
  function moveScene(fromId: string, toId: string) {
    if (fromId === toId) return;
    update((p) => {
      const list = [...p.scenes];
      const from = list.findIndex((s) => s.id === fromId);
      const to = list.findIndex((s) => s.id === toId);
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      return { ...p, scenes: list };
    });
  }

  return (
    <div
      className={`panel scenes-panel ${dropOver ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void addFiles([...e.dataTransfer.files]);
        }
      }}
    >
      <div className="panel-title">
        Сцены
        <button className="primary small" disabled={busy} onClick={() => addInput.current?.click()}>
          + Изображения
        </button>
      </div>

      <label className="field">
        <span>Длительность ролика</span>
        <TimeInput
          format="hms"
          valueMs={output.durationMs}
          onCommit={(ms) => update((p) => ({ ...p, output: { ...p.output, durationMs: ms } }))}
        />
      </label>

      <div className="transitions">
        <div className="row">
          <label className="field">
            <span>Проявление в начале</span>
            <DurationSelect allowZero valueMs={transitions.fadeInMs} onChange={(ms) => setTransitions({ fadeInMs: ms })} />
          </label>
          <label className="field">
            <span>Затемнение в конце</span>
            <DurationSelect allowZero valueMs={transitions.fadeOutMs} onChange={(ms) => setTransitions({ fadeOutMs: ms })} />
          </label>
        </div>
        {project.audio && (transitions.fadeInMs > 0 || transitions.fadeOutMs > 0) && (
          <label className="check">
            <input
              type="checkbox"
              checked={transitions.fadeAudio}
              onChange={(e) => setTransitions({ fadeAudio: e.target.checked })}
            />{' '}
            Звук тоже нарастает и затихает
          </label>
        )}
      </div>

      {scenes.length === 0 && (
        <div className="empty-hint">Перетащите сюда картинки (JPG, PNG, WEBP) или нажмите «+ Изображения»</div>
      )}

      <ol className="scene-list">
        {timeline.map(({ scene, startMs }, i) => (
          <li
            key={scene.id}
            className={`scene-item ${i === currentIdx ? 'current' : ''} ${dragId === scene.id ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragId(scene.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => {
              if (dragId) {
                e.preventDefault();
                e.stopPropagation();
                moveScene(dragId, scene.id);
                setDragId(null);
              }
            }}
          >
            <img src={assetUrl(projectId, scene.image)} alt="" onClick={() => onSeek(startMs)} title="Перейти к сцене" />
            <div className="scene-props">
              <div className="scene-head">
                <span className="drag-handle" title="Перетащите для смены порядка">⋮⋮</span>
                <b>{i + 1}</b>
                <span className="muted mono">с {formatHms(startMs)}</span>
              </div>
              <TimeInput
                format="hms"
                title="Длительность сцены"
                valueMs={scene.durationMs}
                onCommit={(ms) => setScene(scene.id, { durationMs: ms })}
              />
              <div className="row">
                <select value={scene.fit} onChange={(e) => setScene(scene.id, { fit: e.target.value as FitMode })}>
                  {Object.entries(FIT_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                {scene.fit === 'contain' && (
                  <input
                    type="color"
                    title="Цвет полей"
                    value={scene.padColor}
                    onChange={(e) => setScene(scene.id, { padColor: e.target.value }, `pad-${scene.id}`)}
                  />
                )}
              </div>
              {i < scenes.length - 1 && (
                <div
                  className="row scene-transition"
                  title="Переход к следующей сцене: половина до границы сцен, половина после"
                >
                  <span className="muted">Переход →</span>
                  <select
                    value={scene.transition?.type ?? 'cut'}
                    onChange={(e) => {
                      const type = e.target.value as TransitionType;
                      const durationMs = scene.transition?.durationMs ?? 1000;
                      setScene(scene.id, { transition: type === 'cut' ? undefined : { type, durationMs } });
                    }}
                  >
                    {Object.entries(TRANSITION_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {scene.transition && scene.transition.type !== 'cut' && (
                    <DurationSelect
                      valueMs={scene.transition.durationMs}
                      onChange={(ms) => setScene(scene.id, { transition: { ...scene.transition!, durationMs: ms } })}
                    />
                  )}
                </div>
              )}
              <div className="row">
                <button
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    replaceTarget.current = scene.id;
                    replaceInput.current?.click();
                  }}
                >
                  Заменить
                </button>
                <button
                  className="small danger"
                  onClick={() => update((p) => ({ ...p, scenes: p.scenes.filter((s) => s.id !== scene.id) }))}
                >
                  Удалить
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>

      {scenes.length > 0 && (
        <div className={`scenes-summary ${mismatch ? 'warn' : ''}`}>
          <div>
            Сумма сцен: <b className="mono">{formatHms(total)}</b>
            {mismatch && <> — не совпадает с длительностью ролика</>}
          </div>
          <div className="row">
            <button className="small" onClick={() => update((p) => ({ ...p, scenes: splitEvenly(p.scenes, p.output) }))}>
              Поделить поровну
            </button>
            {mismatch && (
              <button
                className="small"
                onClick={() => update((p) => ({ ...p, scenes: fitLastScene(p.scenes, p.output.durationMs) }))}
              >
                Подогнать последнюю
              </button>
            )}
          </div>
        </div>
      )}

      <div className="audio-track">
        <div className="panel-title">
          Звук
          <button className="small" disabled={busy} onClick={() => audioInput.current?.click()}>
            {project.audio ? 'Заменить' : '+ Звук'}
          </button>
        </div>
        {project.audio ? (
          <>
            <div className="audio-name" title={project.audio}>
              ♪ {assetLabel(project.audio)}
            </div>
            <div className="muted small-text">
              {audioDurationMs !== null && <>Длина {formatHms(audioDurationMs)}. </>}
              {audioDurationMs !== null && audioDurationMs > output.durationMs
                ? `Звук длиннее ролика — после ${formatHms(output.durationMs)} будет отрезан.`
                : 'Идёт с начала ролика.'}
            </div>
            <div className="row">
              {/* ФТ-41: длительность ролика по звуку; сцены потом подгоняются кнопками выше. */}
              {audioDurationMs !== null && audioDurationMs !== output.durationMs && (
                <button
                  className="small"
                  onClick={() => update((p) => ({ ...p, output: { ...p.output, durationMs: audioDurationMs } }))}
                >
                  Ролик = длина звука
                </button>
              )}
              <button className="small danger" onClick={() => update((p) => ({ ...p, audio: null }))}>
                Убрать звук
              </button>
            </div>
          </>
        ) : (
          <div className="muted small-text">Без звука. Подойдут M4A, MP3, WAV, AAC, OGG.</div>
        )}
      </div>

      <input
        ref={audioInput}
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void setAudioFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={addInput}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void replaceFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
