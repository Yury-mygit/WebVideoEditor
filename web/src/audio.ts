import { useEffect, useRef, useState } from 'react';

export const AUDIO_ACCEPT = '.m4a,.mp3,.wav,.aac,.ogg';
export const isAudioFile = (name: string) => /\.(m4a|mp3|wav|aac|ogg)$/i.test(name);

/** Имя файла без префикса, который сервер добавляет при загрузке («1a2b3c4d-»). */
export const assetLabel = (name: string) => name.replace(/^[0-9a-f]{8}-/i, '');

/** Насколько звук может разойтись с курсором превью, прежде чем его перемотать. */
const MAX_DRIFT_MS = 400;

/**
 * Звуковая дорожка в превью: играет вместе с курсором, перематывается при переходах по таймлайну.
 * Возвращает длительность файла (после загрузки метаданных).
 */
export function useAudioPreview(src: string | null, timeMs: number, playing: boolean): number | null {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  useEffect(() => {
    setDurationMs(null);
    if (!src) return;
    const audio = new Audio(src);
    audio.preload = 'metadata';
    const onMeta = () => setDurationMs(Math.round(audio.duration * 1000));
    audio.addEventListener('loadedmetadata', onMeta);
    ref.current = audio;
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      ref.current = null;
    };
  }, [src]);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const target = timeMs / 1000;
    if (!playing || (Number.isFinite(audio.duration) && target >= audio.duration)) {
      audio.pause();
      return;
    }
    if (Math.abs(audio.currentTime - target) * 1000 > MAX_DRIFT_MS) audio.currentTime = target;
    if (audio.paused) audio.play().catch(() => {});
  }, [src, timeMs, playing]);

  return durationMs;
}
