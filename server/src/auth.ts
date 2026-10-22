import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';

/**
 * Простая авторизация одним общим паролем (SLIDESUB_PASSWORD).
 * - Браузер: POST /api/auth/login → HttpOnly-кука; кука уходит и с картинками, и со скачиванием.
 * - Скрипты, curl и MCP: заголовок `Authorization: Bearer <пароль>`.
 * Если пароль не задан — авторизация выключена (локальная разработка).
 */

export const COOKIE = 'slidesub_auth';
const MAX_AGE_SEC = 30 * 24 * 3600;

export const authEnabled = () => !!config.password;

const sha = (s: string) => createHash('sha256').update(s).digest();

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

/** Значение куки: подпись от пароля. Смена пароля автоматически разлогинивает всех. */
function sessionValue(): string {
  return createHmac('sha256', config.password!).update('slidesub-session-v1').digest('base64url');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isAuthorized(req: Request): boolean {
  if (!authEnabled()) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && safeEqual(bearer, config.password!)) return true;
  const cookie = readCookie(req, COOKIE);
  return !!cookie && safeEqual(cookie, sessionValue());
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthorized(req)) return next();
  res.status(401).json({ error: 'Нужна авторизация' });
}

// Примитивная защита от перебора: не больше 10 неудачных попыток в минуту с одного адреса.
const failures = new Map<string, number[]>();

export function login(req: Request, res: Response) {
  if (!authEnabled()) return void res.json({ ok: true });
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return void res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });

  const password = String(req.body?.password ?? '');
  if (!password || !safeEqual(password, config.password!)) {
    failures.set(ip, [...recent, now]);
    return void res.status(401).json({ error: 'Неверный пароль' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionValue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}`);
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

export function authStatus(req: Request, res: Response) {
  res.json({ required: authEnabled(), authorized: isAuthorized(req) });
}
