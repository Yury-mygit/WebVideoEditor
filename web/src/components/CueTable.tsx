import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CUE_ISSUE_LABELS, newId, sortCues, type Cue, type CueIssueKind, type Project } from '@wve/shared';
import type { UpdateProject } from '../editor';
import { TimeInput } from './TimeInput';

interface Props {
  project: Project;
  update: UpdateProject;
  timeMs: number;
  onSeek: (ms: number) => void;
  selectedIds: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  issues: Map<string, CueIssueKind[]>;
  follow: boolean;
}

const ROW_H = 46;

interface RowProps {
  cue: Cue;
  index: number;
  num: number;
  selected: boolean;
  active: boolean;
  issues: CueIssueKind[] | undefined;
  onRowClick: (e: React.MouseEvent, cue: Cue, index: number) => void;
  setCue: (id: string, patch: Partial<Cue>, key?: string) => void;
}

const CueRow = memo(function CueRow({ cue, index, num, selected, active, issues, onRowClick, setCue }: RowProps) {
  const dur = (cue.endMs - cue.startMs) / 1000;
  return (
    <div
      className={`cue-row ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${issues ? 'has-issue' : ''}`}
      onMouseDown={(e) => onRowClick(e, cue, index)}
    >
      <div className="c-num mono">{num}</div>
      <TimeInput valueMs={cue.startMs} onCommit={(ms) => setCue(cue.id, { startMs: ms })} />
      <TimeInput valueMs={cue.endMs} onCommit={(ms) => setCue(cue.id, { endMs: ms })} />
      <div className="c-dur mono">{dur.toFixed(2)}</div>
      <textarea
        className="c-text"
        value={cue.text}
        spellCheck={false}
        onChange={(e) => setCue(cue.id, { text: e.target.value }, `text-${cue.id}`)}
        onKeyDown={(e) => {
          // ФТ-27: Shift+Enter — ручной перенос строки, Enter — закончить правку.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      <div className="c-issue" title={issues?.map((k) => CUE_ISSUE_LABELS[k]).join('\n')}>
        {issues ? '⚠' : ''}
      </div>
    </div>
  );
});

export function CueTable({ project, update, timeMs, onSeek, selectedIds, onSelect, issues, follow }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [shiftMs, setShiftMs] = useState(500);
  const lastClicked = useRef<number | null>(null);

  const cues = project.subtitles;
  const rows = useMemo(() => (onlyIssues ? cues.filter((c) => issues.has(c.id)) : cues), [cues, issues, onlyIssues]);
  const numbers = useMemo(() => new Map(cues.map((c, i) => [c.id, i + 1])), [cues]);
  const activeIndex = useMemo(() => rows.findIndex((c) => timeMs >= c.startMs && timeMs < c.endMs), [rows, timeMs]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  useEffect(() => {
    if (follow && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: 'center' });
  }, [follow, activeIndex, virtualizer]);

  // Ссылки стабильны между рендерами, чтобы memo-строки не перерисовывались зря.
  const stateRef = useRef({ rows, selectedIds, onSelect, onSeek });
  stateRef.current = { rows, selectedIds, onSelect, onSeek };

  const setCue = useMemo(
    () => (id: string, patch: Partial<Cue>, key?: string) =>
      update((p) => {
        const list = p.subtitles.map((c) => (c.id === id ? { ...c, ...patch } : c));
        // После смены времени держим таблицу отсортированной по началу.
        return { ...p, subtitles: 'startMs' in patch ? sortCues(list) : list };
      }, key),
    [update],
  );

  const onRowClick = useMemo(
    () => (e: React.MouseEvent, cue: Cue, index: number) => {
      const { rows, selectedIds, onSelect, onSeek } = stateRef.current;
      const editing = (e.target as HTMLElement).closest('input, textarea');
      if (e.shiftKey && lastClicked.current !== null) {
        const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
        onSelect(new Set(rows.slice(a, b + 1).map((c) => c.id)));
      } else if (e.ctrlKey || e.metaKey) {
        const next = new Set(selectedIds);
        if (next.has(cue.id)) next.delete(cue.id);
        else next.add(cue.id);
        onSelect(next);
        lastClicked.current = index;
      } else {
        if (!(editing && selectedIds.has(cue.id) && selectedIds.size === 1)) onSelect(new Set([cue.id]));
        lastClicked.current = index;
        // ФТ-52: клик по реплике переводит превью на её начало.
        onSeek(cue.startMs);
      }
    },
    [],
  );

  function addCue() {
    const start = Math.round(timeMs);
    const cue: Cue = { id: newId(), startMs: start, endMs: start + 2000, text: '' };
    update((p) => ({ ...p, subtitles: sortCues([...p.subtitles, cue]) }));
    onSelect(new Set([cue.id]));
  }

  function deleteSelected() {
    if (!selectedIds.size) return;
    update((p) => ({ ...p, subtitles: p.subtitles.filter((c) => !selectedIds.has(c.id)) }));
    onSelect(new Set());
  }

  // ФТ-24: сдвиг таймингов выделенных или всех реплик.
  function shift(sign: 1 | -1, all: boolean) {
    const d = sign * shiftMs;
    update((p) => ({
      ...p,
      subtitles: sortCues(
        p.subtitles.map((c) =>
          all || selectedIds.has(c.id) ? { ...c, startMs: Math.max(0, c.startMs + d), endMs: Math.max(0, c.endMs + d) } : c,
        ),
      ),
    }));
  }

  return (
    <div className="panel cue-table">
      <div className="cue-toolbar">
        <b>Субтитры</b>
        <span className="muted">
          {cues.length} реплик{selectedIds.size ? `, выделено ${selectedIds.size}` : ''}
          {issues.size ? `, с замечаниями ${issues.size}` : ''}
        </span>
        <button className="small" onClick={addCue} title="Добавить реплику в текущей позиции">
          + Реплика
        </button>
        <button className="small danger" disabled={!selectedIds.size} onClick={deleteSelected}>
          Удалить
        </button>
        <span className="sep" />
        <span className="muted">Сдвиг, мс</span>
        <input type="number" className="num" value={shiftMs} step={100} onChange={(e) => setShiftMs(Math.abs(Number(e.target.value)))} />
        <button className="small" disabled={!selectedIds.size} onClick={() => shift(-1, false)} title="Сдвинуть выделенные раньше">
          − выдел.
        </button>
        <button className="small" disabled={!selectedIds.size} onClick={() => shift(1, false)} title="Сдвинуть выделенные позже">
          + выдел.
        </button>
        <button className="small" onClick={() => shift(-1, true)} title="Сдвинуть все раньше">
          − все
        </button>
        <button className="small" onClick={() => shift(1, true)} title="Сдвинуть все позже">
          + все
        </button>
        <span className="sep" />
        <label className="check">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Только с замечаниями
        </label>
      </div>
      <div className="cue-head">
        <div className="c-num">№</div>
        <div>Начало</div>
        <div>Конец</div>
        <div className="c-dur">Длит., с</div>
        <div>Текст (Shift+Enter — перенос строки)</div>
        <div />
      </div>
      <div ref={scrollRef} className="cue-scroll">
        {rows.length === 0 && (
          <div className="empty-hint">
            {onlyIssues ? 'Замечаний нет' : 'Импортируйте SRT/ASS/TXT кнопкой «Импорт субтитров» или добавьте реплику вручную'}
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const cue = rows[v.index];
            return (
              <div key={cue.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${v.start}px)` }}>
                <CueRow
                  cue={cue}
                  index={v.index}
                  num={numbers.get(cue.id) ?? 0}
                  selected={selectedIds.has(cue.id)}
                  active={v.index === activeIndex}
                  issues={issues.get(cue.id)}
                  onRowClick={onRowClick}
                  setCue={setCue}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
