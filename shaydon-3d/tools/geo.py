"""Shared geographic constants (per city, chosen by the CITY env var) and Web-Mercator helpers.

Local scene coordinates are metres: +x east, +y north, origin at ORIGIN.
They are derived from Web-Mercator metres scaled by cos(lat0) so that the
aerial imagery tiles (which are in Web-Mercator) line up exactly.
"""
import math

import json
import os

CITY = os.environ.get("CITY", "shaydon")
_CFG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cities.json")))[CITY]
ORIGIN = tuple(_CFG["origin"])               # lat, lon - centre of the town
CITY_BBOX = tuple(_CFG["city_bbox"])         # w, s, e, n
REGION_BBOX = tuple(_CFG["region_bbox"])     # mountains + valley context

R = 6378137.0
K = math.cos(math.radians(ORIGIN[0]))


def merc(lat, lon):
    x = math.radians(lon) * R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R
    return x, y


MX0, MY0 = merc(*ORIGIN)


def local(lat, lon):
    x, y = merc(lat, lon)
    return (x - MX0) * K, (y - MY0) * K


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile_range(bbox, z):
    w, s, e, n = bbox
    x0, y0 = tile_xy(n, w, z)
    x1, y1 = tile_xy(s, e, z)
    return int(x0), int(x1), int(y0), int(y1)


def tile_to_local(tx, ty, z):
    """Local metres of the NW corner of a (fractional) tile coordinate."""
    n = 2 ** z
    mx = (tx / n * 2 - 1) * math.pi * R
    my = (1 - ty / n * 2) * math.pi * R
    return (mx - MX0) * K, (my - MY0) * K
