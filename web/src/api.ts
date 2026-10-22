import type { Project, ProjectIssue, ProjectSummary, RenderJobInfo, RenderRange } from '@wve/shared';

export const UNAUTHORIZED_EVENT = 'slidesub:unauthorized';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // Сессия истекла или пароль сменили — показываем вход.
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new Error(data?.error ?? `Ошибка ${res.status}`);
  return data as T;
}

export const api = {
  authStatus: () => request<{ required: boolean; authorized: boolean }>('GET', '/api/auth/status'),
  login: (password: string) => request<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  health: () => request<{ ok: boolean; ffmpeg: string }>('GET', '/api/health'),
  listProjects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string) => request<{ id: string; project: Project }>('POST', '/api/projects', { name }),
  loadProject: (id: string) => request<Project>('GET', `/api/projects/${id}`),
  saveProject: (id: string, project: Project) => request<Project>('PUT', `/api/projects/${id}`, project),
  checkProject: (id: string) => request<ProjectIssue[]>('GET', `/api/projects/${id}/check`),
  startRender: (id: string, range: RenderRange | null) =>
    request<RenderJobInfo>('POST', `/api/projects/${id}/render`, range ? { range } : {}),
  cancelRender: (jobId: string) => request<{ cancelled: boolean }>('POST', `/api/renders/${jobId}/cancel`),
  listRenders: (id: string) => request<RenderJobInfo[]>('GET', `/api/projects/${id}/renders`),

  async uploadAsset(id: string, file: File): Promise<string> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: fd });
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `Ошибка загрузки ${file.name}`);
    return data.name as string;
  },
};

export const assetUrl = (projectId: string, name: string) =>
  `/api/projects/${projectId}/assets/${encodeURIComponent(name)}`;

export const renderFileUrl = (jobId: string) => `/api/renders/${jobId}/file`;

export function watchRender(jobId: string, onUpdate: (job: RenderJobInfo) => void): () => void {
  const es = new EventSource(`/api/renders/${jobId}/events`);
  es.onmessage = (e) => {
    const job = JSON.parse(e.data) as RenderJobInfo;
    onUpdate(job);
    if (!['queued', 'running'].includes(job.status)) es.close();
  };
  return () => es.close();
}
