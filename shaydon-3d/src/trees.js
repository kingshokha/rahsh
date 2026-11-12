// Trees detected in the aerial imagery, drawn as instanced meshes per spatial
// chunk with two levels of detail.  Kinds: 0 broadleaf (apricot, mulberry,
// walnut), 1 Lombardy poplar, 2 large plane tree / elm (chinar).
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ELEV0, mulberry32 } from './geo.js';

function hash3(x, y, z) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/** Clumpy crown made of displaced spheres, normalised to x,z in [-1,1], y in [y0,1]. */
function crownGeometry({ lumps, detail, y0, shape, seed }) {
  const rnd = mulberry32(seed);
  const parts = [];
  for (let i = 0; i < lumps; i++) {
    let g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const t = lumps === 1 ? 0.5 : i / (lumps - 1);
    let cx, cy, cz, r;
    if (shape === 'cone') {             // spruce: stacked tiers
      cy = 0.06 + t * 0.86; r = (1 - t) * 0.95 + 0.12;
      cx = (rnd() - 0.5) * 0.06; cz = (rnd() - 0.5) * 0.06;
      g.scale(r, 0.2, r);
    } else if (shape === 'column') {    // poplar: narrow spindle
      cy = 0.12 + t * 0.72; r = 0.55 + Math.sin(t * Math.PI) * 0.45;
      const a = rnd() * Math.PI * 2; cx = Math.cos(a) * 0.25; cz = Math.sin(a) * 0.25;
      g.scale(r, 0.22, r);
    } else {
      const a = rnd() * Math.PI * 2, d = i === 0 ? 0 : 0.35 + rnd() * 0.3;
      cx = Math.cos(a) * d; cz = Math.sin(a) * d; cy = 0.5 + (rnd() - 0.4) * 0.35;
      r = i === 0 ? 0.75 : 0.42 + rnd() * 0.22;
      g.scale(r, r * 0.8, r);
    }
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
      const n = 0.72 + 0.5 * hash3(Math.round(x * 7), Math.round(y * 7), Math.round(z * 7) + i * 7);
      pos.setXYZ(k, x * n + cx, y * n + cy, z * n + cz);
      const shade = 0.5 + 0.5 * THREE.MathUtils.clamp((y + cy - 0.15) / 0.85, 0, 1);
      const jitter = 0.85 + 0.3 * hash3(k, i, seed);
      col[k * 3] = shade * jitter; col[k * 3 + 1] = shade * jitter; col[k * 3 + 2] = shade * jitter;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const g = mergeGeometries(parts);
  // normalise into [-1,1] x [y0,1] x [-1,1]
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const sx = 2 / (bb.max.x - bb.min.x), sz = 2 / (bb.max.z - bb.min.z), sy = (1 - y0) / (bb.max.y - bb.min.y);
  g.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
  g.scale(sx, sy, sz);
  g.translate(0, y0, 0);
  g.computeVertexNormals();
  // soften normals towards a sphere: foliage scatters light rather than facets
  const p = g.attributes.position, nn = g.attributes.normal, v = new THREE.Vector3(), s = new THREE.Vector3();
  for (let k = 0; k < p.count; k++) {
    s.set(p.getX(k), (p.getY(k) - (1 + y0) / 2) * 1.6, p.getZ(k)).normalize();
    v.set(nn.getX(k), nn.getY(k), nn.getZ(k)).lerp(s, 0.55).normalize();
    nn.setXYZ(k, v.x, v.y, v.z);
  }
  return g;
}


/** 2x2 atlas of leaf clusters (neutral light green; instances tint it). */
function leafTexture() {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(99);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * 256 + 128, oy = Math.floor(cell / 2) * 256 + 128;
    // twigs
    ctx.strokeStyle = 'rgba(92,74,52,0.9)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.cos(a) * 90, oy + Math.sin(a) * 90); ctx.stroke();
    }
    for (let k = 0; k < 230; k++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.7) * 108;
      const x = ox + Math.cos(a) * d, y = oy + Math.sin(a) * d;
      const L = 9 + rnd() * 9, W = L * (0.42 + rnd() * 0.15);
      const lum = 150 + rnd() * 105, warm = rnd() * 22;
      ctx.fillStyle = `rgb(${Math.round(lum * 0.86 + warm)},${Math.round(lum)},${Math.round(lum * 0.62)})`;
      ctx.save(); ctx.translate(x, y); ctx.rotate(rnd() * Math.PI * 2);
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2, W / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.ellipse(-L * 0.1, -W * 0.12, L / 3, W / 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Crown of randomly oriented leaf-cluster cards with spherical normals. */
function cardGeometry({ count, y0, shape, seed, size }) {
  const rnd = mulberry32(seed);
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const cy = (1 + y0) / 2, hy = (1 - y0) / 2;
  const d = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  const p = new THREE.Vector3(), c = new THREE.Vector3(), sn = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    d.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.lengthSq() < 1e-4) d.set(0, 1, 0);
    d.normalize();
    const rad = 0.4 + 0.6 * Math.sqrt(rnd());
    if (shape === 'cone') {
      const ty = rnd(), prof = (1 - ty) * 0.95 + 0.05;
      c.set(d.x * rad * prof, y0 + ty * (1 - y0), d.z * rad * prof);
    } else if (shape === 'column') {
      const ty = rnd(), prof = Math.sin(Math.min(1, ty * 1.15) * Math.PI) * 0.85 + 0.15;
      c.set(d.x * rad * prof, y0 + ty * (1 - y0), d.z * rad * prof);
    } else {
      c.set(d.x * rad * 0.92, cy + d.y * rad * hy * 0.92, d.z * rad * 0.92);
    }
    n.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().lerp(d, 0.35).normalize();
    t1.set(0, 1, 0).cross(n);
    if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0);
    t1.normalize();
    t2.crossVectors(n, t1).normalize();
    const s = size * (0.75 + rnd() * 0.5);
    const cell = Math.floor(rnd() * 4), u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.copy(c).addScaledVector(t1, a * s).addScaledVector(t2, b * s);
      pos.push(p.x, p.y, p.z);
      sn.set(p.x, (p.y - cy) * (shape === 'column' || shape === 'cone' ? 0.5 : 1.4), p.z).normalize();
      nor.push(sn.x, sn.y, sn.z);
      uv.push(u0 + (a + 1) * 0.25, v0 + (b + 1) * 0.25);
      const h = THREE.MathUtils.clamp((p.y - y0) / (1 - y0), 0, 1);
      const ao = (0.45 + 0.55 * h) * (0.6 + 0.4 * rad);
      col.push(ao, ao, ao);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function trunkGeometry(top, radius) {
  const g = new THREE.CylinderGeometry(radius * 0.7, radius, top, 6, 1, true);
  g.translate(0, top / 2 - 0.02, 0);
  g.deleteAttribute('uv');
  return g;
}

function leafMaterial(uniforms, map = null) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0,
    ...(map ? { map, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide } : {}),
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float sway = sin(uTime * 1.6 + ip.x * 0.11 + ip.z * 0.07) * 0.5 + sin(uTime * 2.7 + ip.z * 0.13) * 0.25;
          transformed.x += sway * 0.035 * transformed.y * transformed.y;
          transformed.z += sway * 0.02 * transformed.y * transformed.y;
        #endif`);
    // a touch of light transmission through leaves when back-lit
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
      `#include <dithering_fragment>
       gl_FragColor.rgb += diffuseColor.rgb * 0.06;`);
  };
  m.customProgramCacheKey = () => (map ? 'leaf-sway-cards' : 'leaf-sway');
  return m;
}

export function buildTrees(buffer, heightAt, { chunkSize = 900, stride = 1 } = {}) {
  const dv = new DataView(buffer);
  const N = buffer.byteLength / 12;
  const uniforms = { uTime: { value: 0 } };

  const kinds = [
    { cards: cardGeometry({ count: 64, y0: 0.32, shape: 'round', seed: 23, size: 0.34 }),
      core: crownGeometry({ lumps: 3, detail: 1, y0: 0.38, shape: 'round', seed: 29 }),
      hi: crownGeometry({ lumps: 6, detail: 2, y0: 0.32, shape: 'round', seed: 3 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.32, shape: 'round', seed: 5 }),
      trunk: trunkGeometry(0.5, 0.07),
      colors: ['#3b5222', '#45592a', '#34491f', '#4d5f2c', '#2f4420', '#57652f', '#3f4f24', '#5a6a34'] },
    { cards: cardGeometry({ count: 56, y0: 0.1, shape: 'column', seed: 31, size: 0.42 }),
      core: crownGeometry({ lumps: 4, detail: 1, y0: 0.14, shape: 'column', seed: 37 }),
      hi: crownGeometry({ lumps: 7, detail: 2, y0: 0.1, shape: 'column', seed: 11 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.1, shape: 'column', seed: 13 }),
      trunk: trunkGeometry(0.3, 0.09),
      colors: ['#33492a', '#3a512c', '#2f4426', '#41582f'] },
    { cards: cardGeometry({ count: 80, y0: 0.3, shape: 'round', seed: 41, size: 0.3 }),
      core: crownGeometry({ lumps: 3, detail: 1, y0: 0.36, shape: 'round', seed: 43 }),
      hi: crownGeometry({ lumps: 8, detail: 2, y0: 0.3, shape: 'round', seed: 17 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.3, shape: 'round', seed: 19 }),
      trunk: trunkGeometry(0.48, 0.06),
      colors: ['#384f22', '#30451e', '#425628'] },
    // 3: Scots pine - tall bare trunk, crown bunched at the top
    { cards: cardGeometry({ count: 60, y0: 0.6, shape: 'round', seed: 47, size: 0.32 }),
      core: crownGeometry({ lumps: 3, detail: 1, y0: 0.64, shape: 'round', seed: 53 }),
      hi: crownGeometry({ lumps: 6, detail: 2, y0: 0.6, shape: 'round', seed: 59 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.6, shape: 'round', seed: 61 }),
      trunk: trunkGeometry(0.75, 0.05), bark: '#8a5a3c',
      colors: ['#2b3d24', '#26381f', '#32452a', '#2d3f2a'] },
    // 4: birch - white trunk, light airy crown
    { cards: cardGeometry({ count: 56, y0: 0.3, shape: 'round', seed: 67, size: 0.3 }),
      core: crownGeometry({ lumps: 2, detail: 1, y0: 0.36, shape: 'round', seed: 71 }),
      hi: crownGeometry({ lumps: 6, detail: 2, y0: 0.3, shape: 'round', seed: 73 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.3, shape: 'round', seed: 79 }),
      trunk: trunkGeometry(0.6, 0.045), bark: '#d9d5cc',
      colors: ['#4f6a2c', '#5a7432', '#48632a', '#617b38'] },
    // 5: spruce - dark cone
    { cards: cardGeometry({ count: 70, y0: 0.08, shape: 'cone', seed: 83, size: 0.3 }),
      core: crownGeometry({ lumps: 5, detail: 1, y0: 0.1, shape: 'cone', seed: 89 }),
      hi: crownGeometry({ lumps: 8, detail: 2, y0: 0.06, shape: 'cone', seed: 97 }),
      lo: crownGeometry({ lumps: 1, detail: 0, y0: 0.1, shape: 'cone', seed: 101 }),
      trunk: trunkGeometry(0.2, 0.06), bark: '#5b4636',
      colors: ['#1f3324', '#233827', '#1c2f21'] },
  ];
  for (const k of kinds) { k.core.scale(0.62, 0.72, 0.62); k.core.translate(0, 0.12, 0); }
  const leafM = leafMaterial(uniforms);
  const leafTex = leafTexture();
  const cardM = leafMaterial(uniforms, leafTex);
  const cardDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.42 });
  const barkM = new THREE.MeshStandardMaterial({ color: '#5a4c3e', roughness: 0.95 });
  const barks = {};
  const barkFor = (c) => (barks[c] ||= new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));

  // bucket per chunk & kind
  const buckets = new Map();
  for (let i = 0; i < N; i += stride) {
    const o = i * 12;
    const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true);
    const r = dv.getUint8(o + 8) / 20, h = dv.getUint8(o + 9) / 8, k = dv.getUint8(o + 10), s = dv.getUint8(o + 11);
    const key = `${Math.floor(x / chunkSize)},${Math.floor(y / chunkSize)},${k}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([x, y, r, h, s]);
  }

  const group = new THREE.Group();
  const chunks = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  for (const [key, list] of buckets) {
    const k = +key.split(',')[2];
    const kind = kinds[k];
    const hi = new THREE.InstancedMesh(kind.hi, leafM, list.length);
    const lo = new THREE.InstancedMesh(kind.lo, leafM, list.length);
    const tr = new THREE.InstancedMesh(kind.trunk, kind.bark ? barkFor(kind.bark) : barkM, list.length);
    const cards = new THREE.InstancedMesh(kind.cards, cardM, list.length);
    const core = new THREE.InstancedMesh(kind.core, leafM, list.length);
    cards.customDepthMaterial = cardDepth;
    cards.userData.noAO = true;
    let cx = 0, cy = 0;
    list.forEach(([x, y, r, h, s], i) => {
      const g = heightAt(x, y) - ELEV0 - 0.3;
      q.setFromAxisAngle(up, (s / 255) * Math.PI * 2);
      const lean = 1 + ((s * 7) % 13) / 60;
      sc.set(r * lean, h, r * (2 - lean));
      m4.compose(p.set(x, g, -y), q, sc);
      hi.setMatrixAt(i, m4); lo.setMatrixAt(i, m4); cards.setMatrixAt(i, m4); core.setMatrixAt(i, m4);
      sc.set(Math.max(r, 2.2), h, Math.max(r, 2.2));
      m4.compose(p, q, sc);
      tr.setMatrixAt(i, m4);
      col.set(kind.colors[s % kind.colors.length]).multiplyScalar(0.8 + ((s * 13) % 29) / 70);
      hi.setColorAt(i, col); lo.setColorAt(i, col); cards.setColorAt(i, col);
      core.setColorAt(i, col.multiplyScalar(0.55));
      cx += x; cy += y;
    });
    for (const m of [hi, lo, tr, cards, core]) {
      m.castShadow = true; m.receiveShadow = true;
      m.computeBoundingSphere();
      group.add(m);
    }
    lo.receiveShadow = false;
    chunks.push({ hi, lo, tr, cards, core, cx: cx / list.length, cy: cy / list.length, z: heightAt(cx / list.length, cy / list.length) - ELEV0 });
  }

  const v = new THREE.Vector3();
  function updateLOD(camera) {
    for (const c of chunks) {
      const d = camera.position.distanceTo(v.set(c.cx, c.z, -c.cy));
      const close = d < 650, near = d < 1500;
      c.cards.visible = c.core.visible = close;
      c.hi.visible = near && !close;
      c.lo.visible = !near;
      c.tr.visible = d < 1300;
      c.lo.castShadow = d < 2500;
    }
  }
  return { group, uniforms, updateLOD, count: N };
}
