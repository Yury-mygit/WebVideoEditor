import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { validateProject, type Project, type RenderRange } from '@wve/shared';
import { config } from './config';
import { cancelRender, enqueueRender, ffmpegVersion, getJob, getJobFile, listJobs, renderEvents } from './render';
import {
  HttpError,
  assetPath,
  assetsDir,
  createNewProject,
  listProjects,
  loadProject,
  makeAssetName,
  missingAssets,
  saveProject,
} from './storage';

const app = express();
app.use(express.json({ limit: '50mb' }));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const param = (req: Request, name: string) => String(req.params[name]);

app.get(
  '/api/health',
  h(async (_req, res) => res.json({ ok: true, ffmpeg: await ffmpegVersion() })),
);

app.get(
  '/api/projects',
  h(async (_req, res) => res.json(await listProjects())),
);

app.post(
  '/api/projects',
  h(async (req, res) => res.status(201).json(await createNewProject(String(req.body?.name ?? '')))),
);

app.get(
  '/api/projects/:id',
  h(async (req, res) => res.json(await loadProject(param(req, 'id')))),
);

app.put(
  '/api/projects/:id',
  h(async (req, res) => res.json(await saveProject(param(req, 'id'), req.body as Project))),
);

/** ФТ-66: проверка сохранённого проекта + наличие файлов. */
app.get(
  '/api/projects/:id/check',
  h(async (req, res) => {
    const id = param(req, 'id');
    const project = await loadProject(id);
    const issues = validateProject(project);
    for (const name of await missingAssets(id, project)) issues.unshift({ level: 'error', message: `Файл не найден: ${name}` });
    res.json(issues);
  }),
);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = assetsDir(param(req, 'id'));
      fs.mkdir(dir, { recursive: true }).then(
        () => cb(null, dir),
        (e: Error) => cb(e, ''),
      );
    },
    filename: (req, file, cb) => {
      try {
        // Браузер передаёт имя в multipart в UTF-8, а busboy читает его как latin1.
        const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, makeAssetName(original));
      } catch (e) {
        cb(e as Error, '');
      }
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post(
  '/api/projects/:id/assets',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Файл не передан');
    res.status(201).json({ name: req.file.filename, size: req.file.size });
  }),
);

app.get(
  '/api/projects/:id/assets/:name',
  h(async (req, res) => {
    const file = assetPath(param(req, 'id'), param(req, 'name'));
    if (!existsSync(file)) throw new HttpError(404, 'Файл не найден');
    res.sendFile(file, { maxAge: '1d', immutable: true });
  }),
);

app.post(
  '/api/projects/:id/render',
  h(async (req, res) => {
    const id = param(req, 'id');
    const project = await loadProject(id);
    const missing = await missingAssets(id, project);
    if (missing.length) throw new HttpError(400, `Не найдены файлы: ${missing.join(', ')}`);
    const errors = validateProject(project).filter((i) => i.level === 'error');
    if (errors.length) throw new HttpError(400, errors.map((e) => e.message).join('; '));
    const range = req.body?.range as RenderRange | undefined;
    const validRange =
      range && Number.isFinite(range.startMs) && Number.isFinite(range.durationMs) && range.durationMs > 0 ? range : null;
    res.status(202).json(await enqueueRender(id, project, validRange));
  }),
);

app.get(
  '/api/projects/:id/renders',
  h(async (req, res) => res.json(listJobs(param(req, 'id')))),
);

app.get('/api/renders/:jobId', (req, res) => {
  const job = getJob(param(req, 'jobId'));
  if (!job) return void res.status(404).json({ error: 'Задание не найдено' });
  res.json(job);
});

/** ФТ-63: прогресс рендера через Server-Sent Events. */
app.get('/api/renders/:jobId/events', (req, res) => {
  const jobId = param(req, 'jobId');
  const job = getJob(jobId);
  if (!job) return void res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (info: unknown) => res.write(`data: ${JSON.stringify(info)}\n\n`);
  send(job);
  const listener = (info: { status: string }) => {
    send(info);
    if (!['queued', 'running'].includes(info.status)) res.end();
  };
  renderEvents.on(jobId, listener);
  req.on('close', () => renderEvents.off(jobId, listener));
});

app.post('/api/renders/:jobId/cancel', (req, res) => {
  res.json({ cancelled: cancelRender(param(req, 'jobId')) });
});

app.get('/api/renders/:jobId/file', (req, res) => {
  const file = getJobFile(param(req, 'jobId'));
  if (!file || !existsSync(file.path)) return void res.status(404).json({ error: 'Файл не готов' });
  res.download(file.path, file.name);
});

if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Express 5 передаёт ошибку listen (например, занятый порт) в колбэк.
app.listen(config.port, config.host, async (err?: Error) => {
  if (err) {
    console.error(`Не удалось запустить сервер на ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`SlideSub server: http://${config.host}:${config.port}`);
  console.log(`Данные: ${config.dataDir}`);
  console.log(`FFmpeg: ${await ffmpegVersion()}`);
});
