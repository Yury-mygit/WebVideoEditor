import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  buildAss,
  buildSegments,
  cuesAfterCuts,
  finalDurationMs,
  keptPieces,
  msToFrame,
  toFinalMs,
  sliceProject,
  sliceSegments,
  type Cut,
  type Project,
  type RenderJobInfo,
  type RenderRange,
  type RenderStatus,
  type Scene,
  type Segment,
} from '@wve/shared';
import { config, logsDir } from './config';
import { projectDir } from './storage';

interface Job extends RenderJobInfo {
  /** Проект в пределах собираемого видео: реплики и длительность уже без вырезов. */
  project: Project;
  /** Отрезки с переходами: считаются по всей ленте и режутся по кускам между вырезами. */
  segments: Segment[];
  /** Куски ленты (они же куски звуковой записи), которые идут в видео подряд. */
  pieces: Cut[];
  /** Фильтр громкости для проявления и затемнения — свой у каждого куска. */
  audioFilters: (string | null)[];
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

/** tail — дополнительные фильтры слоя (для верхнего слоя перехода — прозрачность). */
function sceneFilter(scene: Scene, input: number, frames: number, w: number, h: number, label: string, tail: string): string {
  const fit = {
    contain: `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${hexColor(scene.padColor)}`,
    cover: `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    stretch: `scale=${w}:${h}`,
  }[scene.fit];
  // Изображение масштабируется один раз, затем кадр размножается фильтром loop —
  // это намного быстрее, чем декодировать картинку на каждом кадре.
  return (
    `[${input}:v]${fit},setsar=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,` +
    `loop=loop=${frames - 1}:size=1:start=0,setpts=N/FRAME_RATE/TB${tail}[${label}]`
  );
}

/** Затухание и нарастание звука на месте выреза, с. */
const SPLICE_FADE_SEC = 0.03;

function blackFilter(frames: number, w: number, h: number, fps: number, label: string, tail: string): string {
  return `color=c=black:s=${w}x${h}:r=${fps},format=yuv420p,trim=end_frame=${frames},setpts=N/FRAME_RATE/TB${tail}[${label}]`;
}

/**
 * ФТ-16: громкость для проявления и затемнения во времени всей ленты.
 * t в фильтре — время от начала куска звука, startMs — его начало на ленте.
 */
export function audioFadeFilter(project: Project, startMs: number): string | null {
  const { fadeInMs, fadeOutMs, fadeAudio } = project.transitions;
  if (!fadeAudio || (!fadeInMs && !fadeOutMs)) return null;
  const t = `(t+${startMs / 1000})`;
  const terms: string[] = [];
  if (fadeInMs) terms.push(`clip(${t}/${fadeInMs / 1000},0,1)`);
  if (fadeOutMs) terms.push(`clip((${project.output.durationMs / 1000}-${t})/${fadeOutMs / 1000},0,1)`);
  return `volume='${terms.join('*')}':eval=frame`;
}

export interface RenderOptions {
  fontsDir: string | null;
  /** Куски звуковой записи, которые идут в видео подряд (между вырезами, с начала тестового фрагмента). */
  audioPieces: readonly Cut[];
  /** Фильтры громкости кусков для проявления и затемнения. */
  audioFilters: readonly (string | null)[];
}

/**
 * Путь внутри описания фильтра FFmpeg: прямые слэши, «:» экранируется (C:/… на Windows),
 * значение в одинарных кавычках — так его не разбивают ни разделители опций, ни граф фильтров.
 */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:')}'`;
}

/**
 * Строит аргументы FFmpeg по раскладке на отрезки. Пути к материалам относительные:
 * процесс запускается в папке проекта.
 */
export function buildFfmpegArgs(
  project: Project,
  segments: readonly Segment[],
  assRel: string,
  outRel: string,
  { fontsDir, audioPieces, audioFilters }: RenderOptions,
): string[] {
  const { width: w, height: h, fps } = project.output;
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  const chains: string[] = [];
  let inputs = 0;
  // Слой отрезка: картинка сцены (отдельный вход) или чёрный кадр.
  const layer = (scene: Scene | null, frames: number, label: string, tail = '') => {
    if (!scene) return void chains.push(blackFilter(frames, w, h, fps, label, tail));
    args.push('-framerate', String(fps), '-i', `assets/${scene.image}`);
    chains.push(sceneFilter(scene, inputs++, frames, w, h, label, tail));
  };
  segments.forEach((s, i) => {
    if (s.kind === 'still') return layer(s.scene, s.frames, `v${i}`);
    // Переход: второй слой накладывается на первый с растущей непрозрачностью p0 + step·k.
    // Это p = (k + c) / m с целыми c и m: прозрачность даёт fade по времени (точный даже для
    // переходов в несколько минут), а первые c кадров, нужные только для отсчёта, отрезаются.
    // overlay + fade быстрее покадровой формулы blend в десятки раз.
    const m = Math.round(1 / s.step);
    const c = Math.round(s.p0 / s.step);
    layer(s.from, s.frames, `a${i}`);
    layer(
      s.to,
      s.frames + c,
      `b${i}`,
      `,format=yuva420p,fade=t=in:st=0:d=${m / fps}:alpha=1,trim=start_frame=${c},setpts=N/FRAME_RATE/TB`,
    );
    chains.push(`[a${i}][b${i}]overlay=format=yuv420,setpts=N/FRAME_RATE/TB[v${i}]`);
  });
  if (!segments.length) throw new Error('Нет сцен для рендера');
  const labels = segments.map((_, i) => `[v${i}]`).join('');
  const ass = `ass=${filterPath(assRel)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}`;
  chains.push(`${labels}concat=n=${segments.length}:v=1:a=0,${ass}[out]`);
  // Звук начинается вместе с роликом; всё, что длиннее ролика, отрезается (-t на входе).
  // С вырезами каждый кусок записи — отдельный вход, куски склеиваются concat.
  const audio: string[] = [];
  if (project.audio && audioPieces.length) {
    const first = inputs;
    for (const piece of audioPieces) {
      args.push('-ss', String(piece.startMs / 1000), '-t', String((piece.endMs - piece.startMs) / 1000), '-i', `assets/${project.audio}`);
      inputs++;
    }
    // На склейках — короткое затухание и нарастание, чтобы не было щелчков.
    const labels = audioPieces.map((piece, k) => {
      const len = (piece.endMs - piece.startMs) / 1000;
      const filters = [
        ...(audioFilters[k] ? [audioFilters[k]] : []),
        ...(k > 0 ? [`afade=t=in:d=${SPLICE_FADE_SEC}`] : []),
        ...(k < audioPieces.length - 1 ? [`afade=t=out:st=${Math.max(0, len - SPLICE_FADE_SEC)}:d=${SPLICE_FADE_SEC}`] : []),
      ];
      if (!filters.length) return `${first + k}:a:0`;
      chains.push(`[${first + k}:a]${filters.join(',')}[ap${k}]`);
      return `[ap${k}]`;
    });
    if (labels.length > 1) {
      // У нескольких кусков фильтры есть всегда (склейки), так что все метки в скобках.
      chains.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
      audio.push('-map', '[aout]');
    } else {
      audio.push('-map', labels[0]);
    }
    audio.push('-c:a', 'aac', '-b:a', '160k');
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
  // Вырезы: собирается только то, что между ними. Тестовый фрагмент — с места ленты range.startMs,
  // длиной range.durationMs уже в собранном видео.
  const { fps, durationMs } = project.output;
  const { cuts } = project;
  const totalMs = finalDurationMs(cuts, durationMs);
  const fromFinal = range ? Math.min(toFinalMs(cuts, range.startMs), Math.max(0, totalMs - range.durationMs)) : 0;
  const lengthMs = range ? Math.min(range.durationMs, totalMs - fromFinal) : totalMs;
  const pieces = keptPieces(cuts, fromFinal, lengthMs);
  const allSegments = buildSegments(project);
  const segments = pieces.flatMap((p) => sliceSegments(allSegments, msToFrame(p.startMs, fps), msToFrame(p.endMs, fps)));
  const finalProject: Project = {
    ...project,
    output: { ...project.output, durationMs: totalMs },
    subtitles: cuesAfterCuts(project.subtitles, cuts),
    cuts: [],
  };
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
    project: range ? sliceProject(finalProject, { startMs: fromFinal, durationMs: lengthMs }) : finalProject,
    segments,
    pieces,
    audioFilters: pieces.map((p) => audioFadeFilter(project, p.startMs)),
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
  const args = buildFfmpegArgs(project, job.segments, job.assFile, job.partFile, {
    fontsDir,
    audioPieces: job.pieces,
    audioFilters: job.audioFilters,
  });
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
