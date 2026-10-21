// Скриншоты для страницы /instruction.
// Поднимает отдельный сервер на временной папке данных, проходит сценарий в headless Chrome
// и сохраняет картинки с пометками в web/public/guide/.
//
// Запуск: npm run guide:shots   (нужны собранный web/dist и установленный Chrome или Edge;
// путь к браузеру можно задать через CHROME_PATH)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'web', 'public', 'guide');
const DEMO = path.join(OUT, 'demo');
const PORT = 3102;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEW = { width: 1440, height: 1060 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 30_000, stepMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error('Таймаут ожидания');
}

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(() => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false));
  return child;
}

// --- Пометки на странице: рамка и номер ---
const MARK_CSS = `
.__mark-box{position:fixed;border:3px solid #e5393f;border-radius:8px;pointer-events:none;z-index:9998;box-shadow:0 0 0 3px rgba(229,57,63,.25)}
.__mark-num{position:fixed;width:30px;height:30px;border-radius:50%;background:#e5393f;color:#fff;font:700 17px/30px system-ui,sans-serif;text-align:center;z-index:9999;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.35)}
`;

/** pos — где ставить номер: tl, tr (углы сверху), l, r (слева/справа по центру). */
async function mark(page, handle, num, pad = 4, pos = 'tl') {
  await page.evaluate(
    (el, num, pad, css, pos) => {
      if (!document.getElementById('__mark-style')) {
        const s = document.createElement('style');
        s.id = '__mark-style';
        s.textContent = css;
        document.head.appendChild(s);
      }
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = '__mark-box __mark';
      Object.assign(box.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const badge = document.createElement('div');
      badge.className = '__mark-num __mark';
      badge.textContent = String(num);
      const midY = r.top + r.height / 2 - 15;
      const { left, top } = {
        tl: { left: r.left - pad - 15, top: r.top - pad - 15 },
        tr: { left: r.right + pad - 15, top: r.top - pad - 15 },
        l: { left: r.left - pad - 34, top: midY },
        r: { left: r.right + pad + 4, top: midY },
      }[pos];
      Object.assign(badge.style, { left: `${Math.max(2, left)}px`, top: `${Math.max(2, top)}px` });
      document.body.append(box, badge);
    },
    handle,
    num,
    pad,
    MARK_CSS,
    pos,
  );
}

const clearMarks = (page) => page.evaluate(() => document.querySelectorAll('.__mark').forEach((e) => e.remove()));

/** Элемент по CSS-селектору и (необязательно) тексту. */
async function $(page, selector, text) {
  const handle = await page.evaluateHandle(
    (selector, text) =>
      [...document.querySelectorAll(selector)].find((e) => !text || e.textContent.replace(/\s+/g, ' ').trim().includes(text)) ?? null,
    selector,
    text ?? null,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`Не найден элемент: ${selector} ${text ?? ''}`);
  return el;
}

async function shot(page, name, clipEl = null, pad = 18) {
  const file = path.join(OUT, `${name}.png`);
  if (!clipEl) {
    await page.screenshot({ path: file });
  } else {
    const b = await clipEl.boundingBox();
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    await page.screenshot({
      path: file,
      clip: { x, y, width: Math.min(VIEW.width - x, b.width + pad * 2), height: Math.min(VIEW.height - y, b.height + pad * 2) },
    });
  }
  console.log('  ✓', name);
}

async function typeInto(page, el, text) {
  await el.click();
  await el.evaluate((e) => e.select());
  await el.type(text);
  await page.keyboard.press('Enter');
}

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) throw new Error('Не найден Chrome/Edge, укажите CHROME_PATH');
  if (!existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('Сначала соберите фронтенд: npm run build');

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'slidesub-guide-'));
  const server = await startServer(dataDir);
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-proxy-server', `--window-size=${VIEW.width},${VIEW.height}`, '--lang=ru-RU'],
    defaultViewport: { ...VIEW, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  try {
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => console.error('  [page]', e.message));

    // 1. Создание проекта
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    const nameInput = await $(page, '.picker input');
    await nameInput.type('Времена года');
    await mark(page, nameInput, 1);
    await mark(page, await $(page, '.picker button', 'Создать'), 2);
    await shot(page, '01-project', await $(page, '.picker'), 24);
    await clearMarks(page);
    await (await $(page, '.picker button', 'Создать')).click();
    await page.waitForSelector('.scenes-panel');
    await sleep(500);

    // 2. Пустой проект: где добавлять фото
    await mark(page, await $(page, '.scenes-panel .panel-title button', 'Изображения'), 1);
    await mark(page, await $(page, '.scenes-panel .empty-hint'), 2);
    await shot(page, '02-empty');
    await clearMarks(page);

    // 3. Загрузка фото
    const addInput = await $(page, '.scenes-panel input[type=file][multiple]');
    await addInput.uploadFile(...['1-zima.jpg', '2-vesna.jpg', '3-leto.jpg', '4-osen.jpg'].map((f) => path.join(DEMO, f)));
    await waitFor(() => page.$$eval('.scene-item img', (imgs) => imgs.length === 4 && imgs.every((i) => i.complete && i.naturalWidth)));
    // Длительность ролика 4 минуты и деление поровну
    await typeInto(page, await $(page, '.scenes-panel .field .time-input'), '00:04:00');
    await sleep(300);
    await (await $(page, '.scenes-summary button', 'Поделить поровну')).click();
    await sleep(800);
    const duration = await page.$eval('.scenes-panel .field .time-input', (e) => e.value);
    if (duration !== '00:04:00') throw new Error(`Длительность ролика не установилась: ${duration}`);
    await page.evaluate(() => document.querySelector('.scenes-panel').scrollTo(0, 0));
    await shot(page, '03-photos');

    // 4. Настройка сцен (крупно)
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => document.querySelector('.scenes-panel').scrollTo(0, 0));
    await sleep(200);
    const scenesPanel = await $(page, '.scenes-panel');
    await mark(page, await $(page, '.scenes-panel .field .time-input'), 1, 4, 'r');
    const firstScene = await $(page, '.scene-item');
    await mark(page, await firstScene.$('.time-input'), 2, 4, 'r');
    await mark(page, await firstScene.$('select'), 3, 4, 'r');
    await mark(page, await firstScene.$('.drag-handle'), 4, 2, 'l');
    await mark(page, await firstScene.$('.scene-props .row:last-child'), 5, 3, 'l');
    await shot(page, '04-scenes', scenesPanel, 20);
    await clearMarks(page);
    await page.evaluate(() => document.querySelector('.scenes-panel').scrollTo(0, 10_000));
    await sleep(200);
    await mark(page, await $(page, '.scenes-summary button', 'Поделить поровну'), 1);
    await shot(page, '05-split', await $(page, '.scenes-summary'), 40);
    await clearMarks(page);
    await page.evaluate(() => document.querySelector('.scenes-panel').scrollTo(0, 0));

    // 5. Импорт субтитров
    await mark(page, await $(page, '.toolbar button', 'Импорт субтитров'), 1);
    await shot(page, '06-import-button', await $(page, '.toolbar'), 6);
    await clearMarks(page);
    const subInput = await $(page, '.toolbar input[type=file]');
    await subInput.uploadFile(path.join(DEMO, 'vremena-goda.srt'));
    await page.waitForFunction(() => document.querySelectorAll('.cue-row').length > 5);
    await page.evaluate(() => document.querySelector('.toast')?.click());
    await sleep(800);
    // Переходим на 5-ю реплику, чтобы в превью был текст
    const rows = await page.$$('.cue-row');
    await (await rows[4].$('.c-num')).click();
    await sleep(600);
    await mark(page, await $(page, '.cue-table'), 1, 2);
    await mark(page, await $(page, '.timeline'), 2, 2);
    await mark(page, await $(page, '.preview-canvas-wrap'), 3, 2);
    await shot(page, '07-imported');
    await clearMarks(page);
    await page.evaluate(() => document.querySelector('.toast')?.click());

    // 6. Правка реплик: короткая реплика для демонстрации замечания
    const row3 = (await page.$$('.cue-row'))[2];
    const row3Times = await row3.$$('.time-input');
    // Делаем реплику 3 короче секунды, чтобы показать подсветку замечания.
    const start3 = await row3Times[0].evaluate((e) => e.value);
    const [hh, mm, rest] = start3.split(':');
    const [ss, ms] = rest.split(',');
    const end3 = Number(hh) * 3_600_000 + Number(mm) * 60_000 + Number(ss) * 1000 + Number(ms) + 500;
    const pad2 = (n, l = 2) => String(n).padStart(l, '0');
    await typeInto(
      page,
      row3Times[1],
      `${pad2(Math.floor(end3 / 3_600_000))}:${pad2(Math.floor(end3 / 60_000) % 60)}:${pad2(Math.floor(end3 / 1000) % 60)},${pad2(end3 % 1000, 3)}`,
    );
    await sleep(300);
    const row2Text = await (await page.$$('.cue-row'))[1].$('.c-text');
    await row2Text.click();
    await page.keyboard.press('End');
    await sleep(200);
    const cueTable = await $(page, '.cue-table');
    const r2 = (await page.$$('.cue-row'))[1];
    await mark(page, await r2.$('.c-text'), 1, 2);
    await mark(page, (await r2.$$('.time-input'))[0], 2, 2, 'l');
    await mark(page, await $(page, '.cue-toolbar button', '+ Реплика'), 3);
    await mark(page, await $(page, '.cue-toolbar button', 'Удалить'), 4, 4, 'tr');
    await mark(page, await $(page, '.cue-toolbar input.num'), 5);
    await mark(page, await (await page.$$('.cue-row'))[2].$('.c-issue'), 6, 2);
    await shot(page, '08-table', cueTable, 12);
    await clearMarks(page);
    await page.evaluate(() => document.activeElement?.blur());

    // 7. Превью и таймлайн
    await (await (await page.$$('.cue-row'))[3].$('.c-num')).click();
    await sleep(500);
    await mark(page, await $(page, '.preview-controls button', 'Пуск'), 1);
    await mark(page, await $(page, '.preview-controls button', '◀︎|'), 2, 4, 'tr');
    await mark(page, await $(page, '.preview-controls input[type=range]'), 3);
    await shot(page, '09-preview', await $(page, '.preview'), 10);
    await clearMarks(page);
    await mark(page, await $(page, '.timeline-zoom button', '30 с'), 1, 4, 'r');
    await mark(page, await $(page, '.timeline canvas'), 2, 2, 'l');
    await shot(page, '09b-timeline', await $(page, '.timeline'), 18);
    await clearMarks(page);

    // 8. Стиль
    const sizeInput = await $(page, '.style-panel input.num');
    await typeInto(page, sizeInput, '60');
    await (await $(page, '.style-panel label.check', 'Жирный')).click();
    await sleep(400);
    await mark(page, await $(page, '.style-panel input[list]'), 1);
    await mark(page, sizeInput, 2);
    await mark(page, await $(page, '.style-panel .field.inline input[type=color]'), 3);
    await mark(page, await $(page, '.style-panel legend .check'), 4);
    await shot(page, '10-style', await $(page, '.style-panel'), 20);
    await clearMarks(page);
    await shot(page, '11-style-preview', await $(page, '.preview-canvas-wrap'), 0);

    // 9. Сборка видео
    await mark(page, await $(page, '.toolbar button', 'Собрать видео'), 1);
    await shot(page, '12-render-button', await $(page, '.toolbar'), 6);
    await clearMarks(page);
    await (await $(page, '.toolbar button', 'Собрать видео')).click();
    await page.waitForSelector('.render-dialog .issues .ok, .render-dialog .issues .warning, .render-dialog .issues .error');
    await sleep(400);
    const dialog = await $(page, '.render-dialog');
    await mark(page, await $(page, '.render-dialog select'), 1);
    await mark(page, await $(page, '.render-dialog .issues'), 2, 2);
    await mark(page, await $(page, '.render-dialog button.primary', 'Собрать видео'), 3);
    await mark(page, await $(page, '.render-dialog button', 'Тестовый фрагмент'), 4);
    await shot(page, '13-render-dialog', dialog, 20);
    await clearMarks(page);

    await (await $(page, '.render-dialog button.primary', 'Собрать видео')).click();
    await page.waitForFunction(() => {
      const t = document.querySelector('.job .muted')?.textContent ?? '';
      return parseInt(t, 10) >= 25;
    }, { timeout: 120_000 });
    await mark(page, await $(page, '.render-dialog .progress'), 1, 3);
    await mark(page, await $(page, '.render-dialog .job button', 'Отмена'), 2);
    await shot(page, '14-render-progress', await $(page, '.render-dialog'), 20);
    await clearMarks(page);

    await page.waitForSelector('.render-dialog .job.done a', { timeout: 600_000 });
    await sleep(300);
    await mark(page, await $(page, '.render-dialog .job.done a'), 1);
    await shot(page, '15-render-done', await $(page, '.render-dialog'), 20);
    await clearMarks(page);

    // Кадр из готового ролика
    const href = await page.$eval('.render-dialog .job.done a', (a) => a.href);
    const mp4 = path.join(dataDir, 'result.mp4');
    writeFileSync(mp4, Buffer.from(await (await fetch(href)).arrayBuffer()));
    const res = spawnSync(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '38.5', '-i', mp4, '-frames:v', '1', '-vf', 'scale=1280:-1', '-q:v', '3', path.join(OUT, '16-result.jpg')]);
    if (res.status !== 0) throw new Error(String(res.stderr));
    console.log('  ✓ 16-result');
  } catch (e) {
    await page.screenshot({ path: path.join(dataDir, '..', 'slidesub-guide-error.png') }).catch(() => {});
    console.error('  Снимок страницы при ошибке:', path.join(os.tmpdir(), 'slidesub-guide-error.png'));
    throw e;
  } finally {
    await browser.close();
    server.kill();
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
