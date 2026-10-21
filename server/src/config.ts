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
  /** Папка со шрифтами для libass; по умолчанию — fonts/ в папке проекта, если она есть. */
  fontsDir: process.env.FONTS_DIR ?? null,
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
};

export const projectsDir = () => path.join(config.dataDir, 'projects');
export const logsDir = () => path.join(config.dataDir, 'logs');
