"""Gina "Mecha-Botanical Cyber-Guard", procedural, headless Blender (Cycles, METAL).

usage:
  blender --background --python design/3d/gina_mecha.py -- head  <out.png> [samples]
  blender --background --python design/3d/gina_mecha.py -- full  <out.png> [samples]

Anatomy follows assets/references/gina-*.png: dark spherical core, big white
eyes, lime leaf hood with a curled sprout and one long lock on her right.
Mecha treatment follows assets/references/mecha-style-reference.jpg: the
petals become worn armour plates with seams that show lit circuitry, bolts,
optical eye housings and cables.
"""
import bpy, bmesh, math, sys
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
MODE = argv[0] if argv else "head"
OUT = argv[1] if len(argv) > 1 else f"/tmp/gina_{MODE}.png"
SAMPLES = int(argv[2]) if len(argv) > 2 else 96

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception as exc:  # fall back, but say so
    print("GPU unavailable:", exc)
    scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.view_settings.exposure = -0.3
scene.render.film_transparent = False


def hex_rgb(h, a=1.0):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, a)


# ---------------------------------------------------------------- materials
def new_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    return m, nt, nt.nodes["Principled BSDF"]


def simple(name, color, rough=0.4, metal=0.0, emit=None, strength=0.0, coat=0.0):
    m, nt, b = new_mat(name)
    b.inputs["Base Color"].default_value = hex_rgb(color)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
    if emit:
        b.inputs["Emission Color"].default_value = hex_rgb(emit)
        b.inputs["Emission Strength"].default_value = strength
    return m


def armour(name, c1, c2, wear="#DDE6CF"):
    """Worn painted armour: two-tone paint, chipped edges, cavity grime, dents."""
    m, nt, b = new_mat(name)
    N, L = nt.nodes, nt.links
    tc = N.new("ShaderNodeTexCoord")
    noise = N.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 6
    L.new(tc.outputs["Object"], noise.inputs["Vector"])
    tone = N.new("ShaderNodeMix"); tone.data_type = "RGBA"
    tone.inputs[6].default_value = hex_rgb(c1); tone.inputs[7].default_value = hex_rgb(c2)
    L.new(noise.outputs["Fac"], tone.inputs[0])
    # chips: high-frequency noise thresholded, stronger near convex edges (bevel normal vs true normal)
    chipn = N.new("ShaderNodeTexNoise"); chipn.inputs["Scale"].default_value = 38
    chipn.inputs["Detail"].default_value = 10; chipn.inputs["Roughness"].default_value = 0.7
    L.new(tc.outputs["Object"], chipn.inputs["Vector"])
    bev = N.new("ShaderNodeBevel"); bev.inputs["Radius"].default_value = 0.025
    geo = N.new("ShaderNodeNewGeometry")
    dot = N.new("ShaderNodeVectorMath"); dot.operation = "DOT_PRODUCT"
    L.new(bev.outputs["Normal"], dot.inputs[0]); L.new(geo.outputs["Normal"], dot.inputs[1])
    edge = N.new("ShaderNodeMapRange"); edge.inputs["From Min"].default_value = 0.995
    edge.inputs["From Max"].default_value = 0.90
    L.new(dot.outputs["Value"], edge.inputs["Value"])
    add = N.new("ShaderNodeMath"); add.operation = "ADD"
    L.new(edge.outputs["Result"], add.inputs[0]); L.new(chipn.outputs["Fac"], add.inputs[1])
    chipr = N.new("ShaderNodeValToRGB")
    chipr.color_ramp.elements[0].position = 0.63; chipr.color_ramp.elements[1].position = 0.66
    L.new(add.outputs["Value"], chipr.inputs["Fac"])
    paint = N.new("ShaderNodeMix"); paint.data_type = "RGBA"
    L.new(chipr.outputs["Color"], paint.inputs[0]); L.new(tone.outputs[2], paint.inputs[6])
    paint.inputs[7].default_value = hex_rgb(wear)
    # cavity grime via AO
    ao = N.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.12
    grime = N.new("ShaderNodeMix"); grime.data_type = "RGBA"
    aor = N.new("ShaderNodeValToRGB")
    aor.color_ramp.elements[0].position = 0.35; aor.color_ramp.elements[1].position = 0.95
    L.new(ao.outputs["AO"], aor.inputs["Fac"])
    L.new(aor.outputs["Color"], grime.inputs[0])
    grime.inputs[6].default_value = hex_rgb("#164E27")
    L.new(paint.outputs[2], grime.inputs[7])
    L.new(grime.outputs[2], b.inputs["Base Color"])
    # metal where chipped
    mm = N.new("ShaderNodeMapRange"); mm.inputs["To Min"].default_value = 0.15; mm.inputs["To Max"].default_value = 0.9
    L.new(chipr.outputs["Color"], mm.inputs["Value"]); L.new(mm.outputs["Result"], b.inputs["Metallic"])
    rr = N.new("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = 0.30; rr.inputs["To Max"].default_value = 0.55
    L.new(noise.outputs["Fac"], rr.inputs["Value"]); L.new(rr.outputs["Result"], b.inputs["Roughness"])
    # dents + scratches
    dn = N.new("ShaderNodeTexNoise"); dn.inputs["Scale"].default_value = 14; dn.inputs["Detail"].default_value = 4
    L.new(tc.outputs["Object"], dn.inputs["Vector"])
    bump = N.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.3; bump.inputs["Distance"].default_value = 0.02
    L.new(dn.outputs["Fac"], bump.inputs["Height"]); L.new(bev.outputs["Normal"], bump.inputs["Normal"])
    L.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def circuits(name):
    """Dark board with glowing traces (voronoi edges) and pads, seen through plate seams."""
    m, nt, b = new_mat(name)
    N, L = nt.nodes, nt.links
    tc = N.new("ShaderNodeTexCoord")
    vor = N.new("ShaderNodeTexVoronoi"); vor.feature = "DISTANCE_TO_EDGE"; vor.inputs["Scale"].default_value = 18
    L.new(tc.outputs["Object"], vor.inputs["Vector"])
    ramp = N.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0; ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    ramp.color_ramp.elements[1].position = 0.06; ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    L.new(vor.outputs["Distance"], ramp.inputs["Fac"])
    hue = N.new("ShaderNodeTexNoise"); hue.inputs["Scale"].default_value = 2.5
    L.new(tc.outputs["Object"], hue.inputs["Vector"])
    hm = N.new("ShaderNodeMix"); hm.data_type = "RGBA"
    hm.inputs[6].default_value = hex_rgb("#A3E635"); hm.inputs[7].default_value = hex_rgb("#22D3EE")
    L.new(hue.outputs["Fac"], hm.inputs[0])
    mul = N.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    L.new(ramp.outputs["Color"], mul.inputs[6]); L.new(hm.outputs[2], mul.inputs[7])
    L.new(mul.outputs[2], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = 2.5
    b.inputs["Base Color"].default_value = hex_rgb("#101418")
    b.inputs["Metallic"].default_value = 0.8
    b.inputs["Roughness"].default_value = 0.35
    return m


M_HOOD = armour("hood", "#A4E637", "#8CD728")
M_LOCK = armour("lock", "#9EDF32", "#7FC51F")
M_CIRC = circuits("circuits")
M_CORE = simple("titanium", "#1E2022", 0.42, 0.75)
M_CORE_DARK = simple("joint", "#121416", 0.35, 0.9)
M_STEEL = simple("steel", "#8A9096", 0.28, 1.0)
M_SCLERA = simple("sclera", "#F4F7F2", 0.08, 0.0, emit="#F4F7F2", strength=0.15, coat=1.0)
M_PUPIL = simple("pupil", "#07090B", 0.05, 0.0, coat=1.0)
M_SCAN = simple("scanner", "#A3E635", 0.2, 0.0, emit="#A3E635", strength=9.0)
M_GLINT = simple("glint", "#FFFFFF", 0.1, 0.0, emit="#FFFFFF", strength=12.0)
M_TIP = simple("tip", "#C6F36B", 0.2, 0.0, emit="#BEF264", strength=14.0)
M_CABLE_G = simple("cable_forest", "#164E27", 0.45, 0.1, coat=0.6)
M_CABLE_L = simple("cable_lime", "#A3E635", 0.35, 0.0, emit="#A3E635", strength=1.2, coat=0.6)
M_CABLE_C = simple("cable_cyan", "#22D3EE", 0.35, 0.0, emit="#22D3EE", strength=1.6, coat=0.6)
M_SOLE = simple("sole", "#F1F5F9", 0.5, 0.0)


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def mesh_obj(name, bm, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = link(bpy.data.objects.new(name, me))
    ob.data.materials.append(mat)
    return ob


def add_mod(ob, kind, **kw):
    md = ob.modifiers.new(kind.lower(), kind)
    for k, v in kw.items():
        setattr(md, k, v)
    return md


# ---------------------------------------------------------------- geometry
R_CORE, R_HOOD = 1.0, 1.2
FACE = Vector((-0.12, -1.0, -0.22)).normalized()


def in_opening(d):
    fringe = 0.40 - 0.42 * d.x          # fringe sweeps down to her right (viewer's right)
    return d.dot(FACE) > 0.50 and d.z < fringe


def lower_edge(phi):
    # petal tips along the lower rim of the hood
    return -0.12 - 0.32 * abs(math.cos(3 * phi + 0.4)) ** 4


SEAMS = [i * 2 * math.pi / 7 + 0.3 for i in range(7)]


def near_seam(d):
    theta = math.acos(max(-1, min(1, d.z)))
    if theta < 0.42:
        return False
    phi = math.atan2(d.y, d.x)
    for s in SEAMS:
        sp = s + 0.55 * (theta - 0.42)   # gentle spiral, petals overlap like leaves
        dd = (phi - sp + math.pi) % (2 * math.pi) - math.pi
        if abs(dd) * math.sin(theta) < 0.022:
            return True
    return False


def keep_face(d):
    phi = math.atan2(d.y, d.x)
    if d.z < lower_edge(phi):
        return False
    if in_opening(d):
        return False
    return not near_seam(d)


def shell(name, radius, mat, thickness, seams=True, smooth_iters=25):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=320, v_segments=160, radius=radius)
    kill = []
    for f in bm.faces:
        d = f.calc_center_median().normalized()
        ok = keep_face(d) if seams else (d.z >= lower_edge(math.atan2(d.y, d.x)) and not in_opening(d))
        if not ok:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    # remove tiny islands (slivers left between seams)
    seen, small = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, comp = [f], []
        seen.add(f)
        while stack:
            g = stack.pop(); comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h); stack.append(h)
        if len(comp) < 400:
            small.extend(comp)
    bmesh.ops.delete(bm, geom=small, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # smooth the staircase boundary, keep it on the sphere
    for _ in range(smooth_iters):
        bverts = [v for v in bm.verts if v.is_boundary]
        newp = {}
        for v in bverts:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                newp[v] = ((nb[0].co + nb[1].co) * 0.5 + v.co) / 2
        for v, p in newp.items():
            v.co = p.normalized() * radius
    ob = mesh_obj(name, bm, mat)
    if thickness:
        add_mod(ob, "SOLIDIFY", thickness=thickness, offset=-1.0, use_even_offset=False, use_rim=True)
        add_mod(ob, "BEVEL", width=0.008, segments=2, limit_method="ANGLE")
    add_mod(ob, "SUBSURF", levels=1, render_levels=1)
    return ob


def uv_sphere(name, r, mat, loc=(0, 0, 0), scale=(1, 1, 1), seg=64):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=r)
    ob = mesh_obj(name, bm, mat)
    ob.location = loc
    ob.scale = scale
    return ob


def orient_to(ob, direction, up=Vector((0, 0, 1))):
    z = direction.normalized()
    x = up.cross(z).normalized()
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    y = z.cross(x)
    ob.rotation_euler = Matrix((x, y, z)).transposed().to_euler()


def torus(name, R, r, mat, loc, direction, maj=64, mino=16):
    bm = bmesh.new()
    me = bpy.data.meshes.new(name)
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=maj, minor_segments=mino)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    ob.location = loc
    orient_to(ob, direction)
    bm.free()
    return ob


def cylinder(name, r, depth, mat, loc, direction, verts=6, bevel=0.004):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth)
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(mat)
    ob.location = loc
    orient_to(ob, direction)
    if bevel:
        add_mod(ob, "BEVEL", width=bevel, segments=2)
    return ob


def catmull(points, n):
    pts = [points[0]] + points + [points[-1]]
    out = []
    segs = len(points) - 1
    for i in range(n):
        t = i / (n - 1) * segs
        k = min(int(t), segs - 1)
        u = t - k
        p0, p1, p2, p3 = pts[k], pts[k + 1], pts[k + 2], pts[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u))
    return out


def tube(name, points, radius, mat, taper_end=1.0, res=120, ring=16):
    path = catmull([Vector(p) for p in points], res)
    bm = bmesh.new()
    rings = []
    prev_n = None
    for i, p in enumerate(path):
        t = path[min(i + 1, res - 1)] - path[max(i - 1, 0)]
        t.normalize()
        if prev_n is None:
            ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            prev_n = t.cross(ref).normalized()
        n = (prev_n - t * prev_n.dot(t)).normalized()
        prev_n = n
        bnorm = t.cross(n)
        rr = radius * (1 - (1 - taper_end) * i / (res - 1))
        rings.append([bm.verts.new(p + (n * math.cos(a) + bnorm * math.sin(a)) * rr)
                      for a in [2 * math.pi * j / ring for j in range(ring)]])
    for a, b in zip(rings, rings[1:]):
        for j in range(ring):
            bm.faces.new((a[j], a[(j + 1) % ring], b[(j + 1) % ring], b[j]))
    bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    return mesh_obj(name, bm, mat), path


def blade(name, points, width_fn, mat, seg_count=7, gap=0.012, nu=26, nv=10, cup=0.07, thick=0.06):
    """Articulated leaf lock: plates laid along a spline, tangent to the head."""
    path = catmull([Vector(p) for p in points], 400)
    objs = []
    for s in range(seg_count):
        t0 = s / seg_count + (gap if s else 0)
        t1 = (s + 1) / seg_count
        bm = bmesh.new()
        grid = []
        for i in range(nu + 1):
            t = t0 + (t1 - t0) * i / nu
            k = min(int(t * 399), 398)
            p = path[k]
            tan = (path[k + 1] - path[k]).normalized()
            radial = (p - Vector((0, 0, min(max(p.z, -0.6), 0.6) * 0.3))).normalized()
            wdir = radial.cross(tan).normalized()
            nrm = tan.cross(wdir).normalized()
            if nrm.dot(radial) < 0:
                nrm = -nrm
            w = width_fn(t)
            row = []
            for j in range(nv + 1):
                sx = -1 + 2 * j / nv
                row.append(bm.verts.new(p + wdir * sx * w + nrm * cup * (1 - sx * sx) * (w / 0.35)))
            grid.append(row)
        for i in range(nu):
            for j in range(nv):
                bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]))
        ob = mesh_obj(f"{name}_{s}", bm, mat)
        add_mod(ob, "SOLIDIFY", thickness=thick, offset=-1.0, use_rim=True)
        add_mod(ob, "BEVEL", width=0.01, segments=2, limit_method="ANGLE")
        add_mod(ob, "SUBSURF", levels=1, render_levels=2)
        objs.append(ob)
    return objs, path


# ---------------------------------------------------------------- build Gina head
core = uv_sphere("core", R_CORE, M_CORE, seg=128)
add_mod(core, "SUBSURF", levels=1, render_levels=1)
# equator seam band on the titanium core
torus("core_seam", math.sqrt(1 - 0.42 ** 2) - 0.004, 0.012, M_CORE_DARK, (0, 0, -0.42), Vector((0, 0, 1)))

hood = shell("hood", R_HOOD, M_HOOD, 0.085)
circ = shell("circuit_layer", R_HOOD - 0.09, M_CIRC, 0.0, seams=False, smooth_iters=25)

# eyes: optical housings with sclera, pupil, scanner ring and glints
eye_dirs = [Vector((-0.40, -1.0, -0.10)).normalized(), Vector((0.10, -1.0, -0.12)).normalized()]
for k, d in enumerate(eye_dirs):
    base = d * (R_CORE - 0.02)
    sc = uv_sphere(f"sclera_{k}", 1, M_SCLERA, loc=base, scale=(0.205, 0.255, 0.10))
    orient_to(sc, d)
    sc.rotation_euler.rotate_axis("Z", math.radians(-8 if k == 0 else 8))
    torus(f"housing_{k}", 0.245, 0.03, M_STEEL, d * (R_CORE + 0.005), d, maj=48)
    look = (d + Vector((0.12, 0, 0.05))).normalized()   # glance toward her left, like the reference
    pu = uv_sphere(f"pupil_{k}", 1, M_PUPIL, loc=look * (R_CORE + 0.075), scale=(0.11, 0.135, 0.03))
    orient_to(pu, d)
    torus(f"scan_{k}", 0.1, 0.009, M_SCAN, look * (R_CORE + 0.095), d, maj=48, mino=8)
    gl = uv_sphere(f"glint_{k}", 0.028, M_GLINT, loc=(look + Vector((0.035, 0, 0.06))).normalized() * (R_CORE + 0.11))
    for b in range(5):  # housing bolts
        a = 2 * math.pi * b / 5 + 0.3
        xd = Vector((0, 0, 1)).cross(d).normalized()
        yd = d.cross(xd)
        pos = d * (R_CORE + 0.02) + (xd * math.cos(a) + yd * math.sin(a)) * 0.245
        cylinder(f"eyebolt_{k}_{b}", 0.016, 0.03, M_STEEL, pos, d)

# sprout antenna: curled tendril of ringed segments with a glowing bud
sprout_pts = [(0.0, 0.05, 1.10), (0.0, 0.0, 1.35), (0.08, -0.02, 1.55), (0.32, -0.04, 1.66),
              (0.50, -0.05, 1.56), (0.50, -0.06, 1.38), (0.34, -0.07, 1.32), (0.24, -0.07, 1.43),
              (0.31, -0.07, 1.52)]
sprout, spath = tube("sprout", sprout_pts, 0.085, M_LOCK, taper_end=0.35, res=160, ring=20)
for i in range(8, 150, 14):
    p = spath[i]; t = (spath[i + 1] - spath[i - 1]).normalized()
    rr = 0.085 * (1 - 0.65 * i / 159) + 0.012
    torus(f"sprout_ring_{i}", rr, 0.011, M_STEEL, p, t, maj=32, mino=8)
uv_sphere("sprout_bud", 0.045, M_TIP, loc=spath[-1])
uv_sphere("sprout_socket", 0.16, M_CORE_DARK, loc=(0, 0.03, 1.12), scale=(1, 1, 0.5))

# the long lock on her right (viewer's right), articulated plates
lock_pts = [(-0.10, -0.80, 0.98), (0.45, -0.98, 0.62), (0.90, -0.80, 0.05), (1.10, -0.55, -0.62),
            (0.98, -0.48, -1.22), (0.70, -0.55, -1.62)]
def lock_w(t):
    return 0.30 * math.sin(math.pi * min(1.0, 0.18 + t * 0.95)) ** 0.8 + 0.02
lock, lpath = blade("lock", lock_pts, lock_w, M_LOCK, seg_count=7)

# bolts along the seams of the hood plates
for s in SEAMS:
    for theta in (0.75, 1.15, 1.55):
        for side in (-1, 1):
            sp = s + 0.55 * (theta - 0.42) + side * 0.075 / math.sin(theta)
            d = Vector((math.sin(theta) * math.cos(sp), math.sin(theta) * math.sin(sp), math.cos(theta)))
            if keep_face(d) and keep_face((d * 1.0 + Vector((0, 0, -0.05))).normalized()):
                cylinder("bolt", 0.018, 0.04, M_STEEL, d * (R_HOOD + 0.005), d)

# ---------------------------------------------------------------- body (full figure only)
def limb(name, pts, r, joints=()):
    ob, path = tube(name, pts, r, M_CORE, res=60, ring=14)
    for j in joints:
        uv_sphere(f"{name}_joint", r * 1.6, M_CORE_DARK, loc=path[j], seg=24)
    return path


if MODE == "full":
    # legs to lime sneakers
    for side, sx in (("L", -0.38), ("R", 0.38)):
        lp = limb(f"leg_{side}", [(sx * 0.8, 0.05, -0.85), (sx, 0.0, -1.55), (sx * 1.05, -0.02, -2.25)], 0.06,
                  joints=(30,))
        foot = uv_sphere(f"shoe_{side}", 1, M_LOCK, loc=(sx * 1.08, -0.16, -2.33), scale=(0.21, 0.36, 0.16))
        uv_sphere(f"sole_{side}", 1, M_SOLE, loc=(sx * 1.08, -0.17, -2.43), scale=(0.23, 0.38, 0.07))
        uv_sphere(f"toe_{side}", 1, M_SOLE, loc=(sx * 1.08, -0.42, -2.36), scale=(0.15, 0.1, 0.09))
        torus(f"ankle_{side}", 0.085, 0.022, M_STEEL, (sx * 1.05, -0.02, -2.18), Vector((0, 0, 1)))
    # left arm relaxed, right arm raised with an open palm: the gate says stop
    rp = limb("arm_R", [(-0.95, -0.15, -0.30), (-1.45, -0.35, -0.15), (-1.62, -0.55, 0.45)], 0.055, joints=(30,))
    ap = limb("arm_L", [(0.95, -0.05, -0.35), (1.35, -0.1, -0.75), (1.55, -0.2, -1.15)], 0.055, joints=(30,))

    def hand(base, up, toward, name):
        palm = uv_sphere(f"palm_{name}", 1, M_CORE, loc=base, scale=(0.13, 0.15, 0.05))
        orient_to(palm, toward, up)
        x = up.cross(toward).normalized()
        for i, off in enumerate((-0.09, -0.03, 0.03, 0.09)):
            fp = [base + x * off + up * 0.10, base + x * off * 1.25 + up * (0.24 - abs(off) * 0.4)]
            tube(f"finger_{name}_{i}", fp, 0.028, M_CORE, res=8, ring=10)
            uv_sphere(f"fingertip_{name}_{i}", 0.03, M_CORE_DARK, loc=fp[1], seg=16)
        tube(f"thumb_{name}", [base - x * 0.11 * (1 if name == 'R' else -1), base - x * 0.22 * (1 if name == 'R' else -1) + up * 0.06],
             0.03, M_CORE, res=8, ring=10)
    hand(rp[-1] + Vector((0.0, -0.04, 0.10)), Vector((0, 0, 1)), Vector((0, -1, 0)), "L")
    hand(ap[-1] + Vector((0, -0.02, -0.08)), Vector((0, 0, -1)), Vector((1, 0, 0)), "R")

    # fibre-optic cables from the back of the shell to the floor
    cable_specs = [
        (M_CABLE_G, [(-0.5, 0.75, -0.55), (-1.0, 1.1, -1.4), (-1.3, 1.2, -2.15), (-1.3, 1.2, -2.42)], 0.05),
        (M_CABLE_L, [(-0.25, 0.9, -0.45), (-0.5, 1.4, -1.5), (-0.6, 1.65, -2.15), (-0.6, 1.65, -2.42)], 0.035),
        (M_CABLE_C, [(0.3, 0.88, -0.5), (0.45, 1.45, -1.5), (0.5, 1.7, -2.15), (0.5, 1.7, -2.42)], 0.04),
        (M_CABLE_G, [(0.6, 0.7, -0.6), (1.05, 1.0, -1.4), (1.25, 1.25, -2.15), (1.25, 1.25, -2.42)], 0.055),
        (M_CABLE_L, [(0.05, 0.95, -0.6), (0.0, 1.6, -1.6), (-0.05, 1.85, -2.15), (-0.05, 1.85, -2.42)], 0.03),
    ]
    for i, (m, pts, r) in enumerate(cable_specs):
        tube(f"cable_{i}", pts, r, m, res=90, ring=14)
        cylinder(f"cable_plug_{i}", r * 1.7, 0.12, M_STEEL, Vector(pts[0]),
                 (Vector(pts[1]) - Vector(pts[0])).normalized(), verts=12)
        cylinder(f"floor_socket_{i}", r * 2.2, 0.14, M_STEEL, Vector(pts[-1]), Vector((0, 0, 1)), verts=16)
    # platform: dark disc with a lime gate ring
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=2.0, depth=0.12, location=(0, 0.2, -2.56))
    plat = bpy.context.active_object; plat.data.materials.append(simple("platform", "#151B2B", 0.3, 0.6))
    add_mod(plat, "BEVEL", width=0.02, segments=3)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 4, -2.62))
    bpy.context.active_object.data.materials.append(simple("floor", "#0B1120", 0.85, 0.0))
    torus("gate_ring", 1.9, 0.018, M_SCAN, (0, 0.2, -2.49), Vector((0, 0, 1)), maj=160, mino=8)

# ---------------------------------------------------------------- world, lights, camera
world = bpy.data.worlds.new("w"); scene.world = world; world.use_nodes = True
bgn = world.node_tree.nodes["Background"]
bgn.inputs["Color"].default_value = hex_rgb("#0F172A"); bgn.inputs["Strength"].default_value = 0.35

# backdrop: curved sweep so the render integrates with the showcase (#0F172A)
bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 9, 0), rotation=(math.radians(90), 0, 0))
bd = bpy.context.active_object
bd.data.materials.append(simple("backdrop", "#0F172A", 0.9, 0.0))


def area(name, loc, target, energy, size, color="#FFFFFF"):
    ld = bpy.data.lights.new(name, "AREA"); ld.energy = energy; ld.size = size
    ld.color = hex_rgb(color)[:3]
    ob = link(bpy.data.objects.new(name, ld)); ob.location = loc
    orient_to(ob, (Vector(loc) - Vector(target)))
    return ob


tgt = (0.15, 0, 0.2) if MODE == "head" else (0.1, 0, -0.55)
area("key", (-4.5, -5.5, 4.5), tgt, 1400, 3.5, "#FFF6EA")
area("fill", (5, -4, 0.5), tgt, 260, 4.0, "#CFE3FF")
area("rim_lime", (3.5, 4.0, 3.0), tgt, 900, 1.2, "#B8F05A")
area("rim_cyan", (-3.8, 3.5, 1.5), tgt, 700, 1.2, "#67E8F9")
area("top", (0, 0.5, 6), tgt, 300, 2.0)

cam_d = bpy.data.cameras.new("cam")
cam = link(bpy.data.objects.new("cam", cam_d)); scene.camera = cam
if MODE == "head":
    cam_d.lens = 85
    cam.location = (0.9, -9.6, 1.1)
    scene.render.resolution_x = scene.render.resolution_y = 1400
else:
    cam_d.lens = 70
    cam.location = (1.4, -12.5, 0.6)
    scene.render.resolution_x, scene.render.resolution_y = 1600, 2000
orient_to(cam, cam.location - Vector(tgt))
cam_d.dof.use_dof = False

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("rendered", OUT)
