import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  createScene,
  cueIssues,
  CUE_ISSUE_LABELS,
  finalDurationMs,
  normalizeCuts,
  fitLastScene,
  formatSrtTime,
  sceneTimeline,
  sortCues,
  splitEvenly,
  validateProject,
  type FitMode,
  type Project,
  type Scene,
  type Transition,
} from '@wve/shared';
import { config } from './config';
import { authEnabled } from './auth';
import { cancelRender, enqueueRender, getJob, listJobs } from './render';
import {
  AUDIO_EXTENSIONS,
  HttpError,
  IMAGE_EXTENSIONS,
  createNewProject,
  downloadToAssets,
  importSubtitlesFromAsset,
  listAssets,
  listProjects,
  listResults,
  loadProject,
  missingAssets,
  saveProject,
  saveTextAsset,
} from './storage';

/**
 * MCP-сервер SlideSub (Streamable HTTP, без сессий: на каждый запрос — свой экземпляр).
 * Большие файлы через MCP не передаются: инструменты возвращают готовые команды curl
 * для загрузки материалов и ссылки для скачивания результата.
 */

const FIT = z.enum(['cover', 'contain', 'stretch']);
const TRANSITION = z.object({
  type: z.enum(['cut', 'crossfade', 'dip']).describe('cut — резко, crossfade — плавно, dip — через чёрный'),
  durationSec: z.number().nonnegative().describe('Полная длительность: половина до границы сцен, половина после'),
});
const ms = (sec: number) => Math.round(sec * 1000);
const CUT_FADE = z
  .union([z.literal(0), z.literal(0.5), z.literal(1), z.literal(2), z.literal(5)])
  .describe('Затухание картинки и звука у границ выреза, с: гаснут за столько до начала и проявляются столько же после конца; 0 — резко');
const sec = (msValue: number) => msValue / 1000;
const transitionView = (t: Transition) => ({ type: t.type, durationSec: sec(t.durationMs) });
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
});

type ToolResult = ReturnType<typeof json> | ReturnType<typeof fail>;
const safe =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return json(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

/** Регистрация инструмента без тяжёлых обобщённых типов SDK (иначе TS упирается в глубину инстанцирования). */
function tool<S extends z.ZodRawShape = {}>(
  server: McpServer,
  name: string,
  cfg: { title?: string; description?: string; inputSchema?: S },
  cb: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
) {
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: object,
    f: (a: unknown) => Promise<ToolResult>,
  ) => void;
  register(name, cfg, cb as (a: unknown) => Promise<ToolResult>);
}

function links(base: string, projectId: string) {
  const auth = authEnabled() ? ' -H "Authorization: Bearer $SLIDESUB_PASSWORD"' : '';
  return {
    upload: `curl${auth} -F "file=@<путь к файлу>" ${base}/api/projects/${projectId}/assets`,
    uploadNote:
      'Ответ — {"name": "<имя на сервере>"}; это имя передавайте в add_scenes, import_subtitles или update_project (audio). ' +
      'Картинки: JPG, PNG, WEBP. Субтитры: SRT, ASS, TXT. Звук: M4A, MP3, WAV, AAC, OGG. Пароль — переменная окружения SLIDESUB_PASSWORD.',
    download: `curl${auth} -o <файл.mp4> "${base}/api/projects/${projectId}/results/<имя файла>"`,
    editor: `${base}/#/p/${projectId}`,
  };
}

function summary(project: Project, base: string, projectId: string) {
  return {
    projectId,
    name: project.meta.name,
    updatedAt: project.meta.updatedAt,
    output: {
      width: project.output.width,
      height: project.output.height,
      fps: project.output.fps,
      duration: formatSrtTime(project.output.durationMs),
      durationSec: project.output.durationMs / 1000,
    },
    scenes: sceneTimeline(project.scenes).map((t) => ({
      index: t.index + 1,
      image: t.scene.image,
      start: formatSrtTime(t.startMs),
      durationSec: t.scene.durationMs / 1000,
      fit: t.scene.fit,
      padColor: t.scene.padColor,
      ...(t.scene.transition ? { transition: transitionView(t.scene.transition) } : {}),
    })),
    transitions: {
      fadeInSec: sec(project.transitions.fadeInMs),
      fadeOutSec: sec(project.transitions.fadeOutMs),
      fadeAudio: project.transitions.fadeAudio,
    },
    audio: project.audio,
    cuts: project.cuts.map((c, i) => ({
      index: i + 1,
      start: formatSrtTime(c.startMs),
      end: formatSrtTime(c.endMs),
      ...(c.fadeMs ? { fadeSec: sec(c.fadeMs) } : {}),
    })),
    finalDuration: formatSrtTime(finalDurationMs(project.cuts, project.output.durationMs)),
    subtitlesCount: project.subtitles.length,
    style: project.style,
    issues: validateProject(project),
    links: links(base, projectId),
  };
}

export function createMcpServer(base: string): McpServer {
  const server = new McpServer({ name: 'slidesub', version: '0.2.0' });

  tool(
    server,
    'list_projects',
    { title: 'Список проектов', description: 'Все проекты SlideSub на сервере: id, название, дата изменения.' },
    safe(async () => listProjects()),
  );

  tool(
    server,
    'create_project',
    {
      title: 'Создать проект',
      description:
        'Создаёт проект ролика из картинок и субтитров. Возвращает projectId и команды для загрузки материалов.',
      inputSchema: {
        name: z.string().describe('Название ролика'),
        durationSec: z.number().positive().optional().describe('Длительность ролика в секундах (по умолчанию 5400 = 1:30:00)'),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().int().positive().optional(),
      },
    },
    safe(async ({ name, durationSec, width, height, fps }) => {
      const { id, project } = await createNewProject(name);
      const output = { ...project.output };
      if (durationSec) output.durationMs = ms(durationSec);
      if (width && height) Object.assign(output, { width, height });
      if (fps) output.fps = fps;
      const saved = await saveProject(id, { ...project, output });
      return summary(saved, base, id);
    }),
  );

  tool(
    server,
    'get_project',
    {
      title: 'Проект',
      description: 'Настройки проекта: вывод, сцены, стиль, число реплик, замечания, ссылки для загрузки и скачивания.',
      inputSchema: { projectId: z.string() },
    },
    safe(async ({ projectId }) => summary(await loadProject(projectId), base, projectId)),
  );

  tool(
    server,
    'list_assets',
    {
      title: 'Материалы проекта',
      description: 'Файлы, загруженные в проект (картинки, субтитры, аудио), и команда curl для загрузки новых.',
      inputSchema: { projectId: z.string() },
    },
    safe(async ({ projectId }) => ({ files: await listAssets(projectId), ...links(base, projectId) })),
  );

  tool(
    server,
    'import_asset_from_url',
    {
      title: 'Скачать материал по ссылке',
      description: 'Сервер сам скачивает файл по http(s)-ссылке в материалы проекта. Возвращает имя файла на сервере.',
      inputSchema: {
        projectId: z.string(),
        url: z.string().url(),
        fileName: z.string().optional().describe('Имя с расширением, если в ссылке его нет, например photo.jpg'),
      },
    },
    safe(async ({ projectId, url, fileName }) => downloadToAssets(projectId, url, fileName)),
  );

  tool(
    server,
    'add_scenes',
    {
      title: 'Добавить сцены',
      description:
        'Добавляет загруженные картинки как сцены в конец ролика. По умолчанию длительность ролика делится поровну между всеми сценами.',
      inputSchema: {
        projectId: z.string(),
        images: z.array(z.string()).min(1).describe('Имена файлов на сервере (из ответа загрузки или list_assets)'),
        fit: FIT.optional().describe('cover — обрезать, contain — вписать с полями, stretch — растянуть'),
        splitEvenly: z.boolean().optional().default(true),
      },
    },
    safe(async ({ projectId, images, fit, splitEvenly: split }) => {
      const files = new Set((await listAssets(projectId)).map((f) => f.name));
      for (const img of images) {
        if (!files.has(img)) throw new HttpError(404, `Нет такого файла в проекте: ${img}`);
        if (!IMAGE_EXTENSIONS.has(img.slice(img.lastIndexOf('.')).toLowerCase())) throw new HttpError(400, `Не картинка: ${img}`);
      }
      const p = await loadProject(projectId);
      const scenes = [...p.scenes, ...images.map((img) => ({ ...createScene(img, 0), ...(fit ? { fit } : {}) }))];
      const saved = await saveProject(projectId, { ...p, scenes: split ? splitEvenly(scenes, p.output) : scenes });
      return summary(saved, base, projectId);
    }),
  );

  tool(
    server,
    'update_project',
    {
      title: 'Изменить проект',
      description:
        'Меняет название, длительность, разрешение, частоту кадров, стиль субтитров, звуковую дорожку, ' +
        'проявление и затемнение и/или список сцен. scenes заменяет весь список (порядок, длительности, подгонка, ' +
        'переход после сцены). splitEvenly делит длительность поровну, fitLastScene подгоняет последнюю сцену. ' +
        'Переход задаётся у каждой сцены отдельно и не сдвигает тайминги: идёт симметрично относительно границы сцен.',
      inputSchema: {
        projectId: z.string(),
        name: z.string().optional(),
        durationSec: z.number().positive().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().int().positive().optional(),
        style: z
          .object({
            fontFamily: z.string(),
            fontSize: z.number(),
            bold: z.boolean(),
            italic: z.boolean(),
            color: z.string().describe('#rrggbb'),
            outlineWidth: z.number(),
            outlineColor: z.string(),
            shadow: z.number(),
            shadowColor: z.string(),
            boxEnabled: z.boolean(),
            boxColor: z.string(),
            boxOpacity: z.number().min(0).max(1),
            boxPadding: z.number(),
            position: z.enum(['bottom', 'middle', 'top']),
            marginV: z.number(),
            align: z.enum(['left', 'center', 'right']),
            maxWidthPct: z.number(),
          })
          .partial()
          .optional()
          .describe('Только изменяемые поля стиля'),
        scenes: z
          .array(
            z.object({
              image: z.string(),
              durationSec: z.number().nonnegative().optional(),
              fit: FIT.optional(),
              padColor: z.string().optional(),
              transition: TRANSITION.nullable().optional().describe('Переход к следующей сцене; null — резкая смена'),
            }),
          )
          .optional(),
        fadeInSec: z.number().nonnegative().optional().describe('Проявление из чёрного в начале ролика, 0 — нет'),
        fadeOutSec: z.number().nonnegative().optional().describe('Затемнение в чёрный в конце ролика, 0 — нет'),
        fadeAudio: z.boolean().optional().describe('Звук нарастает и затихает вместе с проявлением и затемнением'),
        splitEvenly: z.boolean().optional(),
        fitLastScene: z.boolean().optional(),
        audio: z
          .string()
          .nullable()
          .optional()
          .describe('Звуковая дорожка: имя загруженного аудиофайла (идёт с начала ролика, лишнее отрезается); null — убрать звук'),
      },
    },
    safe(async (a) => {
      const p = await loadProject(a.projectId);
      if (a.audio) {
        const files = new Set((await listAssets(a.projectId)).map((f) => f.name));
        if (!files.has(a.audio)) throw new HttpError(404, `Нет такого файла в проекте: ${a.audio}`);
        if (!AUDIO_EXTENSIONS.has(a.audio.slice(a.audio.lastIndexOf('.')).toLowerCase())) throw new HttpError(400, `Не аудиофайл: ${a.audio}`);
      }
      let next: Project = {
        ...p,
        meta: { ...p.meta },
        output: { ...p.output },
        style: { ...p.style, ...(a.style ?? {}) },
        transitions: { ...p.transitions },
      };
      if (a.fadeInSec !== undefined) next.transitions.fadeInMs = ms(a.fadeInSec);
      if (a.fadeOutSec !== undefined) next.transitions.fadeOutMs = ms(a.fadeOutSec);
      if (a.fadeAudio !== undefined) next.transitions.fadeAudio = a.fadeAudio;
      if (a.name) next.meta.name = a.name;
      if (a.durationSec) next.output.durationMs = ms(a.durationSec);
      if (a.width && a.height) Object.assign(next.output, { width: a.width, height: a.height });
      if (a.fps) next.output.fps = a.fps;
      if (a.audio !== undefined) next.audio = a.audio;
      if (a.scenes) {
        const files = new Set((await listAssets(a.projectId)).map((f) => f.name));
        for (const s of a.scenes) if (!files.has(s.image)) throw new HttpError(404, `Нет такого файла в проекте: ${s.image}`);
        const old = new Map(p.scenes.map((s) => [s.image, s]));
        next.scenes = a.scenes.map((s): Scene => {
          const prev = old.get(s.image) ?? createScene(s.image, 0);
          const scene: Scene = {
            ...prev,
            durationMs: s.durationSec !== undefined ? ms(s.durationSec) : prev.durationMs,
            fit: (s.fit as FitMode | undefined) ?? prev.fit,
            padColor: s.padColor ?? prev.padColor,
          };
          if (s.transition === null || s.transition?.type === 'cut') delete scene.transition;
          else if (s.transition) scene.transition = { type: s.transition.type, durationMs: ms(s.transition.durationSec) };
          return scene;
        });
      }
      if (a.splitEvenly) next = { ...next, scenes: splitEvenly(next.scenes, next.output) };
      if (a.fitLastScene) next = { ...next, scenes: fitLastScene(next.scenes, next.output.durationMs) };
      return summary(await saveProject(a.projectId, next), base, a.projectId);
    }),
  );

  tool(
    server,
    'cut_fragment',
    {
      title: 'Вырезать кусок',
      description:
        'Ставит вырез на ленте: при сборке этот кусок пропускается целиком (картинка, звук, субтитры), видео становится короче. ' +
        'Сцены, звук и реплики не меняются — время везде остаётся временем ленты (записи звука), вырез можно убрать (remove_cut). ' +
        'Пересекающиеся вырезы склеиваются. В ответе cuts и finalDuration — длина собранного видео.',
      inputSchema: {
        projectId: z.string(),
        startSec: z.number().nonnegative().describe('Начало куска на ленте, с'),
        endSec: z.number().positive().describe('Конец куска на ленте, с'),
        fadeSec: CUT_FADE.optional(),
      },
    },
    safe(async ({ projectId, startSec, endSec, fadeSec }) => {
      if (endSec <= startSec) throw new HttpError(400, 'Конец куска должен быть позже начала');
      const p = await loadProject(projectId);
      const cuts = normalizeCuts([...p.cuts, { startMs: ms(startSec), endMs: ms(endSec), fadeMs: ms(fadeSec ?? 0) }]);
      return summary(await saveProject(projectId, { ...p, cuts }), base, projectId);
    }),
  );

  tool(
    server,
    'update_cut',
    {
      title: 'Изменить вырез',
      description: 'Меняет границы или затухание выреза по номеру из get_project (cuts[].index); не заданные поля остаются как были.',
      inputSchema: {
        projectId: z.string(),
        index: z.number().int().positive(),
        startSec: z.number().nonnegative().optional(),
        endSec: z.number().positive().optional(),
        fadeSec: CUT_FADE.optional(),
      },
    },
    safe(async ({ projectId, index, startSec, endSec, fadeSec }) => {
      const p = await loadProject(projectId);
      const old = p.cuts[index - 1];
      if (!old) throw new HttpError(404, `Нет выреза с номером ${index}`);
      const cut = {
        startMs: startSec !== undefined ? ms(startSec) : old.startMs,
        endMs: endSec !== undefined ? ms(endSec) : old.endMs,
        fadeMs: fadeSec !== undefined ? ms(fadeSec) : old.fadeMs,
      };
      if (cut.endMs <= cut.startMs) throw new HttpError(400, 'Конец куска должен быть позже начала');
      const cuts = normalizeCuts([...p.cuts.filter((_, i) => i !== index - 1), cut]);
      return summary(await saveProject(projectId, { ...p, cuts }), base, projectId);
    }),
  );

  tool(
    server,
    'remove_cut',
    {
      title: 'Убрать вырез',
      description: 'Убирает вырез по номеру из get_project (cuts[].index): кусок снова попадёт в видео.',
      inputSchema: { projectId: z.string(), index: z.number().int().positive() },
    },
    safe(async ({ projectId, index }) => {
      const p = await loadProject(projectId);
      if (index > p.cuts.length) throw new HttpError(404, `Нет выреза с номером ${index}`);
      return summary(await saveProject(projectId, { ...p, cuts: p.cuts.filter((_, i) => i !== index - 1) }), base, projectId);
    }),
  );

  tool(
    server,
    'import_subtitles',
    {
      title: 'Импорт субтитров',
      description:
        'Заменяет реплики проекта субтитрами из загруженного файла (SRT, ASS или TXT: одна строка — одна реплика). ' +
        'Небольшие субтитры можно передать текстом в content — тогда файл не нужен.',
      inputSchema: {
        projectId: z.string(),
        assetName: z.string().optional().describe('Имя файла на сервере'),
        content: z.string().optional().describe('Текст SRT/ASS/TXT, если файл не загружали'),
        format: z.enum(['srt', 'ass', 'txt']).optional().describe('Формат content (по умолчанию определяется сам)'),
        txtMode: z.enum(['chars', 'even']).optional().describe('Для TXT: тайминги по длине строк или поровну'),
      },
    },
    safe(async ({ projectId, assetName, content, format, txtMode }) => {
      let name = assetName;
      if (!name) {
        if (!content) throw new HttpError(400, 'Нужен assetName или content');
        name = await saveTextAsset(projectId, content, format);
      }
      const { project, count } = await importSubtitlesFromAsset(projectId, name, txtMode);
      const issues = cueIssues(project.subtitles, project.output.durationMs);
      return { imported: count, file: name, cuesWithIssues: issues.size, projectIssues: validateProject(project) };
    }),
  );

  tool(
    server,
    'get_subtitles',
    {
      title: 'Реплики',
      description: 'Постранично возвращает реплики (номер, начало, конец, текст, замечания). onlyIssues — только проблемные.',
      inputSchema: {
        projectId: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().positive().max(500).optional().default(50),
        onlyIssues: z.boolean().optional(),
      },
    },
    safe(async ({ projectId, offset, limit, onlyIssues }) => {
      const p = await loadProject(projectId);
      const issues = cueIssues(p.subtitles, p.output.durationMs);
      const rows = p.subtitles
        .map((c, i) => ({
          n: i + 1,
          id: c.id,
          start: formatSrtTime(c.startMs),
          end: formatSrtTime(c.endMs),
          text: c.text,
          issues: (issues.get(c.id) ?? []).map((k) => CUE_ISSUE_LABELS[k]),
        }))
        .filter((r) => !onlyIssues || r.issues.length);
      return { total: rows.length, offset, items: rows.slice(offset, offset + limit) };
    }),
  );

  tool(
    server,
    'edit_subtitles',
    {
      title: 'Правка реплик',
      description:
        'Правит реплики по номеру (как в get_subtitles): текст и время. deleteNumbers удаляет реплики. shiftMs сдвигает все реплики.',
      inputSchema: {
        projectId: z.string(),
        updates: z
          .array(
            z.object({
              n: z.number().int().positive(),
              text: z.string().optional(),
              startSec: z.number().nonnegative().optional(),
              endSec: z.number().nonnegative().optional(),
            }),
          )
          .optional(),
        deleteNumbers: z.array(z.number().int().positive()).optional(),
        shiftMs: z.number().int().optional(),
      },
    },
    safe(async ({ projectId, updates, deleteNumbers, shiftMs }) => {
      const p = await loadProject(projectId);
      let cues = p.subtitles.map((c) => ({ ...c }));
      for (const u of updates ?? []) {
        const c = cues[u.n - 1];
        if (!c) throw new HttpError(400, `Нет реплики №${u.n}`);
        if (u.text !== undefined) c.text = u.text;
        if (u.startSec !== undefined) c.startMs = ms(u.startSec);
        if (u.endSec !== undefined) c.endMs = ms(u.endSec);
      }
      const del = new Set((deleteNumbers ?? []).map((n) => cues[n - 1]?.id));
      cues = cues.filter((c) => !del.has(c.id));
      if (shiftMs) cues = cues.map((c) => ({ ...c, startMs: Math.max(0, c.startMs + shiftMs), endMs: Math.max(0, c.endMs + shiftMs) }));
      const saved = await saveProject(projectId, { ...p, subtitles: sortCues(cues) });
      return { subtitlesCount: saved.subtitles.length, cuesWithIssues: cueIssues(saved.subtitles, saved.output.durationMs).size };
    }),
  );

  tool(
    server,
    'check_project',
    {
      title: 'Проверка перед сборкой',
      description: 'Ошибки и предупреждения: сцены, сумма длительностей, реплики, отсутствующие файлы.',
      inputSchema: { projectId: z.string() },
    },
    safe(async ({ projectId }) => {
      const p = await loadProject(projectId);
      const issues = validateProject(p);
      for (const name of await missingAssets(projectId, p)) issues.unshift({ level: 'error', message: `Файл не найден: ${name}` });
      return { ok: !issues.some((i) => i.level === 'error'), issues };
    }),
  );

  tool(
    server,
    'start_render',
    {
      title: 'Собрать видео',
      description:
        'Ставит сборку MP4 в очередь. testStartSec/testDurationSec — тестовый фрагмент вместо всего ролика: начало — место на ленте, длина — в собранном видео (вырезы пропускаются). ' +
        'Дальше — render_status; когда status = done, файл скачивается по ссылке downloadUrl.',
      inputSchema: {
        projectId: z.string(),
        testStartSec: z.number().nonnegative().optional(),
        testDurationSec: z.number().positive().optional(),
      },
    },
    safe(async ({ projectId, testStartSec, testDurationSec }) => {
      const p = await loadProject(projectId);
      const missing = await missingAssets(projectId, p);
      if (missing.length) throw new HttpError(400, `Не найдены файлы: ${missing.join(', ')}`);
      const errors = validateProject(p).filter((i) => i.level === 'error');
      if (errors.length) throw new HttpError(400, errors.map((e) => e.message).join('; '));
      const range = testDurationSec ? { startMs: ms(testStartSec ?? 0), durationMs: ms(testDurationSec) } : null;
      return withDownload(await enqueueRender(projectId, p, range), base);
    }),
  );

  tool(
    server,
    'render_status',
    {
      title: 'Статус сборки',
      description: 'Статус задания сборки: прогресс 0..1, оставшееся время, ошибка, ссылка на готовый файл.',
      inputSchema: { jobId: z.string() },
    },
    safe(async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job) throw new HttpError(404, 'Задание не найдено (сервер мог перезапуститься — смотрите list_results)');
      return withDownload(job, base);
    }),
  );

  tool(
    server,
    'cancel_render',
    { title: 'Отменить сборку', inputSchema: { jobId: z.string() } },
    safe(async ({ jobId }) => ({ cancelled: cancelRender(jobId) })),
  );

  tool(
    server,
    'list_results',
    {
      title: 'Готовые видео',
      description: 'Готовые MP4 проекта с размерами и ссылками для скачивания, плюс текущие задания сборки.',
      inputSchema: { projectId: z.string() },
    },
    safe(async ({ projectId }) => ({
      files: (await listResults(projectId)).map((f) => ({ ...f, downloadUrl: resultUrl(base, projectId, f.name) })),
      jobs: listJobs(projectId).map((j) => withDownload(j, base)),
      download: links(base, projectId).download,
    })),
  );

  return server;
}

const resultUrl = (base: string, projectId: string, name: string) =>
  `${base}/api/projects/${projectId}/results/${encodeURIComponent(name)}`;

function withDownload<T extends { projectId: string; status: string; fileName: string | null }>(job: T, base: string) {
  return { ...job, downloadUrl: job.status === 'done' && job.fileName ? resultUrl(base, job.projectId, job.fileName) : null };
}

export function baseUrl(req: Request): string {
  return config.publicUrl ?? `${req.protocol}://${req.get('host')}`;
}

/** Обработчик POST /mcp: новый сервер и транспорт на каждый запрос (режим без сессий). */
export async function handleMcp(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  const server = createMcpServer(baseUrl(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
