import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { MOON_DIR, shared, buildTerrain, buildHeightTexture, buildGroundTexture, path } from './world.js';
import { loadRuins, marbleLook } from './ruins.js';
import { loadPlants, buildTrees, buildFlowers, buildUnderstory, buildMotes } from './vegetation.js';
import { buildMeadow } from './grass.js';
import { buildSky, SKY_HORIZON } from './sky.js';
import { buildWater } from './water.js';
import { Walker } from './walker.js';
import { Soundscape } from './audio.js';
import { loadTuning } from './tuning.js';
import { AirPass } from './air.js';

const params = new URLSearchParams(location.search);
const tuning = await loadTuning();
const ui = {
  intro: document.getElementById('intro'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  mode: document.getElementById('mode'),
};
// lets the status line paint; the timer keeps loading going in a background tab, where frames don't come
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });
const say = async (msg) => { ui.status.textContent = msg; await nextFrame(); };

// ---------------------------------------------------------------- renderer

// Window size, never zero (a page opened in a hidden or minimised window starts out 0 x 0).
const W = () => Math.max(1, innerWidth), H = () => Math.max(1, innerHeight);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// Pixel ratio: as sharp as 1.5 where the machine keeps up; the loop below lowers it (down to 1) if frames
// come too slowly and raises it again when there is room.
const PR_MAX = Math.min(devicePixelRatio, 1.5), PR_MIN = Math.min(1, PR_MAX);
let PR = PR_MAX;
renderer.setPixelRatio(PR);
renderer.setSize(W(), H());
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(SKY_HORIZON.clone().multiplyScalar(0.9), 0.0032);

const camera = new THREE.PerspectiveCamera(58, W() / H(), 0.1, 4000);
camera.layers.enable(1);

// moonlight: white where it falls, deep blue in the shadows
const moon = new THREE.DirectionalLight(new THREE.Color().setRGB(0.82, 0.88, 1.0), 2.6);
moon.castShadow = true;
moon.shadow.mapSize.set(4096, 4096);
// Moon shadows over a 200 m square set ahead of the viewer, reaching some 160 m in the direction one looks
// (so distant ruins already cast theirs as one approaches). Moon and ruins stand still, so the map is drawn
// again only when the square moves, in steps of about 8 m that are a whole number of its texels.
const SH = 100, SHADOW_AHEAD = 60;
const SHADOW_STEP = ((SH * 2) / 4096) * Math.round(8 / ((SH * 2) / 4096));
Object.assign(moon.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 450 });
moon.shadow.bias = -0.0004;
moon.shadow.normalBias = 0.06;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
scene.add(moon, moon.target);

const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.16, 0.27, 0.62), new THREE.Color().setRGB(0.03, 0.05, 0.11), 1.6);
scene.add(hemi);

// ---------------------------------------------------------------- world

await say('立起神殿的石柱…');
scene.add(await loadRuins());

await say('铺开水面与沙洲…');
const groundTex = buildGroundTexture(); // after the ruins: grass grows up to their stones
scene.add(buildTerrain(groundTex));
const heightTex = buildHeightTexture();

await say('种下橄榄与月桂…');
const plants = await loadPlants();
scene.add(buildTrees(plants));
await say('龙胆花正在开放…');
scene.add(buildFlowers(plants));
scene.add(buildUnderstory(plants));
scene.add(buildMeadow(groundTex));
const motes = buildMotes();
motes.material.uniforms.uPR.value = PR;
scene.add(motes);

await say('点亮星空…');
const sky = buildSky(PR);
scene.add(sky.group);

const reflScale = 0.5;
const water = buildWater(W() * PR * reflScale, H() * PR * reflScale, scene.fog);
water.setHeightTexture(heightTex);
scene.add(water);

// ---------------------------------------------------------------- post

const rt = new THREE.WebGLRenderTarget(W() * PR, H() * PR, { type: THREE.HalfFloatType, samples: 2 });
rt.depthTexture = new THREE.DepthTexture(W() * PR, H() * PR); // the air pass reads how far each pixel is
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const air = new AirPass(camera); // straight after the scene, while the buffer still holds its depth
composer.addPass(air);
// A single NaN / Inf pixel would be smeared by bloom into a black block; clear any before bloom.
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c)) || any(isinf(c)) || c.r != c.r || c.g != c.g || c.b != c.b;
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(min(c.rgb, vec3(200.0)), c.a);
    }`,
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.42, 0.55, 1.0);
// the glow is soft anyway: work it out at half the size the composer asks for
const bloomSetSize = bloom.setSize.bind(bloom);
bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
composer.addPass(bloom);
composer.addPass(new OutputPass());
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: W() / H() }, uVignette: { value: 0.45 }, uGrade: { value: 0.5 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uAspect, uVignette, uGrade; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = smoothstep(1.05, 0.25, length(d));
      c.rgb *= mix(1.0 - uVignette, 1.0, v);
      c.rgb = mix(c.rgb, c.rgb * vec3(0.92, 0.97, 1.08), uGrade);
      c.rgb += vec3(0.004, 0.008, 0.02);
      c.rgb += (hash(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5) * 0.022;
      gl_FragColor = c;
    }`,
});
composer.addPass(finish);

// ---------------------------------------------------------------- the tunable look (tuning.json)

const deg = THREE.MathUtils.degToRad;
function applyTuning(t) {
  MOON_DIR.setFromSphericalCoords(1, deg(90 - t.moon.elevation), deg(t.moon.azimuth));
  moon.position.copy(moon.target.position).addScaledVector(MOON_DIR, 220);
  renderer.shadowMap.needsUpdate = true; // the moon moved: the shadows must be drawn again
  water.material.uniforms.uMoonDir.value.copy(MOON_DIR);
  moon.color.set(t.moon.color);
  moon.intensity = t.moon.intensity;
  hemi.color.set(t.sky.color);
  hemi.groundColor.set(t.sky.ground);
  hemi.intensity = t.sky.intensity;
  scene.fog.density = t.fog.density;
  scene.fog.color.set(t.fog.color);
  water.material.uniforms.uFogColor.value.copy(scene.fog.color);
  const m = t.temples;
  marbleLook.material.color.set(m.color);
  marbleLook.material.roughness = m.roughness;
  marbleLook.uLitTint.value.set(m.litTint);
  marbleLook.uShadeTint.value.set(m.shadeTint);
  Object.assign(marbleLook.uAO, { value: m.ao });
  Object.assign(marbleLook.uGrime, { value: m.grime });
  Object.assign(marbleLook.uVein, { value: m.veins });
  Object.assign(marbleLook.uRelief, { value: m.relief });
  Object.assign(marbleLook.uWet, { value: m.wet });
  const a = air.uniforms;
  a.uAir.value = t.air.density;
  a.uAirColor.value.set(t.air.color);
  a.uGlowColor.value.set(t.air.glowColor);
  a.uGlow.value = t.air.glow;
  a.uMist.value = t.air.mist;
  a.uMistHeight.value = t.air.mistHeight;
  a.uMistColor.value.set(t.air.mistColor);
  renderer.toneMappingExposure = t.post.exposure;
  bloom.strength = t.post.bloom;
  bloom.radius = t.post.bloomRadius;
  bloom.threshold = t.post.bloomThreshold;
  finish.uniforms.uVignette.value = t.post.vignette;
  finish.uniforms.uGrade.value = t.post.grade;
}
applyTuning(tuning);

// ---------------------------------------------------------------- walking

// ---------------------------------------------------------------- sound

const sound = new Soundscape();
const soundButton = document.getElementById('sound');
const showSound = () => {
  soundButton.textContent = sound.muted ? '♪ 静音' : '♪';
  soundButton.setAttribute('aria-pressed', String(!sound.muted));
};
const toggleSound = () => { sound.setMuted(!sound.muted); showSound(); };
soundButton.addEventListener('click', () => { toggleSound(); soundButton.blur(); }); // keep Space for walking
addEventListener('keydown', (e) => { if (e.code === 'KeyM') toggleSound(); });
showSound();

const walker = new Walker(camera, renderer.domElement, {
  onStep: (x, z, ground) => { if (ground < -0.03) water.addRipple(x, z, 1.0, shared.uTime.value); },
  onModeChange: (mode) => { ui.mode.textContent = mode === 'auto' ? '自动漫步中 · 空格切换' : '自由行走 · 空格回到漫步'; },
});
if (params.has('s')) walker.s = parseFloat(params.get('s'));

const top = params.has('top');
if (top) {
  scene.fog.density = 0.0006;
  camera.position.set(-8, 260, -20);
  camera.lookAt(-8, 0, -20.01);
}

// ---------------------------------------------------------------- loop

let sizeW = -1, sizeH = -1; // forces a resize on the first frame: the window may have changed while loading
const resize = () => {
  sizeW = W();
  sizeH = H();
  camera.aspect = W() / H();
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(PR);
  renderer.setSize(W(), H());
  composer.setPixelRatio(PR);
  composer.setSize(W(), H());
  water.getRenderTarget().setSize(W() * PR * reflScale, H() * PR * reflScale);
  finish.uniforms.uAspect.value = W() / H();
  motes.material.uniforms.uPR.value = PR;
  sky.starsMaterial.uniforms.uPR.value = PR;
};
addEventListener('resize', resize);

// adaptive sharpness: every 1.5 s, step the pixel ratio down if frames average over 21 ms (under ~48 fps),
// and back up after a few windows under 17.5 ms
const pace = { time: 0, frames: 0, good: 0 };
function adaptResolution(rawDt) {
  if (rawDt > 0.2 || document.hidden) return; // a stall or a hidden tab says nothing about rendering
  pace.time += rawDt;
  pace.frames++;
  if (pace.time < 1.5) return;
  const ms = (pace.time / pace.frames) * 1000;
  pace.time = pace.frames = 0;
  let next = PR;
  if (ms > 21) {
    next = Math.max(PR_MIN, PR - 0.1);
    pace.good = 0;
  } else if (ms < 17.5 && ++pace.good >= 3) {
    next = Math.min(PR_MAX, PR + 0.1);
    pace.good = 0;
  }
  if (Math.abs(next - PR) > 0.01) {
    PR = next;
    resize();
  }
}

const clock = new THREE.Clock();
let dripAt = 2;
const rnd = Math.random;
const snap = (v, step) => Math.round(v / step) * step;
const look = new THREE.Vector3();

function frame() {
  if (W() !== sizeW || H() !== sizeH) resize(); // catches size changes that fire no resize event
  const rawDt = clock.getDelta();
  adaptResolution(rawDt);
  const dt = Math.min(rawDt, 0.05);
  const t = (shared.uTime.value += dt);

  if (!top) walker.update(dt);
  sky.update(camera, dt, t);
  shared.uCamera.value.copy(camera.position);
  motes.material.uniforms.uCam.value.copy(camera.position);
  finish.uniforms.uTime.value = t;

  // the shadow square, ahead of the viewer; redrawn only when it moves
  camera.getWorldDirection(look);
  const cx = snap(camera.position.x + look.x * SHADOW_AHEAD, SHADOW_STEP);
  const cz = snap(camera.position.z + look.z * SHADOW_AHEAD, SHADOW_STEP);
  if (cx !== moon.target.position.x || cz !== moon.target.position.z) {
    moon.target.position.set(cx, 0, cz);
    moon.position.set(cx, 0, cz).addScaledVector(MOON_DIR, 220);
    renderer.shadowMap.needsUpdate = true;
  }

  // the odd drop of water ringing out somewhere nearby
  if (t > dripAt) {
    const a = rnd() * Math.PI * 2, r = 4 + rnd() * 22;
    water.addRipple(camera.position.x + Math.cos(a) * r, camera.position.z + Math.sin(a) * r, 0.35 + rnd() * 0.5, t);
    dripAt = t + 0.6 + rnd() * 2.2;
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
if (!top) walker.update(0);
requestAnimationFrame(frame);
window.__scene = { scene, camera, walker, renderer, composer, path };
