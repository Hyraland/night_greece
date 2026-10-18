// Night sky: deep blue dome with the Milky Way, twinkling stars, a large moon with a halo,
// and the occasional shooting star. Everything is centred on the camera.

import * as THREE from 'three';
import { mulberry32, GLSL_NOISE } from './noise.js';
import { MOON_DIR, shared } from './world.js';

const MW_POLE = new THREE.Vector3(1, 0.35, -0.9).normalize();
// Galactic core: a point on the band, low in the north-east.
const MW_CORE = new THREE.Vector3().crossVectors(MW_POLE, new THREE.Vector3(0, 1, 0)).normalize()
  .multiplyScalar(-1).lerp(new THREE.Vector3(0, 1, 0), 0.25).projectOnPlane(MW_POLE).normalize();

export const SKY_HORIZON = new THREE.Color().setRGB(0.045, 0.085, 0.2);

export function buildSky(pixelRatio) {
  const group = new THREE.Group();
  const uniforms = {
    uMoonDir: { value: MOON_DIR },
    uPole: { value: MW_POLE },
    uCore: { value: MW_CORE },
    uTime: shared.uTime,
    uHorizon: { value: SKY_HORIZON },
  };

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1500, 64, 32),
    new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uMoonDir, uPole, uCore, uHorizon;
        uniform float uTime;
        varying vec3 vDir;
        ${GLSL_NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 zenith = vec3(0.004, 0.011, 0.05);
          vec3 mid = vec3(0.013, 0.034, 0.12);
          vec3 col = mix(uHorizon, mid, smoothstep(-0.02, 0.22, h));
          col = mix(col, zenith, smoothstep(0.2, 0.95, h));

          // moon glow
          float md = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.30, 0.42, 0.75) * pow(md, 90.0) * 0.9;
          col += vec3(0.12, 0.2, 0.45) * pow(md, 12.0) * 0.45;
          col += vec3(0.05, 0.09, 0.2) * pow(md, 3.0) * 0.4;

          // Milky Way
          float b = dot(d, uPole);
          float core = pow(max(dot(d, uCore), 0.0), 3.0);
          float width = 0.16 + 0.1 * core;
          float band = exp(-b * b / (width * width));
          float cloud = fbm3(d * 3.5 + 1.7);
          float fine = fbm3(d * 11.0 - 4.2);
          float dust = smoothstep(0.42, 0.68, fbm3(d * 6.0 + vec3(5.1, 0.0, 2.3))) * exp(-b * b / (width * width * 0.18));
          float mw = band * (0.35 + 0.9 * cloud * cloud + 0.35 * fine) * (1.0 - 0.8 * dust);
          vec3 mwCol = mix(vec3(0.16, 0.22, 0.42), vec3(0.42, 0.36, 0.40), core * 0.8);
          float horizonFade = smoothstep(-0.02, 0.28, h);
          col += mwCol * mw * (0.55 + 1.1 * core) * horizonFade * (1.0 - 0.8 * pow(md, 4.0));

          // thin cloud bank near the horizon, lit by the moon
          float cl = fbm3(vec3(d.x * 3.0, h * 14.0, d.z * 3.0) + vec3(uTime * 0.004, 0.0, 0.0));
          float clMask = smoothstep(0.5, 0.75, cl) * smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.08, 0.2, h));
          col = mix(col, vec3(0.10, 0.15, 0.30) + vec3(0.35, 0.42, 0.6) * pow(md, 6.0), clMask * 0.55);

          if (h < 0.0) col = mix(col, uHorizon * 0.8, smoothstep(0.0, -0.1, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  group.add(buildStars(pixelRatio));
  const moon = buildMoon();
  group.add(moon);

  const meteors = new Meteors();
  group.add(meteors.mesh);

  return {
    group,
    starsMaterial: group.children[1].material,
    update(camera, dt, t) {
      group.position.copy(camera.position);
      for (const s of moon.children) s.position.copy(MOON_DIR).multiplyScalar(moon.userData.dist); // follows a retuned moon
      meteors.update(dt, t, camera);
    },
  };
}

function buildStars(pixelRatio) {
  const rng = mulberry32(2024);
  const N = 9000;
  const pos = [], size = [], col = [], phase = [];
  const d = new THREE.Vector3();
  while (pos.length / 3 < N) {
    d.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    const l = d.length();
    if (l > 1 || l < 0.05) continue;
    d.divideScalar(l);
    if (d.y < -0.08) continue;
    const b = d.dot(MW_POLE);
    const inBand = Math.exp(-(b * b) / 0.03);
    if (rng() > 0.35 + 0.65 * inBand) continue;
    pos.push(d.x * 1400, d.y * 1400, d.z * 1400);
    const m = Math.pow(rng(), 11);
    size.push(1.0 + m * 7.0);
    const t = rng();
    const c = t < 0.62 ? [0.82, 0.9, 1.0] : t < 0.82 ? [0.62, 0.74, 1.0] : t < 0.94 ? [1.0, 0.94, 0.82] : [1.0, 0.78, 0.6];
    col.push(...c);
    phase.push(rng() * 100);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uPR: { value: pixelRatio }, uMoonDir: { value: MOON_DIR } },
    vertexShader: /* glsl */ `
      uniform float uTime, uPR; uniform vec3 uMoonDir;
      attribute float aSize, aPhase; attribute vec3 color;
      varying vec3 vCol; varying float vBig;
      void main() {
        vec3 dir = normalize(position);
        float tw = 0.65 + 0.35 * sin(uTime * (1.5 + fract(aPhase) * 3.0) + aPhase) * sin(uTime * 0.7 + aPhase * 3.1);
        float moonDim = 1.0 - 0.85 * smoothstep(0.93, 0.995, dot(dir, uMoonDir));
        float horizon = smoothstep(-0.02, 0.18, dir.y);
        vBig = smoothstep(3.5, 7.0, aSize);
        vCol = color * tw * moonDim * horizon * (0.7 + aSize * 0.25);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
        gl_PointSize = aSize * uPR * (1.0 + vBig * 2.5);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying float vBig;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        float core = exp(-r * r * mix(40.0, 160.0, vBig));
        float halo = exp(-r * r * 18.0) * 0.1 * vBig;
        float spikes = vBig * (exp(-abs(p.x) * 70.0) + exp(-abs(p.y) * 70.0)) * exp(-r * 6.0) * 0.6;
        float a = core + halo + spikes;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}

function moonTexture() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const rng = mulberry32(8);
  const maria = [...Array(9)].map(() => [0.25 + rng() * 0.5, 0.2 + rng() * 0.55, 0.06 + rng() * 0.16, 0.12 + rng() * 0.16]);
  const craters = [...Array(40)].map(() => [rng(), rng(), 0.01 + rng() * 0.035]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) / 0.5;
    const i = (y * S + x) * 4;
    if (r > 1) { img.data[i + 3] = 0; continue; }
    let b = 1;
    for (const [mx, my, mr, k] of maria) {
      const dd = Math.hypot(u - mx, (v - my) * 1.2) / mr;
      b -= k * Math.exp(-dd * dd * 1.5);
    }
    for (const [cx, cy, cr] of craters) {
      const dd = Math.hypot(u - cx, v - cy) / cr;
      if (dd < 1.3) b += dd < 1 ? -0.04 : 0.05;
    }
    b *= 0.82 + 0.18 * Math.sqrt(1 - r * r);
    const edge = Math.min(1, (1 - r) * 60);
    img.data[i] = 255 * b * 0.96; img.data[i + 1] = 255 * b * 0.98; img.data[i + 2] = 255 * b;
    img.data[i + 3] = 255 * edge;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

function buildMoon() {
  const group = new THREE.Group();
  const dist = 1300;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: new THREE.Color().setRGB(0.22, 0.3, 0.55), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  halo.scale.setScalar(440);
  const disk = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTexture(), color: new THREE.Color().setRGB(7, 7.6, 8.4), transparent: true, depthWrite: false, fog: false,
  }));
  disk.scale.setScalar(64);
  group.userData.dist = dist;
  for (const s of [halo, disk]) {
    s.position.copy(MOON_DIR).multiplyScalar(dist);
    s.renderOrder = -8;
    s.frustumCulled = false;
    group.add(s);
  }
  return group;
}

class Meteors {
  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(4 * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aT', new THREE.Float32BufferAttribute([0, 0, 1, 1], 1));
    this.geo.setIndex([0, 1, 2, 1, 3, 2]);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aT; varying float vT;
        void main() { vT = aT; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha; varying float vT;
        void main() { gl_FragColor = vec4(vec3(0.8, 0.9, 1.0) * pow(vT, 2.5) * uAlpha * 3.0, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -7;
    this.rng = mulberry32(5150);
    this.next = 6;
    this.active = null;
  }

  update(dt, t, camera) {
    if (!this.active && t > this.next) {
      const r = this.rng;
      const az = r() * Math.PI * 2, el = 0.45 + r() * 0.6;
      const start = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      const dir = new THREE.Vector3(r() - 0.5, -0.4 - r() * 0.4, r() - 0.5).projectOnPlane(start).normalize();
      this.active = { start, dir, t0: t, dur: 0.7 + r() * 0.6, len: 0.08 + r() * 0.1 };
      this.next = t + 7 + r() * 16;
    }
    this.mesh.visible = false;
    if (!this.active) return;
    const a = this.active, k = (t - a.t0) / a.dur;
    if (k > 1) { this.active = null; return; }
    const R = 1350;
    const head = a.start.clone().addScaledVector(a.dir, k * 0.35).normalize();
    const tail = a.start.clone().addScaledVector(a.dir, Math.max(0, k * 0.35 - a.len)).normalize();
    const trail = head.clone().sub(tail);
    if (trail.lengthSq() < 1e-10) return; // first frame: no length yet, and no direction to give it width
    const side = new THREE.Vector3().crossVectors(trail, head).normalize().multiplyScalar(0.9 / R);
    this.mesh.visible = true;
    const pts = [tail.clone().sub(side), tail.clone().add(side), head.clone().sub(side), head.clone().add(side)];
    pts.forEach((p, i) => this.pos.set([p.x * R, p.y * R, p.z * R], i * 3));
    this.geo.attributes.position.needsUpdate = true;
    this.mat.uniforms.uAlpha.value = Math.sin(Math.PI * k);
  }
}
