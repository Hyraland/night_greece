// Land layout: the walking loop, where each ruin stands, the height of the ground,
// and the terrain mesh itself. Water surface is at y = 0.

import * as THREE from 'three';
import { noise2, fbm, smoothstep, GLSL_NOISE } from './noise.js';

export const MOON_DIR = new THREE.Vector3(0.3, 0.37, -1).normalize();
export const shared = { uTime: { value: 0 }, uCamera: { value: new THREE.Vector3() } };

// ---------------------------------------------------------------- walking loop
// Runs of collinear points keep the path dead straight where it walks through a building:
// the avenue of giant columns, the tholos, the great temple (naos), the propylon and the colonnade hall.
const AVENUE = { c: [-20, 46.5], d: [0.872, 0.49] };
const THOLOS = { c: [33, 33], d: [0.537, -0.844] };
const NAOS = { c: [44, -31], d: [0, -1] };
const GATE = { c: [-48.5, -75], d: [-0.519, 0.855] };
const HALL = { c: [-59.5, -20], d: [0.0995, 0.995] };
const along = ({ c, d }, k) => [c[0] + d[0] * k, c[1] + d[1] * k];
const straight = (line, half) => [-half, -half / 2, 0, half / 2, half].map((k) => along(line, k));
const CTRL = [
  ...straight(AVENUE, 26),
  ...straight(THOLOS, 26),
  ...straight(NAOS, 33),
  [33, -80], [18, -89], [-12, -99],
  along(GATE, -16.4), along(GATE, -8), along(GATE, 0), along(GATE, 8), along(GATE, 16.4),
  ...straight(HALL, 24),
  [-51, 14],
];
export const PATH_POINTS = CTRL;
export const path = new THREE.CatmullRomCurve3(
  CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
export const PATH_LEN = path.getLength();

// A loop for the automatic stroll: by default the walking loop itself; a page may stroll a variant of it
// (points as [x, z]) without moving anything that was laid out along the loop.
export function makeRoute(points) {
  const curve = points === CTRL ? path : new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  const length = curve === path ? PATH_LEN : curve.getLength();
  const pts = curve.getSpacedPoints(NS);
  const nearest = (x, z) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < NS; i++) {
      const dx = pts[i].x - x, dz = pts[i].z - z, d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bi = i; }
    }
    return { u: bi / NS, d: Math.sqrt(best) };
  };
  return { curve, length, nearest };
}

const NS = 800;
const PX = new Float32Array(NS), PZ = new Float32Array(NS);
{
  const pts = path.getSpacedPoints(NS);
  for (let i = 0; i < NS; i++) { PX[i] = pts[i].x; PZ[i] = pts[i].z; }
}

export function nearestOnPath(x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < NS; i++) {
    const dx = PX[i] - x, dz = PZ[i] - z, d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; }
  }
  return { u: bi / NS, d: Math.sqrt(best) };
}

// Distance to the loop and inside/outside, baked on a coarse grid.
const GMIN = -330, GC = 3, GN = 221;
const FD = new Float32Array(GN * GN), FI = new Float32Array(GN * GN);
for (let j = 0; j < GN; j++) {
  const z = GMIN + j * GC;
  for (let i = 0; i < GN; i++) {
    const x = GMIN + i * GC;
    let best = Infinity, inside = false;
    for (let k = 0, l = NS - 1; k < NS; l = k++) {
      const dx = PX[k] - x, dz = PZ[k] - z, d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
      if ((PZ[k] > z) !== (PZ[l] > z) && x < ((PX[l] - PX[k]) * (z - PZ[k])) / (PZ[l] - PZ[k]) + PX[k]) inside = !inside;
    }
    FD[j * GN + i] = Math.sqrt(best);
    FI[j * GN + i] = inside ? 1 : 0;
  }
}
let fD = 0, fI = 0;
function sampleField(x, z) {
  const fx = (x - GMIN) / GC, fz = (z - GMIN) / GC;
  if (fx < 0 || fz < 0 || fx >= GN - 1 || fz >= GN - 1) { fD = 400; fI = 0; return; }
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, a = j * GN + i;
  const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
  fD = FD[a] * w00 + FD[a + 1] * w10 + FD[a + GN] * w01 + FD[a + GN + 1] * w11;
  fI = FI[a] * w00 + FI[a + 1] * w10 + FI[a + GN] * w01 + FI[a + GN + 1] * w11;
}
export function pathDistance(x, z) { sampleField(x, z); return fD; }

// ---------------------------------------------------------------- ruin sites
// A building straddling the path at (px, pz), its front (local +z) turned toward the approaching walker.
export function onPath(px, pz) {
  const { u } = nearestOnPath(px, pz);
  const p = path.getPointAt(u), t = path.getTangentAt(u);
  return { x: p.x, z: p.z, rot: Math.atan2(-t.x, -t.z) };
}

// A spot `offset` metres from the path, on its outer (out = true) or inner side, turned to face the path.
export function besidePath(px, pz, offset, out = true) {
  const { u } = nearestOnPath(px, pz);
  const p = path.getPointAt(u), t = path.getTangentAt(u);
  let nx = -t.z, nz = t.x;
  sampleField(p.x + nx * 6, p.z + nz * 6);
  if ((fI > 0.5) === out) { nx = -nx; nz = -nz; }
  return { x: p.x + nx * offset, z: p.z + nz * offset, rot: Math.atan2(-nx, -nz) };
}

// Every ruin is modelled in Blender (blender/build_colossi.py) and loaded from assets/<asset>.glb by ruins.js.
// rot: rotation about y; local +z maps to world (sin rot, cos rot). pad: terrain flattened under the ruin.
// y: 'pad' lifts a ruin built at z = 0 onto its flattened ground (the hill temple).
const site = (asset, node, where, pad, extra = {}) => ({ asset, node, ...where, pad, ...extra });
export const SITES = [
  site('avenue', 'Avenue', onPath(...AVENUE.c), { hw: 13, hl: 32, h: -0.42, blend: 5 }),
  site('tholos', 'Tholos', onPath(...THOLOS.c), { r: 25, h: -0.42, blend: 6 }),
  site('naos', 'Naos', onPath(...NAOS.c), { hw: 22.5, hl: 32.5, h: -0.42, blend: 6 }),
  site('colossal_temple', 'ColossalTemple', besidePath(28, -76, 23), { hw: 27, hl: 16, h: -0.42, blend: 7 }),
  site('colossal_statues', 'GiantBase', besidePath(-48, 21, 18), { hw: 10, hl: 10, h: -0.42, blend: 5 }),
  site('propylon', 'Propylon', onPath(...GATE.c), { hw: 16.5, hl: 15.6, h: -0.42, blend: 5 }),
  site('colonnade_hall', 'ColonnadeHall', onPath(...HALL.c), { hw: 14, hl: 29.5, h: -0.42, blend: 5 }),
  site('podium_temple', 'PodiumTemple', besidePath(-20, 46.5, 47), { hw: 19.5, hl: 32.5, h: 0.5, blend: 6 }),
  site('stoa', 'Stoa', besidePath(-52, -69, 27), { hw: 26, hl: 10, h: -0.42, blend: 5 }),
  site('shrine', 'Shrine', besidePath(14, 57, 44), { hw: 15.7, hl: 24, h: 0.33, blend: 8 }),
  site('hill_temple', 'HillTemple', { x: -10, z: -22, rot: Math.PI / 2 }, { hw: 20, hl: 30, h: null, blend: 11 }, { y: 'pad' }),
];

export function toWorld(site, lx, lz) {
  const c = Math.cos(site.rot), s = Math.sin(site.rot);
  return [site.x + lx * c + lz * s, site.z - lx * s + lz * c];
}
export function toLocal(site, x, z) {
  const dx = x - site.x, dz = z - site.z, c = Math.cos(site.rot), s = Math.sin(site.rot);
  return [dx * c - dz * s, dx * s + dz * c];
}
function padDistance(site, x, z) {
  const p = site.pad;
  if (p.r !== undefined) return Math.max(0, Math.hypot(x - site.x, z - site.z) - p.r);
  const [lx, lz] = toLocal(site, x, z);
  return Math.hypot(Math.max(Math.abs(lx) - p.hw, 0), Math.max(Math.abs(lz) - p.hl, 0));
}
export function nearSite(x, z, margin) {
  for (const s of SITES) if (padDistance(s, x, z) < margin) return s;
  return null;
}

// ---------------------------------------------------------------- height
// The two-tone page shows the ruins standing in a flat shallow sea: once it calls useFlatGround, the land
// (hills, banks, islets) is gone and only the ruins' own plots and the giant laurel's mound remain.
let flatGround = false;
export function useFlatGround() { flatGround = true; }
// the height the land has without that: hills, banks and all
export function landHeightAt(x, z) {
  const flat = flatGround;
  flatGround = false;
  const h = heightAt(x, z);
  flatGround = flat;
  return h;
}

function rawHeight(x, z) {
  if (flatGround) return -0.42;
  sampleField(x, z);
  const d = fD, inside = fI;
  let h = -0.37 + 0.09 * fbm(x * 0.045, z * 0.045, 3) + 0.025 * noise2(x * 0.35, z * 0.35);

  // The island inside the loop rises into a wooded hill.
  const sIn = 15 + 6 * noise2(x * 0.03 + 11.3, z * 0.03 - 4.1);
  const rIn = smoothstep(sIn, sIn + 13, d);
  const hillIn = 0.9 + Math.min(Math.max(d - sIn, 0), 60) * 0.11 + 2.2 * fbm(x * 0.02 + 5.2, z * 0.02 + 9.7, 4);

  // Outside: banks to the north and sides, open shallow sea toward the moon (south).
  const open = smoothstep(-25, 25, z + 22 * noise2(x * 0.008 + 3.3, 1.7));
  const sOut = 21 + 14 * noise2(x * 0.022 - 4.4, z * 0.022 + 2.2);
  const rOut = smoothstep(sOut, sOut + 24, d) * open;
  const hillOut = 0.8 + Math.min(Math.max(d - sOut, 0), 120) * 0.07 + 5 * Math.max(0, fbm(x * 0.011, z * 0.011, 4) + 0.25);

  h += inside * rIn * hillIn + (1 - inside) * rOut * hillOut;
  h -= (1 - inside) * (1 - open) * smoothstep(60, 260, d) * 0.9;

  // Small islets scattered in the shallows, kept clear of the walking line.
  const isl = fbm(x * 0.03 + 31.7, z * 0.03 - 17.2, 3);
  h += Math.max(0, isl - 0.36) * 10 * smoothstep(6, 14, d) * (1 - smoothstep(35, 70, d) * (1 - inside)) * (1 - inside * rIn);
  return h;
}

for (const s of SITES) {
  if (s.pad.h !== null) continue;
  let sum = 0, n = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const [x, z] = toWorld(s, a * s.pad.hw, b * s.pad.hl);
    sum += rawHeight(x, z); n++;
  }
  s.pad.h = sum / n - 0.25;
}
for (const s of SITES) s.y = s.y === 'pad' ? s.pad.h : 0;

// The ancient laurel on the island's north slope, and a few ruins at its foot (between tree and path)
// to show how big it is.
export function slopeAt(x, z) {
  return Math.hypot(heightAt(x + 1, z) - heightAt(x - 1, z), heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;
}
const FLATS = []; // round patches of levelled ground: { x, z, r, h, blend }
export const GIANT_LAUREL = (() => {
  let best = null;
  for (let x = -32; x <= 2; x += 1) for (let z = -4; z <= 22; z += 1) {
    const h = heightAt(x, z);
    if (h < 1.5 || h > 7 || nearSite(x, z, 9) || pathDistance(x, z) < 22) continue;
    const score = -slopeAt(x, z) * 10 - Math.hypot(x + 15, z - 10) * 0.05;
    if (!best || score > best.score) best = { x, z, score };
  }
  return best;
})();
if (GIANT_LAUREL) {
  const { x, z } = GIANT_LAUREL;
  const p = path.getPointAt(nearestOnPath(x, z).u);
  const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
  const rx = x + (dx / d) * 8, rz = z + (dz / d) * 8;
  const ruins = site('laurel_ruins', 'LaurelRuins', { x: rx, z: rz, rot: Math.atan2(dx, dz) },
    { hw: 5.5, hl: 3.5, h: heightAt(rx, rz) - 0.15, blend: 3 });
  ruins.y = ruins.pad.h;
  SITES.push(ruins);
  GIANT_LAUREL.h = heightAt(x, z);
  // the ground levels out around its foot, so the buttress roots lie on it all the way round
  FLATS.push({ x, z, r: 6.5, h: GIANT_LAUREL.h, blend: 5 });
}

export function heightAt(x, z) {
  let h = rawHeight(x, z);
  for (const s of SITES) {
    const w = 1 - smoothstep(0, s.pad.blend, padDistance(s, x, z));
    if (w > 0) h += (s.pad.h - h) * w;
  }
  for (const f of FLATS) {
    const w = 1 - smoothstep(f.r, f.r + f.blend, Math.hypot(x - f.x, z - f.z));
    if (w > 0) h += (f.h - h) * w;
  }
  return h;
}

// What the walker can stand on. Each ruin brings a walk grid baked in Blender: per cell, the surfaces with
// headroom above them (int16 centimetres) and the lowest solid point. Trees add round colliders.
export const walkGrids = []; // { site, x0, z0, res, nx, nz, layers, data }
export const colliders = []; // { x, z, r }
export const gaze = [];      // { x, z, y, r, weight? }: things the stroll turns to look up at

export const STEP_UP = 0.55, HEADROOM = 1.7;

// Height of the surface underfoot at (x, z) for someone whose feet are at `feet`: the highest place to stand
// that is no more than a step above them and has headroom, or the terrain if no ruin covers it.
// Returns null where there is nowhere to stand (inside a wall or column, under a too-low lintel).
export function groundAt(x, z, feet = Infinity) {
  const terrain = heightAt(x, z);
  let best = -Infinity, terrainOpen = true;
  for (const g of walkGrids) {
    const [lx, lz] = toLocal(g.site, x, z);
    const i = Math.floor((lx - g.x0) / g.res), j = Math.floor((lz - g.z0) / g.res);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
    const o = (j * g.nx + i) * (2 * g.layers + 1), d = g.data;
    let highest = -Infinity;
    for (let k = 0; k < g.layers; k++) {
      if (d[o + k] === -32768) break;
      const top = d[o + k] / 100 + g.site.y;
      highest = Math.max(highest, top);
      if (top < terrain - 0.05) continue; // buried
      if (d[o + g.layers + k] / 100 >= HEADROOM && top <= feet + STEP_UP && top > best) best = top;
    }
    // stone in the way just above the ground blocks it, unless the ground has buried that stone
    const bottom = d[o + 2 * g.layers];
    if (bottom !== 32767 && bottom / 100 + g.site.y < terrain + HEADROOM && highest > terrain + 0.05) terrainOpen = false;
  }
  if (terrainOpen && terrain > best) best = terrain;
  return best === -Infinity ? null : best;
}

// ---------------------------------------------------------------- terrain mesh
export const CENTER = { x: -8, z: -20 };
export const WORLD_RADIUS = 220; // free walking stops here, a little beyond the outermost trees and ruins

// groundTex: the meadow map from buildGroundTexture (where grass grows), so the ground can take on its colour
export function buildTerrain(groundTex) {
  // Grid lines: within INNER of the centre they run through the centres of the ground texture's texels, so the
  // ground one sees and the grass roots (which read that texture) are the same surface, and its heights come
  // straight from the texture's data; further out they spread apart toward the edge, 1000 m away.
  const HALF = 1000, INNER = 240;
  const { minX, minZ, size } = GROUND_RECT, R = groundTex.image.width, cell = size / R;
  const heights = groundTex.userData.heights;
  const f = (u) => u * (0.25 + 0.75 * u * u * u * u); // the outer spacing: dense near the middle
  const lines = (min, centre) => {
    const inner = [], outer = [];
    for (let i = 0; i < R; i++) {
      const v = min + (i + 0.5) * cell;
      if (Math.abs(v - centre) <= INNER) inner.push({ v, i });
    }
    for (let k = 0; k <= 448; k++) {
      const off = HALF * f((k / 448) * 2 - 1);
      if (Math.abs(off) > INNER + 4) outer.push({ v: centre + off, i: -1 });
    }
    return [...outer.filter((l) => l.v < centre), ...inner, ...outer.filter((l) => l.v > centre)];
  };
  const xs = lines(minX, CENTER.x), zs = lines(minZ, CENTER.z);
  const NX = xs.length - 1, NZ = zs.length - 1;
  const cnt = (NX + 1) * (NZ + 1);
  const pos = new Float32Array(cnt * 3);
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      const k = (j * (NX + 1) + i) * 3, gx = xs[i], gz = zs[j];
      const h = gx.i >= 0 && gz.i >= 0 ? heights[gz.i * R + gx.i] : heightAt(gx.v, gz.v);
      pos[k] = gx.v; pos[k + 1] = h; pos[k + 2] = gz.v;
    }
  }
  const idx = new Uint32Array(NX * NZ * 6);
  let q = 0;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b;
    idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal.array;
  const col = new Float32Array(cnt * 3);
  const c = new THREE.Color(), t = new THREE.Color();
  for (let v = 0; v < cnt; v++) {
    const x = pos[v * 3], h = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const slope = 1 - nrm[v * 3 + 1];
    const n = noise2(x * 0.15, z * 0.15) * 0.5 + 0.5;
    const n2 = noise2(x * 0.04 + 9, z * 0.04 - 3) * 0.5 + 0.5;
    if (h < -0.04) {
      c.setRGB(0.30, 0.31, 0.31).multiplyScalar(0.8 + 0.3 * n);
      c.multiplyScalar(1 - Math.min(1, Math.max(0, -h - 0.35)) * 0.5);
    } else if (h < 0.35) {
      c.setRGB(0.36, 0.35, 0.30).multiplyScalar(0.8 + 0.3 * n);
      t.setRGB(0.20, 0.25, 0.15);
      c.lerp(t, smoothstep(0.1, 0.35, h) * 0.7);
    } else {
      // soil under the meadow: dark, so the gaps between blades read as shadow, not bare ground
      c.setRGB(0.06, 0.09, 0.05).lerp(t.setRGB(0.16, 0.15, 0.10), n2 * 0.5);
      c.multiplyScalar(0.8 + 0.35 * n);
      c.lerp(t.setRGB(0.40, 0.39, 0.35), smoothstep(0.4, 0.6, slope)); // bare rock only where grass gives up (past ~55 degrees)
    }
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uMoonDir = { value: MOON_DIR };
    sh.uniforms.uGround = { value: groundTex };
    sh.uniforms.uGroundRect = { value: new THREE.Vector4(GROUND_RECT.minX, GROUND_RECT.minZ, GROUND_RECT.size, 0) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform float uTime;
uniform vec3 uMoonDir;
uniform sampler2D uGround;
uniform vec4 uGroundRect;
${GLSL_NOISE}
float caustic(vec2 p, float t) {
  vec2 q = p;
  float v = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    q += 0.55 * vec2(sin(q.y * 1.3 + t * 0.7 + fi * 1.7), cos(q.x * 1.1 - t * 0.6 + fi * 2.3));
    v += abs(sin(q.x * 1.9) * sin(q.y * 1.9));
  }
  return pow(clamp(1.0 - v / 3.0, 0.0, 1.0), 5.0);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// where the meadow grows the ground takes its colour, streaked like blades, so beyond the reach of the
// blades themselves the field still reads as full grass
float meadow = texture2D(uGround, (vWPos.xz - uGroundRect.xy) / uGroundRect.z).g;
float far = smoothstep(5.0, 30.0, length(vWPos - cameraPosition));
{
  float streak = vnoise2(vWPos.xz * vec2(7.0, 7.0)) * 0.6 + vnoise2(vWPos.xz * 23.0 + 4.0) * 0.4;
  float patchy = vnoise2(vWPos.xz * 0.35 + 7.0);
  float clumps = vnoise2(vWPos.xz * 1.6 + 2.0);
  vec3 grass = mix(vec3(0.07, 0.105, 0.05), vec3(0.15, 0.2, 0.1), streak * 0.6 + patchy * 0.4);
  grass *= 0.75 + 0.45 * clumps; // tufts and hollows, so a far slope looks rough, not mown
  diffuseColor.rgb = mix(diffuseColor.rgb, grass, meadow * mix(0.5, 1.0, far));
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
// the ground under a meadow lies in the shade of its blades: the moon lights their tips, not the soil;
// far off, where the ground stands in for the grass itself, it takes more of the light
reflectedLight.directDiffuse *= mix(1.0, mix(0.22, 0.5, smoothstep(20.0, 60.0, length(vWPos - cameraPosition))), meadow);
reflectedLight.indirectDiffuse *= mix(1.0, 0.75, meadow);
reflectedLight.directSpecular *= smoothstep(-0.05, 0.0, vWPos.y);
reflectedLight.indirectSpecular *= smoothstep(-0.05, 0.0, vWPos.y);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float under = smoothstep(-0.03, -0.12, vWPos.y);
  vec2 cp = vWPos.xz * 0.9 + uMoonDir.xz * vWPos.y * 2.0;
  float ca = caustic(cp, uTime) * 0.7 + caustic(cp * 1.7 + 3.1, uTime * 1.3) * 0.5;
  float fade = 1.0 - smoothstep(15.0, 60.0, length(vWPos - cameraPosition));
  totalEmissiveRadiance += vec3(0.55, 0.7, 1.0) * ca * under * fade * 0.10;
}`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// Ground height baked for the water shader (shoreline fade and depth tint).
// Ground data for the grass shader: R = ground height, G = how thickly grass grows here
// (none in the water, on the ruins or on steep banks; thicker and thinner meadows elsewhere).
export const GROUND_RECT = { minX: CENTER.x - 320, minZ: CENTER.z - 320, size: 640 };
// Is there stone on the ground here (or within a stride of it)? Read from the ruins' walk grids: any
// surface standing above the ground, or solid stone where one would stand. Grass grows right up to the
// stones, not over the whole plot set aside for a ruin.
function stoneAt(x, z, ground) {
  if (!nearSite(x, z, 1)) return false;
  for (const [dx, dz] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) {
    const g = groundAt(x + dx, z + dz, ground + 0.3);
    if (g === null || g > heightAt(x + dx, z + dz) + 0.05) return true;
  }
  return false;
}

// Built after the ruins have loaded (their walk grids say where the stones lie).
export function buildGroundTexture() {
  const R = 768, { minX, minZ, size } = GROUND_RECT, cell = size / R;
  const h = new Float32Array(R * R);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    h[j * R + i] = heightAt(minX + (i + 0.5) * cell, minZ + (j + 0.5) * cell);
  }
  const data = new Uint16Array(R * R * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const k = j * R + i, x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
    const hx = h[j * R + Math.min(R - 1, i + 1)] - h[j * R + Math.max(0, i - 1)];
    const hz = h[Math.min(R - 1, j + 1) * R + i] - h[Math.max(0, j - 1) * R + i];
    const slope = Math.hypot(hx, hz) / (2 * cell);
    // grass right down to the water's edge and up slopes of about 50 degrees, kept off the stones
    const grow = smoothstep(0.0, 0.1, h[k]) * (1 - smoothstep(1.2, 2.0, slope)) * (stoneAt(x, z, h[k]) ? 0 : 1)
      * (0.8 + 0.2 * smoothstep(-0.3, 0.3, fbm(x * 0.05, z * 0.05, 3)));
    data.set([toHalf(h[k]), toHalf(grow), 0, toHalf(1)], k * 4);
  }
  const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  tex.userData.heights = h; // the terrain mesh is built on these same heights
  return tex;
}

export const HEIGHT_RECT = { minX: CENTER.x - 320, minZ: CENTER.z - 320, size: 640, lo: -1.5, hi: 1.5 };
export function buildHeightTexture() {
  const R = 512, data = new Uint8Array(R * R);
  const { minX, minZ, size, lo, hi } = HEIGHT_RECT;
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const h = heightAt(minX + ((i + 0.5) / R) * size, minZ + ((j + 0.5) / R) * size);
    data[j * R + i] = Math.round(Math.min(1, Math.max(0, (h - lo) / (hi - lo))) * 255);
  }
  const tex = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
