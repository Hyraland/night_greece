// The ruins, all modelled in Blender (blender/build_colossi.py): loaded from assets/*.glb,
// dressed in moonlit marble and placed at their SITES, each with its walk grid.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLSL_NOISE } from './noise.js';
import { SITES, toWorld, walkGrids, gaze } from './world.js';
import { evenNormals } from './normals.js';

// Marble whose vertex colours were baked in Blender: R = ambient occlusion, G = grime and rain streaks,
// B = the tone of each block (also seeds its own grain and veins), A = 1 on the bevelled arrises.
// Each block reads as its own piece of stone: clouding and a few faint veins in a frame turned and shifted
// per block. A bump in the block's own coordinates gives the weathered surface (soft erosion, pits, and
// up close a sugary grain), fading out with distance before it can shimmer; arrises chip and wear.
// Adjustable from tuning.json: tints for the moonlit and the shaded side, and how
// strongly each kind of weathering shows.
export const marbleLook = {
  uLitTint: { value: new THREE.Color(1, 1, 1) },
  uShadeTint: { value: new THREE.Color(1, 1, 1) },
  uAO: { value: 1 },
  uGrime: { value: 1 },
  uVein: { value: 1 },
  uRelief: { value: 1 },
  uWet: { value: 1 },
};

export function marbleMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 0.72, metalness: 0, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, marbleLook);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vOPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOPos = position;\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vOPos;
uniform vec3 uLitTint, uShadeTint;
uniform float uAO, uGrime, uVein, uRelief, uWet;
${GLSL_NOISE}
// round, bowl-shaped dimples scattered on a jittered grid (p in cells): 0 outside a pit, up to 1 at its bottom;
// a fraction 'chance' of the cells hold one, each well inside its own cell so no neighbours need checking
float pit(vec3 p, float chance) {
  vec3 i = floor(p), f = fract(p);
  float h = hash31(i);
  if (h > chance) return 0.0;
  vec3 c = 0.5 + (vec3(hash31(i + 17.1), hash31(i + 41.7), hash31(i + 73.3)) - 0.5) * 0.4;
  float r = 0.12 + 0.18 * fract(h * 37.0);
  float d = length(f - c) / r;
  return d < 1.0 ? (1.0 - d * d) * (1.0 - d * d) : 0.0;
}`)
      .replace('#include <color_fragment>', `
float ao = vColor.r, baked = vColor.g, tone = vColor.b;
#ifdef USE_COLOR_ALPHA
float arris = vColor.a;
#else
float arris = 0.0;
#endif
// this block's own frame: turned about the vertical and shifted far through the noise
float ang = tone * 6.2832;
vec3 q = vec3(cos(ang) * vOPos.x + sin(ang) * vOPos.z, vOPos.y, -sin(ang) * vOPos.x + cos(ang) * vOPos.z) + tone * vec3(91.7, 37.3, 53.9);
float fw = length(fwidth(vOPos)); // metres per pixel
float near = 1.0 - smoothstep(0.006, 0.03, fw);
float close = 1.0 - smoothstep(0.0015, 0.006, fw);

// broad clouding runs on across the joints, so a wall reads as one built mass; blocks differ only a little
float cloud = vnoise3(vOPos * 0.9) * 0.6 + vnoise3(q * 3.1) * 0.4;
diffuseColor.rgb *= 0.95 + 0.1 * tone;
diffuseColor.rgb *= mix(vec3(1.0, 0.993, 0.98), vec3(0.98, 0.99, 1.0), fract(tone * 7.31));
diffuseColor.rgb *= 0.9 + 0.14 * cloud;

// veins: the odd faint, ragged vein along a twice-warped field, its width wandering; most of the stone has none,
// as on weathered ancient marble
vec3 wq = q * 0.5 + vec3(vnoise3(q * 1.1), vnoise3(q * 1.1 + 19.1), vnoise3(q * 1.1 - 7.7)) * 1.2;
wq += (vec3(vnoise3(q * 6.0), vnoise3(q * 6.0 + 3.3), vnoise3(q * 6.0 - 5.1)) - 0.5) * 0.12 * near;
float vn = vnoise3(wq), dv = abs(vn - 0.5);
float vw = 0.004 + 0.016 * vnoise3(q * 0.9 + 40.0);
float vein = 1.0 - smoothstep(vw * 0.3, vw + fwidth(vn), dv);
vein *= smoothstep(0.55, 0.8, vnoise3(q * 0.35 + 9.0));
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 0.84, 0.9), min(1.0, vein * 0.3 * uVein));

// worn arrises: rubbed a little lighter, and broken where chips came away (fresh, whiter stone)
float chipN = vnoise3(q * 7.0) * 0.65 + vnoise3(q * 19.0) * 0.35;
float chip = arris * smoothstep(0.47, 0.6, chipN);
diffuseColor.rgb *= 1.0 + arris * 0.06;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.95, 0.93) * (0.9 + 0.1 * tone), chip * 0.55);

float grime = clamp(baked * 0.8 + (1.0 - smoothstep(0.0, 1.4 + cloud, vWPos.y)) * 0.4, 0.0, 1.0) * (1.0 - chip);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.7, 0.75, 0.72), min(1.0, grime * 0.6 * uGrime));
float wet = 1.0 - smoothstep(0.0, 0.16 + 0.08 * cloud, vWPos.y);
diffuseColor.rgb *= mix(1.0, 0.5, wet * uWet);
diffuseColor.rgb *= mix(1.0, ao, uAO);

// the weathered surface as a height in metres: soft erosion, pits, sugary grain, chips
float relief = 0.012 * vnoise3(q * 2.7 + 11.0) + 0.006 * vnoise3(q * 6.1 - 4.0) * near;
if (near > 0.0) relief -= (0.0025 * pit(q * 14.0, 0.35) + 0.0012 * pit(q * 37.0 + 5.0, 0.45)) * near;
if (close > 0.0) relief += 0.0006 * vnoise3(q * 90.0) * close;
relief -= 0.006 * chip;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.9, chip);
roughnessFactor = mix(roughnessFactor, 0.4, wet);
roughnessFactor = mix(roughnessFactor, 1.0, smoothstep(0.0, -0.04, vWPos.y));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 sp = -vViewPosition, sx = dFdx(sp), sy = dFdy(sp);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(relief) * r1 + dFdy(relief) * r2) * uRelief;
  normal = normalize(abs(det) * normal - grad);
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse *= uLitTint;
reflectedLight.directSpecular *= uLitTint;
reflectedLight.indirectDiffuse *= uShadeTint;
float dry = smoothstep(-0.05, 0.0, vWPos.y);
reflectedLight.directSpecular *= dry;
reflectedLight.indirectSpecular *= dry;`);
  };
  m.customProgramCacheKey = () => 'marble-weathered';
  marbleLook.material = m;
  return m;
}

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
loader.setDRACOLoader(draco);

const fetchJSON = (url) => fetch(url).then((r) => r.json());
const fetchGrid = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => new Int16Array(b));

// Beyond this distance from a ruin's centre (most are 40-70 m across), its simplified copy is drawn.
const LOD_DISTANCE = 70;

// material: what the ruins are drawn with (the two-tone page brings its own); the moonlit marble otherwise
export async function loadRuins({ material = marbleMaterial() } = {}) {
  const group = new THREE.Group();
  const assets = [...new Set(SITES.map((s) => s.asset))];
  const loaded = Object.fromEntries(await Promise.all(assets.map(async (name) => {
    const [gltf, meta] = await Promise.all([loader.loadAsync(`assets/${name}.glb`), fetchJSON(`assets/${name}.json`)]);
    return [name, { gltf, meta }];
  })));

  await Promise.all(SITES.map(async (site) => {
    const { gltf, meta } = loaded[site.asset];
    const src = gltf.scene.getObjectByName(site.node);
    if (!src) throw new Error(`ruins: no node ${site.node} in ${site.asset}.glb`);
    const info = meta[site.node];
    // full detail near by, the simplified copy (a quarter of the triangles) from LOD_DISTANCE on;
    // three picks per camera, so the water's reflection makes its own choice
    const ruin = new THREE.LOD();
    const levels = [[src, 0]];
    const far = info.lod && gltf.scene.getObjectByName(info.lod);
    if (far) levels.push([far, LOD_DISTANCE]);
    for (const [node, distance] of levels) {
      const mesh = new THREE.Mesh(node.geometry, material);
      mesh.castShadow = mesh.receiveShadow = true;
      ruin.addLevel(mesh, distance, 0.08);
    }
    ruin.position.set(site.x, site.y, site.z);
    ruin.rotation.y = site.rot;
    group.add(ruin);

    for (const g of info.gaze ?? []) {
      const [x, z] = toWorld(site, g.x, g.z);
      gaze.push({ x, z, y: g.y + site.y, r: g.r });
    }
    const w = info.walk;
    walkGrids.push({ site, ...w, data: await fetchGrid(`assets/${w.file}`) });
  }));
  draco.dispose();
  evenNormals(group); // flat stone faces shade as one under the low moon
  return group;
}
