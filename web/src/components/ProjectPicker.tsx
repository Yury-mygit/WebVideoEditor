import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@wve/shared';
import { api } from '../api';

interface Props {
  onOpen: (id: string) => void;
  onClose?: () => void;
}

export function ProjectPicker({ onOpen, onClose }: Props) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setList, (e) => setError(e.message));
  }, []);

  async function create() {
    try {
      const { id } = await api.createProject(name || 'Новый проект');
      onOpen(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => onClose && e.target === e.currentTarget && onClose()}>
      <div className="modal picker">
        <div className="modal-title">
          Проекты
          {onClose && (
            <button className="small" onClick={onClose}>
              ✕
            </button>
          )}
        </div>
        <div className="row">
          <input
            placeholder="Название нового проекта"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            autoFocus
          />
          <button className="primary" onClick={create}>
            Создать
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="muted">
          Впервые здесь? Посмотрите{' '}
          <a href="/instruction" target="_blank" rel="noreferrer">
            инструкцию в картинках
          </a>
          .
        </div>
        <div className="project-list">
          {list === null && !error && <div className="muted">Загрузка…</div>}
          {list?.length === 0 && <div className="muted">Проектов пока нет</div>}
          {list?.map((p) => (
            <button key={p.id} className="project-item" onClick={() => onOpen(p.id)}>
              <b>{p.name}</b>
              <span className="muted">{new Date(p.updatedAt).toLocaleString('ru-RU')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
