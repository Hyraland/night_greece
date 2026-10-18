// The toon page's surroundings, all in the same two-tone spirit: a sky graded from night blue to a pale
// horizon with a crisp moon and stars, a shallow sea whose reflections and moon path fall into the same two
// tones, the bit of ground that rises out of it, and thin ink lines where depth jumps.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mulberry32, GLSL_NOISE } from '../noise.js';
import { MOON_DIR, shared, heightAt, CENTER, WORLD_RADIUS } from '../world.js';
import { toonMaterial } from './look.js';

// ---------------------------------------------------------------- sky

export function buildToonSky() {
  const group = new THREE.Group();
  const uniforms = {
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uMoon: { value: new THREE.Color() }, uMoonDir: { value: MOON_DIR }, uGlow: { value: 1 },
  };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith, uHorizon, uMoon, uMoonDir;
      uniform float uGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.55, d.y));
        // the moon: a soft halo fading smoothly out into the sky, and a disc bright enough to glow (bloom)
        float m = max(dot(d, uMoonDir), 0.0);
        col = mix(col, uMoon, uGlow * (0.3 * pow(m, 700.0) + 0.1 * pow(m, 70.0)));
        col += uMoon * uGlow * 0.045 * pow(m, 10.0);
        col = mix(col, uMoon * mix(1.0, 1.9, min(uGlow, 1.5)), smoothstep(0.99955, 0.99968, m));
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  // stars: small crisp points, more toward the zenith
  const rng = mulberry32(77);
  const pos = [], size = [];
  while (pos.length < 2200 * 3) {
    const v = new THREE.Vector3(rng() * 2 - 1, rng(), rng() * 2 - 1);
    if (v.lengthSq() > 1 || v.y < 0.06 + 0.2 * rng()) continue;
    v.normalize().multiplyScalar(1300);
    pos.push(v.x, v.y, v.z);
    size.push(rng() < 0.06 ? 3.2 : 1.6 + rng());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  const stars = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uPR: { value: 1 }, uStars: { value: 1 }, uColor: uniforms.uMoon, uTime: shared.uTime },
    transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      attribute float aSize; uniform float uPR, uTime; varying float vTw;
      void main() {
        vTw = 0.75 + 0.25 * sin(uTime * 1.3 + position.x * 0.07 + position.z * 0.05);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
        gl_PointSize = aSize * uPR;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStars; varying float vTw;
      void main() { if (length(gl_PointCoord - 0.5) > 0.5) discard; gl_FragColor = vec4(uColor, uStars * vTw); }`,
  }));
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  group.add(stars);

  return {
    group, stars,
    apply(t, moonColor) {
      uniforms.uZenith.value.set(t.sky.zenith);
      uniforms.uHorizon.value.set(t.sky.horizon);
      uniforms.uMoon.value.set(moonColor);
      stars.material.uniforms.uStars.value = t.sky.stars;
      uniforms.uGlow.value = t.sky.moonGlow;
    },
    update(camera) { group.position.copy(camera.position); },
  };
}

// ---------------------------------------------------------------- water

export function buildToonWater(width, height) {
  const water = new Reflector(new THREE.PlaneGeometry(6000, 6000), {
    textureWidth: width, textureHeight: height, clipBias: 0.003,
    shader: {
      name: 'ToonWater',
      uniforms: {
        color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
        uTime: shared.uTime, uMoonDir: { value: MOON_DIR },
        uWater: { value: new THREE.Color() }, uFar: { value: new THREE.Color() }, uLit: { value: new THREE.Color() },
        uReflect: { value: 0.75 }, uThreshold: { value: 0.7 }, uGlint: { value: 1 }, uFog: { value: 0.002 },
        uRipples: { value: 1 }, uSparkle: { value: 1 }, uFlow: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform mat4 textureMatrix;
        varying vec4 vUv; varying vec3 vWorld;
        void main() {
          vUv = textureMatrix * vec4(position, 1.0);
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uTime, uReflect, uThreshold, uGlint, uFog, uRipples, uSparkle, uFlow;
        uniform vec3 uMoonDir, uWater, uFar, uLit;
        varying vec4 vUv; varying vec3 vWorld;
        ${GLSL_NOISE}
        void main() {
          // ground coordinates across and along the view, so ripples lie as strips across it
          vec3 r3 = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec2 right = normalize(r3.xz + 1e-5), fwd = vec2(-right.y, right.x);
          vec2 rel = vWorld.xz - cameraPosition.xz;
          float across = dot(rel, right), along = abs(dot(rel, fwd));
          float d = length(vWorld - cameraPosition);
          vec3 V = normalize(cameraPosition - vWorld);
          float near = 1.0 - smoothstep(60.0, 220.0, d); // fine detail fades before it could shimmer

          // the reflection, sliced into strips that sway sideways (water, not a smooth film). The water moves:
          // each strip rocks to and fro as small waves pass, and the strips themselves slowly change shape,
          // so the reflected temples waver and re-form
          float t = uTime * uFlow;
          float n1 = vnoise3(vec3(across * 0.3, along * 2.6 - t * 0.2, t * 0.45));
          float n2 = vnoise3(vec3(across * 0.9 + 7.0, along * 6.0 + t * 0.3, t * 0.8));
          float rock = sin(along * 2.2 - t * 1.7 + n1 * 6.28) * (0.5 + 0.5 * sin(along * 0.37 + t * 0.4));
          vec4 uv = vUv;
          uv.x += ((n1 - 0.5) * 0.035 + (n2 - 0.5) * 0.012 + rock * 0.008) * uRipples * uv.w;
          uv.y += (n2 - 0.5) * 0.006 * uRipples * uv.w; // and stretches a little up and down
          vec3 refl = texture2DProj(tDiffuse, uv).rgb;
          float bright = smoothstep(uThreshold - 0.03, uThreshold + 0.03, dot(refl, vec3(0.299, 0.587, 0.114)));
          // close by one sees into the water; toward the horizon it mirrors more
          float fres = mix(0.35, 1.0, smoothstep(0.75, 0.08, V.y));
          vec3 col = mix(uWater, uLit, bright * uReflect * fres);

          // short ripple lines: light on the crests, darker in the troughs
          // (they come and go as the water moves)
          float crest = smoothstep(0.8, 0.86, vnoise3(vec3(across * 1.1, along * 9.0 + t * 0.5, t * 0.9)));
          float trough = smoothstep(0.78, 0.86, vnoise3(vec3(across * 0.8 + 31.0, along * 7.0 - t * 0.4, t * 0.7)));
          col = mix(col, uLit, crest * 0.4 * uSparkle * near);
          col = mix(col, uWater * 0.82, trough * 0.45 * uSparkle * near * (1.0 - bright * 0.6));

          // the moon's path, broken along the strips, bright enough to glow
          vec3 nrm = normalize(vec3(0.0, 1.0, 0.0) + vec3(right.x, 0.0, right.y) * (n1 - 0.5) * 0.4
                                                 + vec3(fwd.x, 0.0, fwd.y) * (n2 - 0.5) * 0.25);
          float g = max(dot(reflect(-uMoonDir, nrm), V), 0.0);
          col = mix(col, uLit * 1.8, smoothstep(0.991, 0.995, g) * uGlint);

          // into the pale horizon with distance
          col = mix(col, uFar, 1.0 - exp(-d * uFog * 1.4));
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    },
  });
  water.rotation.x = -Math.PI / 2;
  // the Reflector copies its shader's uniforms: link the shared clock and moon direction back in
  water.material.uniforms.uTime = shared.uTime;
  water.material.uniforms.uMoonDir = { value: MOON_DIR };
  water.apply = (t) => {
    const u = water.material.uniforms;
    u.uWater.value.set(t.water.color);
    u.uFar.value.set(t.water.far);
    u.uLit.value.set(t.stone.lit);
    u.uReflect.value = t.water.reflect;
    u.uThreshold.value = t.water.threshold;
    u.uGlint.value = t.water.glint;
    u.uRipples.value = t.water.ripples;
    u.uSparkle.value = t.water.sparkle;
    u.uFlow.value = t.water.flow;
    u.uFog.value = t.fog.density;
  };
  return water;
}

// ---------------------------------------------------------------- ground

// The land that rises out of the sea: here only the giant laurel's mound and the plots under the ruins.
export function buildToonGround(look) {
  const R = WORLD_RADIUS + 40, N = 420;
  const geo = new THREE.PlaneGeometry(2 * R, 2 * R, N, N);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + CENTER.x, z = p.getZ(i) + CENTER.z;
    p.setXYZ(i, x, heightAt(x, z), z);
  }
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, toonMaterial(look, 'ground'));
  ground.receiveShadow = true;
  return ground;
}

// ---------------------------------------------------------------- ink lines

// Thin lines where the depth jumps (outlines of columns against the sky, steps against the floor), read from
// the depth buffer after the scene is drawn.
export class OutlinePass extends ShaderPass {
  constructor(camera) {
    super({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() }, uNear: { value: camera.near }, uFar: { value: camera.far },
        uColor: { value: new THREE.Color() }, uStrength: { value: 0.7 }, uDepth: { value: 0.012 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tDepth;
        uniform vec2 uTexel; uniform float uNear, uFar, uStrength, uDepth; uniform vec3 uColor;
        varying vec2 vUv;
        float lin(vec2 uv) {
          float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
          return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
        }
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float d = lin(vUv);
          float l = lin(vUv - vec2(uTexel.x, 0.0)), r = lin(vUv + vec2(uTexel.x, 0.0));
          float b = lin(vUv - vec2(0.0, uTexel.y)), t = lin(vUv + vec2(0.0, uTexel.y));
          // a jump in depth, relative to the depth itself, so lines stay as thin far off as near
          float jump = max(max(abs(l - d), abs(r - d)), max(abs(b - d), abs(t - d))) / d;
          float line = smoothstep(uDepth, uDepth * 2.5, jump) * (1.0 - smoothstep(600.0, 1200.0, d));
          gl_FragColor = vec4(mix(c.rgb, uColor, line * uStrength), c.a);
        }`,
    });
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const u = this.uniforms;
    u.tDepth.value = readBuffer.depthTexture;
    u.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
