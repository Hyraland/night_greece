// Laurel leaves drifting down through the moonlight (the laurel is evergreen and sheds its old leaves a few
// at a time; its flowers are tiny and stay on the twigs), in the same two tones as everything else, a little
// brighter than the temples: each turns over as it falls, so it flickers between lit and shaded. They are not
// spread evenly: a slow noise field, carried along by the wind, gathers them into drifting streams with empty
// air between, thicker around the giant laurel; now and then a gust thickens the streams.
//
// All on the GPU: a few thousand leaves live in a box that follows the viewer (their positions wrap around
// it), so they fill the air wherever one walks.

import * as THREE from 'three';
import { GLSL_NOISE, mulberry32 } from '../noise.js';
import { shared, MOON_DIR } from '../world.js';

const COUNT = 2600;
const BOX = 36, HEIGHT = 14; // metres across the box around the viewer, and how high above the water it reaches

// tree: where the giant laurel stands ({ x, z }), if it does
export function buildFallingLeaves(tree) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const rng = mulberry32(512);
  const seeds = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT * 4; i++) seeds[i] = rng();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = COUNT;

  const uniforms = {
    uTime: shared.uTime, uCam: shared.uCamera, uMoonDir: { value: MOON_DIR },
    uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uFogColor: { value: new THREE.Color() },
    uFog: { value: 0.002 }, uAmount: { value: 1 }, uSize: { value: 1 }, uSpeed: { value: 1 }, uWind: { value: 1 },
    uTree: { value: new THREE.Vector2(tree ? tree.x : 1e5, tree ? tree.z : 1e5) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uAmount, uSize, uSpeed, uWind;
      uniform vec3 uCam, uMoonDir;
      uniform vec2 uTree;
      varying vec2 vUv;
      varying float vLit, vDist;
      ${GLSL_NOISE}
      mat3 rot(vec3 axis, float a) {
        float s = sin(a), c = cos(a), oc = 1.0 - c;
        return mat3(oc * axis.x * axis.x + c, oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
                    oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z + axis.x * s,
                    oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c);
      }
      void main() {
        float t = uTime * uSpeed;
        vec2 wind = vec2(0.8, 0.35) * uWind;
        // falling and drifting, each at its own pace, swinging from side to side as a leaf does
        float fall = 0.3 + 0.3 * aSeed.w;
        vec3 p = vec3(aSeed.x * ${BOX.toFixed(1)}, ${HEIGHT.toFixed(1)} - mod(aSeed.y * ${HEIGHT.toFixed(1)} + t * fall, ${HEIGHT.toFixed(1)}), aSeed.z * ${BOX.toFixed(1)});
        p.xz += wind * t * (0.7 + 0.6 * aSeed.w);
        p.x += sin(t * (0.9 + aSeed.x) + aSeed.z * 20.0) * 0.8;
        p.z += cos(t * (0.7 + aSeed.z) + aSeed.x * 20.0) * 0.8;
        // wrap around the box that follows the viewer
        p.xz = uCam.xz + mod(p.xz - uCam.xz + 0.5 * ${BOX.toFixed(1)}, ${BOX.toFixed(1)}) - 0.5 * ${BOX.toFixed(1)};

        // streams and gaps: a slow noise field carried by the wind, stretched along it so the leaves gather
        // in long ribbons, with smaller clumps inside them; between, only a stray leaf here and there; more of
        // them around the giant laurel. Now and then a gust thickens the ribbons.
        vec2 along = normalize(vec2(0.8, 0.35)), across = vec2(-along.y, along.x);
        vec2 q = vec2(dot(p.xz, along) * 0.035, dot(p.xz, across) * 0.11) - vec2(t * 0.02, 0.0);
        float field = 0.7 * vnoise3(vec3(q, p.y * 0.07 + t * 0.015)) + 0.3 * vnoise3(vec3(p * 0.22) + t * 0.05);
        float gust = smoothstep(0.55, 1.0, sin(t * 0.07 + 1.3) * 0.5 + 0.5);
        float nearTree = 1.0 - smoothstep(12.0, 50.0, length(p.xz - uTree));
        float thr = mix(0.57, 0.48, gust) + (1.0 - uAmount) * 0.3 - 0.14 * nearTree;
        float show = max(smoothstep(thr, thr + 0.05, field), step(aSeed.y, 0.06 + 0.1 * nearTree));
        show *= step(aSeed.w, uAmount + 0.15);
        vDist = length(p - uCam);
        show *= smoothstep(0.6, 1.4, vDist) * (1.0 - smoothstep(12.0, 17.0, vDist));

        // tumbling: the leaf turns about its own axis, so it catches the moon now and then
        vec3 axis = normalize(vec3(aSeed.z - 0.5, aSeed.w - 0.3, aSeed.x - 0.5));
        mat3 R = rot(axis, t * (1.5 + 2.5 * aSeed.y) + aSeed.x * 6.28);
        float size = (0.15 + 0.07 * aSeed.z) * uSize * show; // its length
        vec3 local = R * (position * vec3(size * 0.36, size, size));
        vec3 n = R * vec3(0.0, 0.0, 1.0);
        vLit = abs(dot(n, uMoonDir));
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * vec4(p + local, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uLit, uShade, uFogColor;
      uniform float uFog;
      varying vec2 vUv;
      varying float vLit, vDist;
      void main() {
        // a laurel leaf: long and narrow, widest a little below the middle, pointed at both ends, on a short
        // stalk, with a thin midrib down its length
        float x = abs(vUv.x * 2.0 - 1.0), y = vUv.y;
        float blade = (y - 0.06) / 0.94;
        float w = blade > 0.0 ? pow(sin(3.14159 * pow(blade, 0.8)), 0.9) : 0.0;
        bool stalk = y < 0.08 && x < 0.07;
        if (x > w && !stalk) discard;
        vec3 col = mix(uShade, uLit, step(0.45, vLit));
        if (stalk || (x < 0.06 && blade > 0.0 && blade < 0.9)) col = mix(col, uShade, 0.55);
        col = mix(col, uFogColor, 1.0 - exp(-vDist * uFog));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the water's reflection
  mesh.apply = (t) => {
    // a little brighter than the temples: shade lifted toward the lit tone, lit toward pure white
    uniforms.uLit.value.set(t.stone.lit).lerp(new THREE.Color(1, 1, 1), 0.4);
    uniforms.uShade.value.set(t.stone.shade).lerp(new THREE.Color(t.stone.lit), 0.35);
    uniforms.uFogColor.value.set(t.sky.horizon);
    uniforms.uFog.value = t.fog.density;
    uniforms.uAmount.value = t.falling.amount;
    uniforms.uSize.value = t.falling.size;
    uniforms.uSpeed.value = t.falling.speed;
    uniforms.uWind.value = t.falling.wind;
  };
  return mesh;
}
