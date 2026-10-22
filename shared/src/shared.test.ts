import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assColor,
  buildAss,
  createProject,
  createScene,
  cueIssues,
  DEFAULT_OUTPUT,
  DEFAULT_STYLE,
  formatAssTime,
  formatSrtTime,
  frameAt,
  layoutSegments,
  newId,
  normalizeProject,
  parseAss,
  parseSrt,
  parseTime,
  parseTxt,
  serializeSrt,
  segmentsFrames,
  sliceProject,
  sliceSegments,
  splitEvenly,
  totalScenesMs,
  validateProject,
  withIds,
  type Project,
} from './index';

test('parseTime понимает разные форматы', () => {
  assert.equal(parseTime('01:02:03,456'), 3_723_456);
  assert.equal(parseTime('1:02:03.45'), 3_723_450);
  assert.equal(parseTime('02:03'), 123_000);
  assert.equal(parseTime('7'), 7000);
  assert.equal(parseTime('abc'), null);
});

test('форматирование времени SRT/ASS', () => {
  assert.equal(formatSrtTime(3_723_456), '01:02:03,456');
  assert.equal(formatAssTime(3_723_456), '1:02:03.46');
});

test('SRT: разбор и обратная сериализация, кириллица и теги', () => {
  const src = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Привет</i>,\r\nмир\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nЗима\r\n';
  const cues = parseSrt(src);
  assert.deepEqual(cues, [
    { startMs: 1000, endMs: 2500, text: 'Привет,\nмир' },
    { startMs: 3000, endMs: 4000, text: 'Зима' },
  ]);
  assert.deepEqual(parseSrt(serializeSrt(cues)), cues);
});

test('ASS: импорт Dialogue с запятыми и тегами', () => {
  const src = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\b1}Весна, лето\\Nосень\n';
  assert.deepEqual(parseAss(src), [{ startMs: 1000, endMs: 2500, text: 'Весна, лето\nосень' }]);
});

test('TXT: тайминги по числу символов покрывают всю длительность', () => {
  const cues = parseTxt('аа\n\nбббббб\n', 8000);
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 2000, text: 'аа' },
    { startMs: 2000, endMs: 8000, text: 'бббббб' },
  ]);
});

test('buildAss: стиль, цвета, экранирование', () => {
  assert.equal(assColor('#112233', 0.5), '&H80332211');
  const ass = buildAss(withIds([{ startMs: 0, endMs: 1000, text: 'a{b}\nc' }]), DEFAULT_STYLE, DEFAULT_OUTPUT);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Style: Default,PT Sans,54,&H00FFFFFF/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.00,Default,,0,0,0,,a\(b\)\\Nc/);
});

test('splitEvenly: сумма равна длительности, границы на кадрах', () => {
  const scenes = [1, 2, 3].map((i) => createScene(`${i}.jpg`, 0));
  const out = { ...DEFAULT_OUTPUT, durationMs: 5_400_010 };
  const res = splitEvenly(scenes, out);
  assert.equal(totalScenesMs(res), out.durationMs);
  assert.equal(res[0].durationMs % 40, 0);
});

test('sliceProject: обрезка сцен и сдвиг реплик', () => {
  const p = createProject('t');
  p.output.durationMs = 10_000;
  p.scenes = [createScene('a', 4000), createScene('b', 6000)];
  p.subtitles = withIds([
    { startMs: 1000, endMs: 3000, text: 'x' },
    { startMs: 3500, endMs: 5000, text: 'y' },
  ]);
  const s = sliceProject(p, { startMs: 3000, durationMs: 4000 });
  assert.deepEqual(s.scenes.map((x) => x.durationMs), [1000, 3000]);
  assert.deepEqual(s.subtitles.map((c) => [c.startMs, c.endMs]), [[500, 2000]]);
  assert.equal(s.output.durationMs, 4000);
});

/** Три сцены по 4 с при 25 кадрах/с (по 100 кадров). */
function threeScenes(): Project {
  const p = createProject('t');
  p.output.durationMs = 12_000;
  p.scenes = ['a', 'b', 'c'].map((n) => createScene(n, 4000));
  return p;
}

const describe = (p: Project) =>
  layoutSegments(p).segments.map((s) =>
    s.kind === 'still' ? `${s.scene.image}:${s.frames}` : `${s.from?.image ?? '#'}>${s.to?.image ?? '#'}:${s.frames}`,
  );

test('переходы: без настроек — только резкая смена, как раньше', () => {
  const p = threeScenes();
  assert.deepEqual(describe(p), ['a:100', 'b:100', 'c:100']);
});

test('переходы: проявление, плавный, через чёрный, затемнение — длительность не меняется', () => {
  const p = threeScenes();
  p.transitions = { ...p.transitions, fadeInMs: 1000, fadeOutMs: 2000, between: { type: 'crossfade', durationMs: 1000 } };
  p.scenes[1].transition = { type: 'dip', durationMs: 2000 };
  const { segments, shortened } = layoutSegments(p);
  assert.deepEqual(describe(p), ['#>a:25', 'a:63', 'a>b:25', 'b:62', 'b>#:25', '#>c:25', 'c:25', 'c>#:50']);
  assert.equal(segmentsFrames(segments), 300);
  assert.deepEqual(shortened, []);
  // Первый и последний кадры чёрные, на границе через чёрный — тоже.
  assert.deepEqual(frameAt(segments, 0), { from: null, to: p.scenes[0], p: 0 });
  assert.equal(frameAt(segments, 299)?.p, 1);
  assert.equal(frameAt(segments, 199)?.to, null);
  assert.equal(frameAt(segments, 199)?.p, 1);
  assert.equal(frameAt(segments, 200)?.from, null);
  assert.equal(frameAt(segments, 200)?.p, 0);
  // Плавный переход (кадры 88…112) центрирован на границе сцен (кадр 100): ни 0, ни 1 на краях, монотонно.
  const mid = [88, 100, 112].map((f) => frameAt(segments, f)!.p);
  assert.ok(mid[0] > 0 && mid[0] < mid[1] && mid[1] < mid[2] && mid[2] < 1);
  assert.ok(Math.abs(mid[1] - 0.5) < 0.02);
});

test('переходы: слишком короткая сцена — переходы укорачиваются, сумма кадров та же', () => {
  const p = threeScenes();
  p.scenes[1].durationMs = 400; // 10 кадров
  p.output.durationMs = 8400;
  p.transitions.between = { type: 'crossfade', durationMs: 2000 };
  const { segments, shortened } = layoutSegments(p);
  assert.deepEqual(shortened, [2]);
  assert.equal(segmentsFrames(segments), 210);
  assert.match(validateProject(p).map((i) => i.message).join('\n'), /короче своих переходов \(2\)/);
});

test('переходы: тестовый фрагмент с середины перехода продолжает его с нужной доли', () => {
  const p = threeScenes();
  p.transitions.between = { type: 'crossfade', durationMs: 1000 };
  const all = layoutSegments(p).segments;
  const part = sliceSegments(all, 95, 150);
  assert.equal(segmentsFrames(part), 55);
  for (const f of [0, 10, 30]) {
    const a = frameAt(part, f)!;
    const b = frameAt(all, 95 + f)!;
    assert.equal(a.from, b.from);
    assert.equal(a.to, b.to);
    assert.ok(Math.abs(a.p - b.p) < 1e-9);
  }
});

test('переходы: старый проект без настроек открывается с резкой сменой', () => {
  const p = normalizeProject({ meta: { name: 'old' }, scenes: [createScene('a', 1000)] } as Partial<Project>);
  assert.equal(p.transitions.between.type, 'cut');
  assert.equal(p.transitions.fadeInMs, 0);
});

test('cueIssues: пересечения, короткие, за пределами', () => {
  const cues = withIds([
    { startMs: 0, endMs: 2000, text: 'a' },
    { startMs: 1500, endMs: 1900, text: 'b' },
    { startMs: 9000, endMs: 12000, text: 'c' },
  ]);
  const issues = cueIssues(cues, 10_000);
  assert.deepEqual(issues.get(cues[0].id), ['overlap']);
  assert.deepEqual(issues.get(cues[1].id), ['short']);
  assert.deepEqual(issues.get(cues[2].id), ['out-of-range']);
});

test('newId работает и без crypto.randomUUID (сайт по http, не localhost)', () => {
  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    assert.equal(ids.size, 1000);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
  }
});
