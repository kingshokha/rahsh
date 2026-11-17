// A small hatchback and simple arcade driving physics.
// Model space: forward is -Z, up is +Y, origin on the ground between the axles.
import * as THREE from 'three';
import { ELEV0 } from './geo.js';

function extrudeProfile(points, width, bevel) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width, curveSegments: 6,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.75, bevelSegments: 3,
  });
  // shape x (length, + = rear) -> world z ; extrusion -> world x, centred
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

export function buildCarModel(color = '#c8d0d6') {
  const group = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#10161c', metalness: 0.2, roughness: 0.05, clearcoat: 1 });
  const black = new THREE.MeshStandardMaterial({ color: '#16181a', roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#c9ccd0', metalness: 1, roughness: 0.25 });
  const head = new THREE.MeshStandardMaterial({ color: '#f4f4ee', emissive: '#fff6d8', emissiveIntensity: 0.4 });
  const tail = new THREE.MeshStandardMaterial({ color: '#7a0d0d', emissive: '#ff1a10', emissiveIntensity: 0.35 });

  // lower body (up to the window line), side profile: x along the car (front negative), y up
  const body = [
    [2.05, 0.30], [2.14, 0.60], [2.03, 0.99], [1.45, 1.03], [-1.02, 1.03],
    [-1.96, 0.86], [-2.13, 0.62], [-2.05, 0.30],
  ];
  group.add(new THREE.Mesh(extrudeProfile(body, 1.62, 0.09), paint));

  // glass cabin, a little narrower than the body, with a painted roof and pillars
  const cab = [[1.42, 1.02], [0.76, 1.42], [-0.32, 1.45], [-0.98, 1.02]];
  group.add(new THREE.Mesh(extrudeProfile(cab, 1.44, 0.05), glass));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 1.12), paint);
  roof.position.set(0, 1.48, 0.22);
  group.add(roof);
  const pillar = (x0, y0, x1, y1, side) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, len, 0.08), paint);
    p.position.set(side * 0.74, (y0 + y1) / 2, (x0 + x1) / 2);
    p.rotation.x = Math.atan2(x1 - x0, y1 - y0);
    group.add(p);
  };
  for (const sd of [-1, 1]) {
    pillar(-0.98, 1.03, -0.32, 1.46, sd);   // A
    pillar(0.25, 1.03, 0.25, 1.46, sd);     // B
    pillar(1.42, 1.03, 0.76, 1.44, sd);     // C
  }

  // bumpers, grille, mirrors, plates
  const fb = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.2, 0.18), black);
  fb.position.set(0, 0.42, -2.12); group.add(fb);
  const rb = fb.clone(); rb.position.z = 2.12; group.add(rb);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.05), black);
  grille.position.set(0, 0.72, -2.13); group.add(grille);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.1), paint);
    m.position.set(s * 0.92, 1.1, -0.9); group.add(m);
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.06), head);
    hl.position.set(s * 0.58, 0.8, -2.1); group.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), tail);
    tl.position.set(s * 0.62, 0.86, 2.12); group.add(tl);
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.02), new THREE.MeshStandardMaterial({ color: '#f1f1ec' }));
  plate.position.set(0, 0.46, -2.22); group.add(plate);
  const plate2 = plate.clone(); plate2.position.z = 2.22; group.add(plate2);

  // wheels: pivot (steering) > spinner (rolling) > tyre + rim
  const tyreG = new THREE.CylinderGeometry(0.33, 0.33, 0.23, 24).rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.21, 0.21, 0.24, 10).rotateZ(Math.PI / 2);
  const wheels = [];
  for (const [x, z, front] of [[-0.8, -1.28, true], [0.8, -1.28, true], [-0.8, 1.3, false], [0.8, 1.3, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.33, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tyreG, black), new THREE.Mesh(rimG, chrome));
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, front });
  }
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // headlight beam for dusk and night
  const beam = new THREE.SpotLight('#fff3d6', 0, 70, 0.55, 0.5, 1.2);
  beam.position.set(0, 0.85, -2.0);
  beam.target.position.set(0, 0, -20);
  group.add(beam, beam.target);

  return { group, wheels, head, tail, beam };
}

/** Index building footprints so the car can bump into walls. */
export function buildingIndex(buildings, cell = 40) {
  const grid = new Map();
  const polys = buildings.map((b) => {
    const pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < b.p.length; i += 2) {
      const x = b.p[i], y = b.p[i + 1];
      pts.push(x, y);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return { pts, x0, y0, x1, y1 };
  });
  polys.forEach((p, i) => {
    for (let gx = Math.floor(p.x0 / cell); gx <= Math.floor(p.x1 / cell); gx++) {
      for (let gy = Math.floor(p.y0 / cell); gy <= Math.floor(p.y1 / cell); gy++) {
        const k = gx + ',' + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return (x, y) => {
    const list = grid.get(Math.floor(x / cell) + ',' + Math.floor(y / cell));
    if (!list) return false;
    for (const i of list) {
      const p = polys[i];
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue;
      let inside = false;
      const q = p.pts, n = q.length;
      for (let a = 0, b = n - 2; a < n; b = a, a += 2) {
        if ((q[a + 1] > y) !== (q[b + 1] > y) && x < ((q[b] - q[a]) * (y - q[a + 1])) / (q[b + 1] - q[a + 1]) + q[a]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
}

const HALF_L = 2.15, HALF_W = 0.92, WHEELBASE = 2.58, TRACK = 1.6;

export class Car {
  constructor(model, heightAt, blocked, bounds) {
    this.m = model;
    this.heightAt = heightAt;
    this.blocked = blocked;
    this.bounds = bounds;
    this.x = 0; this.y = 0; this.heading = 0; this.v = 0; this.steer = 0;
    this.bump = 0;
  }
  reset(x, y, heading) {
    this.x = x; this.y = y; this.heading = heading; this.v = 0; this.steer = 0;
    this.place(0);
  }
  /** Ground height under a local point, a touch above the road surfaces. */
  ground(x, y) { return this.heightAt(x, y) + 0.2; }
  hits(x, y, h) {
    const fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const b = this.bounds;
    for (const [l, w] of [[HALF_L, HALF_W], [HALF_L, -HALF_W], [-HALF_L, HALF_W], [-HALF_L, -HALF_W], [HALF_L, 0], [0, HALF_W], [0, -HALF_W]]) {
      const px = x + fx * l + rx * w, py = y + fy * l + ry * w;
      if (px < b.x0 || px > b.x1 || py < b.y0 || py > b.y1) return true;
      if (this.blocked(px, py)) return true;
    }
    return false;
  }
  update(dt, input) {
    const { throttle, steer, brake } = input;
    // steering: quicker at low speed, gentler at speed
    const maxSteer = 0.6 / (1 + Math.abs(this.v) / 14);
    this.steer += (steer * maxSteer - this.steer) * Math.min(1, dt * 6);
    // engine, brakes, drag, slope
    if (throttle > 0) this.v += (this.v < 0 ? 14 : 6.5 * (1 - this.v / 26)) * dt;
    else if (throttle < 0) this.v -= (this.v > 0.5 ? 13 : 4) * dt;
    else this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), 1.6 * dt);
    if (brake) this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), 18 * dt);
    this.v -= this.v * Math.abs(this.v) * 0.0018 * dt;
    this.v -= 9.8 * Math.sin(this.pitch || 0) * dt * 0.6;
    this.v = THREE.MathUtils.clamp(this.v, -7, 26);

    const yaw = (this.v / WHEELBASE) * Math.tan(this.steer);
    const h = this.heading + yaw * dt;
    const nx = this.x + Math.sin(h) * this.v * dt, ny = this.y + Math.cos(h) * this.v * dt;
    if (this.hits(nx, ny, h)) {
      this.bump = Math.min(1, Math.abs(this.v) / 8);
      this.v *= -0.25;
    } else {
      this.x = nx; this.y = ny; this.heading = h;
    }
    this.bump = Math.max(0, this.bump - dt * 2);
    this.place(dt);
  }
  place(dt) {
    const fx = Math.sin(this.heading), fy = Math.cos(this.heading), rx = Math.cos(this.heading), ry = -Math.sin(this.heading);
    const g = (l, w) => this.ground(this.x + fx * l + rx * w, this.y + fy * l + ry * w);
    const fl = g(1.29, -0.8), fr = g(1.29, 0.8), bl = g(-1.29, -0.8), br = g(-1.29, 0.8);
    const front = (fl + fr) / 2, back = (bl + br) / 2, left = (fl + bl) / 2, right = (fr + br) / 2;
    this.pitch = Math.atan2(front - back, WHEELBASE);
    const roll = Math.atan2(right - left, TRACK);
    const o = this.m.group;
    o.position.set(this.x, (front + back) / 2 - ELEV0, -this.y);
    o.rotation.set(this.pitch, -this.heading, roll, 'YXZ');
    for (const w of this.m.wheels) {
      w.spin.rotation.x -= (this.v * dt) / 0.33;
      if (w.front) w.pivot.rotation.y = -this.steer;
    }
  }
}
