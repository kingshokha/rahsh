"""Turn the raw downloads (see fetch_data.py / fetch_buildings.py) into the
compact assets the viewer loads from ../data/.

Outputs
  terrain_city.png    terrarium-encoded elevation, 10 m grid over CITY_BBOX
  terrain_region.png  terrarium-encoded elevation, 60 m grid over REGION_BBOX
  city.json           buildings, streets, water, points of interest, metadata
  trees.bin           tree instances detected from the aerial imagery

Usage:  python3 build_data.py <cache_dir> <out_dir>
"""
import hashlib
import json
import math
import os
import sys

import cv2
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import LineString, Polygon

from shapely.ops import polygonize, unary_union

from geo import _CFG, CITY, CITY_BBOX, K, MX0, MY0, ORIGIN, R, REGION_BBOX, local, tile_range

CACHE = sys.argv[1] if len(sys.argv) > 1 else "cache"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "data", CITY)
PROFILE = _CFG.get("profile", "town")
CLIMATE = _CFG.get("climate", "central_asia")   # tree species mix
PX = 156543.03392 * math.cos(math.radians(ORIGIN[0])) / 2 ** 17   # metres per z17 pixel       # "town": village-like, "city": apartment blocks
os.makedirs(OUT, exist_ok=True)


def rnd(key, salt=""):
    """Deterministic pseudo-random number in [0,1) for a key."""
    h = hashlib.md5((str(key) + salt).encode()).digest()
    return int.from_bytes(h[:4], "little") / 2 ** 32


def bbox_local(bbox):
    w, s, e, n = bbox
    x0, y0 = local(s, w)
    x1, y1 = local(n, e)
    return x0, y0, x1, y1


def local_to_pixel(x, y, z, tx0, ty0):
    """Local metres -> pixel coordinates inside a tile mosaic starting at tile (tx0,ty0)."""
    mx = np.asarray(x) / K + MX0
    my = np.asarray(y) / K + MY0
    n = 2 ** z * 256
    px = (mx / (2 * math.pi * R) + 0.5) * n - tx0 * 256
    py = (0.5 - my / (2 * math.pi * R)) * n - ty0 * 256
    return px, py


# --------------------------------------------------------------------------- terrain
def bilinear(img, px, py):
    h, w = img.shape
    px = np.clip(px, 0, w - 1.001)
    py = np.clip(py, 0, h - 1.001)
    x0 = np.floor(px).astype(int)
    y0 = np.floor(py).astype(int)
    fx, fy = px - x0, py - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def build_terrain(dem_z, bbox, spacing, name, smooth):
    tx0, tx1, ty0, ty1 = tile_range(bbox, dem_z)
    npy = os.path.join(CACHE, f"dem{dem_z}.npy")
    if not os.path.exists(npy):
        dem = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
        for x in range(tx0, tx1 + 1):
            for y in range(ty0, ty1 + 1):
                t = cv2.imread(os.path.join(CACHE, f"dem{dem_z}", f"{dem_z}_{x}_{y}.png"))[..., ::-1].astype(np.float32)
                dem[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = \
                    t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768
        np.save(npy, dem)
    dem = np.load(npy)
    x0, y0, x1, y1 = bbox_local(bbox)
    nx = int(round((x1 - x0) / spacing)) + 1
    ny = int(round((y1 - y0) / spacing)) + 1
    xs = np.linspace(x0, x1, nx)
    ys = np.linspace(y1, y0, ny)              # row 0 = north
    gx, gy = np.meshgrid(xs, ys)
    px, py = local_to_pixel(gx, gy, dem_z, tx0, ty0)
    h = bilinear(dem, px, py).astype(np.float32)
    h = np.maximum(h, np.percentile(h, 1.0) - 5)        # drop DEM voids / spikes
    if smooth:
        h = cv2.GaussianBlur(h, (0, 0), smooth)
    v = h + 32768.0
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.round((v - r * 256 - g) * 256)
    over = b > 255
    g[over] += 1
    b[over] = 0
    rgb = np.dstack([r, g, b]).astype(np.uint8)
    cv2.imwrite(os.path.join(OUT, name), rgb[..., ::-1], [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f"{name}: {nx}x{ny} @ {spacing} m, {h.min():.0f}..{h.max():.0f} m")
    return {"file": name, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "nx": nx, "ny": ny,
            "min": float(h.min()), "max": float(h.max())}


# --------------------------------------------------------------------------- imagery
def load_mosaic():
    path = os.path.join(CACHE, "mosaic17.png")
    tx0, tx1, ty0, ty1 = tile_range(CITY_BBOX, 17)
    if not os.path.exists(path):
        m = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8)
        for x in range(tx0, tx1 + 1):
            for y in range(ty0, ty1 + 1):
                t = cv2.imread(os.path.join(CACHE, "img17", f"17_{x}_{y}.jpg"))
                m[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = t
        cv2.imwrite(path, m)
    return cv2.imread(path), tx0, ty0


# --------------------------------------------------------------------------- OSM
ROAD_W = {"trunk": 10, "primary": 10, "secondary": 9, "tertiary": 7, "unclassified": 5.5,
          "residential": 5, "living_street": 4, "service": 3.5, "track": 3,
          "path": 1.5, "footway": 1.5, "pedestrian": 4}
WATER_W = {"river": 8, "stream": 4, "canal": 3, "ditch": 1.2, "drain": 1.2}


def load_osm():
    d = json.load(open(os.path.join(CACHE, "osm.json")))
    roads, water, pois, landuse, lakes, forests = [], [], [], [], [], []
    for e in d["elements"]:
        t = e.get("tags", {})
        if e["type"] == "node":
            if "amenity" in t or "place" in t:
                x, y = local(e["lat"], e["lon"])
                pois.append({"name": t.get("name", ""), "kind": t.get("amenity") or t.get("place"),
                             "x": round(x, 1), "y": round(y, 1)})
            continue
        is_forest = t.get("landuse") == "forest" or t.get("natural") == "wood"
        if e["type"] == "relation" and (t.get("natural") == "water" or is_forest):
            outer, inner = [], []
            for m in e.get("members", []):
                if m.get("type") == "way" and "geometry" in m:
                    line = LineString([local(p["lat"], p["lon"]) for p in m["geometry"]])
                    (inner if m.get("role") == "inner" else outer).append(line)
            polys = list(polygonize(unary_union(outer)))
            if polys:
                shape = unary_union(polys)
                for hole in polygonize(unary_union(inner)) if inner else []:
                    shape = shape.difference(hole)
                if is_forest:
                    forests.append((t.get("leaf_type", ""), shape))
                else:
                    lakes.append((t.get("name", ""), shape))
            continue
        if e["type"] == "relation":
            if "name" in t and ("amenity" in t or "building" in t):
                b = e["bounds"]
                x, y = local((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2)
                pois.append({"name": t["name"], "kind": t.get("amenity", "building"),
                             "x": round(x, 1), "y": round(y, 1)})
            continue
        if "geometry" not in e:
            continue
        pts = [local(p["lat"], p["lon"]) for p in e["geometry"]]
        flat = [round(v, 1) for p in pts for v in p]
        if "highway" in t and t["highway"] in ROAD_W:
            roads.append({"type": t["highway"], "w": ROAD_W[t["highway"]], "name": t.get("name", ""),
                          "surface": t.get("surface", ""), "p": flat})
        elif "waterway" in t and t["waterway"] in WATER_W and t["waterway"] != "river":
            water.append({"type": t["waterway"], "w": WATER_W[t["waterway"]],
                          "name": t.get("name", ""), "p": flat})
        elif t.get("natural") == "water" and len(pts) > 3 and pts[0] == pts[-1]:
            lakes.append((t.get("name", ""), Polygon(pts)))
        elif is_forest and len(pts) > 3 and pts[0] == pts[-1]:
            forests.append((t.get("leaf_type", ""), Polygon(pts)))
        elif "landuse" in t:
            landuse.append((t["landuse"], pts))
    return roads, water, pois, landuse, lakes, forests


def water_polygons(lakes):
    x0, y0, x1, y1 = bbox_local(CITY_BBOX)
    clip = Polygon([(x0 - 800, y0 - 800), (x1 + 800, y0 - 800), (x1 + 800, y1 + 800), (x0 - 800, y1 + 800)])
    out = []
    for name, shape in lakes:
        shape = shape.buffer(0).intersection(clip).simplify(1.5)
        for pg in getattr(shape, "geoms", [shape]):
            if pg.geom_type != "Polygon" or pg.area < 400:
                continue
            ext = list(pg.exterior.coords)[:-1]
            if not pg.exterior.is_ccw:
                ext = ext[::-1]
            rings = [[round(v, 1) for p in ext for v in p]]
            for hole in pg.interiors:
                rings.append([round(v, 1) for p in list(hole.coords)[:-1] for v in p])
            out.append({"name": name, "rings": rings})
    print(f"water polygons: {len(out)}")
    return out


# --------------------------------------------------------------------------- buildings
WALLS = ["#e6dfcf", "#d8ccb4", "#cdbb98", "#c4ad89", "#e2d3b3", "#d3c9b8",
         "#bfc8c6", "#d9dccd", "#b9a17e", "#ddd0bb", "#a8916f", "#ece7db",
         "#c9b28c", "#d6c3a1", "#b8b0a2", "#e0d6c2"]


def roof_colour(mosaic, poly_px):
    h, w = mosaic.shape[:2]
    p = np.array(poly_px)
    lo = np.maximum(np.floor(p.min(0)).astype(int) - 2, 0)
    hi = np.minimum(np.ceil(p.max(0)).astype(int) + 2, [w, h])
    if (hi - lo).min() <= 2:
        return None
    m = np.zeros((hi[1] - lo[1], hi[0] - lo[0]), np.uint8)
    cv2.fillPoly(m, [(p - lo).round().astype(np.int32)], 1)
    if m.sum() > 30:
        m = cv2.erode(m, np.ones((3, 3), np.uint8))
    px = mosaic[lo[1]:hi[1], lo[0]:hi[0]][m > 0]
    if len(px) < 4:
        return None
    bgr = np.median(px, axis=0)
    return "#%02x%02x%02x" % (int(bgr[2]), int(bgr[1]), int(bgr[0]))


BLOCK_WALLS = ["#c9c4b8", "#d6d0c2", "#bfb9ad", "#d9cfb9", "#c4b9a3", "#e0dbd0", "#b7b3aa", "#cfc2a8"]


def classify(key, area, rect_l, rect_w, fill, dist_centre, floors=None, height=None, cls=None):
    """Return (wall height, roof type, pitch, apartment block?).  Deterministic per building."""
    r1, r2 = rnd(key, "h"), rnd(key, "r")
    aspect = rect_l / max(rect_w, 0.1)
    city = PROFILE == "city"
    central = dist_centre < (2500 if city else 900)
    if height:
        h = float(height)
        return h, ("flat" if h > 8 else "hip"), 16, h > 8
    if floors:
        f = int(floors)
        if f >= 3:
            return f * 3.0 + 0.6, "flat", 0, True
        return f * 3.1 + 0.3, ("hip" if fill > 0.8 else "flat"), 20, False
    if cls in ("house", "detached", "garage", "garages", "shed", "hut", "farm_auxiliary"):
        floors = 2 if r1 < 0.25 and area > 90 else 1
        return floors * 3.0 + 0.2 + r2 * 0.4, ("hip" if fill > 0.8 else "flat"), 20, False
    if cls == "apartments" and area > 120:
        return (5 if r1 < 0.7 else 9) * 3.0 + 0.6, "flat", 0, True
    if area < 28:                                   # sheds, garages, outbuildings
        return 2.4 + r1 * 0.6, "shed" if r2 < 0.6 else "flat", 6, False
    if city and area > 380 and fill > 0.88 and 10 < rect_w < 16.5 and rect_l > 36:
        # Soviet-era panel / brick apartment block
        f = 5 if r1 < 0.52 else 9 if r1 < 0.78 else 4 if r1 < 0.93 else 3
        return f * 3.0 + 0.6, "flat", 0, True
    if area > 900:                                  # halls, markets, sport halls
        return 7.5 + r1 * 3, "flat" if fill < 0.85 or r2 < 0.5 else "gable", 8, False
    if area > 320:                                  # schools, offices, clinics
        floors = 1 + (r1 < (0.75 if central else 0.4)) + (central and aspect > 2.5 and r1 < 0.2) + (city and r2 < 0.3)
        roof = "hip" if fill > 0.82 and r2 < 0.65 else "flat"
        return floors * 3.3 + 0.5, roof, 16, floors >= 3
    # private houses
    two = (0.22 if central else 0.12) if city else (0.07 if central else 0.03)
    floors = 2 if r1 < two and area > 90 else 1
    wall = floors * 3.0 + 0.1 + r2 * 0.5
    if fill < 0.78:
        return wall, "flat", 0, False
    if aspect > 2.1:
        return wall, "gable", 18 + r2 * 8, False
    return wall, "hip", 18 + r2 * 8, False


def rect_from(poly_xy):
    (cx, cy), (w, h), ang = cv2.minAreaRect(np.asarray(poly_xy, np.float32))
    box = cv2.boxPoints(((cx, cy), (w, h), ang))
    return box, w, h


def detect_extra_roofs(mosaic, footprint_mask, road_mask, town_mask):
    def one(m, fm, rm, tm):
        boxes = _extra_roofs(m, fm, rm, tm)
        return [[*b.mean(0), *b.ravel()] for b in boxes]
    one.cols = 10
    res = tiled(one, [mosaic, footprint_mask, road_mask, town_mask])
    out = []
    for row in res:
        box = row[2:].reshape(4, 2) + (row[:2] - row[2:].reshape(4, 2).mean(0))
        out.append(box.astype(np.float32))
    return out


def _extra_roofs(mosaic, footprint_mask, road_mask, town_mask):
    """Colour/contrast roof detection to fill gaps in the ML footprint dataset."""
    lab = cv2.cvtColor(mosaic, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A, B = lab[..., 0], lab[..., 1] - 128, lab[..., 2] - 128
    f = mosaic.astype(np.float32)
    exg = (2 * f[..., 1] - f[..., 2] - f[..., 0]) / (f.sum(-1) + 1)
    bg = cv2.GaussianBlur(L, (0, 0), 12)
    mu = cv2.blur(L, (5, 5))
    sd = np.sqrt(np.maximum(cv2.blur(L * L, (5, 5)) - mu * mu, 0))
    chroma = np.hypot(A, B)
    bright = (L > bg + 18) & (L > 160) & (chroma < 20)
    coloured = ((A > 22) & (L < 190)) | ((B < -12) & (L > 60))
    roof = (bright | coloured) & (exg < 0.04) & (sd < 12)
    blocked = cv2.dilate(footprint_mask, np.ones((5, 5), np.uint8)) | road_mask | (1 - town_mask)
    roof = (roof & (blocked == 0)).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    roof = cv2.morphologyEx(roof, cv2.MORPH_OPEN, k)
    roof = cv2.morphologyEx(roof, cv2.MORPH_CLOSE, k)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(roof, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 40 or a > 2000:
            continue
        sub = (lbl[y:y + h, x:x + w] == i).astype(np.uint8)
        cs, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(cs[0])
        if min(rw, rh) < 4.5 or a / (rw * rh + 1e-6) < 0.72 or max(rw, rh) / min(rw, rh) > 5:
            continue
        box = cv2.boxPoints(((cx + x, cy + y), (rw, rh), ang))
        out.append(box)
    return out


def build_buildings(mosaic, tx0, ty0, roads, landuse):
    t = pq.read_table(os.path.join(CACHE, "overture_buildings.parquet"),
                      columns=["id", "geometry", "names", "class", "num_floors", "height"])
    geoms = shapely.from_wkb(t.column("geometry").to_pylist())
    ids = t.column("id").to_pylist()
    names = [(n or {}).get("primary") for n in t.column("names").to_pylist()]
    names = [n if n and len(n) > 4 and not n[0].isdigit() and "улица" not in n.lower() and "кӯча" not in n.lower() else None
             for n in names]
    extra_attr = {gid: (f, hh, c) for gid, f, hh, c in zip(ids, t.column("num_floors").to_pylist(),
                                                          t.column("height").to_pylist(), t.column("class").to_pylist())}

    def to_px(xy):
        px, py = local_to_pixel(xy[:, 0], xy[:, 1], 17, tx0, ty0)
        return np.stack([px, py], 1)

    def from_px(p):
        n = 2 ** 17 * 256
        mx = ((p[:, 0] + tx0 * 256) / n - 0.5) * 2 * math.pi * R
        my = (0.5 - (p[:, 1] + ty0 * 256) / n) * 2 * math.pi * R
        return np.stack([(mx - MX0) * K, (my - MY0) * K], 1)

    h, w = mosaic.shape[:2]
    fmask = np.zeros((h, w), np.uint8)
    polys = []
    for gid, g, nm in zip(ids, geoms, names):
        pg = g if g.geom_type == "Polygon" else max(g.geoms, key=lambda q: q.area)
        xy = np.array([local(la, lo) for lo, la in pg.exterior.coords])
        pp = to_px(xy)
        cv2.fillPoly(fmask, [pp.round().astype(np.int32)], 1)
        polys.append((gid, xy, pp, nm, "ms"))

    # roads + town mask for supplementary detection
    rmask = np.zeros((h, w), np.uint8)
    for r in roads:
        p = to_px(np.array(r["p"]).reshape(-1, 2))
        cv2.polylines(rmask, [p.round().astype(np.int32)], False, 1, max(2, int(r["w"] / PX) + 2))
    tmask = np.zeros((h, w), np.uint8)
    for lu, pts in landuse:
        if lu == "residential":
            cv2.fillPoly(tmask, [to_px(np.array(pts)).round().astype(np.int32)], 1)
    tmask = cv2.dilate(tmask, np.ones((61, 61), np.uint8))
    extra = detect_extra_roofs(mosaic, fmask, rmask, tmask)
    for i, box in enumerate(extra):
        polys.append((f"det{i}", from_px(box), box, None, "det"))
    print(f"buildings: {len(geoms)} from Overture/Microsoft, {len(extra)} detected from imagery")

    out = []
    for gid, xy, pp, nm, src in polys:
        P = Polygon(xy)
        if not P.is_valid:
            P = P.buffer(0)
            if P.geom_type != "Polygon":
                continue
        area = P.area
        if area < 8:
            continue
        box, rw, rh = rect_from(xy)
        fill = area / max(rw * rh, 1e-6)
        L, W = max(rw, rh), min(rw, rh)
        cx, cy = P.centroid.x, P.centroid.y
        cxc, cyc = _CFG.get("centre", [0, 0])
        wall, roof, pitch, block = classify(gid, area, L, W, fill, math.hypot(cx - cxc, cy - cyc),
                                            *extra_attr.get(gid, (None, None, None)))
        if roof in ("hip", "gable", "shed"):
            ring = box                                        # regularised rectangle
        else:
            ring = np.array(P.simplify(0.35).exterior.coords)[:-1]
        if Polygon(ring).exterior.is_ccw is False:
            ring = ring[::-1]
        colour = roof_colour(mosaic, pp) or "#9a9a96"
        out.append({
            "p": [round(float(v), 1) for v in np.asarray(ring).ravel()],
            "h": round(wall, 2),
            "roof": roof,
            "pitch": round(pitch, 1),
            "rc": colour,
            "wc": (BLOCK_WALLS if block else WALLS)[int(rnd(gid, "w") * len((BLOCK_WALLS if block else WALLS)))],
            **({"name": nm} if nm else {}),
        })
    return out, fmask, rmask


# --------------------------------------------------------------------------- trees
def tiled(fn, arrays, size=4096, pad=48):
    """Run fn on overlapping tiles of large rasters to bound memory.  fn returns
    an (N, >=2) array whose first two columns are x, y pixel coordinates inside
    the tile; results are kept only in each tile's core and offset back."""
    h, w = arrays[0].shape[:2]
    out = []
    for y0 in range(0, h, size):
        for x0 in range(0, w, size):
            a, b = max(0, x0 - pad), max(0, y0 - pad)
            sub = [arr[b:min(h, y0 + size + pad), a:min(w, x0 + size + pad)] for arr in arrays]
            res = np.asarray(fn(*sub), dtype=np.float64).reshape(-1, fn.cols)
            if not len(res):
                continue
            res[:, 0] += a
            res[:, 1] += b
            keep = (res[:, 0] >= x0) & (res[:, 0] < x0 + size) & (res[:, 1] >= y0) & (res[:, 1] < y0 + size)
            out.append(res[keep])
    return np.concatenate(out) if out else np.zeros((0, fn.cols))


def _tree_peaks(mosaic, fmask, rmask):
    f = mosaic.astype(np.float32)
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    L = cv2.cvtColor(mosaic, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)
    exg = (2 * g - r - b) / (f.sum(-1) + 1)
    veg = ((exg > 0.07) & (L < 120)).astype(np.uint8)
    mu = cv2.blur(L, (5, 5))
    sd = np.sqrt(np.maximum(cv2.blur(L * L, (5, 5)) - mu * mu, 0))
    veg &= ((sd > 5.5) | (L < 78)).astype(np.uint8)
    veg &= (1 - fmask)
    veg &= (1 - cv2.erode(rmask, np.ones((3, 3), np.uint8)))
    veg = cv2.morphologyEx(veg, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    dt = cv2.distanceTransform(veg, cv2.DIST_L2, 3)
    sm = cv2.GaussianBlur(dt, (0, 0), 1.2)
    mx = cv2.dilate(sm, np.ones((7, 7), np.uint8))
    peak = (sm >= mx - 1e-6) & (sm > 1.9) & (L < 105)
    ys, xs = np.nonzero(peak)
    return np.stack([xs, ys, dt[ys, xs]], 1) if len(xs) else np.zeros((0, 3))


_tree_peaks.cols = 3


def build_trees(mosaic, tx0, ty0, fmask, rmask, roads, water, forests=()):
    pk = tiled(_tree_peaks, [mosaic, fmask, rmask])
    max_trees = _CFG.get("max_trees", 0)
    if max_trees and len(pk) > max_trees:
        pk = pk[np.random.default_rng(3).choice(len(pk), max_trees, replace=False)]
    xs, ys, dtv = pk[:, 0].astype(int), pk[:, 1].astype(int), pk[:, 2]
    dt = None
    rad = np.clip(dtv * PX, 1.5, 6.5)

    n = 2 ** 17 * 256
    mxm = ((xs + 0.5 + tx0 * 256) / n - 0.5) * 2 * math.pi * R
    mym = (0.5 - (ys + 0.5 + ty0 * 256) / n) * 2 * math.pi * R
    X = (mxm - MX0) * K
    Y = (mym - MY0) * K

    # Lombardy poplars line streets and irrigation ditches in the Fergana valley
    line_mask = np.zeros_like(fmask)
    for coll, thick in ((roads, 30), (water, 36)):
        for e in coll:
            p = np.array(e["p"]).reshape(-1, 2)
            px, py = local_to_pixel(p[:, 0], p[:, 1], 17, tx0, ty0)
            cv2.polylines(line_mask, [np.stack([px, py], 1).round().astype(np.int32)], False, 1, thick)
    near_line = line_mask[ys, xs] > 0
    rng = np.random.default_rng(7)
    u = rng.random(len(X))
    kind = np.zeros(len(X), np.uint8)                       # 0 broadleaf (fruit / mulberry / walnut)
    kind[(near_line & (rad < 4.2) & (u < 0.35)) | ((rad < 2.2) & (u < 0.15))] = 1   # poplar
    kind[(kind == 0) & (u > 0.93)] = 2                      # tall plane / elm (chinar)
    hgt = np.where(kind == 1, 13 + rng.random(len(X)) * 9,
                   np.where(kind == 2, rad * 3.0 + 5, rad * 1.9 + 2.2 + rng.random(len(X)) * 2))
    rad = np.where(kind == 1, np.clip(rad * 0.6, 1.0, 2.0), rad)
    if CLIMATE == "siberia":
        # forest type from OSM: 1 needle-leaved (pine "bor"), 2 other forest
        fmap = np.zeros_like(fmask)
        for leaf, shape in forests:
            for pg in getattr(shape, "geoms", [shape]):
                if pg.geom_type != "Polygon":
                    continue
                pp = np.array(pg.exterior.coords)
                px, py = local_to_pixel(pp[:, 0], pp[:, 1], 17, tx0, ty0)
                cv2.fillPoly(fmap, [np.stack([px, py], 1).round().astype(np.int32)], 1 if leaf == "needleleaved" else 2)
        f = fmap[ys, xs]
        v = rng.random(len(X))
        kind = np.zeros(len(X), np.uint8)                    # elm / maple / balsam poplar
        kind[(f == 0) & (v < 0.32)] = 4                       # birch
        kind[(f == 0) & (v >= 0.32) & (v < 0.42)] = 2         # big old poplars
        kind[(f == 0) & (v >= 0.42) & (v < 0.47)] = 5         # spruce
        kind[(f == 1) & (v < 0.85)] = 3                       # Scots pine
        kind[(f == 1) & (v >= 0.85) & (v < 0.93)] = 4
        kind[(f == 1) & (v >= 0.93)] = 5
        kind[(f == 2) & (v < 0.45)] = 4
        kind[(f == 2) & (v >= 0.45) & (v < 0.75)] = 3
        r2 = rng.random(len(X))
        rad = np.where(kind == 3, np.clip(rad * 0.85, 2.0, 4.5), np.where(kind == 5, np.clip(rad * 0.7, 1.5, 3.2), rad))
        hgt = np.select([kind == 3, kind == 4, kind == 5, kind == 2],
                        [18 + r2 * 9, rad * 2.4 + 7 + r2 * 4, 9 + r2 * 9, rad * 2.6 + 8],
                        rad * 2.0 + 4 + r2 * 3)

    arr = np.zeros(len(X), dtype=[("x", "<f4"), ("y", "<f4"), ("r", "u1"), ("h", "u1"),
                                  ("k", "u1"), ("s", "u1")])
    arr["x"], arr["y"] = X, Y
    arr["r"] = np.clip(rad * 20, 0, 255)
    arr["h"] = np.clip(hgt * 8, 0, 255)
    arr["k"] = kind
    arr["s"] = rng.integers(0, 256, len(X))
    arr.tofile(os.path.join(OUT, "trees.bin"))
    print(f"trees: {len(X)} by kind {np.bincount(kind, minlength=6).tolist()}")
    return len(X)


if __name__ == "__main__":
    terrain_city = build_terrain(14, CITY_BBOX, 10.0, "terrain_city.png", smooth=1.3)
    terrain_region = build_terrain(11, REGION_BBOX, 60.0, "terrain_region.png", smooth=0.6)
    roads, water, pois, landuse, lakes, forests = load_osm()
    mosaic, tx0, ty0 = load_mosaic()
    buildings, fmask, rmask = build_buildings(mosaic, tx0, ty0, roads, landuse)
    ntrees = build_trees(mosaic, tx0, ty0, fmask, rmask, roads, water, forests)
    city = {
        "meta": {
            "name": _CFG.get("viewer", {}).get("title", CITY),
            "origin": {"lat": ORIGIN[0], "lon": ORIGIN[1]},
            "scale": K,
            "cityBBox": CITY_BBOX, "regionBBox": REGION_BBOX,
            "terrainCity": terrain_city, "terrainRegion": terrain_region,
            "trees": ntrees,
            "viewer": _CFG.get("viewer", {}),
            "attribution": [
                "Map data © OpenStreetMap contributors (ODbL)",
                "Building footprints: Microsoft Global ML Building Footprints via Overture Maps (ODbL)",
                "Elevation: AWS Terrain Tiles (SRTM, GMTED)",
                "Imagery: Esri World Imagery (Maxar, Earthstar Geographics)",
            ],
        },
        "buildings": buildings,
        "roads": roads,
        "water": water,
        "pois": pois,
        "lakes": water_polygons(lakes),
    }
    with open(os.path.join(OUT, "city.json"), "w") as fh:
        json.dump(city, fh, ensure_ascii=False, separators=(",", ":"))
    print("city.json", os.path.getsize(os.path.join(OUT, "city.json")) // 1024, "KB")
