// Free-roam driving over the city model: a car, a chase camera, nothing else.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

import { initGeo, loadHeightField, makeHeightAt, ELEV0 } from './geo.js';
import { TileLoader, loadBakedManifest } from './imagery.js';
import { Terrain } from './terrain.js';
import { buildBuildings } from './buildings.js';
import { buildTrees } from './trees.js';
import { buildFeatures } from './features.js';
import { buildCarModel, buildingIndex, Car } from './car.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const CITY = (params.get('city') || window.CITY || 'shaydon').replace(/[^a-z0-9-]/g, '');
const DATA = `data/${CITY}/`;
const isPhone = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
const CAPTURE = params.has('capture');

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: CAPTURE });
renderer.setPixelRatio(Math.min(devicePixelRatio, isPhone ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 160000);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ sky & sun
const sky = new Sky();
sky.scale.setScalar(140000);
scene.add(sky);
const su = sky.material.uniforms;
Object.assign(su.turbidity, { value: 4.5 }); su.rayleigh.value = 1.25; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(isPhone ? 1024 : 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 10, far: 6000 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd4ea, 0x8a7a62, 0.55);
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xbfcbd4, 0.00003);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.scale.setScalar(1000);
envScene.add(envSky);
let envRT = null;
scene.environmentIntensity = 0.55;

const sunDir = new THREE.Vector3();
let LAT = 40.666, LON = 70.359, sunEl = 1;
function setTime(hours) {
  const day = 172, lat = THREE.MathUtils.degToRad(LAT);
  const decl = THREE.MathUtils.degToRad(23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365));
  const tzMeridian = Math.round(LON / 15) * 15;
  const H = THREE.MathUtils.degToRad(15 * (hours - (12 - (LON - tzMeridian) / 15)));
  const el = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
  const e = Math.max(el, -0.05);
  sunEl = e;
  sunDir.set(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e)).normalize();
  su.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) envSky.material.uniforms[k].value = su[k].value;
  const low = 1 - THREE.MathUtils.smoothstep(e, 0.02, 0.45);
  sun.color.setRGB(1, 1 - 0.35 * low, 1 - 0.62 * low);
  sun.intensity = 3.4 * THREE.MathUtils.smoothstep(e, -0.03, 0.12);
  hemi.intensity = 0.12 + 0.45 * THREE.MathUtils.smoothstep(e, -0.05, 0.3);
  scene.fog.color.set(0xc4d0d9).lerp(new THREE.Color(0xd9b896), low * 0.8)
    .multiplyScalar(0.3 + 0.7 * THREE.MathUtils.smoothstep(e, -0.06, 0.15));
  renderer.toneMappingExposure = 0.5 + 0.18 * THREE.MathUtils.smoothstep(e, 0, 0.6) + 0.35 * (1 - THREE.MathUtils.smoothstep(e, -0.05, 0.15));
  envRT?.dispose();
  envRT = pmrem.fromScene(envScene, 0, 1, 10000);
  scene.environment = envRT.texture;
  const hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
  $('#timeval').textContent = `${hh}:${String(mm).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ input
const keys = new Set();
const touch = { up: false, down: false, left: false, right: false };
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyC') nextCamera();
  if (e.code === 'KeyR') respawn();
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('[data-touch]').forEach((b) => {
  const k = b.dataset.touch;
  const on = (e) => { e.preventDefault(); touch[k] = true; b.classList.add('down'); b.setPointerCapture?.(e.pointerId); };
  const off = (e) => { e.preventDefault(); touch[k] = false; b.classList.remove('down'); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('lostpointercapture', off);
});
if (isPhone) document.body.classList.add('touch');
function readInput() {
  const k = (...c) => c.some((x) => keys.has(x));
  return {
    throttle: (k('ArrowUp', 'KeyW') || touch.up ? 1 : 0) - (k('ArrowDown', 'KeyS') || touch.down ? 1 : 0),
    steer: (k('ArrowRight', 'KeyD') || touch.right ? 1 : 0) - (k('ArrowLeft', 'KeyA') || touch.left ? 1 : 0),
    brake: k('Space'),
  };
}

// ------------------------------------------------------------------ camera
const CAMS = [
  { name: 'Сзади', back: 7.5, up: 2.6, look: 1.3 },
  { name: 'Дальше', back: 16, up: 6.5, look: 1.0 },
  { name: 'Сверху', back: 30, up: 34, look: 0 },
  { name: 'Из салона', back: -0.35, up: 1.25, look: 1.15, inside: true },
];
let camIdx = 0;
function nextCamera() {
  camIdx = (camIdx + 1) % CAMS.length;
  $('#cam').textContent = `Камера: ${CAMS[camIdx].name}`;
  if (car) car.m.group.visible = !CAMS[camIdx].inside;
  snapCam = true;
}
$('#cam').addEventListener('click', nextCamera);
$('#reset').addEventListener('click', () => respawn());
$('#time').addEventListener('input', (e) => setTime(+e.target.value));

// ------------------------------------------------------------------ world
let car, heightAt, trees, terrain, start, snapCam = true;

function startPose(features, vc) {
  const spot = (vc.views || []).find((v) => v.street) || { street: [0, 0], look: 'N' };
  let best = null;
  for (const pts of features.mainRoads) {
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - spot.street[0], pts[i].y - spot.street[1]);
      if (!best || d < best.d) best = { d, pts, i };
    }
  }
  if (!best) return { x: spot.street[0], y: spot.street[1], heading: 0 };
  const { pts, i } = best;
  const a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)];
  const L = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] }[spot.look] || [0, 1];
  const ahead = (a.x - pts[i].x) * L[0] + (a.y - pts[i].y) * L[1] > (b.x - pts[i].x) * L[0] + (b.y - pts[i].y) * L[1] ? a : b;
  const heading = Math.atan2(ahead.x - pts[i].x, ahead.y - pts[i].y);
  // keep right: 1.8 m to the right of the centre line
  return { x: pts[i].x + Math.cos(heading) * 1.8, y: pts[i].y - Math.sin(heading) * 1.8, heading };
}
function respawn() {
  if (!car) return;
  car.reset(start.x, start.y, start.heading);
  snapCam = true;
}

async function boot() {
  const [city, treeBuf] = await Promise.all([
    fetch(DATA + 'city.json').then((r) => r.json()),
    fetch(DATA + (window.TREES_TXT ? 'trees.txt' : 'trees.bin')).then((r) =>
      window.TREES_TXT ? r.text().then((t) => Uint8Array.from(atob(t.trim()), (c) => c.charCodeAt(0)).buffer) : r.arrayBuffer()),
  ]);
  initGeo(city.meta);
  LAT = city.meta.origin.lat; LON = city.meta.origin.lon;
  const vc = city.meta.viewer || {};
  if (vc.title) { $('#title b').textContent = vc.title; document.title = `${vc.title}: поездка`; }
  $('#attrib').textContent = city.meta.attribution.join(' · ');
  $('#status').textContent = 'Рельеф…';
  const [cityHF, regionHF] = await Promise.all([
    loadHeightField(DATA + city.meta.terrainCity.file, city.meta.terrainCity),
    loadHeightField(DATA + city.meta.terrainRegion.file, city.meta.terrainRegion),
  ]);
  heightAt = makeHeightAt(cityHF, regionHF);

  await loadBakedManifest(DATA + 'imagery.json');
  const loader = new TileLoader(14);
  terrain = new Terrain(scene, renderer, cityHF, regionHF, loader);
  terrain.build(4, 4);
  $('#status').textContent = 'Дома и деревья…';
  await new Promise(requestAnimationFrame);
  const list = isPhone ? city.buildings.filter((x) => x.h > 2.95 || x.p.length > 8) : city.buildings;
  scene.add(buildBuildings(list, heightAt).group);
  trees = buildTrees(treeBuf, heightAt, { stride: isPhone && treeBuf.byteLength > 12 * 60000 ? 2 : 1 });
  scene.add(trees.group);
  const features = buildFeatures(city, heightAt, { allRoads: true });
  scene.add(features.group);

  const model = buildCarModel(params.get('color') || '#c62f2a');
  scene.add(model.group);
  const m = 25;
  car = new Car(model, heightAt, buildingIndex(city.buildings),
    { x0: cityHF.x0 + m, x1: cityHF.x1 - m, y0: cityHF.y0 + m, y1: cityHF.y1 - m });
  start = startPose(features, vc);
  if (CAPTURE) { window.__car = car; window.__buildings = city.buildings; }
  respawn();
  setTime(+$('#time').value);
  if (params.has('t')) { $('#time').value = params.get('t'); setTime(+params.get('t')); }

  $('#status').textContent = 'Снимки…';
  await terrain.loadBaseImagery();
  $('#loader').classList.add('done');
  window.__ready = true;
  const zoom = renderer.capabilities.maxTextureSize >= 4096 && !isPhone ? 17 : 16;
  terrain.refine(() => ({ x: car.x, y: car.y }), zoom).then(() => { window.__refined = true; });
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3();
let lodTimer = 0;
function step(dt) {
  if (!car) { renderer.render(scene, camera); return; }
  car.update(dt, readInput());
  const fwd = new THREE.Vector3(Math.sin(car.heading), 0, -Math.cos(car.heading));
  const p = car.m.group.position;
  const c = CAMS[camIdx];
  const want = tmp.copy(p).addScaledVector(fwd, -c.back);
  want.y += c.up;
  const ground = heightAt(want.x, -want.z) - ELEV0 + 1.2;
  if (want.y < ground) want.y = ground;
  const look = new THREE.Vector3().copy(p).addScaledVector(fwd, c.inside ? 30 : 4);
  look.y += c.look;
  const k = snapCam || c.inside ? 1 : 1 - Math.exp(-dt * 5);
  camPos.lerp(want, k);
  camLook.lerp(look, k);
  if (snapCam) { camPos.copy(want); camLook.copy(look); snapCam = false; }
  camera.position.copy(camPos);
  if (c.inside) { camera.position.copy(p).addScaledVector(fwd, 0.35); camera.position.y += c.up; }
  camera.lookAt(camLook);
  camera.near = c.inside ? 0.15 : 0.3;
  camera.updateProjectionMatrix();

  // shadows follow the car; headlights at dusk
  const texel = 220 / sun.shadow.mapSize.x;
  sun.target.position.set(Math.round(p.x / texel) * texel, p.y, Math.round(p.z / texel) * texel);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 3000);
  car.m.beam.intensity = sunEl < 0.12 ? 60 : 0;
  car.m.head.emissiveIntensity = sunEl < 0.12 ? 3 : 0.4;
  const braking = readInput().throttle < 0 && car.v > 0.5;
  car.m.tail.emissiveIntensity = braking ? 3 : sunEl < 0.12 ? 1.2 : 0.35;

  if (trees) {
    trees.uniforms.uTime.value += dt;
    if ((lodTimer -= dt) <= 0) { trees.updateLOD(camera); lodTimer = 0.3; }
  }
  $('#speed b').textContent = Math.round(Math.abs(car.v) * 3.6);
  renderer.render(scene, camera);
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!CAPTURE) step(dt);
}
// automated screenshots: drive scripted steps, then render
window.__drive = (seconds, input) => {
  const n = Math.round(seconds * 30);
  for (let i = 0; i < n; i++) {
    if (input) { keys.clear(); for (const c of input) keys.add(c); }
    car.update(1 / 30, readInput());
  }
  keys.clear();
  snapCam = true;
  step(1 / 30);
};
boot().catch((e) => { console.error(e); $('#status').textContent = `Ошибка: ${e.message}`; });
frame();
