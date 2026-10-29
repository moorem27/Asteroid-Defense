"""
============================================================
ASTEROID DEFENSE: CLASSIC FLYING SAUCER GENERATOR

An original, classic disc-shaped UFO: a polished silver lens-shaped
hull with raised panel rings and radial seams, a tinted glass dome
with a beacon on top, a chasing ring of rim lights, six high-voltage
"Tesla" nodes on the upper hull (where the game's lightning arcs
start), and a glowing field-emitter ring underneath.

There are no exhausts, nozzles or vents anywhere: it flies on high
voltage, not rockets.

Run (either works):
  blender --background --python blender/generate_ufo.py
  python3 blender/generate_ufo.py        (no Blender needed)

With Blender, Blender's own glTF exporter is used. Without it, a small
built-in exporter writes the same model, so the file can be made on
any computer with Python 3.

Output:
  public/assets/ufo.glb   (found next to this script or one folder up;
                           otherwise ../assets like the other scripts)

FIT WITH THE GAME
  - Diameter 3.3 units (the starfighter's wingspan is about 2.6 once
    scaled), centered on the origin, symmetric around the vertical
    axis. game.js spins it slowly, so the rim lights chase.
  - The six Tesla node tips sit at radius NODE_RADIUS, height
    NODE_TIP_Z, at angles 0, 60, ... 300 degrees. game.js draws its
    lightning from these points (UFO_ARC_NODES in game.js); keep the
    two in step if you move them.
  - The game's shield (a glowing patch that appears where a shot
    lands) is drawn by a shader in game.js, around this model.

COORDINATES
  X = right, Y = backward (forward is -Y), Z = up (toward the
  top-down camera), like the other generated assets.

The geometry is plain Python (no bpy) and only turned into Blender
objects (or written to a GLB directly) at the end.
============================================================
"""

import json
import math
import os
import struct

try:
    import bpy
except ImportError:
    bpy = None


# ------------------------------------------------------------
# MATERIALS
# (name, base color, metallic, roughness, emission strength)
# ------------------------------------------------------------

MATERIALS = {
    "hull": ((0.66, 0.69, 0.74), 0.85, 0.28, 0.06),
    "hull_panel": ((0.5, 0.53, 0.58), 0.8, 0.35, 0.04),
    "seam": ((0.2, 0.22, 0.26), 0.7, 0.45, 0.0),
    "rim": ((0.3, 0.32, 0.36), 0.9, 0.3, 0.0),
    "dome": ((0.12, 0.3, 0.42), 0.1, 0.05, 0.5),
    "dome_collar": ((0.42, 0.45, 0.5), 0.9, 0.25, 0.0),
    "light_cyan": ((0.35, 1.0, 1.0), 0.0, 0.3, 6.0),
    "light_white": ((1.0, 1.0, 1.0), 0.0, 0.3, 5.0),
    "beacon": ((0.85, 0.6, 1.0), 0.0, 0.3, 7.0),
    "node_base": ((0.16, 0.17, 0.2), 0.9, 0.35, 0.0),
    "node_coil": ((0.62, 0.42, 0.18), 1.0, 0.3, 0.0),
    "node_tip": ((0.55, 0.8, 1.0), 0.0, 0.2, 7.0),
    "emitter": ((0.35, 0.65, 1.0), 0.0, 0.3, 4.5),
}

# Where the lightning starts (used by game.js; see FIT WITH THE GAME).
NODE_COUNT = 6
NODE_RADIUS = 1.12
NODE_TIP_Z = 0.36

SEGMENTS = 64


# ------------------------------------------------------------
# PURE-PYTHON GEOMETRY
# Each part is (name, vertices, faces, material, smooth).
# ------------------------------------------------------------

def lathe(name, profile, material, segments=SEGMENTS, smooth=True):
    """
    Spin a profile [(radius, z), ...] around the Z axis. A point with
    radius 0 becomes a single pole vertex.
    """

    vertices = []
    rings = []

    for r, z in profile:
        if r <= 1e-9:
            rings.append([len(vertices)])
            vertices.append((0.0, 0.0, z))
            continue

        ring = []

        for k in range(segments):
            angle = math.tau * k / segments
            ring.append(len(vertices))
            vertices.append((math.cos(angle) * r, math.sin(angle) * r, z))

        rings.append(ring)

    faces = []

    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue

        if len(a) == 1:
            for k in range(segments):
                faces.append((a[0], b[(k + 1) % segments], b[k]))
        elif len(b) == 1:
            for k in range(segments):
                faces.append((a[k], a[(k + 1) % segments], b[0]))
        else:
            for k in range(segments):
                k2 = (k + 1) % segments
                faces.append((a[k], a[k2], b[k2], b[k]))

    return (name, vertices, faces, material, smooth)


def box(name, center, size, material, yaw=0.0):
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    c, s = math.cos(yaw), math.sin(yaw)

    vertices = []

    for dz in (-hz, hz):
        for dy in (-hy, hy):
            for dx in (-hx, hx):
                rx = dx * c - dy * s
                ry = dx * s + dy * c
                vertices.append((cx + rx, cy + ry, cz + dz))

    faces = [
        (0, 2, 3, 1), (4, 5, 7, 6),
        (0, 1, 5, 4), (2, 6, 7, 3),
        (0, 4, 6, 2), (1, 3, 7, 5),
    ]

    return (name, vertices, faces, material, False)


def sphere(name, center, radius, material, rings=8, segments=14, squash=1.0):
    """A UV sphere (squash < 1 flattens it vertically)."""

    cx, cy, cz = center
    profile = []

    for i in range(rings + 1):
        phi = math.pi * i / rings
        profile.append((math.sin(phi) * radius, math.cos(phi) * radius * squash))

    name_, vertices, faces, material_, smooth = lathe(name, profile, material, segments)

    vertices = [(x + cx, y + cy, z + cz) for x, y, z in vertices]

    return (name_, vertices, faces, material_, True)


def cylinder_z(name, center, radius, z0, z1, material, segments=12, radius_top=None):
    """A closed cylinder (or cone) along Z."""

    cx, cy = center
    rt = radius if radius_top is None else radius_top

    profile = [(0.0, z0), (radius, z0), (rt, z1), (0.0, z1)]
    name_, vertices, faces, material_, _ = lathe(name, profile, material, segments, smooth=False)

    vertices = [(x + cx, y + cy, z) for x, y, z in vertices]

    return (name_, vertices, faces, material_, False)


def surface_strip(name, angle, r0, r1, width, height_at, lift, material, steps=10):
    """
    A thin raised strip lying on the hull along a radius (a panel
    seam), following the hull's curve.
    """

    c, s = math.cos(angle), math.sin(angle)
    px, py = -s * width / 2, c * width / 2

    vertices = []

    for i in range(steps + 1):
        r = r0 + (r1 - r0) * i / steps
        z = height_at(r) + lift
        x, y = c * r, s * r

        vertices.append((x - px, y - py, z))
        vertices.append((x + px, y + py, z))
        vertices.append((x - px, y - py, z - lift * 1.5))
        vertices.append((x + px, y + py, z - lift * 1.5))

    faces = []

    for i in range(steps):
        a = i * 4
        b = a + 4
        faces.append((a, a + 1, b + 1, b))          # top
        faces.append((a + 2, b + 2, b + 3, a + 3))  # bottom
        faces.append((a, b, b + 2, a + 2))          # side
        faces.append((a + 1, a + 3, b + 3, b + 1))  # side

    return (name, vertices, faces, material, False)


# The upper hull's surface height at radius r (matches HULL_PROFILE).
HULL_PROFILE = [
    (0.0, -0.24),
    (0.42, -0.235),
    (0.78, -0.21),
    (1.12, -0.16),
    (1.42, -0.09),
    (1.6, -0.035),
    (1.65, 0.0),
    (1.6, 0.04),
    (1.42, 0.11),
    (1.12, 0.21),
    (0.85, 0.29),
    (0.62, 0.33),
    (0.0, 0.335),
]


def upper_height(r):
    top = [(r_, z) for r_, z in HULL_PROFILE[6:]]
    top.sort()

    if r <= top[0][0]:
        return top[0][1]

    for (ra, za), (rb, zb) in zip(top, top[1:]):
        if ra <= r <= rb:
            t = (r - ra) / (rb - ra) if rb > ra else 0
            return za + (zb - za) * t

    return top[-1][1]


# ------------------------------------------------------------
# THE SAUCER
# ------------------------------------------------------------

def build_ufo():
    parts = []

    # ---- Hull: one smooth, lens-shaped body ------------------------
    parts.append(lathe("Hull", HULL_PROFILE, "hull"))

    # ---- Raised panel rings on the upper hull ------------------------
    for r_in, r_out, mat in ((0.9, 0.98, "hull_panel"), (1.3, 1.36, "hull_panel")):
        z_in = upper_height(r_in) + 0.012
        z_out = upper_height(r_out) + 0.012

        parts.append(
            lathe(
                f"Panel Ring {r_in}",
                [(r_in, z_in - 0.02), (r_in, z_in), (r_out, z_out), (r_out, z_out - 0.02)],
                mat,
                smooth=False,
            )
        )

    # ---- Radial seams --------------------------------------------------
    for k in range(12):
        angle = math.tau * (k + 0.5) / 12
        parts.append(
            surface_strip(f"Seam {k:02d}", angle, 0.66, 1.56, 0.022, upper_height, 0.006, "seam")
        )

    # ---- Rim band and chasing lights -----------------------------------
    parts.append(
        lathe(
            "Rim Band",
            [(1.6, -0.045), (1.68, -0.03), (1.69, 0.0), (1.68, 0.03), (1.6, 0.045)],
            "rim",
            smooth=True,
        )
    )

    for k in range(18):
        angle = math.tau * k / 18
        material = "light_cyan" if k % 2 == 0 else "light_white"
        parts.append(
            sphere(
                f"Rim Light {k:02d}",
                (math.cos(angle) * 1.69, math.sin(angle) * 1.69, 0.0),
                0.045,
                material,
                rings=5,
                segments=8,
            )
        )

    # ---- Dome --------------------------------------------------------
    dome_profile = []

    for i in range(10):
        phi = (math.pi / 2) * i / 9
        dome_profile.append((math.cos(phi) * 0.6, 0.33 + math.sin(phi) * 0.4))

    dome_profile[-1] = (0.0, 0.73)
    parts.append(lathe("Dome", [(0.0, 0.33)] + dome_profile, "dome"))

    parts.append(
        lathe(
            "Dome Collar",
            [(0.56, 0.31), (0.68, 0.32), (0.69, 0.36), (0.6, 0.38), (0.56, 0.36)],
            "dome_collar",
        )
    )

    # Beacon on top of the dome.
    parts.append(sphere("Beacon", (0.0, 0.0, 0.76), 0.06, "beacon", rings=6, segments=10))

    # ---- High-voltage Tesla nodes --------------------------------------
    for k in range(NODE_COUNT):
        angle = math.tau * k / NODE_COUNT
        x, y = math.cos(angle) * NODE_RADIUS, math.sin(angle) * NODE_RADIUS
        base_z = upper_height(NODE_RADIUS)

        parts.append(cylinder_z(f"Node Base {k}", (x, y), 0.07, base_z - 0.02, base_z + 0.05, "node_base", 10, 0.05))

        # A copper coil: stacked rings.
        for j in range(3):
            z = base_z + 0.07 + j * 0.05
            parts.append(cylinder_z(f"Node Coil {k}.{j}", (x, y), 0.045, z, z + 0.03, "node_coil", 10))

        parts.append(cylinder_z(f"Node Mast {k}", (x, y), 0.018, base_z + 0.05, NODE_TIP_Z - 0.03, "node_base", 6))
        parts.append(sphere(f"Node Tip {k}", (x, y, NODE_TIP_Z), 0.05, "node_tip", rings=6, segments=10))

    # ---- Field emitter ring underneath ---------------------------------
    parts.append(
        lathe(
            "Emitter Ring",
            [(0.52, -0.236), (0.58, -0.255), (0.86, -0.25), (0.92, -0.225)],
            "emitter",
            smooth=False,
        )
    )

    parts.append(sphere("Emitter Core", (0.0, 0.0, -0.25), 0.16, "emitter", rings=6, segments=12, squash=0.4))

    return parts


# ------------------------------------------------------------
# OUTPUT FOLDER
# ------------------------------------------------------------

def output_path():
    """
    The game's assets folder: public/assets next to this script or one
    folder up (the repo layout), otherwise ../assets like the other
    generator scripts.
    """

    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(script_dir)

    for base in (script_dir, parent):
        if os.path.isdir(os.path.join(base, "public")):
            folder = os.path.join(base, "public", "assets")
            break
    else:
        folder = os.path.join(parent, "assets")

    os.makedirs(folder, exist_ok=True)

    return os.path.join(folder, "ufo.glb")


# ------------------------------------------------------------
# BUILT-IN GLB EXPORT (no Blender needed)
# Writes glTF 2.0 binary: one mesh with one primitive per material,
# Blender's Z-up converted to glTF's Y-up the same way Blender's
# exporter does (x, y, z) -> (x, z, -y). Emission above 1 uses
# KHR_materials_emissive_strength, which three.js supports.
# ------------------------------------------------------------

def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(v):
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1.0
    return (v[0] / length, v[1] / length, v[2] / length)


def _triangles(part):
    """Triangles with outward normals: (p0, p1, p2, n0, n1, n2)."""

    name, vertices, faces, material, smooth = part

    centroid = tuple(sum(v[i] for v in vertices) / len(vertices) for i in range(3))

    # Fan-triangulate, and turn each face to point away from the part's
    # center (all parts here are convex or nearly so).
    tris = []

    for face in faces:
        for i in range(1, len(face) - 1):
            a, b, c = face[0], face[i], face[i + 1]
            pa, pb, pc = vertices[a], vertices[b], vertices[c]

            n = _cross(_sub(pb, pa), _sub(pc, pa))
            center = tuple((pa[j] + pb[j] + pc[j]) / 3 for j in range(3))
            out = _sub(center, centroid)

            if n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0:
                b, c = c, b

            tris.append((a, b, c))

    face_normals = []

    for a, b, c in tris:
        pa, pb, pc = vertices[a], vertices[b], vertices[c]
        face_normals.append(_cross(_sub(pb, pa), _sub(pc, pa)))

    if smooth:
        # Area-weighted vertex normals; vertices at the same position
        # share them, so seams in the lathe stay smooth.
        key = lambda p: (round(p[0], 5), round(p[1], 5), round(p[2], 5))
        sums = {}

        for (a, b, c), n in zip(tris, face_normals):
            for v in (a, b, c):
                k = key(vertices[v])
                s = sums.get(k, (0.0, 0.0, 0.0))
                sums[k] = (s[0] + n[0], s[1] + n[1], s[2] + n[2])

        out = []

        for a, b, c in tris:
            out.append((
                vertices[a], vertices[b], vertices[c],
                _norm(sums[key(vertices[a])]),
                _norm(sums[key(vertices[b])]),
                _norm(sums[key(vertices[c])]),
            ))

        return out

    return [
        (vertices[a], vertices[b], vertices[c], _norm(n), _norm(n), _norm(n))
        for (a, b, c), n in zip(tris, face_normals)
    ]


def _to_gltf(p):
    return (p[0], p[2], -p[1])


def write_glb(parts, path):
    by_material = {}

    for part in parts:
        by_material.setdefault(part[3], []).extend(_triangles(part))

    binary = bytearray()
    buffer_views = []
    accessors = []
    primitives = []
    materials = []

    def add_view(data, target):
        while len(binary) % 4:
            binary.append(0)

        offset = len(binary)
        binary.extend(data)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})

        return len(buffer_views) - 1

    for index, (key, tris) in enumerate(sorted(by_material.items())):
        # Shared vertices (same position and normal) are stored once.
        positions = []
        normals = []
        indices = []
        seen = {}

        for p0, p1, p2, n0, n1, n2 in tris:
            for p, n in ((p0, n0), (p1, n1), (p2, n2)):
                gp = _to_gltf(p)
                gn = _to_gltf(n)
                k = tuple(round(v, 5) for v in gp + gn)

                if k not in seen:
                    seen[k] = len(positions)
                    positions.append(gp)
                    normals.append(gn)

                indices.append(seen[k])

        pos_bytes = b"".join(struct.pack("<3f", *p) for p in positions)
        nor_bytes = b"".join(struct.pack("<3f", *n) for n in normals)
        idx_bytes = struct.pack(f"<{len(indices)}H", *indices)

        mins = [min(p[i] for p in positions) for i in range(3)]
        maxs = [max(p[i] for p in positions) for i in range(3)]

        pos_view = add_view(pos_bytes, 34962)
        accessors.append({
            "bufferView": pos_view, "componentType": 5126, "count": len(positions),
            "type": "VEC3", "min": mins, "max": maxs,
        })
        pos_accessor = len(accessors) - 1

        nor_view = add_view(nor_bytes, 34962)
        accessors.append({"bufferView": nor_view, "componentType": 5126, "count": len(normals), "type": "VEC3"})
        nor_accessor = len(accessors) - 1

        idx_view = add_view(idx_bytes, 34963)
        accessors.append({"bufferView": idx_view, "componentType": 5123, "count": len(indices), "type": "SCALAR"})
        idx_accessor = len(accessors) - 1

        color, metallic, roughness, emission = MATERIALS[key]

        material = {
            "name": f"UFO | {key}",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [*color, 1.0],
                "metallicFactor": metallic,
                "roughnessFactor": roughness,
            },
        }

        if emission > 0:
            material["emissiveFactor"] = list(color)

            if emission != 1:
                material["extensions"] = {"KHR_materials_emissive_strength": {"emissiveStrength": emission}}

        materials.append(material)

        primitives.append({
            "attributes": {"POSITION": pos_accessor, "NORMAL": nor_accessor},
            "indices": idx_accessor,
            "material": index,
            "mode": 4,
        })

    gltf = {
        "asset": {"version": "2.0", "generator": "Asteroid Defense generate_ufo.py"},
        "extensionsUsed": ["KHR_materials_emissive_strength"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "ufo", "mesh": 0}],
        "meshes": [{"name": "ufo", "primitives": primitives}],
        "materials": materials,
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)

    while len(binary) % 4:
        binary.append(0)

    total = 12 + 8 + len(json_bytes) + 8 + len(binary)

    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(json_bytes), b"JSON"))
        f.write(json_bytes)
        f.write(struct.pack("<I4s", len(binary), b"BIN\x00"))
        f.write(binary)

    triangles = sum(len(t) for t in by_material.values())

    print("\n========================================")
    print(" ASTEROID DEFENSE - FLYING SAUCER")
    print("========================================")
    print(f"Exported: {path}  ({triangles} triangles, {total // 1024} KB)")


# ------------------------------------------------------------
# BLENDER EXPORT
# ------------------------------------------------------------

def blender_main():
    path = output_path()

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for datablocks in (bpy.data.meshes, bpy.data.materials):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)

    materials = {}

    def material_for(key):
        if key in materials:
            return materials[key]

        color, metallic, roughness, emission = MATERIALS[key]

        mat = bpy.data.materials.new(name=f"UFO | {key}")
        mat.diffuse_color = (*color, 1.0)
        mat.use_nodes = True

        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness

        if emission > 0:
            for name in ("Emission Color", "Emission"):
                if name in bsdf.inputs:
                    bsdf.inputs[name].default_value = (*color, 1.0)
                    break

            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = emission

        materials[key] = mat
        return mat

    objects = []

    for name, vertices, faces, material_key, smooth in build_ufo():
        mesh = bpy.data.meshes.new(name + " Mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(material_for(material_key))
        mesh.update()

        for polygon in mesh.polygons:
            polygon.use_smooth = smooth

        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        objects.append(obj)

    bpy.ops.object.select_all(action="DESELECT")

    for obj in objects:
        obj.select_set(True)

    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()

    joined = bpy.context.object
    joined.name = "ufo"

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )

    print("\n========================================")
    print(" ASTEROID DEFENSE - FLYING SAUCER")
    print("========================================")
    print("Exported:", path)


if __name__ == "__main__":
    if bpy is not None:
        blender_main()
    else:
        write_glb(build_ufo(), output_path())
