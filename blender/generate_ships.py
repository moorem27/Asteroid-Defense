"""
============================================================
ASTEROID DEFENSE: SHIP FLEET + SHIP EXPLOSION GENERATOR

Four pilotable ships, each in three states, plus the pieces of the
big explosion played when a ship is destroyed.

  STARFIGHTER  the original weathered white interceptor (its intact
               model stays starfighter.glb from generate_starfighter.py;
               this script adds its damaged versions)
  VIPER        crimson and black arrowhead with gold trim and twin fins
  WRAITH       teal-lit gunmetal stealth wing
  HORNET       yellow and black heavy fighter with big side pods

  Each ship:  <name>.glb            intact (hull bar green)
              <name>_damaged.glb    scorched, a clipped fin or wingtip,
                                    a few hot embers (hull bar yellow)
              <name>_critical.glb   heavily burned, a wing torn open
                                    with glowing edges and exposed
                                    spars, a dead engine, a cracked
                                    canopy (hull bar red; game.js adds
                                    smoke)

  Explosion:  ship_explosion_fireball.glb  layered fireball shells
              ship_explosion_ring.glb      flat shockwave ring
              ship_debris.glb              eight hull shards, each its
                                           own object, flung by game.js

Run (either works):
  blender --background --python blender/generate_ships.py
  python3 blender/generate_ships.py        (no Blender needed)

Output: public/assets/ (found next to this script or one folder up;
otherwise ../assets like the other generator scripts).

FIT WITH THE GAME
  Every design keeps the starfighter's hardpoints, so the game's
  engine effects fit all of them without per-ship tuning:
  - nose at about Y = -1.25, main engine nozzle at Y = +1.05 on the
    centerline (the afterburner attaches there);
  - front thruster nozzles at X = +-0.42, Y = -0.14, Z = 0.10 (the
    reverse jets fire from there);
  - wingspan up to about 2.4 (the hit radius is unchanged).
  The smoke points game.js uses for each critical ship are listed in
  SMOKE_POINTS below (keep the two in step if you move the damage).

COORDINATES
  X = right, Y = backward (forward is -Y), Z = up (toward the
  top-down camera), like the other generated assets.
============================================================
"""

import json
import math
import os
import random
import struct

try:
    import bpy
except ImportError:
    bpy = None


# ------------------------------------------------------------
# MATERIALS (shared by every ship)
# (base color, metallic, roughness, emission strength)
# ------------------------------------------------------------

MATERIALS = {
    # Starfighter (as in generate_starfighter.py)
    "hull": ((0.74, 0.72, 0.67), 0.15, 0.55, 0.05),
    "hull_panel": ((0.6, 0.6, 0.57), 0.2, 0.6, 0.04),
    "greeble": ((0.32, 0.33, 0.35), 0.6, 0.45, 0.02),
    "dark_metal": ((0.12, 0.12, 0.13), 0.85, 0.35, 0.0),
    "scorch": ((0.08, 0.07, 0.06), 0.0, 0.95, 0.0),
    "stripe": ((0.72, 0.22, 0.12), 0.1, 0.5, 0.12),
    "canopy": ((0.03, 0.06, 0.1), 0.1, 0.08, 0.06),
    "canopy_frame": ((0.22, 0.22, 0.24), 0.7, 0.4, 0.0),
    "engine_glow": ((0.45, 0.85, 1.0), 0.0, 0.3, 6.0),
    "light_red": ((1.0, 0.1, 0.08), 0.0, 0.3, 6.0),
    "light_green": ((0.1, 1.0, 0.35), 0.0, 0.3, 6.0),
    "cannon_tip": ((1.0, 0.25, 0.2), 0.0, 0.3, 3.0),

    # Viper
    "viper_red": ((0.62, 0.05, 0.07), 0.35, 0.38, 0.1),
    "viper_black": ((0.05, 0.05, 0.06), 0.6, 0.35, 0.0),
    "viper_gold": ((0.95, 0.68, 0.2), 0.9, 0.3, 0.15),
    "viper_glass": ((0.28, 0.12, 0.02), 0.1, 0.05, 0.25),
    "warm_glow": ((1.0, 0.55, 0.2), 0.0, 0.3, 6.0),

    # Wraith
    "wraith_metal": ((0.17, 0.2, 0.23), 0.8, 0.32, 0.03),
    "wraith_panel": ((0.24, 0.28, 0.31), 0.75, 0.4, 0.02),
    "wraith_teal": ((0.1, 0.95, 0.85), 0.0, 0.3, 4.0),
    "wraith_glass": ((0.02, 0.18, 0.2), 0.1, 0.05, 0.4),

    # Hornet
    "hornet_yellow": ((0.95, 0.72, 0.06), 0.25, 0.42, 0.12),
    "hornet_black": ((0.06, 0.06, 0.07), 0.55, 0.4, 0.0),
    "hornet_glass": ((0.08, 0.2, 0.42), 0.1, 0.05, 0.3),
    "hornet_white": ((0.85, 0.85, 0.82), 0.2, 0.5, 0.05),

    # Damage
    "burn": ((0.015, 0.012, 0.01), 0.0, 1.0, 0.0),
    "soot": ((0.05, 0.04, 0.035), 0.0, 1.0, 0.0),
    "ember": ((1.0, 0.28, 0.02), 0.0, 0.5, 2.6),
    "ember_dim": ((0.95, 0.25, 0.02), 0.0, 0.5, 1.6),
    "dead_glow": ((0.06, 0.07, 0.08), 0.5, 0.6, 0.0),
    "crack": ((0.85, 0.9, 1.0), 0.0, 0.2, 1.2),

    # Explosion
    "fire_core": ((1.0, 0.95, 0.75), 0.0, 1.0, 10.0),
    "fire_mid": ((1.0, 0.55, 0.12), 0.0, 1.0, 6.0),
    "fire_outer": ((0.85, 0.2, 0.05), 0.0, 1.0, 3.0),
    "shock": ((0.75, 0.9, 1.0), 0.0, 1.0, 5.0),
    "debris_metal": ((0.3, 0.3, 0.32), 0.7, 0.45, 0.0),
    "debris_hot": ((1.0, 0.42, 0.08), 0.0, 0.5, 4.0),
}


# ------------------------------------------------------------
# GEOMETRY HELPERS
# A part is (name, vertices, faces, material[, smooth]).
# ------------------------------------------------------------

def box(name, center, size, material, yaw=0.0, pitch=0.0, roll=0.0):
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2

    vertices = []

    for dz in (-hz, hz):
        for dy in (-hy, hy):
            for dx in (-hx, hx):
                x, y, z = rotate((dx, dy, dz), yaw, pitch, roll)
                vertices.append((cx + x, cy + y, cz + z))

    faces = [
        (0, 2, 3, 1), (4, 5, 7, 6),
        (0, 1, 5, 4), (2, 6, 7, 3),
        (0, 4, 6, 2), (1, 3, 7, 5),
    ]

    return (name, vertices, faces, material)


def rotate(p, yaw=0.0, pitch=0.0, roll=0.0):
    """Rotate about Z (yaw), then X (pitch), then Y (roll)."""

    x, y, z = p

    c, s = math.cos(yaw), math.sin(yaw)
    x, y = x * c - y * s, x * s + y * c

    c, s = math.cos(pitch), math.sin(pitch)
    y, z = y * c - z * s, y * s + z * c

    c, s = math.cos(roll), math.sin(roll)
    x, z = x * c + z * s, -x * s + z * c

    return (x, y, z)


def loft(name, sections, material, sides=10, flatten=0.0):
    """A body through cross-sections (y, half_width, half_height, z)."""

    exponent = 2.0 / (1.0 + flatten * 2.0)
    vertices = []

    for y, hw, hh, zc in sections:
        for k in range(sides):
            angle = math.tau * k / sides
            c, s = math.cos(angle), math.sin(angle)
            x = hw * math.copysign(abs(c) ** exponent, c)
            z = hh * math.copysign(abs(s) ** exponent, s)
            vertices.append((x, y, zc + z))

    faces = []

    for i in range(len(sections) - 1):
        for k in range(sides):
            a = i * sides + k
            b = i * sides + (k + 1) % sides
            faces.append((a, b, b + sides, a + sides))

    faces.append(tuple(reversed(range(sides))))
    last = (len(sections) - 1) * sides
    faces.append(tuple(last + k for k in range(sides)))

    return (name, vertices, faces, material)


def plate(name, outline, z, thickness, material):
    """A convex outline [(x, y), ...] extruded up by `thickness`."""

    n = len(outline)
    vertices = [(x, y, z) for x, y in outline]
    vertices += [(x, y, z + thickness) for x, y in outline]

    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]

    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))

    return (name, vertices, faces, material)


def blob(name, cx, cy, z, radius, material, rng, points=9, squash=0.75, thickness=0.004):
    """
    An irregular flat splotch (scorch, soot, ember): a star-shaped
    outline fanned from its center, so it needn't be convex.
    """

    outline = []

    for k in range(points):
        angle = math.tau * k / points
        r = radius * rng.uniform(0.55, 1.25)
        outline.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r * squash))

    n = len(outline)
    vertices = [(cx, cy, z), (cx, cy, z + thickness)]
    vertices += [(x, y, z) for x, y in outline]
    vertices += [(x, y, z + thickness) for x, y in outline]

    faces = []

    for i in range(n):
        j = (i + 1) % n
        faces.append((0, 2 + j, 2 + i))                # bottom
        faces.append((1, 2 + n + i, 2 + n + j))        # top
        faces.append((2 + i, 2 + j, 2 + n + j, 2 + n + i))

    return (name, vertices, faces, material)


def cylinder_y(name, x, y0, y1, z, radius, material, sides=12, radius_end=None):
    r1 = radius if radius_end is None else radius_end
    vertices = []

    for y, r in ((y0, radius), (y1, r1)):
        for k in range(sides):
            angle = math.tau * k / sides
            vertices.append((x + math.cos(angle) * r, y, z + math.sin(angle) * r))

    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(sides + k for k in range(sides)))

    return (name, vertices, faces, material)


def glow_disc_y(name, x, y, z, radius, material, sides=16):
    vertices = [(x, y, z)]

    for k in range(sides):
        angle = math.tau * k / sides
        vertices.append((x + math.cos(angle) * radius, y, z + math.sin(angle) * radius))

    faces = [(0, 1 + (k + 1) % sides, 1 + k) for k in range(sides)]

    return (name, vertices, faces, material)


def mirrored(part):
    name, vertices, faces, material = part[:4]
    rest = part[4:]

    return (
        name + " (L)",
        [(-x, y, z) for x, y, z in vertices],
        [tuple(reversed(f)) for f in faces],
        material,
        *rest,
    )


def symmetric(parts, right):
    for part in right:
        parts.append(part)
        parts.append(mirrored(part))


def with_material(part, material):
    return (part[0], part[1], part[2], material, *part[4:])


def clip_outline(outline, a, b, keep):
    """
    Clip a convex outline by the line through a and b, keeping the
    side that `keep` is on (Sutherland-Hodgman, one edge).
    """

    def side(p):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

    sign = 1 if side(keep) >= 0 else -1
    out = []

    for i in range(len(outline)):
        p = outline[i]
        q = outline[(i + 1) % len(outline)]
        sp, sq = side(p) * sign, side(q) * sign

        if sp >= 0:
            out.append(p)

        if (sp >= 0) != (sq >= 0):
            t = sp / (sp - sq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))

    return out


def clip_plate(part, a, b, keep):
    """Clip a plate() part (outline at its first n vertices)."""

    name, vertices, faces, material = part[:4]
    n = len(vertices) // 2
    z0 = vertices[0][2]
    t = vertices[n][2] - z0
    outline = clip_outline([(x, y) for x, y, _ in vertices[:n]], a, b, keep)

    # Entirely on the lost side: the part is gone.
    if len(outline) < 3:
        return None

    return plate(name, outline, z0, t, material)


# ------------------------------------------------------------
# DAMAGE
# Each design describes where damage goes; these helpers add it.
# ------------------------------------------------------------

def add_scorch(parts, rng, spots, count, size):
    """Burn marks on top surfaces: spots are (x, y, z) on the hull."""

    picks = rng.sample(spots, min(count, len(spots)))

    for i, (x, y, z) in enumerate(picks):
        x += rng.uniform(-0.06, 0.06)
        y += rng.uniform(-0.06, 0.06)
        r = size * rng.uniform(0.7, 1.3)

        # A soot halo with a darker burn inside.
        parts.append(blob(f"Soot {i}", x, y, z + 0.002, r * 1.6, "soot", rng))
        parts.append(blob(f"Burn {i}", x, y, z + 0.005, r, "burn", rng))


def add_embers(parts, rng, spots, material="ember", size=0.035):
    for i, (x, y, z) in enumerate(spots):
        parts.append(blob(f"Ember {i}", x, y, z + 0.008, size * rng.uniform(0.7, 1.2), material, rng, points=7))


def add_tear(parts, rng, a, b, z, side_x):
    """
    Along a torn wing edge from a to b: exposed spar ends, jagged
    shards and glowing hot edges.
    """

    for i in range(5):
        t = (i + 0.5) / 5
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t

        # Spars sticking out past the tear.
        length = rng.uniform(0.06, 0.14)
        parts.append(
            box(f"Spar {i}", (x + side_x * length * 0.4, y, z + 0.02), (length, 0.018, 0.018),
                "dark_metal", yaw=rng.uniform(-0.4, 0.4))
        )

        # Bent shards of skin.
        parts.append(
            box(f"Shard {i}", (x, y + rng.uniform(-0.03, 0.03), z + 0.03), (0.06, 0.035, 0.008),
                "burn", yaw=rng.uniform(0, math.pi), pitch=rng.uniform(-0.6, 0.6))
        )

        # Glowing hot metal along the edge.
        parts.append(blob(f"Hot Edge {i}", x, y, z + 0.055, 0.05, "ember", rng, points=6))


def apply_damage(parts, spec, level, seed):
    """level 1 = damaged (yellow), level 2 = critical (red)."""

    rng = random.Random(seed + level * 101)

    if level == 0:
        return parts

    lost = set(spec.get("lost1", ())) | (set(spec.get("lost2", ())) if level == 2 else set())
    parts = [p for p in parts if p[0] not in lost]

    # Damage builds up: a critical ship keeps the yellow-stage damage too.
    clips = [spec.get("clip1", {})] + ([spec.get("clip2", {})] if level == 2 else [])

    # Swap out parts (clipped wings, dead engines, ...).
    replaced = []

    for part in parts:
        name = part[0]

        for clip in clips:
            if part is not None and name in clip:
                a, b, keep = clip[name]
                part = clip_plate(part, a, b, keep)

        if part is None:
            continue

        if level == 2 and name in spec.get("dead", ()):
            part = with_material(part, "dead_glow")

        if level == 2 and name in spec.get("cracked", ()):
            part = with_material(part, "soot")

        replaced.append(part)

    parts = replaced

    # Nothing floating where a piece of the ship used to be.
    def gone(x, y):
        for clip in clips:
            for a, b, keep in clip.values():
                if clip_outline([(x, y)] * 3, a, b, keep) == []:
                    return True

        return False

    spots = spec["scorch"]
    spots = [p for p in spots + [(-x, y, z) for x, y, z in spots] if not gone(p[0], p[1])]

    # The shot-off piece from the yellow stage leaves a glowing edge.
    (ax, ay), (bx, by), ez = spec["edge1"]

    for i in range(4):
        t = (i + 0.5) / 4
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t

        if not gone(x - 0.02 * (1 if x > 0 else -1), y):
            parts.append(blob(f"Hot Edge {i}", x, y, ez + 0.01, 0.04, "ember", rng, points=6))

    if level == 1:
        add_scorch(parts, rng, spots, 6, 0.12)
        add_embers(parts, rng, spec["embers1"], "ember", 0.05)
    else:
        add_scorch(parts, rng, spots, 11, 0.15)
        add_embers(parts, rng, spec["embers2"], "ember", 0.06)

        a, b, z, side_x = spec["tear"]
        add_tear(parts, rng, a, b, z, side_x)

        # A crack across the canopy.
        if "canopy_crack" in spec:
            (x0, y0), (x1, y1), z = spec["canopy_crack"]
            steps = 5

            for i in range(steps):
                t0, t1 = i / steps, (i + 1) / steps
                xa = x0 + (x1 - x0) * t0 + rng.uniform(-0.01, 0.01)
                ya = y0 + (y1 - y0) * t0
                xb = x0 + (x1 - x0) * t1 + rng.uniform(-0.01, 0.01)
                yb = y0 + (y1 - y0) * t1
                length = math.hypot(xb - xa, yb - ya)
                angle = math.atan2(yb - ya, xb - xa)

                parts.append(
                    box(f"Crack {i}", ((xa + xb) / 2, (ya + yb) / 2, z), (length, 0.008, 0.006),
                        "crack", yaw=angle)
                )

    return parts


# ------------------------------------------------------------
# STARFIGHTER (from generate_starfighter.py, unchanged)
# ------------------------------------------------------------

def build_starfighter():
    rng = random.Random(1977)
    parts = []

    parts.append(loft("Fuselage", [
        (-1.25, 0.02, 0.02, 0.02), (-1.05, 0.09, 0.07, 0.03), (-0.7, 0.16, 0.12, 0.05),
        (-0.25, 0.22, 0.16, 0.06), (0.25, 0.24, 0.17, 0.06), (0.7, 0.2, 0.15, 0.05),
        (0.92, 0.17, 0.14, 0.04),
    ], "hull", sides=12, flatten=0.35))

    parts.append(loft("Spine Panel", [
        (-0.55, 0.05, 0.02, 0.17), (-0.1, 0.09, 0.03, 0.21), (0.6, 0.08, 0.03, 0.19),
        (0.85, 0.05, 0.02, 0.16),
    ], "hull_panel", sides=8, flatten=0.6))

    parts.append(loft("Canopy Frame", [
        (-0.72, 0.03, 0.02, 0.15), (-0.6, 0.1, 0.07, 0.17), (-0.32, 0.13, 0.1, 0.2),
        (-0.12, 0.1, 0.08, 0.21), (0.0, 0.04, 0.03, 0.2),
    ], "canopy_frame", sides=12))

    parts.append(loft("Canopy Glass", [
        (-0.68, 0.025, 0.02, 0.17), (-0.58, 0.085, 0.065, 0.19), (-0.33, 0.11, 0.09, 0.22),
        (-0.16, 0.08, 0.07, 0.23), (-0.05, 0.03, 0.02, 0.22),
    ], "canopy", sides=12))

    parts.append(cylinder_y("Main Engine", 0.0, 0.7, 1.0, 0.04, 0.16, "dark_metal", sides=14))
    parts.append(cylinder_y("Main Nozzle", 0.0, 1.0, 1.05, 0.04, 0.17, "greeble", sides=14, radius_end=0.19))
    parts.append(glow_disc_y("Main Exhaust Glow", 0.0, 1.051, 0.04, 0.14, "engine_glow"))

    right = []
    right.append(plate("Wing", [(0.2, -0.3), (1.12, 0.32), (1.14, 0.6), (0.95, 0.66), (0.2, 0.62)], 0.0, 0.05, "hull"))
    right.append(plate("Wing Panel", [(0.32, 0.05), (0.95, 0.45), (0.95, 0.52), (0.32, 0.5)], 0.05, 0.006, "hull_panel"))
    right.append(plate("Wing Stripe", [(0.82, 0.17), (0.95, 0.25), (0.97, 0.63), (0.84, 0.64)], 0.05, 0.008, "stripe"))
    right.append(box("Wingtip Cap", (1.12, 0.47, 0.03), (0.06, 0.32, 0.08), "greeble"))
    right.append(box("Running Light", (1.16, 0.4, 0.04), (0.035, 0.07, 0.04), "light_green"))
    right.append(cylinder_y("Nacelle", 0.42, -0.05, 0.72, 0.08, 0.11, "hull", sides=12))
    right.append(cylinder_y("Nacelle Intake", 0.42, -0.12, -0.05, 0.08, 0.08, "dark_metal", sides=12, radius_end=0.11))
    right.append(cylinder_y("Nacelle Nozzle", 0.42, 0.72, 0.8, 0.08, 0.1, "dark_metal", sides=12, radius_end=0.09))
    right.append(glow_disc_y("Nacelle Glow", 0.42, 0.801, 0.08, 0.075, "engine_glow"))
    right.append(cylinder_y("Nacelle Band", 0.42, 0.18, 0.26, 0.08, 0.115, "stripe", sides=12))
    right.append(cylinder_y("Cannon", 0.13, -1.05, -0.35, -0.04, 0.03, "dark_metal", sides=8))
    right.append(cylinder_y("Cannon Shroud", 0.13, -0.5, -0.3, -0.04, 0.05, "greeble", sides=8))
    right.append(cylinder_y("Cannon Tip", 0.13, -1.1, -1.05, -0.04, 0.02, "cannon_tip", sides=8, radius_end=0.03))

    for i in range(2):
        cx = rng.uniform(0.45, 0.85)
        cy = rng.uniform(0.15, 0.55)
        r = rng.uniform(0.05, 0.09)
        outline = []

        for k in range(7):
            angle = math.tau * k / 7
            rr = r * rng.uniform(0.6, 1.3)
            outline.append((cx + math.cos(angle) * rr, cy + math.sin(angle) * rr * 0.7))

        right.append(plate(f"Scorch {i}", outline, 0.05, 0.004, "scorch"))

    symmetric(parts, right)

    for index, part in enumerate(parts):
        if part[0] == "Running Light (L)":
            parts[index] = with_material(part, "light_red")

    parts.append(plate("Dorsal Fin", [(-0.025, 0.35), (0.025, 0.35), (0.025, 0.92), (-0.025, 0.92)], 0.2, 0.12, "hull_panel"))

    for i in range(26):
        on_wing = i % 2 == 0

        if on_wing:
            x, y, z = rng.uniform(0.3, 0.9), rng.uniform(0.15, 0.58), 0.055
        else:
            x, y, z = rng.uniform(0.05, 0.19), rng.uniform(-0.2, 0.85), 0.17

        size = (rng.uniform(0.03, 0.09), rng.uniform(0.03, 0.12), rng.uniform(0.012, 0.03))
        material = "greeble" if rng.random() < 0.7 else "dark_metal"
        greeble = box(f"Greeble {i:02d}", (x, y, z + size[2] / 2), size, material)
        parts.append(greeble)

        if rng.random() < 0.8:
            parts.append(mirrored(greeble))

    return parts


STARFIGHTER_DAMAGE = {
    "scorch": [(0.5, 0.2, 0.05), (0.75, 0.45, 0.05), (0.35, 0.5, 0.05), (0.0, -0.3, 0.235), (0.0, 0.5, 0.235), (0.9, 0.55, 0.05)],
    # Level 1: the left wingtip is shot off.
    "clip1": {
        "Wing (L)": ((-0.88, 0.1), (-1.0, 0.7), (-0.5, 0.4)),
        "Wing Stripe (L)": ((-0.88, 0.1), (-1.0, 0.7), (-0.5, 0.4)),
    },
    "lost1": ["Wingtip Cap (L)", "Running Light (L)"],
    "edge1": ((-0.89, 0.18), (-0.99, 0.64), 0.05),
    "embers1": [(0.6, 0.35, 0.05), (0.15, 0.1, 0.2), (-0.42, 0.45, 0.19)],
    # Level 2: half the left wing is torn away.
    "clip2": {
        "Wing (L)": ((-0.62, -0.05), (-0.8, 0.66), (-0.3, 0.3)),
        "Wing Panel (L)": ((-0.62, -0.05), (-0.8, 0.66), (-0.3, 0.3)),
        "Wing Stripe (L)": ((-0.62, -0.05), (-0.8, 0.66), (-0.3, 0.3)),
    },
    "tear": ((-0.64, 0.02), (-0.79, 0.62), 0.02, -1),
    "embers2": [(-0.7, 0.3, 0.05), (0.42, 0.55, 0.19), (0.1, 0.2, 0.2), (-0.42, 0.1, 0.19)],
    "dead": ["Nacelle Glow (L)"],
    "cracked": [],
    "canopy_crack": ((-0.06, -0.55), (0.07, -0.2), 0.235),
}

STARFIGHTER_DAMAGE["lost2"] = []


# ------------------------------------------------------------
# VIPER: crimson and black arrowhead, gold trim, twin fins
# ------------------------------------------------------------

def build_viper():
    parts = []

    parts.append(loft("Fuselage", [
        (-1.32, 0.015, 0.015, 0.03), (-1.05, 0.08, 0.06, 0.04), (-0.6, 0.15, 0.11, 0.06),
        (-0.1, 0.21, 0.15, 0.07), (0.45, 0.23, 0.15, 0.07), (0.8, 0.2, 0.14, 0.05),
        (0.98, 0.17, 0.13, 0.04),
    ], "viper_red", sides=12, flatten=0.5))

    # A black spine with a gold pinstripe.
    parts.append(loft("Spine", [
        (-0.95, 0.02, 0.015, 0.09), (-0.5, 0.06, 0.03, 0.16), (0.3, 0.08, 0.035, 0.2),
        (0.85, 0.05, 0.025, 0.17),
    ], "viper_black", sides=8, flatten=0.6))
    parts.append(box("Spine Pinstripe", (0.0, -0.05, 0.235), (0.018, 0.9, 0.006), "viper_gold"))

    # Canopy (amber tinted).
    parts.append(loft("Canopy", [
        (-0.78, 0.02, 0.015, 0.15), (-0.62, 0.08, 0.06, 0.18), (-0.4, 0.1, 0.08, 0.21),
        (-0.22, 0.07, 0.06, 0.22), (-0.12, 0.02, 0.015, 0.21),
    ], "viper_glass", sides=12))

    # Main engine at the hardpoint.
    parts.append(cylinder_y("Main Engine", 0.0, 0.75, 1.0, 0.04, 0.16, "viper_black", sides=14))
    parts.append(cylinder_y("Main Nozzle", 0.0, 1.0, 1.05, 0.04, 0.17, "viper_gold", sides=14, radius_end=0.19))
    parts.append(glow_disc_y("Main Exhaust Glow", 0.0, 1.051, 0.04, 0.14, "warm_glow"))

    right = []

    # Big swept delta wing, black, with a crimson leading edge and gold trim.
    right.append(plate("Wing", [(0.18, -0.6), (1.16, 0.5), (1.16, 0.74), (0.95, 0.8), (0.18, 0.74)], 0.0, 0.045, "viper_black"))
    right.append(plate("Wing Edge", [(0.2, -0.56), (1.12, 0.48), (1.1, 0.56), (0.2, -0.38)], 0.045, 0.008, "viper_red"))
    right.append(plate("Wing Trim", [(0.55, 0.62), (1.05, 0.66), (1.05, 0.7), (0.55, 0.69)], 0.045, 0.008, "viper_gold"))
    right.append(box("Wingtip Light", (1.17, 0.62, 0.035), (0.03, 0.12, 0.03), "light_green"))

    # Twin canted tail fins.
    right.append(box("Tail Fin", (0.3, 0.72, 0.22), (0.025, 0.42, 0.28), "viper_red", roll=-0.35))
    right.append(box("Fin Tip", (0.36, 0.8, 0.35), (0.025, 0.2, 0.03), "viper_gold", roll=-0.35))

    # Side pods with intakes at the front thruster hardpoints.
    right.append(cylinder_y("Pod", 0.42, -0.1, 0.62, 0.09, 0.1, "viper_red", sides=12))
    right.append(cylinder_y("Pod Intake", 0.42, -0.18, -0.1, 0.09, 0.075, "viper_black", sides=12, radius_end=0.1))
    right.append(cylinder_y("Pod Ring", 0.42, 0.05, 0.11, 0.09, 0.106, "viper_gold", sides=12))
    right.append(cylinder_y("Pod Nozzle", 0.42, 0.62, 0.72, 0.09, 0.09, "viper_black", sides=12, radius_end=0.08))
    right.append(glow_disc_y("Pod Glow", 0.42, 0.721, 0.09, 0.065, "warm_glow"))

    # Wing cannons.
    right.append(cylinder_y("Cannon", 0.78, -0.4, 0.3, 0.02, 0.025, "viper_black", sides=8))
    right.append(cylinder_y("Cannon Tip", 0.78, -0.46, -0.4, 0.02, 0.018, "cannon_tip", sides=8, radius_end=0.025))

    symmetric(parts, right)

    for index, part in enumerate(parts):
        if part[0] == "Wingtip Light (L)":
            parts[index] = with_material(part, "light_red")

    return parts


VIPER_DAMAGE = {
    "scorch": [(0.55, 0.2, 0.045), (0.85, 0.55, 0.045), (0.4, 0.55, 0.045), (0.0, 0.3, 0.24), (0.0, -0.5, 0.2), (0.62, 0.62, 0.045)],
    "clip1": {
        "Wing (L)": ((-0.9, 0.3), (-1.0, 0.85), (-0.5, 0.5)),
        "Wing Edge (L)": ((-0.9, 0.3), (-1.0, 0.85), (-0.5, 0.5)),
        "Wing Trim (L)": ((-0.9, 0.3), (-1.0, 0.85), (-0.5, 0.5)),
    },
    "lost1": ["Wingtip Light (L)"],
    "edge1": ((-0.91, 0.36), (-0.99, 0.78), 0.045),
    "embers1": [(0.6, 0.35, 0.05), (-0.3, 0.68, 0.3), (0.42, 0.1, 0.19)],
    "clip2": {
        "Wing": ((0.7, 0.0), (0.9, 0.8), (0.4, 0.4)),
        "Wing Edge": ((0.7, 0.0), (0.9, 0.8), (0.4, 0.4)),
        "Wing Trim": ((0.7, 0.0), (0.9, 0.8), (0.4, 0.4)),
    },
    "tear": ((0.71, 0.05), (0.88, 0.76), 0.02, 1),
    "embers2": [(0.78, 0.4, 0.05), (-0.42, 0.4, 0.2), (0.0, 0.5, 0.21), (0.3, 0.75, 0.3)],
    "dead": ["Pod Glow"],
    "cracked": [],
    "canopy_crack": ((-0.05, -0.68), (0.06, -0.3), 0.225),
}

VIPER_DAMAGE["lost2"] = ["Wingtip Light", "Cannon", "Cannon Tip"]


# ------------------------------------------------------------
# WRAITH: teal-lit gunmetal stealth wing
# ------------------------------------------------------------

def build_wraith():
    parts = []

    # A low, faceted center body.
    parts.append(loft("Body", [
        (-1.25, 0.02, 0.015, 0.03), (-0.95, 0.12, 0.05, 0.05), (-0.45, 0.24, 0.1, 0.07),
        (0.2, 0.28, 0.12, 0.07), (0.75, 0.22, 0.11, 0.05), (0.98, 0.18, 0.1, 0.04),
    ], "wraith_metal", sides=8, flatten=0.8))

    parts.append(loft("Dorsal Hump", [
        (-0.6, 0.06, 0.03, 0.14), (-0.2, 0.16, 0.07, 0.16), (0.45, 0.14, 0.06, 0.15),
        (0.8, 0.06, 0.03, 0.12),
    ], "wraith_panel", sides=8, flatten=0.8))

    parts.append(loft("Canopy", [
        (-0.88, 0.02, 0.01, 0.1), (-0.72, 0.07, 0.035, 0.12), (-0.5, 0.09, 0.05, 0.15),
        (-0.3, 0.05, 0.035, 0.16), (-0.2, 0.015, 0.01, 0.15),
    ], "wraith_glass", sides=10))

    parts.append(cylinder_y("Main Engine", 0.0, 0.75, 1.0, 0.04, 0.15, "wraith_metal", sides=10))
    parts.append(cylinder_y("Main Nozzle", 0.0, 1.0, 1.05, 0.04, 0.16, "wraith_panel", sides=10, radius_end=0.18))
    parts.append(glow_disc_y("Main Exhaust Glow", 0.0, 1.051, 0.04, 0.13, "wraith_teal"))

    right = []

    # Broad swept wing with a sawtooth trailing edge.
    right.append(plate("Wing", [(0.16, -0.9), (1.22, 0.5), (1.18, 0.62), (0.16, 0.82)], 0.0, 0.04, "wraith_metal"))
    right.append(plate("Wing Panel", [(0.35, -0.3), (0.95, 0.42), (0.9, 0.55), (0.35, 0.62)], 0.04, 0.006, "wraith_panel"))
    right.append(plate("Trailing Tooth", [(0.62, 0.66), (0.86, 0.6), (0.66, 0.82)], 0.0, 0.04, "wraith_metal"))

    # Glowing teal lines along the leading edge and wingtip.
    right.append(box("Edge Light", (0.69, -0.2, 0.05), (1.18, 0.018, 0.008), "wraith_teal", yaw=math.atan2(1.4, 1.06)))
    right.append(box("Tip Light", (1.2, 0.56, 0.035), (0.03, 0.1, 0.03), "wraith_teal"))

    # Buried engines at the front thruster hardpoints.
    right.append(cylinder_y("Engine Pod", 0.42, -0.12, 0.68, 0.07, 0.085, "wraith_panel", sides=8))
    right.append(cylinder_y("Engine Intake", 0.42, -0.18, -0.12, 0.07, 0.06, "wraith_metal", sides=8, radius_end=0.085))
    right.append(glow_disc_y("Engine Glow", 0.42, 0.681, 0.07, 0.06, "wraith_teal"))

    # Small canted fin.
    right.append(box("Fin", (0.55, 0.62, 0.11), (0.02, 0.26, 0.16), "wraith_panel", roll=-0.6))

    symmetric(parts, right)

    return parts


WRAITH_DAMAGE = {
    "scorch": [(0.5, 0.0, 0.04), (0.8, 0.35, 0.04), (0.35, 0.5, 0.04), (0.0, 0.1, 0.235), (0.3, -0.45, 0.04), (1.0, 0.45, 0.04)],
    "clip1": {
        "Wing (L)": ((-0.85, 0.0), (-1.0, 0.8), (-0.5, 0.3)),
        "Edge Light (L)": ((-0.85, 0.0), (-1.0, 0.8), (-0.5, 0.3)),
    },
    "lost1": ["Tip Light (L)"],
    "edge1": ((-0.86, 0.06), (-0.97, 0.62), 0.04),
    "embers1": [(0.6, 0.2, 0.04), (0.2, 0.25, 0.17), (-0.42, 0.4, 0.16)],
    "clip2": {
        "Wing (L)": ((-0.75, -0.2), (-0.85, 0.75), (-0.3, 0.2)),
        "Wing Panel (L)": ((-0.75, -0.2), (-0.85, 0.75), (-0.3, 0.2)),
        "Edge Light (L)": ((-0.75, -0.2), (-0.85, 0.75), (-0.3, 0.2)),
    },
    "tear": ((-0.76, -0.15), (-0.84, 0.7), 0.02, -1),
    "embers2": [(-0.8, 0.2, 0.04), (0.42, 0.5, 0.16), (0.1, 0.3, 0.2), (-0.3, 0.6, 0.04)],
    "dead": ["Engine Glow (L)", "Tip Light (L)"],
    "cracked": [],
    "canopy_crack": ((-0.04, -0.78), (0.05, -0.35), 0.17),
}

WRAITH_DAMAGE["lost2"] = ["Trailing Tooth (L)"]


# ------------------------------------------------------------
# HORNET: yellow and black heavy fighter
# ------------------------------------------------------------

def build_hornet():
    parts = []

    parts.append(loft("Fuselage", [
        (-1.2, 0.05, 0.05, 0.04), (-1.0, 0.14, 0.11, 0.05), (-0.6, 0.24, 0.17, 0.07),
        (0.0, 0.28, 0.2, 0.08), (0.6, 0.25, 0.18, 0.07), (0.95, 0.18, 0.15, 0.05),
    ], "hornet_yellow", sides=12, flatten=0.4))

    # Black chevron bands across the back.
    for i, y in enumerate((-0.2, 0.15, 0.5)):
        parts.append(box(f"Band {i}", (0.0, y, 0.25), (0.42, 0.08, 0.04), "hornet_black"))

    parts.append(loft("Canopy", [
        (-0.95, 0.03, 0.02, 0.12), (-0.8, 0.11, 0.08, 0.16), (-0.55, 0.14, 0.11, 0.2),
        (-0.32, 0.1, 0.08, 0.22), (-0.22, 0.03, 0.02, 0.21),
    ], "hornet_glass", sides=12))

    parts.append(cylinder_y("Main Engine", 0.0, 0.75, 1.0, 0.04, 0.17, "hornet_black", sides=14))
    parts.append(cylinder_y("Main Nozzle", 0.0, 1.0, 1.05, 0.04, 0.18, "hornet_white", sides=14, radius_end=0.2))
    parts.append(glow_disc_y("Main Exhaust Glow", 0.0, 1.051, 0.04, 0.15, "engine_glow"))

    right = []

    # Stubby straight wings with black tips.
    right.append(plate("Wing", [(0.25, -0.15), (1.0, 0.0), (1.0, 0.45), (0.25, 0.55)], 0.0, 0.06, "hornet_yellow"))
    right.append(plate("Wing Tip", [(0.82, -0.03), (1.0, 0.0), (1.0, 0.45), (0.82, 0.47)], 0.06, 0.008, "hornet_black"))
    right.append(box("Tip Light", (1.02, 0.25, 0.04), (0.03, 0.1, 0.04), "light_green"))

    # Heavy side pods (front thruster hardpoints at their noses).
    right.append(cylinder_y("Pod", 0.42, -0.1, 0.78, 0.1, 0.14, "hornet_yellow", sides=14))
    right.append(cylinder_y("Pod Intake", 0.42, -0.2, -0.1, 0.1, 0.1, "hornet_black", sides=14, radius_end=0.14))
    right.append(cylinder_y("Pod Stripe A", 0.42, 0.2, 0.28, 0.1, 0.145, "hornet_black", sides=14))
    right.append(cylinder_y("Pod Stripe B", 0.42, 0.42, 0.5, 0.1, 0.145, "hornet_black", sides=14))
    right.append(cylinder_y("Pod Nozzle", 0.42, 0.78, 0.88, 0.1, 0.12, "hornet_black", sides=14, radius_end=0.11))
    right.append(glow_disc_y("Pod Glow", 0.42, 0.881, 0.1, 0.09, "engine_glow"))

    # Canards near the nose.
    right.append(plate("Canard", [(0.14, -0.9), (0.42, -0.78), (0.42, -0.68), (0.14, -0.68)], 0.03, 0.03, "hornet_black"))

    # Wingtip cannons.
    right.append(cylinder_y("Cannon", 0.92, -0.55, 0.2, 0.0, 0.03, "hornet_black", sides=8))
    right.append(cylinder_y("Cannon Tip", 0.92, -0.62, -0.55, 0.0, 0.02, "cannon_tip", sides=8, radius_end=0.03))

    symmetric(parts, right)

    for index, part in enumerate(parts):
        if part[0] == "Tip Light (L)":
            parts[index] = with_material(part, "light_red")

    return parts


HORNET_DAMAGE = {
    "scorch": [(0.55, 0.15, 0.06), (0.75, 0.35, 0.06), (0.62, 0.42, 0.06), (0.0, -0.4, 0.29), (0.0, 0.35, 0.29), (0.32, 0.5, 0.06)],
    "clip1": {
        "Wing (L)": ((-0.78, -0.3), (-0.78, 0.7), (-0.5, 0.2)),
        "Wing Tip (L)": ((-0.78, -0.3), (-0.78, 0.7), (-0.5, 0.2)),
    },
    "lost1": ["Tip Light (L)", "Cannon (L)", "Cannon Tip (L)"],
    "edge1": ((-0.78, -0.08), (-0.78, 0.48), 0.06),
    "embers1": [(0.6, 0.3, 0.06), (-0.42, 0.3, 0.25), (0.1, -0.3, 0.27)],
    "clip2": {
        "Wing": ((0.62, -0.2), (0.7, 0.6), (0.35, 0.2)),
        "Wing Tip": ((0.62, -0.2), (0.7, 0.6), (0.35, 0.2)),
    },
    "tear": ((0.63, -0.1), (0.69, 0.5), 0.03, 1),
    "embers2": [(0.66, 0.2, 0.06), (-0.42, 0.3, 0.25), (0.0, 0.0, 0.29), (0.42, 0.7, 0.24)],
    "dead": ["Pod Glow"],
    "cracked": [],
    "canopy_crack": ((-0.07, -0.85), (0.08, -0.4), 0.235),
}

HORNET_DAMAGE["lost2"] = ["Tip Light", "Cannon", "Cannon Tip", "Wing Tip"]


# ------------------------------------------------------------
# THE FLEET
# ------------------------------------------------------------

def without(parts, names):
    return [p for p in parts if p[0] not in names]


FLEET = {
    # name: (builder, damage spec, seed, write intact?)
    "starfighter": (build_starfighter, STARFIGHTER_DAMAGE, 11, False),
    "ship_viper": (build_viper, VIPER_DAMAGE, 23, True),
    "ship_wraith": (build_wraith, WRAITH_DAMAGE, 37, True),
    "ship_hornet": (build_hornet, HORNET_DAMAGE, 41, True),
}

# Where critical ships smoke, in game.js's ship space (x, y up, z
# forward): from each design's tear and dead engine. Copied into
# SHIP_DESIGNS in game.js.
SMOKE_POINTS = {
    "starfighter": [(-0.72, 0.08, -0.32), (-0.42, 0.1, -0.8)],
    "ship_viper": [(0.8, 0.08, -0.4), (0.42, 0.1, -0.72)],
    "ship_wraith": [(-0.8, 0.08, -0.25), (-0.42, 0.08, -0.68)],
    "ship_hornet": [(0.66, 0.08, -0.2), (0.42, 0.1, -0.88)],
}


def ship_variants():
    out = {}

    for name, (builder, spec, seed, write_intact) in FLEET.items():
        base = builder()

        if write_intact:
            out[name] = [("ship", base)]

        out[f"{name}_damaged"] = [("ship", apply_damage(list(base), spec, 1, seed))]
        out[f"{name}_critical"] = [("ship", apply_damage(list(base), spec, 2, seed))]

    return out


# ------------------------------------------------------------
# SHIP EXPLOSION
# ------------------------------------------------------------

def sphere(name, center, radius, material, rings=10, segments=16, wobble=0.0, rng=None, squash=1.0):
    cx, cy, cz = center
    vertices = []
    faces = []

    rows = []

    for i in range(rings + 1):
        phi = math.pi * i / rings
        row = []

        for j in range(segments if 0 < i < rings else 1):
            theta = math.tau * j / segments
            r = radius * (1 + (rng.uniform(-wobble, wobble) if (rng and 0 < i < rings) else 0))
            x = math.sin(phi) * math.cos(theta) * r
            y = math.sin(phi) * math.sin(theta) * r
            z = math.cos(phi) * r * squash
            row.append(len(vertices))
            vertices.append((cx + x, cy + y, cz + z))

        rows.append(row)

    for i in range(rings):
        a, b = rows[i], rows[i + 1]

        if len(a) == 1:
            for j in range(segments):
                faces.append((a[0], b[j], b[(j + 1) % segments]))
        elif len(b) == 1:
            for j in range(segments):
                faces.append((a[j], b[0], a[(j + 1) % segments]))
        else:
            for j in range(segments):
                j2 = (j + 1) % segments
                faces.append((a[j], b[j], b[j2], a[j2]))

    return (name, vertices, faces, material, True)


def explosion_assets():
    rng = random.Random(5150)
    out = {}

    # Fireball: three lumpy shells, hot white core inside orange inside
    # red. game.js grows and fades the layers at different rates.
    out["ship_explosion_fireball"] = [
        ("core", [sphere("Core", (0, 0, 0), 0.45, "fire_core", 10, 16, 0.12, rng, 0.8)]),
        ("mid", [sphere("Mid", (0, 0, 0), 0.75, "fire_mid", 12, 20, 0.18, rng, 0.75)]),
        ("outer", [sphere("Outer", (0, 0, 0), 1.0, "fire_outer", 12, 22, 0.22, rng, 0.7)]),
    ]

    # Shockwave: a thin flat ring (radius 1), its edge brightest.
    segments = 64
    inner, outer = 0.82, 1.0
    vertices = []

    for k in range(segments):
        a = math.tau * k / segments
        vertices.append((math.cos(a) * inner, math.sin(a) * inner, 0.0))
        vertices.append((math.cos(a) * outer, math.sin(a) * outer, 0.0))

    faces = []

    for k in range(segments):
        a, b = k * 2, ((k + 1) % segments) * 2
        faces.append((a, b, b + 1, a + 1))

    ring = ("Ring", vertices, faces, "shock")
    out["ship_explosion_ring"] = [("ring", [ring])]

    # Debris: eight jagged shards of hull, each its own object, with
    # a glowing hot edge.
    nodes = []

    for i in range(8):
        size = rng.uniform(0.14, 0.3)

        # A jagged slab (fanned from its center, so it can be any
        # shape), with a glowing hot spot near one edge.
        shard = blob(f"Shard {i}", 0.0, 0.0, -0.02, size, "debris_metal", rng, points=5, squash=0.8, thickness=0.04)
        hx, hy = rng.uniform(-0.4, 0.4) * size, rng.uniform(-0.3, 0.3) * size
        hot = blob(f"Hot {i}", hx, hy, 0.022, size * 0.35, "debris_hot", rng, points=6)
        nodes.append((f"debris_{i}", [shard, hot]))

    out["ship_debris"] = nodes

    return out


# ------------------------------------------------------------
# OUTPUT FOLDER
# ------------------------------------------------------------

def output_folder():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(script_dir)

    for base in (script_dir, parent):
        if os.path.isdir(os.path.join(base, "public")):
            folder = os.path.join(base, "public", "assets")
            break
    else:
        folder = os.path.join(parent, "assets")

    os.makedirs(folder, exist_ok=True)
    return folder


# ------------------------------------------------------------
# BUILT-IN GLB EXPORT (no Blender needed)
# glTF 2.0 binary, one node per object, one primitive per material,
# indexed. Blender's Z-up becomes glTF's Y-up like Blender's own
# exporter: (x, y, z) -> (x, z, -y).
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

    name, vertices, faces, material = part[:4]
    smooth = len(part) > 4 and part[4]

    centroid = tuple(sum(v[i] for v in vertices) / len(vertices) for i in range(3))
    tris = []

    for face in faces:
        for i in range(1, len(face) - 1):
            a, b, c = face[0], face[i], face[i + 1]
            pa, pb, pc = vertices[a], vertices[b], vertices[c]
            n = _cross(_sub(pb, pa), _sub(pc, pa))

            if n[0] ** 2 + n[1] ** 2 + n[2] ** 2 < 1e-18:
                continue

            center = tuple((pa[j] + pb[j] + pc[j]) / 3 for j in range(3))
            out = _sub(center, centroid)

            if n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0:
                b, c = c, b

            tris.append((a, b, c))

    normals = [
        _cross(_sub(vertices[b], vertices[a]), _sub(vertices[c], vertices[a]))
        for a, b, c in tris
    ]

    if smooth:
        key = lambda p: (round(p[0], 5), round(p[1], 5), round(p[2], 5))
        sums = {}

        for (a, b, c), n in zip(tris, normals):
            for v in (a, b, c):
                k = key(vertices[v])
                s = sums.get(k, (0.0, 0.0, 0.0))
                sums[k] = (s[0] + n[0], s[1] + n[1], s[2] + n[2])

        return [
            (vertices[a], vertices[b], vertices[c],
             _norm(sums[key(vertices[a])]), _norm(sums[key(vertices[b])]), _norm(sums[key(vertices[c])]))
            for a, b, c in tris
        ]

    return [
        (vertices[a], vertices[b], vertices[c], _norm(n), _norm(n), _norm(n))
        for (a, b, c), n in zip(tris, normals)
    ]


def _to_gltf(p):
    return (p[0], p[2], -p[1])


def write_glb(nodes, path, label):
    """nodes: [(node name, parts), ...]"""

    binary = bytearray()
    buffer_views = []
    accessors = []
    meshes = []
    gltf_nodes = []
    materials = []
    material_index = {}
    triangles = 0

    def add_view(data, target):
        while len(binary) % 4:
            binary.append(0)

        offset = len(binary)
        binary.extend(data)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        return len(buffer_views) - 1

    def material_for(key):
        if key in material_index:
            return material_index[key]

        color, metallic, roughness, emission = MATERIALS[key]

        material = {
            "name": f"{label} | {key}",
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
        material_index[key] = len(materials) - 1
        return material_index[key]

    for node_name, parts in nodes:
        by_material = {}

        for part in parts:
            by_material.setdefault(part[3], []).extend(_triangles(part))

        primitives = []

        for key, tris in sorted(by_material.items()):
            positions, normals, indices, seen = [], [], [], {}

            for p0, p1, p2, n0, n1, n2 in tris:
                for p, n in ((p0, n0), (p1, n1), (p2, n2)):
                    gp, gn = _to_gltf(p), _to_gltf(n)
                    k = tuple(round(v, 5) for v in gp + gn)

                    if k not in seen:
                        seen[k] = len(positions)
                        positions.append(gp)
                        normals.append(gn)

                    indices.append(seen[k])

            triangles += len(tris)

            pos_view = add_view(b"".join(struct.pack("<3f", *p) for p in positions), 34962)
            accessors.append({
                "bufferView": pos_view, "componentType": 5126, "count": len(positions), "type": "VEC3",
                "min": [min(p[i] for p in positions) for i in range(3)],
                "max": [max(p[i] for p in positions) for i in range(3)],
            })
            pos_accessor = len(accessors) - 1

            nor_view = add_view(b"".join(struct.pack("<3f", *n) for n in normals), 34962)
            accessors.append({"bufferView": nor_view, "componentType": 5126, "count": len(normals), "type": "VEC3"})
            nor_accessor = len(accessors) - 1

            big = len(positions) > 65535
            idx_view = add_view(struct.pack(f"<{len(indices)}{'I' if big else 'H'}", *indices), 34963)
            accessors.append({
                "bufferView": idx_view, "componentType": 5125 if big else 5123,
                "count": len(indices), "type": "SCALAR",
            })
            idx_accessor = len(accessors) - 1

            primitives.append({
                "attributes": {"POSITION": pos_accessor, "NORMAL": nor_accessor},
                "indices": idx_accessor,
                "material": material_for(key),
                "mode": 4,
            })

        meshes.append({"name": node_name, "primitives": primitives})
        gltf_nodes.append({"name": node_name, "mesh": len(meshes) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "Asteroid Defense generate_ships.py"},
        "extensionsUsed": ["KHR_materials_emissive_strength"],
        "scene": 0,
        "scenes": [{"nodes": list(range(len(gltf_nodes)))}],
        "nodes": gltf_nodes,
        "meshes": meshes,
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

    print(f"  {os.path.basename(path):34s} {triangles:6d} triangles  {total // 1024:4d} KB")


# ------------------------------------------------------------
# BLENDER EXPORT
# ------------------------------------------------------------

def blender_export(nodes, path, label):
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
        mat = bpy.data.materials.new(name=f"{label} | {key}")
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

    roots = []

    for node_name, parts in nodes:
        objects = []

        for part in parts:
            name, vertices, faces, material_key = part[:4]
            smooth = len(part) > 4 and part[4]

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
        joined.name = node_name

        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode="OBJECT")

        roots.append(joined)

    bpy.ops.object.select_all(action="DESELECT")

    for obj in roots:
        obj.select_set(True)

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )

    print("  Exported:", path)


def main():
    folder = output_folder()

    print("\n========================================")
    print(" ASTEROID DEFENSE - SHIP FLEET + EXPLOSION")
    print("========================================")

    everything = {}
    everything.update(ship_variants())
    everything.update(explosion_assets())

    for name, nodes in everything.items():
        path = os.path.join(folder, f"{name}.glb")
        label = name.replace("ship_", "").replace("_", " ").title()

        if bpy is not None:
            blender_export(nodes, path, label)
        else:
            write_glb(nodes, path, label)

    print(f"\n{len(everything)} files written to {folder}")


if __name__ == "__main__":
    main()
