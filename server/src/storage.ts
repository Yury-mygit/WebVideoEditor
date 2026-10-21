import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProject, normalizeProject, type Project, type ProjectSummary } from '@wve/shared';
import { projectsDir } from './config';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const ID_RE = /^[0-9a-f-]{36}$/i;
const ASSET_RE = /^[\w\-. ()а-яё]+$/i;

export const ASSET_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp3', '.wav', '.m4a', '.ogg', '.ttf', '.otf']);

export function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, 'Некорректный id проекта');
  return path.join(projectsDir(), id);
}

export function assetsDir(id: string): string {
  return path.join(projectDir(id), 'assets');
}

export function assetPath(id: string, name: string): string {
  if (!ASSET_RE.test(name) || name.includes('..')) throw new HttpError(400, 'Некорректное имя файла');
  return path.join(assetsDir(id), name);
}

/** Атомарная запись: во временный файл, затем переименование. */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await fs.mkdir(projectsDir(), { recursive: true });
  const ids = (await fs.readdir(projectsDir())).filter((d) => ID_RE.test(d));
  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const p = await loadProject(id);
        return { id, name: p.meta.name, updatedAt: p.meta.updatedAt };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is ProjectSummary => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createNewProject(name: string): Promise<{ id: string; project: Project }> {
  const id = randomUUID();
  const project = createProject(name.trim() || 'Новый проект');
  await fs.mkdir(assetsDir(id), { recursive: true });
  await writeFileAtomic(path.join(projectDir(id), 'project.json'), JSON.stringify(project, null, 2));
  return { id, project };
}

export async function loadProject(id: string): Promise<Project> {
  const file = path.join(projectDir(id), 'project.json');
  if (!existsSync(file)) throw new HttpError(404, 'Проект не найден');
  return normalizeProject(JSON.parse(await fs.readFile(file, 'utf8')));
}

export async function saveProject(id: string, project: Project): Promise<Project> {
  const dir = projectDir(id);
  if (!existsSync(dir)) throw new HttpError(404, 'Проект не найден');
  const saved = normalizeProject({ ...project, meta: { ...project.meta, updatedAt: new Date().toISOString() } });
  await writeFileAtomic(path.join(dir, 'project.json'), JSON.stringify(saved, null, 2));
  return saved;
}

/** Безопасное имя для загруженного файла: короткий префикс + очищенное исходное имя. */
export function makeAssetName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  if (!ASSET_EXTENSIONS.has(ext)) throw new HttpError(400, `Неподдерживаемый тип файла: ${ext || 'без расширения'}`);
  const base =
    path
      .basename(originalName, path.extname(originalName))
      .replace(/[^\w\-а-яё]+/gi, '_')
      .slice(0, 60) || 'file';
  return `${randomUUID().slice(0, 8)}-${base}${ext}`;
}

export async function missingAssets(id: string, project: Project): Promise<string[]> {
  const names = [...project.scenes.map((s) => s.image), ...(project.audio ? [project.audio] : [])];
  return names.filter((n) => {
    try {
      return !existsSync(assetPath(id, n));
    } catch {
      return true;
    }
  });
}
