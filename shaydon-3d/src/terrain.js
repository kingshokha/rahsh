// Terrain meshes: a detailed 10 m grid for the town (split into chunks that
// each get their own high-resolution aerial texture) and a 60 m regional grid
// for the surrounding Kurama mountains and the Fergana valley.
import * as THREE from 'three';
import { ELEV0 } from './geo.js';
import { tileWindow, composeTexture } from './imagery.js';

// Fine-scale noise so the ground keeps some texture when the camera is close.
function detailTexture() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s);
  const rnd = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const vnoise = (x, y, p) => { // tileable value noise, period p
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (a, b) => rnd(((a % p) + p) % p, ((b % p) + p) % p);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  };
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let n = 0, amp = 0.5, f = 8;
      for (let o = 0; o < 5; o++) { n += amp * vnoise(x / s * f, y / s * f, f); amp *= 0.5; f *= 2; }
      const g = Math.round(n * 255);
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

let DETAIL;

function groundMaterial(map, detail = true) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.96, metalness: 0 });
  if (detail) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.detailMap = { value: DETAIL };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float camD = length(vWPos - cameraPosition);
          float d1 = texture2D(detailMap, vWPos.xz * 0.11).r;
          float d2 = texture2D(detailMap, vWPos.xz * 0.023).r;
          float fade = 1.0 - smoothstep(150.0, 1400.0, camD);
          diffuseColor.rgb *= mix(1.0, 0.78 + 0.44 * (d1 * 0.65 + d2 * 0.35), fade);
          // gravel / dust grain right next to the camera
          float g0 = texture2D(detailMap, vWPos.xz * 0.9).r, g1 = texture2D(detailMap, vWPos.xz * 3.1).r;
          float nearF = 1.0 - smoothstep(15.0, 140.0, camD);
          diffuseColor.rgb *= mix(1.0, 0.7 + 0.6 * (g0 * 0.55 + g1 * 0.45), nearF);`);
    };
    m.customProgramCacheKey = () => 'ground-detail';
  }
  return m;
}

function gridNormals(hf, i0, j0, nx, ny, step = 1) {
  const n = new Float32Array(nx * ny * 3);
  const sx = 2 * hf.dx * step, sy = 2 * hf.dy * step;
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const gi = i0 + i * step, gj = j0 + j * step;
      const dzdx = (hf.at(gi + step, gj) - hf.at(gi - step, gj)) / sx;
      const dzdn = (hf.at(gi, gj - step) - hf.at(gi, gj + step)) / sy; // north is -j
      // world: X east, Z south => dZ = -dN
      const v = new THREE.Vector3(-dzdx, 1, dzdn).normalize();
      n[k++] = v.x; n[k++] = v.y; n[k++] = v.z;
    }
  }
  return n;
}

/** Build an indexed grid mesh geometry from a height-field window. */
function gridGeometry(hf, i0, j0, nx, ny, { step = 1, heightFn = null, skirt = 0 } = {}) {
  const pos = new Float32Array(nx * ny * 3);
  const loc = new Float32Array(nx * ny * 2);
  let k = 0, l = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const gi = i0 + i * step, gj = j0 + j * step;
      const x = hf.x0 + gi * hf.dx, y = hf.y1 - gj * hf.dy;
      const h = heightFn ? heightFn(x, y, hf.at(gi, gj)) : hf.at(gi, gj);
      pos[k++] = x; pos[k++] = h - ELEV0; pos[k++] = -y;
      loc[l++] = x; loc[l++] = y;
    }
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  let positions = pos, normals = gridNormals(hf, i0, j0, nx, ny, step), locals = loc;
  if (skirt > 0) {
    // Hanging skirts along the border hide cracks against the regional mesh.
    const border = [];
    for (let i = 0; i < nx; i++) border.push(i);
    for (let j = 1; j < ny; j++) border.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) border.push((ny - 1) * nx + i);
    for (let j = ny - 2; j >= 0; j--) border.push(j * nx);
    const base = nx * ny, P = Array.from(pos), N = Array.from(normals), Lc = Array.from(loc);
    border.forEach((v) => {
      P.push(pos[v * 3], pos[v * 3 + 1] - skirt, pos[v * 3 + 2]);
      N.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      Lc.push(loc[v * 2], loc[v * 2 + 1]);
    });
    for (let s = 0; s < border.length - 1; s++) {
      const a = border[s], b = border[s + 1], c = base + s, d = base + s + 1;
      idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings: always visible
    }
    positions = new Float32Array(P); normals = new Float32Array(N); locals = new Float32Array(Lc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(locals.length), 2));
  g.userData.local = locals;
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function setUVs(geometry, win) {
  const loc = geometry.userData.local, uv = geometry.attributes.uv.array;
  for (let i = 0; i < loc.length; i += 2) {
    const [u, v] = win.uvOf(loc[i], loc[i + 1]);
    uv[i] = u; uv[i + 1] = v;
  }
  geometry.attributes.uv.needsUpdate = true;
}

export class Terrain {
  constructor(scene, renderer, cityHF, regionHF, loader) {
    this.scene = scene;
    this.renderer = renderer;
    this.city = cityHF;
    this.region = regionHF;
    this.loader = loader;
    this.chunks = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    DETAIL = DETAIL || detailTexture();
  }

  build(chunksX = 4, chunksY = 4) {
    const hf = this.city;
    const ci = Math.ceil((hf.nx - 1) / chunksX), cj = Math.ceil((hf.ny - 1) / chunksY);
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const i0 = cx * ci, j0 = cy * cj;
        const nx = Math.min(ci, hf.nx - 1 - i0) + 1, ny = Math.min(cj, hf.ny - 1 - j0) + 1;
        const g = gridGeometry(hf, i0, j0, nx, ny, { skirt: 25 });
        const mesh = new THREE.Mesh(g, groundMaterial(null));
        mesh.receiveShadow = true;
        mesh.userData.terrain = true;
        const rect = {
          x0: hf.x0 + i0 * hf.dx, x1: hf.x0 + (i0 + nx - 1) * hf.dx,
          y1: hf.y1 - j0 * hf.dy, y0: hf.y1 - (j0 + ny - 1) * hf.dy,
        };
        mesh.userData.rect = rect;
        mesh.userData.level = 0;
        this.group.add(mesh);
        this.chunks.push(mesh);
      }
    }
    // Regional terrain; dips under the town so the detailed chunks win.
    // Triangles fully inside the town are dropped; border triangles take the
    // town's heights (minus a little) so the two meshes meet without a step.
    const r = this.region, c = this.city;
    const geo = gridGeometry(r, 0, 0, r.nx, r.ny, {
      heightFn: (x, y, h) => (c.inside(x, y) ? c.sample(x, y) - 1.5 : h),
    });
    const loc = geo.userData.local, idx = geo.index.array, keep = [];
    const inner = (v) => c.inside(loc[v * 2], loc[v * 2 + 1], 2);
    for (let t = 0; t < idx.length; t += 3) {
      if (inner(idx[t]) && inner(idx[t + 1]) && inner(idx[t + 2])) continue;
      keep.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    geo.setIndex(keep);
    // Far valley floor beyond the regional grid, lost in the haze.
    // sit it at the low end of the regional border so it never covers the town
    const edge = [];
    for (let i = 0; i < r.nx; i++) edge.push(r.at(i, 0), r.at(i, r.ny - 1));
    for (let j = 0; j < r.ny; j++) edge.push(r.at(0, j), r.at(r.nx - 1, j));
    edge.sort((a, b) => a - b);
    const floorH = Math.min(edge[Math.floor(edge.length * 0.1)], c.min) - 6;
    const far = new THREE.Mesh(new THREE.CircleGeometry(160000, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#8f8a6c', roughness: 1 }));
    far.position.set((r.x0 + r.x1) / 2, floorH - ELEV0, -(r.y0 + r.y1) / 2);
    this.group.add(far);

    this.regionMesh = new THREE.Mesh(geo, groundMaterial(null, false));
    this.regionMesh.receiveShadow = true;
    this.regionMesh.userData.terrain = true;
    this.group.add(this.regionMesh);
  }

  /** Low-resolution imagery for everything, then refine near the camera. */
  async loadBaseImagery(onStep) {
    const all = { x0: this.city.x0, x1: this.city.x1, y0: this.city.y0, y1: this.city.y1 };
    const reg = { x0: this.region.x0, x1: this.region.x1, y0: this.region.y0, y1: this.region.y1 };
    const cityWin = tileWindow(all, 15), regWin = tileWindow(reg, 12);
    const [cityTex, regTex] = await Promise.all([
      composeTexture(cityWin, this.loader, this.renderer, -10).then((t) => { onStep?.(); return t; }),
      composeTexture(regWin, this.loader, this.renderer, -9).then((t) => { onStep?.(); return t; }),
    ]);
    for (const ch of this.chunks) {
      if (!cityTex) break;
      setUVs(ch.geometry, cityWin);
      ch.material.map = cityTex;
      ch.material.needsUpdate = true;
    }
    if (regTex) {
      setUVs(this.regionMesh.geometry, regWin);
      this.regionMesh.material.map = regTex;
      this.regionMesh.material.needsUpdate = true;
    }
  }

  /** Progressive refinement: z17 (~0.9 m/px) per town chunk, z13 for the region. */
  async refine(getFocus, zoom = 17) {
    const pending = [...this.chunks];
    const workers = [];
    const next = () => {
      if (!pending.length) return null;
      const f = getFocus();
      pending.sort((a, b) => {
        const ra = a.userData.rect, rb = b.userData.rect;
        const da = Math.hypot((ra.x0 + ra.x1) / 2 - f.x, (ra.y0 + ra.y1) / 2 - f.y);
        const db = Math.hypot((rb.x0 + rb.x1) / 2 - f.x, (rb.y0 + rb.y1) / 2 - f.y);
        return da - db;
      });
      return pending.shift();
    };
    const work = async () => {
      for (let ch = next(); ch; ch = next()) {
        const win = tileWindow(ch.userData.rect, zoom);
        const tex = await composeTexture(win, this.loader, this.renderer, 0);
        if (!tex) continue;
        setUVs(ch.geometry, win);
        ch.material.map = tex;
        ch.material.needsUpdate = true;
        ch.userData.level = zoom;
      }
    };
    for (let w = 0; w < 2; w++) workers.push(work());
    const reg = { x0: this.region.x0, x1: this.region.x1, y0: this.region.y0, y1: this.region.y1 };
    const regWin = tileWindow(reg, 13);
    workers.push(composeTexture(regWin, this.loader, this.renderer, 5).then((tex) => {
      if (!tex) return;
      setUVs(this.regionMesh.geometry, regWin);
      this.regionMesh.material.map?.dispose();
      this.regionMesh.material.map = tex;
    }));
    await Promise.all(workers);
  }
}
