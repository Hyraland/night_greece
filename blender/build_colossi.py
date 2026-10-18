"""Colossal ruins for 月光浅滩, built procedurally in Blender and exported as GLB.

Run (from the night_greece folder):
  blender --background --factory-startup --python blender/build_colossi.py -- temple statues
  ... -- temple --preview /some/folder      # also render preview images

Blender is Z-up; the glTF exporter turns it Y-up (Blender -Y becomes three.js +Z).
Each asset faces Blender -Y, i.e. its front is local +Z in three.js. z = 0 is the water surface.
Every asset gets ambient occlusion baked into the vertex colour "AO" and a JSON sidecar
with colliders / floors / gaze points in three.js local coordinates.
"""

import bpy, bmesh, math, random, json, os, sys
from mathutils import Vector, Matrix, Quaternion, noise

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets')
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = ARGV[ARGV.index('--preview') + 1] if '--preview' in ARGV else None
BUILDS = ('temple', 'statues', 'hall', 'podium', 'propylon', 'naos', 'tholos', 'stoa', 'shrine', 'hill', 'laurel_ruins', 'avenue')
WHAT = [a for a in ARGV if a in BUILDS] or list(BUILDS)
SEABED = -0.42
MOON = Vector((0.3, 1.0, 0.37)).normalized()  # three.js MOON_DIR in Blender axes


# ------------------------------------------------------------------ basics

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def obj_from_bm(bm, name, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    return link(bpy.data.objects.new(name, me))


def apply_mods(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def join(objs, name):
    bm = bmesh.new()
    for o in objs:
        me = o.data.copy()
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    for o in objs:
        bpy.data.objects.remove(o)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def fbm(x, y, z=0.0, oct=4, seed=0.0):
    return noise.fractal(Vector((x + seed * 13.1, y - seed * 7.3, z + seed * 3.7)), 1.0, 2.0, oct, noise_basis='PERLIN_NEW')


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def look_rot(direction, up=Vector((0, 0, 1))):
    return direction.to_track_quat('Z', 'Y')


# ------------------------------------------------------------------ primitives in bmesh

def lathe(bm, profile, segs, radius_fn=None, matrix=Matrix()):
    """profile: list of (r, z) bottom to top. r == 0 at an end closes it with a single vertex."""
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new(matrix @ Vector((0, 0, z)))])
            continue
        ring = []
        for i in range(segs):
            a = i / segs * math.tau
            rr = radius_fn(a, z, r) if radius_fn else r
            ring.append(bm.verts.new(matrix @ Vector((math.cos(a) * rr, math.sin(a) * rr, z))))
        rings.append(ring)
    for k in range(len(rings) - 1):
        A, B = rings[k], rings[k + 1]
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:   # bottom cap, facing down
            for i in range(segs):
                bm.faces.new((A[0], B[(i + 1) % segs], B[i]))
        elif len(B) == 1:  # top cap, facing up
            for i in range(segs):
                bm.faces.new((A[i], A[(i + 1) % segs], B[0]))
        else:
            for i in range(segs):
                j = (i + 1) % segs
                bm.faces.new((A[i], A[j], B[j], B[i]))
    return rings


def tube(bm, pts, radii, segs=10, cap=True):
    """Sweep a circle along points with parallel-transported frames."""
    n = len(pts)
    tangents = []
    for i in range(n):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        tangents.append(t)
    ref = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = tangents[0].cross(ref).normalized()
    rings = []
    for i in range(n):
        if i > 0:
            q = tangents[i - 1].rotation_difference(tangents[i])
            nrm = (q @ nrm).normalized()
        bin_ = tangents[i].cross(nrm).normalized()
        ring = []
        for s in range(segs):
            a = s / segs * math.tau
            ring.append(bm.verts.new(pts[i] + (nrm * math.cos(a) + bin_ * math.sin(a)) * radii[i]))
        rings.append(ring)
    for i in range(n - 1):
        for s in range(segs):
            j = (s + 1) % segs
            bm.faces.new((rings[i][s], rings[i][j], rings[i + 1][j], rings[i + 1][s]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])


def box(bm, size, center, rot=Quaternion()):
    m = Matrix.Translation(center) @ rot.to_matrix().to_4x4() @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def noisy_cutter(origin, normal, size, amp, seed, freq=1.0, res=56):
    """A solid slab whose lower face is a rough, rocky surface; everything above it is cut away."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=res, y_segments=res, size=size / 2)
    for v in bm.verts:
        x, y = v.co.x, v.co.y
        v.co.z = amp * (fbm(x * freq, y * freq, 0, 4, seed) + 0.35 * fbm(x * freq * 4.0, y * freq * 4.0, 1, 2, seed))
    ret = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    for v in [g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)]:
        v.co.z = size
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = obj_from_bm(bm, 'cutter', smooth=False)
    ob.matrix_world = Matrix.Translation(origin) @ look_rot(normal.normalized()).to_matrix().to_4x4()
    return ob


def cut(ob, cutter, overlapping=False):
    """Boolean difference. `overlapping`: the mesh is a soup of intersecting parts (boxes, blobs)."""
    m = ob.modifiers.new('cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cutter
    m.solver = 'EXACT'
    m.use_self = overlapping
    m.use_hole_tolerant = overlapping
    apply_mods(ob)
    bpy.data.objects.remove(cutter)


# ------------------------------------------------------------------ the Corinthian order

def flute(n_flutes, depth, fillet=True):
    """Ionic / Corinthian flutes are separated by flat fillets; Doric flutes meet in sharp arrises."""
    def fn(a, z, r):
        f = (a * n_flutes / math.tau) % 1.0
        if fillet:
            g = math.sin(math.pi * f / 0.8) if f < 0.8 else 0.0
        else:
            g = math.sin(math.pi * f)
        wear = 1 + 0.006 * noise.noise(Vector((math.cos(a) * 3, math.sin(a) * 3, z * 0.8)))
        return r * (1 - depth * g) * wear
    return fn


def shaft(bm, rb, height, full, matrix, drum=1.75, taper=0.86, segs=120, flutes=24, fillet=True, depth=0.045):
    """Fluted Corinthian shaft from z=0 to z=height, with visible drum joints."""
    prof = [(0.0, 0.0)]
    z = 0.0
    def radius(z):
        t = z / full
        return rb * (1 - (1 - taper) * t) + rb * 0.025 * math.sin(math.pi * t)
    joints = [k * drum for k in range(1, int(height / drum) + 1) if k * drum < height - 0.2]
    zs = sorted(set([0.0] + [i * 0.6 for i in range(1, int(height / 0.6) + 1) if i * 0.6 < height] + [height]))
    for zz in zs:
        if any(abs(zz - j) < 0.25 for j in joints):
            continue
        prof.append((radius(zz), zz))
    for j in joints:
        prof += [(radius(j - 0.04), j - 0.04), (radius(j) * 0.975, j), (radius(j + 0.04), j + 0.04)]
    prof = [p for p in prof if p[0] > 0]
    prof.sort(key=lambda p: p[1])
    prof = [(0.0, 0.0)] + prof + [(0.0, height)]
    lathe(bm, prof, segs, flute(flutes, depth, fillet), matrix)
    return radius(height)


def attic_base(bm, rb, matrix):
    """Thick square plinth + torus / scotia / torus; returns its height."""
    m = rb * 0.42 # the plinth, a solid block under the mouldings
    t = rb * 0.42 # the mouldings
    box(bm, (rb * 2.9, rb * 2.9, m), (matrix @ Vector((0, 0, m / 2))))
    prof = [(0, m), (rb * 1.38, m)] + [(rb * r, m + t * k) for r, k in (
        (1.42, 0.15), (1.38, 0.29), (1.2, 0.38), (1.12, 0.53), (1.2, 0.65), (1.26, 0.76), (1.2, 0.9), (1.02, 1.0))] + [(0, m + t)]
    lathe(bm, prof, 64, None, matrix)
    return m + t


def corinthian_capital(bm, rt, matrix, seed=0, broken=0.0):
    """Bell, two rows of acanthus, corner volutes, inner helices and concave abacus. Height ~1.15 * 2rt."""
    rng = random.Random(seed)
    H = rt * 2.25
    bell = lambda z: rt * (1.0 + 0.16 * smoothstep(0.0, H * 0.9, z) ** 1.4)
    lathe(bm, [(0, 0), (rt * 1.0, 0)] + [(bell(H * k / 8), H * k / 8) for k in range(1, 8)] + [(rt * 1.2, H * 0.88), (rt * 1.22, H * 0.9), (0, H * 0.9)], 48, None, matrix)

    def leaf(angle, z0, L, W, curl):
        nt, nu = 14, 8
        grid = []
        for i in range(nt + 1):
            t = i / nt
            row = []
            for j in range(nu + 1):
                u = -1 + 2 * j / nu
                w = W * math.sin(math.pi * min(t, 0.97) ** 0.75) * (1 + 0.2 * math.sin(t * math.pi * 7) * smoothstep(0.1, 0.3, t))
                z = z0 + L * t - L * 0.22 * smoothstep(0.72, 1.0, t) ** 2
                r = bell(min(z, H * 0.88)) + 0.03 * L + curl * L * 0.42 * smoothstep(0.5, 1.0, t) ** 2 + 0.18 * w * u * u
                a = angle + u * w / max(r, 1e-3)
                row.append(bm.verts.new(matrix @ Vector((math.cos(a) * r, math.sin(a) * r, z))))
            grid.append(row)
        faces = []
        for i in range(nt):
            for j in range(nu):
                faces.append(bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j])))
        bmesh.ops.solidify(bm, geom=faces, thickness=0.035 * L)

    for k in range(8):
        a = k / 8 * math.tau + math.pi / 8
        if rng.random() < broken:
            continue
        leaf(a, 0.0, H * 0.4, math.pi * rt * 1.05 / 8 * 1.15, 0.8)
    for k in range(8):
        a = k / 8 * math.tau
        if rng.random() < broken:
            continue
        leaf(a, H * 0.06, H * 0.68, math.pi * rt * 1.1 / 8 * 1.2, 1.0)

    def spiral(center_r, ang, zc, rad, turns, tube_r, inward):
        d = Vector((math.cos(ang), math.sin(ang), 0))
        pts, rads = [], []
        n = 40
        for i in range(n + 1):
            t = i / n
            th = t * turns * math.tau
            rr = rad * (1 - 0.82 * t)
            side = -1 if inward else 1
            p = d * (center_r + side * rr * math.sin(th)) + Vector((0, 0, zc + rr * math.cos(th)))
            pts.append(matrix @ p)
            rads.append(tube_r * (1 - 0.5 * t))
        tube(bm, pts, rads, 8)

    for k in range(4):
        spiral(rt * 1.55, k * math.pi / 2 + math.pi / 4, H * 0.8, H * 0.12, 1.4, H * 0.035, False)
        spiral(rt * 1.18, k * math.pi / 2, H * 0.82, H * 0.07, 1.2, H * 0.025, True)

    # concave abacus
    A, th = rt * 1.5, H * 0.12
    outline = []
    for s in range(4):
        base = s * math.pi / 2
        for i in range(17):
            t = i / 16
            x = -A + 2 * A * t
            y = A - 0.14 * A * math.sin(math.pi * t)
            if i in (0, 16):
                x *= 0.93
            ca, sa = math.cos(base), math.sin(base)
            outline.append(Vector((x * ca - y * sa, x * sa + y * ca, H * 0.88)))
    ring = [bm.verts.new(matrix @ p) for p in outline]
    f = bm.faces.new(ring)
    ret = bmesh.ops.extrude_face_region(bm, geom=[f])
    up = (matrix.to_3x3() @ Vector((0, 0, th)))
    bmesh.ops.translate(bm, verts=[g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)], vec=up)
    bmesh.ops.reverse_faces(bm, faces=[f])
    for k in range(4):
        a = k * math.pi / 2
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=H * 0.06,
                                  matrix=matrix @ Matrix.Translation(Vector((math.cos(a) * A * 0.9, math.sin(a) * A * 0.9, H * 0.93))))
    return H * 0.88 + th


def entablature(bm, x0, x1, y, z, D, depth, seed=0):
    """Architrave of three fasciae, plain frieze, dentils and an overhanging cornice. Laid in blocks per bay."""
    rng = random.Random(seed)
    E = D * 2.2
    aH, fH, cH = E * 0.38, E * 0.32, E * 0.3
    L = x1 - x0
    nb = max(1, round(L / (D * 2.5)))
    for b in range(nb):
        bx0 = x0 + L * b / nb + 0.02
        bx1 = x0 + L * (b + 1) / nb - 0.02
        cx, w = (bx0 + bx1) / 2, bx1 - bx0
        for k, s in enumerate((0.94, 0.97, 1.0)):
            box(bm, (w, depth * s, aH / 3), Vector((cx, y, z + aH / 6 + k * aH / 3)))
        box(bm, (w, depth * 0.96, fH), Vector((cx, y, z + aH + fH / 2)))
    zc = z + aH + fH
    box(bm, (L, depth * 1.02, cH * 0.15), Vector(((x0 + x1) / 2, y, zc + cH * 0.075)))
    n = int(L / (D * 0.22))
    for i in range(n):
        x = x0 + (i + 0.5) * L / n
        for side in (-1, 1):
            box(bm, (L / n * 0.55, D * 0.16, cH * 0.22), Vector((x, y + side * (depth * 0.51 + D * 0.06), zc + cH * 0.26)))
    box(bm, (L + D * 0.6, depth + D * 0.7, cH * 0.4), Vector(((x0 + x1) / 2, y, zc + cH * 0.57)))
    box(bm, (L + D * 0.4, depth + D * 0.5, cH * 0.25), Vector(((x0 + x1) / 2, y, zc + cH * 0.88)))
    return zc + cH


# ------------------------------------------------------------------ colossal temple

def build_temple():
    reset()
    rng = random.Random(7)
    D, H_SHAFT = 2.6, 23.5
    rb = D / 2
    SP = 6.6
    xs = [-SP * 3 + SP * i for i in range(7)]
    ROWS = {'front': -9.0, 'back': 9.0}
    # krepidoma at the scale of the columns: three courses of great blocks, each step 0.85 m (one can still
    # clamber up), the paving laid on the column grid, and every column on its own bedding block
    STEP_H, STEPS, TREAD = 0.85, 3, 1.8
    TOP = SEABED + STEP_H * STEPS  # stylobate top
    SX, SY = SP / 2, 3.0           # paving slabs: two per bay along the rows, columns on slab centres
    hw, hd = xs[-1] + SX * 1.5, 13.5
    meta = {'colliders': [], 'floors': [], 'gaze': []}

    blocks = bmesh.new()
    for s in range(STEPS):
        grow = (STEPS - 1 - s) * TREAD
        zc = SEABED + STEP_H * (s + 0.5)
        W, Dd = hw + grow, hd + grow
        ring = TREAD + 0.6
        for side in range(4):
            length = 2 * (W if side < 2 else Dd)
            for a0, bl in course_run(length, 3.6, 5.2, rng):
                if rng.random() < 0.05 + 0.1 * (s == STEPS - 1):
                    continue
                along = -length / 2 + a0 + bl / 2
                if side == 0: c, sz = Vector((along, -Dd + ring / 2, zc)), (bl - 0.003, ring, STEP_H - 0.003)
                elif side == 1: c, sz = Vector((along, Dd - ring / 2, zc)), (bl - 0.003, ring, STEP_H - 0.003)
                elif side == 2: c, sz = Vector((-W + ring / 2, along, zc)), (ring, bl - 0.003, STEP_H - 0.003)
                else: c, sz = Vector((W - ring / 2, along, zc)), (ring, bl - 0.003, STEP_H - 0.003)
                c += Vector((rng.uniform(-0.006, 0.006), rng.uniform(-0.006, 0.006), 0))
                box(blocks, sz, c, Quaternion((0, 0, 1), rng.uniform(-0.002, 0.002)))
    # paving: under the colonnades, with gaps where water shows through in the middle
    nxs, nys = int(round(2 * hw / SX)), int(round(2 * hd / SY))
    for i in range(nxs):
        for j in range(nys):
            x, y = -hw + (i + 0.5) * SX, -hd + (j + 0.5) * SY
            mid = abs(y) < 5.5 and abs(x) < hw - 6
            if (mid and rng.random() < 0.55) or rng.random() < 0.06:
                continue
            tilt = Quaternion(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized(), rng.uniform(0, 0.003))
            box(blocks, (SX - 0.003, SY - 0.003, STEP_H), Vector((x, y, TOP - STEP_H / 2 - rng.uniform(0, 0.01))), tilt)
    BED = 0.14  # each column's bedding block stands a little proud of the paving
    for row in ROWS.values():
        for x in xs:
            box(blocks, (D * 1.7, D * 1.7, STEP_H + BED), Vector((x, row, TOP + BED - (STEP_H + BED) / 2)),
                Quaternion((0, 0, 1), rng.uniform(-0.003, 0.003)))
    blk = obj_from_bm(blocks, 'blocks', smooth=False)
    bev = blk.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments, bev.limit_method = 0.04, 2, 'ANGLE'
    apply_mods(blk)
    densify(blk, 1)
    parts = [blk]
    meta['floors'].append({'hw': hw - 0.4, 'hl': hd - 0.4, 'top': TOP})

    # --- columns: (row, index, state)
    plan = {
        ('front', 1): 'intact', ('front', 2): 'intact', ('front', 3): 'intact', ('front', 4): 'intact',
        ('front', 0): 0.12, ('front', 5): 0.62, ('front', 6): 0.04,
        ('back', 0): 0.05, ('back', 1): 'intact', ('back', 2): 0.3, ('back', 3): 0.48, ('back', 4): 0.08,
        ('back', 5): 'fallen', ('back', 6): 'intact',
    }
    tops = {}
    for (row, i), state in plan.items():
        x, y = xs[i], ROWS[row]
        base = bmesh.new()
        bh = BED + attic_base(base, rb, Matrix.Translation(Vector((x, y, TOP + BED))))
        parts.append(obj_from_bm(base, f'base_{row}{i}'))  # kept apart: a boolean cut on the shaft must not touch it
        bm = bmesh.new()
        M2 = Matrix.Translation(Vector((x, y, TOP + bh))) @ Matrix.Rotation(rng.uniform(0, 0.26), 4, 'Z')
        meta['colliders'].append({'x': x, 'z': -y, 'r': rb * 1.45})
        if state == 'intact':
            rt = shaft(bm, rb, H_SHAFT, H_SHAFT, M2)
            ztop = TOP + bh + H_SHAFT
            tops[(row, i)] = ztop + corinthian_capital(bm, rt, Matrix.Translation(Vector((x, y, ztop))) @ Matrix.Rotation(rng.uniform(-0.03, 0.03), 4, 'Z'), seed=i * 7 + (row == 'back'), broken=0.15)
            parts.append(obj_from_bm(bm, f'col_{row}{i}'))
        elif state == 'fallen':
            shaft(bm, rb, 1.2, H_SHAFT, M2)
            ob = obj_from_bm(bm, f'col_{row}{i}')
            cut(ob, noisy_cutter(Vector((x, y, TOP + bh + 0.9)), Vector((0.2, 0.1, 1)), 6, 0.35, i))
            parts.append(ob)
        else:
            h = H_SHAFT * state + 1.0
            shaft(bm, rb, h, H_SHAFT, M2)
            ob = obj_from_bm(bm, f'col_{row}{i}')
            n = Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 1))
            cut(ob, noisy_cutter(Vector((x, y, TOP + bh + h - 0.7)), n, 7, 0.55, i * 3.1 + 1, freq=0.9))
            parts.append(ob)

    # --- the standing group carries its entablature
    ent = bmesh.new()
    zt = tops[('front', 1)]
    entablature(ent, xs[1] - rb * 1.4, xs[4] + rb * 1.4, ROWS['front'], zt, D, D * 1.35, seed=3)
    ob = obj_from_bm(ent, 'entablature', smooth=False)
    cut(ob, noisy_cutter(Vector((xs[4] + rb * 1.1, ROWS['front'], zt + 3)), Vector((1, 0, 0.35)), 12, 0.6, 9, freq=0.5), overlapping=True)
    parts.append(ob)
    meta['gaze'].append({'x': (xs[1] + xs[4]) / 2, 'z': -ROWS['front'], 'y': zt - 6, 'r': 46})

    # --- the fallen column: drums tumbled like dominoes out into the water
    fx, fy = xs[5], ROWS['back']
    d = Vector((0.55, 1.0, 0)).normalized()
    side = Vector((-d.y, d.x, 0))
    s = 2.4
    for k in range(13):
        bm = bmesh.new()
        r = rb * (1 - 0.13 * k / 13)
        L = 1.72
        shaft(bm, r, L, L, Matrix.Translation(Vector((0, 0, -L / 2))), drum=99, taper=0.995)
        ob = obj_from_bm(bm, f'drum{k}')
        tilt = rng.uniform(0.03, 0.12)
        yaw = rng.uniform(-0.12, 0.12)
        rot = Quaternion((0, 0, 1), yaw) @ Quaternion(side, -tilt) @ d.to_track_quat('Z', 'Y')
        s += L / 2 + r * math.sin(tilt)
        c = Vector((fx, fy, 0)) + d * s + side * (math.sin(k * 0.9) * 0.5)
        ground = TOP if (abs(c.x) < hw - 1 and abs(c.y) < hd - 1) else SEABED
        c.z = ground + r * 0.92
        ob.matrix_world = Matrix.Translation(c) @ rot.to_matrix().to_4x4() @ Matrix.Rotation(rng.uniform(0, 6), 4, 'Z')
        parts.append(ob)
        meta['colliders'].append({'x': c.x, 'z': -c.y, 'r': r * 1.1})
        s += L / 2 + r * math.sin(tilt) + rng.uniform(0.15, 0.6)
    cap = bmesh.new()
    corinthian_capital(cap, rb * 0.86, Matrix(), seed=99, broken=0.35)
    ob = obj_from_bm(cap, 'fallen_capital')
    end = Vector((fx, fy, 0)) + d * (s + 1.6)
    ob.matrix_world = (Matrix.Translation(Vector((end.x, end.y, SEABED + rb * 0.9))) @ Matrix.Rotation(math.pi / 2 + 0.25, 4, side)
                       @ Matrix.Translation(Vector((0, 0, -rb * 1.1))))
    parts.append(ob)
    meta['colliders'].append({'x': end.x, 'z': -end.y, 'r': 2.6})

    # --- a slipped architrave block and scattered stones
    bm = bmesh.new()
    box(bm, (6.0, 2.2, 1.9), Vector((xs[6] + 1.5, -hd - 3.2, SEABED + 0.7)), Quaternion((0.2, 0.1, 1), 0.5))
    for k in range(18):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(hd + 2, hd + 10)
        c = Vector((math.cos(a) * rr * 1.6, math.sin(a) * rr, SEABED + 0.25))
        q = Quaternion(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized(), rng.uniform(0, 0.6))
        box(bm, (rng.uniform(1.2, 2.6), rng.uniform(0.8, 1.4), rng.uniform(0.5, 0.9)), c, q)
    ob = obj_from_bm(bm, 'stones', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.12, 2
    apply_mods(ob)
    parts.append(ob)

    temple = join(parts, 'ColossalTemple')
    weather(temple, 0.7, 0.03)
    finish_asset([temple], 'colossal_temple', meta)


# ------------------------------------------------------------------ surface helpers, and the giant column base

def densify(ob, levels):
    """Simple subdivision so baked vertex AO has enough samples on big flat faces."""
    m = ob.modifiers.new('dense', 'SUBSURF')
    m.subdivision_type, m.levels, m.render_levels = 'SIMPLE', levels, levels
    apply_mods(ob)


def weather(ob, scale, strength):
    tex = bpy.data.textures.new('wear', 'CLOUDS')
    tex.noise_scale, tex.noise_depth = scale, 3
    m = ob.modifiers.new('wear', 'DISPLACE')
    m.texture, m.strength, m.mid_level, m.texture_coords = tex, strength, 0.5, 'GLOBAL'
    apply_mods(ob)


def build_statues():
    reset()
    meta = {}

    base = giant_column_base(meta)
    meta['GiantBase']['gaze'] = [{'x': 0, 'z': 0, 'y': 4.5, 'r': 30}]

    finish_asset([base], 'colossal_statues', meta)


# ------------------------------------------------------------------ AO bake, export, preview

def bake_ao(objs):
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = 64
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scn.cycles.device = 'GPU'
    except Exception:
        scn.cycles.device = 'CPU'
    world = bpy.data.worlds.new('w')
    scn.world = world
    world.light_settings.distance = 6.0
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=300, matrix=Matrix.Translation(Vector((0, 0, SEABED))))
    ground = obj_from_bm(bm, 'ao_ground', smooth=False)
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    for ob in objs:
        ob.data.materials.append(mat)
        attr = ob.data.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
        ob.data.color_attributes.active_color = attr
        ob.data.attributes.default_color_name = 'AO'
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
        data = attr.data
        raw = [c.color[0] for c in data]
        print(f'[colossi] AO {ob.name}: min {min(raw):.2f} mean {sum(raw) / len(raw):.2f}')
        tone = block_tones(ob.data)
        # a vertex is on a worn arris when every face around it is an arris strip
        arris_face = ob.data.attributes['arris'].data
        on_arris = [True] * len(ob.data.vertices)
        touched = [False] * len(ob.data.vertices)
        for poly in ob.data.polygons:
            flag = arris_face[poly.index].value == 1
            for vi in poly.vertices:
                touched[vi] = True
                on_arris[vi] = on_arris[vi] and flag
        for i, (c, v) in enumerate(zip(data, ob.data.vertices)):
            ao = raw[i]
            p = v.co
            streak = max(0.0, noise.noise(Vector((p.x * 1.3, p.y * 1.3, p.z * 0.12))))
            low = 1 - smoothstep(0.0, 3.5, p.z - SEABED)
            grime = min(1.0, 0.55 * (1 - ao) + 0.5 * streak + 0.3 * low)
            # R: ambient occlusion (softened, never black)  G: grime and rain streaks  B: tone of this block
            # A: 1 on the bevelled arrises along block edges
            c.color = (0.32 + 0.68 * ao, grime, tone[i], 1.0 if on_arris[i] and touched[i] else 0.0)
    bpy.data.objects.remove(ground)


def block_tones(me):
    """One random tone per connected piece (each block, drum or capital), so stones differ slightly."""
    n = len(me.vertices)
    parent = list(range(n))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[a] = b
    for e in me.edges:
        union(e.vertices[0], e.vertices[1])
    seen = {}
    for v in me.vertices:  # edge-split copies of a vertex share its position: same piece
        key = (round(v.co.x, 4), round(v.co.y, 4), round(v.co.z, 4))
        if key in seen:
            union(v.index, seen[key])
        else:
            seen[key] = v.index
    roots = [find(i) for i in range(n)]
    return [((r * 2654435761) % 1000003) / 1000003 for r in roots]


def mark_arrises(bm, layer, width=0.22, angle=20):
    """Flag the bevel strips along block edges: narrow faces lying between two convex, sharp edges. These
    are the arrises that chip and wear first; the browser roughens and brightens them."""
    bm.faces.ensure_lookup_table()
    cos_sharp = math.cos(math.radians(angle))
    n = 0
    for f in bm.faces:
        longest = max(e.calc_length() for e in f.edges)
        if longest < 1e-6 or f.calc_area() / longest > width:
            continue
        c = f.calc_center_median()
        sharp = 0
        for e in f.edges:
            for g in e.link_faces:
                if g is f or f.normal.dot(g.normal) > cos_sharp:
                    continue
                if (g.calc_center_median() - c).dot(f.normal) < 0:  # the neighbour falls away: a convex edge
                    sharp += 1
        if sharp >= 2:
            f[layer] = 1
            n += 1
    return n


def lod_copy(ob, info, ratio=0.25):
    """A simplified copy (about a quarter of the triangles, baked colours kept) for when the ruin is far
    off, and for its reflection: welded so decimation cannot open the split edges, then split again so
    block edges stay crisp."""
    lod = ob.copy()
    lod.data = ob.data.copy()
    lod.name = lod.data.name = ob.name + '_lod'
    bpy.context.scene.collection.objects.link(lod)
    bm = bmesh.new()
    bm.from_mesh(lod.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
    bm.to_mesh(lod.data)
    bm.free()
    m = lod.modifiers.new('dec', 'DECIMATE')
    m.ratio = ratio
    apply_mods(lod)
    for p in lod.data.polygons:
        p.use_smooth = True
    m = lod.modifiers.new('split', 'EDGE_SPLIT')
    m.split_angle, m.use_edge_sharp = math.radians(30), False
    apply_mods(lod)
    info['lod'] = lod.name
    print(f'[colossi] {lod.name}: {sum(len(p.vertices) - 2 for p in lod.data.polygons)} triangles')
    return lod


def finish_asset(objs, name, meta, views=None):
    os.makedirs(OUT, exist_ok=True)
    for ob in objs:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
        bm.normal_update()
        layer = bm.faces.layers.int.new('arris')
        n = mark_arrises(bm, layer)
        print(f'[colossi] {ob.name}: {n} arris faces of {len(bm.faces)}')
        bm.to_mesh(ob.data)
        bm.free()
    for ob in objs:
        # smooth shading, then split normals where faces meet at > 30 deg: block edges and flute arrises stay
        # crisp up close, while the weathered faces (their vertices nudged a little) shade evenly instead of
        # breaking into flat facets under the low moon
        for p in ob.data.polygons:
            p.use_smooth = True
        m = ob.modifiers.new('split', 'EDGE_SPLIT')
        m.split_angle, m.use_edge_sharp = math.radians(30), False
        apply_mods(ob)
    bake_ao(objs)
    if len(objs) == 1 and objs[0].name not in meta:
        meta = {objs[0].name: meta}
    for ob in objs:
        info = meta.setdefault(ob.name, {})
        info.pop('colliders', None)
        info.pop('floors', None)
        if not info.get('gaze'):  # the stroll looks up toward the upper part of every ruin
            co = [v.co for v in ob.data.vertices]
            x0, x1 = min(c.x for c in co), max(c.x for c in co)
            y0, y1 = min(c.y for c in co), max(c.y for c in co)
            top = max(c.z for c in co)
            info['gaze'] = [{'x': (x0 + x1) / 2, 'z': -(y0 + y1) / 2, 'y': top * 0.7,
                             'r': max(30.0, 1.3 * max(x1 - x0, y1 - y0))}]
        info['walk'] = walk_grid(ob, name)
    tris = {ob.name: sum(len(p.vertices) - 2 for p in ob.data.polygons) for ob in objs}
    print(f'[colossi] {name}: triangles {tris}')
    lods = [lod_copy(ob, meta[ob.name]) for ob in objs]
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs + lods:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, name + '.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_materials='NONE', export_vertex_color='ACTIVE',
        export_active_vertex_color_when_no_material=True, export_normals=True,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
    )
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    if PREVIEW:
        render_previews(objs, name, views)


def bridge_joints(data, nx, nz, layers, span=2, rise=30, level=10, headroom=170):
    """Where a joint between blocks (or where two joints cross) is so wide that every ray falls into it, the
    cell reads as a pit one can't climb out of. A gap at most `span` cells wide with level stone either side
    is something you'd step over, so give such cells that stone's height as a layer to stand on."""
    L = 2 * layers + 1
    src = data[:]
    def top(i, j):
        o = (j * nx + i) * L
        best = None
        for k in range(layers):
            h = src[o + k]
            if h == -32768:
                break
            if src[o + layers + k] >= headroom and (best is None or h > best[0]):
                best = (h, src[o + layers + k])
        return best
    for j in range(nz):
        for i in range(nx):
            here = top(i, j)
            if here is None:
                continue
            o = (j * nx + i) * L
            found = None
            for di, dj in ((1, 0), (0, 1), (1, 1), (1, -1)):
                sides = []
                for sgn in (1, -1):
                    for k in range(1, span + 1):
                        ii, jj = i + sgn * k * di, j + sgn * k * dj
                        if not (0 <= ii < nx and 0 <= jj < nz):
                            break
                        t = top(ii, jj)
                        if t is not None and t[0] > here[0] + rise:
                            sides.append(t)
                            break
                if len(sides) == 2 and abs(sides[0][0] - sides[1][0]) <= level:
                    h = max(sides[0][0], sides[1][0])
                    if found is None or h > found[0]:
                        found = (h, min(sides[0][1], sides[1][1]))
            if found is None:
                continue
            n = sum(1 for k in range(layers) if data[o + k] != -32768)
            if n >= layers:
                continue
            # don't bridge into a ceiling: the layer under it must have room above the new floor
            below = max((k for k in range(n) if data[o + k] < found[0]), default=None, key=lambda k: data[o + k])
            if below is not None and data[o + below] + data[o + layers + below] < found[0] + headroom:
                continue
            entries = sorted([(data[o + k], data[o + layers + k]) for k in range(n)] + [found])
            for k in range(layers):
                data[o + k], data[o + layers + k] = entries[k] if k < len(entries) else (-32768, 0)


def walk_grid(ob, name, res=0.3, layers=4):
    """Cast rays straight down over a grid and record, per cell, every surface one could stand on
    (an upward face with open space above) and how much headroom it has, plus the lowest solid point.
    Stored as int16 centimetres in three.js local axes: x, z = -Blender y."""
    from mathutils.bvhtree import BVHTree
    from array import array
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(ob, dg)
    xs = [v.co.x for v in ob.data.vertices]
    ys = [v.co.y for v in ob.data.vertices]
    ztop = max(v.co.z for v in ob.data.vertices) + 1.0
    x0, x1, y0, y1 = min(xs) - 0.5, max(xs) + 0.5, min(ys) - 0.5, max(ys) + 0.5
    nx, nz = int(math.ceil((x1 - x0) / res)), int(math.ceil((y1 - y0) / res))
    down = Vector((0, 0, -1))
    NONE, FREE = -32768, 32767
    data = array('h')
    def probe(bx, by):
        """Surfaces to stand on (height, headroom) along one vertical ray, and the lowest solid point."""
        hits, z = [], ztop
        while len(hits) < 400:
            loc, nrm, _, _ = bvh.ray_cast(Vector((bx, by, z)), down)
            if loc is None:
                break
            hits.append((loc.z, nrm.z))
            z = loc.z - 0.004
        stand = []
        for k, (hz, nzv) in enumerate(hits):
            if nzv < 0.35:   # steeper than ~70 degrees: not somewhere to stand (bevels on block edges still count)
                continue
            if k == 0:
                clear = 300.0
            elif hits[k - 1][1] < 0:
                clear = hits[k - 1][0] - hz
            else:
                continue  # inside a solid
            if clear >= 1.0:
                stand.append((hz, min(clear, 300.0)))
        return stand, (hits[-1][0] if hits else None)

    # five rays spread over each cell, so a joint between paving slabs (wide on the scaled-up temples) or a
    # bevel can't hide the floor
    q = 0.4 * res
    offsets = ((0.0, 0.0), (q, 0.6 * q), (-q, -0.6 * q), (0.6 * q, -q), (-0.6 * q, q))
    for j in range(nz):
        by = y1 - (j + 0.5) * res
        for i in range(nx):
            bx = x0 + (i + 0.5) * res
            stands, bottoms = [], []
            for ox, oy in offsets:
                st, b = probe(bx + ox, by + oy)
                stands += st
                bottoms.append(b)
            merged = []
            for h, c in sorted(stands):
                if merged and h - merged[-1][0] < 0.08:
                    merged[-1] = (max(h, merged[-1][0]), max(c, merged[-1][1]))
                else:
                    merged.append((h, c))
            merged = merged[:layers]
            tops = [int(round(h * 100)) for h, _ in merged] + [NONE] * (layers - len(merged))
            clears = [int(round(c * 100)) for _, c in merged] + [0] * (layers - len(merged))
            solid = [b for b in bottoms if b is not None]
            bottom = int(round(min(solid) * 100)) if solid else FREE
            data.extend(tops + clears + [bottom])
    bridge_joints(data, nx, nz, layers)
    fname = f'{name}.{ob.name}.walk.bin'
    with open(os.path.join(OUT, fname), 'wb') as f:
        data.tofile(f)
    print(f'[colossi] walk grid {fname}: {nx} x {nz}')
    return {'file': fname, 'x0': x0, 'z0': -y1, 'res': res, 'nx': nx, 'nz': nz, 'layers': layers}


def render_previews(objs, name, views=None):
    scn = bpy.context.scene
    try:
        scn.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        scn.render.engine = 'BLENDER_WORKBENCH'
    scn.render.resolution_x, scn.render.resolution_y = 1200, 760
    world = scn.world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.02, 0.05, 0.16, 1)
    bg.inputs[1].default_value = 1.0
    sun = bpy.data.lights.new('moon', 'SUN')
    sun.energy, sun.color = 3.5, (0.82, 0.88, 1.0)
    so = link(bpy.data.objects.new('moon', sun))
    so.rotation_euler = MOON.to_track_quat('Z', 'Y').to_euler()
    mat = bpy.data.materials.new('marble')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'AO'
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type, mix.blend_type = 'RGBA', 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs[6].default_value = (0.86, 0.85, 0.82, 1)
    nt.links.new(attr.outputs['Color'], mix.inputs[7])
    nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.7
    for ob in objs:
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    wbm = bmesh.new()
    bmesh.ops.create_grid(wbm, x_segments=1, y_segments=1, size=400)
    water = obj_from_bm(wbm, 'water', smooth=False)
    wm = bpy.data.materials.new('water')
    wm.use_nodes = True
    wb = wm.node_tree.nodes['Principled BSDF']
    wb.inputs['Base Color'].default_value = (0.01, 0.02, 0.05, 1)
    wb.inputs['Roughness'].default_value = 0.04
    water.data.materials.append(wm)
    cam = bpy.data.cameras.new('cam')
    cam.lens = 22
    co = link(bpy.data.objects.new('cam', cam))
    scn.camera = co
    views = views or {
        'colossal_temple': [((0, -32, 1.6), (0, 0, 14)), ((-30, -28, 1.6), (0, 0, 10)), ((10, -95, 4), (0, 0, 13), 40),
                            ((-14, -34, 2), (-6.6, -9, 27), 55), ((40, 40, 3), (19.8, 18, 0), 30)],
        'colossal_statues': [],
    }.get(name, [])
    if name == 'colossal_statues':
        objs[1].location.x += 26
        objs[2].location.x -= 26
        views = [((0, -22, 1.6), (0, 0, 2), 28), ((26, -14, 1.6), (26, 0, 4.5)), ((-26, -16, 1.6), (-26, 0, 3)), ((-8, -12, 1.8), (0, 0, 1.5), 30)]
    for i, v in enumerate(views):
        loc, tgt = v[0], v[1]
        cam.lens = v[2] if len(v) > 2 else 22
        co.location = Vector(loc)
        co.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(PREVIEW, f'{name}_{i}.png')
        bpy.ops.render.render(write_still=True)


# ------------------------------------------------------------------ Doric and Ionic orders, walls, platforms

ORDERS = {
    'doric': dict(flutes=20, fillet=False, depth=0.05, taper=0.78, drum=1.05, segs=120, cap=0.42),
    'ionic': dict(flutes=24, fillet=True, depth=0.045, taper=0.86, drum=1.2, segs=120, cap=0.36),
}


def doric_capital(bm, rt, D, M):
    """Necking rings, echinus and square abacus. Height 0.42 D."""
    lathe(bm, [(0, 0), (rt * 0.98, 0), (rt * 1.0, 0.04 * D), (rt * 0.96, 0.06 * D), (rt * 1.0, 0.08 * D),
               (rt * 1.16, 0.15 * D), (rt * 1.32, 0.23 * D), (rt * 1.42, 0.28 * D), (rt * 1.43, 0.29 * D), (0, 0.29 * D)], 64, None, M)
    box(bm, (rt * 2.9, rt * 2.9, 0.13 * D), M @ Vector((0, 0, 0.355 * D)), M.to_quaternion())
    return 0.42 * D


def ionic_capital(bm, rt, D, M):
    """Echinus, bolsters with spiral volutes on the local ±Y faces, thin abacus. Height 0.36 D."""
    q = M.to_quaternion()
    lathe(bm, [(0, 0), (rt * 0.98, 0), (rt * 1.12, 0.06 * D), (rt * 1.18, 0.12 * D), (0, 0.12 * D)], 48, None, M)
    box(bm, (1.45 * D, 0.86 * D, 0.13 * D), M @ Vector((0, 0, 0.19 * D)), q)
    for sx in (-1, 1):
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.2 * D, radius2=0.2 * D, depth=0.86 * D,
                              matrix=M @ Matrix.Translation(Vector((sx * 0.6 * D, 0, 0.12 * D))) @ Matrix.Rotation(math.pi / 2, 4, 'X'))
        for sy in (-1, 1):
            pts, rads = [], []
            for i in range(61):
                t = i / 60
                th = t * 2.6 * math.tau
                r = 0.2 * D * (1 - 0.85 * t)
                pts.append(M @ Vector((sx * 0.6 * D + sx * math.sin(th) * r, sy * 0.445 * D, 0.12 * D + math.cos(th) * r)))
                rads.append(0.032 * D * (1 - 0.5 * t))
            tube(bm, pts, rads, 8)
            bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.045 * D,
                                      matrix=M @ Matrix.Translation(Vector((sx * 0.6 * D, sy * 0.445 * D, 0.12 * D))))
    box(bm, (1.0 * D, 1.0 * D, 0.07 * D), M @ Vector((0, 0, 0.325 * D)), q)
    return 0.36 * D


def column(parts, meta, x, y, z0, order, D, H, state, seed, ry=0.0):
    """A Doric or Ionic column standing at (x, y, z0), total height H when intact.
    state: 'intact', 'stump', 'none' (base only) or a float = fraction of the shaft left standing.
    Returns the top (where the entablature sits) for an intact column, else None."""
    rng = random.Random(seed)
    sp = ORDERS[order]
    rb = D / 2
    z = z0
    if order != 'doric':
        base = bmesh.new()
        z += attic_base(base, rb, Matrix.Translation(Vector((x, y, z))))
        parts.append(obj_from_bm(base, 'base'))  # kept apart: a boolean cut on the shaft must not touch it
    meta['colliders'].append({'x': x, 'z': -y, 'r': rb * 1.3})
    if state == 'none':
        return None
    bm = bmesh.new()
    full = H - (z - z0) - sp['cap'] * D
    M = Matrix.Translation(Vector((x, y, z))) @ Matrix.Rotation(rng.uniform(0, 0.3), 4, 'Z')
    kw = dict(drum=sp['drum'] * D, taper=sp['taper'], flutes=sp['flutes'], fillet=sp['fillet'], depth=sp['depth'], segs=sp['segs'])
    if state == 'intact':
        rt = shaft(bm, rb, full, full, M, **kw)
        cm = Matrix.Translation(Vector((x, y, z + full))) @ Matrix.Rotation(ry, 4, 'Z')
        top = z + full + (doric_capital if order == 'doric' else ionic_capital)(bm, rt, D, cm)
        parts.append(obj_from_bm(bm, 'col'))
        return top
    frac = rng.uniform(0.04, 0.12) if state == 'stump' else float(state)
    h = max(D * 0.5, full * frac)
    shaft(bm, rb, h + D * 0.4, full, M, **kw)
    ob = obj_from_bm(bm, 'col')
    n = Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), 1))
    cut(ob, noisy_cutter(Vector((x, y, z + h)), n, D * 3.2, D * 0.22, seed * 1.7 + 3, freq=2.0 / D))
    parts.append(ob)
    return None


def fallen_drum(parts, meta, x, y, z, D, order, yaw, seed, length=None):
    sp = ORDERS[order]
    r = D / 2 * (0.82 + 0.1 * random.Random(seed).random())
    L = length or D * 1.1
    bm = bmesh.new()
    shaft(bm, r, L, L, Matrix.Translation(Vector((0, 0, -L / 2))), drum=99, taper=0.995,
          flutes=sp['flutes'], fillet=sp['fillet'], depth=sp['depth'], segs=sp['segs'])
    ob = obj_from_bm(bm, 'drum')
    ob.matrix_world = Matrix.Translation(Vector((x, y, z + r * 0.85))) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
    parts.append(ob)
    meta['colliders'].append({'x': x, 'z': -y, 'r': max(r, L / 2)})


def place(ob, center, angle=0.0):
    ob.matrix_world = Matrix.Translation(Vector(center)) @ Matrix.Rotation(angle, 4, 'Z')
    return ob


def scale_about(ob, k, z0=0.0):
    """Enlarge a finished ruin by k, keeping the level z0 (water line or base) where it was."""
    ob.data.transform(Matrix.Translation(Vector((0, 0, z0))) @ Matrix.Diagonal((k, k, k, 1)) @ Matrix.Translation(Vector((0, 0, -z0))))


def runs(indices):
    out, cur = [], []
    for i in sorted(indices):
        if cur and i != cur[-1] + 1:
            out.append(cur)
            cur = []
        cur.append(i)
    if cur:
        out.append(cur)
    return [r for r in out if len(r) >= 2]


def doric_entablature_obj(L, D, depth, bay, ext=None):
    """Architrave in blocks, triglyph frieze, overhanging cornice; along local X, base z=0."""
    ext = 0.62 * D if ext is None else ext
    aH, fH, cH = 0.62 * D, 0.62 * D, 0.3 * D
    TL = L + 2 * ext
    bm = bmesh.new()
    nb = max(1, round(L / bay))
    for k in range(nb):
        a = -TL / 2 + TL * k / nb
        box(bm, (TL / nb - 0.03, depth, aH), Vector((a + TL / nb / 2, 0, aH / 2)))
    box(bm, (TL, depth * 1.03, 0.07 * D), Vector((0, 0, aH)))
    box(bm, (TL - 0.05, depth * 0.92, fH), Vector((0, 0, aH + fH / 2)))
    n = max(1, round(L / (bay / 2)))
    for k in range(n + 1):
        x = -L / 2 + k * L / n
        for t in (-1, 0, 1):
            box(bm, (0.11 * D, depth * 0.92 + 0.14, fH * 0.97), Vector((x + t * 0.15 * D, 0, aH + fH / 2)))
        box(bm, (0.5 * D, depth * 0.92 + 0.16, 0.08 * D), Vector((x, 0, aH + fH - 0.04 * D)))
    box(bm, (TL + 0.7 * D, depth + 0.8 * D, cH * 0.55), Vector((0, 0, aH + fH + cH * 0.275)))
    box(bm, (TL + 0.55 * D, depth + 0.62 * D, cH * 0.45), Vector((0, 0, aH + fH + cH * 0.775)))
    return obj_from_bm(bm, 'doric_ent', smooth=False), aH + fH + cH


def ionic_entablature_obj(L, D, depth):
    bm = bmesh.new()
    top = entablature(bm, -L / 2 - 0.7 * D, L / 2 + 0.7 * D, 0, 0, D, depth)
    return obj_from_bm(bm, 'ionic_ent', smooth=False), top


def pediment_obj(L, depth, D):
    """Tympanum and raking cornices over an entablature of length L (along X), base z=0."""
    h = L / 2 * 0.24
    bm = bmesh.new()
    tri = [bm.verts.new(Vector(p)) for p in ((-L / 2, -depth * 0.42, 0), (L / 2, -depth * 0.42, 0), (0, -depth * 0.42, h))]
    f = bm.faces.new(tri)
    ret = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, verts=[g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)], vec=Vector((0, depth * 0.84, 0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ang = math.atan2(h, L / 2)
    rl = math.hypot(L / 2, h) + 0.6 * D
    for sx in (-1, 1):
        box(bm, (rl, depth + 0.7 * D, 0.32 * D), Vector((sx * L / 4, 0, h / 2 + 0.12 * D)), Quaternion((0, 1, 0), sx * ang))
    return obj_from_bm(bm, 'pediment', smooth=False), h


def ashlar_wall(L, thick, height_at, rng, course=0.8, blen=2.2, openings=()):
    """Wall of courses along local X from 0 to L, centred on y = 0, base z = 0, built as the Greeks did:
    a projecting base course (running on under doorways as their sill), a tall first course of upright
    slabs, then courses laid with hairline joints; only the stones near the ruined top have shifted.
    height_at(s) is the ruined top; openings are (s0, s1, top) doorways with lintels above."""
    bm = bmesh.new()
    hmax = max(height_at(L * i / 40) for i in range(41))
    hb = min(0.35, course * 0.3)
    for a0, bl in course_run(L + 0.3, blen * 1.1, blen * 1.6, rng):
        box(bm, (bl, thick + 0.3, hb), Vector((-0.15 + a0 + bl / 2, 0, hb / 2)))
    z0, c = hb, 0
    while z0 < hmax + course:
        ch = course * 1.5 if c == 0 else course
        s = -rng.uniform(0.3, 0.7) * blen
        while s < L:
            bl = blen * rng.uniform(0.8, 1.3) * (1.3 if c == 0 else 1.0)
            a, b = max(0.0, s), min(L, s + bl)
            s += bl
            pieces = [(a, b)]
            for s0, s1, top in openings:
                if z0 < top:
                    nxt = []
                    for pa, pb in pieces:
                        if pb <= s0 or pa >= s1:
                            nxt.append((pa, pb))
                        else:
                            if pa < s0: nxt.append((pa, s0))
                            if pb > s1: nxt.append((s1, pb))
                    pieces = nxt
            for pa, pb in pieces:
                if pb - pa < 0.35:
                    continue
                mid = (pa + pb) / 2
                if z0 + ch * 0.5 > height_at(mid) + rng.uniform(-0.35, 0.35):
                    continue
                # joints are closed (the bevel leaves a fine groove); stones near the broken top have only
                # shifted a centimetre in depth and turned a hair (more, and the exposed end of the next stone
                # catches the moon like a crack of light), with the rubble core behind so no joint opens
                loose = z0 + course * 2 > height_at(mid)
                if loose:
                    box(bm, (pb - pa + 0.12, thick * 0.6, ch * 0.98), Vector((mid, 0, z0 + ch / 2)))
                    box(bm, (pb - pa, thick, ch), Vector((mid, rng.uniform(-0.01, 0.01), z0 + ch / 2)),
                        Quaternion((0, 0, 1), rng.uniform(-0.0015, 0.0015)))
                else:
                    box(bm, (pb - pa, thick, ch), Vector((mid, 0, z0 + ch / 2)))
        z0 += ch
        c += 1
    for s0, s1, top in openings:
        if height_at((s0 + s1) / 2) > top + course:
            box(bm, (s1 - s0 + 1.4, thick * 1.02, course * 1.5), Vector(((s0 + s1) / 2, 0, top + course * 0.75)))
    ob = obj_from_bm(bm, 'wall', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    # a hairline bevel: a wider one leaves a groove whose moon-facing side lights up like a crack of light
    bev.width, bev.segments, bev.limit_method = 0.005, 1, 'ANGLE'
    apply_mods(ob)
    return ob


def wall_colliders(meta, p0, p1, height_at, step=1.4, r=0.9, openings=()):
    p0, p1 = Vector(p0), Vector(p1)
    L = (p1 - p0).length
    for i in range(int(L / step) + 1):
        s = i * step
        if height_at(s) < 0.6 or any(s0 - 0.3 < s < s1 + 0.3 for s0, s1, _ in openings):
            continue
        p = p0.lerp(p1, s / L)
        meta['colliders'].append({'x': p.x, 'z': -p.y, 'r': r})


def course_run(length, lo, hi, rng):
    """Split a course of the given length into blocks of irregular length between lo and hi:
    (start, length) pairs, the last block taking up whatever is left."""
    out, s = [], 0.0
    while length - s > hi:
        bl = rng.uniform(lo, hi)
        if length - s - bl < lo:
            bl = (length - s) / 2
        out.append((s, bl))
        s += bl
    out.append((s, length - s))
    return out


def platform(hw, hd, base, top, steps, rng, tread=0.9, block=2.4, slab=0.3, floor_gap=None, center=(0.0, 0.0)):
    """Stepped platform of eroded blocks (about `block` long; paving slabs `block` square and `slab` thick);
    hw, hd = half sizes of the top step. Returns (object, floors)."""
    cx, cy = center
    bm = bmesh.new()
    sh = (top - base) / steps
    floors = []
    for s in range(steps):
        grow = (steps - 1 - s) * tread
        z0 = base - 0.9 if s == 0 else base + sh * s
        z1 = base + sh * (s + 1)
        W, Dd = hw + grow, hd + grow
        ring = max(1.2, tread + 0.35)
        for side in range(4):
            length = 2 * (W if side < 2 else Dd)
            for a0, bl in course_run(length, block * 0.8, block * 1.25, rng):
                if rng.random() < 0.05:
                    continue
                along = -length / 2 + a0 + bl / 2
                if side < 2:
                    c = Vector((cx + along, cy + (-1 if side == 0 else 1) * (Dd - ring / 2), (z0 + z1) / 2))
                    sz = (bl - 0.003, ring, z1 - z0 - 0.003)
                else:
                    c = Vector((cx + (-1 if side == 2 else 1) * (W - ring / 2), cy + along, (z0 + z1) / 2))
                    sz = (ring, bl - 0.003, z1 - z0 - 0.003)
                c += Vector((rng.uniform(-0.006, 0.006), rng.uniform(-0.006, 0.006), 0))
                box(bm, sz, c, Quaternion((0, 0, 1), rng.uniform(-0.002, 0.002)))
        floors.append({'hw': W, 'hl': Dd, 'top': z1, 'cx': cx, 'cz': -cy})
    box(bm, (2 * hw - 0.6, 2 * hd - 0.6, top - 0.3 - (base - 0.9)), Vector((cx, cy, (top - 0.3 + base - 0.9) / 2)))
    nx, ny = max(1, round(2 * hw / block)), max(1, round(2 * hd / block))
    for i in range(nx):
        for j in range(ny):
            x = cx - hw + (i + 0.5) * 2 * hw / nx
            y = cy - hd + (j + 0.5) * 2 * hd / ny
            if floor_gap and floor_gap(x - cx, y - cy):
                continue
            tilt = Quaternion(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized(), rng.uniform(0, 0.003))
            box(bm, (2 * hw / nx - 0.003, 2 * hd / ny - 0.003, slab), Vector((x, y, top - slab / 2 - rng.uniform(0, 0.01))), tilt)
    ob = obj_from_bm(bm, 'platform', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments, bev.limit_method = 0.03, 2, 'ANGLE'
    apply_mods(ob)
    densify(ob, 1)
    return ob, floors


def stones(parts, rng, n, region, z, scale=1.0):
    bm = bmesh.new()
    for _ in range(n):
        x, y = region(rng)
        q = Quaternion(Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized(), rng.uniform(0, 0.6))
        box(bm, (rng.uniform(1.0, 2.4) * scale, rng.uniform(0.7, 1.2) * scale, rng.uniform(0.5, 0.85) * scale), Vector((x, y, z + 0.2 * scale)), q)
    ob = obj_from_bm(bm, 'stones', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.1, 2
    apply_mods(ob)
    parts.append(ob)


def new_meta():
    return {'colliders': [], 'floors': [], 'gaze': []}


# ------------------------------------------------------------------ two-storey colonnade hall

def build_hall():
    """A long hall whose nave the path walks down: Doric below, Ionic gallery above, ruined outer walls.
    Long axis along Y (three.js Z)."""
    reset()
    rng = random.Random(21)
    parts, meta = [], new_meta()
    D1, H1, D2, H2 = 1.5, 9.0, 1.05, 6.8
    XC, SP, N = 4.6, 4.0, 13
    ys = [-SP * (N - 1) / 2 + SP * i for i in range(N)]
    TOP = -0.1
    ob, floors = platform(11.4, 26.6, SEABED, TOP, 2, rng, block=4.0, slab=0.6, floor_gap=lambda x, y: 5.6 < abs(x) < 9.6 and rng.random() < 0.35)
    parts.append(ob)
    meta['floors'] += floors

    lower = {1: set(range(1, 11)), -1: {2, 3, 4, 5, 8, 9, 10, 11}}
    upper = {1: {2, 3, 4, 5, 6}, -1: {3, 4, 9, 10}}
    upper_broken = {1: {8: 0.5, 9: 0.28}, -1: {5: 0.6, 11: 0.4, 2: 0.2}}
    ent_top = {}
    for side in (1, -1):
        tops = {}
        for i, y in enumerate(ys):
            st = 'intact' if i in lower[side] else (rng.uniform(0.12, 0.55) if rng.random() < 0.6 else 'stump')
            t = column(parts, meta, side * XC, y, TOP, 'doric', D1, H1, st, seed=i * 13 + side * 7)
            if t:
                tops[i] = t
        for run in runs(tops):
            y0, y1 = ys[run[0]], ys[run[-1]]
            ob, h = doric_entablature_obj(y1 - y0, D1, D1 * 1.2, SP)
            parts.append(place(ob, (side * XC, (y0 + y1) / 2, tops[run[0]]), math.pi / 2))
            for i in run:
                ent_top[(side, i)] = tops[run[0]] + h
        # the gallery above
        utops = {}
        for i, y in enumerate(ys):
            if (side, i) not in ent_top:
                continue
            if i in upper[side]:
                st = 'intact'
            elif i in upper_broken[side]:
                st = upper_broken[side][i]
            else:
                st = 'stump' if rng.random() < 0.35 else 'none'
            if st == 'none':
                continue
            t = column(parts, meta, side * XC, y, ent_top[(side, i)], 'ionic', D2, H2, st, seed=i * 31 + side, ry=math.pi / 2)
            if t:
                utops[i] = t
        for run in runs(utops):
            y0, y1 = ys[run[0]], ys[run[-1]]
            ob, h = ionic_entablature_obj(y1 - y0, D2, D2 * 1.25)
            parts.append(place(ob, (side * XC, (y0 + y1) / 2, utops[run[0]]), math.pi / 2))

    # stone beams still bridging the nave at gallery level; one has snapped
    for i, whole in ((3, True), (9, False)):
        z = ent_top[(1, i)]
        bm = bmesh.new()
        box(bm, (2 * XC + 1.4, 1.1, 1.0), Vector((0, ys[i], z + 0.5)))
        ob = obj_from_bm(bm, 'beam', smooth=False)
        if not whole:
            cut(ob, noisy_cutter(Vector((0.8, ys[i], z)), Vector((1, 0, 0.25)), 4, 0.35, 5, freq=1.2))
        parts.append(ob)
        meta['gaze'].append({'x': 0, 'z': -ys[i], 'y': z, 'r': 26})
    # the snapped half lies in the west aisle
    bm = bmesh.new()
    box(bm, (5.2, 1.1, 1.0), Vector((-7.4, ys[9] + 1.5, TOP + 0.45)), Quaternion((0.1, 0.2, 1), 0.5))
    parts.append(obj_from_bm(bm, 'beam_fallen', smooth=False))

    # gallery floor slabs along the east side
    bm = bmesh.new()
    for i in range(3, 9):
        if (1, i) in ent_top:
            box(bm, (5.3, SP - 0.06, 0.45), Vector((XC + 2.9, ys[i], ent_top[(1, i)] - 0.6)), Quaternion((1, 0, 0), rng.uniform(-0.02, 0.02)))
    parts.append(obj_from_bm(bm, 'gallery', smooth=False))

    # ruined outer walls
    L = 52.0
    east = lambda s: 2.2 + 6.5 * smoothstep(8, 16, s) * (1 - smoothstep(30, 40, s)) + 1.6 * fbm(s * 0.15, 1.3, 0, 3)
    west = lambda s: 2.5 + 6.0 * math.exp(-((s - 12) / 4.0) ** 2) + 2 * max(0, fbm(s * 0.12, 7.1, 0, 3))
    for side, prof in ((1, east), (-1, west)):
        x = side * 10.2
        ob = ashlar_wall(L, 1.1, prof, rng, course=1.25, blen=3.4)
        parts.append(place(ob, (x, -L / 2, TOP), math.pi / 2))
        wall_colliders(meta, (x, -L / 2), (x, L / 2), prof)

    # debris in the aisles, never on the walking line
    for k in range(9):
        side = 1 if k % 2 else -1
        fallen_drum(parts, meta, side * rng.uniform(6.2, 8.8), rng.uniform(-23, 23), TOP, D2, 'ionic', rng.uniform(0, 3), 40 + k)
    stones(parts, rng, 16, lambda r: ((1 if r.random() < 0.5 else -1) * r.uniform(6, 9.2), r.uniform(-24, 24)), TOP)

    hall = join(parts, 'ColonnadeHall')
    weather(hall, 0.7, 0.025)
    views = [((0, -40, 1.6), (0, 0, 8), 26), ((0, -14, 1.6), (0, 0, 12), 20), ((26, -30, 2), (0, 0, 8), 30)]
    finish_asset([hall], 'colonnade_hall', meta, views)


# ------------------------------------------------------------------ temple on a high podium

def build_podium():
    """A Doric temple on an 8 m podium; a broad stair runs down to the shore (toward -Y, the path)."""
    reset()
    rng = random.Random(55)
    parts, meta = [], new_meta()
    P0, PT = 0.5, 8.5
    PW, PY0, PY1 = 12.0, -11.5, 22.5           # podium half-width, front and back edge
    pc = (PY0 + PY1) / 2
    corner = Vector((-PW, PY0))
    def collapsed(x, y, z):
        d = (Vector((x, y)) - corner).length
        return d < 7.5 and z > 1.2 + 0.9 * d

    # core, mouldings and an ashlar skin, broken open at the front-left corner
    core = bmesh.new()
    box(core, (2 * PW - 0.6, PY1 - PY0 - 0.6, PT - P0 + 0.8), Vector((0, pc, (PT + P0 - 0.8) / 2 - 0.2)))
    co = obj_from_bm(core, 'core', smooth=False)
    cut(co, noisy_cutter(Vector((-PW + 3.2, PY0 + 3.2, 4.0)), Vector((-1, -1, 1.1)), 16, 0.8, 3, freq=0.35))
    densify(co, 3)
    parts.append(co)
    skin = bmesh.new()
    course, blen = 0.8, 2.0
    for c in range(int((PT - P0) / course)):
        z = P0 + c * course + course / 2
        for side in range(4):
            if side < 2:
                y = PY0 if side == 0 else PY1
                length, n = 2 * PW, int(2 * PW / blen)
            else:
                length, n = PY1 - PY0, int((PY1 - PY0) / blen)
            off = (c % 2) * 0.5
            for i in range(n):
                t = (i + 0.5 + off) / n
                if t > 1:
                    continue
                if side < 2:
                    x, yy = -PW + t * length, y
                    sz = (length / n - 0.03, 0.7, course - 0.03)
                else:
                    x, yy = (-PW if side == 2 else PW), PY0 + t * length
                    sz = (0.7, length / n - 0.03, course - 0.03)
                if collapsed(x, yy, z) or rng.random() < 0.02:
                    continue
                box(skin, sz, Vector((x, yy, z)), Quaternion((0, 0, 1), rng.uniform(-0.01, 0.01)))
    # base moulding and crown cornice
    for z, h, grow in ((P0 + 0.3, 0.6, 0.45), (PT - 0.35, 0.7, 0.55)):
        for side in range(4):
            if side < 2:
                y = PY0 if side == 0 else PY1
                for i in range(12):
                    x = -PW - grow + (i + 0.5) * (2 * PW + 2 * grow) / 12
                    if not collapsed(x, y, z):
                        box(skin, ((2 * PW + 2 * grow) / 12 - 0.03, 0.7 + 2 * grow, h), Vector((x, y, z)))
            else:
                x = -PW if side == 2 else PW
                for i in range(16):
                    yy = PY0 - grow + (i + 0.5) * (PY1 - PY0 + 2 * grow) / 16
                    if not collapsed(x, yy, z):
                        box(skin, (0.7 + 2 * grow, (PY1 - PY0 + 2 * grow) / 16 - 0.03, h), Vector((x, yy, z)))
    # top paving
    for i in range(10):
        for j in range(14):
            x = -PW + (i + 0.5) * 2 * PW / 10
            y = PY0 + (j + 0.5) * (PY1 - PY0) / 14
            if collapsed(x, y, PT) or rng.random() < 0.06:
                continue
            box(skin, (2 * PW / 10 - 0.04, (PY1 - PY0) / 14 - 0.04, 0.3), Vector((x, y, PT - 0.15)))
    # the great stair down to the shore, worn and broken on one side, with cheek walls
    nst = 26
    rise, run = (PT - P0) / nst, (PY0 - (-22.5)) / nst
    for k in range(nst):
        y = PY0 - (k + 0.5) * run
        z = PT - (k + 1) * rise
        w = 16.0
        if 4 <= k <= 11:
            w -= rng.uniform(1.5, 4.5)
        box(skin, (w, run + 0.05, rise + 0.6), Vector(((16.0 - w) / 2 * -1 if 4 <= k <= 11 else 0, y, z + rise / 2 - 0.3)))
    # cheek walls: sloping parapets either side of the stair, with a coping stone along the top
    YB = -22.5
    slope = math.atan2(PT - P0, PY0 - YB)
    for sx in (-1, 1):
        cw = bmesh.new()
        prof = [(PY0 + 0.4, P0 - 0.6), (YB - 0.3, P0 - 0.6), (YB - 0.3, P0 + 1.1), (PY0 + 0.4, PT + 1.1 + 0.4 * math.tan(slope))]
        f = cw.faces.new([cw.verts.new(Vector((sx * 8.0, y, z))) for y, z in prof])
        ret = bmesh.ops.extrude_face_region(cw, geom=[f])
        bmesh.ops.translate(cw, verts=[g for g in ret['geom'] if isinstance(g, bmesh.types.BMVert)], vec=Vector((sx * 0.9, 0, 0)))
        bmesh.ops.recalc_face_normals(cw, faces=cw.faces[:])
        L = math.hypot(PY0 + 0.4 - (YB - 0.3), PT - P0 + 0.4 * math.tan(slope))
        box(cw, (1.15, L, 0.28), Vector((sx * 8.45, (PY0 + 0.4 + YB - 0.3) / 2, (P0 + PT) / 2 + 1.15 + 0.2 * math.tan(slope))),
            Quaternion((1, 0, 0), slope))  # rising toward the top of the stair (+y)
        ob = obj_from_bm(cw, 'cheek', smooth=False)
        if sx < 0:
            cut(ob, noisy_cutter(Vector((-8.45, YB + 5.5, P0 + 1.0)), Vector((0, -0.35, 1)), 9, 0.4, 8, freq=0.6), overlapping=True)
        bev = ob.modifiers.new('bev', 'BEVEL')
        bev.width, bev.segments, bev.limit_method = 0.04, 1, 'ANGLE'
        apply_mods(ob)
        densify(ob, 2)
        parts.append(ob)
    ob = obj_from_bm(skin, 'podium', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments, bev.limit_method = 0.05, 1, 'ANGLE'
    apply_mods(ob)
    parts.append(ob)
    stones(parts, rng, 26, lambda r: (-PW - r.uniform(-2, 5), PY0 - r.uniform(-3, 5)), P0, 1.1)
    meta['floors'] += [
        {'hw': PW - 0.2, 'hl': (PY1 - PY0) / 2 - 0.2, 'top': PT, 'cx': 0, 'cz': -pc},
        # the stair as a ramp: three.js z runs from PY0 (top of the stair) out to 22.5 (the shore)
        {'hw': 8.0, 'hl': (PY0 + 22.5) / 2, 'cx': 0, 'cz': -(PY0 - 22.5) / 2, 'top': PT, 'ramp': [PT, P0]},
    ]

    # the temple on top
    D, H, SP = 1.5, 9.5, 3.6
    xs = [-SP * 2.5 + SP * i for i in range(6)]
    ys = [pc - SP * 4 + SP * j for j in range(9)]
    ob, fl = platform(xs[-1] + D * 0.5 + 0.7, ys[-1] - pc + D * 0.5 + 0.7, PT - 0.3, PT + 1.0, 3, rng, tread=0.55, block=3.1, slab=0.5, center=(0, pc))
    parts.append(ob)
    meta['floors'] += fl
    TT = PT + 1.0
    def state(i, j):
        if j == 0:
            return 'intact'
        if i == 0 and j <= 5:
            return 'intact'
        if i == 5 and j <= 2:
            return 'intact'
        if j == 8 and i in (1, 2):
            return 'intact'
        return rng.uniform(0.15, 0.6) if rng.random() < 0.55 else 'stump'
    tops = {}
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            if 0 < i < 5 and 0 < j < 8:
                continue
            t = column(parts, meta, x, y, TT, 'doric', D, H, state(i, j), seed=i * 17 + j * 5)
            if t:
                tops[(i, j)] = t
    zt = tops[(0, 0)]
    ob, h = doric_entablature_obj(xs[-1] - xs[0], D, D * 1.2, SP)
    parts.append(place(ob, (0, ys[0], zt)))
    ped, ph = pediment_obj(xs[-1] - xs[0] + 1.24 * D, D * 1.2, D)
    parts.append(place(ped, (0, ys[0], zt + h)))
    for i, js in ((0, range(0, 6)), (5, range(0, 3))):
        ob, _ = doric_entablature_obj(ys[js[-1]] - ys[js[0]], D, D * 1.2, SP)
        parts.append(place(ob, (xs[i], (ys[js[0]] + ys[js[-1]]) / 2, zt), math.pi / 2))
    ob, _ = doric_entablature_obj(xs[2] - xs[1], D, D * 1.2, SP)
    parts.append(place(ob, ((xs[1] + xs[2]) / 2, ys[-1], zt)))
    meta['gaze'].append({'x': 0, 'z': -ys[0], 'y': zt + h + ph * 0.4, 'r': 62})
    # cella walls
    cw, cy0, cy1 = 5.6, ys[1] + 0.8, ys[-2] - 0.4
    door = ((cw - 1.6, cw + 1.6, 6.5),)
    walls = [((-cw, cy0), (cw, cy0), lambda s: 5.2 - 2.4 * smoothstep(7, 11, s), door, 0),
             ((-cw, cy0 + 0.8), (-cw, cy1), lambda s: 4.8 - 3.2 * smoothstep(6, 18, s), (), math.pi / 2),
             ((cw, cy0 + 0.8), (cw, cy1), lambda s: 3.2 - 2.0 * smoothstep(4, 12, s) + 1.2 * max(0, fbm(s * 0.2, 3)), (), math.pi / 2)]
    for p0, p1, prof, ops, ang in walls:
        L = (Vector(p1) - Vector(p0)).length
        ob = ashlar_wall(L, 1.0, prof, rng, course=0.95, blen=2.6, openings=ops)
        parts.append(place(ob, (p0[0], p0[1], TT), ang))
        wall_colliders(meta, p0, p1, prof, openings=ops)

    temple = join(parts, 'PodiumTemple')
    scale_about(temple, 1.3, P0)
    meta['gaze'] = []
    weather(temple, 0.7, 0.025)
    views = [((0, -55, 1.6), (0, 0, 10), 28), ((-30, -40, 2), (0, 0, 10), 26), ((0, -26, 1.6), (0, 0, 14), 22)]
    finish_asset([temple], 'podium_temple', meta, views)


# ------------------------------------------------------------------ monumental gateway

def build_propylon():
    """A gateway after the Athenian Propylaea; the path runs along local Y through the central passage.
    Front (toward -Y) keeps its pediment; tall Ionic columns flank the passage inside."""
    reset()
    rng = random.Random(33)
    parts, meta = [], new_meta()
    D, H, TOP = 1.7, 10.5, 0.95
    ob, fl = platform(13.4, 12.2, SEABED, TOP, 4, rng, tread=0.8, block=4.0, slab=0.6)
    parts.append(ob)
    meta['floors'] += fl
    xs = [-10.35, -6.55, -2.75, 2.75, 6.55, 10.35]
    YF, YR, YW = -8.6, 8.6, 2.6
    tops_f = [column(parts, meta, x, YF, TOP, 'doric', D, H, 'intact', seed=k) for k, x in enumerate(xs)]
    rear = ['stump', 0.42, 'intact', 'intact', 'intact', 'none']
    tops_r = [column(parts, meta, x, YR, TOP, 'doric', D, H, st, seed=20 + k) for k, (x, st) in enumerate(zip(xs, rear))]
    zt = tops_f[0]
    ob, h = doric_entablature_obj(xs[-1] - xs[0], D, D * 1.2, 3.8)
    parts.append(place(ob, (0, YF, zt)))
    ped, ph = pediment_obj(xs[-1] - xs[0] + 1.24 * D, D * 1.2, D)
    cut(ped, noisy_cutter(Vector((9.5, YF, zt + h + 1.0)), Vector((1, 0, 0.6)), 8, 0.4, 6, freq=0.8), overlapping=True)
    parts.append(place(ped, (0, YF, zt + h)))
    ob, _ = doric_entablature_obj(xs[4] - xs[2], D, D * 1.2, 3.8)
    parts.append(place(ob, ((xs[2] + xs[4]) / 2, YR, tops_r[2])))
    meta['gaze'].append({'x': 0, 'z': -YF, 'y': zt + h + ph * 0.4, 'r': 40})

    # tall Ionic columns along the passage carry the ceiling beams
    DI, HI = 1.05, zt + h - TOP - 0.9
    for x, y, st in ((-3.7, -5.4, 'intact'), (3.7, -5.4, 'intact'), (-3.7, -1.6, 0.55), (3.7, -1.6, 'intact')):
        column(parts, meta, x, y, TOP, 'ionic', DI, HI, st, seed=int(x * 10 + y), ry=math.pi / 2)
    zb = TOP + HI
    bm = bmesh.new()
    box(bm, (0.95, YW - YF + 0.6, 0.9), Vector((3.7, (YF + YW) / 2, zb + 0.45)))
    box(bm, (0.95, 4.4, 0.9), Vector((-3.7, YF + 2.2, zb + 0.45)))
    for x in (-8.4, -5.5, 0.0, 5.5):
        if x == 0.0:
            box(bm, (0.9, 6.0, 0.8), Vector((x, YF + 3.0, zb + 0.4)))
        else:
            box(bm, (0.9, YW - YF, 0.8), Vector((x, (YF + YW) / 2, zb + 0.4)))
    parts.append(obj_from_bm(bm, 'ceiling', smooth=False))

    # side walls and the cross wall with five doorways
    side_l = lambda s: 6.5 - 3.5 * smoothstep(4, 14, s) + 1.5 * fbm(s * 0.3, 2.2)
    side_r = lambda s: 5.0 - 2.8 * smoothstep(3, 13, s) + 1.2 * fbm(s * 0.3, 8.1)
    for x, prof in ((-12.3, side_l), (12.3, side_r)):
        ob = ashlar_wall(YR - YF, 1.2, prof, rng, course=1.25, blen=3.4)
        parts.append(place(ob, (x, YF, TOP), math.pi / 2))
        wall_colliders(meta, (x, YF), (x, YR), prof)
    doors = ((12.3 - 2.3, 12.3 + 2.3, 9.4), (12.3 - 6.6, 12.3 - 4.0, 6.4), (12.3 + 4.0, 12.3 + 6.6, 6.4),
             (12.3 - 10.2, 12.3 - 8.2, 4.4), (12.3 + 8.2, 12.3 + 10.2, 4.4))
    cross = lambda s: 12.6 - 6.5 * smoothstep(15, 22, s) + 0.8 * fbm(s * 0.4, 4.4)
    ob = ashlar_wall(24.6, 1.6, cross, rng, course=1.25, blen=3.4, openings=doors)
    parts.append(place(ob, (-12.3, YW, TOP)))
    wall_colliders(meta, (-12.3, YW), (12.3, YW), cross, openings=doors)

    # a fallen ceiling beam and stones in the shallows
    bm = bmesh.new()
    box(bm, (0.9, 9.0, 0.8), Vector((-7.0, YF - 6.0, SEABED + 0.5)), Quaternion((0.15, 0.1, 1), 0.7))
    parts.append(obj_from_bm(bm, 'beam_fallen', smooth=False))
    stones(parts, rng, 14, lambda r: ((1 if r.random() < 0.5 else -1) * r.uniform(9, 17), r.uniform(-16, 16)), SEABED)
    fallen_drum(parts, meta, 15.5, 4.0, SEABED, D, 'doric', 0.4, 77)
    fallen_drum(parts, meta, 16.2, 6.4, SEABED, D, 'doric', 0.9, 78)

    gate = join(parts, 'Propylon')
    weather(gate, 0.7, 0.025)
    views = [((0, -40, 1.6), (0, 0, 9), 26), ((0, -4, 2.2), (0, 6, 9), 18), ((-30, -26, 2), (0, 0, 8), 28)]
    finish_asset([gate], 'propylon', meta, views)



# ------------------------------------------------------------------ the foot of a colossal column

def giant_column_base(meta):
    """Stepped footing, Attic base and a broken stump of a 6.4 m column; two drums lie beside it."""
    D = 6.4
    rb = D / 2
    parts = []
    m = new_meta()
    bm = bmesh.new()
    box(bm, (14.0, 14.0, 1.4), Vector((0, 0, SEABED + 0.2)))
    box(bm, (12.2, 12.2, 0.6), Vector((0, 0, 0.6)))
    ob = obj_from_bm(bm, 'footing', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.12, 2
    apply_mods(ob)
    densify(ob, 3)
    cut(ob, noisy_cutter(Vector((6.4, -6.4, 0.6)), Vector((1, -1, 0.8)), 7, 0.4, 12, freq=0.6), overlapping=True)
    parts.append(ob)
    zb = 0.9
    base = bmesh.new()
    h = attic_base(base, rb, Matrix.Translation(Vector((0, 0, zb))))
    parts.append(obj_from_bm(base, 'base'))
    bm = bmesh.new()
    shaft(bm, rb, 4.6, 34, Matrix.Translation(Vector((0, 0, zb + h))), drum=D * 0.45)
    ob = obj_from_bm(bm, 'stump')
    cut(ob, noisy_cutter(Vector((0, 0, zb + h + 3.4)), Vector((0.35, -0.25, 1)), D * 2.6, 0.8, 9, freq=0.35))
    parts.append(ob)
    fallen_drum(parts, m, 11.0, -2.5, SEABED, D * 0.98, 'ionic', 0.5, 91, length=2.8)
    fallen_drum(parts, m, 8.4, 6.2, SEABED, D * 0.96, 'ionic', 1.9, 92, length=2.5)
    rng = random.Random(4)
    stones(parts, rng, 12, lambda r: (r.uniform(-12, 14), r.uniform(-12, 12)), SEABED, 1.4)
    ob = join(parts, 'GiantBase')
    weather(ob, 0.6, 0.04)
    meta['GiantBase'] = {}
    return ob


# ------------------------------------------------------------------ the earlier ruins, now built here too

def peripteral(parts, meta, nx, nz, sp, D, H, top, state, seed, pediment=False):
    """Doric columns round a rectangle: x across, z along in three.js local axes (Blender y = -z).
    Entablature over every run of standing columns; an optional pediment on the front (+z)."""
    W, L = (nx - 1) * sp / 2, (nz - 1) * sp / 2
    tops = {}
    for j in range(nz):
        for i in range(nx):
            if 0 < i < nx - 1 and 0 < j < nz - 1:
                continue
            t = column(parts, meta, -W + i * sp, -(-L + j * sp), top, 'doric', D, H, state(i, j), seed=seed + i * 31 + j * 7)
            if t:
                tops[(i, j)] = t
    depth = D * 1.2
    sides = [[(i, nz - 1) for i in range(nx)], [(i, 0) for i in range(nx)],
             [(0, j) for j in range(nz)], [(nx - 1, j) for j in range(nz)]]
    for k, cells in enumerate(sides):
        for run in runs([n for n, c in enumerate(cells) if c in tops]):
            a, b = cells[run[0]], cells[run[-1]]
            ax, az, bx, bz = -W + a[0] * sp, -L + a[1] * sp, -W + b[0] * sp, -L + b[1] * sp
            ob, h = doric_entablature_obj(math.hypot(bx - ax, bz - az), D, depth, sp)
            parts.append(place(ob, ((ax + bx) / 2, -(az + bz) / 2, tops[a]), 0 if k < 2 else math.pi / 2))
            if k == 0 and pediment and len(run) == nx:
                ped, _ = pediment_obj(2 * W + 1.24 * D, depth, D)
                parts.append(place(ped, (0, -L, tops[a] + h)))
    return tops


def cella(parts, meta, rng, hw, hl, top, door, height, keep, course, thick=0.7):
    """Ruined cella walls; doorways (width `door`) front and back on the axis. Lengths in three.js axes."""
    ops = ((hw - door / 2, hw + door / 2, height * 2),) if door else ()
    seed = rng.uniform(0, 50)
    prof = lambda k: (lambda s: height * (0.15 + keep * k * (0.5 + 0.5 * math.sin(s * 0.45 + seed + k)
                                                              * math.cos(s * 0.17 + seed * 0.3))) + rng.uniform(0, 0.3))
    walls = [((-hw, -hl), (hw, -hl), prof(1.0), ops, 0),          # front (three.js +z)
             ((-hw, hl), (hw, hl), prof(0.8), ops, 0),            # back
             ((-hw, -hl + thick), (-hw, hl - thick), prof(1.0), (), math.pi / 2),
             ((hw, -hl + thick), (hw, hl - thick), prof(0.9), (), math.pi / 2)]
    for p0, p1, f, o, ang in walls:
        L = (Vector(p1) - Vector(p0)).length
        ob = ashlar_wall(L, thick, f, rng, course=course, blen=course * 3, openings=o)
        parts.append(place(ob, (p0[0], p0[1], top), ang))


def build_naos():
    """The temple the path walks straight through along its axis, its floor a hand's depth under water."""
    reset()
    rng = random.Random(101)
    parts, meta = [], new_meta()
    D, H, SP = 1.0, 5.8, 3.0
    BASE, TOP = -0.36, -0.08
    ob, _ = platform(8.5, 12.95, BASE, TOP, 2, rng, tread=0.8, block=2.0)
    parts.append(ob)

    def state(i, j):
        if i == 5 and j >= 2:
            return 'intact'
        if j == 0 and 1 <= i <= 4:
            return 'intact' if rng.random() < 0.85 else rng.uniform(0.3, 0.7)
        if j == 8:
            return 'intact' if i >= 3 else (rng.uniform(0.2, 0.6) if rng.random() < 0.5 else 'stump')
        if i == 0:
            return 'intact' if rng.random() < 0.3 else (rng.uniform(0.2, 0.7) if rng.random() < 0.6 else 'stump')
        return rng.uniform(0.2, 0.7) if rng.random() < 0.5 else 'stump'
    peripteral(parts, meta, 6, 9, SP, D, H, TOP, state, 101)
    cella(parts, meta, rng, 4.3, 7.6, TOP, 2.6, 2.4, 0.6, 0.55)
    for k in range(10):
        x = (1 if rng.random() < 0.5 else -1) * rng.uniform(2.3, 11)
        y = rng.uniform(-16, 16)
        if abs(x) < 7.5 and abs(y) < 12:
            fallen_drum(parts, meta, x, y, TOP, D, 'doric', rng.uniform(0, 3), 300 + k, length=1.0)
    stones(parts, rng, 12, lambda r: ((1 if r.random() < 0.5 else -1) * r.uniform(2.4, 12), r.uniform(-17, 17)), BASE, 0.7)
    ob = join(parts, 'Naos')
    scale_about(ob, 2.2)
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'naos', meta, [((0, -30, 1.6), (0, 0, 3), 26), ((0, -6, 1.6), (0, 6, 3), 22)])


def round_platform(R, base, top, steps, rng, tread=0.6):
    bm = bmesh.new()
    sh = (top - base) / steps
    for s_ in range(steps):
        ro = R + (steps - 1 - s_) * tread
        z0 = base - 0.9 if s_ == 0 else base + sh * s_
        z1 = base + sh * (s_ + 1)
        n = int(math.tau * ro / 1.6)
        for k in range(n):
            a = (k + 0.5) / n * math.tau
            rc = ro - 0.6
            box(bm, (1.2, math.tau * ro / n - 0.004, z1 - z0 - 0.003), Vector((math.cos(a) * rc, math.sin(a) * rc, (z0 + z1) / 2)),
                Quaternion((0, 0, 1), a + rng.uniform(-0.002, 0.002)))
    bmesh.ops.create_cone(bm, cap_ends=True, segments=72, radius1=R - 0.3, radius2=R - 0.3, depth=top - base + 0.6,
                          matrix=Matrix.Translation(Vector((0, 0, (top + base - 0.9) / 2 + 0.15))))
    ob = obj_from_bm(bm, 'round_platform', smooth=False)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments, bev.limit_method = 0.05, 2, 'ANGLE'
    apply_mods(ob)
    densify(ob, 1)
    return ob


def build_tholos():
    """A round tholos (after Delphi): three columns still carry their entablature."""
    reset()
    rng = random.Random(202)
    parts, meta = [], new_meta()
    R, n, D, H = 9.3, 20, 1.08, 7.9
    BASE, TOP = -0.42, 0.27
    parts.append(round_platform(R + 1.2, BASE, TOP, 3, rng))
    # the path runs along y through the middle: columns sit half a spacing off its line, and the three
    # still carrying their entablature stand where it enters, so one walks in beneath them
    ang = lambda k: (k + 0.5) / n * math.tau
    tops = []
    for k in range(n):
        a = ang(k)
        st = 'intact' if 4 <= k <= 6 else ('none' if rng.random() < 0.25 else ('stump' if rng.random() < 0.5 else rng.uniform(0.15, 0.6)))
        tops.append(column(parts, meta, math.cos(a) * R, math.sin(a) * R, TOP, 'doric', D, H, st, seed=k * 11, ry=a))  # abacus square to the centre
        if st not in ('intact', 'none') and rng.random() < 0.6:
            d = rng.uniform(1.8, 4.0)
            x, y = math.cos(a) * (R + d), math.sin(a) * (R + d)
            if abs(x) > 1.8:
                fallen_drum(parts, meta, x, y, BASE, D, 'doric', rng.uniform(0, 3), 400 + k)
    for k in (4, 5):
        a0, a1 = ang(k), ang(k + 1)
        p0, p1 = Vector((math.cos(a0) * R, math.sin(a0) * R)), Vector((math.cos(a1) * R, math.sin(a1) * R))
        ob, _ = doric_entablature_obj((p1 - p0).length, D, D * 1.2, (p1 - p0).length, ext=0.25 * D)
        mid = (p0 + p1) / 2
        parts.append(place(ob, (mid.x, mid.y, tops[k]), math.atan2(p1.y - p0.y, p1.x - p0.x)))
    Ri, segs = 6.6, 24
    for k in range(segs):
        if k in (5, 6, 17, 18):  # doorways where the path crosses
            continue
        a0, a1 = k / segs * math.tau, (k + 1) / segs * math.tau
        p0, p1 = Vector((math.cos(a0) * Ri, math.sin(a0) * Ri)), Vector((math.cos(a1) * Ri, math.sin(a1) * Ri))
        hgt = 0.6 + 1.6 * (0.5 + 0.5 * math.sin(k * 0.9 + 1.3))
        ob = ashlar_wall((p1 - p0).length, 0.9, lambda s, h=hgt: h, rng, course=0.6, blen=1.9)
        parts.append(place(ob, (p0.x, p0.y, TOP), math.atan2(p1.y - p0.y, p1.x - p0.x)))
    ob = join(parts, 'Tholos')
    scale_about(ob, 2.0)
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'tholos', meta, [((0, -60, 1.6), (0, 0, 8), 26), ((0, -16, 1.6), (0, 0, 12), 22)])


def build_stoa():
    """A long colonnade, most of its columns broken at different heights, the ruin of its back wall behind."""
    reset()
    rng = random.Random(303)
    parts, meta = [], new_meta()
    D, H, SP, n = 1.08, 6.9, 3.9, 8
    BASE, TOP = -0.42, 0.06
    half = SP * (n - 1) / 2
    ob, _ = platform(half + 2.7, 5.4, BASE, TOP, 2, rng, tread=0.8, block=2.6, slab=0.4)
    parts.append(ob)
    x0 = -SP * (n - 1) / 2
    tops = {}
    for k in range(n):
        intact = k in (1, 2, 3, 5, 6)
        st = 'intact' if intact else (rng.uniform(0.15, 0.65) if rng.random() < 0.6 else 'stump')
        t = column(parts, meta, x0 + k * SP, -3.45, TOP, 'doric', D, H, st, seed=k * 13)
        if t:
            tops[k] = t
        elif rng.random() < 0.6:
            fallen_drum(parts, meta, x0 + k * SP + rng.uniform(-1.5, 1.5), -rng.uniform(6.5, 9), BASE, D, 'doric', rng.uniform(0, 3), 500 + k)
    for run in runs(tops):
        a, b = x0 + run[0] * SP, x0 + run[-1] * SP
        ob, _ = doric_entablature_obj(b - a, D, D * 1.2, SP)
        parts.append(place(ob, ((a + b) / 2, -3.45, tops[run[0]])))
    # the back wall survives only as a broken ruin, one to three courses high
    prof = lambda s: 0.7 + 1.9 * max(0.0, 0.5 + 0.5 * math.sin(s * 0.33 + 1.0) * math.cos(s * 0.11)) + 0.3 * fbm(s * 0.5, 3)
    ob = ashlar_wall(2 * half + 4.5, 1.1, prof, rng, course=0.83, blen=2.3)
    parts.append(place(ob, (-half - 2.25, 3.9, TOP)))
    stones(parts, rng, 10, lambda r: (r.uniform(-half, half), r.uniform(6.5, 11)), BASE, 0.9)
    ob = join(parts, 'Stoa')
    scale_about(ob, 1.5)
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'stoa', meta, [((0, -40, 1.6), (0, 0, 3), 30)])


def build_shrine():
    """A small prostyle shrine on the shore; its pediment still stands over three columns."""
    reset()
    rng = random.Random(404)
    parts, meta = [], new_meta()
    D, H, SP = 1.11, 7.0, 3.45
    BASE, TOP = 0.33, 1.275
    ob, _ = platform(6.9, 11.1, BASE, TOP, 3, rng, tread=0.7, block=2.5, slab=0.4)
    parts.append(ob)
    xs = [k * SP for k in (-1.5, -0.5, 0.5, 1.5)]
    yf = -8.85
    tops = [column(parts, meta, x, yf, TOP, 'doric', D, H, 'intact' if i < 3 else 0.45, seed=600 + i) for i, x in enumerate(xs)]
    ob, h = doric_entablature_obj(xs[2] - xs[0], D, D * 1.2, SP)
    parts.append(place(ob, ((xs[0] + xs[2]) / 2, yf, tops[0])))
    ped, _ = pediment_obj(xs[2] - xs[0] + 1.24 * D + 0.6, D * 1.2, D)
    parts.append(place(ped, ((xs[0] + xs[2]) / 2, yf, tops[0] + h)))
    fallen_drum(parts, meta, xs[3] + 2.2, yf - 2.5, BASE, D, 'doric', 0.4, 611)
    # the cella stands only as a ruin: highest beside the porch, broken down toward the back
    walls = [((-5.1, -6.45), (-1.35, -6.45), lambda s: 3.0 - 0.3 * s), ((1.35, -6.45), (5.1, -6.45), lambda s: 2.6 + 0.1 * s),
             ((-5.1, -5.75), (-5.1, 9.9), lambda s: 3.0 - 1.8 * smoothstep(3, 13, s)),
             ((5.1, -5.75), (5.1, 9.9), lambda s: 2.4 - 1.4 * smoothstep(2, 11, s) + 0.5 * max(0, fbm(s * 0.3, 2))),
             ((-5.1, 9.9), (5.1, 9.9), lambda s: 1.1 + 0.4 * fbm(s * 0.4, 5))]
    for p0, p1, prof in walls:
        L = (Vector(p1) - Vector(p0)).length
        ob = ashlar_wall(L, 0.75, prof, rng, course=0.78, blen=2.2)
        parts.append(place(ob, (p0[0], p0[1], TOP), math.atan2(p1[1] - p0[1], p1[0] - p0[0])))
    ob = join(parts, 'Shrine')
    scale_about(ob, 1.6, BASE)
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'shrine', meta, [((0, -32, 2.4), (0, 0, 4), 28), ((-18, -24, 2.4), (0, 0, 4), 30)])


def build_hill():
    """The temple on the island hill (after Sounion); its moon-facing flank survives.
    Built with its base at z = 0; the scene lifts it onto the hilltop."""
    reset()
    rng = random.Random(505)
    parts, meta = [], new_meta()
    D, H, SP = 0.86, 5.0, 2.4
    BASE, TOP = 0.0, 0.95
    HD, K = 10.4, 2.4
    ob, _ = platform(6.8, HD, BASE, TOP, 3, rng, tread=0.55, block=2.0)
    parts.append(ob)

    def state(i, j):
        if i == 5 and 1 <= j <= 7:
            return 'intact'
        if j == 8 and i >= 2:
            return 'intact'
        if i == 0 and j in (2, 3, 6):
            return 'intact'
        r = rng.random()
        return 'none' if r < 0.15 else ('stump' if r < 0.55 else rng.uniform(0.2, 0.7))
    peripteral(parts, meta, 6, 9, SP, D, H, TOP, state, 505)
    cella(parts, meta, rng, 3.6, 6.5, TOP, 2.2, 1.6, 0.5, 0.5)
    stones(parts, rng, 12, lambda r: ((1 if r.random() < 0.5 else -1) * r.uniform(8, 12), r.uniform(-13, 13)), BASE - 0.1, 0.6)
    ob = join(parts, 'HillTemple')
    scale_about(ob, K)
    # at this size each step of the base is knee-high: a broad stair climbs it at both ends
    bm = bmesh.new()
    top, run, nst = TOP * K, 0.55, 8
    for side in (-1, 1):
        for k in range(nst):
            y0, y1 = HD * K + k * run, HD * K + (k + 1) * run
            zt = top * (nst - k) / nst
            box(bm, (9.0, run - 0.02, zt + 0.6), Vector((0, side * (y0 + y1) / 2, (zt - 0.6) / 2)))
    st = obj_from_bm(bm, 'stairs', smooth=False)
    bev = st.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.04, 1
    apply_mods(st)
    densify(st, 2)
    ob = join([ob, st], 'HillTemple')
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'hill_temple', meta, [((30, -70, 2), (0, 0, 8), 26)])


def build_avenue():
    """An avenue of colossal Ionic columns standing on plinths in the water; the path walks between
    the two rows. A few pairs still carry their lintels, one great lintel spans the avenue, and one
    column lies where it fell, drum after drum, out into the sea."""
    reset()
    rng = random.Random(707)
    parts, meta = [], new_meta()
    D, H, SP, N, X, Z0 = 2.0, 22.0, 8.0, 8, 8.5, 0.9
    ys = [-SP * (N - 1) / 2 + SP * i for i in range(N)]
    plan = {1: {0: 'intact', 1: 'intact', 2: 0.45, 3: 'intact', 4: 'intact', 5: 0.7, 6: 'intact', 7: 'stump'},
            -1: {0: 'intact', 1: 0.55, 2: 'intact', 3: 'intact', 4: 0.3, 5: 'intact', 6: 0.6, 7: 'none'}}
    bm = bmesh.new()
    for side in (1, -1):
        for i, y in enumerate(ys):
            box(bm, (3.8, 3.8, Z0 - SEABED + 0.8), Vector((side * X, y, (Z0 + SEABED - 0.8) / 2)), Quaternion((0, 0, 1), rng.uniform(-0.02, 0.02)))
            box(bm, (4.4, 4.4, 0.5), Vector((side * X, y, SEABED + 0.1)))
    plinths = obj_from_bm(bm, 'plinths', smooth=False)
    bev = plinths.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.08, 2
    apply_mods(plinths)
    densify(plinths, 2)
    parts.append(plinths)
    tops = {}
    for side in (1, -1):
        for i, y in enumerate(ys):
            t = column(parts, meta, side * X, y, Z0, 'ionic', D, H, plan[side][i], seed=700 + i * 7 + side, ry=math.pi / 2)
            if t:
                tops[(side, i)] = t
        for run in runs([i for i in range(N) if (side, i) in tops]):
            y0, y1 = ys[run[0]], ys[run[-1]]
            ob, _ = ionic_entablature_obj(y1 - y0, D, D * 1.2)
            parts.append(place(ob, (side * X, (y0 + y1) / 2, tops[(side, run[0])]), math.pi / 2))
    # one great lintel across the avenue, on the first pair
    zt = tops[(1, 0)]
    bm = bmesh.new()
    box(bm, (2 * X + D * 1.6, 2.0, 1.7), Vector((0, ys[0], zt + 0.85)))
    box(bm, (2 * X + D * 2.0, 2.4, 0.5), Vector((0, ys[0], zt + 1.95)))
    parts.append(obj_from_bm(bm, 'lintel', smooth=False))
    meta['gaze'].append({'x': 0, 'z': -ys[0], 'y': zt, 'r': 45})
    # the fallen column: drums lying outward into the water from its empty plinth
    for k in range(9):
        d = X + 3.2 + k * 2.35
        fallen_drum(parts, meta, -d, ys[7] + math.sin(k * 0.8) * 0.4 + k * 0.25, SEABED, D, 'ionic', math.pi / 2 + rng.uniform(-0.15, 0.15), 720 + k, length=2.2)
    stones(parts, rng, 14, lambda r: ((1 if r.random() < 0.5 else -1) * r.uniform(X + 3, X + 12), r.uniform(-32, 32)), SEABED, 1.3)
    ob = join(parts, 'Avenue')
    weather(ob, 0.7, 0.025)
    finish_asset([ob], 'avenue', meta, [((0, -45, 1.6), (0, 0, 10), 24), ((0, -10, 1.6), (0, 10, 16), 20)])


def build_laurel_ruins():
    """A few remains under the ancient laurel, there to give it scale: a stretch of wall, a broken column,
    a fallen drum and scattered blocks. Built with its base at z = 0; the scene sets it on the slope."""
    reset()
    rng = random.Random(606)
    parts, meta = [], new_meta()
    prof = lambda s: 0.7 + 1.5 * max(0.0, math.sin(s * 0.55 + 0.4)) + rng.uniform(0, 0.25)
    ob = ashlar_wall(7.0, 0.75, prof, rng, course=0.5, blen=1.5)
    parts.append(place(ob, (-4.2, 0.6, -0.3)))
    bm = bmesh.new()
    box(bm, (8.2, 1.3, 0.6), Vector((-0.6, 0.6, -0.35)))
    footing = obj_from_bm(bm, 'footing', smooth=False)
    bev = footing.modifiers.new('bev', 'BEVEL')
    bev.width, bev.segments = 0.06, 2
    apply_mods(footing)
    densify(footing, 2)
    parts.append(footing)
    column(parts, meta, 4.4, -0.6, -0.1, 'doric', 0.95, 5.6, 0.3, 61)
    fallen_drum(parts, meta, 2.6, -2.6, -0.2, 0.95, 'doric', 0.5, 62, length=1.0)
    fallen_drum(parts, meta, -2.2, -2.2, -0.2, 0.9, 'doric', 2.3, 63, length=0.9)
    stones(parts, rng, 9, lambda r: (r.uniform(-5, 5), r.uniform(-3.2, 2.8)), -0.25, 0.75)
    ob = join(parts, 'LaurelRuins')
    weather(ob, 0.6, 0.02)
    finish_asset([ob], 'laurel_ruins', meta, [((0, -12, 1.6), (0, 0, 1), 30)])


if __name__ == '__main__':
    builders = {'temple': build_temple, 'statues': build_statues, 'hall': build_hall,
                'podium': build_podium, 'propylon': build_propylon, 'naos': build_naos, 'tholos': build_tholos,
                'stoa': build_stoa, 'shrine': build_shrine, 'hill': build_hill, 'laurel_ruins': build_laurel_ruins,
                'avenue': build_avenue}
    for name in WHAT:
        builders[name]()
