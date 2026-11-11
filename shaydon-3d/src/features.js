// Draped line features: asphalt main roads, irrigation canals, the Ashtsoy
// stream and the utility poles that line the main road.
import * as THREE from 'three';
import { ELEV0 } from './geo.js';

function resample(flat, step) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], flat[i + 1]));
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = a.distanceTo(b), n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push(new THREE.Vector2().lerpVectors(a, b, k / n));
  }
  return out;
}

/** Ribbon geometry that follows the terrain. u across (0..1), v along (metres). */
export function ribbon(flat, width, heightAt, lift = 0.25, step = 4) {
  const pts = resample(flat, step);
  if (pts.length < 2) return null;
  const pos = [], uv = [], idx = [];
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    const t = new THREE.Vector2().subVectors(next, prev).normalize();
    const n = new THREE.Vector2(-t.y, t.x).multiplyScalar(width / 2);
    if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
    for (const s of [-1, 1]) {
      const x = pts[i].x + n.x * s, y = pts[i].y + n.y * s;
      const hc = heightAt(pts[i].x, pts[i].y), he = heightAt(x, y);
      pos.push(x, Math.max(hc, he) - ELEV0 + lift, -y);
      uv.push(s < 0 ? 0 : 1, along);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // counter-clockwise seen from above
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nr = g.attributes.normal;
  for (let i = 0; i < nr.count; i++) if (nr.getY(i) < 0) nr.setXYZ(i, -nr.getX(i), -nr.getY(i), -nr.getZ(i));
  return { geometry: g, points: pts };
}

function asphaltTexture() {
  const w = 128, h = 512, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a4b4c';
  ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // patch repairs, cracks and worn wheel tracks
  for (let k = 0; k < 14; k++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '30,30,32' : '95,92,86'},${0.18 + Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * w * 0.8, Math.random() * h, 10 + Math.random() * 40, 8 + Math.random() * 50);
  }
  ctx.strokeStyle = 'rgba(28,28,28,0.45)';
  ctx.lineWidth = 1;
  for (let k = 0; k < 10; k++) {
    let x = Math.random() * w, y = Math.random() * h;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) { x += (Math.random() - 0.5) * 16; y += Math.random() * 14; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(25,25,25,0.16)';
  for (const x of [0.2, 0.33, 0.67, 0.8]) ctx.fillRect(x * w - 5, 0, 10, h);
  // faded markings: edge lines and dashed centre line (texture spans 12 m)
  ctx.fillStyle = 'rgba(220,218,205,0.32)';
  ctx.fillRect(4, 0, 2, h); ctx.fillRect(w - 6, 0, 2, h);
  ctx.fillStyle = 'rgba(225,222,210,0.5)';
  ctx.fillRect(w / 2 - 1.5, 0, 3, h * 0.4);
  // dusty shoulders
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(150,135,110,0.55)'); grad.addColorStop(0.05, 'rgba(150,135,110,0)');
  grad.addColorStop(0.95, 'rgba(150,135,110,0)'); grad.addColorStop(1, 'rgba(150,135,110,0.55)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 1 / 12);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function waterNormals() {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
  const waves = Array.from({ length: 14 }, (_, i) => ({
    kx: Math.round((Math.random() - 0.5) * 12), ky: Math.round((Math.random() - 0.5) * 12) || 1,
    a: 0.6 / (1 + i * 0.3), p: Math.random() * 6.28,
  }));
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let dx = 0, dy = 0;
      for (const w of waves) {
        const ph = ((w.kx * x + w.ky * y) / s) * Math.PI * 2 + w.p;
        dx += w.a * w.kx * Math.cos(ph) * 0.05; dy += w.a * w.ky * Math.cos(ph) * 0.05;
      }
      const l = Math.hypot(dx, dy, 1), i = (y * s + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function buildFeatures(city, heightAt) {
  const group = new THREE.Group();
  const asphalt = new THREE.MeshStandardMaterial({
    map: asphaltTexture(), roughness: 0.88, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const mainRoads = [];
  for (const r of city.roads) {
    if (r.type !== 'secondary' && r.type !== 'tertiary') continue;
    const rb = ribbon(r.p, r.w, heightAt, 0.22, 4);
    if (!rb) continue;
    const m = new THREE.Mesh(rb.geometry, asphalt);
    m.receiveShadow = true;
    group.add(m);
    mainRoads.push(rb.points);
  }

  const wn = waterNormals();
  wn.repeat.set(0.25, 0.08);
  const water = new THREE.MeshStandardMaterial({
    color: '#2c4a4c', roughness: 0.04, metalness: 0.1, normalMap: wn, normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  for (const w of city.water) {
    const rb = ribbon(w.p, w.w, (x, y) => heightAt(x, y), w.type === 'stream' ? 0.1 : 0.05, 3);
    if (!rb) continue;
    const m = new THREE.Mesh(rb.geometry, water);
    m.receiveShadow = true;
    group.add(m);
  }

  // Concrete utility poles every ~38 m along the main roads.
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.16, 9, 6);
  poleGeo.translate(0, 4.5, 0);
  const armGeo = new THREE.BoxGeometry(1.6, 0.1, 0.1);
  armGeo.translate(0, 8.4, 0);
  const lampGeo = new THREE.BoxGeometry(0.25, 0.12, 0.6);
  lampGeo.translate(0, 7.6, 1.6);
  const spots = [];
  for (const pts of mainRoads) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += pts[i].distanceTo(pts[i - 1]);
      if (acc < 38) continue;
      acc = 0;
      const t = new THREE.Vector2().subVectors(pts[i], pts[i - 1]).normalize();
      const n = new THREE.Vector2(-t.y, t.x);
      spots.push({ x: pts[i].x + n.x * 7, y: pts[i].y + n.y * 7, ang: Math.atan2(n.y, n.x) });
    }
  }
  const concrete = new THREE.MeshStandardMaterial({ color: '#a9a49a', roughness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({ color: '#4c4f52', roughness: 0.5, metalness: 0.6 });
  const poles = new THREE.InstancedMesh(poleGeo, concrete, spots.length);
  const arms = new THREE.InstancedMesh(armGeo, metal, spots.length);
  const lamps = new THREE.InstancedMesh(lampGeo, metal, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  spots.forEach((s, i) => {
    q.setFromAxisAngle(up, s.ang - Math.PI / 2);
    m4.compose(new THREE.Vector3(s.x, heightAt(s.x, s.y) - ELEV0 - 0.3, -s.y), q, s1);
    poles.setMatrixAt(i, m4); arms.setMatrixAt(i, m4); lamps.setMatrixAt(i, m4);
  });
  for (const m of [poles, arms, lamps]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }

  return { group, waterNormals: wn, mainRoads };
}
