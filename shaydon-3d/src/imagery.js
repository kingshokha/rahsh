// Streams Esri World Imagery tiles straight from Esri into canvas textures.
import * as THREE from 'three';
import { localToTile } from './geo.js';

const URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export class TileLoader {
  constructor(concurrency = 12) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.requested = 0;
    this.done = 0;
    this.failed = 0;
    this.onProgress = null;
  }
  load(z, x, y, priority = 0) {
    this.requested++;
    return new Promise((resolve) => {
      this.queue.push({ z, x, y, priority, resolve });
      this.pump();
    });
  }
  pump() {
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.fetch(job).then((bmp) => {
        this.active--;
        this.done++;
        if (!bmp) this.failed++;
        this.onProgress?.(this);
        job.resolve(bmp);
        this.pump();
      });
    }
  }
  async fetch({ z, x, y }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(URL(z, x, y), { mode: 'cors' });
        if (!r.ok) throw new Error(r.status);
        return await createImageBitmap(await r.blob());
      } catch (e) {
        await new Promise((ok) => setTimeout(ok, 400 * (attempt + 1)));
      }
    }
    return null;
  }
}

/**
 * Tile window covering a local-metre rectangle at zoom z.  `uvOf(x, y)` maps
 * local metres to texture coordinates inside the composed canvas.
 */
export function tileWindow(rect, z) {
  const [ax, ay] = localToTile(rect.x0, rect.y1, z); // NW corner
  const [bx, by] = localToTile(rect.x1, rect.y0, z); // SE corner
  const tx0 = Math.floor(ax), ty0 = Math.floor(ay);
  const tx1 = Math.floor(bx), ty1 = Math.floor(by);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  return {
    z, tx0, ty0, nx, ny,
    uvOf(x, y) {
      const [tx, ty] = localToTile(x, y, z);
      return [(tx - tx0) / nx, 1 - (ty - ty0) / ny];
    },
  };
}

export async function composeTexture(win, loader, renderer, priority = 0, maxSize = 8192) {
  const scale = Math.min(1, maxSize / (256 * Math.max(win.nx, win.ny)));
  const ts = Math.floor(256 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = ts * win.nx;
  canvas.height = ts * win.ny;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9c8d74';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let x = 0; x < win.nx; x++) {
    for (let y = 0; y < win.ny; y++) {
      jobs.push(loader.load(win.z, win.tx0 + x, win.ty0 + y, priority).then((bmp) => {
        if (bmp) { ctx.drawImage(bmp, x * ts, y * ts, ts, ts); bmp.close?.(); }
      }));
    }
  }
  await Promise.all(jobs);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
