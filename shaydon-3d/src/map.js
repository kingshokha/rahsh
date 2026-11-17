// Street map for the driving mode: one pre-rendered canvas of the town,
// shown as a heading-up minimap and as a full-screen "where am I" map.

const COL = {
  land: '#ebe6da', water: '#9cc6d8', building: '#c9c0b0', buildingEdge: '#b3a993',
  road: '#ffffff', roadEdge: '#c9c2b2', main: '#f3cd5e', mainEdge: '#c99a2a', trail: '#2f7de1',
};
const MAIN = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

/** Draw the town into a 2D context; X/Y map local metres to pixels, `ppm` is pixels per metre. */
function drawTown(g, city, X, Y, ppm, W, H) {
  const path = (flat, close) => {
    g.beginPath();
    for (let i = 0; i < flat.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(flat[i]), Y(flat[i + 1]));
    if (close) g.closePath();
  };
  g.fillStyle = COL.land;
  g.fillRect(0, 0, W, H);
  g.fillStyle = COL.water;
  for (const l of city.lakes || []) {
    g.beginPath();
    for (const ring of l.rings) {
      for (let i = 0; i < ring.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(ring[i]), Y(ring[i + 1]));
      g.closePath();
    }
    g.fill('evenodd');
  }
  g.strokeStyle = COL.water; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const w of city.water || []) { g.lineWidth = Math.max(1.2, w.w * ppm); path(w.p); g.stroke(); }
  g.fillStyle = COL.building; g.strokeStyle = COL.buildingEdge; g.lineWidth = 0.6;
  for (const b of city.buildings) { path(b.p, true); g.fill(); if (ppm > 0.3) g.stroke(); }
  const roads = city.roads.filter((r) => r.type !== 'footway' && r.type !== 'path');
  for (const pass of [0, 1]) {
    for (const main of [false, true]) {
      for (const r of roads) {
        if (MAIN.has(r.type) !== main) continue;
        const w = Math.max(main ? 2.6 : 1.4, r.w * ppm + (main ? 1.2 : 0.4));
        g.lineWidth = pass ? w : w + (ppm > 0.3 ? 2 : 1.4);
        g.strokeStyle = pass ? (main ? COL.main : COL.road) : (main ? COL.mainEdge : COL.roadEdge);
        path(r.p); g.stroke();
      }
    }
  }
}

/** Render the town once at `scale` metres per pixel (used by the minimap). */
export function buildMapCanvas(city, hf, scale = 2.2) {
  const W = Math.ceil((hf.x1 - hf.x0) / scale), H = Math.ceil((hf.y1 - hf.y0) / scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  drawTown(c.getContext('2d'), city, (x) => (x - hf.x0) / scale, (y) => (hf.y1 - y) / scale, 1 / scale, W, H);
  return { canvas: c, scale, x0: hf.x0, y1: hf.y1, W, H, city };
}

function carArrow(g, x, y, angle, size, fill = '#e5332a') {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(0, -size); g.lineTo(size * 0.72, size * 0.75); g.lineTo(0, size * 0.38); g.lineTo(-size * 0.72, size * 0.75);
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  g.restore();
}

/** Round heading-up minimap. */
export class MiniMap {
  constructor(canvas, map, radiusMeters = 260) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.map = map; this.r = radiusMeters;
    const dpr = Math.min(devicePixelRatio, 2);
    this.size = canvas.clientWidth || 180;
    canvas.width = canvas.height = Math.round(this.size * dpr);
    this.g.scale(dpr, dpr);
  }
  draw(x, y, heading) {
    const { g, map, size } = this;
    const R = size / 2, k = R / (this.r / map.scale);
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#ebe6da'; g.fillRect(0, 0, size, size);
    g.translate(R, R);
    g.rotate(-heading);
    g.scale(k, k);
    g.imageSmoothingQuality = 'high';
    g.drawImage(map.canvas, -(x - map.x0) / map.scale, -(map.y1 - y) / map.scale);
    g.restore();
    carArrow(g, R, R, 0, 9);
    // north marker on the rim
    const nx = R - Math.sin(heading) * (R - 12), ny = R - Math.cos(heading) * (R - 12);
    g.fillStyle = 'rgba(20,24,28,.75)';
    g.beginPath(); g.arc(nx, ny, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('С', nx, ny + 0.5);
  }
}

/** Full-screen map: whole town, north up, with the car and the route so far. */
export class BigMap {
  constructor(canvas, map) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.map = map; this.trail = [];
  }
  record(x, y) {
    const t = this.trail, last = t[t.length - 1];
    if (!last || Math.hypot(last[0] - x, last[1] - y) > 8) t.push([x, y]);
    if (t.length > 6000) t.splice(0, 1000);
  }
  draw(x, y, heading, start) {
    const { c, g, map } = this;
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const k = Math.min(w / map.W, h / map.H) * 0.96;
    const ox = (w - map.W * k) / 2, oy = (h - map.H * k) / 2;
    const key = `${c.width}x${c.height}`;
    if (this.key !== key) {
      // draw the streets once at this size so they stay crisp
      this.key = key;
      this.base = document.createElement('canvas');
      this.base.width = c.width; this.base.height = c.height;
      const b = this.base.getContext('2d');
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ppm = k / map.scale;
      drawTown(b, map.city, (px) => ox + (px - map.x0) * ppm, (py) => oy + (map.y1 - py) * ppm, ppm, w, h);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = (px, py) => [ox + ((px - map.x0) / map.scale) * k, oy + ((map.y1 - py) / map.scale) * k];
    if (this.trail.length > 1) {
      g.beginPath();
      this.trail.forEach(([tx, ty], i) => { const [u, v] = P(tx, ty); (i ? g.lineTo : g.moveTo).call(g, u, v); });
      g.lineWidth = 3; g.strokeStyle = COL.trail; g.globalAlpha = 0.8; g.stroke(); g.globalAlpha = 1;
    }
    if (start) {
      const [u, v] = P(start.x, start.y);
      g.fillStyle = '#2f7de1'; g.beginPath(); g.arc(u, v, 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    }
    const [cx, cy] = P(x, y);
    g.fillStyle = 'rgba(229,51,42,.18)'; g.beginPath(); g.arc(cx, cy, 22, 0, Math.PI * 2); g.fill();
    carArrow(g, cx, cy, heading, 11);
    g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,.9)'; g.strokeText('Вы здесь', cx + 16, cy - 14);
    g.fillStyle = '#1b1e21'; g.fillText('Вы здесь', cx + 16, cy - 14);
    // north arrow and scale bar
    g.fillStyle = '#1b1e21'; g.font = '700 14px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('С ↑', w - 34, 28);
    const meters = 500, px = (meters / map.scale) * k;
    g.fillRect(20, h - 30, px, 4);
    g.font = '12px system-ui, sans-serif'; g.textAlign = 'left';
    g.fillText(`${meters} м`, 20, h - 42);
  }
}
