// First-person stroll. By default the camera wanders the loop on its own; drag to look around,
// WASD / arrow keys to walk freely, Space to hand control back to the stroll.

import * as THREE from 'three';
import { PATH_POINTS, makeRoute, groundAt, heightAt, colliders, gaze, STEP_UP, CENTER, WORLD_RADIUS } from './world.js';

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const EYE = 1.62;
// A human gait: walking briskly, about 1.6 m/s in 0.8 m steps (two a second), running about 3.8 m/s in
// 1.25 m strides (three a second). The head is lowest as each foot lands and highest passing over it,
// and sways a little toward the standing foot; running bounces more and drops sharply on landing.
const GAIT = {
  walk: { speed: 1.6, stride: 0.8, bob: 0.02, sway: 0.014 },
  run: { speed: 3.8, stride: 1.25, bob: 0.045, sway: 0.008 },
  stroll: 1.3, // the automatic stroll, unhurried
};
const FOV = 58;
const CLAMBER = 0.9; // highest ledge one can climb onto

export class Walker {
  // route: the loop the automatic stroll follows (see makeRoute), the walking loop unless given
  constructor(camera, dom, { onStep, onModeChange, route = makeRoute(PATH_POINTS) }) {
    this.camera = camera;
    this.route = route;
    this.onStep = onStep;
    this.onModeChange = onModeChange;
    this.mode = 'auto';
    this.s = 0;
    this.pos = route.curve.getPointAt(0);
    this.yaw = 0;
    this.pitch = 0.02;
    this.lookYaw = 0;   // drag offset while strolling
    this.lookPitch = 0;
    this.lastDrag = -10;
    this.feet = groundAt(this.pos.x, this.pos.z) ?? heightAt(this.pos.x, this.pos.z);
    this.eyeY = this.feet + EYE;
    this.pushing = 0;
    this.vel = new THREE.Vector2();  // free walking: current velocity, eased toward what the keys ask for
    this.speedNow = 0;               // current ground speed
    this.runAmt = 0;                 // 0 walking .. 1 running, eased
    this.runLock = false;            // R: keep running without holding Shift
    this.dashing = false;            // forward key tapped twice and held: running
    this.forwardDownAt = -1;
    this.phase = 0;                  // steps taken; each whole number is a footfall
    this.keys = new Set();
    this.joinOffset = new THREE.Vector3();
    this.time = 0;

    let dragging = false, lx = 0, ly = 0;
    dom.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointerup', (e) => { dragging = false; dom.releasePointerCapture(e.pointerId); });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      const k = 0.0032;
      if (this.mode === 'auto') {
        this.lookYaw -= dx * k;
        this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * k, -1.1, 1.2);
        this.lastDrag = this.time;
      } else {
        this.yaw -= dx * k;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.2, 1.3);
      }
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); this.setMode(this.mode === 'auto' ? 'free' : 'auto'); return; }
      const move = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      // forward pressed twice in quick succession, and held: run
      if ((e.code === 'KeyW' || e.code === 'ArrowUp') && !e.repeat) {
        const now = performance.now();
        this.dashing = now - this.forwardDownAt < 350;
        this.forwardDownAt = now;
      }
      if (move.includes(e.code)) { e.preventDefault(); this.keys.add(e.code); if (this.mode === 'auto') this.setMode('free'); }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.add('Shift');
      if (e.code === 'KeyR' && !e.repeat) this.runLock = !this.runLock;
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if ((e.code === 'KeyW' || e.code === 'ArrowUp') && !this.keys.has('KeyW') && !this.keys.has('ArrowUp')) this.dashing = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.delete('Shift');
    });
    addEventListener('blur', () => { this.keys.clear(); this.dashing = false; });
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'free') {
      this.yaw += this.lookYaw;
      this.pitch += this.lookPitch;
      this.lookYaw = this.lookPitch = 0;
    } else {
      const { u } = this.route.nearest(this.pos.x, this.pos.z);
      this.s = u * this.route.length;
      const p = this.route.curve.getPointAt(u);
      this.joinOffset.set(this.pos.x - p.x, 0, this.pos.z - p.z);
      this.lookYaw = this.yaw - this.autoYaw(this.s);
      this.lookPitch = this.pitch - 0.02;
      this.lastDrag = this.time;
    }
    this.mode = mode;
    this.onModeChange?.(mode);
  }

  autoYaw(s) {
    const { curve, length } = this.route;
    const u = (((s + 7) / length) % 1 + 1) % 1;
    const ahead = curve.getPointAt(u);
    const here = curve.getPointAt((((s / length) % 1) + 1) % 1);
    return Math.atan2(-(ahead.x - here.x), -(ahead.z - here.z));
  }

  // What the stroll looks at, heading along its way: the yaw that frames it, how far to turn there (w),
  // and the pitch to look up to and how far (pw). Close by, it turns toward a ruin, from further out, and
  // looks up steeply when right beneath a giant; further off, a temple in view that stands out enough is
  // only nudged into place. Either way it is framed on a third of the picture, on the side it is already
  // on, rather than in the middle or squeezed toward the edge; only right beneath it does it fill the view.
  // g.weight, if set, makes one more likely to be chosen (the giant laurel).
  gazeAt(heading) {
    const cam = this.camera;
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
    const third = Math.atan(Math.tan(half) / 3);
    let best = null;
    for (const g of gaze) {
      const dx = g.x - this.pos.x, dz = g.z - this.pos.z, d = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dx, -dz);
      const rel = angleDiff(yaw, heading);
      const near = (1 - smooth(g.r * 0.35, g.r * 1.15, d)) * smooth(2.1, 1.1, Math.abs(rel)) * 0.85;
      const far = smooth(0.05, 0.14, g.y / Math.max(d, 1)) * smooth(half * 1.25, half * 0.7, Math.abs(rel)) *
        (1 - smooth(150, 220, d)) * 0.8;
      const w = Math.min(0.95, Math.max(near, far) * (g.weight ?? 1));
      // which third: the side it is on, kept until it is clearly over on the other
      if (!g.side || rel * g.side < -0.08) g.side = rel < 0 ? -1 : 1;
      if (w > 0 && (!best || w > best.w)) {
        const pitch = Math.min(0.85, Math.max(-0.1, Math.atan2(g.y - this.eyeY, Math.max(d, 4))));
        const framed = yaw - g.side * third * smooth(g.r * 0.25, g.r * 0.6, d);
        best = { w, yaw: framed, pitch, pw: Math.min(0.95, near * (g.weight ?? 1)) };
      }
    }
    return best;
  }

  // Step onto (x+dx, z+dz) if there is ground there: at most a step up, and no drop off a high ledge.
  tryMove(dx, dz, stepUp = STEP_UP) {
    const nx = this.pos.x + dx, nz = this.pos.z + dz;
    const g = groundAt(nx, nz, this.feet + stepUp - STEP_UP);
    if (g === null || g - this.feet > stepUp || this.feet - g > 1.6) return false;
    this.pos.x = nx;
    this.pos.z = nz;
    this.feet = g;
    return true;
  }

  // Standing in a gap narrower than a stride (a joint between blocks, a hole in rubble): a real foot would
  // never have gone down there, so the walker may climb back out of it.
  inCrack() {
    const { x, z } = this.pos, top = this.feet + STEP_UP;
    const higher = (dx, dz) => (groundAt(x + dx, z + dz, this.feet + 1.2) ?? -Infinity) > top;
    return (higher(0.45, 0) && higher(-0.45, 0)) || (higher(0, 0.45) && higher(0, -0.45));
  }

  get running() {
    return this.dashing || this.keys.has('Shift') !== this.runLock;
  }

  update(dt) {
    this.time += dt;
    const prev = this.pos.clone();
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    this.runAmt += ((this.running ? 1 : 0) - this.runAmt) * ease(4);

    if (this.mode === 'auto') {
      const pace = this.running ? GAIT.run.speed : GAIT.stroll;
      this.speedNow += (pace - this.speedNow) * ease(1.5);
      this.s = (this.s + this.speedNow * dt) % this.route.length;
      const p = this.route.curve.getPointAt(this.s / this.route.length);
      this.joinOffset.multiplyScalar(Math.exp(-dt * 0.6));
      this.pos.set(p.x + this.joinOffset.x, 0, p.z + this.joinOffset.z);
      let target = this.autoYaw(this.s);
      let targetPitch = 0.02;
      // when passing a colossus, turn toward it and lift the eyes; a temple further off, nudge it onto a third
      const g = this.gazeAt(target);
      if (g) {
        target += angleDiff(g.yaw, target) * g.w;
        targetPitch += (g.pitch - targetPitch) * g.pw;
      }
      this.yaw += angleDiff(target, this.yaw) * Math.min(1, dt * 0.9);
      this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 0.6);
      if (this.time - this.lastDrag > 4) {
        const k = Math.min(1, dt * 0.5);
        this.lookYaw -= Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw)) * k;
        this.lookPitch -= this.lookPitch * k;
      }
    } else {
      const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
      const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
      const turn = (this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0);
      this.yaw += turn * dt * 1.4;
      // the velocity the keys ask for (walking backward or sideways is slower); one gets going and stops
      // over a few tenths of a second, as a body does
      const want = new THREE.Vector2();
      if (f || r) {
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        want.set(fx * f - fz * r, fz * f + fx * r).normalize();
        const top = THREE.MathUtils.lerp(GAIT.walk.speed, GAIT.run.speed, this.runAmt) * (f < 0 || (r && !f) ? 0.7 : 1);
        want.multiplyScalar(top);
      }
      this.vel.lerp(want, ease(want.lengthSq() > this.vel.lengthSq() ? 4 : 6));
      if (this.vel.lengthSq() < 1e-5) this.vel.set(0, 0);
      const mx = this.vel.x * dt, mz = this.vel.y * dt, step = Math.hypot(mx, mz);
      if (step > 0) {
        // try the full step, then slide along whatever is in the way
        const x0 = this.pos.x, z0 = this.pos.z;
        this.tryMove(mx, mz) || this.tryMove(mx, 0) || this.tryMove(0, mz);
        // pressing on against a knee-high block (a temple step, a fallen drum) for a moment climbs onto it
        const blocked = Math.hypot(this.pos.x - x0, this.pos.z - z0) < step * 0.3;
        this.pushing = blocked && want.lengthSq() > 0 ? this.pushing + dt : 0;
        if (blocked && ((this.inCrack() && this.tryMove(mx, mz, 1.2)) || (this.pushing > 0.35 && this.tryMove(mx, mz, CLAMBER)))) {
          this.pushing = 0;
        }
      }
      for (const c of colliders) {
        const dx = this.pos.x - c.x, dz = this.pos.z - c.z, rr = c.r + 0.3, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          this.pos.x = c.x + (dx / d) * rr;
          this.pos.z = c.z + (dz / d) * rr;
        }
      }
      // the edge of the world: one cannot go further, only along it
      const ox = this.pos.x - CENTER.x, oz = this.pos.z - CENTER.z, od = Math.hypot(ox, oz);
      if (od > WORLD_RADIUS) {
        const nx = ox / od, nz = oz / od;
        this.pos.x = CENTER.x + nx * WORLD_RADIUS;
        this.pos.z = CENTER.z + nz * WORLD_RADIUS;
        const out = this.vel.x * nx + this.vel.y * nz;
        if (out > 0) this.vel.set(this.vel.x - nx * out, this.vel.y - nz * out);
      }
    }

    const g = groundAt(this.pos.x, this.pos.z, this.feet) ?? this.feet;
    this.feet = g;
    this.eyeY += (g + EYE - this.eyeY) * Math.min(1, dt * 6);

    // the gait: steps counted by distance covered, a footfall at each whole step
    const travelled = Math.hypot(this.pos.x - prev.x, this.pos.z - prev.z);
    if (this.mode !== 'auto') this.speedNow = travelled / Math.max(dt, 1e-4);
    const stride = THREE.MathUtils.lerp(GAIT.walk.stride, GAIT.run.stride, this.runAmt);
    const before = this.phase;
    this.phase += travelled / stride;
    if (Math.floor(this.phase) !== Math.floor(before)) {
      const side = Math.floor(this.phase) % 2 ? 1 : -1;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      this.onStep?.(this.pos.x - fz * 0.16 * side + fx * 0.3, this.pos.z + fx * 0.16 * side + fz * 0.3, g);
    }
    const moving = smooth(0.1, 0.8, this.speedNow); // the motion fades in as one gets going
    const ph = this.phase * Math.PI;
    const walkBob = -Math.cos(2 * ph);                                   // low at footfall, high over the foot
    const runBob = 2 * Math.pow(Math.abs(Math.sin(ph)), 0.7) - 1;       // a sharp dip on landing
    const bob = THREE.MathUtils.lerp(GAIT.walk.bob * walkBob, GAIT.run.bob * runBob, this.runAmt) * moving;
    const sway = Math.sin(ph) * THREE.MathUtils.lerp(GAIT.walk.sway, GAIT.run.sway, this.runAmt) * moving;

    const cam = this.camera;
    const ry = this.yaw + this.lookYaw;
    cam.position.set(this.pos.x + Math.cos(ry) * sway, this.eyeY + bob, this.pos.z - Math.sin(ry) * sway);
    const lean = -0.035 * this.runAmt * moving; // a runner leans into it
    cam.rotation.set(this.pitch + this.lookPitch + lean, ry, sway * 0.35, 'YXZ');
    const fov = FOV + 4 * this.runAmt * moving;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
