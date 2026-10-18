// Shallow mirror water: planar reflection distorted by small waves and footstep ripples,
// a glittering moon path, the sea floor showing through where it is shallow.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { GLSL_NOISE } from './noise.js';
import { MOON_DIR, shared, HEIGHT_RECT } from './world.js';

const MAX_RIPPLES = 16;

const WaterShader = {
  name: 'MoonWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uMoonDir: { value: new THREE.Vector3() },
    uMoonColor: { value: new THREE.Color() },
    uRipples: { value: [] },
    uHeight: { value: null },
    uHeightRect: { value: new THREE.Vector4() },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWPos;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uMoonDir;
    uniform vec3 uMoonColor;
    uniform vec4 uRipples[${MAX_RIPPLES}];
    uniform sampler2D uHeight;
    uniform vec4 uHeightRect;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec4 vUv;
    varying vec3 vWPos;
    ${GLSL_NOISE}

    float waves(vec2 p, float detail) {
      float t = uTime;
      float h = 0.0;
      h += sin(dot(p, vec2(0.62, 0.78)) * 0.9 + t * 0.7) * 0.012;
      h += sin(dot(p, vec2(-0.85, 0.52)) * 1.7 + t * 1.1) * 0.006;
      h += sin(dot(p, vec2(0.21, -0.97)) * 3.3 + t * 1.7) * 0.0035;
      h += (vnoise2(p * 1.3 + vec2(t * 0.22, t * 0.15)) - 0.5) * 0.012;
      h += (vnoise2(p * 3.7 - vec2(t * 0.35, -t * 0.28)) - 0.5) * 0.005 * detail;
      h += (vnoise2(p * 9.1 + vec2(-t * 0.6, t * 0.5)) - 0.5) * 0.0022 * detail;
      return h;
    }

    float ripples(vec2 p) {
      float h = 0.0;
      for (int i = 0; i < ${MAX_RIPPLES}; i++) {
        vec4 r = uRipples[i];
        float age = uTime - r.z;
        if (r.w <= 0.0 || age < 0.0 || age > 7.0) continue;
        float d = length(p - r.xy);
        float x = d - age * 0.85;
        float env = exp(-x * x * 2.2) * exp(-age * 0.55) / (1.0 + d * 1.2);
        h += sin(x * 10.0) * env * 0.022 * r.w;
      }
      return h;
    }

    float surface(vec2 p, float detail) { return waves(p, detail) + ripples(p); }

    void main() {
      vec3 toCam = cameraPosition - vWPos;
      float dist = length(toCam);
      vec3 V = toCam / dist;
      float detail = 1.0 - smoothstep(20.0, 120.0, dist);

      float e = 0.04 + dist * 0.002;
      float h0 = surface(vWPos.xz, detail);
      float hx = surface(vWPos.xz + vec2(e, 0.0), detail);
      float hz = surface(vWPos.xz + vec2(0.0, e), detail);
      vec3 n = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));
      n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(80.0, 600.0, dist) * 0.8));

      // reflection, nudged by the wave normal
      vec4 uv = vUv;
      uv.xy += n.xz * uv.w * 0.35;
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;

      float NdV = max(dot(n, V), 0.0);
      float fres = 0.02 + 0.98 * pow(clamp(1.0 - NdV, 0.0, 1.0), 5.0);
      float R = clamp(fres * 1.25 + 0.04, 0.0, 1.0);

      // depth of water here, from the baked ground heights
      vec2 huv = (vWPos.xz - uHeightRect.xy) / uHeightRect.z;
      float ground = -uHeightRect.w + texture2D(uHeight, huv).r * (2.0 * uHeightRect.w);
      if (huv.x < 0.0 || huv.y < 0.0 || huv.x > 1.0 || huv.y > 1.0) ground = -2.0;
      float depth = max(-ground, 0.0);

      // the moon's glitter path
      vec3 H = normalize(uMoonDir + V);
      float NdH = max(dot(n, H), 0.0);
      float spec = pow(NdH, 3000.0) * 14.0;
      vec2 cell = floor(vWPos.xz * 9.0);
      float flick = hash21(cell + floor(uTime * 6.0 + hash21(cell) * 6.0));
      float sparkle = step(0.965, flick) * pow(NdH, 600.0) * 10.0 * detail;
      vec3 glint = uMoonColor * (spec + sparkle);

      float T = exp(-depth * 2.2) * 0.88;
      vec3 scatter = color * (1.0 - T);
      vec3 rgb = refl * R + scatter * (1.0 - R) + glint;
      float alpha = 1.0 - T * (1.0 - R);

      float shore = smoothstep(0.0, 0.05, depth);
      rgb *= shore;
      alpha *= shore;

      float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
      rgb = (1.0 - fog) * rgb + fog * uFogColor * alpha;

      gl_FragColor = vec4(rgb, alpha);
    }`,
};

export function buildWater(width, height, fog) {
  const geo = new THREE.PlaneGeometry(6000, 6000);
  const water = new Reflector(geo, {
    shader: WaterShader,
    textureWidth: width,
    textureHeight: height,
    color: new THREE.Color().setRGB(0.010, 0.028, 0.085),
    clipBias: 0.003,
    multisample: 4,
  });
  water.rotation.x = -Math.PI / 2;
  water.renderOrder = 1;

  const m = water.material;
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  const u = m.uniforms;
  u.uTime = shared.uTime;
  u.uMoonDir.value.copy(MOON_DIR);
  u.uMoonColor.value.setRGB(0.9, 0.95, 1.1);
  u.uRipples.value = [...Array(MAX_RIPPLES)].map(() => new THREE.Vector4(0, 0, -100, 0));
  u.uHeightRect.value.set(HEIGHT_RECT.minX, HEIGHT_RECT.minZ, HEIGHT_RECT.size, HEIGHT_RECT.hi);
  u.uFogColor.value.copy(fog.color);
  u.uFogDensity.value = fog.density;

  let slot = 0;
  water.addRipple = (x, z, strength, time) => {
    u.uRipples.value[slot].set(x, z, time, strength);
    slot = (slot + 1) % MAX_RIPPLES;
  };
  water.setHeightTexture = (tex) => { u.uHeight.value = tex; };
  return water;
}
