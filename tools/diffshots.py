"""Compare two screenshots from tools/shoot.mjs pixel by pixel.

    python tools/diffshots.py output/shots/a.png output/shots/b.png

Prints "identical" or how many pixels differ and by how much at most. Exits 1
if they differ. Uses Pillow (already a pipeline dependency).
"""
import sys

from PIL import Image, ImageChops


def main(a, b):
    ia, ib = Image.open(a).convert("RGBA"), Image.open(b).convert("RGBA")
    if ia.size != ib.size:
        print(f"different sizes: {ia.size} vs {ib.size}")
        return 1
    d = ImageChops.difference(ia, ib)
    if not d.getbbox():
        print("identical")
        return 0
    px = [p for p in d.getdata() if any(p)]
    print(f"{len(px)} pixels differ (of {ia.size[0] * ia.size[1]}), max channel difference {max(max(p) for p in px)}")
    return 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
