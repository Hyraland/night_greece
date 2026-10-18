// 月光浅滩 · 二分光影: the same walk among the ruins, drawn in two tones (moonlit pale and cyan shade) over
// a flat shallow sea: only the temples, the buildings and the giant laurel; no meadows, hills or other plants.
// Its colours are set in toon-tuning.json.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { MOON_DIR, shared, useFlatGround, GIANT_LAUREL, colliders, gaze, PATH_POINTS, makeRoute } from '../world.js';
import { loadRuins } from '../ruins.js';
import { loadPlants, sprigTexture } from '../vegetation.js';
import { Walker } from '../walker.js';
import { Soundscape } from '../audio.js';
import { loadTuning } from '../tuning.js';
import { TOON_DEFAULTS, makeLook, applyLook, toonMaterial, derivePalette, shadeAlong, placeAlong, rangeGradient, shiftShades } from './look.js';
import { buildToonSky, buildToonWater, buildToonGround, OutlinePass } from './scenery.js';
import { buildFallingLeaves } from './falling.js';
import { settleLooseStones } from './settle.js';

useFlatGround(); // from here on the land is a flat shallow sea

const params = new URLSearchParams(location.search);
const tuning = await loadTuning({ file: 'toon-tuning.json', defaults: TOON_DEFAULTS });

const ui = {
  intro: document.getElementById('intro'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  mode: document.getElementById('mode'),
};
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });
const say = async (msg) => { ui.status.textContent = msg; await nextFrame(); };

// ---------------------------------------------------------------- renderer

const W = () => Math.max(1, innerWidth), H = () => Math.max(1, innerHeight);
const PR = Math.min(devicePixelRatio, 1.5);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(PR);
renderer.setSize(W(), H());
renderer.toneMapping = THREE.NoToneMapping; // the two tones are shown exactly as chosen
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xa6cfd8, 0.0022);
const camera = new THREE.PerspectiveCamera(58, W() / H(), 0.1, 4000);
camera.layers.enable(1);

// The moon only decides lit or shaded here, so it is plain white at unit strength. Its shadows come from two
// maps: a fine one over the few dozen metres just ahead of the viewer (crisp leaf shadows up close) and a
// wide one beyond; the toon material reads the fine one where it reaches (see look.js). The fine one is a
// second light of no strength, added first so that it is shadow map 0.
const shadowLight = (half, ahead, bias, normalBias) => {
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  light.shadow.mapSize.set(4096, 4096);
  light.shadow.autoUpdate = false; // drawn again only when its square moves (see frame)
  Object.assign(light.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 450 });
  Object.assign(light.shadow, { bias, normalBias });
  const texel = (half * 2) / 4096;
  light.userData = { ahead, step: texel * Math.round(1 / texel) }; // about a metre, in whole texels
  scene.add(light, light.target);
  return light;
};
const fineShadow = shadowLight(18, 13, -0.0002, 0.02);
fineShadow.intensity = 0;
const moon = shadowLight(100, 60, -0.0004, 0.06);
const shadowLights = [fineShadow, moon];

// ---------------------------------------------------------------- world

const look = makeLook();

await say('立起神殿的石柱…');
const ruins = await loadRuins({ material: toonMaterial(look, 'stone', { ao: true }) });
settleLooseStones(ruins); // the pieces that lay on the hills come down to the water
scene.add(ruins);
await say('铺开水面…');
scene.add(buildToonGround(look));

await say('种下月桂…');
const plants = await loadPlants();
const giant = plants.trees.find((t) => t.kind === 'giant');
if (giant && GIANT_LAUREL) {
  const leafTex = sprigTexture('laurel');
  const tree = new THREE.Group();
  const bark = new THREE.Mesh(giant.bark, toonMaterial(look, 'bark', { ao: true }));
  const leaves = new THREE.Mesh(giant.leaves, toonMaterial(look, 'leaves', {
    ao: true, noFlip: true, map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide,
  }));
  leaves.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.45 });
  for (const m of [bark, leaves]) m.castShadow = m.receiveShadow = true;
  tree.add(bark, leaves);
  tree.position.set(GIANT_LAUREL.x, GIANT_LAUREL.h - 0.2, GIANT_LAUREL.z);
  tree.rotation.y = 0.7;
  scene.add(tree);
  colliders.push({ x: GIANT_LAUREL.x, z: GIANT_LAUREL.z, r: giant.trunk + 0.6 });
  gaze.push({ x: GIANT_LAUREL.x, z: GIANT_LAUREL.z, y: GIANT_LAUREL.h + giant.height * 0.6, r: 75, weight: 1.3 });
}

await say('点亮星空…');
const sky = buildToonSky();
sky.stars.material.uniforms.uPR.value = PR;
scene.add(sky.group);
const reflScale = 0.5;
const water = buildToonWater(W() * PR * reflScale, H() * PR * reflScale);
scene.add(water);
const falling = buildFallingLeaves(GIANT_LAUREL);
scene.add(falling);

// ---------------------------------------------------------------- post: ink lines, then out to the screen

const rt = new THREE.WebGLRenderTarget(W() * PR, H() * PR, { type: THREE.HalfFloatType, samples: 2 });
rt.depthTexture = new THREE.DepthTexture(W() * PR, H() * PR);
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const outline = new OutlinePass(camera);
composer.addPass(outline);
// a glow only for what is brighter than white: the moon and its path on the water, not the pale stone
const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.7, 0.75, 1.0);
const bloomSetSize = bloom.setSize.bind(bloom);
bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- the tunable look (toon-tuning.json)

// The viewer's own choices, kept in this browser: the colour (a place along the slider, 0 to 1), where the
// moon stands (degrees round the horizon), and whether laurel leaves drift down.
const CHOICE_KEY = 'moonlit-shallows.toon.choice';
const choice = { hue: placeAlong(tuning, tuning.palette.start), moon: null, falling: tuning.falling.on };
try {
  const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}');
  for (const k of Object.keys(choice)) if (k in saved) choice[k] = saved[k];
} catch { /* storage unavailable */ }
const keepChoice = () => { try { localStorage.setItem(CHOICE_KEY, JSON.stringify(choice)); } catch { /* storage unavailable */ } };
const around = (a) => ((a % 360) + 360) % 360;
// the page shows the viewer's choices. The colour slider moves the whole tuned family of colours (linked or
// set one by one) to its colour.
const tuned = structuredClone(tuning);
const useChoices = () => {
  shiftShades(tuning, tuned, shadeAlong(tuning, choice.hue));
  if (choice.moon !== null) tuning.moon.azimuth = choice.moon;
};
useChoices();

const deg = THREE.MathUtils.degToRad;
function applyTuning(t) {
  derivePalette(t); // linked colours follow the two bases
  MOON_DIR.setFromSphericalCoords(1, deg(90 - t.moon.elevation), deg(t.moon.azimuth));
  for (const light of shadowLights) {
    light.position.copy(light.target.position).addScaledVector(MOON_DIR, 220);
    light.shadow.needsUpdate = true;
  }
  renderer.shadowMap.needsUpdate = true;
  applyLook(look, t, 1);
  sky.apply(t, t.stone.lit);
  water.apply(t);
  scene.fog.color.set(t.sky.horizon);
  scene.fog.density = t.fog.density;
  outline.enabled = t.outline.on;
  outline.uniforms.uColor.value.set(t.outline.color);
  outline.uniforms.uStrength.value = t.outline.strength;
  outline.uniforms.uDepth.value = t.outline.depth;
  falling.apply(t);
  falling.visible = choice.falling;
}
applyTuning(tuning);

// ---------------------------------------------------------------- walking and sound

// The stroll here takes a detour the meadow page can't (there a hill rises in the way): out of the tholos it
// turns west toward the giant laurel, comes round under it, and loops back to the great temple's front.
const DETOUR = [[38, 9], [22, 12], [8, 15], [1, 9], [6, 4], [20, 8], [34, 7]];
const AFTER_THOLOS = 10; // the loop's points: the avenue's five, then the tholos's five
const route = makeRoute([...PATH_POINTS.slice(0, AFTER_THOLOS), ...DETOUR, ...PATH_POINTS.slice(AFTER_THOLOS)]);
const walker = new Walker(camera, renderer.domElement, {
  route,
  onStep: () => {},
  onModeChange: (mode) => { ui.mode.textContent = mode === 'auto' ? '自动漫步中 · 空格切换' : '自由行走 · 空格回到漫步'; },
});
if (params.has('s')) walker.s = parseFloat(params.get('s'));

const sound = new Soundscape();
const soundButton = document.getElementById('sound');
const showSound = () => {
  soundButton.textContent = sound.muted ? '♪ 静音' : '♪';
  soundButton.setAttribute('aria-pressed', String(!sound.muted));
};
const toggleSound = () => { sound.setMuted(!sound.muted); showSound(); };
soundButton.addEventListener('click', () => { toggleSound(); soundButton.blur(); });
addEventListener('keydown', (e) => { if (e.code === 'KeyM') toggleSound(); });
showSound();

// the viewer's controls: colour and moon (two sliders under one button), falling leaves on or off
const lookButton = document.getElementById('look');
const lookPanel = document.getElementById('look-panel');
const hueSlider = document.getElementById('hue');
const moonSlider = document.getElementById('moon-az');
const fallingButton = document.getElementById('falling');
hueSlider.style.background = rangeGradient(tuning);
hueSlider.value = choice.hue;
moonSlider.value = Math.round(around(tuning.moon.azimuth));
const showPanel = (open) => {
  lookPanel.hidden = !open;
  lookButton.setAttribute('aria-expanded', String(open));
};
lookButton.addEventListener('click', (e) => { e.stopPropagation(); showPanel(lookPanel.hidden); lookButton.blur(); });
addEventListener('pointerdown', (e) => { if (!lookPanel.hidden && !lookPanel.contains(e.target) && e.target !== lookButton) showPanel(false); });
const slid = () => {
  choice.hue = parseFloat(hueSlider.value);
  choice.moon = parseFloat(moonSlider.value);
  useChoices();
  applyTuning(tuning);
};
for (const el of [hueSlider, moonSlider]) {
  el.addEventListener('input', slid);
  el.addEventListener('change', () => { keepChoice(); el.blur(); }); // let go: the keys walk again
}
const showFalling = () => {
  fallingButton.textContent = choice.falling ? '落叶 · 开' : '落叶 · 关';
  fallingButton.setAttribute('aria-pressed', String(choice.falling));
};
const toggleFalling = () => {
  choice.falling = !choice.falling;
  keepChoice();
  falling.visible = choice.falling;
  showFalling();
};
fallingButton.addEventListener('click', () => { toggleFalling(); fallingButton.blur(); });
addEventListener('keydown', (e) => { if (e.code === 'KeyP') toggleFalling(); });
showFalling();

// ---------------------------------------------------------------- loop

let sizeW = -1, sizeH = -1;
const resize = () => {
  sizeW = W();
  sizeH = H();
  camera.aspect = W() / H();
  camera.updateProjectionMatrix();
  renderer.setSize(W(), H());
  composer.setSize(W(), H());
  water.getRenderTarget().setSize(W() * PR * reflScale, H() * PR * reflScale);
};
addEventListener('resize', resize);

const clock = new THREE.Clock();
const snap = (v, step) => Math.round(v / step) * step;
const lookDir = new THREE.Vector3();

function frame() {
  if (W() !== sizeW || H() !== sizeH) resize();
  const dt = Math.min(clock.getDelta(), 0.05);
  shared.uTime.value += dt;
  walker.update(dt);
  sky.update(camera);
  shared.uCamera.value.copy(camera.position);

  // moon shadows over squares ahead of the viewer, each drawn again only when it moves
  camera.getWorldDirection(lookDir);
  for (const light of shadowLights) {
    const { ahead, step } = light.userData;
    const cx = snap(camera.position.x + lookDir.x * ahead, step);
    const cz = snap(camera.position.z + lookDir.z * ahead, step);
    if (cx !== light.target.position.x || cz !== light.target.position.z) {
      light.target.position.set(cx, 0, cz);
      light.position.set(cx, 0, cz).addScaledVector(MOON_DIR, 220);
      light.shadow.needsUpdate = renderer.shadowMap.needsUpdate = true;
    }
  }

  composer.render(dt);
  requestAnimationFrame(frame);
}

await say('');
ui.intro.classList.add('ready');
const begin = () => {
  sound.start();
  ui.intro.classList.add('gone');
  ui.hint.classList.add('show');
  setTimeout(() => ui.hint.classList.remove('show'), 9000);
};
ui.intro.addEventListener('click', begin, { once: true });
if (params.has('go')) begin();
requestAnimationFrame(frame);

window.__scene = { scene, camera, walker, renderer, composer };
