"""Генерирует иконки PWA: зелёный фон #2F5D50 и светлое «окошко» (кольцо с точкой-слотом)."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
BG = (47, 93, 80, 255)      # #2F5D50
FG = (246, 244, 240, 255)   # #F6F4F0
os.makedirs(OUT, exist_ok=True)


def draw(size, rounded):
    k = 4  # суперсэмплинг для гладких краёв
    s = size * k
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, s, s], fill=BG)  # maskable / apple: фон на весь холст
    c = s / 2
    r_out, r_in = s * 0.26, s * 0.17  # внутри безопасной зоны maskable (60%)
    d.ellipse([c - r_out, c - r_out, c + r_out, c + r_out], fill=FG)
    d.ellipse([c - r_in, c - r_in, c + r_in, c + r_in], fill=BG)
    dot = s * 0.045
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


draw(192, True).save(os.path.join(OUT, "icon-192.png"))
draw(512, True).save(os.path.join(OUT, "icon-512.png"))
draw(512, False).save(os.path.join(OUT, "icon-maskable-512.png"))
draw(180, False).save(os.path.join(OUT, "apple-touch-icon.png"))  # iOS сам скругляет
print("icons ok")
