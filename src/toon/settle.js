// Loose stones come down to the water.
//
// Here the hills are gone (see useFlatGround). A ruin's loose pieces lying outside its levelled plot, a
// fallen drum, a block of rubble, rested on the hillside or half sank into it, and would now hang in the air
// over the flat shallows. Each such piece is lowered until it sits on the ground below, a hand's breadth in.
// Only the pieces that lay on the land move; whatever stands on other stone stays where it is.

import * as THREE from 'three';
import { SITES, heightAt, landHeightAt } from '../world.js';

const SINK = 0.1; // how far a lowered piece sinks into the ground

export function settleLooseStones(ruins) {
  ruins.updateMatrixWorld(true);
  for (const lod of ruins.children) {
    if (!lod.isLOD || !landChanged(lod)) continue;
    for (const { object } of lod.levels) settle(object);
  }
}

// does the ground around this ruin differ from the land it was built on?
function landChanged(lod) {
  const site = SITES.find((s) => Math.abs(s.x - lod.position.x) < 0.01 && Math.abs(s.z - lod.position.z) < 0.01);
  const r = site ? Math.hypot(site.pad.hw ?? site.pad.r, site.pad.hl ?? site.pad.r) + 12 : 40;
  for (let x = -r; x <= r; x += 3) {
    for (let z = -r; z <= r; z += 3) {
      const wx = lod.position.x + x, wz = lod.position.z + z;
      if (landHeightAt(wx, wz) > Math.max(heightAt(wx, wz), -0.42) + 0.1) return true;
    }
  }
  return false;
}

function settle(mesh) {
  const pos = mesh.geometry.attributes.position, index = mesh.geometry.index.array, n = pos.count;
  // the separate pieces: vertices joined by triangles, or at the same place (split along sharp edges)
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 200)},${Math.round(pos.getY(i) * 200)},${Math.round(pos.getZ(i) * 200)}`;
    const j = seen.get(key);
    if (j === undefined) seen.set(key, i);
    else join(i, j);
  }
  for (let t = 0; t < index.length; t += 3) { join(index[t], index[t + 1]); join(index[t], index[t + 2]); }

  const m = mesh.matrixWorld, v = new THREE.Vector3();
  const pieces = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    let p = pieces.get(r);
    if (!p) pieces.set(r, (p = { y0: Infinity, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, drop: 0 }));
    p.y0 = Math.min(p.y0, v.y);
    p.x0 = Math.min(p.x0, v.x); p.x1 = Math.max(p.x1, v.x);
    p.z0 = Math.min(p.z0, v.z); p.z1 = Math.max(p.z1, v.z);
  }
  let moved = false;
  for (const p of pieces.values()) {
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, hx = (p.x1 - p.x0) * 0.35, hz = (p.z1 - p.z0) * 0.35;
    let ground = -Infinity, land = -Infinity;
    for (const [ox, oz] of [[0, 0], [hx, 0], [-hx, 0], [0, hz], [0, -hz]]) {
      ground = Math.max(ground, heightAt(cx + ox, cz + oz), -0.42);
      land = Math.max(land, landHeightAt(cx + ox, cz + oz));
    }
    // it lay on (or in) the land, and the ground under it now is lower
    if (p.y0 - ground > 0.12 && land > ground + 0.1 && p.y0 - land < 0.3) {
      p.drop = p.y0 - ground + SINK;
      moved = true;
    }
  }
  if (!moved) return;
  for (let i = 0; i < n; i++) {
    const drop = pieces.get(find(i)).drop;
    if (drop) pos.setY(i, pos.getY(i) - drop); // the ruins turn only about the vertical: a drop is the same in their own frame
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}
