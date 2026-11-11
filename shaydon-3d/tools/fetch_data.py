"""Download raw source data for the Shaydon 3D model into a cache directory.

Sources
  * OpenStreetMap (Overpass API)            - streets, canals, river, land use, POIs
  * AWS Terrain Tiles (terrarium encoding)  - elevation (SRTM / GMTED based)
  * Esri World Imagery                      - aerial imagery, used only for analysis
                                              (building / tree detection); the viewer
                                              streams imagery directly from Esri.

Usage:  python3 fetch_data.py <cache_dir>
"""
import concurrent.futures as cf
import json
import math
import os
import subprocess
import sys
import time

from geo import CITY_BBOX, REGION_BBOX, tile_range

CACHE = sys.argv[1] if len(sys.argv) > 1 else "cache"
UA = "shaydon-3d-builder/1.0"

ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def curl(url, out, data=None, timeout=240):
    cmd = ["curl", "-sS", "-f", "-m", str(timeout), "-A", UA, "-o", out, url]
    if data is not None:
        cmd[1:1] = ["--data-urlencode", "data@" + data]
    for attempt in range(5):
        if subprocess.run(cmd).returncode == 0 and os.path.getsize(out) > 0:
            return True
        time.sleep(2 ** attempt)
    return False


def fetch_tiles(template, z, bbox, folder, ext):
    os.makedirs(folder, exist_ok=True)
    x0, x1, y0, y1 = tile_range(bbox, z)
    jobs = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            out = os.path.join(folder, f"{z}_{x}_{y}.{ext}")
            if not os.path.exists(out):
                jobs.append((template.format(z=z, x=x, y=y), out))
    print(f"{folder}: z{z} {x1-x0+1}x{y1-y0+1} tiles, {len(jobs)} to download")
    with cf.ThreadPoolExecutor(12) as ex:
        ok = list(ex.map(lambda j: curl(*j, timeout=60), jobs))
    if not all(ok):
        raise SystemExit(f"{ok.count(False)} tiles failed")


def fetch_osm(out):
    s, w, n, e = CITY_BBOX[1], CITY_BBOX[0], CITY_BBOX[3], CITY_BBOX[2]
    b = f"({s - .01},{w - .01},{n + .01},{e + .01})"
    q = f"""[out:json][timeout:180];
(
  way["building"]{b}; relation["building"]{b};
  way["highway"]{b}; way["waterway"]{b};
  way["natural"]{b}; relation["natural"]{b};
  way["landuse"]{b}; relation["landuse"]{b};
  way["leisure"]{b}; way["amenity"]{b};
  node["amenity"]{b}; node["place"]{b}; node["natural"="tree"]{b};
);
out geom;"""
    qf = out + ".q"
    open(qf, "w").write(q)
    for url in OVERPASS:
        if curl(url, out, data=qf):
            json.load(open(out))
            return
    raise SystemExit("Overpass download failed")


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(os.path.join(CACHE, "osm.json")):
        fetch_osm(os.path.join(CACHE, "osm.json"))
    fetch_tiles(TERRARIUM, 14, CITY_BBOX, os.path.join(CACHE, "dem14"), "png")
    fetch_tiles(TERRARIUM, 11, REGION_BBOX, os.path.join(CACHE, "dem11"), "png")
    fetch_tiles(ESRI, 17, CITY_BBOX, os.path.join(CACHE, "img17"), "jpg")
