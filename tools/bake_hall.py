"""Build MB Hall statics in Blender (three.js units), bake lighting-only lightmaps, export GLB.
Blender (X, Y, Z) maps to three (X, Z_up -> y, -Y -> z): we place objects at (X, -Zthree, Ythree).
"""
import bpy, bmesh, math, os, sys, json
import numpy as np

OUT = '/home/claude/render/hall_out'
os.makedirs(OUT, exist_ok=True)
SAMPLES = int(os.environ.get('BAKE_SAMPLES', '96'))
RES_P = int(os.environ.get('BAKE_RES', '1536'))
RES_F = int(os.environ.get('BAKE_RES_F', '1024'))

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
U = lambda v: v / 20.0

ZX, ZY, ZW, ZH = 880, 70, 640, 410
T, HH = 14, 6.2
HX, HY = ZX + ZW / 2, ZY + 150

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

MATS = {}
def mat(name, col, emit=None, strength=0.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*lin(col), 1); b.inputs['Roughness'].default_value = 0.7
    if emit:
        b.inputs['Emission Color'].default_value = (*lin(emit), 1); b.inputs['Emission Strength'].default_value = strength
    MATS[name] = m; return m

def emit_img(name, path, strength):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    o = nt.nodes.new('ShaderNodeOutputMaterial'); t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images.load(path)
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Strength'].default_value = strength
    nt.links.new(t.outputs['Color'], e.inputs['Color']); nt.links.new(e.outputs[0], o.inputs[0]); return m

M_DARK = mat('darkwood', '#3a2619'); M_MID = mat('midwood', '#5c3d29'); M_FLOOR = mat('floor', '#4e3424')
M_POD2 = mat('podium2', '#2a2d33'); M_POD = mat('podium', '#15171b'); M_C1 = mat('cushion', '#3a3e45'); M_C2 = mat('cushion2', '#4a4f57')
M_LANT = mat('lantern_glow', '#ffe0a6', emit='#ffc879', strength=14)
M_RIM = mat('rim_glow', '#ffd27a', emit='#ffc35a', strength=10)
M_LAMP = mat('lamp_glow', '#ffd89a', emit='#ffcf7a', strength=10)
M_CEIL = mat('ceiling', '#2e1d12')

EXPORT, BAKEONLY = [], []

def box(px, py, pw, pd, h, y0, m, export=True, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = (U(pw), U(pd), h); o.location = (U(px + pw / 2), -U(py + pd / 2), y0 + h / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        md = o.modifiers.new('b', 'BEVEL'); md.width = bevel; md.segments = 3
        bpy.ops.object.modifier_apply(modifier=md.name)
    o.data.materials.append(m); (EXPORT if export else BAKEONLY).append(o); return o

def cyl(cx, cy, r, h, y0, m, export=True, verts=48):
    bpy.ops.mesh.primitive_cylinder_add(radius=U(r), depth=h, vertices=verts)
    o = bpy.context.active_object; o.location = (U(cx), -U(cy), y0 + h / 2)
    for p in o.data.polygons: p.use_smooth = True
    o.data.materials.append(m); (EXPORT if export else BAKEONLY).append(o); return o

# ---- floor (own lightmap + tiling UV) ----
bpy.ops.mesh.primitive_plane_add(size=1); fl = bpy.context.active_object
fl.scale = (U(ZW), U(ZH), 1); fl.location = (U(ZX + ZW / 2), -U(ZY + ZH / 2), 0.226)
bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
fl.name = 'hall_floor'; fl.data.materials.append(M_FLOOR)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.subdivide(number_cuts=24); bpy.ops.object.mode_set(mode='OBJECT')

# ---- statics ----
box(ZX, ZY, ZW, T, HH, 0, M_DARK)                                       # north wall
for side in ('w', 'e'):
    x = ZX if side == 'w' else ZX + ZW - T
    box(x, ZY, T, ZH, HH, 0, M_MID)                                     # side wall
    y = ZY
    while y <= ZY + ZH:
        box(x + T - 2 if side == 'w' else x - 6, y, 8, 8, HH, 0, M_DARK); y += 95
    box(x + T - 4 if side == 'w' else x - 4, ZY, 8, ZH, 1.2, 0, M_DARK)  # wainscot
for (x, y, w, d) in [(ZX - 6, ZY - 6, ZW + 12, T + 12), (ZX - 6, ZY - 6, T + 12, ZH + 12), (ZX + ZW - T - 6, ZY - 6, T + 12, ZH + 12)]:
    box(x, y, w, d, 0.45, HH, M_DARK)                                   # top beams
dA, dB, ry = 1200 - 72, 1200 + 72, ZY + ZH - T
box(ZX, ry, dA - ZX, T, 0.9, 0, M_MID); box(dB, ry, ZX + ZW - dB, T, 0.9, 0, M_MID)  # south rail
cyl(HX, HY, 98, 0.22, 0.22, M_POD2, verts=96); cyl(HX, HY, 82, 0.3, 0.44, M_POD, verts=96)
for lx in (HX - 185, HX + 185):
    cyl(lx, HY, 8, 2.3, 0.22, M_DARK, verts=16)
    box(lx - 18, HY - 18, 36, 36, 0.1, 3.35, M_DARK)
    box(lx - 15, HY - 15, 30, 30, 0.85, 2.5, M_LANT, export=False)
    bpy.ops.object.light_add(type='POINT', location=(U(lx), -U(HY + 40), 3.2)); L = bpy.context.active_object
    L.data.energy = 900; L.data.color = lin('#ffcf8a'); L.data.shadow_soft_size = 0.5
for y in (ZY + 275, ZY + 330, ZY + 385):
    for x in (HX - 240, HX - 160, HX - 80, HX + 80, HX + 160, HX + 240):
        box(x - 24, y - 24, 48, 48, 0.14, 0.22, M_C1, bevel=0.05)
        box(x - 19, y - 19, 38, 38, 0.05, 0.335, M_C2, bevel=0.02)
# door posts + lamps (realtime in app; bake-only here so their shadows/light exist)
for x in (dA - 14, dB):
    box(x, ry - 4, 14, T + 8, 2.6, 0, M_DARK, export=False)
    cyl(x + 7, ry + T / 2, 9, 0.5, 2.6, M_LAMP, export=False, verts=16)
# gold rim (emitter)
bpy.ops.mesh.primitive_torus_add(major_radius=U(82), minor_radius=0.06, major_segments=96, minor_segments=8)
r = bpy.context.active_object; r.location = (U(HX), -U(HY), 0.75); r.data.materials.append(M_RIM); BAKEONLY.append(r)
# LED art + lattice windows (emitters)
bpy.ops.mesh.primitive_plane_add(size=1); a = bpy.context.active_object
a.scale = (U(500), U(250), 1); a.rotation_euler = (math.radians(90), 0, 0); a.location = (U(HX), -(U(ZY + T) + 0.03), 3.45)
a.data.materials.append(emit_img('art', '/home/claude/render/art.png', 2.5)); BAKEONLY.append(a)
lat = emit_img('lattice', '/home/claude/render/lattice.png', 2.0)
for side in ('w', 'e'):
    x = ZX if side == 'w' else ZX + ZW - T
    inner = U(x + T) + 0.02 if side == 'w' else U(x) - 0.02
    y = ZY + 40
    while y < ZY + ZH - 60:
        bpy.ops.mesh.primitive_plane_add(size=1); w = bpy.context.active_object
        w.scale = (U(70), 2.9, 1); w.rotation_euler = (math.radians(90), 0, math.radians(90 if side == 'w' else -90))
        w.location = (inner, -U(y + 35), 3.1); w.data.materials.append(lat); BAKEONLY.append(w); y += 95
# ceiling (bake only)
box(ZX - 6, ZY - 6, ZW + 12, ZH + 12, 0.2, HH + 0.45, M_CEIL, export=False)
# spot over podium
bpy.ops.object.light_add(type='AREA', location=(U(HX), -U(HY), 6.3)); A = bpy.context.active_object
A.data.energy = 1500; A.data.size = 3.0; A.data.color = lin('#fff1d6')
# world = daylight through the open south side
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (*lin('#cfe0ee'), 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.6

# ---- join props into one mesh with lightmap UVs ----
bpy.ops.object.select_all(action='DESELECT')
for o in EXPORT: o.select_set(True)
bpy.context.view_layer.objects.active = EXPORT[0]
bpy.ops.object.join(); props = bpy.context.active_object; props.name = 'hall_props'

def add_lm_uv(o, smart=True):
    me = o.data
    if not me.uv_layers: me.uv_layers.new(name='uv')
    else: me.uv_layers[0].name = 'uv'
    lm = me.uv_layers.new(name='lm'); me.uv_layers.active = lm
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    if smart: bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.006, area_weight=1.0)
    else: bpy.ops.uv.reset()
    bpy.ops.object.mode_set(mode='OBJECT')
add_lm_uv(props, True)

# floor: UV0 = planar tiling (6.4 units per tile), lm = 0..1
me = fl.data
if not me.uv_layers: me.uv_layers.new(name='uv')
me.uv_layers[0].name = 'uv'
bm = bmesh.new(); bm.from_mesh(me)
uvl = bm.loops.layers.uv['uv']
xs = [v.co.x for v in bm.verts]; ys = [v.co.y for v in bm.verts]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
lml = bm.loops.layers.uv.new('lm')
for f in bm.faces:
    for l in f.loops:
        l[uvl].uv = (l.vert.co.x / 6.4, -l.vert.co.y / 6.4)
        l[lml].uv = ((l.vert.co.x - x0) / (x1 - x0), (l.vert.co.y - y0) / (y1 - y0))
bm.to_mesh(me); bm.free(); me.uv_layers.active = me.uv_layers['lm']

# ---- bake ----
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = SAMPLES
sc.cycles.max_bounces = 5; sc.cycles.diffuse_bounces = 4
def bake(o, name, res):
    img = bpy.data.images.new(name, res, res, float_buffer=True)
    for slot in o.material_slots:
        nt = slot.material.node_tree
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = img; nt.nodes.active = n
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=12, use_clear=True)
    px = np.empty(res * res * 4, dtype=np.float32); img.pixels.foreach_get(px)
    np.save(os.path.join(OUT, name + '.npy'), px.reshape(res, res, 4))
    for slot in o.material_slots:
        nt = slot.material.node_tree
        for n in list(nt.nodes):
            if n.type == 'TEX_IMAGE' and n.image == img: nt.nodes.remove(n)
    print('baked', name, flush=True)
bake(fl, 'floor_lm', RES_F)
bake(props, 'props_lm', RES_P)

# ---- export ----
for o in list(sc.objects):
    if o not in (fl, props): o.hide_set(False)
bpy.ops.object.select_all(action='DESELECT'); fl.select_set(True); props.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'hall.glb'), export_format='GLB', use_selection=True,
                          export_texcoords=True, export_normals=True, export_materials='EXPORT', export_apply=True)
print('EXPORTED', flush=True)
