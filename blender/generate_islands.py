"""
============================================================
ASTEROID DEFENSE: "LOW ORBIT" MAP BACKGROUND
Generates the three parallax layers for the island-chain map: a
view straight down from low Earth orbit onto a chain of volcanic
islands, with clouds and high haze drifting between the ground and
the ships.

    public/assets/bg_orbit_ground.jpg   ocean and islands (opaque)
    public/assets/bg_orbit_clouds.png   cloud cover and shadows
    public/assets/bg_orbit_haze.png     thin high cirrus

Each image tiles seamlessly (the noise is made periodic with an FFT
and the island chain wraps around the tile), so game.js can repeat
it forever like the space map's layers.

Needs Python 3 with numpy and Pillow (pip install numpy pillow).
Run from the project folder:

    python3 blender/generate_islands.py

Change SEED for a different chain of islands.
============================================================
"""

import math
import os

import numpy as np
from PIL import Image

SEED = 7
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "assets")

GROUND_SIZE = 2048
CLOUD_SIZE = 1024
HAZE_SIZE = 1024


# ------------------------------------------------------------
# Periodic noise
# ------------------------------------------------------------

def fbm(rng, size, beta=2.0, low_cut=1.0):
    """Tileable fractal noise in 0..1: white noise shaped to a 1/f^beta
    spectrum. The FFT makes it wrap around perfectly."""
    white = rng.standard_normal((size, size))
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    radius = np.sqrt(fx * fx + fy * fy)
    radius[0, 0] = 1.0

    shape = 1.0 / np.power(np.maximum(radius, low_cut), beta / 2.0)
    shape[0, 0] = 0.0

    field = np.real(np.fft.ifft2(np.fft.fft2(white) * shape))
    field -= field.min()
    field /= field.max()
    return field


def stretched_fbm(rng, size, beta, stretch):
    """Periodic noise smeared along x (for streaky cirrus)."""
    white = rng.standard_normal((size, size))
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    radius = np.sqrt((fx * stretch) ** 2 + fy * fy)
    radius[0, 0] = 1.0

    shape = 1.0 / np.power(np.maximum(radius, 1.0), beta / 2.0)
    shape[0, 0] = 0.0

    field = np.real(np.fft.ifft2(np.fft.fft2(white) * shape))
    field -= field.min()
    field /= field.max()
    return field


def wrapped_distance(size, cx, cy):
    """Distance (pixels) from (cx, cy) to every pixel on a torus."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    dx = np.abs(x - cx)
    dy = np.abs(y - cy)
    dx = np.minimum(dx, size - dx)
    dy = np.minimum(dy, size - dy)
    return np.sqrt(dx * dx + dy * dy)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lerp(a, b, t):
    return a + (b - a) * t[..., None]


def rgb(hex_code):
    hex_code = hex_code.lstrip("#")
    return np.array([int(hex_code[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def blur(field, radius):
    """Gaussian blur that wraps around the tile edges (done with an FFT,
    so it's seamless)."""
    size = field.shape[0]
    f = np.fft.fftfreq(size)
    fx, fy = np.meshgrid(f, f)
    kernel = np.exp(-2 * (math.pi * radius) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(field) * kernel))


# ------------------------------------------------------------
# Ground: ocean and the island chain
# ------------------------------------------------------------

def wrapped_delta(size, cx, cy):
    """Signed offsets (pixels) from (cx, cy) to every pixel on a torus."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    dx = (x - cx + size / 2) % size - size / 2
    dy = (y - cy + size / 2) % size - size / 2
    return dx, dy


def island_heights(rng, size):
    """Height field: a chain of volcanic islands running diagonally
    across the tile (wrapping, so the chain never ends), with smaller
    islets and atolls along it. Coordinates are warped by noise so the
    coastlines come out ragged, with bays and headlands."""
    height = np.zeros((size, size))

    # Warp field (periodic): bends every island's shape.
    warp_x = (fbm(rng, size, beta=2.4) - 0.5) * size * 0.07
    warp_y = (fbm(rng, size, beta=2.4) - 0.5) * size * 0.07

    # Wobbles the erosion valleys so they wander instead of running
    # dead straight.
    wander = (fbm(rng, size, beta=3.2) - 0.5) * 1.6

    # The chain runs along the tile's diagonal (it wraps around and
    # joins up with itself), wandering a little.
    count = 9
    phase = rng.uniform(0, 1)
    chain_angle = math.pi / 4

    for i in range(count):
        t = (i + rng.uniform(-0.2, 0.2)) / count
        cx = (t * size) % size
        cy = ((t + phase + 0.05 * math.sin(2 * math.pi * t * 2)) * size) % size

        # Bigger, higher islands at one end of the chain (the youngest
        # volcanoes), smaller worn-down ones toward the other.
        big = 1.0 - 0.8 * (i / (count - 1))
        sigma = size * rng.uniform(0.026, 0.04) * (0.6 + big * 0.8)
        peak = rng.uniform(0.8, 1.0) * (0.55 + big * 0.55)
        stretch = rng.uniform(1.2, 1.9)

        dx, dy = wrapped_delta(size, cx, cy)
        dx = dx + warp_x
        dy = dy + warp_y

        # Stretched along the chain.
        a = chain_angle + rng.uniform(-0.4, 0.4)
        u = dx * math.cos(a) + dy * math.sin(a)
        v = -dx * math.sin(a) + dy * math.cos(a)
        d2 = (u / (sigma * stretch)) ** 2 + (v / sigma) ** 2

        cone = np.exp(-d2 * 0.5)
        height += peak * cone

        # Valleys running down the flanks like spokes, as rain carves
        # them into old volcanoes; none at the summit or out at sea.
        spokes = rng.integers(13, 22)
        theta = np.arctan2(v, u) + wander / spokes * 2
        gully = np.power(0.5 + 0.5 * np.cos(theta * spokes), 3)
        flank = cone * (1 - cone) * 4
        height -= peak * 0.3 * gully * flank

        # A second, older volcano joined to some of them.
        if rng.uniform() < 0.55:
            off = sigma * stretch * rng.uniform(0.9, 1.5) * (1 if rng.uniform() < 0.5 else -1)
            ox = (cx + math.cos(a) * off) % size
            oy = (cy + math.sin(a) * off) % size
            ex, ey = wrapped_delta(size, ox, oy)
            ex += warp_x
            ey += warp_y
            height += peak * 0.6 * np.exp(-((ex * ex + ey * ey) / (sigma * 0.75) ** 2) * 0.5)

        # Islets and atolls trailing off the chain.
        for _ in range(rng.integers(1, 4)):
            ang = rng.uniform(0, 2 * math.pi)
            r = sigma * rng.uniform(1.8, 3.4)
            sx = (cx + math.cos(ang) * r) % size
            sy = (cy + math.sin(ang) * r) % size
            ex, ey = wrapped_delta(size, sx, sy)
            ex += warp_x * 0.4
            ey += warp_y * 0.4
            small = sigma * rng.uniform(0.16, 0.32)
            height += rng.uniform(0.35, 0.55) * np.exp(-((ex * ex + ey * ey) / small ** 2) * 0.5)

    # Ragged coasts: noise added near sea level (it barely changes the
    # open ocean or the peaks).
    rough = fbm(rng, size, beta=2.5)
    coast = np.exp(-((height - 0.42) / 0.09) ** 2)
    height = height + (rough - 0.5) * 0.22 * coast

    # (A little broad unevenness inland.)
    lumps = fbm(rng, size, beta=3.2)
    height = height + (lumps - 0.5) * 0.04 * smoothstep(0.45, 0.8, height)

    return height


def hillshade(height, strength):
    """Light from the upper left (north-west), like the clouds' shadows."""
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5

    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)

    light = np.array([-0.55, -0.55, 0.63])
    light /= np.linalg.norm(light)

    return (nx * light[0] + ny * light[1] + nz * light[2]) / length


def make_ground(rng):
    size = GROUND_SIZE
    h = island_heights(rng, size)

    sea = 0.42
    land = h > sea

    # ---- Ocean ----------------------------------------------------
    deep = rgb("#0a2340")
    open_sea = rgb("#0f3558")
    shelf = rgb("#16607a")
    lagoon = rgb("#2aa3a6")

    swell = fbm(rng, size, beta=2.8)
    ripples = fbm(rng, size, beta=1.7)

    color = lerp(deep, open_sea, smoothstep(0.25, 0.75, swell))

    # Shallower water near the islands: the submerged slopes, then
    # bright lagoons and reefs right at the shore.
    near = np.clip(h / sea, 0, 1)
    color = lerp(color, shelf, smoothstep(0.35, 0.8, near) * 0.85)
    color = lerp(color, lagoon, smoothstep(0.82, 0.99, near) * 0.9)

    # Reef rings: a thin bright band offshore.
    reef = np.exp(-((near - 0.9) / 0.025) ** 2) * (0.4 + 0.6 * ripples)
    color = lerp(color, rgb("#5fd0c4"), reef * 0.35)

    # Fine texture on the water.
    color *= (0.96 + 0.08 * ripples)[..., None]

    # ---- Land -----------------------------------------------------
    elevation = np.clip((h - sea) / (h.max() - sea), 0, 1)
    jungle = fbm(rng, size, beta=3.0)

    sand = rgb("#c9b98a")
    lowland = rgb("#3f7a3a")
    forest = rgb("#24502a")
    upland = rgb("#5b6236")
    rock = rgb("#5e5248")
    lava = rgb("#2b2522")

    land_color = lerp(lowland, forest, smoothstep(0.3, 0.7, jungle) * 0.5)
    land_color = lerp(land_color, upland, smoothstep(0.35, 0.6, elevation))
    land_color = lerp(land_color, rock, smoothstep(0.6, 0.8, elevation))
    land_color = lerp(land_color, lava, smoothstep(0.82, 0.95, elevation) * 0.8)

    # Beaches.
    beach = 1.0 - smoothstep(0.0, 0.035, elevation)
    land_color = lerp(land_color, sand, beach)

    # Relief.
    # Relief, from a slightly smoothed height so it reads as slopes and
    # ridges rather than grain. Valleys a little darker and greener.
    smooth_h = blur(h, 2.5)
    shade = hillshade(smooth_h, strength=size * 1.2)
    land_color *= (0.45 + 0.75 * np.clip(shade, 0, 1))[..., None]

    color = np.where(land[..., None], land_color, color)

    # Surf: a soft white line where the waves break.
    shore = np.exp(-((blur(h, 1.0) - sea) / 0.008) ** 2)
    color = lerp(color, rgb("#e8f3f2"), shore * 0.5)

    # ---- Seen through the atmosphere --------------------------------
    # From orbit everything is softened by a thin blue haze, and kept
    # fairly dark so the ships and rocks stand out against it.
    color = lerp(color, rgb("#2a4a6a"), np.full(h.shape, 0.18))
    color *= 0.82

    image = Image.fromarray((np.clip(color, 0, 1) * 255).astype(np.uint8), "RGB")
    image.save(os.path.join(OUT, "bg_orbit_ground.jpg"), quality=86, optimize=True, progressive=True)


# ------------------------------------------------------------
# Clouds
# ------------------------------------------------------------

def make_clouds(rng):
    size = CLOUD_SIZE

    coverage = fbm(rng, size, beta=3.2)
    puff = fbm(rng, size, beta=2.4)
    detail = fbm(rng, size, beta=1.9)

    # Mostly clear sky with drifting fields of cumulus: big soft shapes
    # from the low-frequency noise, puffy edges from the rest.
    density = coverage * 0.72 + puff * 0.28
    cloud = smoothstep(0.56, 0.74, density) * (0.78 + 0.22 * detail)
    cloud = np.clip(blur(cloud, 1.2), 0, 1)

    # Puffy tops lit from the north-west; greyer underneath.
    tops = hillshade(blur(cloud, 3.0), strength=size * 0.12)
    shade = 0.74 + 0.3 * np.clip(tops, 0, 1)

    white = np.stack([shade * 0.97, shade * 0.98, shade], axis=-1)
    alpha = np.clip(cloud * 0.95, 0, 0.85)

    # Shadows on the sea below, offset away from the sun.
    offset = int(size * 0.014)
    shadow = blur(np.roll(np.roll(cloud, offset, axis=0), offset, axis=1), 3.0)
    shadow_alpha = np.clip(shadow * 0.42 - alpha, 0, 1)

    # Composite the cloud over its own shadow.
    out_alpha = alpha + shadow_alpha * (1 - alpha)
    out_rgb = (white * alpha[..., None] + np.array([0.02, 0.05, 0.09]) * (shadow_alpha * (1 - alpha))[..., None])
    out_rgb = out_rgb / np.maximum(out_alpha, 1e-4)[..., None]

    rgba = np.dstack([np.clip(out_rgb, 0, 1), np.clip(out_alpha, 0, 1)])
    Image.fromarray((rgba * 255).astype(np.uint8), "RGBA").save(
        os.path.join(OUT, "bg_orbit_clouds.png"), optimize=True
    )


# ------------------------------------------------------------
# High haze: thin cirrus streaks (nothing point-like: no glints or
# satellites, which would look like stars shining up from the sea)
# ------------------------------------------------------------

def make_haze(rng):
    size = HAZE_SIZE

    streaks = stretched_fbm(rng, size, beta=2.4, stretch=6.0)
    patches = fbm(rng, size, beta=2.8)

    cirrus = smoothstep(0.5, 0.82, streaks) * smoothstep(0.4, 0.72, patches)
    alpha = blur(cirrus, 1.0) * 0.38

    rgba = np.zeros((size, size, 4))
    rgba[..., 0] = 0.86
    rgba[..., 1] = 0.93
    rgba[..., 2] = 1.0
    rgba[..., 3] = np.clip(alpha, 0, 1)

    Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), "RGBA").save(
        os.path.join(OUT, "bg_orbit_haze.png"), optimize=True
    )


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(SEED)

    make_ground(rng)
    make_clouds(rng)
    make_haze(rng)

    print("Wrote bg_orbit_ground.jpg, bg_orbit_clouds.png and bg_orbit_haze.png to", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
