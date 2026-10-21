import { useCallback, useReducer } from 'react';
import type { Project } from '@wve/shared';

/** ФТ-5: история изменений для отмены/повтора. */
const HISTORY_LIMIT = 200;
/** Правки с одинаковым ключом в пределах этого окна объединяются в один шаг отмены. */
const COALESCE_MS = 1200;

interface State {
  project: Project | null;
  past: Project[];
  future: Project[];
  lastKey: string | null;
  lastAt: number;
}

type Action =
  | { type: 'load'; project: Project | null }
  | { type: 'update'; fn: (p: Project) => Project; key: string | null }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load':
      return { project: action.project, past: [], future: [], lastKey: null, lastAt: 0 };
    case 'update': {
      if (!state.project) return state;
      const next = action.fn(state.project);
      if (next === state.project) return state;
      const now = Date.now();
      const coalesce = action.key !== null && action.key === state.lastKey && now - state.lastAt < COALESCE_MS;
      return {
        project: next,
        past: coalesce ? state.past : [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        lastKey: action.key,
        lastAt: now,
      };
    }
    case 'undo': {
      if (!state.project || !state.past.length) return state;
      return {
        project: state.past[state.past.length - 1],
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future],
        lastKey: null,
        lastAt: 0,
      };
    }
    case 'redo': {
      if (!state.project || !state.future.length) return state;
      return {
        project: state.future[0],
        past: [...state.past, state.project],
        future: state.future.slice(1),
        lastKey: null,
        lastAt: 0,
      };
    }
  }
}

export type UpdateProject = (fn: (p: Project) => Project, key?: string) => void;

export function useEditor() {
  const [state, dispatch] = useReducer(reducer, { project: null, past: [], future: [], lastKey: null, lastAt: 0 });
  const load = useCallback((project: Project | null) => dispatch({ type: 'load', project }), []);
  const update = useCallback<UpdateProject>((fn, key) => dispatch({ type: 'update', fn, key: key ?? null }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  return {
    project: state.project,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    load,
    update,
    undo,
    redo,
  };
}
