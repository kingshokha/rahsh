"""Pre-compose the aerial imagery the viewer would stream from Esri into JPEG
files plus data/imagery.json, for hosts whose sandbox blocks third-party
requests (e.g. a claude.ai artifact).  The windows mirror src/terrain.js.

Usage:  python3 bake_imagery.py <cache_dir> <out_root>
        (writes <out_root>/data/<CITY>/img/*.jpg and <out_root>/data/<CITY>/imagery.json)
"""
import json
import math
import os
import sys

from PIL import Image

from fetch_data import ESRI, curl
from geo import CITY, K, MX0, MY0, R

CACHE, OUT = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", CITY, "city.json")))["meta"]


def to_tile(x, y, z):
    mx, my = x / K + MX0, y / K + MY0
    n = 2 ** z
    return (mx / (2 * math.pi * R) + 0.5) * n, (0.5 - my / (2 * math.pi * R)) * n


def window(rect, z):
    ax, ay = to_tile(rect["x0"], rect["y1"], z)
    bx, by = to_tile(rect["x1"], rect["y0"], z)
    tx0, ty0 = math.floor(ax), math.floor(ay)
    return z, tx0, ty0, math.floor(bx) - tx0 + 1, math.floor(by) - ty0 + 1


def windows():
    c, r = meta["terrainCity"], meta["terrainRegion"]
    yield window(c, 15), 82
    yield window(r, 12), 82
    yield window(r, 13), 80
    nx, ny = c["nx"], c["ny"]
    dx, dy = (c["x1"] - c["x0"]) / (nx - 1), (c["y1"] - c["y0"]) / (ny - 1)
    ci, cj = math.ceil((nx - 1) / 4), math.ceil((ny - 1) / 4)
    for cy in range(4):
        for cx in range(4):
            i0, j0 = cx * ci, cy * cj
            n_x, n_y = min(ci, nx - 1 - i0) + 1, min(cj, ny - 1 - j0) + 1
            rect = {"x0": c["x0"] + i0 * dx, "x1": c["x0"] + (i0 + n_x - 1) * dx,
                    "y1": c["y1"] - j0 * dy, "y0": c["y1"] - (j0 + n_y - 1) * dy}
            yield window(rect, 16), 80
            yield window(rect, 17), 78


IMG = f"data/{CITY}/img"
os.makedirs(os.path.join(OUT, IMG), exist_ok=True)
manifest = {}
for (z, tx0, ty0, nx, ny), q in windows():
    im = Image.new("RGB", (nx * 256, ny * 256), (156, 141, 116))
    for x in range(nx):
        for y in range(ny):
            f = os.path.join(CACHE, f"img{z}", f"{z}_{tx0 + x}_{ty0 + y}.jpg")
            if not os.path.exists(f):
                os.makedirs(os.path.dirname(f), exist_ok=True)
                curl(ESRI.format(z=z, x=tx0 + x, y=ty0 + y), f, timeout=60)
            try:
                im.paste(Image.open(f).convert("RGB"), (x * 256, y * 256))
            except Exception:
                pass
    name = f"{IMG}/z{z}_{tx0}_{ty0}.jpg"
    im.save(os.path.join(OUT, name), quality=q, optimize=True, progressive=True)
    manifest[f"{z}/{tx0}/{ty0}/{nx}/{ny}"] = name
    print(name, im.size, os.path.getsize(os.path.join(OUT, name)) // 1024, "KB")
json.dump(manifest, open(os.path.join(OUT, "data", CITY, "imagery.json"), "w"), indent=0)
