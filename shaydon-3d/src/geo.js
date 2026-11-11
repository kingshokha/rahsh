// Coordinate helpers shared by every module.
//
// "Local" coordinates are metres on the ground: x east, y north, origin at the
// centre of Shaydon.  They are Web-Mercator metres scaled by cos(lat0), which
// keeps the Esri imagery tiles (Web-Mercator) exactly aligned with the data.
// World (three.js) coordinates: X = east, Y = up (elevation - ELEV0), Z = south.
import * as THREE from 'three';

export const R = 6378137;
export const ELEV0 = 900; // metres; keeps world-space numbers small

let K = 1, MX0 = 0, MY0 = 0;

export function initGeo(meta) {
  K = meta.scale;
  [MX0, MY0] = merc(meta.origin.lat, meta.origin.lon);
}

export function merc(lat, lon) {
  return [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
}

export function lonLatToLocal(lon, lat) {
  const [mx, my] = merc(lat, lon);
  return [(mx - MX0) * K, (my - MY0) * K];
}

export function bboxToLocal([w, s, e, n]) {
  const [x0, y0] = lonLatToLocal(w, s);
  const [x1, y1] = lonLatToLocal(e, n);
  return { x0, y0, x1, y1 };
}

/** Local metres -> fractional slippy-map tile coordinates at zoom z. */
export function localToTile(x, y, z) {
  const mx = x / K + MX0, my = y / K + MY0, n = 2 ** z;
  return [(mx / (2 * Math.PI * R) + 0.5) * n, (0.5 - my / (2 * Math.PI * R)) * n];
}

export function world(x, y, h, target = new THREE.Vector3()) {
  return target.set(x, h - ELEV0, -y);
}

/** Regular elevation grid decoded from a terrarium PNG (row 0 = north). */
export class HeightField {
  constructor(data, info) {
    Object.assign(this, info);
    this.data = data;
    this.dx = (this.x1 - this.x0) / (this.nx - 1);
    this.dy = (this.y1 - this.y0) / (this.ny - 1);
  }
  inside(x, y, margin = 0) {
    return x >= this.x0 + margin && x <= this.x1 - margin && y >= this.y0 + margin && y <= this.y1 - margin;
  }
  at(i, j) {
    i = Math.min(Math.max(i, 0), this.nx - 1);
    j = Math.min(Math.max(j, 0), this.ny - 1);
    return this.data[j * this.nx + i];
  }
  sample(x, y) {
    const fx = Math.min(Math.max((x - this.x0) / this.dx, 0), this.nx - 1.0001);
    const fy = Math.min(Math.max((this.y1 - y) / this.dy, 0), this.ny - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const d = this.data, n = this.nx, k = j * n + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + n] * (1 - u) + d[k + n + 1] * u) * v;
  }
}

export async function loadHeightField(url, info) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  return new HeightField(out, { ...info, nx: c.width, ny: c.height });
}

/** Elevation anywhere: detailed city grid inside, regional grid outside. */
export function makeHeightAt(city, region) {
  return (x, y) => (city.inside(x, y) ? city.sample(x, y) : region.sample(x, y));
}

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
