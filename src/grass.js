// Dense meadow grass, placed on the GPU (approach adapted from the yili_sheep project).
// Blades live in a square tile that follows the camera, set a little ahead of it: each blade's coordinates
// wrap around the tile, so it keeps a fixed spot in the world and only swaps places at the tile's far edge.
// Three layers, ever sparser and wider blades from the feet outward, each blade fading in or out at its own
// random distance so there's no seam (beyond them the ground itself is tinted as meadow: blades there would
// cover a pixel or two each, which GPUs draw very wastefully). Blades gather
// into clumps and splay outward. Height and where grass grows come from the ground texture baked in
// world.js. Lighting, moon shadows and fog are three.js's own (a Lambert material, cheap for so many
// blades), so the grass sits in the same moonlight as the rest.

import * as THREE from 'three';
import { mulberry32, GLSL_NOISE } from './noise.js';
import { shared, MOON_DIR, GROUND_RECT } from './world.js';

const VERT_HEAD = /* glsl */ `
attribute vec4 aBlade;
uniform vec3 uCenter;
uniform float uSize, uWidth, uHeight, uTime, uAhead;
uniform vec2 uFadeIn, uFadeOut;
uniform sampler2D uGround;
uniform vec4 uGroundRect;
varying vec3 vGrass;
varying float vTip;
${GLSL_NOISE}
`;

// Replaces three's normal setup: places the blade in the world, then its normal and colour.
const VERT_BLADE = /* glsl */ `
// the tile sits ahead of the viewer, so few of its blades are wasted behind them
vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
vec2 c = uCenter.xz + fwd.xz * uAhead;
vec2 wxz = c + mod(aBlade.xy - c + 0.5 * uSize, uSize) - 0.5 * uSize;
float r1 = aBlade.z, r2 = aBlade.w;
// blades out of range or behind the viewer: dropped before any of the work below
{
  vec2 rel = wxz - uCenter.xz;
  float d0 = length(rel);
  if (d0 > uFadeOut.y + 0.6 || (uFadeIn.x >= 0.0 && d0 < uFadeIn.x - 0.6) || dot(rel, fwd.xz) - 1.6 * fwd.y < -2.2) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // beyond the far plane: the whole blade is clipped
    return;
  }
}

// pull blades toward the nearest of some jittered clump centres (irregular, never in rows)
const float CS = 0.45;
vec2 gcell = floor(wxz / CS - 0.5);
vec2 cell = gcell, centre = vec2(0.0);
float best = 1e9;
for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
  vec2 cc = gcell + vec2(float(i), float(j));
  vec2 cp = (cc + vec2(hash21(cc), hash21(cc + vec2(13.0, 7.0)))) * CS;
  float d2 = dot(cp - wxz, cp - wxz);
  if (d2 < best) { best = d2; cell = cc; centre = cp; }
}
float clumpy = 0.15 + 0.25 * vnoise2(wxz * 0.15 + 2.0); // gently: strong clumping leaves bare gaps between tufts
wxz = mix(wxz, centre, clumpy * (0.2 + 0.5 * r2));
vec2 splay = wxz - centre;
splay /= max(length(splay), 0.02);
float clumpH = 0.6 + 0.8 * hash21(cell + vec2(5.0, 19.0));

vec4 gr = texture2D(uGround, (wxz - uGroundRect.xy) / uGroundRect.z);
float dist = length(wxz - uCenter.xz);
float w = (1.0 - smoothstep(uFadeOut.x, uFadeOut.y, dist)) * gr.g;
if (uFadeIn.x >= 0.0) w *= smoothstep(uFadeIn.x, uFadeIn.y, dist);
float thr = fract(r1 * 7.31 + r2 * 3.17);
float alive = smoothstep(thr - 0.06, thr + 0.02, w) * smoothstep(0.0, 0.04, w); // none where nothing grows (water, paving)
// blades behind the viewer are not drawn
vec3 toBlade = vec3(wxz.x, gr.r, wxz.y) - cameraPosition;
if (dot(toBlade, fwd) < -1.5) alive = 0.0;

float tall = smoothstep(0.55, 0.8, vnoise2(wxz * 0.05 + 9.0));
float hgt = uHeight * (0.6 + 0.7 * r2) * clumpH * (0.75 + 1.0 * tall) * (0.4 + 0.6 * alive) * step(0.001, alive);
float wid = uWidth * (0.7 + 0.6 * r1) * alive;
float ang = r1 * 31.4 + r2 * 6.28;
vec2 side = vec2(-sin(ang), cos(ang));
float t = position.y;

// wind: gusts sweep across, blades splay from their clump and tremble a little
float gust = 0.5 + 0.5 * sin(uTime * 0.7 + wxz.x * 0.09 + wxz.y * 0.06) * vnoise2(wxz * 0.04 + uTime * 0.08);
float flutter = sin(uTime * 3.4 + r1 * 40.0) * (0.03 + 0.05 * gust);
vec2 bend = splay * (0.12 + 0.38 * r2) + vec2(0.8, 0.45) * (0.04 + 0.22 * gust) + side * flutter;
float k = pow(t, 1.5);
vec3 bladeWorld = vec3(wxz.x, gr.r, wxz.y);
bladeWorld.xz += side * position.x * wid + bend * k * hgt;
float b2 = min(dot(bend, bend), 0.9);
bladeWorld.y += t * hgt * sqrt(1.0 - b2 * k * 0.8);

// normal: the blade face turned toward the viewer, leaning toward the ground's normal with distance
float dk = 1.5 * pow(max(t, 0.001), 0.5);
vec3 tangent = normalize(vec3(bend.x * dk, 1.0, bend.y * dk));
vec3 N = normalize(cross(vec3(side.x, 0.0, side.y), tangent));
if (dot(N, cameraPosition - bladeWorld) < 0.0) N = -N;
N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.35 + 0.4 * smoothstep(3.0, 30.0, dist)));
vec3 objectNormal = N;

// colour: each clump a little different, about one blade in ten gone to straw, tips lighter
float dry = step(0.9, fract(r2 * 13.7 + r1 * 3.3));
vec3 baseC = vec3(0.1, 0.16, 0.08) * (0.8 + 0.4 * hash21(cell + vec2(9.0, 3.0)));
vec3 tipC = mix(mix(baseC, vec3(0.22, 0.29, 0.14), 0.4 + 0.4 * r1), vec3(0.36, 0.33, 0.19), dry * 0.85);
vGrass = mix(baseC * 0.35, tipC, smoothstep(0.0, 1.0, t));
vTip = t;
`;

function bladeGeometry(segs) {
  const pos = [];
  for (let i = 0; i < segs; i++) {
    const y = i / segs, w = 0.5 * (1 - Math.pow(y, 1.3));
    pos.push(-w, y, 0, w, y, 0);
  }
  pos.push(0, 1, 0);
  const idx = [];
  for (let i = 0; i < segs - 1; i++) {
    const a = 2 * i;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const l = 2 * (segs - 1);
  idx.push(l, l + 1, 2 * segs);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

function grassLayer(groundTex, { count, size, ahead, fadeIn = [-1, 0], fadeOut, width, height, segs, seed }) {
  const g = bladeGeometry(segs);
  const rng = mulberry32(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) a.set([rng() * size, rng() * size, rng(), rng()], i * 4);
  g.setAttribute('aBlade', new THREE.InstancedBufferAttribute(a, 4));
  g.instanceCount = count;

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uCenter: shared.uCamera,
      uTime: shared.uTime,
      uMoonDir: { value: MOON_DIR },
      uSize: { value: size },
      uAhead: { value: ahead },
      uWidth: { value: width },
      uHeight: { value: height },
      uFadeIn: { value: new THREE.Vector2(...fadeIn) },
      uFadeOut: { value: new THREE.Vector2(...fadeOut) },
      uGround: { value: groundTex },
      uGroundRect: { value: new THREE.Vector4(GROUND_RECT.minX, GROUND_RECT.minZ, GROUND_RECT.size, 0) },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <beginnormal_vertex>', VERT_BLADE)
      .replace('#include <begin_vertex>', 'vec3 transformed = bladeWorld;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;\nvarying float vTip;\nuniform vec3 uMoonDir;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrass;')
      // the vertex shader already turned each blade toward the viewer
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replaceAll('normal *= faceDirection;', ''))
      .replace('#include <opaque_fragment>', `{
  vec3 Lv = normalize((viewMatrix * vec4(uMoonDir, 0.0)).xyz);
  // looking toward the moon, it shines through the blades: their upper parts glow
  float back = pow(max(dot(normalize(-vViewPosition), Lv), 0.0), 2.0);
  outgoingLight += diffuseColor.rgb * vec3(0.7, 0.82, 1.0) * back * pow(vTip, 1.3) * 1.6;
}
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `meadow-${segs}`;
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.layers.set(1); // main camera only: the water reflection skips the grass
  return mesh;
}

export function buildMeadow(groundTex) {
  const group = new THREE.Group();
  // each tile reaches its fade-out distance ahead and across the field of view, and little behind
  // density falls off in steps (about 500, 110 and 30 blades a square metre) while blades widen, each layer
  // fading into the next, so walking along there is no ring where the grass suddenly thins
  group.add(grassLayer(groundTex, { count: 200000, size: 20, ahead: 4, fadeOut: [6, 11], width: 0.025, height: 0.34, segs: 2, seed: 11 }));
  group.add(grassLayer(groundTex, { count: 160000, size: 40, ahead: 9, fadeIn: [6, 11], fadeOut: [18, 26], width: 0.036, height: 0.36, segs: 1, seed: 17 }));
  group.add(grassLayer(groundTex, { count: 190000, size: 88, ahead: 22, fadeIn: [18, 26], fadeOut: [42, 64], width: 0.065, height: 0.4, segs: 1, seed: 23 }));
  return group;
}
