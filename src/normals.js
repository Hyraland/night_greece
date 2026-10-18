// Even shading for flat stone faces.
//
// The ruins come with smooth normals split at sharp edges. Where a big flat face meets the narrow chamfers
// along its edges, its corner normals lean toward them, so across the face the normal turns by a few
// degrees. Under a low moon that is enough to sweep a gradient of light across every block, each one on its
// own (and in the two tones, a hard step from lit to shaded). Weighting each face by its area when the normals are averaged
// lets the big face decide its own corners: flat faces shade as one, columns stay round.

import * as THREE from 'three';

const done = new WeakSet();

export function evenNormals(object) {
  object.traverse((o) => {
    if (o.isMesh && o.geometry.index && o.geometry.attributes.normal && !done.has(o.geometry)) {
      areaWeighted(o.geometry);
      done.add(o.geometry);
    }
  });
}

function areaWeighted(geo) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, index = geo.index.array;
  const count = pos.count;

  // one group per smooth surface around a point: vertices at the same place with (about) the same normal,
  // so seams in other attributes don't split it, and sharp edges (normals far apart) still do
  const group = new Int32Array(count);
  const firstOf = new Map();
  const repr = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    let list = firstOf.get(key);
    if (!list) firstOf.set(key, (list = []));
    let g = -1;
    for (const k of list) if (repr[k * 3] * nx + repr[k * 3 + 1] * ny + repr[k * 3 + 2] * nz > 0.9) { g = k; break; }
    if (g < 0) {
      g = repr.length / 3;
      repr.push(nx, ny, nz);
      list.push(g);
    }
    group[i] = g;
  }

  // sum each triangle's normal, its length twice its area, into the groups at its corners
  const sum = new Float32Array(repr.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < index.length; t += 3) {
    const i0 = index[t], i1 = index[t + 1], i2 = index[t + 2];
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1).sub(a);
    c.fromBufferAttribute(pos, i2).sub(a);
    b.cross(c);
    for (const i of [i0, i1, i2]) {
      const g = group[i] * 3;
      sum[g] += b.x;
      sum[g + 1] += b.y;
      sum[g + 2] += b.z;
    }
  }
  for (let i = 0; i < count; i++) {
    const g = group[i] * 3;
    a.set(sum[g], sum[g + 1], sum[g + 2]);
    if (a.lengthSq() > 0) a.normalize();
    else a.fromBufferAttribute(nrm, i);
    nrm.setXYZ(i, a.x, a.y, a.z);
  }
  nrm.needsUpdate = true;
}
