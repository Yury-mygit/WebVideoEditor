import { cueAt, horizontalMargin, sceneAt, type Project, type Scene, type SubtitleStyle } from '@wve/shared';

/**
 * Отрисовка кадра превью. Повторяет то, что делает libass при рендере:
 * PlayRes = разрешение кадра, жадный перенос по словам (WrapStyle=1),
 * высота строки = Fontsize, размер шрифта как в VSFilter (по высоте ascent+descent).
 */

function drawImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, scene: Scene, w: number, h: number) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  if (scene.fit === 'stretch') {
    ctx.drawImage(img, 0, 0, w, h);
    return;
  }
  if (scene.fit === 'contain') {
    ctx.fillStyle = scene.padColor;
    ctx.fillRect(0, 0, w, h);
    const k = Math.min(w / iw, h / ih);
    const dw = iw * k;
    const dh = ih * k;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return;
  }
  const k = Math.max(w / iw, h / ih);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
}

const metricsCache = new Map<string, { k: number; ascent: number }>();

function fontCss(style: SubtitleStyle, px: number): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${px}px "${style.fontFamily}", Arial, sans-serif`;
}

/** Переводит Fontsize из ASS в CSS-пиксели для canvas: у разных шрифтов разное соотношение. */
function fontMetrics(ctx: CanvasRenderingContext2D, style: SubtitleStyle) {
  const key = `${style.fontFamily}|${style.bold}|${style.italic}`;
  let m = metricsCache.get(key);
  if (!m) {
    ctx.font = fontCss(style, 100);
    const tm = ctx.measureText('Йg');
    const asc = tm.fontBoundingBoxAscent || 92;
    const desc = tm.fontBoundingBoxDescent || 22;
    m = { k: 100 / (asc + desc), ascent: asc / (asc + desc) };
    if (document.fonts.check(ctx.font)) metricsCache.set(key, m);
  }
  return m;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

interface Block {
  lines: string[];
  widths: number[];
}

export function drawSubtitles(ctx: CanvasRenderingContext2D, texts: string[], style: SubtitleStyle, w: number, h: number) {
  if (!texts.length) return;
  const { k, ascent } = fontMetrics(ctx, style);
  const px = style.fontSize * k;
  const lineH = style.fontSize;
  ctx.font = fontCss(style, px);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const margin = horizontalMargin(style, w);
  const maxWidth = w - margin * 2;

  const blocks: Block[] = texts.map((t) => {
    const lines = wrapLines(ctx, t, maxWidth);
    return { lines, widths: lines.map((l) => ctx.measureText(l).width) };
  });
  // Несколько одновременных реплик складываются стопкой, как в libass.
  const allLines = style.position === 'top' ? blocks.flatMap((b) => b.lines.map((l, i) => [l, b.widths[i]] as const))
    : blocks.reverse().flatMap((b) => b.lines.map((l, i) => [l, b.widths[i]] as const));
  const totalH = allLines.length * lineH;
  let top =
    style.position === 'bottom' ? h - style.marginV - totalH : style.position === 'top' ? style.marginV : (h - totalH) / 2;

  for (const [line, lw] of allLines) {
    const x = style.align === 'left' ? margin : style.align === 'right' ? w - margin - lw : (w - lw) / 2;
    const baseline = top + lineH * ascent;
    if (style.boxEnabled) {
      const pad = style.boxPadding;
      ctx.fillStyle = hexToRgba(style.boxColor, style.boxOpacity);
      ctx.fillRect(x - pad, top - pad, lw + pad * 2, lineH + pad * 2);
    } else {
      if (style.shadow > 0) {
        ctx.fillStyle = ctx.strokeStyle = hexToRgba(style.shadowColor, 0.6);
        ctx.lineWidth = style.outlineWidth * 2;
        if (style.outlineWidth > 0) ctx.strokeText(line, x + style.shadow, baseline + style.shadow);
        ctx.fillText(line, x + style.shadow, baseline + style.shadow);
      }
      if (style.outlineWidth > 0) {
        ctx.strokeStyle = style.outlineColor;
        ctx.lineWidth = style.outlineWidth * 2;
        ctx.strokeText(line, x, baseline);
      }
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, baseline);
    top += lineH;
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  timeMs: number,
  images: Map<string, HTMLImageElement>,
) {
  const { width: w, height: h } = project.output;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const scene = sceneAt(project.scenes, timeMs);
  const img = scene && images.get(scene.scene.image);
  if (scene && img?.complete) drawImage(ctx, img, scene.scene, w, h);
  const texts = cueAt(project.subtitles, timeMs).map((c) => c.text);
  drawSubtitles(ctx, texts, project.style, w, h);
}
