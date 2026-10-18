// The air between the viewer and the ruins, applied after the scene is drawn, from the depth buffer:
// aerial perspective (with distance everything takes on the colour of the moonlit air, paler and brighter
// toward the moon, where the light scatters forward to the eye) and a low mist lying on the water, thick at
// the surface and gone a couple of metres up, so the feet of the temples dissolve while their tops stay
// clear. The sky itself is left alone; its own horizon glow is drawn by sky.js.

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { MOON_DIR } from './world.js';

const WATER = 0; // height of the water surface

export class AirPass extends ShaderPass {
  constructor(camera) {
    super({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uCam: { value: new THREE.Vector3() },
        uMoonDir: { value: MOON_DIR },
        uAir: { value: 0.0014 },            // aerial perspective: extinction per metre
        uAirColor: { value: new THREE.Color() },
        uGlowColor: { value: new THREE.Color() },
        uGlow: { value: 0.71 },             // how much brighter the air is toward the moon
        uMist: { value: 0.011 },            // mist density at the water, per metre
        uMistHeight: { value: 1.4 },        // metres over which it thins to a third
        uMistColor: { value: new THREE.Color() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tDepth;
        uniform mat4 uProjInv, uViewInv;
        uniform vec3 uCam, uMoonDir, uAirColor, uGlowColor, uMistColor;
        uniform float uAir, uGlow, uMist, uMistHeight;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float depth = texture2D(tDepth, vUv).x;
          if (depth >= 0.99999) { gl_FragColor = c; return; } // the sky
          vec4 view = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec3 world = (uViewInv * vec4(view.xyz / view.w, 1.0)).xyz;
          vec3 ray = world - uCam;
          float dist = length(ray);
          vec3 dir = ray / dist;

          // light scattered toward the eye: strongest looking at the moon, a broad halo around it
          float mu = max(dot(dir, uMoonDir), 0.0);
          float glow = uGlow * (0.35 * pow(mu, 4.0) + 0.65 * pow(mu, 24.0));

          // aerial perspective
          float air = 1.0 - exp(-dist * uAir);
          vec3 airCol = uAirColor + uGlowColor * glow;
          c.rgb = mix(c.rgb, airCol, air);

          // mist: density falls off exponentially with height above the water; its depth along the ray
          float H = uMistHeight;
          float h0 = max(uCam.y - ${WATER.toFixed(1)}, 0.0), h1 = max(world.y - ${WATER.toFixed(1)}, 0.0);
          float k = abs(h1 - h0) > 1e-3 ? H * (exp(-h0 / H) - exp(-h1 / H)) / (h1 - h0) : exp(-h0 / H);
          float mist = 1.0 - exp(-uMist * k * dist);
          c.rgb = mix(c.rgb, uMistColor * (1.0 + 1.5 * glow), mist);

          gl_FragColor = c;
        }`,
    });
    this.camera = camera;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const u = this.uniforms;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uViewInv.value.copy(this.camera.matrixWorld);
    u.uCam.value.setFromMatrixPosition(this.camera.matrixWorld);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
