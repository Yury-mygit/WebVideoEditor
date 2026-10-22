import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  buildAss,
  msToFrame,
  sceneTimeline,
  sliceProject,
  type Project,
  type RenderJobInfo,
  type RenderRange,
  type RenderStatus,
  type Scene,
} from '@wve/shared';
import { config, logsDir } from './config';
import { projectDir } from './storage';

interface Job extends RenderJobInfo {
  project: Project;
  startedAt: number;
  child: ChildProcess | null;
  partFile: string;
  outFile: string;
  assFile: string;
  logFile: string;
  log: WriteStream | null;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running: Job | null = null;
export const renderEvents = new EventEmitter();
renderEvents.setMaxListeners(100);

const hexColor = (c: string) => '0x' + (/^#?([0-9a-f]{6})$/i.exec(c)?.[1] ?? '000000');

function sceneFilter(scene: Scene, input: number, frames: number, w: number, h: number): string {
  const fit = {
    contain: `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${hexColor(scene.padColor)}`,
    cover: `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    stretch: `scale=${w}:${h}`,
  }[scene.fit];
  // Изображение масштабируется один раз, затем кадр размножается фильтром loop —
  // это намного быстрее, чем декодировать картинку на каждом кадре.
  return (
    `[${input}:v]${fit},setsar=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,` +
    `loop=loop=${frames - 1}:size=1:start=0,setpts=N/FRAME_RATE/TB[v${input}]`
  );
}

/**
 * Путь внутри описания фильтра FFmpeg: прямые слэши, «:» экранируется (C:/… на Windows),
 * значение в одинарных кавычках — так его не разбивают ни разделители опций, ни граф фильтров.
 */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:')}'`;
}

/**
 * Строит аргументы FFmpeg. Пути к материалам относительные: процесс запускается в папке проекта.
 * audioStartMs — с какого места звуковой дорожки начинать (для тестового фрагмента).
 */
export function buildFfmpegArgs(
  project: Project,
  assRel: string,
  outRel: string,
  fontsDir: string | null,
  audioStartMs = 0,
): string[] {
  const { width: w, height: h, fps } = project.output;
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  const chains: string[] = [];
  const timeline = sceneTimeline(project.scenes);
  let inputs = 0;
  for (const t of timeline) {
    // Границы сцен — на целых кадрах, чтобы смена была точной до кадра.
    const frames = msToFrame(t.endMs, fps) - msToFrame(t.startMs, fps);
    if (frames <= 0) continue;
    args.push('-framerate', String(fps), '-i', `assets/${t.scene.image}`);
    chains.push(sceneFilter(t.scene, inputs, frames, w, h));
    inputs++;
  }
  if (!inputs) throw new Error('Нет сцен для рендера');
  const labels = Array.from({ length: inputs }, (_, i) => `[v${i}]`).join('');
  const ass = `ass=${filterPath(assRel)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}`;
  chains.push(`${labels}concat=n=${inputs}:v=1:a=0,${ass}[out]`);
  // Звук начинается вместе с роликом; всё, что длиннее ролика, отрезается (-t на входе).
  const audio: string[] = [];
  if (project.audio) {
    args.push('-ss', String(audioStartMs / 1000), '-t', String(project.output.durationMs / 1000), '-i', `assets/${project.audio}`);
    audio.push('-map', `${inputs}:a:0`, '-c:a', 'aac', '-b:a', '160k');
  }
  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '[out]',
    ...audio,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-f', 'mp4', outRel,
  );
  return args;
}

function publicInfo(job: Job): RenderJobInfo {
  const { id, projectId, status, progress, etaSec, elapsedSec, error, fileName, range } = job;
  return { id, projectId, status, progress, etaSec, elapsedSec, error, fileName, range };
}

function emit(job: Job) {
  renderEvents.emit(job.id, publicInfo(job));
}

function safeFileBase(name: string): string {
  return name.replace(/[^\w\-а-яё ]+/gi, '_').trim().slice(0, 80) || 'video';
}

export function getJob(id: string): RenderJobInfo | null {
  const job = jobs.get(id);
  return job ? publicInfo(job) : null;
}

export function getJobFile(id: string): { path: string; name: string } | null {
  const job = jobs.get(id);
  if (!job || job.status !== 'done' || !job.fileName) return null;
  return { path: job.outFile, name: job.fileName };
}

export function listJobs(projectId: string): RenderJobInfo[] {
  return [...jobs.values()].filter((j) => j.projectId === projectId).map(publicInfo);
}

export async function enqueueRender(projectId: string, project: Project, range: RenderRange | null): Promise<RenderJobInfo> {
  const id = randomUUID();
  const dir = projectDir(projectId);
  await fs.mkdir(path.join(dir, 'renders'), { recursive: true });
  await fs.mkdir(logsDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const suffix = range ? '-test' : '';
  const fileName = `${safeFileBase(project.meta.name)}-${stamp}${suffix}.mp4`;
  const job: Job = {
    id,
    projectId,
    status: 'queued',
    progress: 0,
    etaSec: null,
    elapsedSec: 0,
    error: null,
    fileName,
    range,
    project: range ? sliceProject(project, range) : project,
    startedAt: 0,
    child: null,
    assFile: path.join('renders', `${id}.ass`),
    partFile: path.join('renders', `${id}.part.mp4`),
    outFile: path.join(dir, 'renders', fileName),
    logFile: path.join(logsDir(), `render-${stamp}-${id.slice(0, 8)}.log`),
    log: null,
  };
  jobs.set(id, job);
  queue.push(job);
  void pump();
  return publicInfo(job);
}

export function cancelRender(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    emit(job);
    return true;
  }
  if (job.status === 'running' && job.child) {
    job.status = 'cancelled';
    job.child.kill();
    return true;
  }
  return false;
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift()!;
  running = job;
  try {
    await runJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e instanceof Error ? e.message : String(e);
    job.log?.write(`\n[server] ${job.error}\n`);
  } finally {
    job.log?.end();
    job.child = null;
    running = null;
    emit(job);
    void pump();
  }
}

async function runJob(job: Job): Promise<void> {
  const cwd = projectDir(job.projectId);
  const { project } = job;
  const totalUs = project.output.durationMs * 1000;
  job.status = 'running';
  job.startedAt = Date.now();
  job.log = createWriteStream(job.logFile, { flags: 'a' });
  emit(job);

  await fs.writeFile(path.join(cwd, job.assFile), buildAss(project.subtitles, project.style, project.output, project.meta.name), 'utf8');
  const fontsDir = existsSync(config.fontsDir) ? config.fontsDir : null;
  const args = buildFfmpegArgs(project, job.assFile, job.partFile, fontsDir, job.range?.startMs ?? 0);
  job.log.write(`[server] cwd: ${cwd}\n[server] ${config.ffmpegPath} ${args.map((a) => (/\s|;/.test(a) ? `"${a}"` : a)).join(' ')}\n\n`);

  const child = spawn(config.ffmpegPath, args, { cwd, windowsHide: true });
  job.child = child;
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    job.log?.write(chunk);
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  let buf = '';
  let lastEmit = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^out_time_us=(\d+)/.exec(line.trim());
      if (!m) continue;
      const p = Math.min(1, Number(m[1]) / totalUs);
      job.progress = p;
      job.elapsedSec = (Date.now() - job.startedAt) / 1000;
      job.etaSec = p > 0.005 ? (job.elapsedSec * (1 - p)) / p : null;
      if (Date.now() - lastEmit > 500) {
        lastEmit = Date.now();
        emit(job);
      }
    }
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  job.elapsedSec = (Date.now() - job.startedAt) / 1000;
  const part = path.join(cwd, job.partFile);
  await fs.rm(path.join(cwd, job.assFile), { force: true });

  // Статус мог смениться на cancelled из cancelRender, пока процесс работал.
  if ((job.status as RenderStatus) === 'cancelled') {
    await fs.rm(part, { force: true });
    job.log.write('\n[server] Рендер отменён пользователем\n');
    return;
  }
  if (code !== 0) {
    await fs.rm(part, { force: true });
    const lastLines = stderrTail.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`FFmpeg завершился с кодом ${code}. ${lastLines} (подробности: ${path.basename(job.logFile)})`);
  }
  // НФТ-7: итоговое имя появляется только у полностью записанного файла.
  await fs.rename(part, job.outFile);
  job.progress = 1;
  job.etaSec = 0;
  job.status = 'done';
}

export async function ffmpegVersion(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => resolve(`недоступен: ${e.message}`));
    child.on('close', () => resolve(out.split('\n')[0]?.trim() || 'неизвестно'));
  });
}
