"""Plants for 月光浅滩: olive and laurel tree variants, one giant laurel, gentians, asphodel, acanthus, sea daffodils.
(The meadow grass is drawn on the GPU in src/grass.js.)

Run (from the night_greece folder):
  blender --background --factory-startup --python blender/build_plants.py

Writes assets/plants.glb and assets/plants.json. Every plant stands at the origin, base at z = 0
(three.js: y = 0), and the browser scatters instances of each variant over the island.

Vertex colours:
  bark   R = ambient occlusion, G = lichen, B = tone
  leaves R = ambient occlusion, G = tint (dark to silvery); UVs map the sprig texture drawn in the browser,
         and normals point out of the canopy so the foliage lights as one soft volume
  flowers carry their own colour, already darkened by ambient occlusion
"""

import bpy, bmesh, math, random, os, sys, json
from mathutils import Vector, Matrix, Quaternion, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_colossi as bc  # shared helpers; importing it builds nothing

OUT = bc.OUT
UP = Vector((0, 0, 1))


def rand_unit(rng):
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 0.01 < v.length_squared <= 1:
            return v.normalized()


def grow(start, direction, length, step, rng, bend=0.2, up=0.0, droop=0.0):
    """A wandering polyline: each step turns a little at random, toward the light (up) or sags (droop)."""
    n = max(2, int(length / step))
    d = direction.normalized()
    pts = [start.copy()]
    for i in range(n):
        d = (d + rand_unit(rng) * bend + UP * (up - droop * (i + 1) / n)).normalized()
        pts.append(pts[-1] + d * (length / n))
    return pts


def point_at(pts, t):
    f = t * (len(pts) - 1)
    i = min(int(f), len(pts) - 2)
    return pts[i].lerp(pts[i + 1], f - i), (pts[i + 1] - pts[i]).normalized()


BARK_TILE = 0.9  # metres of bark per repeat of the bark texture, around and along a limb


def limb(bm, pts, r0, r1, segs, furrow=0.0, seed=0.0, twist=0.0):
    """A tapering tube along pts with parallel-transported frames; `furrow` carves bark ridges.
    UVs run around (u, a whole number of bark tiles so the seam matches) and along (v) the limb."""
    n = len(pts)
    uv = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    reps = max(1, round(math.tau * (r0 + r1) / 2 / BARK_TILE))
    off = (seed * 0.37) % 1.0
    tang = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    ref = Vector((1, 0, 0)) if abs(tang[0].z) > 0.9 else UP
    nrm = tang[0].cross(ref).normalized()
    length = 0.0
    rings = []
    for i in range(n):
        if i:
            nrm = (tang[i - 1].rotation_difference(tang[i]) @ nrm).normalized()
            length += (pts[i] - pts[i - 1]).length
        b = tang[i].cross(nrm).normalized()
        t = i / (n - 1)
        r = r0 + (r1 - r0) * t
        ring = []
        for s in range(segs):
            a = s / segs * math.tau + twist * length
            ridge = 1.0
            if furrow:
                ridge += furrow * noise.noise(Vector((math.cos(a) * 2.4 + seed, math.sin(a) * 2.4, length * 0.7)))
                ridge += furrow * 0.5 * abs(math.sin(a * 3 + length * 0.9 + seed))
            ring.append(bm.verts.new(pts[i] + (nrm * math.cos(a) + b * math.sin(a)) * r * ridge))
        rings.append(ring)
    vs = [0.0]
    for i in range(1, n):
        vs.append(vs[-1] + (pts[i] - pts[i - 1]).length / BARK_TILE)
    for i in range(n - 1):
        for s in range(segs):
            j = (s + 1) % segs
            f = bm.faces.new((rings[i][s], rings[i][j], rings[i + 1][j], rings[i + 1][s]))
            u0, u1 = s / segs * reps + off, (s + 1) / segs * reps + off
            for loop, co in zip(f.loops, ((u0, vs[i]), (u1, vs[i]), (u1, vs[i + 1]), (u0, vs[i + 1]))):
                loop[uv].uv = co
    tip = bm.verts.new(pts[-1] + tang[-1] * r1 * 0.6)
    for s in range(segs):
        f = bm.faces.new((rings[-1][s], rings[-1][(s + 1) % segs], tip))
        u0, u1 = s / segs * reps + off, (s + 1) / segs * reps + off
        for loop, co in zip(f.loops, ((u0, vs[-1]), (u1, vs[-1]), ((u0 + u1) / 2, vs[-1] + 0.1))):
            loop[uv].uv = co


class Leaves:
    """Leaf cards (a sprig texture on each): position of the stem end, growth direction, size, tint."""

    def __init__(self):
        self.cards = []

    def along(self, pts, count, size, rng, tint, spread=0.9, start=0.2):
        for _ in range(count):
            p, d = point_at(pts, rng.uniform(start, 1.0))
            dirn = (d * 0.6 + rand_unit(rng) * spread + UP * 0.25).normalized()
            self.cards.append((p, dirn, rand_unit(rng), rng.uniform(*size), min(1.0, max(0.0, tint + rng.uniform(-0.25, 0.25)))))

    def mesh(self, name, normal_bias=0.35):
        """Quads with UVs; normals bent outward from the canopy's centre for soft, volumetric shading."""
        if not self.cards:
            return None
        c = sum((p for p, *_ in self.cards), Vector()) / len(self.cards)
        ext = Vector([max(0.5, max(abs(p[k] - c[k]) for p, *_ in self.cards)) for k in range(3)])
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new('UVMap')
        col = bm.verts.layers.float_color.new('Col')
        normals = []
        for p, d, r, size, tint in self.cards:
            side = d.cross(r)
            if side.length < 1e-3:
                side = d.cross(Vector((1, 0, 0)))
            side.normalize()
            w, h = size * 0.5, size
            q = [p - side * w / 2, p + side * w / 2, p + side * w / 2 + d * h, p - side * w / 2 + d * h]
            vs = [bm.verts.new(v) for v in q]
            f = bm.faces.new(vs)
            for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                loop[uv].uv = (u, v)
            mid = p + d * h * 0.5
            rel = Vector(((mid.x - c.x) / ext.x, (mid.y - c.y) / ext.y, (mid.z - c.z) / ext.z))
            n = (rel.normalized() + UP * normal_bias).normalized()
            for v in vs:
                v[col] = (1.0, tint, 0.0, 1.0)
                normals.append(n)
        ob = bc.obj_from_bm(bm, name)
        ob['custom_normals'] = [tuple(n) for n in normals]
        return ob


def apply_custom_normals(ob):
    if 'custom_normals' in ob:
        ob.data.normals_split_custom_set_from_vertices([Vector(n) for n in ob['custom_normals']])
        del ob['custom_normals']


# ------------------------------------------------------------------ trees

def olive(seed):
    """Gnarled olive: one to three twisted, furrowed stems, spreading limbs, drooping silvery sprigs."""
    rng = random.Random(seed)
    bark, leaves = bmesh.new(), Leaves()
    nstem = rng.choice([1, 2, 2, 3])
    lean = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized() * rng.uniform(0.12, 0.35)
    for s in range(nstem):
        off = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * (0.2 if nstem > 1 else 0)
        d = (UP + lean + off * 1.6).normalized()
        H = rng.uniform(1.3, 2.2)
        stem = grow(Vector((off.x, off.y, -0.4)), d, H + 0.4, 0.22, rng, bend=0.16)
        r0 = 0.42 if nstem == 1 else 0.3
        limb(bark, stem, r0 * 1.3, r0 * 0.8, 12, furrow=0.3, seed=seed + s, twist=0.6)
        top = stem[-1]
        for l in range(rng.randint(2, 3)):
            a = rng.uniform(0, math.tau)
            ld = Vector((math.cos(a), math.sin(a), rng.uniform(0.8, 1.5))).normalized()
            arm = grow(top - d * rng.uniform(0, 0.35), ld, rng.uniform(1.6, 2.6), 0.3, rng, bend=0.2, up=0.04)
            limb(bark, arm, r0 * 0.62, r0 * 0.22, 9, furrow=0.18, seed=seed + l * 3, twist=0.3)
            for b in range(rng.randint(3, 5)):
                bp, _ = point_at(arm, rng.uniform(0.35, 1.0))
                bd = (ld + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 1.1 + UP * 0.1).normalized()
                br = grow(bp, bd, rng.uniform(0.9, 1.7), 0.25, rng, bend=0.25, droop=0.25)
                limb(bark, br, r0 * 0.2, 0.025, 6)
                for _ in range(rng.randint(3, 5)):
                    tp, td = point_at(br, rng.uniform(0.3, 1.0))
                    tw = grow(tp, (td + rand_unit(rng) * 1.2).normalized(), rng.uniform(0.4, 0.8), 0.2, rng, bend=0.3, droop=0.35)
                    limb(bark, tw, 0.022, 0.008, 4)
                    leaves.along(tw, rng.randint(5, 8), (0.42, 0.62), rng, tint=0.55)
    return bark, leaves, {'trunk': r0 * 1.2 * max(1, nstem * 0.7)}


def laurel(seed):
    """Bay laurel: several slender upright stems, ascending branches, a dense dark ovoid crown."""
    rng = random.Random(seed)
    bark, leaves = bmesh.new(), Leaves()
    nstem = rng.randint(3, 5)
    for s in range(nstem):
        a0 = s / nstem * math.tau + rng.uniform(-0.4, 0.4)
        out = Vector((math.cos(a0), math.sin(a0), 0))
        H = rng.uniform(5.0, 7.5)
        stem = grow(out * 0.18 + Vector((0, 0, -0.4)), (UP + out * rng.uniform(0.08, 0.25)).normalized(), H, 0.4, rng, bend=0.07, up=0.02)
        limb(bark, stem, 0.17, 0.04, 8, furrow=0.08, seed=seed + s)
        k = 0
        t = 0.3
        while t < 0.97:
            bp, sd = point_at(stem, t)
            side = a0 + (k % 2 - 0.5) * 2.2 + rng.uniform(-0.5, 0.5)
            bd = (Vector((math.cos(side), math.sin(side), 0)) * 0.75 + UP * 0.95).normalized()
            L = rng.uniform(0.8, 2.0) * (1.15 - t * 0.6)
            br = grow(bp, bd, L, 0.25, rng, bend=0.15, up=0.05)
            limb(bark, br, 0.05, 0.012, 5)
            leaves.along(br, rng.randint(3, 5), (0.45, 0.62), rng, tint=0.35)
            for _ in range(rng.randint(2, 3)):
                tp, td = point_at(br, rng.uniform(0.4, 1.0))
                tw = grow(tp, (td + rand_unit(rng) * 0.9 + UP * 0.2).normalized(), rng.uniform(0.3, 0.6), 0.15, rng, bend=0.25)
                limb(bark, tw, 0.012, 0.006, 4)
                leaves.along(tw, rng.randint(6, 9), (0.45, 0.62), rng, tint=0.35)
            t += rng.uniform(0.05, 0.1)
            k += 1
    return bark, leaves, {'trunk': 0.45}


def giant_laurel(seed):
    """An ancient laurel grown alone for millennia: a 3 m trunk on buttress roots that forks into four great
    limbs; each forks again into limbs spreading almost level, so the crown opens into a broad parasol.
    Every limb starts inside its parent and never thicker than the parent is there."""
    rng = random.Random(seed)
    bark, leaves = bmesh.new(), Leaves()
    trunk = grow(Vector((0, 0, -0.8)), (UP + Vector((0.05, -0.03, 0))).normalized(), 6.8, 0.5, rng, bend=0.04)
    tr0, tr1 = 1.65, 1.2
    limb(bark, trunk, tr0, tr1, 22, furrow=0.1, seed=seed, twist=0.08)
    # buttress roots: they leave the trunk low, flare out along the ground half buried, and dive into the soil
    for k in range(7):
        a = k / 7 * math.tau + rng.uniform(-0.3, 0.3)
        out = Vector((math.cos(a), math.sin(a), 0))
        reach, r0, r1 = rng.uniform(3.6, 5.4), 0.85, 0.14
        root = []
        for i in range(9):
            t = i / 8
            r = r0 + (r1 - r0) * t
            z = 1.3 * (1 - t) ** 3 + 0.2 * r - 0.9 * t * t
            root.append(Vector((0, 0, z)) + out * (0.6 + t * reach)
                        + Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0)) * (i > 0))
        limb(bark, root, r0, r1, 12, furrow=0.1, seed=seed + k)

    def radius_at(r0, r1, t):
        return r0 + (r1 - r0) * t

    def leafy_branch(start, d, length, r0):
        br = grow(start, d, length, 0.45, rng, bend=0.14, up=0.04)
        limb(bark, br, r0, 0.05, 8)
        for _ in range(rng.randint(9, 12)):
            tp, td = point_at(br, rng.uniform(0.2, 1.0))
            tw = grow(tp, (td * 0.5 + rand_unit(rng) * 0.6 + UP * 0.6).normalized(), rng.uniform(1.0, 2.0), 0.35, rng, bend=0.2)
            limb(bark, tw, 0.05, 0.015, 5)
            leaves.along(tw, rng.randint(12, 15), (1.0, 1.45), rng, tint=0.3, spread=0.8)

    nmain = 4
    for m in range(nmain):
        a = m / nmain * math.tau + rng.uniform(-0.35, 0.35)
        out = Vector((math.cos(a), math.sin(a), 0))
        # a great limb leaves the fork rising steeply, then leans out
        t0 = rng.uniform(0.82, 0.95)
        start, _ = point_at(trunk, t0)
        m0, m1 = min(1.0, 0.8 * radius_at(tr0, tr1, t0)), 0.5
        main = grow(start, (out * 0.6 + UP * 1.0).normalized(), rng.uniform(8.0, 10.0), 0.5, rng, bend=0.05, droop=0.1)
        limb(bark, main, m0, m1, 16, furrow=0.08, seed=seed + m * 5, twist=0.05)
        # it forks into two or three limbs that spread almost level, fanning out sideways
        nsec = rng.randint(2, 3)
        for k in range(nsec):
            t = 1.0 if k == 0 else rng.uniform(0.55, 0.8)
            sp, sd = point_at(main, t)
            fan = (k - (nsec - 1) / 2) * rng.uniform(0.6, 0.9) + rng.uniform(-0.2, 0.2)
            ang = math.atan2(out.y, out.x) + fan
            d = Vector((math.cos(ang), math.sin(ang), rng.uniform(0.2, 0.45))).normalized()
            s0 = min(0.45, 0.85 * radius_at(m0, m1, t))
            sec = grow(sp, (sd * 0.3 + d * 0.7).normalized(), rng.uniform(6.5, 9.0), 0.5, rng, bend=0.07, droop=0.05)
            limb(bark, sec, s0, 0.14, 12, furrow=0.06, seed=seed + m * 5 + k)
            # leafy branches along it, reaching out and up into the canopy
            for b in range(rng.randint(5, 7)):
                bt = rng.uniform(0.3, 1.0)
                bp, bd = point_at(sec, bt)
                side = Vector((-bd.y, bd.x, 0)) * rng.choice((-1, 1))
                d2 = (bd * 0.8 + side * 0.6 + UP * 0.3).normalized()
                leafy_branch(bp, d2, rng.uniform(3.0, 5.5), min(0.18, 0.8 * radius_at(s0, 0.14, bt)))
        # and a few along the great limb itself, filling the crown between the limbs
        for b in range(2):
            bt = rng.uniform(0.45, 0.85)
            bp, bd = point_at(main, bt)
            d2 = (bd * 0.4 + rand_unit(rng) * 0.5 + UP * 0.6).normalized()
            leafy_branch(bp, d2, rng.uniform(3.0, 4.5), min(0.2, 0.8 * radius_at(m0, m1, bt)))
    # a leader carries on up from the fork, so the middle of the crown is not hollow
    t0 = 0.97
    start, _ = point_at(trunk, t0)
    lead = grow(start, (UP + rand_unit(rng) * 0.15).normalized(), 6.0, 0.5, rng, bend=0.06)
    l0 = min(0.75, 0.6 * radius_at(tr0, tr1, t0))
    limb(bark, lead, l0, 0.15, 12, furrow=0.06, seed=seed + 99)
    for b in range(6):
        bt = rng.uniform(0.35, 1.0)
        bp, bd = point_at(lead, bt)
        a = b / 6 * math.tau + rng.uniform(-0.4, 0.4)
        d2 = (Vector((math.cos(a), math.sin(a), 0)) * 0.8 + UP * 0.5).normalized()
        leafy_branch(bp, d2, rng.uniform(3.0, 5.0), min(0.18, 0.8 * radius_at(l0, 0.15, bt)))
    return bark, leaves, {'trunk': 2.4}


# ------------------------------------------------------------------ gentians and grass

def gentian_clump(seed):
    """Several stems with paired leaves, each crowned by pink-violet trumpet flowers."""
    rng = random.Random(seed)
    bm = bmesh.new()
    col = bm.verts.layers.float_color.new('Col')
    stem_c, leaf_c = (0.05, 0.12, 0.04), (0.07, 0.16, 0.05)
    calyx, body, lobe = Vector((0.1, 0.2, 0.07)), Vector((0.3, 0.12, 0.62)), Vector((0.68, 0.3, 0.76))

    def paint(verts, c):
        for v in verts:
            v[col] = (c[0], c[1], c[2], 1.0)

    def flower(base, d, size, hue):
        prof = [(0.0, 0.05), (0.014, 0.1), (0.04, 0.13), (0.07, 0.16), (0.095, 0.21), (0.11, 0.28), (0.118, 0.38)]
        radial = 10
        q = UP.rotation_difference(d)
        spin = rng.uniform(0, math.tau)
        rings = []
        for j, (z, r) in enumerate(prof):
            t = j / (len(prof) - 1)
            c = calyx.lerp(body, min(1, t / 0.25)) if t < 0.25 else body.lerp(lobe, bc.smoothstep(0.35, 1, t))
            c = c.lerp(Vector((c.x * 1.15, c.y * 0.9, c.z * 1.0)), hue)
            ring = []
            for i in range(radial):
                a = i / radial * math.tau + spin
                last = j == len(prof) - 1
                lob = 1 + (0.28 * math.cos(5 * a) if last else 0.06 * math.cos(5 * a) * t)
                zz = z + (0.012 * math.cos(5 * a) if last else 0)
                v = bm.verts.new(base + q @ (Vector((math.cos(a) * r * lob, math.sin(a) * r * lob, zz)) * size))
                v[col] = (c.x, c.y, c.z, 1.0)
                ring.append(v)
            rings.append(ring)
        for j in range(len(rings) - 1):
            for i in range(radial):
                k = (i + 1) % radial
                bm.faces.new((rings[j][i], rings[j][k], rings[j + 1][k], rings[j + 1][i]))
        tip = bm.verts.new(base - d * 0.004)
        paint([tip], calyx)
        for i in range(radial):
            bm.faces.new((rings[0][(i + 1) % radial], rings[0][i], tip))

    def leaf(base, along, side, length, width):
        pts, verts = 5, []
        for i in range(pts + 1):
            t = i / pts
            w = width * math.sin(math.pi * t) ** 0.8
            p = base + along * length * t + UP * (length * 0.25 * t * t)
            verts.append((bm.verts.new(p - side * w / 2), bm.verts.new(p + side * w / 2)))
        for i in range(pts):
            bm.faces.new((verts[i][0], verts[i][1], verts[i + 1][1], verts[i + 1][0]))
        paint([v for pair in verts for v in pair], leaf_c)

    n = rng.randint(4, 8)
    for s in range(n):
        a = rng.uniform(0, math.tau)
        rr = math.sqrt(rng.random()) * 0.16
        base = Vector((math.cos(a) * rr, math.sin(a) * rr, -0.02))
        tilt = rng.uniform(0.06, 0.38)
        d = Vector((math.sin(tilt) * math.cos(a), math.sin(tilt) * math.sin(a), math.cos(tilt)))
        L = rng.uniform(0.3, 0.58)
        pts = grow(base, d, L, L / 4, rng, bend=0.06)
        nv = len(bm.verts)
        limb(bm, pts, 0.008, 0.005, 5)
        paint(list(bm.verts)[nv:], stem_c)
        for node in range(1, 4):
            p, sd = point_at(pts, node * 0.22)
            ang = a + node * math.pi / 2
            for sign in (1, -1):
                out = Vector((math.cos(ang) * sign, math.sin(ang) * sign, 0))
                along = (out * 0.85 + UP * 0.5).normalized()
                leaf(p, along, along.cross(UP).normalized(), rng.uniform(0.07, 0.1), rng.uniform(0.018, 0.024))
        top, td = pts[-1], (pts[-1] - pts[-2]).normalized()
        hue = rng.random()
        size = rng.uniform(1.0, 1.3) * 0.27
        flower(top, (td + rand_unit(rng) * 0.15).normalized(), size, hue)
        for _ in range(rng.choice([0, 1, 1, 2])):
            p, _ = point_at(pts, rng.uniform(0.72, 0.9))
            fd = (td + Vector((math.cos(a + rng.uniform(-2, 2)), math.sin(a + rng.uniform(-2, 2)), 0)) * 0.8).normalized()
            flower(p, fd, size * 0.85, hue)
    return bc.obj_from_bm(bm, f'Gentian{seed}')


# ------------------------------------------------------------------ asphodel, acanthus, sea daffodil

class Painter:
    """A bmesh with a per-vertex colour layer and a few small shape helpers."""

    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.verts.layers.float_color.new('Col')

    def v(self, p, c):
        vert = self.bm.verts.new(p)
        vert[self.col] = (c[0], c[1], c[2], 1.0)
        return vert

    def strip(self, rows):
        """rows: list of (left, right, colour) pairs along a ribbon."""
        vs = [(self.v(l, c), self.v(r, c)) for l, r, c in rows]
        for i in range(len(vs) - 1):
            self.bm.faces.new((vs[i][0], vs[i][1], vs[i + 1][1], vs[i + 1][0]))

    def stem(self, pts, r0, r1, c, segs=4):
        n0 = len(self.bm.verts)
        limb(self.bm, pts, r0, r1, segs)
        for vert in list(self.bm.verts)[n0:]:
            vert[self.col] = (c[0], c[1], c[2], 1.0)

    def strap_leaf(self, base, out, length, width, c0, c1, rise=0.55, droop=0.35, twist=0.0, segs=6):
        side = Vector((-out.y, out.x, 0))
        rows = []
        for i in range(segs + 1):
            t = i / segs
            p = base + out * length * 0.85 * t + UP * length * (rise * math.sin(t * math.pi * 0.6) - droop * t * t)
            w = width * (1 - t ** 1.5) + 0.001
            sd = (side * math.cos(twist * t) + UP * math.sin(twist * t)).normalized()
            rows.append((p - sd * w / 2, p + sd * w / 2, Vector(c0).lerp(Vector(c1), t)))
        self.strip(rows)

    def star(self, centre, normal, n, length, width, c_mid, c_tip, cup=0.25, spin=0.0):
        """A flat flower of n narrow tepals radiating from centre."""
        ref = Vector((1, 0, 0)) if abs(normal.x) < 0.9 else Vector((0, 1, 0))
        u = normal.cross(ref).normalized()
        w = normal.cross(u).normalized()
        c = self.v(centre, c_mid)
        for k in range(n):
            a = spin + k / n * math.tau
            d = u * math.cos(a) + w * math.sin(a)
            s = u * math.cos(a + math.pi / 2) + w * math.sin(a + math.pi / 2)
            mid = centre + d * length * 0.5 + normal * length * cup * 0.3
            tip = centre + d * length + normal * length * cup
            l, r = self.v(mid - s * width / 2, c_mid), self.v(mid + s * width / 2, c_mid)
            t = self.v(tip, c_tip)
            self.bm.faces.new((c, l, t, r))

    def obj(self, name):
        return bc.obj_from_bm(self.bm, name)


def asphodel(seed):
    """Asphodel: a rosette of strap leaves and tall branching stems of white star flowers."""
    rng = random.Random(seed)
    P = Painter()
    for _ in range(rng.randint(10, 15)):
        a = rng.uniform(0, math.tau)
        P.strap_leaf(Vector((0, 0, -0.02)), Vector((math.cos(a), math.sin(a), 0)), rng.uniform(0.35, 0.6), rng.uniform(0.02, 0.032),
                     (0.06, 0.12, 0.05), (0.12, 0.2, 0.08), rise=rng.uniform(0.4, 0.7), droop=rng.uniform(0.2, 0.5), twist=rng.uniform(-0.6, 0.6))
    white, mid = (0.86, 0.85, 0.82), (0.72, 0.58, 0.6)
    for s_ in range(rng.randint(1, 3)):
        lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1)).normalized()
        H = rng.uniform(0.85, 1.25)
        main = grow(Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0)), lean, H, H / 6, rng, bend=0.04)
        P.stem(main, 0.009, 0.004, (0.12, 0.16, 0.07))
        spikes = [main]
        for _ in range(rng.randint(2, 4)):
            bp, bd = point_at(main, rng.uniform(0.45, 0.75))
            out = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized()
            br = grow(bp, (bd + out * 0.6).normalized(), rng.uniform(0.18, 0.32), 0.08, rng, bend=0.05, up=0.1)
            P.stem(br, 0.005, 0.003, (0.12, 0.16, 0.07))
            spikes.append(br)
        for sp in spikes:
            k = 0
            t = 0.5 if sp is main else 0.25
            while t < 0.97:
                p, d = point_at(sp, t)
                ang = k * 2.4
                out = Vector((math.cos(ang), math.sin(ang), 0))
                if t > 0.88:  # buds at the tip
                    P.star(p + out * 0.008, (out + UP).normalized(), 3, 0.014, 0.006, (0.3, 0.26, 0.2), (0.45, 0.38, 0.32), cup=1.2)
                else:
                    P.star(p + out * 0.012, (out * 1.2 + UP * 0.6).normalized(), 6, rng.uniform(0.03, 0.038), 0.011, mid, white, spin=rng.uniform(0, 1))
                t += rng.uniform(0.04, 0.07) * (1.6 if sp is main else 1.2)
                k += 1
    return P.obj(f'Asphodel{seed}')


def acanthus(seed):
    """Acanthus mollis: big glossy, deeply lobed leaves and a tall spike of white and mauve hooded flowers."""
    rng = random.Random(seed)
    P = Painter()
    for k in range(rng.randint(7, 10)):
        a = k / 9 * math.tau + rng.uniform(-0.3, 0.3)
        out = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-out.y, out.x, 0))
        L, W = rng.uniform(0.5, 0.8), rng.uniform(0.2, 0.28)
        lobes = rng.randint(4, 6)
        nt, nu = 12, 6
        grid = []
        for i in range(nt + 1):
            t = i / nt
            half = W * math.sin(math.pi * min(t, 0.98)) ** 0.6 * (0.5 + 0.5 * abs(math.sin(t * math.pi * lobes)))
            spine = out * L * 0.9 * t + UP * L * (0.55 * math.sin(t * math.pi * 0.75) - 0.25 * t * t)
            row = []
            for j in range(nu + 1):
                u = -1 + 2 * j / nu
                p = spine + side * u * half + UP * (0.05 * half * (u * u) - 0.02 * half)
                c = Vector((0.15, 0.2, 0.1)).lerp(Vector((0.035, 0.09, 0.035)), min(1, abs(u) * 3))
                row.append(P.v(p, c))
            grid.append(row)
        for i in range(nt):
            for j in range(nu):
                P.bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]))
    for _ in range(rng.randint(1, 2)):
        H = rng.uniform(0.9, 1.35)
        sp = grow(Vector((rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 0)), Vector((rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), 1)), H, H / 6, rng, bend=0.03)
        P.stem(sp, 0.013, 0.007, (0.14, 0.15, 0.08))
        t, k = 0.4, 0
        while t < 0.98:
            p, d = point_at(sp, t)
            for m in range(3):
                ang = k * 0.9 + m * math.tau / 3
                out = Vector((math.cos(ang), math.sin(ang), 0))
                side = Vector((-out.y, out.x, 0))
                base = p + out * 0.012
                hood_tip = base + out * 0.045 + UP * 0.03
                lip_tip = base + out * 0.05 - UP * 0.015
                hood = (0.28, 0.13, 0.27)
                P.bm.faces.new((P.v(base - side * 0.012, hood), P.v(base + side * 0.012, hood), P.v(hood_tip, hood)))
                lip = (0.8, 0.76, 0.78)
                P.bm.faces.new((P.v(base - side * 0.014 - UP * 0.004, lip), P.v(lip_tip, lip), P.v(base + side * 0.014 - UP * 0.004, lip)))
            t += 0.035
            k += 1
    return P.obj(f'Acanthus{seed}')


def sea_daffodil(seed):
    """Pancratium maritimum: grey-green strap leaves and an umbel of white trumpets with a frilled crown."""
    rng = random.Random(seed)
    P = Painter()
    for _ in range(rng.randint(5, 8)):
        a = rng.uniform(0, math.tau)
        P.strap_leaf(Vector((0, 0, -0.02)), Vector((math.cos(a), math.sin(a), 0)), rng.uniform(0.28, 0.45), rng.uniform(0.016, 0.024),
                     (0.12, 0.17, 0.13), (0.2, 0.25, 0.2), rise=0.3, droop=0.25, twist=rng.uniform(1.0, 2.5))
    white, throat = (0.9, 0.9, 0.87), (0.55, 0.62, 0.45)
    for _ in range(rng.randint(1, 2)):
        H = rng.uniform(0.3, 0.42)
        sc = grow(Vector((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0)), Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1)), H, H / 4, rng, bend=0.04)
        P.stem(sc, 0.008, 0.006, (0.16, 0.22, 0.15))
        top = sc[-1]
        n = rng.randint(4, 7)
        for f in range(n):
            ang = f / n * math.tau + rng.uniform(-0.3, 0.3)
            out = Vector((math.cos(ang), math.sin(ang), 0))
            d = (out * 0.8 + UP * rng.uniform(0.6, 1.0)).normalized()
            end = top + d * 0.075
            P.stem([top, top.lerp(end, 0.5), end], 0.005, 0.007, throat)
            P.star(end, d, 6, 0.05, 0.008, white, white, cup=0.15, spin=rng.uniform(0, 1))
            # the frilled corona: a short toothed cup
            ref = Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))
            u = d.cross(ref).normalized()
            w = d.cross(u).normalized()
            teeth = 12
            lo, hi = [], []
            for k in range(teeth):
                a = k / teeth * math.tau
                r = u * math.cos(a) + w * math.sin(a)
                lo.append(P.v(end + r * 0.011, white))
                hi.append(P.v(end + r * (0.022 + 0.004 * (k % 2)) + d * (0.024 + 0.005 * (k % 2)), white))
            for k in range(teeth):
                k2 = (k + 1) % teeth
                P.bm.faces.new((lo[k], lo[k2], hi[k2], hi[k]))
    return P.obj(f'SeaDaffodil{seed}')


# ------------------------------------------------------------------ baking, export

def setup_bake():
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = 48
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for dv in prefs.devices:
            dv.use = True
        scn.cycles.device = 'GPU'
    except Exception:
        scn.cycles.device = 'CPU'
    scn.world = bpy.data.worlds.new('w')
    gm = bmesh.new()
    bmesh.ops.create_grid(gm, x_segments=1, y_segments=1, size=400)
    bc.obj_from_bm(gm, 'ao_ground', smooth=False)
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    return mat


def bake_ao(ob, mat, distance):
    """Bake ambient occlusion and return it per vertex (softened)."""
    bpy.context.scene.world.light_settings.distance = distance
    if not ob.data.materials:
        ob.data.materials.append(mat)
    attr = ob.data.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
    ob.data.color_attributes.active_color = attr
    ob.data.attributes.default_color_name = 'AO'
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    ao = [0.3 + 0.7 * c.color[0] for c in attr.data]
    ob.data.color_attributes.remove(attr)
    return ao


def finish_colours(ob, ao, mode):
    me = ob.data
    if 'Col' not in me.color_attributes:
        me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    col = me.color_attributes['Col']
    for i, (c, v) in enumerate(zip(col.data, me.vertices)):
        r, g, b, _ = c.color
        if mode == 'bark':
            p = v.co
            lichen = max(0.0, noise.noise(Vector((p.x * 1.7, p.y * 1.7, p.z * 0.9)))) * 1.4
            c.color = (ao[i], min(1.0, lichen), 0.5 + 0.5 * noise.noise(p * 0.4), 1.0)
        elif mode == 'leaves':
            c.color = (ao[i], g, 0.0, 1.0)
        else:  # coloured: darken the colour by occlusion
            c.color = (r * ao[i], g * ao[i], b * ao[i], 1.0)
    me.color_attributes.active_color = col
    me.attributes.default_color_name = 'Col'


def main():
    bc.reset()
    mat = setup_bake()
    meta = {'trees': [], 'gentians': []}
    parked = []
    park_x = 0.0

    # each plant is baked alone at the origin, then moved aside so it can't shade the next; all return at export
    def park(objs, extent):
        nonlocal park_x
        park_x += extent + 60
        for ob in objs:
            ob.data.transform(Matrix.Translation(Vector((park_x, 0, 0))))
            parked.append((ob, park_x))

    def tree(kind, name, fn, seed, leaf_ao):
        bark_bm, leaves, info = fn(seed)
        bark = bc.obj_from_bm(bark_bm, name + '_bark')
        leaf = leaves.mesh(name + '_leaves')
        apply_custom_normals(leaf)
        finish_colours(bark, bake_ao(bark, mat, leaf_ao), 'bark')
        finish_colours(leaf, bake_ao(leaf, mat, leaf_ao), 'leaves')
        zs = [v.co.z for v in leaf.data.vertices]
        xs = [math.hypot(v.co.x, v.co.y) for v in leaf.data.vertices]
        meta['trees'].append({'kind': kind, 'bark': bark.name, 'leaves': leaf.name, 'height': round(max(zs), 2),
                              'radius': round(sorted(xs)[int(len(xs) * 0.9)], 2), 'trunk': round(info['trunk'], 2),
                              'cards': len(leaves.cards)})
        print(f'[plants] {name}: {len(leaves.cards)} leaf cards, height {max(zs):.1f} m')
        park([bark, leaf], max(xs) + 2)

    for i in range(4):
        tree('olive', f'Olive{i}', olive, 100 + i, 1.2)
    for i in range(3):
        tree('laurel', f'Laurel{i}', laurel, 200 + i, 1.2)
    tree('giant', 'GiantLaurel', giant_laurel, 300, 3.0)

    for i in range(6):
        ob = gentian_clump(400 + i)
        finish_colours(ob, bake_ao(ob, mat, 0.15), 'colour')
        meta['gentians'].append({'node': ob.name})
        park([ob], 1)
    for kind, fn, base, n, dist in (('asphodel', asphodel, 600, 3, 0.2), ('acanthus', acanthus, 700, 3, 0.25),
                                     ('daffodils', sea_daffodil, 800, 3, 0.12)):
        meta[kind] = []
        for i in range(n):
            ob = fn(base + i)
            finish_colours(ob, bake_ao(ob, mat, dist), 'colour')
            meta[kind].append({'node': ob.name})
            park([ob], 2)

    for ob, x in parked:
        ob.data.transform(Matrix.Translation(Vector((-x, 0, 0))))
    bpy.data.objects.remove(bpy.data.objects['ao_ground'])
    bpy.ops.object.select_all(action='DESELECT')
    for ob, _ in parked:
        ob.data.materials.clear()
        ob.select_set(True)
    tris = sum(sum(len(p.vertices) - 2 for p in ob.data.polygons) for ob, _ in parked)
    print(f'[plants] total triangles {tris}')
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, 'plants.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_materials='NONE', export_vertex_color='ACTIVE',
        export_active_vertex_color_when_no_material=True, export_normals=True, export_texcoords=True,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
    )
    with open(os.path.join(OUT, 'plants.json'), 'w') as f:
        json.dump(meta, f, indent=1)


if __name__ == '__main__':
    main()
