// Two-tone shading for the toon page: every surface is either lit by the moon (a pale, almost white tone)
// or in shade (a light cyan-blue), with a crisp edge between, cast shadows included. Built on three's
// Lambert material, so the moon's angle and its shadow map decide which; baked ambient occlusion, where a
// surface has it, only deepens the shade a little in creases so forms still read.

import * as THREE from 'three';

// The look, adjustable from toon-tuning.json.
export const TOON_DEFAULTS = {
  // linked: every colour follows the two bases below (see derivePalette); off, each is set on its own.
  // range: the shade colours a viewer's slider runs through, cyan to blue (see shadeAlong); start: where
  // the slider starts on the normal page (the middle of the range)
  palette: {
    linked: true, shade: '#8caaca', lit: '#f3f6f2',
    range: ['#8cc3ca', '#8cc0cc', '#8cafca', '#8caaca', '#8c96ca'], start: '#8cacca',
  },
  moon: { elevation: 19.5, azimuth: 163.3 },
  stone: { lit: '#f3f6f2', shade: '#8cc0cc', deep: '#679cb2', ao: 0.6 },
  bark: { lit: '#d9e3df', shade: '#6f9faf', deep: '#4f7f94', ao: 0.5 },
  leaves: { lit: '#e2eee4', shade: '#73aab0', deep: '#4f8794', ao: 0.4 },
  ground: { lit: '#e8eee6', shade: '#93c2c9', deep: '#7aaebb', ao: 0 },
  edge: { at: 0.09, softness: 0.045 },
  sky: { zenith: '#3e6f8e', horizon: '#a6cfd8', stars: 1, moonGlow: 1 },
  water: { color: '#6ea7b9', far: '#a0cbd5', reflect: 0.75, threshold: 0.7, glint: 1, ripples: 1, sparkle: 1, flow: 1 },
  outline: { on: true, color: '#4d7f95', strength: 0.7, depth: 0.012 },
  fog: { density: 0.0022 },
  falling: { on: false, amount: 1, size: 1, speed: 1, wind: 1 }, // laurel leaves drifting down
};

// Sky, sea, stone and leaves share one family of hues. Each colour keeps its place relative to one of two
// bases (hue offset, saturation ratio, lightness offset, measured on the defaults), so changing a base moves
// the whole family together and keeps it in harmony.
const SHADE_FAMILY = [['stone', 'shade'], ['stone', 'deep'], ['bark', 'shade'], ['bark', 'deep'], ['leaves', 'shade'],
  ['leaves', 'deep'], ['ground', 'shade'], ['ground', 'deep'], ['sky', 'zenith'], ['sky', 'horizon'], ['water', 'color'],
  ['water', 'far'], ['outline', 'color']];
const LIT_FAMILY = [['stone', 'lit'], ['bark', 'lit'], ['leaves', 'lit'], ['ground', 'lit']];
const hsl = (hex) => new THREE.Color(hex).getHSL({}, THREE.SRGBColorSpace); // as the eye sees it, not in linear light
const relation = (family, baseHex) => {
  const b = hsl(baseHex);
  return family.map(([g, k]) => {
    const c = hsl(TOON_DEFAULTS[g][k]);
    return { g, k, dh: c.h - b.h, sr: b.s > 1e-3 ? c.s / b.s : 1, dl: c.l - b.l };
  });
};
const RELATIONS = [
  ['shade', relation(SHADE_FAMILY, '#8cc0cc')], // the base the default colours above were made with
  ['lit', relation(LIT_FAMILY, TOON_DEFAULTS.palette.lit)],
];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Move the whole shade family to a new base colour: every colour in it turns, saturates and lightens as
// the base does, from the colours in 'from' (those set by hand included). For the viewer's colour slider.
export function shiftShades(t, from, toShade) {
  const a = hsl(from.palette.shade), b = hsl(toShade), c = new THREE.Color();
  for (const [g, k] of SHADE_FAMILY) {
    const o = hsl(from[g][k]);
    c.setHSL(((o.h + b.h - a.h) % 1 + 1) % 1, clamp01(a.s > 1e-3 ? o.s * b.s / a.s : o.s), clamp01(o.l + b.l - a.l), THREE.SRGBColorSpace);
    t[g][k] = '#' + c.getHexString();
  }
  t.palette.shade = toShade;
}

// Write the linked colours into t from its two bases (does nothing when the palette is unlinked).
export function derivePalette(t) {
  if (!t.palette.linked) return;
  const c = new THREE.Color();
  for (const [base, list] of RELATIONS) {
    const b = hsl(t.palette[base]);
    for (const { g, k, dh, sr, dl } of list) {
      c.setHSL(((b.h + dh) % 1 + 1) % 1, clamp01(b.s * sr), clamp01(b.l + dl), THREE.SRGBColorSpace);
      t[g][k] = '#' + c.getHexString();
    }
  }
}

// The viewer's colour slider: from 0 to 1 it runs through the colours of t.palette.range in order of hue,
// at an even pace of hue, saturation and lightness changing smoothly from each colour to the next.
const rangeStops = (t) => (t.palette.range || []).map(hsl).sort((p, q) => p.h - q.h);
export function shadeAlong(t, x) {
  const stops = rangeStops(t);
  if (!stops.length) return t.palette.shade;
  const h = stops[0].h + (stops[stops.length - 1].h - stops[0].h) * clamp01(x);
  let i = 0;
  while (i < stops.length - 2 && h > stops[i + 1].h) i++;
  const p = stops[i], q = stops[Math.min(i + 1, stops.length - 1)];
  const f = q.h > p.h ? clamp01((h - p.h) / (q.h - p.h)) : 0;
  const c = new THREE.Color().setHSL(h, p.s + (q.s - p.s) * f, p.l + (q.l - p.l) * f, THREE.SRGBColorSpace);
  return '#' + c.getHexString();
}
// where a colour sits along the slider (by its hue)
export function placeAlong(t, hex) {
  const stops = rangeStops(t);
  if (stops.length < 2) return 0;
  return clamp01((hsl(hex).h - stops[0].h) / (stops[stops.length - 1].h - stops[0].h));
}
// the slider's track: its colours, as a CSS gradient
export function rangeGradient(t) {
  return `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) => shadeAlong(t, i / 8)).join(', ')})`;
}

// One shared set of uniforms per kind of surface, so everything of a kind is retinted at once.
export function makeLook() {
  const tone = () => ({
    uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uAO: { value: 0 },
  });
  return {
    common: { uEdge: { value: 0.3 }, uSoft: { value: 0.02 }, uLightLum: { value: 1 } },
    stone: tone(), bark: tone(), leaves: tone(), ground: tone(),
  };
}

export function applyLook(look, t, lightLum) {
  for (const kind of ['stone', 'bark', 'leaves', 'ground']) {
    const u = look[kind], c = t[kind];
    u.uLit.value.set(c.lit);
    u.uShade.value.set(c.shade);
    u.uDeep.value.set(c.deep);
    u.uAO.value = c.ao;
  }
  look.common.uEdge.value = t.edge.at;
  look.common.uSoft.value = t.edge.softness;
  look.common.uLightLum.value = lightLum;
}

// kind: which colours; ao: read ambient occlusion from the red channel of the vertex colours;
// noFlip: keep authored normals on back faces (leaf cards shaded as one soft canopy)
export function toonMaterial(look, kind, { ao = false, noFlip = false, ...params } = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: ao, ...params });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, look.common, look[kind]);
    let fs = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uLit, uShade, uDeep;
uniform float uEdge, uSoft, uLightLum, uAO;`)
      // the vertex colours carry baked data, not colour: keep them out of the albedo
      .replace('#include <color_fragment>', ao ? 'float aoTerm = vColor.r;' : 'float aoTerm = 1.0;')
      .replace('#include <opaque_fragment>', `{
  // how much moonlight arrives here: its angle, and the shadows
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 2
  // two shadow maps of the same moon (see main.js): the fine one just ahead of the viewer where it reaches,
  // fading over to the wide one near its border
  float moon = max(dot(normal, directionalLights[ 0 ].direction), 0.0);
  if (receiveShadow) {
    float fine = getShadow(directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, 1.0,
      directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ]);
    float wide = getShadow(directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, 1.0,
      directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ]);
    vec3 fc = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
    vec2 off = abs(fc.xy - 0.5);
    float inFine = (1.0 - smoothstep(0.4, 0.48, max(off.x, off.y))) * step(fc.z, 1.0);
    moon *= mix(wide, fine, inFine);
  }
#else
  // read back from three's own lighting
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float base = max(dot(diffuseColor.rgb, LUMA), 1e-3);
  float moon = dot(reflectedLight.directDiffuse, LUMA) * PI / (base * uLightLum);
#endif
  float lit = smoothstep(uEdge - uSoft, uEdge + uSoft, moon);
  vec3 shade = mix(uDeep, uShade, mix(1.0, smoothstep(0.35, 0.9, aoTerm), uAO));
  outgoingLight = mix(shade, uLit, lit);
}
#include <opaque_fragment>`);
    if (noFlip) fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replaceAll('normal *= faceDirection;', ''));
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `toon-${kind}-${ao}-${noFlip}`;
  return m;
}
