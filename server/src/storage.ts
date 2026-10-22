import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createProject,
  detectFormat,
  normalizeProject,
  parseAss,
  parseSrt,
  parseTxt,
  sortCues,
  withIds,
  type Project,
  type ProjectSummary,
  type TxtTimingMode,
} from '@wve/shared';
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

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.txt']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);
export const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...SUBTITLE_EXTENSIONS, ...AUDIO_EXTENSIONS, '.ttf', '.otf']);
const RESULT_RE = /^[\w\-. ()а-яё]+\.mp4$/i;

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

export interface FileInfo {
  name: string;
  size: number;
  modified: string;
}

async function listDir(dir: string, filter: (name: string) => boolean): Promise<FileInfo[]> {
  if (!existsSync(dir)) return [];
  const names = (await fs.readdir(dir)).filter(filter);
  const items = await Promise.all(
    names.map(async (name) => {
      const st = await fs.stat(path.join(dir, name));
      return st.isFile() ? { name, size: st.size, modified: st.mtime.toISOString() } : null;
    }),
  );
  return items.filter((x): x is FileInfo => !!x).sort((a, b) => b.modified.localeCompare(a.modified));
}

export function listAssets(id: string): Promise<FileInfo[]> {
  return listDir(assetsDir(id), (n) => ASSET_EXTENSIONS.has(path.extname(n).toLowerCase()));
}

/** Готовые ролики берём с диска, а не из памяти: скачать можно и после перезапуска сервера. */
export function listResults(id: string): Promise<FileInfo[]> {
  return listDir(path.join(projectDir(id), 'renders'), (n) => RESULT_RE.test(n) && !n.endsWith('.part.mp4'));
}

export function resultPath(id: string, name: string): string {
  if (!RESULT_RE.test(name) || name.includes('..') || name.endsWith('.part.mp4')) throw new HttpError(400, 'Некорректное имя файла');
  const file = path.join(projectDir(id), 'renders', name);
  if (!existsSync(file)) throw new HttpError(404, 'Файл не найден');
  return file;
}

/** Текст файла субтитров: UTF-8, а если не читается — Windows-1251 (частый случай для русских SRT). */
function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

/** Импорт субтитров из файла в assets проекта (заменяет текущие реплики). */
export async function importSubtitlesFromAsset(
  id: string,
  name: string,
  txtMode: TxtTimingMode = 'chars',
): Promise<{ project: Project; count: number; format: string }> {
  const file = assetPath(id, name);
  if (!existsSync(file)) throw new HttpError(404, `Файл не найден: ${name}`);
  if (!SUBTITLE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new HttpError(400, 'Нужен файл .srt, .ass, .ssa или .txt');
  const text = decodeText(await fs.readFile(file));
  const project = await loadProject(id);
  const format = detectFormat(name, text);
  const drafts =
    format === 'srt' ? parseSrt(text) : format === 'ass' ? parseAss(text) : parseTxt(text, project.output.durationMs, txtMode, 200);
  if (!drafts.length) throw new HttpError(400, `В файле ${name} не найдено ни одной реплики`);
  const saved = await saveProject(id, { ...project, subtitles: sortCues(withIds(drafts)) });
  return { project: saved, count: drafts.length, format };
}

/** Скачивает файл по ссылке прямо в assets проекта (картинки, субтитры, аудио). */
export async function downloadToAssets(id: string, url: string, fileName?: string): Promise<FileInfo> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Некорректная ссылка');
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Поддерживаются только ссылки http и https');
  const original = fileName || decodeURIComponent(path.basename(u.pathname)) || 'file';
  const name = makeAssetName(original);
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new HttpError(502, `Не удалось скачать: HTTP ${res.status}`);
  const limit = 500 * 1024 * 1024;
  if (Number(res.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'Файл больше 500 МБ');
  await fs.mkdir(assetsDir(id), { recursive: true });
  const target = assetPath(id, name);
  const tmp = `${target}.download`;
  let size = 0;
  const out = createWriteStream(tmp);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Файл больше 500 МБ');
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    await fs.rename(tmp, target);
  } catch (e) {
    out.destroy();
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { name, size, modified: new Date().toISOString() };
}

/** Сохраняет текст субтитров (переданный, например, через MCP) как файл в assets проекта. */
export async function saveTextAsset(id: string, content: string, format?: 'srt' | 'ass' | 'txt'): Promise<string> {
  const ext = format ?? detectFormat('', content);
  const name = makeAssetName(`subtitles.${ext}`);
  await fs.mkdir(assetsDir(id), { recursive: true });
  await fs.writeFile(assetPath(id, name), content, 'utf8');
  return name;
}
