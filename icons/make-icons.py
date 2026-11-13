"""Draws the PNG icons from the same geometry as icons/icon.svg (Chrome can't use SVG icons).

The 128px icon gets 16px of transparent padding (96px artwork), as the Chrome Web Store asks.
Run: python3 icons/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
ORANGE, DARK = (0xFF, 0x64, 0x0A, 255), (0x14, 0x15, 0x19, 255)


def art(px):
    """The 96x96 artwork rendered at `px` pixels (drawn 8x larger, then downsampled)."""
    s8 = px * 8 / 96
    s = lambda v: v * s8
    big = Image.new("RGBA", (px * 8, px * 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    w = s(7)
    d.rounded_rectangle([0, 0, px * 8 - 1, px * 8 - 1], radius=s(22), fill=ORANGE)
    d.rounded_rectangle([s(37), s(15), s(59), s(53)], radius=s(11), fill=DARK)  # capsule
    d.arc([s(28) - w / 2, s(25) - w / 2, s(68) + w / 2, s(65) + w / 2], 0, 180, fill=DARK, width=round(w))  # holder
    for x, y in ((28, 45), (68, 45)):  # round ends of the holder
        d.ellipse([s(x) - w / 2, s(y) - w / 2, s(x) + w / 2, s(y) + w / 2], fill=DARK)
    d.rounded_rectangle([s(48) - w / 2, s(65) - w / 2, s(48) + w / 2, s(77) + w / 2], radius=w / 2, fill=DARK)  # stand
    d.rounded_rectangle([s(35) - w / 2, s(77) - w / 2, s(61) + w / 2, s(77) + w / 2], radius=w / 2, fill=DARK)  # base
    return big.resize((px, px), Image.LANCZOS)


for size in (16, 32, 48):
    art(size).save(HERE / f"icon-{size}.png", optimize=True)

store = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
store.paste(art(96), (16, 16))
store.save(HERE / "icon-128.png", optimize=True)
print("icons/icon-16.png icon-32.png icon-48.png icon-128.png")
