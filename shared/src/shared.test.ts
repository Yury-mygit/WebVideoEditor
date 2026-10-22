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
  newId,
  parseAss,
  parseSrt,
  parseTime,
  parseTxt,
  serializeSrt,
  sliceProject,
  splitEvenly,
  totalScenesMs,
  withIds,
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
