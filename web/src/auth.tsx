import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, UNAUTHORIZED_EVENT } from './api';

interface AuthInfo {
  required: boolean;
  logout: () => void;
}

export const AUTHORIZED_EVENT = 'slidesub:authorized';

const AuthContext = createContext<AuthInfo>({ required: false, logout: () => {} });
export const useAuth = () => useContext(AuthContext);

type State = 'checking' | 'login' | 'ok' | 'relogin';

/**
 * Вход по общему паролю сервера. Если сессия истекла во время работы, окно входа
 * показывается поверх редактора — несохранённые правки не теряются и уйдут после входа.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking');
  const [required, setRequired] = useState(false);

  useEffect(() => {
    api.authStatus().then(
      (s) => {
        setRequired(s.required);
        setState(!s.required || s.authorized ? 'ok' : 'login');
      },
      () => setState('ok'),
    );
    const onUnauthorized = () => setState((s) => (s === 'ok' ? 'relogin' : s === 'checking' ? 'login' : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const logout = () => {
    api.logout().finally(() => location.reload());
  };

  if (state === 'checking') return <div className="center-message muted">Проверка доступа…</div>;
  if (state === 'login') return <LoginForm onSuccess={() => setState('ok')} />;
  return (
    <AuthContext.Provider value={{ required, logout }}>
      {children}
      {state === 'relogin' && (
        <LoginForm
          overlay
          onSuccess={() => {
            setState('ok');
            window.dispatchEvent(new Event(AUTHORIZED_EVENT));
          }}
        />
      )}
    </AuthContext.Provider>
  );
}

function LoginForm({ onSuccess, overlay }: { onSuccess: () => void; overlay?: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={overlay ? 'modal-backdrop' : 'login-page'}>
      <form className="modal login" onSubmit={submit}>
        <div className="modal-title">SlideSub — вход</div>
        {overlay && <div className="muted">Сессия истекла. Войдите снова — несохранённые правки сохранятся после входа.</div>}
        <label className="field">
          <span>Пароль</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="primary" type="submit" disabled={busy || !password}>
            Войти
          </button>
          <a className="muted" href="/instruction" target="_blank" rel="noreferrer">
            Инструкция
          </a>
        </div>
      </form>
    </div>
  );
}
