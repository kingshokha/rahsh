// Extruded buildings with hip / gable / shed / flat roofs.  Footprints come
// from the Microsoft ML building dataset (via Overture) plus extra roofs found
// in the aerial imagery; roof colours are sampled from that imagery.
import * as THREE from 'three';
import { ELEV0 } from './geo.js';

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpN = new THREE.Vector3();

class Bucket {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.w = []; }
  /** Triangle with explicit outward normal; winding fixed to match it. */
  tri(a, b, c, n, col, uvs = null, w = null) {
    tmpA.subVectors(b, a); tmpB.subVectors(c, a); tmpN.crossVectors(tmpA, tmpB);
    if (tmpN.dot(n) < 0) { [b, c] = [c, b]; if (uvs) uvs = [uvs[0], uvs[2], uvs[1]]; if (w) w = [w[0], w[2], w[1]]; }
    for (const v of [a, b, c]) { this.p.push(v.x, v.y, v.z); this.n.push(n.x, n.y, n.z); this.c.push(col.r, col.g, col.b); }
    if (uvs) for (const u of uvs) this.uv.push(u[0], u[1]); else this.uv.push(0, 0, 0, 0, 0, 0);
    if (w) for (const q of w) this.w.push(q[0], q[1], q[2], q[3]); else for (let i = 0; i < 3; i++) this.w.push(0, -9, 0, 0);
  }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.w, 4));
    g.computeBoundingSphere();
    return g;
  }
}

function faceNormal(a, b, c, up = true) {
  const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a)).normalize();
  if (up && n.y < 0) n.negate();
  return n;
}

// --------------------------------------------------------------- materials
function corrugationNormalMap() {
  // 1 m x 1 m of corrugated metal sheet: sine profile along u, sheet laps along v.
  const w = 256, h = 256, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ph = (x / w) * Math.PI * 2 * 6;          // 6 ribs per metre
      let nx = Math.cos(ph) * 0.55, ny = 0;
      const lap = (y % 128) / 128;                    // sheet overlap every 0.5 m
      if (lap > 0.96) ny = 0.5;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (nx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

function wallMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWall;\nvarying vec4 vWall;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vWall;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hh = vWall.y, wu = vWall.x, wlen = vWall.z, wtop = abs(vWall.w);
        vec3 base = diffuseColor.rgb;
        float isWin = 0.0;
        if (hh > -8.0) {
          base *= mix(1.0, 0.80, 1.0 - smoothstep(0.0, 1.4, hh));        // splash dirt
          base *= mix(1.0, 0.72, smoothstep(wtop - 0.7, wtop, hh));       // shade under eaves
          if (hh < 0.0) base = vec3(0.30, 0.285, 0.27);                    // concrete plinth
          if (vWall.w > 0.0 && wlen > 2.4 && hh > 0.0) {
            float fl = floor(hh / 3.0), ly = hh - fl * 3.0;
            float modW = 3.3;
            float n = max(1.0, floor((wlen - 0.6) / modW));
            float lu = wu - (wlen - n * modW) * 0.5;
            float lx = lu - floor(lu / modW) * modW;
            float inX = step(0.0, lu) * step(lu, n * modW);
            float topOk = step(fl * 3.0 + 2.55, wtop);
            float wx = abs(lx - modW * 0.5), wy = abs(ly - 1.55);
            float win = inX * topOk * (1.0 - smoothstep(0.58, 0.62, wx)) * (1.0 - smoothstep(0.68, 0.72, wy));
            float frm = inX * topOk * (1.0 - smoothstep(0.68, 0.72, wx)) * (1.0 - smoothstep(0.78, 0.82, wy)) - win;
            float mull = win * (1.0 - smoothstep(0.02, 0.05, abs(wx - 0.0))) ;   // centre mullion
            base = mix(base, vec3(0.93, 0.93, 0.9), clamp(frm + mull, 0.0, 1.0));
            isWin = win * (1.0 - mull);
            float far = smoothstep(220.0, 1100.0, length(vViewPosition));   // calm the pattern at distance
            isWin *= 1.0 - far * 0.75;
            base = mix(base, diffuseColor.rgb * 0.9, far * 0.6);
            base = mix(base, vec3(0.035, 0.05, 0.065), isWin);
          }
        }
        diffuseColor.rgb = base;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, isWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.9, isWin);');
  };
  m.customProgramCacheKey = () => 'walls-procedural';
  return m;
}

// --------------------------------------------------------------- geometry
const OVERHANG = 0.5;

function addWalls(bucket, pts, gh, floorY, topY, col, windows, extra = 0) {
  const n = pts.length;
  const wtop = topY - floorY;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    // outward normal for CCW (x east, y north) polygon is (dy, -dx); world Z = -y
    const nrm = new THREE.Vector3((b[1] - a[1]) / len, 0, (b[0] - a[0]) / len);
    const ya = gh[i] - 0.8, yb = gh[(i + 1) % n] - 0.8, top = topY + extra;
    const A0 = new THREE.Vector3(a[0], ya, -a[1]), B0 = new THREE.Vector3(b[0], yb, -b[1]);
    const A1 = new THREE.Vector3(a[0], top, -a[1]), B1 = new THREE.Vector3(b[0], top, -b[1]);
    const flag = windows ? wtop : -wtop;
    const w = (u, y) => [u, y - floorY, len, flag];
    bucket.tri(A0, B0, B1, nrm, col, null, [w(0, ya), w(len, yb), w(len, top)]);
    bucket.tri(A0, B1, A1, nrm, col, null, [w(0, ya), w(len, top), w(0, top)]);
  }
}

function roofFace(bucket, verts, col, eaveDir, slopeDir) {
  // verts: array of Vector3 (3 or 4, planar).  uv in metres along eave / slope.
  const n = faceNormal(verts[0], verts[1], verts[2]);
  const uv = (v) => [v.x * eaveDir.x + v.z * eaveDir.z, v.x * slopeDir.x + v.z * slopeDir.z + v.y];
  bucket.tri(verts[0], verts[1], verts[2], n, col, [uv(verts[0]), uv(verts[1]), uv(verts[2])]);
  if (verts.length === 4) bucket.tri(verts[0], verts[2], verts[3], n, col, [uv(verts[0]), uv(verts[2]), uv(verts[3])]);
}

function pitchedRoof(b, pts, wallTop, roofCol, wallCol, roofs, walls, floorY) {
  // Re-order the rectangle so p0->p1 is a long side.
  let p = pts.map((q) => new THREE.Vector2(q[0], q[1]));
  if (p[0].distanceTo(p[1]) < p[1].distanceTo(p[2])) p = [p[1], p[2], p[3], p[0]];
  const a = p[0].distanceTo(p[1]), c = p[1].distanceTo(p[2]);
  const C = new THREE.Vector2().addVectors(p[0], p[2]).multiplyScalar(0.5);
  const u = new THREE.Vector2().subVectors(p[1], p[0]).normalize();
  const v = new THREE.Vector2().subVectors(p[2], p[1]).normalize();
  const t = Math.tan(THREE.MathUtils.degToRad(b.pitch || 20));
  const W = (q, y) => new THREE.Vector3(q.x, y, -q.y);
  const pt = (su, sv, hu, hv) => new THREE.Vector2(C.x + u.x * su * hu + v.x * sv * hv, C.y + u.y * su * hu + v.y * sv * hv);
  const eDir3 = new THREE.Vector3(u.x, 0, -u.y), sDir3 = new THREE.Vector3(v.x, 0, -v.y);

  if (b.roof === 'shed') {
    const A = a / 2 + OVERHANG * 0.6, B = c / 2 + OVERHANG * 0.6;
    const rise = c * t;
    const lo = wallTop - OVERHANG * 0.6 * t, hi = wallTop + rise + OVERHANG * 0.6 * t;
    roofFace(roofs, [W(pt(-1, -1, A, B), lo), W(pt(1, -1, A, B), lo), W(pt(1, 1, A, B), hi), W(pt(-1, 1, A, B), hi)], roofCol, eDir3, sDir3);
    // fill the gap between wall top and the sloping roof
    const q = [pt(-1, -1, a / 2, c / 2), pt(1, -1, a / 2, c / 2), pt(1, 1, a / 2, c / 2), pt(-1, 1, a / 2, c / 2)];
    const wf = (len, y) => [0, y - floorY, len, -(y - floorY)];
    const nE = new THREE.Vector3(u.x, 0, -u.y), nN = new THREE.Vector3(v.x, 0, -v.y);
    walls.tri(W(q[1], wallTop), W(q[2], wallTop), W(q[2], wallTop + rise), nE, wallCol, null, [wf(c, wallTop), wf(c, wallTop), wf(c, wallTop + rise)]);
    walls.tri(W(q[0], wallTop), W(q[3], wallTop), W(q[3], wallTop + rise), nE.clone().negate(), wallCol, null, [wf(c, wallTop), wf(c, wallTop), wf(c, wallTop + rise)]);
    walls.tri(W(q[3], wallTop), W(q[2], wallTop), W(q[2], wallTop + rise), nN, wallCol, null, [wf(a, wallTop), wf(a, wallTop), wf(a, wallTop + rise)]);
    walls.tri(W(q[3], wallTop), W(q[2], wallTop + rise), W(q[3], wallTop + rise), nN, wallCol, null, [wf(a, wallTop), wf(a, wallTop + rise), wf(a, wallTop + rise)]);
    return;
  }

  const A = a / 2 + OVERHANG, B = c / 2 + OVERHANG;
  const eave = wallTop - OVERHANG * t;
  const ridgeY = wallTop + (c / 2) * t;
  const q0 = W(pt(-1, -1, A, B), eave), q1 = W(pt(1, -1, A, B), eave);
  const q2 = W(pt(1, 1, A, B), eave), q3 = W(pt(-1, 1, A, B), eave);
  if (b.roof === 'hip') {
    const inset = Math.max(A - B, 0);
    const r0 = W(new THREE.Vector2(C.x - u.x * inset, C.y - u.y * inset), ridgeY);
    const r1 = W(new THREE.Vector2(C.x + u.x * inset, C.y + u.y * inset), ridgeY);
    const negS = sDir3.clone().negate(), negE = eDir3.clone().negate();
    roofFace(roofs, [q0, q1, r1, r0], roofCol, eDir3, sDir3);
    roofFace(roofs, [q2, q3, r0, r1], roofCol, eDir3, negS);
    roofFace(roofs, [q3, q0, r0], roofCol, sDir3, eDir3);
    roofFace(roofs, [q1, q2, r1], roofCol, sDir3, negE);
  } else { // gable
    const r0 = W(new THREE.Vector2(C.x - u.x * A, C.y - u.y * A), ridgeY);
    const r1 = W(new THREE.Vector2(C.x + u.x * A, C.y + u.y * A), ridgeY);
    roofFace(roofs, [q0, q1, r1, r0], roofCol, eDir3, sDir3);
    roofFace(roofs, [q2, q3, r0, r1], roofCol, eDir3, sDir3.clone().negate());
    // gable end walls
    for (const s of [-1, 1]) {
      const e0 = pt(s, -1, a / 2, c / 2), e1 = pt(s, 1, a / 2, c / 2);
      const apex = W(new THREE.Vector2(C.x + u.x * s * a / 2, C.y + u.y * s * a / 2), ridgeY);
      const nrm = new THREE.Vector3(u.x * s, 0, -u.y * s);
      const wf = (y, uu) => [uu, y - floorY, c, -(ridgeY - floorY)];
      walls.tri(W(e0, wallTop), W(e1, wallTop), apex, nrm, wallCol, null, [wf(wallTop, 0), wf(wallTop, c), wf(ridgeY, c / 2)]);
    }
  }
}

function flatRoof(pts, topY, col, roofs) {
  const contour = pts.map((q) => new THREE.Vector2(q[0], q[1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const up = new THREE.Vector3(0, 1, 0);
  const e = new THREE.Vector3(1, 0, 0), s = new THREE.Vector3(0, 0, 1);
  for (const [i, j, k] of tris) {
    const V = (q) => new THREE.Vector3(q[0], topY, -q[1]);
    const a = V(pts[i]), b = V(pts[j]), c = V(pts[k]);
    roofs.tri(a, b, c, up, col, [[a.x, a.z], [b.x, b.z], [c.x, c.z]]);
  }
}

export function buildBuildings(list, heightAt, { chunkSize = 1100 } = {}) {
  const chunks = new Map();
  const get = (x, y) => {
    const key = `${Math.floor(x / chunkSize)},${Math.floor(y / chunkSize)}`;
    if (!chunks.has(key)) chunks.set(key, { walls: new Bucket(), metal: new Bucket(), flat: new Bucket() });
    return chunks.get(key);
  };
  const roofC = new THREE.Color(), wallC = new THREE.Color();
  const labels = [];
  for (const b of list) {
    const pts = [];
    for (let i = 0; i < b.p.length; i += 2) pts.push([b.p[i], b.p[i + 1]]);
    if (pts.length < 3) continue;
    let cx = 0, cy = 0;
    for (const q of pts) { cx += q[0]; cy += q[1]; }
    cx /= pts.length; cy /= pts.length;
    const gh = pts.map((q) => heightAt(q[0], q[1]) - ELEV0);
    const floorY = Math.max(...gh, heightAt(cx, cy) - ELEV0) + 0.25;
    const wallTop = floorY + b.h;
    roofC.set(b.rc).multiplyScalar(0.94);
    wallC.set(b.wc);
    const ch = get(cx, cy);
    const windows = b.h >= 2.9;
    if (b.roof === 'flat') {
      addWalls(ch.walls, pts, gh, floorY, wallTop, wallC, windows, 0.35);
      flatRoof(pts, wallTop, roofC, ch.flat);
    } else {
      addWalls(ch.walls, pts, gh, floorY, wallTop, wallC, windows);
      pitchedRoof(b, pts, wallTop, roofC, wallC, ch.metal, ch.walls, floorY);
    }
    if (b.name) labels.push({ name: b.name, x: cx, y: cy, top: wallTop + ELEV0 + 6 });
  }

  const group = new THREE.Group();
  const wallsM = wallMaterial();
  const metalM = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.58, metalness: 0.18, side: THREE.DoubleSide,
    normalMap: corrugationNormalMap(), normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const flatM = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  for (const ch of chunks.values()) {
    for (const [bucket, mat] of [[ch.walls, wallsM], [ch.metal, metalM], [ch.flat, flatM]]) {
      const g = bucket.geometry();
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
  }
  return { group, labels };
}
