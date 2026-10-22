// Проверка сервера SlideSub через MCP «от и до»: проект → загрузка материалов → сцены и субтитры →
// сборка → скачивание результата. Подходит и для локального, и для удалённого сервера.
//
//   SLIDESUB_URL=http://server:9100 SLIDESUB_PASSWORD=... node tools/mcp-smoke.mjs [папка для результата]
//
// Демо-материалы берутся из web/public/guide/demo. Проект на сервере остаётся (имя «MCP smoke …»).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'web', 'public', 'guide', 'demo');
const BASE = (process.env.SLIDESUB_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const PASSWORD = process.env.SLIDESUB_PASSWORD ?? '';
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'data', 'smoke'));
const authHeaders = PASSWORD ? { Authorization: `Bearer ${PASSWORD}` } : {};

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(cond, msg) {
  if (!cond) throw new Error(`Проверка не прошла: ${msg}`);
}

const client = new Client({ name: 'slidesub-smoke', version: '1.0.0' });

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

async function upload(projectId, file) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path.join(DEMO, file))]), file);
  const res = await fetch(`${BASE}/api/projects/${projectId}/assets`, { method: 'POST', headers: authHeaders, body: fd });
  const data = await res.json();
  check(res.status === 201, `загрузка ${file}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data.name;
}

async function download(url, file) {
  const res = await fetch(url, { headers: authHeaders });
  check(res.ok, `скачивание ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

async function waitRender(jobId) {
  for (;;) {
    const job = await call('render_status', { jobId });
    process.stdout.write(`\r  … ${job.status} ${Math.round(job.progress * 100)}%   `);
    if (!['queued', 'running'].includes(job.status)) {
      process.stdout.write('\n');
      check(job.status === 'done', `сборка завершилась статусом ${job.status}: ${job.error}`);
      return job;
    }
    await sleep(1000);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  step(`Авторизация на ${BASE}`);
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok(`сервер отвечает, пароль ${health.auth ? 'включён' : 'НЕ включён'}, ${health.ffmpeg}`);
  if (health.auth) {
    const noAuth = await fetch(`${BASE}/api/projects`);
    check(noAuth.status === 401, `без пароля /api должен давать 401, а дал ${noAuth.status}`);
    const noAuthMcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(noAuthMcp.status === 401, `без пароля /mcp должен давать 401, а дал ${noAuthMcp.status}`);
    ok('без пароля API и MCP закрыты (401)');
  }

  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: authHeaders } }));
  const { tools } = await client.listTools();
  ok(`MCP подключён, инструментов: ${tools.length} (${tools.map((t) => t.name).join(', ')})`);

  step('Проект');
  const created = await call('create_project', { name: `MCP smoke ${new Date().toISOString().slice(0, 16)}`, durationSec: 60 });
  const id = created.projectId;
  ok(`создан ${id}, длительность ${created.output.duration}`);

  step('Загрузка материалов на сервер');
  const images = [];
  for (const f of ['1-zima.jpg', '2-vesna.jpg', '3-leto.jpg']) images.push(await upload(id, f));
  ok(`картинки по HTTP: ${images.join(', ')}`);
  const fromUrl = await call('import_asset_from_url', { projectId: id, url: `${BASE}/guide/demo/4-osen.jpg` });
  images.push(fromUrl.name);
  ok(`картинка по ссылке (сервер скачал сам): ${fromUrl.name}, ${fromUrl.size} байт`);
  const srtName = await upload(id, 'vremena-goda.srt');
  ok(`субтитры по HTTP: ${srtName}`);
  const assets = await call('list_assets', { projectId: id });
  check(assets.files.length === 5, `в проекте должно быть 5 файлов, а их ${assets.files.length}`);
  ok('list_assets видит все 5 файлов');

  step('Сцены и субтитры');
  const withScenes = await call('add_scenes', { projectId: id, images });
  check(withScenes.scenes.length === 4, 'должно быть 4 сцены');
  ok(`сцены: ${withScenes.scenes.map((s) => `${s.index}: ${s.durationSec} с`).join(', ')}`);
  const imported = await call('import_subtitles', { projectId: id, assetName: srtName });
  ok(`импортировано реплик: ${imported.imported}`);
  const page = await call('get_subtitles', { projectId: id, limit: 3 });
  ok(`первые реплики: ${page.items.map((c) => `${c.start} «${c.text.split('\n')[0]}»`).join(' | ')}`);
  await call('edit_subtitles', { projectId: id, updates: [{ n: 1, text: 'Проверка MCP: реплика изменена' }] });
  const edited = await call('get_subtitles', { projectId: id, limit: 1 });
  check(edited.items[0].text === 'Проверка MCP: реплика изменена', 'правка реплики не сохранилась');
  ok('правка реплики через MCP сохранилась');
  await call('update_project', { projectId: id, style: { fontSize: 60, bold: true } });
  const checkRes = await call('check_project', { projectId: id });
  ok(`проверка проекта: ${checkRes.ok ? 'без ошибок' : 'есть ошибки'}; замечаний ${checkRes.issues.length}`);

  step('Сборка тестового фрагмента (5 с)');
  const test = await waitRender((await call('start_render', { projectId: id, testStartSec: 0, testDurationSec: 5 })).id);
  ok(`готово: ${test.fileName}`);

  step('Сборка всего ролика (60 с)');
  const full = await waitRender((await call('start_render', { projectId: id })).id);
  ok(`готово за ${full.elapsedSec.toFixed(1)} с: ${full.fileName}`);

  step('Скачивание результата с сервера');
  const results = await call('list_results', { projectId: id });
  ok(`list_results: ${results.files.map((f) => `${f.name} (${(f.size / 1024).toFixed(0)} КБ)`).join(', ')}`);
  const mp4 = path.join(OUT, 'smoke-full.mp4');
  const buf = await download(full.downloadUrl, mp4);
  check(buf.length > 10_000 && buf.subarray(4, 8).toString() === 'ftyp', 'скачанный файл не похож на MP4');
  ok(`MP4 скачан: ${mp4} (${(buf.length / 1024).toFixed(0)} КБ)`);
  if (PASSWORD) {
    const denied = await fetch(full.downloadUrl);
    check(denied.status === 401, `скачивание без пароля должно давать 401, а дало ${denied.status}`);
    ok('без пароля скачать нельзя (401)');
  }
  const srt = await download(`${BASE}/api/projects/${id}/subtitles/srt`, path.join(OUT, 'smoke.srt'));
  check(srt.toString('utf8').includes('Проверка MCP'), 'в выгруженном SRT нет изменённой реплики');
  ok(`SRT выгружен: ${path.join(OUT, 'smoke.srt')}`);

  console.log(`\nВсё работает. Проект: ${created.links.editor}`);
  await client.close();
}

main().catch(async (e) => {
  console.error(`\n✗ ${e.message}`);
  await client.close().catch(() => {});
  process.exit(1);
});
