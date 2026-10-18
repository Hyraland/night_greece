// Olive and laurel trees, gentians, asphodel, acanthus, sea daffodils and drifting motes of light.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mulberry32, noise2, fbm, smoothstep } from './noise.js';
import { heightAt, slopeAt, pathDistance, nearSite, colliders, gaze, shared, MOON_DIR, CENTER, GIANT_LAUREL } from './world.js';

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

// ---------------------------------------------------------------- shared shader tweaks

// Wind sway applied in world space (bend: GLSL weight from the local vertex), moonlight shining through
// thin leaves and petals, a faint glow, and optionally a custom decoding of the baked vertex colours.
// noFlip keeps the authored normals on back faces (cards and blades lit as one soft volume).
function foliage(material, { key, noFlip = false, bend = '0.0', amp = 0.03, flutter = 0, translucency = 0, glow = '', color = '' }) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uMoonDir = { value: MOON_DIR };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <project_vertex>', `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
{
  float bw = (${bend}) * ${amp.toFixed(4)};
  vec2 wp = mvPosition.xz;
  float gust = 0.55 + 0.45 * sin(uTime * 0.27 + wp.x * 0.015 + wp.y * 0.01);
  float s1 = sin(uTime * 1.3 + wp.x * 0.33 + wp.y * 0.21);
  float s2 = sin(uTime * 2.2 + wp.x * 0.9 - wp.y * 0.7);
  mvPosition.xz += vec2(0.8, 0.45) * (s1 + 0.45 * s2) * gust * bw;
  mvPosition.y += 0.15 * s2 * bw;
  ${flutter ? `mvPosition.xyz += vec3(sin(uTime * 5.1 + mvPosition.x * 7.0), sin(uTime * 4.3 + mvPosition.z * 6.0), cos(uTime * 4.7 + mvPosition.y * 8.0)) * ${flutter.toFixed(4)} * gust;` : ''}
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    let fs = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uMoonDir;');
    if (color) fs = fs.replace('#include <color_fragment>', color);
    if (noFlip) fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replaceAll('normal *= faceDirection;', ''));
    if (glow) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * (${glow});`);
    if (translucency) fs = fs.replace('#include <opaque_fragment>', `{
  vec3 Lv = normalize((viewMatrix * vec4(uMoonDir, 0.0)).xyz);
  float back = pow(max(dot(normalize(-vViewPosition), Lv), 0.0), 3.0);
  outgoingLight += diffuseColor.rgb * vec3(0.7, 0.82, 1.0) * back * ${translucency.toFixed(4)};
}
#include <opaque_fragment>`);
    sh.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => key;
  return material;
}

// ---------------------------------------------------------------- textures

export function sprigTexture(kind) {
  const W = 128, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const rng = mulberry32(kind === 'olive' ? 5 : 9);
  g.strokeStyle = '#77756c';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(64, 254); g.quadraticCurveTo(58, 140, 66, 14); g.stroke();
  const olive = kind === 'olive';
  const n = olive ? 13 : 8;
  const drawLeaf = (x, y, ang, len, wid) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const v = Math.round(olive ? 175 + rng() * 80 : 150 + rng() * 105);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath(); g.ellipse(0, -len / 2, wid / 2, len / 2, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, -2); g.lineTo(0, -len * 0.92); g.stroke();
    g.restore();
  };
  for (let i = 0; i < n; i++) {
    const t = 0.06 + (i / n) * 0.84;
    const side = i % 2 ? 1 : -1;
    const ang = side * (olive ? 0.45 + rng() * 0.35 : 0.55 + rng() * 0.35);
    drawLeaf(64 + (t - 0.5) * -6, 254 - t * 238, ang, olive ? 64 + rng() * 22 : 80 + rng() * 22, olive ? 10 + rng() * 3 : 27 + rng() * 6);
  }
  drawLeaf(66, 20, 0.05, olive ? 60 : 72, olive ? 10 : 24);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; // glTF UVs already have v pointing down the image: unflipped, the stem sits at the twig
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Seamless bark, laid around (u) and along (v) every limb by the UVs from Blender: wandering vertical
// furrows, the plates between them broken by cross cracks, lighter ridges. Also used as the bump map.
function barkTexture({ furrows, depth, cracks, seed }) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rng = mulberry32(seed);
  g.fillStyle = 'rgb(200,200,200)';
  g.fillRect(0, 0, S, S);
  // wrapped drawing so the tile repeats without seams
  const wrapped = (draw) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { g.save(); g.translate(dx, dy); draw(); g.restore(); } };
  const lines = [];
  for (let k = 0; k < furrows; k++) {
    const x0 = ((k + 0.2 + rng() * 0.6) / furrows) * S;
    const waves = [1, 2, 3].map((n) => ({ n, a: (rng() - 0.5) * (S / furrows) * 0.5 / n, p: rng() * 6.28 }));
    const wn = 2 + Math.floor(rng() * 3), wp = rng() * 6.28;
    const at = (y) => x0 + waves.reduce((x, w) => x + w.a * Math.sin((y / S) * 6.28 * w.n + w.p), 0);
    const width = (y) => (0.35 + 0.65 * (0.5 + 0.5 * Math.sin((y / S) * 6.28 * wn + wp))) * (S / furrows) * 0.32;
    lines.push({ at, width });
  }
  // soft shading toward each furrow, then the dark furrow itself
  for (const [shade, wk, blur] of [[150, 2.4, 10], [95, 1.2, 4], [55, 0.55, 1]]) {
    for (const { at, width } of lines) {
      wrapped(() => {
        g.fillStyle = `rgb(${shade},${shade},${shade})`;
        g.filter = `blur(${blur}px)`;
        g.beginPath();
        for (let y = 0; y <= S; y += 8) g.lineTo(at(y) - width(y) * wk / 2, y);
        for (let y = S; y >= 0; y -= 8) g.lineTo(at(y) + width(y) * wk / 2, y);
        g.fill();
      });
    }
  }
  g.filter = 'none';
  // cross cracks between neighbouring furrows break the ridges into plates
  for (let k = 0; k < lines.length; k++) {
    const a = lines[k], b = lines[(k + 1) % lines.length];
    for (let c = 0; c < cracks; c++) {
      const y = rng() * S, xa = a.at(y), xb = b.at(y) + (k === lines.length - 1 ? S : 0);
      wrapped(() => {
        g.strokeStyle = `rgba(50,50,50,${0.5 + rng() * 0.4})`;
        g.lineWidth = 1.5 + rng() * 2.5;
        g.beginPath();
        g.moveTo(xa, y);
        g.quadraticCurveTo((xa + xb) / 2, y + (rng() - 0.5) * 18, xb, y + (rng() - 0.5) * 12);
        g.stroke();
      });
    }
  }
  // fine grain
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 34;
    const v = 255 - (255 - d[i]) * depth + n;
    d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v));
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; // as for the sprigs: glTF UVs
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------- plant templates from Blender

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
loader.setDRACOLoader(draco);

// The plant variants modelled in blender/build_plants.py: tree bark and leaf cards, gentians and other flowers.
export async function loadPlants() {
  const [gltf, meta] = await Promise.all([
    loader.loadAsync('assets/plants.glb'),
    fetch('assets/plants.json').then((r) => r.json()),
  ]);
  const geo = (name) => {
    const o = gltf.scene.getObjectByName(name);
    if (!o) throw new Error(`plants: no node ${name}`);
    return o.geometry;
  };
  return {
    trees: meta.trees.map((t) => ({ ...t, bark: geo(t.bark), leaves: geo(t.leaves) })),
    gentians: meta.gentians.map((g) => geo(g.node)),
    asphodel: meta.asphodel.map((g) => geo(g.node)),
    acanthus: meta.acanthus.map((g) => geo(g.node)),
    daffodils: meta.daffodils.map((g) => geo(g.node)),
  };
}

// Instances of one geometry at the given transforms.
function instanced(geometry, material, items, { shadow = false, layer = 0 } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V3();
  items.forEach((it, i) => {
    q.setFromAxisAngle(UP, it.rot);
    mesh.setMatrixAt(i, m.compose(new V3(it.x, it.y, it.z), q, s.setScalar(it.scale)));
  });
  mesh.computeBoundingSphere();
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  if (layer) mesh.layers.set(layer);
  return mesh;
}

// ---------------------------------------------------------------- trees

const TREE_LOOK = {
  olive: { bark: 0x8a857c, dark: [0.17, 0.22, 0.15], light: [0.47, 0.51, 0.45], roughness: 0.85, translucency: 0.5,
    barkTex: { furrows: 9, depth: 1.0, cracks: 7, seed: 31 }, bump: 3.0 },
  laurel: { bark: 0x6a6259, dark: [0.04, 0.09, 0.04], light: [0.17, 0.27, 0.11], roughness: 0.8, translucency: 0.35,
    barkTex: { furrows: 6, depth: 0.45, cracks: 3, seed: 32 }, bump: 1.2 },
};
// the ancient laurel's bark has had millennia to furrow and crack
TREE_LOOK.giant = { ...TREE_LOOK.laurel, bark: 0x6e665c, barkTex: { furrows: 7, depth: 1.0, cracks: 9, seed: 33 }, bump: 4.0 };

// Trees bend from the ground up; bark and leaves share the same sway so twigs keep their leaves.
const TREE_BEND = 'pow(clamp(position.y / 8.0, 0.0, 1.0), 2.0)';

function barkMaterial(kind) {
  const look = TREE_LOOK[kind], tex = barkTexture(look.barkTex);
  const m = new THREE.MeshStandardMaterial({ color: look.bark, roughness: 0.95, vertexColors: true, map: tex, bumpMap: tex, bumpScale: look.bump });
  return foliage(m, {
    key: 'bark-' + kind, bend: TREE_BEND, amp: 0.08,
    color: `
diffuseColor.rgb *= 0.8 + 0.4 * vColor.b;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.58, 0.62, 0.55), vColor.g * 0.4);
diffuseColor.rgb *= vColor.r;`,
  });
}

function leafMaterial(kind, tex) {
  const look = TREE_LOOK[kind];
  const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: look.roughness, vertexColors: true });
  const v = (c) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;
  return foliage(m, {
    key: 'leaves-' + kind, noFlip: true, bend: TREE_BEND, amp: 0.08, flutter: 0.02, translucency: look.translucency,
    color: `diffuseColor.rgb *= mix(${v(look.dark)}, ${v(look.light)}, vColor.g) * vColor.r;`,
  });
}

const TREE_SCALE = 1.5; // olives and laurels, against the colossal ruins

export function buildTrees(plants) {
  const rng = mulberry32(4242);
  const group = new THREE.Group();
  const byVariant = new Map(plants.trees.map((t) => [t, []]));
  const variants = (kind) => plants.trees.filter((t) => t.kind === kind);
  const placed = [];
  const tooClose = (x, z, r) => placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < (r + p.r) ** 2);

  const giant = variants('giant')[0];
  const spot = GIANT_LAUREL;
  if (giant && spot) {
    byVariant.get(giant).push({ x: spot.x, y: spot.h - 0.2, z: spot.z, rot: 0.7, scale: 1 });
    placed.push({ x: spot.x, z: spot.z, r: 17 });
    colliders.push({ x: spot.x, z: spot.z, r: giant.trunk + 0.6 });
    gaze.push({ x: spot.x, z: spot.z, y: spot.h + giant.height * 0.6, r: 75, weight: 1.3 });
  }

  let olives = 0, laurels = 0, tries = 0;
  while ((olives < 120 || laurels < 75) && tries++ < 60000) {
    const x = CENTER.x + (rng() - 0.5) * 360, z = CENTER.z + (rng() - 0.5) * 360;
    const h = heightAt(x, z);
    if (h < 0.3 || h > 14) continue;
    const d = pathDistance(x, z);
    if (d < 5 || d > 110) continue;
    if (nearSite(x, z, 2.5)) continue;
    if (slopeAt(x, z) > 0.55) continue;
    const laurel = h > 2.2 + 1.5 * noise2(x * 0.05, z * 0.05) ? rng() < 0.6 : rng() < 0.2;
    if (laurel ? laurels >= 75 : olives >= 120) continue;
    const r = (laurel ? 3.2 : 3.6) * TREE_SCALE;
    if (tooClose(x, z, r)) continue;
    const pool = variants(laurel ? 'laurel' : 'olive');
    const v = pool[Math.floor(rng() * pool.length)];
    const scale = (laurel ? 0.85 + rng() * 0.35 : 0.85 + rng() * 0.4) * TREE_SCALE;
    byVariant.get(v).push({ x, y: h, z, rot: rng() * Math.PI * 2, scale });
    colliders.push({ x, z, r: v.trunk * scale });
    placed.push({ x, z, r });
    laurel ? laurels++ : olives++;
  }

  const tex = { olive: sprigTexture('olive'), laurel: sprigTexture('laurel') };
  tex.giant = tex.laurel;
  const mats = {};
  for (const [v, items] of byVariant) {
    if (!items.length) continue;
    mats[v.kind] ??= { bark: barkMaterial(v.kind), leaves: leafMaterial(v.kind, tex[v.kind]) };
    group.add(instanced(v.bark, mats[v.kind].bark, items, { shadow: true }));
    const leaves = instanced(v.leaves, mats[v.kind].leaves, items, { shadow: true });
    leaves.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex[v.kind], alphaTest: 0.45 });
    group.add(leaves);
  }
  return group;
}

// ---------------------------------------------------------------- gentians

export function buildFlowers(plants) {
  const rng = mulberry32(777);
  const lists = plants.gentians.map(() => []);
  let tries = 0, clumps = 0;
  while (clumps < 1000 && tries++ < 60000) {
    const x = CENTER.x + (rng() - 0.5) * 300, z = CENTER.z + (rng() - 0.5) * 300;
    const h = heightAt(x, z);
    if (h < -0.05 || h > 4) continue;
    const d = pathDistance(x, z);
    if (d > 85) continue;
    const site = nearSite(x, z, 4);
    if (site && nearSite(x, z, 0.3)) continue;
    const patch = fbm(x * 0.035 + 50, z * 0.035 - 20, 3);
    let p = 0.08 + smoothstep(0.0, 0.25, patch) * 0.9;
    if (h < 0.4) p += 0.45;
    if (site) p += 0.4;
    p *= 1 - smoothstep(30, 85, d) * 0.7;
    if (rng() > p) continue;
    const n = 1 + (patch > 0.15 ? Math.floor(rng() * 3) : 0);
    for (let k = 0; k < n; k++) {
      const ox = x + (rng() - 0.5) * 2.5, oz = z + (rng() - 0.5) * 2.5;
      const oh = heightAt(ox, oz);
      if (oh < -0.05 || nearSite(ox, oz, 0.3)) continue;
      lists[Math.floor(rng() * lists.length)].push({ x: ox, y: oh, z: oz, rot: rng() * Math.PI * 2, scale: 0.9 + rng() * 0.4 });
      clumps++;
    }
  }
  const mat = foliage(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55 }), {
    key: 'gentian', bend: 'clamp(position.y / 0.6, 0.0, 1.0)', amp: 0.04, translucency: 0.9,
    glow: 'smoothstep(0.05, 0.25, vColor.b - vColor.g) * 0.25',
  });
  const group = new THREE.Group();
  plants.gentians.forEach((g, i) => { if (lists[i].length) group.add(instanced(g, mat, lists[i])); });
  return group;
}

// ---------------------------------------------------------------- asphodel, acanthus, sea daffodil

// Scatter up to `count` plants where `accept(x, z, h)` gives a probability, over the island and shores.
function scatter(rng, count, variants, accept, scale = [0.85, 1.25], span = 300) {
  const lists = variants.map(() => []);
  let tries = 0, n = 0;
  while (n < count && tries++ < count * 120) {
    const x = CENTER.x + (rng() - 0.5) * span, z = CENTER.z + (rng() - 0.5) * span;
    const h = heightAt(x, z);
    if (rng() > accept(x, z, h)) continue;
    lists[Math.floor(rng() * lists.length)].push({ x, y: h - 0.02, z, rot: rng() * Math.PI * 2, scale: scale[0] + rng() * (scale[1] - scale[0]) });
    n++;
  }
  return lists;
}

export function buildUnderstory(plants) {
  const rng = mulberry32(2718);
  const group = new THREE.Group();
  const add = (geos, lists, mat, layer = 0) => geos.forEach((g, i) => { if (lists[i].length) group.add(instanced(g, mat, lists[i], { layer })); });
  const pale = (key, amp) => foliage(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6 }), {
    key, bend: 'clamp(position.y / 1.0, 0.0, 1.0)', amp, translucency: 0.8,
    glow: 'smoothstep(0.55, 0.8, dot(vColor.rgb, vec3(0.333))) * 0.18', // white flowers catch a little more light
  });

  // asphodel meadows on the slopes, in drifts
  add(plants.asphodel, scatter(rng, 560, plants.asphodel, (x, z, h) => {
    if (h < 0.4 || h > 9 || nearSite(x, z, 1) || pathDistance(x, z) > 95 || slopeAt(x, z) > 0.5) return 0;
    return smoothstep(0.05, 0.3, fbm(x * 0.03 - 11, z * 0.03 + 7, 3));
  }, [1.1, 1.5]), pale('asphodel', 0.05), 1);

  // acanthus at the feet of the ruins
  add(plants.acanthus, scatter(rng, 260, plants.acanthus, (x, z, h) => {
    if (h < 0.02 || h > 9 || !nearSite(x, z, 9) || nearSite(x, z, 0.8)) return 0;
    return 0.9;
  }, [0.9, 1.3]), foliage(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.45 }), {
    key: 'acanthus', bend: 'clamp(position.y / 1.2, 0.0, 1.0)', amp: 0.03, translucency: 0.3,
  }));

  // sea daffodils on the low sandy shore just above the water
  add(plants.daffodils, scatter(rng, 380, plants.daffodils, (x, z, h) => {
    if (h < 0.03 || h > 0.6 || nearSite(x, z, 0.5) || pathDistance(x, z) > 90) return 0;
    return 0.85;
  }, [1.5, 2.0]), pale('daffodil', 0.03));
  return group;
}

// ---------------------------------------------------------------- motes of light

export function buildMotes() {
  const N = 420, rng = mulberry32(99);
  const pos = new Float32Array(N * 3), seed = new Float32Array(N), col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos.set([rng() * 80, 0.3 + rng() * 3.5, rng() * 80], i * 3);
    seed[i] = rng() * 100;
    const c = rng() < 0.5 ? [0.75, 0.85, 1.0] : [1.0, 0.75, 1.0];
    col.set(c, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uCam: { value: new V3() }, uPR: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCam; uniform float uPR;
      attribute float aSeed; attribute vec3 color;
      varying vec3 vCol; varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.13 + aSeed) * 3.0 + uTime * 0.25;
        p.z += cos(uTime * 0.11 + aSeed * 1.7) * 3.0;
        p.y += sin(uTime * 0.4 + aSeed * 2.3) * 0.5;
        p.xz = uCam.xz + mod(p.xz - uCam.xz + 40.0, 80.0) - 40.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = clamp(uPR * 36.0 / d, 1.0, 7.0 * uPR);
        float blink = 0.5 + 0.5 * sin(uTime * (0.6 + fract(aSeed) * 1.4) + aSeed * 5.0);
        vA = blink * blink * (1.0 - smoothstep(25.0, 40.0, d));
        vCol = color;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vA;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = exp(-r * r * 22.0) * vA;
        gl_FragColor = vec4(vCol * a * 2.2, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
