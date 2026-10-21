"""Демо-материалы для инструкции: 4 картинки «времена года» и пример SRT.

Запуск: python tools/guide/make_demo.py  (нужен Pillow)
Результат: web/public/guide/demo/
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080
OUT = Path(__file__).resolve().parents[2] / 'web' / 'public' / 'guide' / 'demo'


def gradient(draw: ImageDraw.ImageDraw, top, bottom, y0=0, y1=H):
    for y in range(y0, y1):
        t = (y - y0) / max(1, y1 - y0 - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (W, y)], fill=color)


def hills(draw, base_y, color, seed, amp=60):
    rnd = random.Random(seed)
    phase = rnd.random() * 6
    pts = [(0, H)]
    for x in range(0, W + 20, 20):
        y = base_y + amp * math.sin(x / 260 + phase) + amp * 0.4 * math.sin(x / 90 + phase * 2)
        pts.append((x, y))
    pts.append((W, H))
    draw.polygon(pts, fill=color)


def tree(draw, x, y, size, crown, trunk=(92, 64, 40), snow=False, round_crown=False):
    draw.rectangle([x - size * 0.08, y - size * 0.35, x + size * 0.08, y], fill=trunk)
    if round_crown:
        r = size * 0.42
        draw.ellipse([x - r, y - size * 0.35 - r * 1.7, x + r, y - size * 0.35 + r * 0.3], fill=crown)
        return
    for i in range(3):
        w = size * (0.55 - i * 0.12)
        top = y - size * (0.55 + i * 0.32)
        bottom = y - size * (0.2 + i * 0.3)
        draw.polygon([(x - w, bottom), (x + w, bottom), (x, top)], fill=crown)
        if snow:
            draw.polygon([(x - w * 0.35, top + (bottom - top) * 0.35), (x + w * 0.35, top + (bottom - top) * 0.35), (x, top)], fill=(250, 252, 255))


def sun(img, cx, cy, r, color, glow):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r * 2.2, cy - r * 2.2, cx + r * 2.2, cy + r * 2.2], fill=glow)
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.8))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    img.alpha_composite(layer)


def winter():
    img = Image.new('RGBA', (W, H))
    d = ImageDraw.Draw(img)
    gradient(d, (126, 160, 205), (222, 233, 245))
    sun(img, 1450, 260, 70, (255, 250, 235, 255), (255, 245, 220, 120))
    d = ImageDraw.Draw(img)
    hills(d, 720, (214, 226, 240), 1, 50)
    hills(d, 820, (240, 245, 252), 2, 40)
    rnd = random.Random(10)
    for _ in range(14):
        x = rnd.randint(40, W - 40)
        tree(d, x, rnd.randint(860, 1000), rnd.randint(180, 300), (46, 84, 72), snow=True)
    for _ in range(500):
        x, y, r = rnd.randint(0, W), rnd.randint(0, H), rnd.choice([2, 3, 4])
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 230))
    return img


def spring():
    img = Image.new('RGBA', (W, H))
    d = ImageDraw.Draw(img)
    gradient(d, (120, 186, 236), (214, 238, 250))
    sun(img, 420, 230, 80, (255, 236, 150, 255), (255, 240, 170, 140))
    d = ImageDraw.Draw(img)
    hills(d, 700, (150, 200, 110), 3, 50)
    hills(d, 820, (110, 176, 80), 4, 40)
    rnd = random.Random(20)
    for _ in range(9):
        x = rnd.randint(60, W - 60)
        tree(d, x, rnd.randint(840, 960), rnd.randint(200, 300), (255, 200, 215), round_crown=True)
    for _ in range(700):
        x, y = rnd.randint(0, W), rnd.randint(860, H)
        c = rnd.choice([(255, 255, 255), (255, 220, 60), (240, 120, 160), (180, 140, 240)])
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=c)
    return img


def summer():
    img = Image.new('RGBA', (W, H))
    d = ImageDraw.Draw(img)
    gradient(d, (40, 120, 220), (150, 210, 250), 0, 640)
    gradient(d, (30, 110, 170), (60, 160, 200), 640, H)
    sun(img, 1500, 200, 95, (255, 220, 80, 255), (255, 210, 90, 150))
    d = ImageDraw.Draw(img)
    rnd = random.Random(30)
    for _ in range(5):
        cx, cy = rnd.randint(100, W - 300), rnd.randint(80, 380)
        for k in range(5):
            r = rnd.randint(50, 90)
            d.ellipse([cx + k * 60 - r, cy - r * 0.6, cx + k * 60 + r, cy + r * 0.6], fill=(255, 255, 255, 235))
    hills(d, 780, (236, 210, 150), 5, 25)
    hills(d, 880, (90, 170, 70), 6, 35)
    for _ in range(8):
        x = rnd.randint(60, W - 60)
        tree(d, x, rnd.randint(930, 1040), rnd.randint(220, 320), (40, 130, 50), round_crown=True)
    return img


def autumn():
    img = Image.new('RGBA', (W, H))
    d = ImageDraw.Draw(img)
    gradient(d, (240, 170, 100), (250, 220, 170))
    sun(img, 960, 420, 110, (255, 190, 100, 255), (255, 170, 80, 140))
    d = ImageDraw.Draw(img)
    hills(d, 700, (180, 110, 60), 7, 50)
    hills(d, 820, (150, 90, 45), 8, 40)
    rnd = random.Random(40)
    for _ in range(11):
        x = rnd.randint(60, W - 60)
        crown = rnd.choice([(220, 110, 30), (200, 60, 30), (235, 180, 40)])
        tree(d, x, rnd.randint(840, 1000), rnd.randint(200, 300), crown, round_crown=True)
    for _ in range(300):
        x, y = rnd.randint(0, W), rnd.randint(0, H)
        c = rnd.choice([(230, 120, 30), (200, 70, 30), (240, 190, 60)])
        d.ellipse([x - 7, y - 4, x + 7, y + 4], fill=c)
    return img


LINES = [
    'Год начинается с тишины зимнего утра.',
    'Снег укрывает поля и дороги\nмягким белым одеялом.',
    'Деревья стоят неподвижно\nи ждут первого тепла.',
    'Короткий день сменяется\nдлинным звёздным вечером.',
    'В морозном воздухе слышен\nкаждый шаг по снегу.',
    'Но вот солнце поднимается выше,\nи начинает звенеть капель.',
    'Весной всё оживает:\nпочки, птицы, ручьи.',
    'Сады покрываются белыми\nи розовыми цветами.',
    'Поля зеленеют, а воздух\nпахнет тёплой землёй.',
    'Дни становятся длиннее,\nвечера — светлее.',
    'Приходит лето — время\nсолнца и долгих прогулок.',
    'Небо высокое, облака\nплывут медленно и лениво.',
    'Тёплое море зовёт искупаться.',
    'Трава высокая, деревья\nстоят в густой листве.',
    'Летние вечера пахнут\nскошенным сеном.',
    'Постепенно ночи становятся\nпрохладнее.',
    'Осень раскрашивает листья\nв жёлтый, оранжевый и красный.',
    'Ветер срывает листья\nи кружит их над землёй.',
    'Небо становится ниже,\nидут неторопливые дожди.',
    'Природа готовится к отдыху,\nи круг замыкается.',
]


def srt(duration_ms=240_000, every_ms=12_000, show_ms=8000):
    def t(ms):
        h, ms = divmod(ms, 3_600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f'{h:02}:{m:02}:{s:02},{ms:03}'

    blocks = []
    count = duration_ms // every_ms
    for i in range(count):
        start = i * every_ms + 500
        text = LINES[i * len(LINES) // count]
        blocks.append(f'{i + 1}\n{t(start)} --> {t(start + show_ms)}\n{text}\n')
    return '\n'.join(blocks)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in [('1-zima', winter), ('2-vesna', spring), ('3-leto', summer), ('4-osen', autumn)]:
        fn().convert('RGB').save(OUT / f'{name}.jpg', quality=88)
    (OUT / 'vremena-goda.srt').write_text(srt(), encoding='utf-8')
    print('ok', OUT)


if __name__ == '__main__':
    main()
