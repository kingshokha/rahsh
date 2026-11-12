import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { initGeo, loadHeightField, makeHeightAt, ELEV0, world } from './geo.js';
import { TileLoader, loadBakedManifest, hasBaked } from './imagery.js';
import { Terrain } from './terrain.js';
import { buildBuildings } from './buildings.js';
import { buildTrees } from './trees.js';
import { buildFeatures } from './features.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const CITY = (params.get('city') || window.CITY || 'shaydon').replace(/[^a-z0-9-]/g, '');
const DATA = `data/${CITY}/`;
let LAT = 40.666, LON = 70.359; // replaced by the city's origin once loaded

// ------------------------------------------------------------------ loader UI
const steps = { total: 9, done: 0 };
function progress(msg) {
  steps.done++;
  $('#bar i').style.width = `${Math.min(100, (steps.done / steps.total) * 100)}%`;
  if (msg) $('#status').textContent = msg;
}

// ------------------------------------------------------------------ renderer
const app = $('#app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') });
const isPhone = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isPhone ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
app.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 160000);

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 8;
controls.maxDistance = 40000;
controls.zoomToCursor = true;

// ------------------------------------------------------------------ sky & light
const sky = new Sky();
sky.scale.setScalar(140000);
scene.add(sky);
const su = sky.material.uniforms;
su.turbidity.value = 4.5;
su.rayleigh.value = 1.25;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.82;

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(isPhone ? 2048 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
const SH = 650;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 9000 });
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd4ea, 0x8a7a62, 0.55);
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xbfcbd4, 0.000026);

const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.scale.setScalar(1000);
envScene.add(envSky);
let envRT = null;

const sunDir = new THREE.Vector3();
/** Sun position for Shaydon in early summer (the imagery season) at a local clock time (UTC+5). */
function solar(hours, day = 172) {
  const lat = THREE.MathUtils.degToRad(LAT);
  const decl = THREE.MathUtils.degToRad(23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365));
  const solarNoon = 12 - (LON - 75) / 15; // UTC+5 zone meridian is 75°E
  const H = THREE.MathUtils.degToRad(15 * (hours - solarNoon));
  const el = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
  return { el, az };
}

const fogDay = new THREE.Color(0xc4d0d9), fogLow = new THREE.Color(0xd9b896), sunCol = new THREE.Color();
let envTimer = 0;
function setTime(hours) {
  const { el, az } = solar(hours);
  const e = Math.max(el, -0.05);
  sunDir.set(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e)).normalize();
  su.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) envSky.material.uniforms[k].value = su[k].value;
  const low = 1 - THREE.MathUtils.smoothstep(e, 0.02, 0.45);
  sunCol.setRGB(1, 1 - 0.35 * low, 1 - 0.62 * low);
  sun.color.copy(sunCol);
  sun.intensity = 3.4 * THREE.MathUtils.smoothstep(e, -0.03, 0.12);
  hemi.intensity = 0.15 + 0.45 * THREE.MathUtils.smoothstep(e, -0.05, 0.3);
  scene.fog.color.copy(fogDay).lerp(fogLow, low * 0.8).multiplyScalar(0.35 + 0.65 * THREE.MathUtils.smoothstep(e, -0.06, 0.15));
  renderer.toneMappingExposure = 0.5 + 0.18 * THREE.MathUtils.smoothstep(e, 0.0, 0.6) + 0.35 * (1 - THREE.MathUtils.smoothstep(e, -0.05, 0.15));
  clearTimeout(envTimer);
  envTimer = setTimeout(() => {
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0, 1, 10000);
    scene.environment = envRT.texture;
  }, 60);
  const hh = Math.floor(hours), mm = Math.round((hours - hh) * 60);
  $('#timeval').textContent = `${hh}:${String(mm).padStart(2, '0')}`;
}
scene.environmentIntensity = 0.55;

// ------------------------------------------------------------------ post
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
// alpha-tested leaf cards would show up as solid quads in the AO normal pass
const baseOverride = gtao.overrideVisibility.bind(gtao);
gtao.overrideVisibility = () => { baseOverride(); scene.traverse((o) => { if (o.userData.noAO) o.visible = false; }); };
gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.4, thickness: 4, scale: 1.0, samples: 12 });
gtao.blendIntensity = 0.85;
composer.addPass(gtao);
composer.addPass(new OutputPass());
const lowPower = isPhone;
gtao.enabled = !lowPower && !params.has('noao');

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ world
let heightAt = () => ELEV0;
let terrain, trees, features, buildings;
const labelGroup = new THREE.Group();
scene.add(labelGroup);

function addLabel(text, sub, x, y, h, cls = '') {
  const el = document.createElement('div');
  el.className = `label ${cls}`;
  el.innerHTML = sub ? `${text}<small>${sub}</small>` : text;
  const o = new CSS2DObject(el);
  o.position.copy(world(x, y, h));
  labelGroup.add(o);
}

// ------------------------------------------------------------------ camera views
let VIEWS = {};

let flight = null;
function flyTo(target, from, dur = 2.6) {
  flight = {
    t0: performance.now(), dur: dur * 1000,
    fromPos: camera.position.clone(), fromTgt: controls.target.clone(),
    toPos: from, toTgt: target,
  };
}

const LOOK = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
function viewVectors(name) {
  const v = VIEWS[name] || Object.values(VIEWS)[0];
  if (v.street && features?.mainRoads.length) {
    // stand in the right-hand lane of the nearest main road, looking along it
    let best = null;
    for (const pts of features.mainRoads) {
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - v.street[0], pts[i].y - v.street[1]);
        if (!best || d < best.d) best = { d, pts, i };
      }
    }
    const { pts, i } = best;
    const a = pts[Math.max(0, i - 15)], b = pts[Math.min(pts.length - 1, i + 15)];
    const [lx, ly] = LOOK[v.look] || LOOK.N;
    const p = pts[i];
    const score = (q) => (q.x - p.x) * lx + (q.y - p.y) * ly;
    const ahead = score(a) > score(b) ? a : b;
    const dir = new THREE.Vector2().subVectors(ahead, p).normalize();
    const side = new THREE.Vector2(dir.y, -dir.x).multiplyScalar(1.8);
    const cx = p.x + side.x, cy = p.y + side.y;
    const tx = cx + dir.x * 80, ty = cy + dir.y * 80;
    return { from: world(cx, cy, heightAt(cx, cy) + 1.7), target: world(tx, ty, heightAt(tx, ty) + 3) };
  }
  const t = world(v.target[0], v.target[1], heightAt(v.target[0], v.target[1]));
  const f = world(v.from[0], v.from[1], heightAt(v.from[0], v.from[1]) + v.up);
  return { from: f, target: t };
}

function buildViewButtons(views) {
  const box = $('#views');
  box.innerHTML = '';
  views.forEach((v, i) => {
    VIEWS[v.id] = v;
    const b = document.createElement('button');
    b.dataset.view = v.id;
    b.textContent = v.label;
    if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      const { from, target } = viewVectors(v.id);
      flyTo(target, from);
    });
    box.appendChild(b);
  });
}

// double-click: fly towards the clicked point
const ray = new THREE.Raycaster();
renderer.domElement.addEventListener('dblclick', (ev) => {
  if (!terrain) return;
  ray.setFromCamera(new THREE.Vector2((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(terrain.group.children, false)[0];
  if (!hit) return;
  const off = new THREE.Vector3().subVectors(camera.position, controls.target);
  off.setLength(Math.max(120, Math.min(off.length() * 0.45, 1500)));
  flyTo(hit.point.clone(), hit.point.clone().add(off), 1.8);
});

// ------------------------------------------------------------------ UI
$('#time').addEventListener('input', (e) => setTime(+e.target.value));
document.querySelectorAll('#toggles button').forEach((b) => b.addEventListener('click', () => {
  b.classList.toggle('on');
  const on = b.classList.contains('on');
  const k = b.dataset.toggle;
  if (k === 'buildings' && buildings) buildings.visible = on;
  if (k === 'trees' && trees) trees.group.visible = on;
  if (k === 'labels') { labelGroup.visible = on; labelRenderer.domElement.style.display = on ? '' : 'none'; }
  if (k === 'ao') gtao.enabled = on;
}));
if (!gtao.enabled) $('[data-toggle="ao"]').classList.remove('on');
$('#compass').addEventListener('click', () => {
  const off = new THREE.Vector3().subVectors(camera.position, controls.target);
  const flat = Math.hypot(off.x, off.z);
  flyTo(controls.target.clone(), controls.target.clone().add(new THREE.Vector3(0, off.y, flat)), 1.2);
});
setTimeout(() => { $('#help').style.opacity = 0; }, 12000);

// ------------------------------------------------------------------ boot
async function boot() {
  $('#status').textContent = 'Данные карты…';
  const [city, treeBuf] = await Promise.all([
    fetch(DATA + 'city.json').then((r) => r.json()),
    fetch(DATA + 'trees.bin').then((r) => r.arrayBuffer()),
  ]);
  progress('Рельеф…');
  initGeo(city.meta);
  const vc = city.meta.viewer || {};
  LAT = city.meta.origin.lat; LON = city.meta.origin.lon;
  if (vc.title) {
    document.title = `${vc.title} 3D`;
    $('#title h1').innerHTML = `${vc.title}<span>${vc.subtitle || ''}</span>`;
    $('#title p').textContent = vc.info || '';
    $('#loader h2').textContent = vc.title;
  }
  buildViewButtons(vc.views || []);
  $('#attrib').innerHTML = city.meta.attribution.join(' · ');
  const [cityHF, regionHF] = await Promise.all([
    loadHeightField(DATA + city.meta.terrainCity.file, city.meta.terrainCity),
    loadHeightField(DATA + city.meta.terrainRegion.file, city.meta.terrainRegion),
  ]);
  heightAt = makeHeightAt(cityHF, regionHF);
  progress('Поверхность…');

  await loadBakedManifest(DATA + 'imagery.json');
  const loader = new TileLoader(14);
  terrain = new Terrain(scene, renderer, cityHF, regionHF, loader);
  terrain.build(4, 4);
  progress('Здания…');
  await new Promise(requestAnimationFrame);

  // phones: drop the smallest outbuildings and half of the trees to save memory
  const list = isPhone ? city.buildings.filter((x) => x.h > 2.95 || x.p.length > 8) : city.buildings;
  const b = buildBuildings(list, heightAt);
  buildings = b.group;
  scene.add(buildings);
  progress('Деревья…');
  await new Promise(requestAnimationFrame);

  trees = buildTrees(treeBuf, heightAt, { stride: isPhone && treeBuf.byteLength > 12 * 60000 ? 2 : 1 });
  scene.add(trees.group);
  features = buildFeatures(city, heightAt);
  scene.add(features.group);
  progress('Подписи…');

  const seen = new Set();
  for (const l of vc.labels || []) {
    seen.add(l.text);
    addLabel(l.text, l.sub || '', l.x, l.y, heightAt(l.x, l.y) + (l.up || 40), l.cls || '');
  }
  if (vc.poiLabels) {
    for (const p of city.pois) {
      if (p.kind === 'town' || p.kind === 'village' || !p.name || seen.has(p.name)) continue;
      seen.add(p.name);
      addLabel(p.name, '', p.x, p.y, heightAt(p.x, p.y) + 30);
    }
  }
  if (vc.buildingLabels) {
    for (const l of b.labels) {
      if ([...seen].some((s) => s.startsWith(l.name) || l.name.startsWith(s))) continue;
      addLabel(l.name, '', l.x, l.y, l.top + 12);
    }
  }

  setTime(+$('#time').value);
  const v = viewVectors(params.get('view') || (vc.views?.[0]?.id ?? 'overview'));
  camera.position.copy(v.from);
  controls.target.copy(v.target);
  if (params.get('view')) document.querySelectorAll('#views button').forEach((x) => x.classList.toggle('active', x.dataset.view === params.get('view')));
  if (params.has('t')) { $('#time').value = params.get('t'); setTime(+params.get('t')); }

  $('#status').textContent = 'Аэрофотоснимки…';
  loader.onProgress = (l) => { $('#status').textContent = `Аэрофотоснимки… ${l.done}/${l.requested}`; };
  await terrain.loadBaseImagery(() => progress());
  progress('Готово');
  $('#loader').classList.add('done');
  window.__ready = true;

  // refine imagery in the background, nearest chunks first
  const pill = $('#tiles');
  pill.classList.remove('hidden');
  loader.onProgress = (l) => { pill.textContent = `Детализация снимков ${l.done}/${l.requested}`; };
  if (hasBaked()) pill.textContent = 'Детализация снимков…';
  const focus = () => ({ x: controls.target.x, y: -controls.target.z });
  const zoom = renderer.capabilities.maxTextureSize >= 4096 && !lowPower ? 17 : 16;
  await terrain.refine(focus, zoom);
  pill.textContent = loader.failed ? `Снимки загружены (${loader.failed} тайлов недоступно)` : 'Снимки загружены';
  setTimeout(() => pill.classList.add('hidden'), 2500);
  window.__refined = true;
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const compassSvg = $('#compass svg');
let lodTimer = 0;
const CAPTURE = params.has('capture');
function frame() {
  requestAnimationFrame(frame);
  const dt = clock.getDelta();
  if (!CAPTURE) render(dt);
}
// capture mode (automated screenshots): render only when asked
window.__render = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) render(dt); };

function render(dt) {
  if (flight) {
    const k = Math.min(1, (performance.now() - flight.t0) / flight.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    // arc upward through the middle of long flights
    const lift = Math.sin(Math.PI * k) * Math.min(1500, flight.fromPos.distanceTo(flight.toPos) * 0.25);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e).y += lift;
    controls.target.lerpVectors(flight.fromTgt, flight.toTgt, e);
    if (k >= 1) flight = null;
  }
  controls.update(dt);

  // keep the camera above ground and the near plane tight for depth precision
  const gx = camera.position.x, gy = -camera.position.z;
  const ground = heightAt(gx, gy) - ELEV0;
  if (camera.position.y < ground + 1.5) camera.position.y = ground + 1.5;
  const agl = camera.position.y - ground;
  camera.near = THREE.MathUtils.clamp(agl * 0.25, 0.4, 150);
  camera.updateProjectionMatrix();

  // shadow frustum follows what the camera looks at
  const dist = camera.position.distanceTo(controls.target);
  const focus = tmp.copy(controls.target);
  const span = THREE.MathUtils.clamp(dist * 0.7, 120, 1400);
  const sc = sun.shadow.camera;
  if (Math.abs(sc.right - span) > 1) {
    Object.assign(sc, { left: -span, right: span, top: span, bottom: -span });
    sc.updateProjectionMatrix();
  }
  const texel = (2 * span) / sun.shadow.mapSize.x;
  focus.x = Math.round(focus.x / texel) * texel;
  focus.z = Math.round(focus.z / texel) * texel;
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDir, 4000);

  if (trees) {
    trees.uniforms.uTime.value += dt;
    if ((lodTimer -= dt) <= 0) { trees.updateLOD(camera); lodTimer = 0.25; }
  }
  if (features) { features.waterNormals.offset.y -= dt * 0.05; features.lakeNormals.offset.x += dt * 0.004; }

  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
  compassSvg.style.transform = `rotate(${THREE.MathUtils.radToDeg(az)}deg)`;

  composer.render();
  labelRenderer.render(scene, camera);
}

boot().catch((e) => {
  console.error(e);
  $('#status').textContent = `Ошибка: ${e.message}`;
});
frame();
