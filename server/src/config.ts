import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../..');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT_DIR, 'data')),
  /** Свой FFmpeg (например, системный на Linux-сервере) или портативный из npm-пакета. */
  ffmpegPath: process.env.FFMPEG_PATH ?? ffmpegInstaller.path,
  /** Папка со шрифтами для libass; по умолчанию — fonts/ репозитория (PT Sans), чтобы не зависеть от шрифтов ОС. */
  fontsDir: path.resolve(process.env.FONTS_DIR ?? path.join(ROOT_DIR, 'fonts')),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  /** Общий пароль: вход в веб-интерфейс и `Authorization: Bearer <пароль>` для API и MCP. Не задан — без авторизации. */
  password: process.env.SLIDESUB_PASSWORD || null,
  /** Внешний адрес сервера для ссылок в ответах MCP (например, http://server:9100). По умолчанию — из запроса. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || null,
};

export const projectsDir = () => path.join(config.dataDir, 'projects');
export const logsDir = () => path.join(config.dataDir, 'logs');
