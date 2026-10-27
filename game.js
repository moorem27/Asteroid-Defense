// Both imports resolve through the import map in index.html, so the
// game and GLTFLoader share a single copy of Three.js.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";


// ============================================================
// ASTEROID DEFENSE
// Browser game using Blender-generated GLB models.
// Controls: WASD / arrows to move, mouse to aim, click / space
// to fire.
// ============================================================

// Cached element lookup. Several elements are read every frame.
// Missing elements (null) are not cached, so they can appear later.
// Shown in the browser console at startup, so it is easy to confirm
// which version of game.js the browser is actually running.
const GAME_BUILD = "retro-thrusters-1";
window.ASTEROID_DEFENSE_BUILD = GAME_BUILD;

const domCache = Object.create(null);
const $ = (id) => (domCache[id] ??= document.getElementById(id));

const container = $("game-container");
const loader = new GLTFLoader();

const scene = new THREE.Scene();
// ============================================================
// RESPONSIVE SYNTHWAVE SPACE BACKGROUND
// Preserves the original image proportions in portrait and
// landscape orientations without stretching or compression.
// ============================================================

scene.background = new THREE.Color(0x050713);

const backgroundLoader = new THREE.TextureLoader();

// The original single image, used only if the parallax layers
// (blender/generate_background.py) have not been generated.
function loadLegacyBackground() {
    backgroundLoader.load(
        './assets/background_space.png',

        (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;

            // Preserve the original image proportions.
            texture.mapping = THREE.UVMapping;

            // Stretch neither the image nor its contents.
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;

            scene.background = texture;

            // Recalculate the background whenever the viewport changes.
            updateBackgroundOrientation();

            console.log('Responsive synthwave background loaded.');
        },

        undefined,

        (error) => {
            console.error('Failed to load synthwave background:', error);
            scene.background = new THREE.Color(0x050713);
        }
    );
}

// ============================================================
// PARALLAX BACKGROUND
// Three seamless, tiling layers that repeat forever. Each scrolls
// at a fraction of the camera's movement (`factor`): the nebula
// barely moves, the near stars move the most. That difference in
// speed is what makes the ship feel like it is travelling through
// deep space as the camera follows it.
//
// factor: 0 = fixed to the screen, 1 = moves with the playfield
// tile:   how many world units one copy of the image covers
// ============================================================

const PARALLAX_LAYERS = [
    {
        file: "bg_nebula.png",
        factor: 0.15,
        tile: 90,
        opacity: 1,
        transparent: false,
        y: -6
    },
    {
        file: "bg_stars_far.png",
        factor: 0.4,
        tile: 55,
        opacity: 0.9,
        transparent: true,
        y: -5
    },
    {
        file: "bg_stars_near.png",
        factor: 0.7,
        tile: 70,
        opacity: 1,
        transparent: true,
        y: -4
    }
];

const parallaxMeshes = [];

// Shared by every layer: a 1x1 plane lying flat in the playfield,
// facing the camera. Each layer scales it to cover the view.
const parallaxGeometry = new THREE.PlaneGeometry(1, 1);
parallaxGeometry.rotateX(-Math.PI / 2);

function loadParallaxBackground() {
    let loaded = 0;
    let failed = false;

    PARALLAX_LAYERS.forEach((layer, index) => {
        backgroundLoader.load(
            `./assets/${layer.file}`,

            (texture) => {
                if (failed) return;

                texture.colorSpace = THREE.SRGBColorSpace;
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: layer.transparent,
                    opacity: layer.opacity,
                    // Always behind the game, never hides it.
                    depthWrite: false,
                    fog: false,
                    toneMapped: false
                });

                const mesh = new THREE.Mesh(parallaxGeometry, material);
                mesh.name = `Parallax_${layer.file}`;
                mesh.renderOrder = -10 + index;
                mesh.frustumCulled = false;
                mesh.userData.layer = layer;

                scene.add(mesh);
                parallaxMeshes.push(mesh);

                loaded++;

                // Once the opaque nebula is in, the flat background
                // color is no longer needed.
                if (loaded === PARALLAX_LAYERS.length) {
                    console.log("Parallax background loaded.");
                }

                updateParallax();
            },

            undefined,

            () => {
                if (failed) return;

                failed = true;

                console.warn(
                    `Parallax layer ${layer.file} not found; using ` +
                    "background_space.png instead. Run " +
                    "blender/generate_background.py to create the layers."
                );

                for (const mesh of parallaxMeshes) {
                    scene.remove(mesh);
                    mesh.material.map.dispose();
                    mesh.material.dispose();
                }

                parallaxMeshes.length = 0;

                loadLegacyBackground();
            }
        );
    });
}

// Keep every layer centered on the camera, sized to the view, and
// scroll its texture by `factor` times the camera's position.
function updateParallax() {
    if (parallaxMeshes.length === 0) return;

    // A little extra so screen shake never reveals an edge.
    const width = (camera.right - camera.left) * 1.1;
    const height = (camera.top - camera.bottom) * 1.1;

    for (const mesh of parallaxMeshes) {
        const layer = mesh.userData.layer;
        const texture = mesh.material.map;

        mesh.position.set(cameraRig.x, layer.y, cameraRig.z);
        mesh.scale.set(width, 1, height);

        texture.repeat.set(width / layer.tile, height / layer.tile);

        // Screen right is world +X; screen up is world -Z.
        texture.offset.set(
            (layer.factor * cameraRig.x - width / 2) / layer.tile,
            (-layer.factor * cameraRig.z - height / 2) / layer.tile
        );
    }
}

loadParallaxBackground();

// ------------------------------------------------------------
// SPACE DUST
// Faint specks fixed to the playfield itself. They stream past at
// exactly the ship's speed, which is the strongest cue that the
// ship is really travelling (the parallax layers above move slower
// to look distant). Drawn in code, so no asset file is needed.
//
// One tile of dust is wrapped around the camera: each speck is
// shown at whichever copy of its tile position is nearest the
// camera, so the field never runs out.
// ------------------------------------------------------------

const DUST_CONFIG = {
    count: 320,

    // Pixel size of each speck.
    size: 2.2,

    opacity: 0.55,
    color: 0xa9c8ff
};

const dustBase = new Float32Array(DUST_CONFIG.count * 2);
const dustPositions = new Float32Array(DUST_CONFIG.count * 3);

for (let i = 0; i < DUST_CONFIG.count; i++) {
    // Positions within one tile, as fractions (0-1).
    dustBase[i * 2] = Math.random();
    dustBase[i * 2 + 1] = Math.random();

    dustPositions[i * 3 + 1] = -0.5;
}

const dustGeometry = new THREE.BufferGeometry();
const dustAttribute = new THREE.BufferAttribute(dustPositions, 3);
dustGeometry.setAttribute("position", dustAttribute);

const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
        color: DUST_CONFIG.color,
        size: DUST_CONFIG.size,
        sizeAttenuation: false,
        transparent: true,
        opacity: DUST_CONFIG.opacity,
        depthWrite: false,
        fog: false
    })
);

dust.name = "SpaceDust";
dust.frustumCulled = false;
dust.renderOrder = -5;

scene.add(dust);

function updateDust() {
    // The tile must be at least as big as the view, so every speck
    // has exactly one copy on screen.
    const tile = Math.max(
        camera.right - camera.left,
        camera.top - camera.bottom
    ) + 6;

    for (let i = 0; i < DUST_CONFIG.count; i++) {
        const baseX = dustBase[i * 2] * tile;
        const baseZ = dustBase[i * 2 + 1] * tile;

        // Nearest copy of this speck to the camera.
        dustPositions[i * 3] =
            baseX + tile * Math.round((cameraRig.x - baseX) / tile);

        dustPositions[i * 3 + 2] =
            baseZ + tile * Math.round((cameraRig.z - baseZ) / tile);
    }

    dustAttribute.needsUpdate = true;
}

// Adjust the background to the viewport's orientation.
function updateBackgroundOrientation() {
    if (!scene.background || !scene.background.isTexture) {
        return;
    }

    const texture = scene.background;

    const image = texture.image;

    if (!image || !image.width || !image.height) {
        return;
    }

    const imageAspect = image.width / image.height;
    const screenAspect = window.innerWidth / window.innerHeight;

    // Reset the texture before calculating the new viewport.
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);

    if (screenAspect < imageAspect) {
        // Portrait or narrow viewport:
        // Show a centered, uncompressed portion of the image.
        const visibleWidth = screenAspect / imageAspect;

        texture.repeat.x = visibleWidth;
        texture.offset.x = (1 - visibleWidth) / 2;
    } else {
        // Landscape or wide viewport:
        // Show a centered, uncompressed portion of the image.
        const visibleHeight = imageAspect / screenAspect;

        texture.repeat.y = visibleHeight;
        texture.offset.y = (1 - visibleHeight) / 2;
    }

    // Offset and repeat only change the UV transform, so the image
    // does not need to be re-uploaded to the GPU.
}
scene.fog = new THREE.FogExp2(0x050713, 0.006);
// The camera looks straight down onto the XZ playfield.
const camera = new THREE.OrthographicCamera(
    -25, 25, 16, -16, 0.1, 150
);

camera.position.set(0, 55, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance"
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

container.appendChild(renderer.domElement);

// ------------------------------------------------------------
// WORLD
// ------------------------------------------------------------

// The world is WORLD_SCALE times the size of the original
// single-screen arena in each direction. The camera follows the
// ship (see FOLLOW CAMERA below), so the player can fly across all
// of it: at 10 it takes about 13 seconds at full speed to reach an
// edge from the center. Set WORLD_SCALE to 1 for the original
// fixed, single-screen arena.
const WORLD_SCALE = 10;

const WORLD_W = 46 * WORLD_SCALE;
const WORLD_H = 29 * WORLD_SCALE;
const HALF_W = WORLD_W / 2;
const HALF_H = WORLD_H / 2;

scene.add(new THREE.HemisphereLight(0x8bdcff, 0x120d35, 2.1));

const ambient = new THREE.AmbientLight(0x8299ff, 0.65);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0x73faff, 2.0);
keyLight.position.set(-8, 20, -8);
scene.add(keyLight);

// Neon perimeter lines.
function makeLine(points, color, opacity = 0.65) {
    const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map(p => new THREE.Vector3(p[0], 0, p[1]))
    );

    const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity
        })
    );

    scene.add(line);
    return line;
}

makeLine([
    [-HALF_W, -HALF_H],
    [HALF_W, -HALF_H],
    [HALF_W, HALF_H],
    [-HALF_W, HALF_H],
    [-HALF_W, -HALF_H]
], 0x32dce8, 0.85);

// ------------------------------------------------------------
// FOLLOW CAMERA
// The camera glides after the ship (leading slightly in the
// direction it is flying) and stops at the world's edge, so the
// border is only seen when the ship is near it.
// ------------------------------------------------------------

const CAMERA_CONFIG = {
    // Higher = the camera catches up with the ship faster.
    followSharpness: 5,

    // Seconds of velocity to look ahead of the ship. At exactly
    // 1 / followSharpness the lead cancels the follow lag, so the
    // ship stays centered while cruising and the screen does not
    // slide around under a resting cursor.
    lookAhead: 0.2
};

// Where the camera is centered, before any screen shake.
const cameraRig = { x: 0, z: 0 };

function viewHalfWidth() {
    return camera.right;
}

function viewHalfHeight() {
    return camera.top;
}

function updateCameraRig(dt, snap = false) {
    let targetX = player.position.x + player.velocity.x * CAMERA_CONFIG.lookAhead;
    let targetZ = player.position.z + player.velocity.z * CAMERA_CONFIG.lookAhead;

    // Keep the view inside the world (centered if the world is
    // smaller than the screen).
    const limitX = Math.max(0, HALF_W - viewHalfWidth());
    const limitZ = Math.max(0, HALF_H - viewHalfHeight());

    targetX = clamp(targetX, -limitX, limitX);
    targetZ = clamp(targetZ, -limitZ, limitZ);

    if (snap) {
        cameraRig.x = targetX;
        cameraRig.z = targetZ;
        return;
    }

    const blend = 1 - Math.exp(-CAMERA_CONFIG.followSharpness * dt);

    cameraRig.x += (targetX - cameraRig.x) * blend;
    cameraRig.z += (targetZ - cameraRig.z) * blend;
}

// A random point on the edge of the visible screen (it may lie
// outside the world when the view touches the world's border).
function viewBoundaryPosition() {
    const hw = viewHalfWidth();
    const hh = viewHalfHeight();
    const edge = Math.floor(Math.random() * 4);

    if (edge === 0) {
        return new THREE.Vector3(cameraRig.x + randomRange(-hw, hw), 0, cameraRig.z - hh);
    }

    if (edge === 1) {
        return new THREE.Vector3(cameraRig.x + randomRange(-hw, hw), 0, cameraRig.z + hh);
    }

    if (edge === 2) {
        return new THREE.Vector3(cameraRig.x - hw, 0, cameraRig.z + randomRange(-hh, hh));
    }

    return new THREE.Vector3(cameraRig.x + hw, 0, cameraRig.z + randomRange(-hh, hh));
}

// A random point just off the visible screen, inside the world,
// so enemies arrive from out of view. Only sides with room inside
// the world are used; if the whole world fits on screen, it falls
// back to the world's edge (the original behavior).
function offscreenSpawnPosition(margin = 2.5) {
    const hw = viewHalfWidth();
    const hh = viewHalfHeight();
    const cx = cameraRig.x;
    const cz = cameraRig.z;

    const sides = [];

    if (cz - hh - margin > -HALF_H) sides.push("top");
    if (cz + hh + margin < HALF_H) sides.push("bottom");
    if (cx - hw - margin > -HALF_W) sides.push("left");
    if (cx + hw + margin < HALF_W) sides.push("right");

    if (sides.length === 0) {
        return randomEdgePosition();
    }

    const side = sides[Math.floor(Math.random() * sides.length)];

    const alongX = clamp(cx + randomRange(-hw, hw), -HALF_W, HALF_W);
    const alongZ = clamp(cz + randomRange(-hh, hh), -HALF_H, HALF_H);

    if (side === "top") return new THREE.Vector3(alongX, 0, cz - hh - margin);
    if (side === "bottom") return new THREE.Vector3(alongX, 0, cz + hh + margin);
    if (side === "left") return new THREE.Vector3(cx - hw - margin, 0, alongZ);

    return new THREE.Vector3(cx + hw + margin, 0, alongZ);
}

// A random point just inside the visible screen's edge (for
// crystals, which don't move and so must appear where they can be
// seen).
function onscreenEdgePosition(inset = 2.5) {
    const hw = Math.max(0, viewHalfWidth() - inset);
    const hh = Math.max(0, viewHalfHeight() - inset);
    const edge = Math.floor(Math.random() * 4);

    let x = cameraRig.x;
    let z = cameraRig.z;

    if (edge === 0) { x += randomRange(-hw, hw); z -= hh; }
    else if (edge === 1) { x += randomRange(-hw, hw); z += hh; }
    else if (edge === 2) { x -= hw; z += randomRange(-hh, hh); }
    else { x += hw; z += randomRange(-hh, hh); }

    return new THREE.Vector3(
        clamp(x, -HALF_W + 1, HALF_W - 1),
        0,
        clamp(z, -HALF_H + 1, HALF_H - 1)
    );
}

// Starfield.
const starCount = 1200;
const starPositions = new Float32Array(starCount * 3);
const starColors = new Float32Array(starCount * 3);

for (let i = 0; i < starCount; i++) {
    const i3 = i * 3;

    starPositions[i3] = (Math.random() - 0.5) * 180;
    starPositions[i3 + 1] = -0.05 - Math.random() * 0.02;
    starPositions[i3 + 2] = (Math.random() - 0.5) * 180;

    const c = new THREE.Color().setHSL(
        0.48 + Math.random() * 0.18,
        0.55,
        0.48 + Math.random() * 0.5
    );

    starColors[i3] = c.r;
    starColors[i3 + 1] = c.g;
    starColors[i3 + 2] = c.b;
}

const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3)
);
starGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(starColors, 3)
);

const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
        size: 0.14,
        vertexColors: true,
        sizeAttenuation: true
    })
);

//scene.add(stars);

// ------------------------------------------------------------
// ASSET LOADING
// ------------------------------------------------------------

const assets = {};

// The player's ship (blender/generate_starfighter.py). If it has not
// been generated yet, the original spaceship.glb is used instead.
const SHIP_MODEL = "starfighter.glb";
const SHIP_FALLBACK_MODEL = "spaceship.glb";

const assetFiles = {
    ship: SHIP_MODEL,

    asteroid1: "asteroid_01.glb",
    asteroid2: "asteroid_02.glb",
    asteroid3: "asteroid_03.glb",

    crystal: "energy_crystal.glb",
    mine: "space_mine.glb",

    // Afterburner effects
    afterburnerBoost: "afterburner_boost.glb",
    afterburnerCore: "afterburner_core.glb",
    afterburnerGlow: "afterburner_glow.glb",
    afterburnerMain: "afterburner_main.glb",
    afterburnerRing: "afterburner_ring.glb",
    afterburnerShort: "afterburner_short.glb",
    afterburnerStreaks: "afterburner_streaks.glb",

    // Warp bubble effects
    warpCore: "warp_bubble_core.glb",
    warpArcs: "warp_bubble_arcs.glb",
    warpImpact: "warp_bubble_impact.glb",
    warpPulse: "warp_bubble_pulse.glb",
    warpRipple: "warp_bubble_ripple.glb",
    warpShimmer: "warp_bubble_shimmer.glb",

    // Black hole event (blender/generate_black_hole.py)
    bhShadow: "gargantua_shadow.glb",
    bhPhotonRing: "gargantua_photon_ring.glb",
    bhHalo: "gargantua_halo.glb",
    bhDiskBack: "gargantua_disk_back.glb",
    bhDiskFront: "gargantua_disk_front.glb",
    bhDiskStreaks: "gargantua_disk_streaks.glb",
    bhTidalStream: "gargantua_tidal_stream.glb",
    bhSpark: "gargantua_spark.glb",
    bhFlare: "gargantua_flare.glb",

    // Weapon upgrades (blender/generate_weapons.py)
    laserBeam: "laser_beam.glb",
    laserEmitter: "laser_emitter.glb",
    laserImpact: "laser_impact.glb",
    rocket: "rocket.glb",
    rocketFlame: "rocket_flame.glb",
    smokeTrail: "smoke_trail.glb",
    smokePuff: "smoke_puff.glb",
    rocketShockwave: "rocket_shockwave.glb",

    // "Blue moon" rogue asteroid (blender/generate_rogue_asteroid.py)
    rogueAsteroid: "rogue_asteroid.glb",
    rogueBowShock: "rogue_bow_shock.glb",
    rogueTail: "rogue_tail.glb",
    vaporRibbon: "vapor_ribbon.glb",
    vaporPuff: "vapor_puff.glb",
    rogueWarning: "rogue_warning.glb",

    // Reverse (retro) thrusters (blender/generate_retro_thrusters.py)
    retroJet: "retro_jet.glb",
    retroGlow: "retro_glow.glb",
    retroPuff: "retro_puff.glb"
};

// Cosmetic extras: if one of these files is missing, the game still
// runs and the effect is simply skipped.
const OPTIONAL_ASSETS = new Set(["retroJet", "retroGlow", "retroPuff"]);

function loadGLB(filename) {
    return new Promise((resolve, reject) => {
        loader.load(
            `assets/${filename}`,
            (gltf) => resolve(gltf.scene),
            undefined,
            (error) => reject(
                new Error(`Could not load assets/${filename}: ${error.message || error}`)
            )
        );
    });
}

async function loadAssets() {
    // Load every model in parallel instead of one after another.
    await Promise.all(
        Object.entries(assetFiles).map(async ([key, filename]) => {
            try {
                assets[key] = await loadGLB(filename);
            } catch (error) {
                if (OPTIONAL_ASSETS.has(key)) {
                    console.warn(
                        `${filename} not found; skipping that effect. ` +
                        "Run blender/generate_retro_thrusters.py to create it."
                    );
                    return;
                }

                // Only the ship has a fallback model.
                if (key !== "ship") throw error;

                console.warn(
                    `${filename} not found; using ${SHIP_FALLBACK_MODEL}. ` +
                    "Run blender/generate_starfighter.py to create it."
                );

                assets[key] = await loadGLB(SHIP_FALLBACK_MODEL);
                filename = SHIP_FALLBACK_MODEL;
            }

            console.info("Loaded Blender model:", filename);
        })
    );
}

// Give a cloned model its own materials so changes to opacity
// (the black hole fade) cannot leak into other instances or into
// the source asset.
function ownMaterials(mesh) {
    mesh.traverse((child) => {
        if (!child.isMesh) return;

        child.material = Array.isArray(child.material)
            ? child.material.map((material) => material.clone())
            : child.material.clone();
    });

    mesh.userData.ownsMaterials = true;
}

// Remove a mesh from the scene and free any materials it owns.
// Shared GLB geometry is never disposed here.
function discardMesh(mesh) {
    if (!mesh) return;

    scene.remove(mesh);

    if (!mesh.userData.ownsMaterials) return;

    mesh.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material?.dispose();
        }
    });
}

function cloneModel(key) {
    const source = assets[key];

    if (!source) {
        throw new Error(`Asset "${key}" is not loaded.`);
    }

    return source.clone(true);
}

// ------------------------------------------------------------
// SHARED MATERIALS AND HELPERS
// ------------------------------------------------------------

// ------------------------------------------------------------
// BLACK HOLE OBJECT FADE
// Gradually fades model materials as objects shrink.
// ------------------------------------------------------------

function fadeObjectTowardBlackHole(mesh, shrinkFactor) {
    if (!mesh) return;

    mesh.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            if (!material) continue;

            // Save the original material properties once.
            if (material.userData.originalOpacity === undefined) {
                material.userData.originalOpacity =
                    material.opacity;

                material.userData.originalTransparent =
                    material.transparent;
            }

            const originalOpacity =
                material.userData.originalOpacity;

            // Begin fading when the object becomes noticeably smaller.
            const fadeProgress = THREE.MathUtils.clamp(
                (0.65 - shrinkFactor) / 0.65,
                0,
                1
            );

            // Switching to transparent changes the shader, so request a
            // rebuild only on that switch, not on every frame.
            if (!material.transparent) {
                material.transparent = true;
                material.needsUpdate = true;
            }

            material.opacity =
                originalOpacity * (1 - fadeProgress);

            material.depthWrite = material.opacity > 0.5;
        }
    });
}


const bulletMaterial = new THREE.MeshBasicMaterial({
    color: 0x7affff
});

const bulletGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0x35eaff,
    transparent: true,
    opacity: 0.28
});

const projectileGeometry = new THREE.SphereGeometry(0.105, 8, 6);
const projectileGlowGeometry = new THREE.SphereGeometry(0.23, 8, 6);

// Shared geometry for effects that were previously rebuilt per spawn.
const pickupGlowGeometry = new THREE.SphereGeometry(0.7, 12, 8);
const explosionGeometry = new THREE.SphereGeometry(0.4, 12, 8);

const pickupGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0x3bff9d,
    transparent: true,
    opacity: 0.25
});

const explosionMaterial = new THREE.MeshBasicMaterial({
    color: 0xff9d54,
    transparent: true,
    opacity: 0.9
});

const particleMaterial = new THREE.MeshBasicMaterial({
    color: 0xffdd85
});

const clock = new THREE.Clock();

const worldPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    0
);

const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();

const mouseWorld = new THREE.Vector3();

function randomRange(min, max) {
    return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randomEdgePosition() {
    const edge = Math.floor(Math.random() * 4);

    if (edge === 0) {
        return new THREE.Vector3(
            randomRange(-HALF_W, HALF_W), 0, -HALF_H
        );
    }

    if (edge === 1) {
        return new THREE.Vector3(
            randomRange(-HALF_W, HALF_W), 0, HALF_H
        );
    }

    if (edge === 2) {
        return new THREE.Vector3(
            -HALF_W, 0, randomRange(-HALF_H, HALF_H)
        );
    }

    return new THREE.Vector3(
        HALF_W, 0, randomRange(-HALF_H, HALF_H)
    );
}

// ------------------------------------------------------------
// INPUT
// ------------------------------------------------------------

const keys = Object.create(null);

let firing = false;
let steeringMode = "mouse";
let pointerSteering = false;

let pointerDown = false;
let pointerDragged = false;
let pointerStartX = 0;
let pointerStartY = 0;

const DRAG_THRESHOLD = 8;

// The camera now moves, so the point under a still cursor changes
// every frame. Remember the cursor's screen position and re-project
// it after the camera moves.
let pointerKnown = false;

function refreshAim() {
    if (!pointerKnown) return;

    camera.updateMatrixWorld();
    raycaster.setFromCamera(mouseNDC, camera);

    const hit = raycaster.ray.intersectPlane(worldPlane, mouseWorld);

    if (hit) {
        player.aim.copy(hit);
    }
}

window.addEventListener("keydown", (event) => {
    keys[event.code] = true;
    if (
        event.code === "KeyA" ||
        event.code === "KeyD" ||
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight"
    ) {
        steeringMode = "keyboard";
    }

    if (
        event.code === "Space" ||
        event.code.startsWith("Arrow")
    ) {
        event.preventDefault();
    }

    if (event.code === "Space") {
        firing = true;
    }

    if (
        event.code === "Enter" &&
        !state.running &&
        !state.loading
    ) {
        startGame();
    }
});

window.addEventListener("keyup", (event) => {
    keys[event.code] = false;

    if (event.code === "Space") {
        firing = false;
    }
});

renderer.domElement.style.touchAction = "none";

renderer.domElement.addEventListener("pointermove", (event) => { const rect = renderer.domElement.getBoundingClientRect();

mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

pointerKnown = true;

raycaster.setFromCamera(mouseNDC, camera);

const hit = raycaster.ray.intersectPlane(worldPlane, mouseWorld);

if (hit) {
    player.aim.copy(hit);
}

if (pointerDown) {
    const dx = event.clientX - pointerStartX;
    const dy = event.clientY - pointerStartY;

    if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        pointerDragged = true;
        pointerSteering = true;
        steeringMode = "mouse";
    }
}


});

renderer.domElement.addEventListener("pointerdown", (event) => { if (event.button !== 0 && event.pointerType !== "touch") { return; }

pointerDown = true;
pointerDragged = false;
pointerSteering = false;

pointerStartX = event.clientX;
pointerStartY = event.clientY;

renderer.domElement.setPointerCapture(event.pointerId);


});

function finishPointer(event) { if (!pointerDown) return;

if (!pointerDragged && event.type === "pointerup") {
    // A tap or click fires a shot (and the laser, once unlocked).
    fireBullet();
    tryFireLaser();
}

pointerDown = false;
pointerSteering = false;
pointerDragged = false;

if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
}


}

renderer.domElement.addEventListener("pointerup", finishPointer);

renderer.domElement.addEventListener("pointercancel", (event) => { pointerDown = false; pointerSteering = false; pointerDragged = false;

if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
}


});

window.addEventListener("pointercancel", () => {
    pointerSteering = false;
    firing = false;
});

// ------------------------------------------------------------
// NO ACCIDENTAL COPY / PASTE OR ZOOM ON PHONES
// Backs up the CSS in style.css for browsers that ignore parts of
// it (older iOS Safari in particular). Nothing in the game needs
// text selection, a context menu, copy / paste or zooming.
// ------------------------------------------------------------

const blockDefault = (event) => event.preventDefault();

// Long-press menu (and right-click menu on desktop).
document.addEventListener("contextmenu", blockDefault);

// Starting a text selection, by long-press or double-tap.
document.addEventListener("selectstart", blockDefault);

// Copy / cut / paste, including from the phone's menu.
document.addEventListener("copy", blockDefault);
document.addEventListener("cut", blockDefault);
document.addEventListener("paste", blockDefault);

// Dragging text or images out of the page.
document.addEventListener("dragstart", blockDefault);

// iOS Safari's pinch-zoom gestures, which ignore user-scalable=no.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, blockDefault, { passive: false });
}

// Double-tap zoom in browsers that ignore touch-action. Taps on
// buttons are left alone so they still respond instantly.
let lastTouchEnd = 0;

document.addEventListener("touchend", (event) => {
    const now = performance.now();

    if (
        now - lastTouchEnd < 300 &&
        !event.target.closest?.("button")
    ) {
        event.preventDefault();
    }

    lastTouchEnd = now;

    // Clear any selection that slipped through anyway.
    window.getSelection?.()?.removeAllRanges();
}, { passive: false });

window.addEventListener("blur", () => {
    firing = false;
    pointerDown = false;
    pointerSteering = false;
    pointerDragged = false;

    for (const key of Object.keys(keys)) {
        keys[key] = false;
    }
});

// ------------------------------------------------------------
// GAME STATE
// ------------------------------------------------------------

const state = {
    loading: true,
    running: false,
    gameOver: false,

    score: 0,
    highScore: Number(localStorage.getItem("asteroidDefenseHighScore") || 0),

    lives: 3,
    sector: 1,

    elapsed: 0,

    // Seconds played in the current match (see MATCH_SECONDS).
    matchTime: 0,

    spawnTimer: 0,
    mineTimer: 0,
    pickupTimer: 0,
    fireCooldown: 0,
    damageCooldown: 0,

    screenShake: 0,
    restartTimer: null
};

// Writing to localStorage on every point scored is a synchronous disk
// write many times per second. Save at natural checkpoints instead.
function saveHighScore() {
    try {
        localStorage.setItem(
            "asteroidDefenseHighScore",
            String(state.highScore)
        );
    } catch {
        // Storage can be unavailable (private mode); ignore.
    }
}

window.addEventListener("pagehide", saveHighScore);

const player = {
    mesh: null,
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(),
    aim: new THREE.Vector3(0, 0, -1),

    radius: 0.85,
    speed: 15,
    rotation: 0,

    // Black hole spaghettification state.
    blackHoleData: null
};

const bullets = [];
const asteroids = [];
const mines = [];
const pickups = [];
const particles = [];
const explosions = [];

function updateHUD() {
    $("score").textContent = String(state.score).padStart(6, "0");
    $("high-score").textContent = String(state.highScore).padStart(6, "0");
    $("sector").textContent = String(state.sector).padStart(2, "0");

    $("lives").textContent =
        "♥ ".repeat(Math.max(0, state.lives)).trim() || "—";

    $("lives").style.color =
        state.lives <= 1 ? "#ff3f9f" : "#ff6dce";
}

// The match clock in the HUD: time left, e.g. "2:13". Only touches
// the page when the shown second changes (or when forced).
let shownMatchSeconds = -1;

function formatClock(seconds) {
    const whole = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function updateMatchClockHUD(force = false) {
    const left = Math.max(0, MATCH_SECONDS - state.matchTime);
    const seconds = Math.ceil(left);

    if (!force && seconds === shownMatchSeconds) return;

    shownMatchSeconds = seconds;

    const time = $("match-time");
    const box = $("match-clock");

    if (time) time.textContent = formatClock(left);

    // The last 30 seconds glow warmer.
    if (box) box.classList.toggle("final", left <= 30 && left > 0);
}

function addScore(amount) {
    state.score += amount;

    if (state.score > state.highScore) {
        state.highScore = state.score;
    }

    // (The score no longer ends the game: the black hole victory comes
    // at the end of the match. See MATCH_SECONDS.)

    // Activate the warp whenever a new WARP_SCORE_INTERVAL
    // milestone is reached.
    while (state.score >= warp.nextMilestone) {
        activateWarp();

        warp.nextMilestone += WARP_SCORE_INTERVAL;
    }

    // Unlock the laser and rockets. Checked after the warp so the
    // unlock message is the one the player sees at 50,000.
    checkWeaponUnlocks();

    updateHUD();
}

// ------------------------------------------------------------
// PLAYER
// ------------------------------------------------------------

// Drawn size of the ship. Was 0.85; 1.05 is about 25% bigger.
const SHIP_DISPLAY_SCALE = 1.15;

function createPlayer() {
    if (player.mesh) {
        scene.remove(player.mesh);
    }

    player.mesh = cloneModel("ship");
    player.mesh.position.copy(player.position);
    player.mesh.position.y = 0.3;

    // How big the ship is drawn. This is purely visual: the hit area
    // (player.radius), speed and weapon positions are unchanged, and
    // the afterburner scales with the ship automatically.
    player.mesh.scale.setScalar(SHIP_DISPLAY_SCALE);

    player.rotation = 0;
    player.mesh.rotation.y = player.rotation;

    scene.add(player.mesh);

    player.velocity.set(0, 0, 0);

    // Create and attach all seven afterburner layers.
    createAfterburners();

    // And the reverse thrusters near the nose.
    createRetroThrusters();
}

// ------------------------------------------------------------
// AFTERBURNER SYSTEM
// Seven layered GLB effects attached to the spaceship.
// ------------------------------------------------------------

const afterburners = {
    group: null,
    models: {},
    active: false,
    elapsed: 0
};

const AFTERBURNER_CONFIG = {
    // Adjust to match the scale of your Blender models.
    scale: 0.35,

    // Position behind the spaceship.
    // Assumes the ship faces local +Z.
    position: new THREE.Vector3(0, 0.05, -1.05)
};

const AFTERBURNER_ASSETS = [
    {
        key: "boost",
        asset: "afterburnerBoost",
        scale: 1.15,
        rotationSpeed: 1.8,
        pulseSpeed: 18,
        pulseAmount: 0.12
    },
    {
        key: "core",
        asset: "afterburnerCore",
        scale: 0.72,
        rotationSpeed: 0,
        pulseSpeed: 24,
        pulseAmount: 0.10
    },
    {
        key: "glow",
        asset: "afterburnerGlow",
        scale: 1.35,
        rotationSpeed: 0,
        pulseSpeed: 12,
        pulseAmount: 0.16
    },
    {
        key: "main",
        asset: "afterburnerMain",
        scale: 1.0,
        rotationSpeed: 0,
        pulseSpeed: 20,
        pulseAmount: 0.08
    },
    {
        key: "ring",
        asset: "afterburnerRing",
        scale: 1.1,
        rotationSpeed: 2.5,
        pulseSpeed: 10,
        pulseAmount: 0.06
    },
    {
        key: "short",
        asset: "afterburnerShort",
        scale: 0.8,
        rotationSpeed: 0,
        pulseSpeed: 28,
        pulseAmount: 0.13
    },
    {
        key: "streaks",
        asset: "afterburnerStreaks",
        scale: 1.2,
        rotationSpeed: -1.5,
        pulseSpeed: 16,
        pulseAmount: 0.11
    }
];

function createAfterburners() {
    if (!player.mesh) return;

    // Remove old effects if the ship is being recreated.
    if (afterburners.group) {
        player.mesh.remove(afterburners.group);
    }

    afterburners.group = new THREE.Group();
    afterburners.group.name = "AfterburnerGroup";

    afterburners.models = {};

    for (const definition of AFTERBURNER_ASSETS) {
        const model = cloneModel(definition.asset);

        model.name = `Afterburner_${definition.key}`;

        // Position the effect behind the ship.
        model.position.copy(AFTERBURNER_CONFIG.position);

        // Apply the overall scale and individual layer scale.
        model.scale.setScalar(
            AFTERBURNER_CONFIG.scale * definition.scale
        );

        // Store animation settings.
        model.userData.rotationSpeed =
            definition.rotationSpeed;

        model.userData.pulseSpeed =
            definition.pulseSpeed;

        model.userData.pulseAmount =
            definition.pulseAmount;

        model.userData.baseScale =
            AFTERBURNER_CONFIG.scale * definition.scale;

        // Hide until forward thrust begins.
        model.visible = false;

        afterburners.group.add(model);
        afterburners.models[definition.key] = model;
    }

    // Attach the entire effect to the spaceship.
    player.mesh.add(afterburners.group);

    afterburners.group.visible = false;
    afterburners.active = false;
    afterburners.elapsed = 0;
}


// ------------------------------------------------------------
// AFTERBURNER ACTIVATION
// ------------------------------------------------------------

function setAfterburnersActive(active) {
    if (!afterburners.group) return;

    if (afterburners.active === active) return;

    afterburners.active = active;
    afterburners.group.visible = active;

    for (const model of Object.values(afterburners.models)) {
        model.visible = active;

        if (active) {
            model.scale.setScalar(model.userData.baseScale);
        }
    }

    if (active) {
        afterburners.elapsed = 0;
    }
}


// ------------------------------------------------------------
// AFTERBURNER ANIMATION
// ------------------------------------------------------------

function updateAfterburners(dt) {
    if (!afterburners.active || !afterburners.group) {
        return;
    }

    afterburners.elapsed += dt;

    for (const model of Object.values(afterburners.models)) {
        const rotationSpeed = model.userData.rotationSpeed;
        const pulseSpeed = model.userData.pulseSpeed;
        const pulseAmount = model.userData.pulseAmount;
        const baseScale = model.userData.baseScale;

        // Animate rotating layers.
        model.rotation.z += rotationSpeed * dt;

        // Animate the engine pulse.
        const pulse =
            1 +
            Math.sin(afterburners.elapsed * pulseSpeed) *
            pulseAmount;

        model.scale.setScalar(baseScale * pulse);
    }
}

// ------------------------------------------------------------
// REVERSE (RETRO) THRUSTERS
// Two small, pale jets that fire forward from the nacelle intakes
// while the ship reverses, plus a few faint gas puffs left hanging
// in the air. Deliberately subtle: they fade in and out, and they
// never compete with the main afterburner.
// Assets come from blender/generate_retro_thrusters.py and are
// optional: without them, reversing simply has no effect.
// ------------------------------------------------------------

const RETRO_CONFIG = {
    // Nozzle positions in the ship's local space (the ship faces +Z).
    // These sit on the front of the starfighter's engine nacelles.
    nozzleX: 0.42,
    nozzleY: 0.1,
    nozzleZ: 0.14,

    // Jets angle slightly outward so they show beside the nose.
    outwardAngle: 0.22,

    // Overall size of the jet models, and how long a jet is
    // (models are 0.62 long at scale 1).
    scale: 1.0,
    jetLength: 0.62,

    // Peak opacity (well below 1, to keep the effect subtle).
    jetOpacity: 0.7,
    glowOpacity: 0.85,

    // How fast the effect fades in and out.
    fadeIn: 14,
    fadeOut: 9,

    // Gas puffs: one per nozzle every puffInterval seconds.
    puffInterval: 0.11,
    puffLife: 0.55,
    puffScale: 0.16,
    puffOpacity: 0.35,
    puffSpeed: 3.2
};

const retroThrusters = {
    group: null,
    jets: [],
    glows: [],
    active: false,
    level: 0,
    elapsed: 0,
    puffTimer: 0
};

const retroPuffs = [];
const retroPuffPool = [];

// Clone a model with its own transparent, glowing materials, so its
// opacity can be animated without affecting the source asset.
function cloneGlowModel(key) {
    const model = cloneModel(key);

    ownMaterials(model);

    model.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material.transparent = true;
            material.depthWrite = false;
            material.blending = THREE.AdditiveBlending;
            material.opacity = 0;
        }
    });

    return model;
}

function setModelOpacity(model, opacity) {
    model.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material.opacity = opacity;
        }
    });
}

function disposeOwnedMaterials(model) {
    model.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material?.dispose();
        }
    });
}

function createRetroThrusters() {
    if (!player.mesh) return;

    // Free the previous ship's effect materials.
    if (retroThrusters.group) {
        retroThrusters.group.parent?.remove(retroThrusters.group);
        disposeOwnedMaterials(retroThrusters.group);
    }

    retroThrusters.group = null;
    retroThrusters.jets = [];
    retroThrusters.glows = [];
    retroThrusters.active = false;
    retroThrusters.level = 0;
    retroThrusters.elapsed = 0;
    retroThrusters.puffTimer = 0;

    if (!assets.retroJet) return;

    const group = new THREE.Group();
    group.name = "RetroThrusterGroup";

    for (const side of [-1, 1]) {
        const jet = cloneGlowModel("retroJet");

        jet.name = side < 0 ? "RetroJet_Left" : "RetroJet_Right";
        jet.position.set(
            side * RETRO_CONFIG.nozzleX,
            RETRO_CONFIG.nozzleY,
            RETRO_CONFIG.nozzleZ
        );
        jet.rotation.y = side * RETRO_CONFIG.outwardAngle;
        jet.scale.setScalar(0.001);
        jet.userData.side = side;

        group.add(jet);
        retroThrusters.jets.push(jet);

        if (assets.retroGlow) {
            const glow = cloneGlowModel("retroGlow");

            glow.position.copy(jet.position);
            glow.rotation.y = jet.rotation.y;
            glow.scale.setScalar(RETRO_CONFIG.scale);

            group.add(glow);
            retroThrusters.glows.push(glow);
        }
    }

    group.visible = false;
    player.mesh.add(group);
    retroThrusters.group = group;
}

function setRetroThrustersActive(active) {
    retroThrusters.active = active;
}

function updateRetroThrusters(dt) {
    updateRetroPuffs(dt);

    const group = retroThrusters.group;

    if (!group) return;

    // Fade toward on or off rather than snapping.
    const target = retroThrusters.active && player.mesh ? 1 : 0;

    retroThrusters.level = THREE.MathUtils.damp(
        retroThrusters.level,
        target,
        target > retroThrusters.level
            ? RETRO_CONFIG.fadeIn
            : RETRO_CONFIG.fadeOut,
        dt
    );

    if (target === 0 && retroThrusters.level < 0.01) {
        retroThrusters.level = 0;
    }

    const level = retroThrusters.level;

    group.visible = level > 0;

    if (!group.visible) {
        retroThrusters.puffTimer = 0;
        return;
    }

    retroThrusters.elapsed += dt;

    const t = retroThrusters.elapsed;

    for (const jet of retroThrusters.jets) {
        // A soft, slightly uneven flicker per side.
        const flicker =
            0.86 +
            Math.sin(t * 31 + jet.userData.side * 1.7) * 0.07 +
            Math.sin(t * 53 + jet.userData.side) * 0.05;

        const s = RETRO_CONFIG.scale;

        jet.scale.set(
            s * (0.75 + level * 0.25),
            s * (0.75 + level * 0.25),
            s * Math.max(0.001, level * flicker)
        );

        setModelOpacity(jet, RETRO_CONFIG.jetOpacity * level * flicker);
    }

    for (const glow of retroThrusters.glows) {
        setModelOpacity(
            glow,
            RETRO_CONFIG.glowOpacity * level *
                (0.85 + Math.sin(t * 40) * 0.15)
        );
    }

    // Leave a few faint gas puffs while firing.
    if (!retroThrusters.active || !assets.retroPuff || !player.mesh) {
        return;
    }

    retroThrusters.puffTimer -= dt;

    if (retroThrusters.puffTimer > 0) return;

    retroThrusters.puffTimer = RETRO_CONFIG.puffInterval;

    for (const jet of retroThrusters.jets) {
        spawnRetroPuff(jet);
    }
}

// Spawn a puff near the tip of a jet, in world space.
function spawnRetroPuff(jet) {
    const heading = player.mesh.rotation.y;
    const shipScale = player.mesh.scale.x;

    // Direction the jet fires, in world space.
    const jetHeading = heading + jet.rotation.y;
    const dirX = Math.sin(jetHeading);
    const dirZ = Math.cos(jetHeading);

    // Nozzle position, rotated into world space.
    const lx = jet.position.x * shipScale;
    const lz = jet.position.z * shipScale;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);

    const reach =
        RETRO_CONFIG.jetLength * RETRO_CONFIG.scale * shipScale *
        randomRange(0.5, 0.9);

    const x = player.mesh.position.x + lx * cos + lz * sin + dirX * reach;
    const z = player.mesh.position.z - lx * sin + lz * cos + dirZ * reach;

    let mesh = retroPuffPool.pop();

    if (!mesh) {
        mesh = cloneGlowModel("retroPuff");
        scene.add(mesh);
    }

    mesh.visible = true;
    mesh.position.set(
        x + randomRange(-0.05, 0.05),
        0.35,
        z + randomRange(-0.05, 0.05)
    );
    mesh.rotation.set(0, randomRange(0, Math.PI * 2), 0);
    mesh.scale.setScalar(0.001);
    setModelOpacity(mesh, 0);

    const speed = RETRO_CONFIG.puffSpeed * randomRange(0.7, 1.1);

    retroPuffs.push({
        mesh,
        life: RETRO_CONFIG.puffLife,
        // Gas keeps moving the way the jet fired, plus the ship's
        // own motion at the moment it left the nozzle.
        vx: dirX * speed + player.velocity.x,
        vz: dirZ * speed + player.velocity.z,
        baseScale:
            RETRO_CONFIG.puffScale * randomRange(0.8, 1.2) * shipScale,
        spin: randomRange(-1.5, 1.5)
    });
}

function updateRetroPuffs(dt) {
    for (let i = retroPuffs.length - 1; i >= 0; i--) {
        const puff = retroPuffs[i];

        puff.life -= dt;

        if (puff.life <= 0) {
            puff.mesh.visible = false;
            retroPuffPool.push(puff.mesh);
            retroPuffs.splice(i, 1);
            continue;
        }

        const progress = 1 - puff.life / RETRO_CONFIG.puffLife;

        // The gas slows quickly as it spreads out.
        const drag = Math.exp(-4 * dt);
        puff.vx *= drag;
        puff.vz *= drag;

        puff.mesh.position.x += puff.vx * dt;
        puff.mesh.position.z += puff.vz * dt;
        puff.mesh.rotation.y += puff.spin * dt;

        puff.mesh.scale.setScalar(
            puff.baseScale * (0.6 + progress * 1.6)
        );

        setModelOpacity(
            puff.mesh,
            RETRO_CONFIG.puffOpacity * (1 - progress) * (1 - progress)
        );
    }
}

function clearRetroPuffs() {
    for (const puff of retroPuffs) {
        puff.mesh.visible = false;
        retroPuffPool.push(puff.mesh);
    }

    retroPuffs.length = 0;
}

// ------------------------------------------------------------
// WARP BUBBLE POWER-UP
// ------------------------------------------------------------

const WARP_DURATION = 15;
const WARP_SCORE_INTERVAL = 10000;

// The ship flies this many times faster while the warp is active.
const WARP_SPEED_MULTIPLIER = 2;

// Asteroids begin curving around the ship within this radius.
const WARP_RADIUS = 7.0;

// Maximum strength of the warp field.
const WARP_STRENGTH = 24;

const warp = {
    active: false,
    remaining: 0,
    elapsed: 0,

    // The next score milestone that activates the warp.
    nextMilestone: WARP_SCORE_INTERVAL,

    group: null,
    models: {},

    // Original materials are kept intact.
    activationCount: 0
};

// ------------------------------------------------------------
// BLACK HOLE EVENT
// The victory. Each match lasts MATCH_SECONDS; survive to the end
// (any number of hits is fine, as long as you have hull left) and
// the black hole opens to carry you out of spacetime.
// ------------------------------------------------------------

const MATCH_SECONDS = 5 * 60;
const BLACK_HOLE_POSITION = new THREE.Vector3(0, 0.35, 0);

const BLACK_HOLE_CONFIG = {
    duration: 12,

    // How far ahead of the ship the black hole opens (world units;
    // the view is 32 units tall, so this stays on screen).
    openDistanceAhead: 10,

    // Objects are pulled directly toward the center.
    pullStrength: 12,
    maximumPullSpeed: 45,
    influenceRadius: 100,

    // Objects are consumed at the center.
    consumeRadius: 0.25,
    shipConsumeRadius: 0.25,

    // Visual event horizon.
    eventHorizonRadius: 2.2,
    asteroidEventHorizonRadius: 2.2,

    // ---- Look (blender/generate_black_hole.py assets) ----

    // How nearly edge-on the accretion disk is seen: its height as a
    // fraction of its width. Smaller = thinner band.
    diskTilt: 0.14,

    // How fast the disk's plasma streaks orbit (radians per second).
    streakSpin: 0.55,

    // Gravitational lensing of the background: the Einstein radius
    // sets how strongly the sky is bent; the lens fades out by
    // lensRadius.
    lensEinsteinRadius: 3.2,
    lensRadius: 16,

    // Things within sparkRadius shed this many sparks per second as
    // they are pulled in.
    sparkRadius: 9,
    sparkRate: 14,

    // After the ship crosses the event horizon, seconds of the black
    // hole on screen before the VICTORY banner appears.
    victoryDelay: 1.8,

    // Spaghettification lasts exactly one animation second.
    stretchDuration: 1.0,
    maximumStretch: 9,
    // Objects shrink as they approach the singularity.
    shrinkStartRadius: 12,
    minimumScale: 0.001,
    shrinkExponent: 1.8
};

const blackHole = {
    active: false,
    triggered: false,
    elapsed: 0,

    group: null,

    // Parts (see createBlackHole).
    shadow: null,
    photonRing: null,
    halo: null,
    diskGroup: null,
    diskBack: null,
    diskFront: null,
    streaksBack: null,
    streaksFront: null,
    clipBack: null,
    clipFront: null,

    // Background lensing disc (see createLens).
    lens: null,

    // Photon-ring pulse from swallow flares (decays to 0).
    flare: 0,

    // Pending switch to the VICTORY banner.
    victoryTimer: null,

    consumedCount: 0,
    asteroidSpawnTimer: 0,
    asteroidSpawnInterval: 0.7
};

// ============================================================
// WEAPON UPGRADES
// Red laser unlocks at LASER_UNLOCK_SCORE and fires with the normal
// fire controls. Rockets unlock at ROCKET_UNLOCK_SCORE and launch
// automatically, homing on asteroids and destroying every asteroid
// inside their blast radius. Rockets leave a smoke trail.
//
// Asset orientation: every weapon model faces local +Z (the same
// forward axis as the ship), so rotation.y = heading aims it.
// ============================================================

const LASER_UNLOCK_SCORE = 15000;
const ROCKET_UNLOCK_SCORE = 20000;

const LASER_CONFIG = {
    // Seconds between beams while the fire button is held.
    cooldown: 0.85,

    // The beam has unlimited range: it passes through everything in
    // its path and hits everything along the line, all the way
    // across the world. Visually it is drawn this far past the edge
    // of the screen, so it always runs off screen.
    offscreenOvershoot: 10,

    // Added to an asteroid's radius when testing for a hit.
    halfWidth: 0.3,

    // Hit points removed from every asteroid the beam touches.
    damage: 2,

    // How long the beam and impact bursts stay on screen.
    beamDuration: 0.16,
    impactDuration: 0.25,

    // Matches where fireBullet() spawns bullets.
    noseOffset: 1.1,
    height: 0.45
};

const ROCKET_CONFIG = {
    // Seconds between automatic launches.
    interval: 2.2,

    speed: 15,

    // How quickly a rocket turns toward its target (radians/s).
    turnRate: 3.2,

    // A rocket that hits nothing explodes after this long.
    life: 3.2,

    // Distance from an asteroid's edge that triggers detonation.
    contactRadius: 0.35,

    // Every asteroid within this distance of the blast is destroyed.
    blastRadius: 4.5,

    // Launch alternates between the ship's left and right sides.
    sideOffset: 0.55,
    height: 0.45,

    // Where the flame and smoke plume attach (behind the nozzle).
    flameOffset: -0.54,
    trailOffset: -0.62,

    // Smoke puffs dropped behind each rocket.
    smokeInterval: 0.035,
    smokeLife: 0.9,

    shockwaveDuration: 0.45
};

const weapons = {
    laserUnlocked: false,
    rocketsUnlocked: false,
    laserCooldown: 0,
    rocketTimer: 0,
    rocketSide: 1
};

const laserBeams = [];
const laserImpacts = [];
const rockets = [];
const shockwaves = [];

// Smoke puffs are pooled: there can be dozens on screen and they
// expire constantly, so meshes are hidden and reused rather than
// cloned and thrown away.
const smokePuffs = [];
const smokePool = [];

function checkWeaponUnlocks() {
    // Don't overwrite the black hole warning.
    const announce = (text) => {
        if (!blackHole.active) {
            $("message").textContent = text;
        }
    };

    if (
        !weapons.laserUnlocked &&
        state.score >= LASER_UNLOCK_SCORE
    ) {
        weapons.laserUnlocked = true;
        weapons.laserCooldown = 0;

        announce("RED LASER ONLINE");
        console.info(`Red laser unlocked at ${LASER_UNLOCK_SCORE} points.`);
    }

    if (
        !weapons.rocketsUnlocked &&
        state.score >= ROCKET_UNLOCK_SCORE
    ) {
        weapons.rocketsUnlocked = true;
        weapons.rocketTimer = 0.6;

        announce("ROCKET BATTERY ONLINE");
        console.info(`Rockets unlocked at ${ROCKET_UNLOCK_SCORE} points.`);
    }
}

// ------------------------------------------------------------
// LASER
// ------------------------------------------------------------

// True if a circle at (px, pz) with `radius` touches the beam
// segment that starts at (ox, oz) and runs `length` along (dx, dz).
function beamTouches(ox, oz, dx, dz, length, px, pz, radius) {
    const rx = px - ox;
    const rz = pz - oz;

    // Distance along the beam to the closest point.
    const along = rx * dx + rz * dz;

    if (along < -radius || along > length + radius) {
        return false;
    }

    const t = clamp(along, 0, length);

    const cx = rx - dx * t;
    const cz = rz - dz * t;

    return cx * cx + cz * cz <= radius * radius;
}

function tryFireLaser() {
    if (!weapons.laserUnlocked) return;
    if (!state.running || blackHole.active || !player.mesh) return;
    if (weapons.laserCooldown > 0) return;

    weapons.laserCooldown = LASER_CONFIG.cooldown;

    const dx = Math.sin(player.rotation);
    const dz = Math.cos(player.rotation);

    const ox = player.position.x + dx * LASER_CONFIG.noseOffset;
    const oz = player.position.z + dz * LASER_CONFIG.noseOffset;

    // Unlimited range: hits are tested along the whole line, through
    // and beyond everything it touches, out to the world's edge and
    // past it (nothing exists beyond the edge, so the test can simply
    // run on forever).
    const hitLength = Infinity;

    // What gets drawn: from the nose to past the far corner of the
    // screen, so the beam always continues out of view (and keeps
    // going past the world's border line too).
    const length =
        Math.hypot(viewHalfWidth(), viewHalfHeight()) * 2 +
        LASER_CONFIG.offscreenOvershoot;

    // The beam pierces: every asteroid along it takes damage.
    // Iterating backwards means fragments from a destroyed rock
    // (appended to the end) are not hit by this same pulse.
    for (let i = asteroids.length - 1; i >= 0; i--) {
        const asteroid = asteroids[i];

        if (!beamTouches(
            ox, oz, dx, dz, hitLength,
            asteroid.position.x,
            asteroid.position.z,
            asteroid.radius + LASER_CONFIG.halfWidth
        )) {
            continue;
        }

        createLaserImpact(asteroid.position);

        asteroid.hp -= LASER_CONFIG.damage;

        if (asteroid.hp <= 0) {
            destroyAsteroid(i);
        } else {
            // Same damage feedback as a bullet hit.
            asteroid.mesh.scale.multiplyScalar(0.96);
            asteroid.radius *= 0.96;
        }
    }

    // The beam also destroys mines it touches.
    for (let i = mines.length - 1; i >= 0; i--) {
        const mine = mines[i];

        if (!beamTouches(
            ox, oz, dx, dz, hitLength,
            mine.position.x,
            mine.position.z,
            mine.radius + LASER_CONFIG.halfWidth
        )) {
            continue;
        }

        createLaserImpact(mine.position);
        destroyMine(i);
    }

    createLaserBeam(ox, oz, player.rotation, length);
}

function createLaserBeam(x, z, heading, length) {
    const group = new THREE.Group();
    group.name = "LaserBeam";

    group.position.set(x, LASER_CONFIG.height, z);
    group.rotation.y = heading;

    // The beam model is one unit long, so stretch it to the range.
    const beam = cloneModel("laserBeam");
    beam.scale.set(1, 1, length);
    group.add(beam);

    const emitter = cloneModel("laserEmitter");
    group.add(emitter);

    scene.add(group);

    laserBeams.push({
        group,
        beam,
        emitter,
        length,
        life: LASER_CONFIG.beamDuration
    });
}

function createLaserImpact(position) {
    const mesh = cloneModel("laserImpact");

    mesh.position.set(position.x, LASER_CONFIG.height, position.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.scale.setScalar(0.6);

    scene.add(mesh);

    laserImpacts.push({
        mesh,
        life: LASER_CONFIG.impactDuration
    });
}

function updateLaserEffects(dt) {
    for (let i = laserBeams.length - 1; i >= 0; i--) {
        const effect = laserBeams[i];

        effect.life -= dt;

        if (effect.life <= 0) {
            scene.remove(effect.group);
            laserBeams.splice(i, 1);
            continue;
        }

        // Full width at first, then the beam thins out to nothing.
        const progress = 1 - effect.life / LASER_CONFIG.beamDuration;
        const width = 1 - progress * progress;
        const flicker = 0.85 + Math.random() * 0.3;

        effect.beam.scale.set(
            width * flicker,
            width * flicker,
            effect.length
        );

        effect.emitter.scale.setScalar(
            (1 + progress * 0.6) * width
        );
    }

    for (let i = laserImpacts.length - 1; i >= 0; i--) {
        const effect = laserImpacts[i];

        effect.life -= dt;

        if (effect.life <= 0) {
            scene.remove(effect.mesh);
            laserImpacts.splice(i, 1);
            continue;
        }

        const progress = 1 - effect.life / LASER_CONFIG.impactDuration;

        // Burst outward, then collapse.
        effect.mesh.scale.setScalar(
            (0.6 + progress * 0.9) * (1 - progress * progress)
        );

        effect.mesh.rotation.y += dt * 4;
    }
}

// ------------------------------------------------------------
// ROCKETS
// ------------------------------------------------------------

function nearestAsteroid(x, z) {
    let best = null;
    let bestDistanceSq = Infinity;

    for (const asteroid of asteroids) {
        const dx = asteroid.position.x - x;
        const dz = asteroid.position.z - z;
        const distanceSq = dx * dx + dz * dz;

        if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            best = asteroid;
        }
    }

    return best;
}

function launchRocket() {
    const heading = player.rotation;

    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);

    // Perpendicular to the heading, alternating sides each launch.
    const side = weapons.rocketSide;
    weapons.rocketSide *= -1;

    const sideX = Math.cos(heading) * side * ROCKET_CONFIG.sideOffset;
    const sideZ = -Math.sin(heading) * side * ROCKET_CONFIG.sideOffset;

    const position = new THREE.Vector3(
        player.position.x + sideX + forwardX * 0.3,
        ROCKET_CONFIG.height,
        player.position.z + sideZ + forwardZ * 0.3
    );

    const mesh = cloneModel("rocket");

    const flame = cloneModel("rocketFlame");
    flame.position.set(0, 0, ROCKET_CONFIG.flameOffset);
    mesh.add(flame);

    const trail = cloneModel("smokeTrail");
    trail.position.set(0, 0, ROCKET_CONFIG.trailOffset);
    mesh.add(trail);

    mesh.position.copy(position);
    mesh.rotation.y = heading;

    scene.add(mesh);

    rockets.push({
        mesh,
        flame,
        trail,
        position,
        heading,
        target: nearestAsteroid(position.x, position.z),
        life: ROCKET_CONFIG.life,
        smokeTimer: 0,
        age: 0
    });
}

function updateRocketLauncher(dt) {
    if (!weapons.rocketsUnlocked || !player.mesh) return;

    weapons.rocketTimer -= dt;

    if (weapons.rocketTimer > 0) return;

    // Hold fire until there is something to shoot at.
    if (asteroids.length === 0) {
        weapons.rocketTimer = 0.25;
        return;
    }

    launchRocket();

    weapons.rocketTimer = ROCKET_CONFIG.interval;
}

function updateRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i--) {
        const rocket = rockets[i];

        rocket.life -= dt;
        rocket.age += dt;

        // Re-target if the original target was destroyed.
        if (!rocket.target || !asteroids.includes(rocket.target)) {
            rocket.target = nearestAsteroid(
                rocket.position.x,
                rocket.position.z
            );
        }

        // Steer toward the target with a limited turn rate.
        if (rocket.target) {
            const desired = Math.atan2(
                rocket.target.position.x - rocket.position.x,
                rocket.target.position.z - rocket.position.z
            );

            const difference = Math.atan2(
                Math.sin(desired - rocket.heading),
                Math.cos(desired - rocket.heading)
            );

            rocket.heading += clamp(
                difference,
                -ROCKET_CONFIG.turnRate * dt,
                ROCKET_CONFIG.turnRate * dt
            );
        }

        rocket.position.x +=
            Math.sin(rocket.heading) * ROCKET_CONFIG.speed * dt;
        rocket.position.z +=
            Math.cos(rocket.heading) * ROCKET_CONFIG.speed * dt;

        rocket.mesh.position.copy(rocket.position);
        rocket.mesh.rotation.y = rocket.heading;

        // Flickering flame and a gently breathing smoke plume.
        rocket.flame.scale.set(1, 1, 0.8 + Math.random() * 0.45);
        rocket.trail.scale.set(
            1,
            1,
            Math.min(1, rocket.age * 4) *
                (0.92 + Math.sin(rocket.age * 18) * 0.08)
        );

        // Drop smoke puffs behind the nozzle.
        rocket.smokeTimer -= dt;

        while (rocket.smokeTimer <= 0) {
            rocket.smokeTimer += ROCKET_CONFIG.smokeInterval;

            spawnSmokePuff(
                rocket.position.x -
                    Math.sin(rocket.heading) * 0.6,
                rocket.position.z -
                    Math.cos(rocket.heading) * 0.6,
                rocket.heading
            );
        }

        // Detonate on contact with any asteroid.
        let contact = false;

        for (const asteroid of asteroids) {
            if (circlesOverlap(
                rocket.position,
                asteroid.position,
                ROCKET_CONFIG.contactRadius,
                asteroid.radius
            )) {
                contact = true;
                break;
            }
        }

        const outOfArena =
            Math.abs(rocket.position.x) > HALF_W ||
            Math.abs(rocket.position.z) > HALF_H;

        if (contact || outOfArena || rocket.life <= 0) {
            explodeRocket(i);
        }
    }
}

function explodeRocket(index) {
    const rocket = rockets[index];

    scene.remove(rocket.mesh);
    rockets.splice(index, 1);

    const center = rocket.position;

    createExplosion(center, 1.8, 24);
    createShockwave(center);

    state.screenShake = Math.max(state.screenShake, 0.2);

    // Destroy every asteroid within the blast radius. Like the warp
    // field, the blast vaporizes rocks without splitting them.
    for (let i = asteroids.length - 1; i >= 0; i--) {
        const asteroid = asteroids[i];

        const dx = asteroid.position.x - center.x;
        const dz = asteroid.position.z - center.z;
        const reach = ROCKET_CONFIG.blastRadius + asteroid.radius;

        if (dx * dx + dz * dz > reach * reach) {
            continue;
        }

        createExplosion(
            asteroid.position.clone(),
            asteroid.radius,
            10
        );

        addScore(asteroid.scoreValue);

        discardMesh(asteroid.mesh);
        asteroids.splice(i, 1);
    }
}

function createShockwave(position) {
    const mesh = cloneModel("rocketShockwave");

    // The ring fades out, so it needs its own transparent materials.
    ownMaterials(mesh);

    mesh.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material.transparent = true;
            material.depthWrite = false;
        }
    });

    mesh.position.set(position.x, 0.42, position.z);
    mesh.scale.setScalar(0.01);

    scene.add(mesh);

    shockwaves.push({
        mesh,
        life: ROCKET_CONFIG.shockwaveDuration
    });
}

function updateShockwaves(dt) {
    for (let i = shockwaves.length - 1; i >= 0; i--) {
        const wave = shockwaves[i];

        wave.life -= dt;

        if (wave.life <= 0) {
            discardMesh(wave.mesh);
            shockwaves.splice(i, 1);
            continue;
        }

        const progress =
            1 - wave.life / ROCKET_CONFIG.shockwaveDuration;

        // Fast expansion that eases out at the blast radius.
        const eased = 1 - (1 - progress) * (1 - progress);

        wave.mesh.scale.setScalar(
            ROCKET_CONFIG.blastRadius * (0.15 + 0.85 * eased)
        );

        const opacity = 1 - progress;

        wave.mesh.traverse((child) => {
            if (!child.isMesh) return;

            const materials = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const material of materials) {
                material.opacity = opacity;
            }
        });
    }
}

// ------------------------------------------------------------
// SMOKE TRAIL PUFFS
// ------------------------------------------------------------

function spawnSmokePuff(x, z, heading) {
    let mesh = smokePool.pop();

    if (!mesh) {
        mesh = cloneModel("smokePuff");
        scene.add(mesh);
    }

    mesh.visible = true;

    mesh.position.set(
        x + randomRange(-0.08, 0.08),
        0.4,
        z + randomRange(-0.08, 0.08)
    );

    mesh.rotation.set(
        randomRange(0, Math.PI * 2),
        randomRange(0, Math.PI * 2),
        0
    );

    // Puffs drift slightly sideways and backwards as they spread.
    const sideways = randomRange(-0.6, 0.6);

    smokePuffs.push({
        mesh,
        life: ROCKET_CONFIG.smokeLife,
        baseScale: randomRange(0.22, 0.34),
        driftX:
            Math.cos(heading) * sideways -
            Math.sin(heading) * 0.8,
        driftZ:
            -Math.sin(heading) * sideways -
            Math.cos(heading) * 0.8,
        spin: randomRange(-2, 2)
    });

    mesh.scale.setScalar(0.001);
}

function updateSmoke(dt) {
    for (let i = smokePuffs.length - 1; i >= 0; i--) {
        const puff = smokePuffs[i];

        puff.life -= dt;

        if (puff.life <= 0) {
            puff.mesh.visible = false;
            smokePool.push(puff.mesh);
            smokePuffs.splice(i, 1);
            continue;
        }

        const progress = 1 - puff.life / ROCKET_CONFIG.smokeLife;

        // Billow out, then dissipate by shrinking to nothing.
        puff.mesh.scale.setScalar(
            puff.baseScale *
                (0.5 + progress * 1.5) *
                (1 - progress * progress)
        );

        puff.mesh.position.x += puff.driftX * dt;
        puff.mesh.position.z += puff.driftZ * dt;

        const damping = Math.max(0, 1 - dt * 2.5);
        puff.driftX *= damping;
        puff.driftZ *= damping;

        puff.mesh.rotation.y += puff.spin * dt;
    }
}

// ------------------------------------------------------------
// WEAPON UPDATE AND CLEANUP
// ------------------------------------------------------------

function updateWeapons(dt) {
    weapons.laserCooldown = Math.max(0, weapons.laserCooldown - dt);

    updateLaserEffects(dt);
    updateRocketLauncher(dt);
    updateRockets(dt);
    updateShockwaves(dt);
    updateSmoke(dt);
}

// Remove beams, impacts, rockets and shockwaves (used when the
// black hole appears and when a game resets). Smoke is left to
// dissipate on its own.
function clearActiveWeapons() {
    for (const effect of laserBeams) {
        scene.remove(effect.group);
    }

    for (const effect of laserImpacts) {
        scene.remove(effect.mesh);
    }

    for (const rocket of rockets) {
        scene.remove(rocket.mesh);
    }

    for (const wave of shockwaves) {
        discardMesh(wave.mesh);
    }

    laserBeams.length = 0;
    laserImpacts.length = 0;
    rockets.length = 0;
    shockwaves.length = 0;
}

function resetWeapons() {
    clearActiveWeapons();

    // Return every active puff to the pool.
    for (const puff of smokePuffs) {
        puff.mesh.visible = false;
        smokePool.push(puff.mesh);
    }

    smokePuffs.length = 0;

    weapons.laserUnlocked = false;
    weapons.rocketsUnlocked = false;
    weapons.laserCooldown = 0;
    weapons.rocketTimer = 0;
    weapons.rocketSide = 1;
}

// ============================================================
// "BLUE MOON" ROGUE ASTEROID
// Once in a blue moon, a huge icy asteroid streaks across the
// arena from a random direction. A warning chevron flashes at the
// edge it will enter from, then it tears straight through,
// destroying everything in its path: asteroids, mines, crystals,
// bullets and rockets. It also costs the ship one hull point if
// it hits (the warp bubble protects you). It leaves a vapor trail
// that lingers for a few seconds before fading away.
//
// To see one without waiting, run summonRogueAsteroid() in the
// browser console during a game.
// ============================================================

const ROGUE_CONFIG = {
    // Random wait, in seconds of play, before the first flyby...
    firstDelay: [60, 180],

    // ...and between later flybys.
    interval: [90, 240],

    // How long the warning chevron shows before it arrives.
    warningTime: 1.4,

    // Units per second; it crosses the arena in about 1.5 seconds.
    speed: 34,

    // Everything within this distance of its path is destroyed.
    radius: 1.6,

    // It starts this far outside the arena edge.
    spawnMargin: 4,

    // Set to false to let it pass harmlessly through the ship.
    damagesPlayer: true,

    height: 0.5,

    // Where the tail attaches, behind the rock's center.
    tailOffset: -1.25,

    // Tumble speed around its flight axis (radians/s).
    spin: 1.6,

    // Vapor puffs are dropped every this many units of travel.
    puffSpacing: 0.55,

    // How long the vapor trail lingers after it passes (seconds).
    vaporLife: 3.6,

    // Width of the glowing ribbon left along its path.
    ribbonWidth: 2.6,

    // Camera shake while it is crossing.
    shake: 0.14
};

const rogue = {
    // "idle" (waiting), "warning" (chevron showing) or "flying".
    phase: "idle",
    timer: 0,
    warningLeft: 0,

    group: null,
    rock: null,
    tail: null,
    shock: null,
    warningMesh: null,
    ribbon: null,

    position: new THREE.Vector3(),
    entry: new THREE.Vector3(),
    heading: 0,
    dirX: 0,
    dirZ: 1,

    elapsed: 0,
    distanceSincePuff: 0,
    destroyedCount: 0
};

// Ribbons fade independently, so several can linger at once.
const vaporRibbons = [];

// Vapor puffs are pooled like the rocket smoke.
const vaporPuffs = [];
const vaporPool = [];

function scheduleRogue(first = false) {
    const [min, max] = first
        ? ROGUE_CONFIG.firstDelay
        : ROGUE_CONFIG.interval;

    rogue.timer = randomRange(min, max);
}

// Pick an entry point on a random edge and aim through the middle
// of the arena, then show the warning.
function startRogueWarning() {
    // Enter from an edge of the visible screen...
    const edgePoint = viewBoundaryPosition();

    // ...aimed at a random point in the central part of the view,
    // so it always crosses the screen instead of clipping a corner.
    const targetX = cameraRig.x + randomRange(-0.55, 0.55) * viewHalfWidth();
    const targetZ = cameraRig.z + randomRange(-0.55, 0.55) * viewHalfHeight();

    let dx = targetX - edgePoint.x;
    let dz = targetZ - edgePoint.z;
    const length = Math.hypot(dx, dz) || 1;

    dx /= length;
    dz /= length;

    rogue.dirX = dx;
    rogue.dirZ = dz;
    rogue.heading = Math.atan2(dx, dz);

    // Start just outside the arena, on the far side of the edge.
    rogue.entry.set(
        edgePoint.x - dx * ROGUE_CONFIG.spawnMargin,
        ROGUE_CONFIG.height,
        edgePoint.z - dz * ROGUE_CONFIG.spawnMargin
    );

    // The chevron sits just inside the edge, pointing the way it
    // will travel.
    const warningMesh = cloneModel("rogueWarning");

    warningMesh.position.set(
        edgePoint.x + dx * 1.8,
        0.45,
        edgePoint.z + dz * 1.8
    );

    warningMesh.rotation.y = rogue.heading;

    scene.add(warningMesh);

    rogue.warningMesh = warningMesh;
    rogue.warningLeft = ROGUE_CONFIG.warningTime;
    rogue.phase = "warning";

    $("message").textContent = "WARNING: ROGUE ASTEROID INBOUND";

    console.info("Rogue asteroid incoming.");
}

function launchRogue() {
    if (rogue.warningMesh) {
        scene.remove(rogue.warningMesh);
        rogue.warningMesh = null;
    }

    // Group = heading. The rock spins inside it on its own, so the
    // tail and bow shock stay aligned with the flight path.
    const group = new THREE.Group();
    group.name = "RogueAsteroid";

    const rock = cloneModel("rogueAsteroid");
    group.add(rock);

    const tail = cloneModel("rogueTail");
    tail.position.set(0, 0, ROGUE_CONFIG.tailOffset);
    group.add(tail);

    const shock = cloneModel("rogueBowShock");
    group.add(shock);

    rogue.position.copy(rogue.entry);

    group.position.copy(rogue.position);
    group.rotation.y = rogue.heading;

    scene.add(group);

    rogue.group = group;
    rogue.rock = rock;
    rogue.tail = tail;
    rogue.shock = shock;

    // The ribbon starts at the entry point and is stretched along
    // the path as the rock travels. It fades, so it owns its
    // materials.
    const ribbonMesh = cloneModel("vaporRibbon");
    ownMaterials(ribbonMesh);

    ribbonMesh.traverse((child) => {
        if (!child.isMesh) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            material.transparent = true;
            material.depthWrite = false;
        }
    });

    ribbonMesh.position.set(rogue.entry.x, 0.32, rogue.entry.z);
    ribbonMesh.rotation.y = rogue.heading;
    ribbonMesh.scale.set(ROGUE_CONFIG.ribbonWidth, 1, 0.001);

    scene.add(ribbonMesh);

    const ribbon = {
        mesh: ribbonMesh,
        length: 0,
        life: ROGUE_CONFIG.vaporLife,
        lingering: false
    };

    vaporRibbons.push(ribbon);
    rogue.ribbon = ribbon;

    rogue.elapsed = 0;
    rogue.distanceSincePuff = 0;
    rogue.destroyedCount = 0;
    rogue.phase = "flying";
}

// Destroy everything touching the rock's path for this frame,
// from (x, z) along its direction for `step` units.
function rogueSweep(x, z, step) {
    const touches = (px, pz, radius) => beamTouches(
        x, z, rogue.dirX, rogue.dirZ, step,
        px, pz,
        ROGUE_CONFIG.radius + radius
    );

    // Asteroids are pulverized outright (no fragments, no points).
    for (let i = asteroids.length - 1; i >= 0; i--) {
        const asteroid = asteroids[i];

        if (!touches(asteroid.position.x, asteroid.position.z, asteroid.radius)) {
            continue;
        }

        createExplosion(asteroid.position.clone(), asteroid.radius, 12);

        discardMesh(asteroid.mesh);
        asteroids.splice(i, 1);

        rogue.destroyedCount++;
    }

    for (let i = mines.length - 1; i >= 0; i--) {
        const mine = mines[i];

        if (!touches(mine.position.x, mine.position.z, mine.radius)) {
            continue;
        }

        createExplosion(mine.position.clone(), 1.1, 15);

        discardMesh(mine.mesh);
        mines.splice(i, 1);

        rogue.destroyedCount++;
    }

    for (let i = pickups.length - 1; i >= 0; i--) {
        const pickup = pickups[i];

        if (!touches(pickup.position.x, pickup.position.z, pickup.radius)) {
            continue;
        }

        createExplosion(pickup.position.clone(), 0.7, 8);

        scene.remove(pickup.mesh);
        scene.remove(pickup.glow);
        pickups.splice(i, 1);

        rogue.destroyedCount++;
    }

    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];

        if (touches(bullet.position.x, bullet.position.z, bullet.radius)) {
            removeBullet(i);
        }
    }

    for (let i = rockets.length - 1; i >= 0; i--) {
        const rocket = rockets[i];

        if (!touches(rocket.position.x, rocket.position.z, ROCKET_CONFIG.contactRadius)) {
            continue;
        }

        // Swatted out of the sky: a small burst, no blast.
        createExplosion(rocket.position.clone(), 0.5, 6);

        scene.remove(rocket.mesh);
        rockets.splice(i, 1);
    }

    // The ship takes one hit (damagePlayer's cooldown stops a
    // single pass from counting twice). The warp bubble protects it.
    if (
        ROGUE_CONFIG.damagesPlayer &&
        player.mesh &&
        !warp.active &&
        touches(player.position.x, player.position.z, player.radius)
    ) {
        damagePlayer();
    }
}

function spawnVaporPuff(x, z) {
    let mesh = vaporPool.pop();

    if (!mesh) {
        mesh = cloneModel("vaporPuff");
        scene.add(mesh);
    }

    mesh.visible = true;

    // Scatter puffs across the width of the path.
    const sideways = randomRange(-1, 1) * ROGUE_CONFIG.ribbonWidth * 0.45;

    mesh.position.set(
        x + rogue.dirZ * sideways,
        0.38,
        z - rogue.dirX * sideways
    );

    mesh.rotation.set(0, randomRange(0, Math.PI * 2), 0);
    mesh.scale.setScalar(0.001);

    vaporPuffs.push({
        mesh,
        life: ROGUE_CONFIG.vaporLife * randomRange(0.75, 1.05),
        maxLife: 0,
        baseScale: randomRange(0.9, 1.5),
        // A gentle push outward from the path, slowing over time.
        driftX: rogue.dirZ * sideways * 0.35,
        driftZ: -rogue.dirX * sideways * 0.35,
        spin: randomRange(-0.6, 0.6)
    });

    const puff = vaporPuffs[vaporPuffs.length - 1];
    puff.maxLife = puff.life;
}

function finishRogue() {
    if (rogue.group) {
        scene.remove(rogue.group);
    }

    if (rogue.warningMesh) {
        scene.remove(rogue.warningMesh);
    }

    // Whatever was left of the ribbon starts fading.
    if (rogue.ribbon) {
        rogue.ribbon.lingering = true;
    }

    rogue.group = null;
    rogue.rock = null;
    rogue.tail = null;
    rogue.shock = null;
    rogue.warningMesh = null;
    rogue.ribbon = null;
    rogue.phase = "idle";

    scheduleRogue();
}

function updateRogue(dt) {
    if (rogue.phase === "idle") {
        rogue.timer -= dt;

        if (rogue.timer <= 0) {
            startRogueWarning();
        }

        return;
    }

    if (rogue.phase === "warning") {
        rogue.warningLeft -= dt;

        // Fast, urgent pulse.
        const pulse = 1 + Math.sin(rogue.warningLeft * 22) * 0.18;
        rogue.warningMesh.scale.setScalar(pulse);

        if (rogue.warningLeft <= 0) {
            launchRogue();
        }

        return;
    }

    // ---- Flying ----------------------------------------------

    rogue.elapsed += dt;

    const step = ROGUE_CONFIG.speed * dt;
    const startX = rogue.position.x;
    const startZ = rogue.position.z;

    // Sweep the whole stretch covered this frame, so nothing slips
    // between frames at this speed.
    rogueSweep(startX, startZ, step);

    rogue.position.x += rogue.dirX * step;
    rogue.position.z += rogue.dirZ * step;

    rogue.group.position.copy(rogue.position);

    // Tumble around the flight axis; flicker the tail.
    rogue.rock.rotation.z += ROGUE_CONFIG.spin * dt;
    rogue.rock.rotation.x += ROGUE_CONFIG.spin * 0.35 * dt;

    rogue.tail.scale.set(
        1,
        1,
        0.9 + Math.random() * 0.2
    );

    rogue.shock.scale.setScalar(
        1 + Math.sin(rogue.elapsed * 30) * 0.04
    );

    // Stretch the ribbon from the entry point to the rock.
    const traveled = Math.hypot(
        rogue.position.x - rogue.entry.x,
        rogue.position.z - rogue.entry.z
    );

    rogue.ribbon.length = traveled;
    rogue.ribbon.mesh.scale.set(
        ROGUE_CONFIG.ribbonWidth,
        1,
        Math.max(0.001, traveled)
    );

    // Drop vapor puffs evenly along the path.
    rogue.distanceSincePuff += step;

    while (rogue.distanceSincePuff >= ROGUE_CONFIG.puffSpacing) {
        rogue.distanceSincePuff -= ROGUE_CONFIG.puffSpacing;

        // Place the puff where the rock was at that distance.
        const back = rogue.distanceSincePuff;

        spawnVaporPuff(
            rogue.position.x - rogue.dirX * back,
            rogue.position.z - rogue.dirZ * back
        );
    }

    // Measured from the camera, since the view moves.
    const fromViewX = Math.abs(rogue.position.x - cameraRig.x);
    const fromViewZ = Math.abs(rogue.position.z - cameraRig.z);

    const onScreen =
        fromViewX <= viewHalfWidth() &&
        fromViewZ <= viewHalfHeight();

    if (onScreen) {
        state.screenShake = Math.max(
            state.screenShake,
            ROGUE_CONFIG.shake
        );
    }

    // Gone once it is well past the far edge of the view.
    const limitX = viewHalfWidth() + ROGUE_CONFIG.spawnMargin + 2;
    const limitZ = viewHalfHeight() + ROGUE_CONFIG.spawnMargin + 2;

    if (
        rogue.elapsed > 0.25 &&
        (fromViewX > limitX || fromViewZ > limitZ)
    ) {
        if (state.running && !blackHole.active) {
            $("message").textContent =
                rogue.destroyedCount > 0
                    ? `ROGUE ASTEROID PASSED — ${rogue.destroyedCount} OBJECTS DESTROYED`
                    : "ROGUE ASTEROID PASSED";
        }

        finishRogue();
    }
}

// Fade lingering ribbons and vapor puffs.
function updateVaporTrails(dt) {
    for (let i = vaporRibbons.length - 1; i >= 0; i--) {
        const ribbon = vaporRibbons[i];

        if (!ribbon.lingering) {
            continue;
        }

        ribbon.life -= dt;

        if (ribbon.life <= 0) {
            discardMesh(ribbon.mesh);
            vaporRibbons.splice(i, 1);
            continue;
        }

        const progress = 1 - ribbon.life / ROGUE_CONFIG.vaporLife;

        // Hold steady for a moment, then thin out and fade.
        const fade = 1 - Math.pow(progress, 1.6);

        ribbon.mesh.scale.set(
            ROGUE_CONFIG.ribbonWidth * (0.35 + 0.65 * fade),
            1,
            Math.max(0.001, ribbon.length)
        );

        ribbon.mesh.traverse((child) => {
            if (!child.isMesh) return;

            const materials = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const material of materials) {
                material.opacity = fade;
            }
        });
    }

    for (let i = vaporPuffs.length - 1; i >= 0; i--) {
        const puff = vaporPuffs[i];

        puff.life -= dt;

        if (puff.life <= 0) {
            puff.mesh.visible = false;
            vaporPool.push(puff.mesh);
            vaporPuffs.splice(i, 1);
            continue;
        }

        const progress = 1 - puff.life / puff.maxLife;

        // Quick bloom, a long slow spread, then a fade at the end.
        const bloom = Math.min(1, progress * 6);
        const spread = 0.6 + progress * 0.9;
        const fade = 1 - Math.pow(progress, 3);

        puff.mesh.scale.setScalar(
            puff.baseScale * bloom * spread * fade
        );

        puff.mesh.position.x += puff.driftX * dt;
        puff.mesh.position.z += puff.driftZ * dt;

        const damping = Math.max(0, 1 - dt * 1.2);
        puff.driftX *= damping;
        puff.driftZ *= damping;

        puff.mesh.rotation.y += puff.spin * dt;
    }
}

// Remove the rock and any warning (used when the black hole
// appears). Its trail is left to fade naturally.
function clearRogueAsteroid() {
    if (rogue.phase === "idle") return;

    finishRogue();
}

function resetRogue() {
    if (rogue.group) scene.remove(rogue.group);
    if (rogue.warningMesh) scene.remove(rogue.warningMesh);

    for (const ribbon of vaporRibbons) {
        discardMesh(ribbon.mesh);
    }

    vaporRibbons.length = 0;

    for (const puff of vaporPuffs) {
        puff.mesh.visible = false;
        vaporPool.push(puff.mesh);
    }

    vaporPuffs.length = 0;

    rogue.group = null;
    rogue.rock = null;
    rogue.tail = null;
    rogue.shock = null;
    rogue.warningMesh = null;
    rogue.ribbon = null;
    rogue.phase = "idle";

    scheduleRogue(true);
}

// Console helper for trying the event without waiting for it.
window.summonRogueAsteroid = () => {
    if (!state.running || blackHole.active) {
        console.warn("Start a game first (and not during the black hole).");
        return;
    }

    if (rogue.phase !== "idle") {
        console.warn("A rogue asteroid is already on its way.");
        return;
    }

    startRogueWarning();
};


// ------------------------------------------------------------
// CREATE BLACK HOLE
// Loads and assembles all six GLB models.
// ------------------------------------------------------------

function createBlackHole() {
    // Remove the previous event if it exists.
    if (blackHole.group) {
        scene.remove(blackHole.group);
    }

    // Clipping only applies to materials that ask for it (the two
    // copies of the orbiting streaks).
    renderer.localClippingEnabled = true;

    const group = new THREE.Group();
    group.name = "BlackHoleEvent";

    // Draw order is set by height above the playfield (the camera
    // looks straight down): higher = in front.
    const place = (key, y) => {
        const model = cloneModel(key);
        model.position.y = y;
        return model;
    };

    // Far side of the disk, lensed up over and under the shadow.
    blackHole.halo = place("bhHalo", 0.0);
    group.add(blackHole.halo);

    // The disk is exported as circles and squashed here into the
    // nearly edge-on band. Its far half sits under the shadow, its
    // near half over it.
    blackHole.diskGroup = new THREE.Group();
    blackHole.diskGroup.name = "BlackHoleDisk";
    group.add(blackHole.diskGroup);

    blackHole.diskBack = place("bhDiskBack", 0.04);
    blackHole.diskFront = place("bhDiskFront", 0.18);

    // Two copies of the orbiting streaks, each clipped to one half of
    // the screen around the hole, so streaks pass BEHIND the shadow
    // on the far side and in FRONT of it on the near side.
    blackHole.clipBack = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    blackHole.clipFront = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const clippedStreaks = (y, plane) => {
        const streaks = place("bhDiskStreaks", y);

        ownMaterials(streaks);

        streaks.traverse((child) => {
            if (!child.isMesh) return;

            const materials = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const material of materials) {
                material.clippingPlanes = [plane];
            }
        });

        return streaks;
    };

    blackHole.streaksBack = clippedStreaks(0.06, blackHole.clipBack);
    blackHole.streaksFront = clippedStreaks(0.2, blackHole.clipFront);

    blackHole.diskGroup.add(
        blackHole.diskBack,
        blackHole.streaksBack,
        blackHole.diskFront,
        blackHole.streaksFront
    );

    // The black shadow and its photon ring sit between the disk halves.
    blackHole.shadow = place("bhShadow", 0.12);
    blackHole.photonRing = place("bhPhotonRing", 0.14);

    group.add(blackHole.shadow, blackHole.photonRing);

    group.position.copy(BLACK_HOLE_POSITION);
    group.visible = false;

    scene.add(group);

    blackHole.group = group;

    console.info("Gargantua-style black hole assembled.");
}

// ------------------------------------------------------------
// GRAVITATIONAL LENSING
// A disc of background drawn over the parallax layers that bends
// the starfield and nebula around the black hole, like a real
// gravitational lens: each point shows the sky from where a point
// lens would have deflected its light (the classic Einstein-ring
// warp). Built once the parallax layers have loaded; without them
// the black hole simply appears without the warp.
// ------------------------------------------------------------

const LENS_VERTEX_SHADER = /* glsl */ `
    varying vec2 vWorld;

    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
    }
`;

const LENS_FRAGMENT_SHADER = /* glsl */ `
    uniform sampler2D uNebula;
    uniform sampler2D uFar;
    uniform sampler2D uNear;

    // Per layer (nebula, far, near): tile size, parallax factor,
    // opacity. Must match PARALLAX_LAYERS.
    uniform vec3 uTile;
    uniform vec3 uFactor;
    uniform vec3 uOpacity;

    uniform vec2 uCamera;
    uniform vec2 uCenter;
    uniform float uEinstein;
    uniform float uRadius;
    uniform float uShadow;
    uniform float uStrength;

    varying vec2 vWorld;

    // Same mapping updateParallax() uses: world point -> layer UV.
    vec2 layerUV(vec2 p, float factor, float tile) {
        return vec2(
            p.x - (1.0 - factor) * uCamera.x,
            (1.0 - factor) * uCamera.y - p.y
        ) / tile;
    }

    void main() {
        vec2 rel = vWorld - uCenter;
        float r = length(rel);

        if (r > uRadius) discard;

        // Point-lens deflection: light seen at angle r came from
        // r - E^2 / r. Inside the Einstein radius the image flips
        // to the other side of the hole, which is what makes the
        // surrounding stars smear into rings.
        float e2 = uEinstein * uEinstein * uStrength;
        vec2 source = uCenter + rel * (1.0 - e2 / max(r * r, 0.0001));

        vec3 color = texture2D(uNebula, layerUV(source, uFactor.x, uTile.x)).rgb;

        vec4 far = texture2D(uFar, layerUV(source, uFactor.y, uTile.y));
        color = mix(color, far.rgb, far.a * uOpacity.y);

        vec4 near = texture2D(uNear, layerUV(source, uFactor.z, uTile.z));
        color = mix(color, near.rgb, near.a * uOpacity.z);

        // Fade into the normal background at the edge of the disc.
        float alpha = (1.0 - smoothstep(uRadius * 0.7, uRadius, r)) * uStrength;

        if (r < uShadow) {
            color = vec3(0.0);
        }

        gl_FragColor = vec4(color, alpha);

        #include <colorspace_fragment>
    }
`;

function createLens() {
    if (blackHole.lens) return blackHole.lens;

    const layerTexture = (file) =>
        parallaxMeshes.find((mesh) => mesh.userData.layer.file === file)
            ?.material.map;

    const files = PARALLAX_LAYERS.map((layer) => layer.file);
    const textures = files.map(layerTexture);

    // Parallax layers not loaded (e.g. using the fallback image).
    if (textures.some((texture) => !texture)) return null;

    const material = new THREE.ShaderMaterial({
        vertexShader: LENS_VERTEX_SHADER,
        fragmentShader: LENS_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
            uNebula: { value: textures[0] },
            uFar: { value: textures[1] },
            uNear: { value: textures[2] },
            uTile: { value: new THREE.Vector3(...PARALLAX_LAYERS.map((l) => l.tile)) },
            uFactor: { value: new THREE.Vector3(...PARALLAX_LAYERS.map((l) => l.factor)) },
            uOpacity: { value: new THREE.Vector3(...PARALLAX_LAYERS.map((l) => l.opacity)) },
            uCamera: { value: new THREE.Vector2() },
            uCenter: { value: new THREE.Vector2() },
            uEinstein: { value: BLACK_HOLE_CONFIG.lensEinsteinRadius },
            uRadius: { value: BLACK_HOLE_CONFIG.lensRadius },
            uShadow: { value: 1.6 },
            uStrength: { value: 0 }
        }
    });

    const lens = new THREE.Mesh(parallaxGeometry, material);
    lens.name = "GravitationalLens";

    // Above the parallax layers and dust, below everything else.
    lens.position.y = -3.5;
    lens.renderOrder = -2;
    lens.frustumCulled = false;
    lens.visible = false;

    scene.add(lens);

    blackHole.lens = lens;

    return lens;
}

function updateLens(strength) {
    const lens = blackHole.lens;

    if (!lens) return;

    lens.visible = strength > 0.001;

    const size = BLACK_HOLE_CONFIG.lensRadius * 2;

    lens.position.x = BLACK_HOLE_POSITION.x;
    lens.position.z = BLACK_HOLE_POSITION.z;
    lens.scale.set(size, 1, size);

    const uniforms = lens.material.uniforms;

    uniforms.uCamera.value.set(cameraRig.x, cameraRig.z);
    uniforms.uCenter.value.set(BLACK_HOLE_POSITION.x, BLACK_HOLE_POSITION.z);
    uniforms.uStrength.value = strength;
}

// ------------------------------------------------------------
// ACTIVATE BLACK HOLE
// ------------------------------------------------------------

function activateBlackHole() {
    if (blackHole.triggered) return;
    if (!blackHole.group) return;

    blackHole.active = true;
    blackHole.triggered = true;

    blackHole.elapsed = 0;
    blackHole.consumedCount = 0;
    blackHole.asteroidSpawnTimer = 0.5;
    blackHole.flare = 0;
    blackHole.sparkTimer = 0;

    // The world is far bigger than the screen, so the black hole
    // opens on screen, a short way ahead of the ship, rather than at
    // the world's center, which could be far out of reach. (Opening
    // right on the ship would swallow it instantly with no pull-in.)
    const ahead = BLACK_HOLE_CONFIG.openDistanceAhead;

    BLACK_HOLE_POSITION.set(
        clamp(
            player.position.x + Math.sin(player.rotation) * ahead,
            -HALF_W + 3,
            HALF_W - 3
        ),
        0.35,
        clamp(
            player.position.z + Math.cos(player.rotation) * ahead,
            -HALF_H + 3,
            HALF_H - 3
        )
    );

    blackHole.group.position.copy(BLACK_HOLE_POSITION);
    blackHole.group.visible = true;

    // The streak clipping planes split the screen at the hole's
    // center: far side (screen up, -Z) and near side (+Z).
    blackHole.clipBack.constant = BLACK_HOLE_POSITION.z;
    blackHole.clipFront.constant = -BLACK_HOLE_POSITION.z;

    // Everything starts collapsed; updateBlackHoleVisuals() unfolds it.
    updateBlackHoleVisuals(0);

    createLens();
    updateLens(0);

    $("message").textContent =
        "CRITICAL EVENT: BLACK HOLE DETECTED";

    console.info(
        `Black hole event activated: survived the ${MATCH_SECONDS}s match.`
    );
}

// ------------------------------------------------------------
// BLACK HOLE EFFECTS
// Tidal streams, infalling sparks and swallow flares. These are
// purely visual: objects still move straight to the center exactly
// as before.
// ------------------------------------------------------------

const blackHoleFx = {
    streams: new Set(),
    sparks: [],
    sparkPool: [],
    flares: []
};

// A glowing ribbon of matter from an object into the hole.
function createTidalStream() {
    const stream = cloneModel("bhTidalStream");
    stream.scale.set(0.001, 1, 0.001);

    scene.add(stream);
    blackHoleFx.streams.add(stream);

    return stream;
}

function updateTidalStream(stream, position, width) {
    const dx = BLACK_HOLE_POSITION.x - position.x;
    const dz = BLACK_HOLE_POSITION.z - position.z;
    const distance = Math.hypot(dx, dz);

    // Starts at the object and reaches all the way to the hole.
    stream.position.set(position.x, 0.28, position.z);
    stream.rotation.y = Math.atan2(dx, dz);

    // Shimmer a little, like flowing gas.
    const flicker = 0.85 + Math.random() * 0.3;

    stream.scale.set(width * flicker, 1, Math.max(0.001, distance));
}

function removeTidalStream(stream) {
    if (!stream) return;

    scene.remove(stream);
    blackHoleFx.streams.delete(stream);
}

// Sparks torn off objects as they near the hole. They spiral in and
// flatten into the plane of the disk before vanishing at its edge.
function spawnBlackHoleSpark(position) {
    let mesh = blackHoleFx.sparkPool.pop();

    if (!mesh) {
        mesh = cloneModel("bhSpark");
        scene.add(mesh);
    }

    mesh.visible = true;

    const dx = position.x - BLACK_HOLE_POSITION.x;
    const dz = position.z - BLACK_HOLE_POSITION.z;

    const radius = Math.max(2.2, Math.hypot(dx, dz) + randomRange(-0.4, 0.4));

    blackHoleFx.sparks.push({
        mesh,
        angle: Math.atan2(dz, dx) + randomRange(-0.25, 0.25),
        radius,
        startRadius: radius,
        size: randomRange(0.35, 0.75),
        spin: randomRange(-6, 6)
    });
}

function updateBlackHoleSparks(dt) {
    const tilt = BLACK_HOLE_CONFIG.diskTilt;

    for (let i = blackHoleFx.sparks.length - 1; i >= 0; i--) {
        const spark = blackHoleFx.sparks[i];

        // Faster as they fall deeper, like orbiting matter.
        spark.radius -= (2.5 + 18 / spark.radius) * dt;
        spark.angle += (BLACK_HOLE_CONFIG.streakSpin * 6 / Math.max(1, spark.radius)) * dt;

        if (spark.radius <= 2.0) {
            spark.mesh.visible = false;
            blackHoleFx.sparkPool.push(spark.mesh);
            blackHoleFx.sparks.splice(i, 1);
            continue;
        }

        // 0 at the start of the fall, 1 at the disk's inner edge.
        const fall = 1 - (spark.radius - 2) / Math.max(0.01, spark.startRadius - 2);

        // Flatten into the edge-on disk as it falls.
        const squash = THREE.MathUtils.lerp(1, tilt, fall);

        spark.mesh.position.set(
            BLACK_HOLE_POSITION.x + Math.cos(spark.angle) * spark.radius,
            0.3,
            BLACK_HOLE_POSITION.z + Math.sin(spark.angle) * spark.radius * squash
        );

        spark.mesh.rotation.y += spark.spin * dt;
        spark.mesh.scale.setScalar(spark.size * (1 - 0.6 * fall));
    }
}

// A ring of light bursting from the photon ring when something is
// swallowed; `power` scales its size (the ship gets a big one).
function triggerSwallowFlare(power = 1) {
    blackHole.flare = Math.min(2.5, blackHole.flare + 0.45 * power);

    const mesh = cloneModel("bhFlare");

    mesh.position.set(BLACK_HOLE_POSITION.x, 0.32, BLACK_HOLE_POSITION.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.scale.setScalar(0.01);

    scene.add(mesh);

    blackHoleFx.flares.push({
        mesh,
        power,
        life: 0.55 + 0.25 * power,
        maxLife: 0.55 + 0.25 * power
    });
}

function updateSwallowFlares(dt) {
    blackHole.flare = Math.max(0, blackHole.flare - dt * 2.2);

    for (let i = blackHoleFx.flares.length - 1; i >= 0; i--) {
        const flare = blackHoleFx.flares[i];

        flare.life -= dt;

        if (flare.life <= 0) {
            scene.remove(flare.mesh);
            blackHoleFx.flares.splice(i, 1);
            continue;
        }

        const progress = 1 - flare.life / flare.maxLife;
        const eased = 1 - (1 - progress) ** 3;

        // Expand from the photon ring outward, thinning as it goes.
        const size = (1.7 + eased * 3.5 * flare.power) * (1 - progress * progress * 0.6);

        flare.mesh.scale.set(size, 1, size * (1 - 0.35 * progress));
        flare.mesh.rotation.y += dt * 1.5;
    }
}

// Sparks are shed by things within this distance of the hole.
function maybeShedSpark(position, dt, rate = BLACK_HOLE_CONFIG.sparkRate) {
    const dx = position.x - BLACK_HOLE_POSITION.x;
    const dz = position.z - BLACK_HOLE_POSITION.z;

    if (dx * dx + dz * dz > BLACK_HOLE_CONFIG.sparkRadius ** 2) return;

    if (Math.random() < rate * dt) {
        spawnBlackHoleSpark(position);
    }
}

function clearBlackHoleFx() {
    for (const stream of blackHoleFx.streams) {
        scene.remove(stream);
    }

    blackHoleFx.streams.clear();

    for (const spark of blackHoleFx.sparks) {
        spark.mesh.visible = false;
        blackHoleFx.sparkPool.push(spark.mesh);
    }

    blackHoleFx.sparks.length = 0;

    for (const flare of blackHoleFx.flares) {
        scene.remove(flare.mesh);
    }

    blackHoleFx.flares.length = 0;

    blackHole.flare = 0;
}

function consumeObjectImmediately(objects, index) {
    const object = objects[index];

    if (!object) return;

    // Something pulled in through the event horizon: its tidal
    // stream ends and the photon ring flares.
    if (object.blackHoleData) {
        removeTidalStream(object.blackHoleData.stream);
        triggerSwallowFlare(0.6);
    }

    discardMesh(object.mesh);

    if (object.glow) {
        scene.remove(object.glow);
    }

    objects.splice(index, 1);

    blackHole.consumedCount++;
}

function destroyShipInBlackHole() { if (!player.mesh) return;

// The ship's tidal stream ends with it.
removeTidalStream(player.blackHoleData?.stream);

// Remove the ship and its attached afterburners.
scene.remove(player.mesh);

player.mesh = null;
player.blackHoleData = null;

// Stop all ship movement.
player.velocity.set(0, 0, 0);

// End gameplay without displaying the normal game-over screen.
state.running = false;
state.gameOver = false;

saveHighScore();

// Crossing the event horizon: the photon ring erupts, the screen
// flashes white, and the black hole keeps turning on screen (see
// updateBlackHoleAftermath) before the VICTORY banner appears.
triggerSwallowFlare(2.5);
setTimeout(() => triggerSwallowFlare(1.6), 180);

state.screenShake = 0.6;

const flash = $("flash");
flash.style.transition = "none";
flash.style.opacity = "0.85";

requestAnimationFrame(() => {
    flash.style.transition = "opacity 900ms ease-out";
    flash.style.opacity = "0";
});

$("message").textContent = "EVENT HORIZON CROSSED";

if (blackHole.victoryTimer !== null) {
    clearTimeout(blackHole.victoryTimer);
}

blackHole.victoryTimer = setTimeout(() => {
    blackHole.victoryTimer = null;
    showVictoryBanner();
}, BLACK_HOLE_CONFIG.victoryDelay * 1000);

console.info("The ship crossed the event horizon.");
}

// The VICTORY banner, shown once the black hole has had its moment.
function showVictoryBanner() {

// Update the status message.
$("message").textContent = "VICTORY";

// Hide the normal game-over screen.
$("game-over").classList.add("hidden");

// Display the victory banner.
let victoryBanner = $("victory-banner");

if (!victoryBanner) {
    victoryBanner = document.createElement("div");
    victoryBanner.id = "victory-banner";

    victoryBanner.innerHTML = `
        <div class="victory-title">VICTORY!</div>
        <div class="victory-subtitle">
            YOU'VE LEFT SPACETIME
        </div>
    `;

    victoryBanner.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        /* Translucent, so the black hole stays visible behind it. */
        background: radial-gradient(circle, rgba(3, 5, 20, 0.25) 0%, rgba(3, 5, 20, 0.7) 75%);
        text-align: center;
        font-family: Arial, sans-serif;
        transition: opacity 700ms ease-out;
    `;

    const title = victoryBanner.querySelector(".victory-title");

    title.style.cssText = `
        color: #66ffff;
        font-size: clamp(56px, 12vw, 120px);
        font-weight: 900;
        letter-spacing: 0.12em;
        text-shadow:
            0 0 10px #00ffff,
            0 0 30px #00ffff,
            0 0 60px #0088ff;
        animation: victoryPulse 1s ease-in-out infinite alternate;
    `;

    const subtitle = victoryBanner.querySelector(".victory-subtitle");

    subtitle.style.cssText = `
        margin-top: 20px;
        color: #ffffff;
        font-size: clamp(14px, 3vw, 24px);
        letter-spacing: 0.2em;
    `;

    // Add the banner animation only once.
    if (!document.getElementById("victory-animation-style")) {
        const style = document.createElement("style");
        style.id = "victory-animation-style";

        style.textContent = `
            @keyframes victoryPulse {
                from {
                    transform: scale(1);
                    opacity: 0.85;
                }
                to {
                    transform: scale(1.06);
                    opacity: 1;
                }
            }
        `;

        document.head.appendChild(style);
    }

    document.body.appendChild(victoryBanner);
}

// Fade in over the still-turning black hole.
victoryBanner.style.opacity = "0";
victoryBanner.style.display = "flex";

requestAnimationFrame(() => {
    victoryBanner.style.opacity = "1";
});

// Return to the start menu after five seconds.
if (state.restartTimer !== null) {
    clearTimeout(state.restartTimer);
}

state.restartTimer = setTimeout(() => {
    victoryBanner.style.display = "none";

    // Ensure gameplay remains stopped.
    state.running = false;
    state.gameOver = false;

    // Hide the game-over screen and show the start menu.
    $("game-over").classList.add("hidden");
    $("start-screen").classList.remove("hidden");

    $("message").textContent = "READY FOR LAUNCH";

    state.restartTimer = null;
}, 5000);

console.info("Victory! The black hole consumed the ship.");


}

function updateShipSpaghettification(dt) {
    if (!player.mesh) return;

    const center = BLACK_HOLE_POSITION;

    // Direction directly toward the black hole.
    const direction = new THREE.Vector3(
        center.x - player.position.x,
        0,
        center.z - player.position.z
    );

    let distance = direction.length();

    // Save the original ship state.
    if (!player.blackHoleData) {
        player.blackHoleData = {
            originalScale: player.mesh.scale.clone(),
            originalRotation: player.mesh.rotation.clone(),
            stretchElapsed: 0,
            stretching: false
        };
    }

    const data = player.blackHoleData;

    // Consume the ship if it has reached the center.
    if (distance <= BLACK_HOLE_CONFIG.shipConsumeRadius) {
        destroyShipInBlackHole();
        return;
    }

    direction.normalize();

    // Begin the one-second stretching animation at the horizon.
    if (
        !data.stretching &&
        distance <= BLACK_HOLE_CONFIG.eventHorizonRadius
    ) {
        data.stretching = true;
        data.stretchElapsed = 0;

        // The ship's own tidal stream, and a flare as it crosses.
        data.stream = createTidalStream();
        triggerSwallowFlare(0.8);
    }

    if (data.stretching) {
        data.stretchElapsed += dt;

        const progress = THREE.MathUtils.clamp(
            data.stretchElapsed /
                BLACK_HOLE_CONFIG.stretchDuration,
            0,
            1
        );

        const stretchProgress =
            progress * progress * (3 - 2 * progress);

        const stretch = THREE.MathUtils.lerp(
            1,
            BLACK_HOLE_CONFIG.maximumStretch,
            stretchProgress
        );

        // --------------------------------------------------------
        // SHRINK AND STRETCH THE SHIP TOWARD THE CENTER
        // --------------------------------------------------------
        
        const shrinkRadius = BLACK_HOLE_CONFIG.shrinkStartRadius;
        
        const normalizedDistance = THREE.MathUtils.clamp(
            distance / shrinkRadius,
            0,
            1
        );
        
        const shrinkFactor = Math.max(
            BLACK_HOLE_CONFIG.minimumScale,
            Math.pow(normalizedDistance, BLACK_HOLE_CONFIG.shrinkExponent)
        );
        
        player.mesh.scale.set(
            data.originalScale.x * shrinkFactor,
            data.originalScale.y * shrinkFactor,
            data.originalScale.z * stretch * shrinkFactor
        );


        // Point the ship directly at the black hole.
        player.mesh.rotation.set(
            data.originalRotation.x,
            Math.atan2(direction.x, direction.z),
            0
        );

        // Move directly toward the center.
        const remainingDistance = Math.max(
            0,
            distance - BLACK_HOLE_CONFIG.shipConsumeRadius
        );

        const remainingTime = Math.max(
            0.001,
            BLACK_HOLE_CONFIG.stretchDuration -
                data.stretchElapsed
        );

        const speed = Math.min(
            BLACK_HOLE_CONFIG.maximumPullSpeed,
            remainingDistance / remainingTime
        );

        player.position.addScaledVector(
            direction,
            speed * dt
        );

        // Update the ship's position.
        player.mesh.position.set(
            player.position.x,
            0.3,
            player.position.z
        );

        distance = Math.hypot(
            center.x - player.position.x,
            center.z - player.position.z
        );

        // Matter streams off the ship into the hole.
        updateTidalStream(
            data.stream,
            player.position,
            Math.max(0.3, 1.8 * (player.mesh.scale.x / data.originalScale.x))
        );

        maybeShedSpark(player.position, dt, BLACK_HOLE_CONFIG.sparkRate * 4);

        // The ship disappears at the center or when its
        // one-second spaghettification animation completes.
        if (
            progress >= 1 ||
            distance <= BLACK_HOLE_CONFIG.shipConsumeRadius
        ) {
            destroyShipInBlackHole();
        }

        return;
    }

    // Before entering the event horizon, pull the ship inward
    // without allowing its previous velocity to create an orbit.
    const proximity = 1 - THREE.MathUtils.clamp(
        distance / BLACK_HOLE_CONFIG.influenceRadius,
        0,
        1
    );

    const speed = THREE.MathUtils.lerp(
        3,
        BLACK_HOLE_CONFIG.maximumPullSpeed,
        proximity
    );

    player.position.addScaledVector(
        direction,
        speed * dt
    );

    // Keep the ship aimed at the center throughout its approach.
    player.mesh.rotation.y = Math.atan2(
        direction.x,
        direction.z
    );

    player.mesh.position.set(
        player.position.x,
        0.3,
        player.position.z
    );

    // Close to the hole, the ship starts shedding sparks.
    maybeShedSpark(player.position, dt, BLACK_HOLE_CONFIG.sparkRate * 1.5);

    // Clear any momentum from normal player controls.
    player.velocity.set(0, 0, 0);
}

function checkBlackHoleShipConsumption() { const dx = player.position.x - BLACK_HOLE_POSITION.x; const dz = player.position.z - BLACK_HOLE_POSITION.z;

const distance = Math.sqrt(dx * dx + dz * dz);

if (distance <= BLACK_HOLE_CONFIG.shipConsumeRadius) {
    destroyShipInBlackHole();
    return true;
}

return false;


}

function consumeAllObjectsInBlackHole() {
// Destroy every asteroid immediately.
// (This loop was previously on the comment line, so it never ran.)
for (let i = asteroids.length - 1; i >= 0; i--) {
    consumeObjectImmediately(asteroids, i);
}

// Destroy every mine immediately.
for (let i = mines.length - 1; i >= 0; i--) {
    consumeObjectImmediately(mines, i);
}

// Remove all bullets.
for (let i = bullets.length - 1; i >= 0; i--) {
    removeBullet(i);
}

// Remove all pickups and their glow effects.
for (let i = pickups.length - 1; i >= 0; i--) {
    consumeObjectImmediately(pickups, i);
}

// Remove existing explosions.
for (let i = explosions.length - 1; i >= 0; i--) {
    scene.remove(explosions[i].mesh);
    explosions[i].mesh.material.dispose();
    explosions.splice(i, 1);
}

// Remove existing particles.
for (let i = particles.length - 1; i >= 0; i--) {
    scene.remove(particles[i].mesh);
    particles.splice(i, 1);
}


}

function spaghettifyObjects(objects, dt) {
    const center = BLACK_HOLE_POSITION;

    for (let i = objects.length - 1; i >= 0; i--) {
        const object = objects[i];

        if (!object || !object.mesh) {
            objects.splice(i, 1);
            continue;
        }

        // Save the object's original state when the black hole
        // begins affecting it.
        if (!object.blackHoleData) {
            object.blackHoleData = {
                originalScale: object.mesh.scale.clone(),
                originalRotation: object.mesh.rotation.clone(),
                stretchElapsed: 0,
                startPosition: object.position.clone(),
                velocity: new THREE.Vector3()
            };
        }

        const data = object.blackHoleData;

        // Calculate a direct direction toward the center.
        const direction = new THREE.Vector3(
            center.x - object.position.x,
            0,
            center.z - object.position.z
        );

        let distance = direction.length();

        // Consume the object immediately if it has reached
        // the black hole's center.
        if (distance <= BLACK_HOLE_CONFIG.consumeRadius) {
            consumeObjectImmediately(objects, i);
            continue;
        }

        direction.normalize();

        // Start the one-second animation when the object
        // enters the event horizon.
        if (!data.stretching &&
            distance <= BLACK_HOLE_CONFIG.asteroidEventHorizonRadius) {

            data.stretching = true;
            data.stretchElapsed = 0;
            data.startPosition.copy(object.position);
            data.velocity.set(0, 0, 0);

            // Matter now streams off it into the hole.
            data.stream = createTidalStream();
        }

        // Once stretching starts, the object's trajectory
        // is controlled exclusively by the black hole.
        if (data.stretching) {
            data.stretchElapsed += dt;

            const progress = THREE.MathUtils.clamp(
                data.stretchElapsed /
                    BLACK_HOLE_CONFIG.stretchDuration,
                0,
                1
            );

            // Smooth the visual stretching without changing
            // the animation's fixed one-second duration.
            const stretchProgress =
                progress * progress * (3 - 2 * progress);

            const stretch = THREE.MathUtils.lerp(
                1,
                BLACK_HOLE_CONFIG.maximumStretch,
                stretchProgress
            );
            // --------------------------------------------------------
            // SHRINK OBJECT TOWARD THE BLACK HOLE
            // --------------------------------------------------------
            
            const shrinkRadius = BLACK_HOLE_CONFIG.shrinkStartRadius;
            
            // Calculate the object's remaining distance to the center.
            const normalizedDistance = THREE.MathUtils.clamp(
                distance / shrinkRadius,
                0,
                1
            );
            
            // Smooth shrinking: full size farther away, nearly invisible
            // close to the singularity.
            const shrinkFactor = Math.max(
                BLACK_HOLE_CONFIG.minimumScale,
                Math.pow(
                    normalizedDistance,
                    BLACK_HOLE_CONFIG.shrinkExponent
                )
            );
            
            // Stretch the object while shrinking it.
            object.mesh.scale.set(
                data.originalScale.x * shrinkFactor,
                data.originalScale.y * shrinkFactor,
                data.originalScale.z * stretch * shrinkFactor
            );

            // Fade the object as it shrinks toward the singularity.
            fadeObjectTowardBlackHole(
                object.mesh,
                shrinkFactor
            );



            // Point the object's heading directly toward
            // the black hole's center.
            object.mesh.rotation.set(
                data.originalRotation.x,
                Math.atan2(direction.x, direction.z),
                0
            );

            // Disable any previous velocity and move directly
            // toward the center. No tangential force is applied.
            const remainingDistance = Math.max(
                0,
                distance - BLACK_HOLE_CONFIG.consumeRadius
            );

            const remainingTime = Math.max(
                0.001,
                BLACK_HOLE_CONFIG.stretchDuration -
                    data.stretchElapsed
            );

            const speed = Math.min(
                BLACK_HOLE_CONFIG.maximumPullSpeed,
                remainingDistance / remainingTime
            );

            object.position.addScaledVector(
                direction,
                speed * dt
            );

            // Check the center again after movement.
            distance = Math.hypot(
                center.x - object.position.x,
                center.z - object.position.z
            );

            // Consume when the one-second animation completes
            // or when the object reaches the center.
            if (
                progress >= 1 ||
                distance <= BLACK_HOLE_CONFIG.consumeRadius
            ) {
                consumeObjectImmediately(objects, i);
                continue;
            }

            // Keep the mesh aligned with its logical position.
            object.mesh.position.copy(object.position);

            // A glowing stream from the object into the hole, as
            // wide as the (shrinking) object, plus a shower of
            // sparks as it is torn apart.
            updateTidalStream(
                data.stream,
                object.position,
                Math.max(
                    0.25,
                    (object.radius ?? 0.8) * 1.6 *
                        (object.mesh.scale.x / data.originalScale.x)
                )
            );

            maybeShedSpark(object.position, dt, BLACK_HOLE_CONFIG.sparkRate * 3);

            continue;
        }

        // Outside the event horizon, pull directly inward.
        // Do not preserve the asteroid's previous velocity.
        const proximity = 1 - THREE.MathUtils.clamp(
            distance / BLACK_HOLE_CONFIG.influenceRadius,
            0,
            1
        );

        const speed = THREE.MathUtils.lerp(
            3,
            BLACK_HOLE_CONFIG.maximumPullSpeed,
            proximity
        );

        object.position.addScaledVector(
            direction,
            speed * dt
        );

        object.mesh.position.copy(object.position);

        // Close to the hole, it starts shedding sparks.
        maybeShedSpark(object.position, dt);
    }
}

// ------------------------------------------------------------
// RESTORE ASTEROID AND MINE MATERIALS
// ------------------------------------------------------------

function restoreBlackHoleMaterials(objects) {
    for (const object of objects) {
        if (!object.mesh) continue;

        // Undo fadeObjectTowardBlackHole using the values it saved
        // on each material.
        object.mesh.traverse((child) => {
            if (!child.isMesh) return;

            const materials = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const material of materials) {
                if (!material) continue;

                const saved = material.userData;

                if (saved.originalOpacity === undefined) continue;

                material.opacity = saved.originalOpacity;
                material.transparent = saved.originalTransparent;
                material.depthWrite = !saved.originalTransparent;
                material.needsUpdate = true;

                delete saved.originalOpacity;
                delete saved.originalTransparent;
            }
        });

        // Restore the original asteroid or mine scale.
        if (object.blackHoleData) {
            removeTidalStream(object.blackHoleData.stream);

            object.mesh.scale.copy(
                object.blackHoleData.originalScale
            );

            delete object.blackHoleData;
        }
    }
}

// ------------------------------------------------------------
// UPDATE BLACK HOLE VISUALS
// Animates all six GLB models and the gravitational glow.
// ------------------------------------------------------------

function updateBlackHoleVisuals(dt) {
    if (!blackHole.group || !blackHole.active) return;

    // Read the event timer without advancing it.
    const t = blackHole.elapsed;
    const smooth = THREE.MathUtils.smoothstep;

    // ---- Opening sequence ---------------------------------------
    // The shadow punches open, the photon ring ignites, the lensed
    // halo blooms around it, then the disk unfurls sideways.
    const shadowIn = smooth(t, 0, 0.7);
    const ringIn = smooth(t, 0.1, 0.8);
    const haloIn = smooth(t, 0.3, 1.4);
    const diskIn = smooth(t, 0.45, 1.8);

    // A brief overshoot as the photon ring ignites.
    const ignite = Math.exp(-((t - 0.75) ** 2) / 0.04) * 0.25;

    // Swallow flares make the ring and halo pulse.
    const flare = blackHole.flare;

    const shadowScale = Math.max(0.001, shadowIn);
    blackHole.shadow.scale.setScalar(shadowScale);

    blackHole.photonRing.scale.setScalar(
        Math.max(0.001, ringIn * (1 + ignite + 0.12 * flare))
    );

    // The halo breathes slowly.
    const breathe = 1 + Math.sin(t * 2.1) * 0.012;

    blackHole.halo.scale.set(
        Math.max(0.001, haloIn * breathe * (1 + 0.04 * flare)),
        1,
        Math.max(0.001, haloIn * breathe * (1 + 0.06 * flare))
    );

    // Disk: unfurls horizontally, squashed into the edge-on band.
    const tilt = BLACK_HOLE_CONFIG.diskTilt;

    blackHole.diskGroup.scale.set(
        Math.max(0.001, diskIn),
        1,
        Math.max(0.001, diskIn * tilt)
    );

    // Orbiting plasma: both clipped copies turn together. (Spinning
    // inside the squashed group makes them follow the ellipse.)
    const spin = BLACK_HOLE_CONFIG.streakSpin * dt * (1 + 0.5 * flare);

    blackHole.streaksBack.rotation.y += spin;
    blackHole.streaksFront.rotation.y = blackHole.streaksBack.rotation.y;

    // Gravitational lensing ramps up with the opening.
    updateLens(smooth(t, 0, 1.5) * (1 + 0.08 * flare));

    // ---- Effects --------------------------------------------------
    updateBlackHoleSparks(dt);
    updateSwallowFlares(dt);
}

// ------------------------------------------------------------
// AFTER THE SHIP IS SWALLOWED
// Gameplay has stopped, but the black hole keeps turning and the
// remaining asteroids and mines keep streaming into it behind the
// translucent VICTORY banner.
// ------------------------------------------------------------

function updateBlackHoleAftermath(dt) {
    if (state.running || !blackHole.active) return;

    blackHole.elapsed += dt;

    spaghettifyObjects(asteroids, dt);
    spaghettifyObjects(mines, dt);

    updateBlackHoleVisuals(dt);
    updateEffects(dt);
    updateSmoke(dt);
    updateVaporTrails(dt);

    state.screenShake = Math.max(0, state.screenShake - dt);
}

// ------------------------------------------------------------
// UPDATE BLACK HOLE EVENT
// Controls the black hole visuals, gravity, and ship consumption.
// ------------------------------------------------------------

function updateBlackHole(dt) {
    if (!blackHole.active) return;

    // Advance the event timer exactly once per frame.
    blackHole.elapsed += dt;

    // Update the black hole's visual effects.
    updateBlackHoleVisuals(dt);

    // Stop normal enemy spawning during the event.
    state.spawnTimer = 999999;
    state.mineTimer = 999999;
    state.pickupTimer = 999999;

    // Pull asteroids and mines toward the singularity.
    spaghettifyObjects(asteroids, dt);
    spaghettifyObjects(mines, dt);

    // --------------------------------------------------------
    // PULL AND STRETCH THE PLAYER'S SHIP
    // --------------------------------------------------------

    if (player.mesh) {
        updateShipSpaghettification(dt);
    }

    // Stop updating the ship if it has been consumed.
    if (!player.mesh) return;

    // Remove any remaining projectiles.
    for (let i = bullets.length - 1; i >= 0; i--) {
        removeBullet(i);
    }

    // Remove pickups during the black hole event.
    for (let i = pickups.length - 1; i >= 0; i--) {
        consumeObjectImmediately(pickups, i);
    }

    // --------------------------------------------------------
    // END THE EVENT
    // --------------------------------------------------------

    if (blackHole.elapsed >= BLACK_HOLE_CONFIG.duration) {
        blackHole.active = false;
        blackHole.group.visible = false;

        updateLens(0);
        clearBlackHoleFx();

        // Restore asteroid and mine materials.
        restoreBlackHoleMaterials(asteroids);
        restoreBlackHoleMaterials(mines);

        // Restore the ship's original scale.
        if (player.mesh && player.blackHoleData) {
            player.mesh.scale.copy(
                player.blackHoleData.originalScale
            );

            player.blackHoleData = null;
        }

        // Resume normal spawning.
        state.spawnTimer = 1.5;
        state.mineTimer = 5;
        state.pickupTimer = 5;

        $("message").textContent =
            `SINGULARITY COMPLETE — ${blackHole.consumedCount} OBJECTS CONSUMED`;

        console.info(
            "Black hole event complete:",
            blackHole.consumedCount,
            "objects consumed."
        );
    }
}


// Build the visual bubble around the ship.
function createWarpBubble() {
    // Remove a previous bubble if one exists.
    if (warp.group) {
        scene.remove(warp.group);
    }

    warp.group = new THREE.Group();
    warp.group.name = "WarpBubble";

    warp.models = {};

    const modelDefinitions = [
        {
            key: "core",
            asset: "warpCore",
            radius: 3.5
        },
        {
            key: "arcs",
            asset: "warpArcs",
            radius: 4.2
        },
        {
            key: "pulse",
            asset: "warpPulse",
            radius: 3.8
        },
        {
            key: "ripple",
            asset: "warpRipple",
            radius: 4.5
        },
        {
            key: "shimmer",
            asset: "warpShimmer",
            radius: 4.0
        },
        {
            key: "impact",
            asset: "warpImpact",
            radius: 3.6
        }
    ];

    for (const definition of modelDefinitions) {
        const model = cloneModel(definition.asset);

        // Calculate the model's dimensions.
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());

        const maxDimension = Math.max(
            size.x,
            size.y,
            size.z
        );

        // Avoid division by zero for empty or invalid models.
        if (maxDimension > 0.0001) {
            model.scale.multiplyScalar(
                definition.radius / maxDimension
            );
        }

        // Center the geometry around its bounding-box center.
        const center = box.getCenter(new THREE.Vector3());

        model.position.sub(center);

        model.visible = false;

        warp.group.add(model);
        warp.models[definition.key] = model;
    }

    // A local light makes the bubble feel energized.
    const glow = new THREE.PointLight(
        0x35dfff,
        3.0,
        12
    );

    glow.position.set(0, 1.0, 0);

    warp.group.add(glow);
    warp.models.glow = glow;

    warp.group.visible = false;

    scene.add(warp.group);
}


// Activate or refresh the warp power-up.
function activateWarp() {
    if (!warp.group) return;

    warp.active = true;
    warp.remaining = WARP_DURATION;
    warp.elapsed = 0;
    warp.activationCount++;

    warp.group.visible = true;

    // Show all six visual layers.
    for (const [key, model] of Object.entries(warp.models)) {
        if (key !== "glow") {
            model.visible = true;
        }
    }

    // Reset the initial scale for the activation animation.
    warp.group.scale.setScalar(0.1);

    // Notify the player.
    $("message").textContent = "WARP BUBBLE ACTIVATED";

    console.info(
        `Warp bubble activated for ${WARP_DURATION} seconds.`
    );
}


// End the warp effect.
function deactivateWarp() {
    warp.active = false;
    warp.remaining = 0;
    warp.elapsed = 0;

    if (warp.group) {
        warp.group.visible = false;
        warp.group.scale.setScalar(1);
    }

    const warpStatus = $("warp-status");

    if (warpStatus) {
        warpStatus.style.display = "none";
    }

    $("message").textContent = "WARP FIELD OFFLINE";

    console.info("Warp bubble expired.");
}

// Update the bubble animation and its timer.
function updateWarp(dt) {
    if (!warp.group || !warp.active) return;

    warp.elapsed += dt;
    warp.remaining -= dt;

    // Expire the warp before updating its visuals.
    if (warp.remaining <= 0) {
        deactivateWarp();
        return;
    }

    // Keep the bubble centered on the player.
    warp.group.position.set(
        player.position.x,
        0.3,
        player.position.z
    );

    // Animate the arcs.
    if (warp.models.arcs) {
        warp.models.arcs.rotation.y += dt * 0.9;
        warp.models.arcs.rotation.x =
            Math.sin(warp.elapsed * 1.2) * 0.12;
    }

    // Rotate the core.
    if (warp.models.core) {
        warp.models.core.rotation.y -= dt * 0.22;
    }

    // Animate the shimmer.
    if (warp.models.shimmer) {
        warp.models.shimmer.rotation.y += dt * 0.4;
        warp.models.shimmer.rotation.z =
            Math.sin(warp.elapsed * 2.0) * 0.08;
    }

    // Pulse the energy layers.
    if (warp.models.pulse) {
        const pulse =
            1 + Math.sin(warp.elapsed * 3.2) * 0.08;

        warp.models.pulse.scale.setScalar(pulse);
    }

    if (warp.models.ripple) {
        const ripple =
            1 + Math.sin(warp.elapsed * 2.4) * 0.06;

        warp.models.ripple.scale.setScalar(ripple);
    }

    if (warp.models.impact) {
        warp.models.impact.rotation.y -= dt * 0.7;
    }

    if (warp.models.glow) {
        warp.models.glow.intensity =
            2.4 + Math.sin(warp.elapsed * 5.0) * 0.8;
    }

    // Animate the initial appearance.
    if (warp.elapsed < 0.6) {
        warp.group.scale.setScalar(
            THREE.MathUtils.smoothstep(
                warp.elapsed,
                0,
                0.6
            )
        );
    } else if (warp.remaining > 2) {
        warp.group.scale.setScalar(1);
    } else {
        // Fade during the final two seconds.
        warp.group.scale.setScalar(
            THREE.MathUtils.clamp(
                warp.remaining / 2,
                0,
                1
            )
        );
    }

    // Update the optional countdown (only touch the DOM on change).
    const warpStatus = $("warp-status");
    const warpTime = $("warp-time");

    if (warpStatus && warpTime) {
        const seconds = String(Math.ceil(warp.remaining));

        if (warpStatus.style.display !== "block") {
            warpStatus.style.display = "block";
        }

        if (warpTime.textContent !== seconds) {
            warpTime.textContent = seconds;
        }
    }
}

// With the mouse, the cursor must be at least this far (in world
// units) from the ship to steer it or (when dragging) to thrust.
const MOUSE_DEADZONE = 2.5;

function updatePlayer(dt) {
    const turnSpeed = 2.8;
    const mouseTurnSpeed = 5;

    // --------------------------------------------------------
    // STEERING: The most recent input controls the heading.
    // --------------------------------------------------------

    const turningLeft = keys.KeyA || keys.ArrowLeft;
    const turningRight = keys.KeyD || keys.ArrowRight;

    if (steeringMode === "keyboard") {
        // Turn only while a turning key is held.
        if (turningLeft) {
            player.rotation += turnSpeed * dt;
        }

        if (turningRight) {
            player.rotation -= turnSpeed * dt;
        }
    } else if (steeringMode === "mouse") {
        // Steer toward the cursor.
        const dx = player.aim.x - player.position.x;
        const dz = player.aim.z - player.position.z;

        // The camera keeps the ship near the middle of the screen,
        // which is also where a resting cursor tends to be. Chasing
        // a point right on top of the ship made the heading flip
        // around or lock up, so inside this dead zone the ship
        // simply holds its course.
        if (dx * dx + dz * dz > MOUSE_DEADZONE * MOUSE_DEADZONE) {
            const targetRotation = Math.atan2(dx, dz);

            let angleDifference =
                targetRotation - player.rotation;

            angleDifference = Math.atan2(
                Math.sin(angleDifference),
                Math.cos(angleDifference)
            );

            player.rotation += THREE.MathUtils.clamp(
                angleDifference,
                -mouseTurnSpeed * dt,
                mouseTurnSpeed * dt
            );
        }
    }

    // Apply the current heading.
    if (player.mesh) {
        player.mesh.rotation.y = player.rotation;
    }

    // --------------------------------------------------------
    // MOVEMENT: Original WASD / arrow-key controls.
    // --------------------------------------------------------

    const forward = new THREE.Vector3(
        Math.sin(player.rotation),
        0,
        Math.cos(player.rotation)
    );
    let thrust = 0;
    
    const forwardKeyPressed =
        keys.KeyW || keys.ArrowUp;
    
    const reverseKeyPressed =
        keys.KeyS || keys.ArrowDown;
    
    // Keyboard movement takes priority.
    if (forwardKeyPressed) {
        thrust = 1;
    } else if (reverseKeyPressed) {
        thrust = -1;
    }
    
    // Mouse and touchscreen forward movement.
    else if (
        steeringMode === "mouse" &&
        pointerSteering
    ) {
        const dx = player.aim.x - player.position.x;
        const dz = player.aim.z - player.position.z;
    
        const distance = Math.sqrt(
            dx * dx + dz * dz
        );
    
        if (distance > MOUSE_DEADZONE) {
            thrust = 1;
        }
    }
    
    // Activate the effects only during forward thrust.
    setAfterburnersActive(thrust > 0);

    // The retro thrusters fire only while reversing.
    setRetroThrustersActive(thrust < 0);

    // Shift boosts; the warp bubble doubles the ship's speed while it
    // is active (on top of any boost).
    const targetSpeed =
        player.speed *
        ((keys.ShiftLeft || keys.ShiftRight) ? 1.35 : 1) *
        (warp.active ? WARP_SPEED_MULTIPLIER : 1);

    if (thrust !== 0) {
        player.velocity.x = THREE.MathUtils.damp(
            player.velocity.x,
            forward.x * targetSpeed * thrust,
            8,
            dt
        );

        player.velocity.z = THREE.MathUtils.damp(
            player.velocity.z,
            forward.z * targetSpeed * thrust,
            8,
            dt
        );
    } else {
        player.velocity.x = THREE.MathUtils.damp(
            player.velocity.x,
            0,
            2,
            dt
        );

        player.velocity.z = THREE.MathUtils.damp(
            player.velocity.z,
            0,
            2,
            dt
        );
    }

    // Update the player's position.
    player.position.x += player.velocity.x * dt;
    player.position.z += player.velocity.z * dt;

    // Keep the ship inside the arena.
    player.position.x = clamp(
        player.position.x,
        -HALF_W + 1,
        HALF_W - 1
    );

    player.position.z = clamp(
        player.position.z,
        -HALF_H + 1,
        HALF_H - 1
    );

    // Update the model's position.
    if (player.mesh) {
        player.mesh.position.set(
            player.position.x,
            0.3 + Math.sin(state.elapsed * 9) * 0.035,
            player.position.z
        );
    }

    // Keep the original firing behavior.
    if (firing && state.running) {
        fireBullet();

        // The laser has its own cooldown and does nothing until
        // it is unlocked.
        tryFireLaser();
    }
}


// ------------------------------------------------------------
// PROJECTILES
// ------------------------------------------------------------

function fireBullet() {
    // Taps and clicks call this directly, so guard on game state too.
    if (!state.running || blackHole.active) return;
    if (state.fireCooldown > 0) return;
    if (!player.mesh) return;

    state.fireCooldown = 0.16;

    // The ship's heading is a pure Y rotation, so its forward vector
    // can be computed directly instead of via a world quaternion.
    const direction = new THREE.Vector3(
        Math.sin(player.rotation),
        0,
        Math.cos(player.rotation)
    );

    // Spawn the bullet ahead of the ship's nose.
    const start = player.position.clone().add(
        direction.clone().multiplyScalar(1.1)
    );

    start.y = 0.45;

    const mesh = new THREE.Mesh(
        projectileGeometry,
        bulletMaterial
    );

    mesh.position.copy(start);
    scene.add(mesh);

    const glow = new THREE.Mesh(
        projectileGlowGeometry,
        bulletGlowMaterial
    );

    glow.position.copy(start);
    scene.add(glow);

    bullets.push({
        mesh,
        glow,
        position: start,
        velocity: direction.multiplyScalar(31),
        radius: 0.20,
        life: 1.15
    });
}

function removeBullet(index) {
    const bullet = bullets[index];

    scene.remove(bullet.mesh);
    scene.remove(bullet.glow);

    bullets.splice(index, 1);
}

function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];

        // Remember where this frame's movement started, for the
        // swept collision test in resolveCollisions().
        bullet.prevX = bullet.position.x;
        bullet.prevZ = bullet.position.z;

        bullet.position.addScaledVector(bullet.velocity, dt);
        bullet.mesh.position.copy(bullet.position);
        bullet.glow.position.copy(bullet.position);

        bullet.life -= dt;

        if (
            bullet.life <= 0 ||
            Math.abs(bullet.position.x) > HALF_W + 2 ||
            Math.abs(bullet.position.z) > HALF_H + 2
        ) {
            removeBullet(i);
        }
    }
}

// ------------------------------------------------------------
// ASTEROIDS
// ------------------------------------------------------------

function createAsteroid(position, size = 1, level = 0) {
    const choices = ["asteroid1", "asteroid2", "asteroid3"];
    const mesh = cloneModel(
        choices[Math.floor(Math.random() * choices.length)]
    );

    // Give this asteroid independent materials so its fade
    // animation cannot affect other asteroid instances.
    ownMaterials(mesh);


    mesh.position.copy(position);
    mesh.position.y = 0.2 + Math.random() * 0.25;

    const scale = size * randomRange(0.75, 1.15);
    mesh.scale.setScalar(scale);

    mesh.rotation.set(
        randomRange(-0.2, 0.2),
        randomRange(0, Math.PI * 2),
        randomRange(-0.2, 0.2)
    );

    scene.add(mesh);

    const target = new THREE.Vector3(
        player.position.x + randomRange(-3, 3),
        0,
        player.position.z + randomRange(-3, 3)
    );

    const direction = target.sub(position);
    direction.y = 0;

    if (direction.lengthSq() < 0.1) {
        direction.set(1, 0, 0);
    }

    direction.normalize();

    const speed = randomRange(1.6, 3.0) + state.sector * 0.12;

    asteroids.push({
        mesh,
        position: mesh.position,
        velocity: direction.multiplyScalar(speed),
        radius: 0.82 * scale,
        hp: size >= 1.25 ? 3 : size >= 0.85 ? 2 : 1,
        size,
        level,
        spin: randomRange(-1.0, 1.0),
        scoreValue: Math.round(100 / Math.max(0.5, size))
    });
}


// Rocks this far beyond the edge of the view are removed.
const ASTEROID_DESPAWN_MARGIN = 25;

function spawnAsteroid() {
    // Arrive from just off screen, wherever the camera is.
    let position = offscreenSpawnPosition();

    // Avoid spawning directly on top of the player. Off-screen
    // points are normally far enough; retry a few times if not.
    for (
        let attempt = 0;
        attempt < 4 && position.distanceTo(player.position) < 13;
        attempt++
    ) {
        position = offscreenSpawnPosition();
    }

    const size = Math.random() < 0.20 ? 1.45 :
                 Math.random() < 0.55 ? 1.0 : 0.72;

    createAsteroid(position, size);
}

function destroyAsteroid(index) {
    const asteroid = asteroids[index];

    createExplosion(asteroid.position, asteroid.radius, 10);
    addScore(asteroid.scoreValue);

    // Large rocks split into smaller rocks.
    if (asteroid.size > 0.9) {
        for (let i = 0; i < 2; i++) {
            const offset = new THREE.Vector3(
                randomRange(-0.5, 0.5),
                0,
                randomRange(-0.5, 0.5)
            );

            createAsteroid(
                asteroid.position.clone().add(offset),
                asteroid.size * 0.58,
                asteroid.level + 1
            );
        }
    }

    // Small chance of an energy pickup.
    if (Math.random() < 0.11) {
        createPickup(asteroid.position.clone());
    }

    // Fragments were appended to the end, so `index` is still valid.
    discardMesh(asteroid.mesh);
    asteroids.splice(index, 1);
}

// ------------------------------------------------------------
// WARP FIELD PHYSICS
// Destroys asteroids that enter the warp bubble.
// ------------------------------------------------------------

// Returns true if the asteroid at `index` was destroyed.
function applyWarpToAsteroid(index) {
    if (!warp.active) return false;

    const asteroid = asteroids[index];

    const dx = asteroid.position.x - player.position.x;
    const dz = asteroid.position.z - player.position.z;

    // Ignore asteroids outside the warp field (squared distance
    // avoids a square root per asteroid per frame).
    if (dx * dx + dz * dz >= WARP_RADIUS * WARP_RADIUS) {
        return false;
    }

    createExplosion(
        asteroid.position.clone(),
        asteroid.radius,
        14
    );

    addScore(asteroid.scoreValue);

    // Remove the asteroid without spawning smaller rocks.
    discardMesh(asteroid.mesh);
    asteroids.splice(index, 1);

    return true;
}

function updateAsteroids(dt) {
    const pull = 0.12 * dt;
    const maxSpeed = 5.5 + state.sector * 0.1;

    for (let i = asteroids.length - 1; i >= 0; i--) {
        // Apply the warp field before moving the asteroid.
        // (Previously used indexOf + includes: O(n²) per frame.)
        if (applyWarpToAsteroid(i)) {
            continue;
        }

        const asteroid = asteroids[i];

        // The world is bigger than the screen now: quietly retire
        // rocks that have drifted far out of view, so the asteroid
        // cap is spent on rocks near the player.
        if (
            Math.abs(asteroid.position.x - cameraRig.x) > viewHalfWidth() + ASTEROID_DESPAWN_MARGIN ||
            Math.abs(asteroid.position.z - cameraRig.z) > viewHalfHeight() + ASTEROID_DESPAWN_MARGIN
        ) {
            discardMesh(asteroid.mesh);
            asteroids.splice(i, 1);
            continue;
        }

        // Start of this frame's movement, for swept collisions.
        asteroid.prevX = asteroid.position.x;
        asteroid.prevZ = asteroid.position.z;

        asteroid.position.addScaledVector(asteroid.velocity, dt);

        asteroid.mesh.rotation.y += asteroid.spin * dt;
        asteroid.mesh.rotation.x += asteroid.spin * dt * 0.22;

        // Bounce off the arena edges.
        if (
            asteroid.position.x < -HALF_W + asteroid.radius ||
            asteroid.position.x > HALF_W - asteroid.radius
        ) {
            asteroid.velocity.x *= -1;
        }

        if (
            asteroid.position.z < -HALF_H + asteroid.radius ||
            asteroid.position.z > HALF_H - asteroid.radius
        ) {
            asteroid.velocity.z *= -1;
        }

        asteroid.position.x = clamp(
            asteroid.position.x,
            -HALF_W + asteroid.radius,
            HALF_W - asteroid.radius
        );

        asteroid.position.z = clamp(
            asteroid.position.z,
            -HALF_H + asteroid.radius,
            HALF_H - asteroid.radius
        );

        // A tiny attraction toward the player keeps the arena active.
        // Computed with scalars to avoid a new Vector3 per asteroid
        // per frame.
        const tx = player.position.x - asteroid.position.x;
        const tz = player.position.z - asteroid.position.z;
        const lengthSq = tx * tx + tz * tz;

        if (lengthSq > 0.1) {
            const inverseLength = 1 / Math.sqrt(lengthSq);

            asteroid.velocity.x += tx * inverseLength * pull;
            asteroid.velocity.z += tz * inverseLength * pull;
            asteroid.velocity.clampLength(0, maxSpeed);
        }
    }
}

// ------------------------------------------------------------
// SPACE MINES
// ------------------------------------------------------------

function createMine(position) {
    const mesh = cloneModel("mine");

    // Without this, the black hole fade wrote to the mine model's
    // shared materials, so mines stayed faded/invisible after a restart.
    ownMaterials(mesh);

    mesh.position.copy(position);
    mesh.position.y = 0.35;
    mesh.scale.setScalar(0.65);
    scene.add(mesh);

    const towardPlayer = player.position.clone().sub(position);
    towardPlayer.y = 0;

    if (towardPlayer.lengthSq() > 0) {
        towardPlayer.normalize();
    }

    mines.push({
        mesh,
        position: mesh.position,
        velocity: towardPlayer.multiplyScalar(
            randomRange(1.1, 2.0)
        ),
        radius: 0.8,
        life: 16,
        pulse: Math.random() * 6
    });
}

function spawnMine() {
    const position = offscreenSpawnPosition();
    createMine(position);
}

function updateMines(dt) {
    for (let i = mines.length - 1; i >= 0; i--) {
        const mine = mines[i];

        // Start of this frame's movement, for swept collisions.
        mine.prevX = mine.position.x;
        mine.prevZ = mine.position.z;

        mine.position.addScaledVector(mine.velocity, dt);
        mine.mesh.rotation.y += dt * 0.7;
        mine.pulse += dt * 5;
        mine.life -= dt;

        const pulseScale = 0.65 + Math.sin(mine.pulse) * 0.04;
        mine.mesh.scale.setScalar(pulseScale);

        if (mine.life <= 0) {
            discardMesh(mine.mesh);
            mines.splice(i, 1);
        }
    }
}

function destroyMine(index) {
    const mine = mines[index];

    createExplosion(mine.position, 1.1, 15);
    addScore(250);

    discardMesh(mine.mesh);
    mines.splice(index, 1);
}

// ------------------------------------------------------------
// PICKUPS
// ------------------------------------------------------------

function createPickup(position) {
    const mesh = cloneModel("crystal");
    mesh.position.copy(position);
    mesh.position.y = 0.5;
    mesh.scale.setScalar(0.5);

    scene.add(mesh);

    // Shared geometry: a new sphere per pickup was never disposed.
    const glow = new THREE.Mesh(
        pickupGlowGeometry,
        pickupGlowMaterial
    );

    glow.position.copy(mesh.position);
    scene.add(glow);

    pickups.push({
        mesh,
        glow,
        position: mesh.position,
        radius: 0.9,
        life: 12,
        phase: Math.random() * Math.PI * 2
    });
}

function updatePickups(dt) {
    for (let i = pickups.length - 1; i >= 0; i--) {
        const pickup = pickups[i];

        pickup.life -= dt;
        pickup.phase += dt * 3;

        pickup.mesh.rotation.y += dt * 1.8;
        pickup.mesh.rotation.x += dt * 0.4;

        pickup.mesh.position.y = 0.5 + Math.sin(pickup.phase) * 0.18;

        pickup.glow.position.copy(pickup.mesh.position);
        pickup.glow.scale.setScalar(
            0.9 + Math.sin(pickup.phase * 1.4) * 0.12
        );

        if (pickup.life <= 0) {
            scene.remove(pickup.mesh);
            scene.remove(pickup.glow);
            pickups.splice(i, 1);
        }
    }
}

// ------------------------------------------------------------
// EXPLOSIONS AND PARTICLES
// ------------------------------------------------------------

const particleGeometry = new THREE.TetrahedronGeometry(0.12, 0);

function createExplosion(position, radius = 1, count = 12) {
    // The flash fades individually, so it needs its own material,
    // but the sphere geometry is shared.
    const flash = new THREE.Mesh(
        explosionGeometry,
        explosionMaterial.clone()
    );

    flash.position.copy(position);
    flash.position.y = 0.4;
    scene.add(flash);

    explosions.push({
        mesh: flash,
        life: 0.24,
        maxLife: 0.24,
        radius
    });

    for (let i = 0; i < count; i++) {
        // Particles never change their material, so they share one.
        const mesh = new THREE.Mesh(
            particleGeometry,
            particleMaterial
        );

        mesh.position.copy(position);
        mesh.position.y = 0.4;

        const angle = Math.random() * Math.PI * 2;
        const speed = randomRange(2, 8);

        scene.add(mesh);

        particles.push({
            mesh,
            velocity: new THREE.Vector3(
                Math.cos(angle) * speed,
                randomRange(-0.2, 0.2),
                Math.sin(angle) * speed
            ),
            life: randomRange(0.25, 0.8)
        });
    }
}

function updateEffects(dt) {
    for (let i = explosions.length - 1; i >= 0; i--) {
        const effect = explosions[i];

        effect.life -= dt;

        const progress = 1 - effect.life / effect.maxLife;
        effect.mesh.scale.setScalar(1 + progress * effect.radius * 2);
        effect.mesh.material.opacity = Math.max(0, 1 - progress);

        if (effect.life <= 0) {
            scene.remove(effect.mesh);
            effect.mesh.material.dispose();
            explosions.splice(i, 1);
        }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const particle = particles[i];

        particle.life -= dt;
        particle.mesh.position.addScaledVector(
            particle.velocity, dt
        );

        particle.velocity.multiplyScalar(Math.max(0, 1 - dt * 1.8));
        particle.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 1.3));

        if (particle.life <= 0) {
            scene.remove(particle.mesh);
            particles.splice(i, 1);
        }
    }
}

// ------------------------------------------------------------
// COLLISIONS
// ------------------------------------------------------------

function circlesOverlap(a, b, radiusA, radiusB) {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    const r = radiusA + radiusB;

    return dx * dx + dz * dz < r * r;
}

function damagePlayer() {
    if (state.damageCooldown > 0 || !state.running) return;

    state.lives--;
    state.damageCooldown = 1.5;
    state.screenShake = 0.45;


    createExplosion(player.position, 1.3, 16);
    updateHUD();

    const flash = $("flash");
    flash.style.transition = "none";
    flash.style.opacity = "0.7";

    requestAnimationFrame(() => {
        flash.style.transition = "opacity 250ms ease";
        flash.style.opacity = "0";
    });

    if (state.lives <= 0) {
        endGame();
    } else {
        $("message").textContent = "WARNING: HULL DAMAGED";
    }
}

// ------------------------------------------------------------
// SWEPT (CONTINUOUS) COLLISION
//
// Bullets move about 0.5 units per frame at 60 fps and over 1 unit
// at 30 fps, which is more than the width of the smallest rocks.
// Testing only where things end up each frame let bullets skip
// straight through small or oncoming asteroids (about 1 shot in 4
// at the smallest rocks at 30 fps), and ignored which rock the
// bullet actually reached first.
//
// Instead, both objects' movement during the frame is considered:
// in the target's frame of reference, the bullet travels in a
// straight line from (start - targetStart) to (end - targetEnd),
// and we find the first moment that line comes within the sum of
// the two radii. The asteroid's direction and speed are part of
// that relative motion.
// ------------------------------------------------------------

// Earliest fraction of the frame (0-1) at which a point moving
// from (x0, z0) to (x1, z1) comes within `radius` of the origin,
// or -1 if it never does.
function sweptCircleHit(x0, z0, x1, z1, radius) {
    const c = x0 * x0 + z0 * z0 - radius * radius;

    // Already touching at the start of the frame.
    if (c <= 0) return 0;

    const dx = x1 - x0;
    const dz = z1 - z0;
    const a = dx * dx + dz * dz;

    // Not moving relative to each other, and not touching.
    if (a < 1e-12) return -1;

    const b = 2 * (x0 * dx + z0 * dz);
    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) return -1;

    const t = (-b - Math.sqrt(discriminant)) / (2 * a);

    return t >= 0 && t <= 1 ? t : -1;
}

// Swept test of one bullet against every target in `targets`.
// Returns the index of the target hit first, and sets
// `bulletHit.t` to when in the frame it happened.
const bulletHit = { t: 0 };

function firstTargetHit(bullet, targets) {
    const bx0 = bullet.prevX ?? bullet.position.x;
    const bz0 = bullet.prevZ ?? bullet.position.z;
    const bx1 = bullet.position.x;
    const bz1 = bullet.position.z;

    let bestIndex = -1;
    let bestT = Infinity;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];

        // Objects created this frame (e.g. fragments) have no
        // start position yet; treat them as stationary.
        const tx0 = target.prevX ?? target.position.x;
        const tz0 = target.prevZ ?? target.position.z;
        const tx1 = target.position.x;
        const tz1 = target.position.z;

        const t = sweptCircleHit(
            bx0 - tx0,
            bz0 - tz0,
            bx1 - tx1,
            bz1 - tz1,
            bullet.radius + target.radius
        );

        if (t >= 0 && t < bestT) {
            bestT = t;
            bestIndex = i;
        }
    }

    bulletHit.t = bestT;

    return bestIndex;
}

function resolveCollisions() {
    // Player bullets versus asteroids and mines. Each bullet stops at
    // whichever target its path reaches first this frame.
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
        const bullet = bullets[bi];

        const asteroidIndex = firstTargetHit(bullet, asteroids);
        const asteroidT = bulletHit.t;

        const mineIndex = firstTargetHit(bullet, mines);
        const mineT = bulletHit.t;

        if (asteroidIndex === -1 && mineIndex === -1) {
            continue;
        }

        const hitsMine =
            mineIndex !== -1 &&
            (asteroidIndex === -1 || mineT < asteroidT);

        const t = hitsMine ? mineT : asteroidT;

        // Where along its path the bullet made contact.
        const startX = bullet.prevX ?? bullet.position.x;
        const startZ = bullet.prevZ ?? bullet.position.z;

        const impact = new THREE.Vector3(
            startX + (bullet.position.x - startX) * t,
            bullet.position.y,
            startZ + (bullet.position.z - startZ) * t
        );

        removeBullet(bi);

        if (hitsMine) {
            destroyMine(mineIndex);
            continue;
        }

        const asteroid = asteroids[asteroidIndex];

        asteroid.hp--;
        createExplosion(impact, 0.25, 3);

        if (asteroid.hp <= 0) {
            destroyAsteroid(asteroidIndex);
        } else {
            // Flash the damaged rock, and keep its hit radius in
            // step with the shrunken model.
            asteroid.mesh.scale.multiplyScalar(0.96);
            asteroid.radius *= 0.96;
        }
    }

    // Asteroids hitting the player.
    for (let i = asteroids.length - 1; i >= 0; i--) {
        const asteroid = asteroids[i];
    
        if (!circlesOverlap(
            player.position,
            asteroid.position,
            player.radius,
            asteroid.radius
        )) {
            continue;
        }
    
        // The active warp field protects the ship.
        if (warp.active) {
            const push = asteroid.position.clone().sub(
                player.position
            );
    
            push.y = 0;
    
            if (push.lengthSq() > 0.001) {
                push.normalize();
    
                // Force the asteroid away from the ship.
                asteroid.velocity.addScaledVector(push, 8);
    
                // Nudge it outside the immediate collision area.
                asteroid.position.addScaledVector(push, 0.35);
            }
    
            // Do not damage the player.
            continue;
        }
    
        damagePlayer();
    
        // Preserve the original collision response.
        const push = asteroid.position.clone().sub(
            player.position
        );
    
        push.y = 0;
    
        if (push.lengthSq() > 0.001) {
            push.normalize();
            asteroid.velocity.addScaledVector(push, 4);
        }
    }

    // Mines hitting the player.
    for (let i = mines.length - 1; i >= 0; i--) {
        const mine = mines[i];
    
        if (!circlesOverlap(
            player.position,
            mine.position,
            player.radius,
            mine.radius
        )) {
            continue;
        }
    
        if (warp.active) {
            // The warp field absorbs the mine impact.
            createExplosion(mine.position, 1.1, 15);

            // Remove the mine without damaging the ship.
            discardMesh(mine.mesh);
            mines.splice(i, 1);
    
            continue;
        }
    
        // Normal damage when the warp field is inactive.
        destroyMine(i);
        damagePlayer();
    }

    // Pickups collected by the player.
    for (let i = pickups.length - 1; i >= 0; i--) {
        const pickup = pickups[i];

        if (circlesOverlap(
            player.position,
            pickup.position,
            player.radius,
            pickup.radius
        )) {
            addScore(500);

            // A crystal repairs one hull point, up to three.
            state.lives = Math.min(3, state.lives + 1);
            updateHUD();

            $("message").textContent = "ENERGY CRYSTAL ACQUIRED";

            createExplosion(pickup.position, 0.7, 10);

            scene.remove(pickup.mesh);
            scene.remove(pickup.glow);
            pickups.splice(i, 1);
        }
    }
}

// ------------------------------------------------------------
// GAME FLOW
// ------------------------------------------------------------

function clearArrayObjects(array, fields) {
    for (const item of array) {
        for (const field of fields) {
            // discardMesh frees only materials the mesh owns; shared
            // GLB and effect geometry is left alone.
            discardMesh(item[field]);
        }
    }

    array.length = 0;
}

function clearGameObjects() {
    // Explosion flashes each own a cloned material.
    for (const effect of explosions) {
        effect.mesh.material.dispose();
    }

    clearArrayObjects(bullets, ["mesh", "glow"]);
    clearArrayObjects(asteroids, ["mesh"]);
    clearArrayObjects(mines, ["mesh"]);
    clearArrayObjects(pickups, ["mesh", "glow"]);
    clearArrayObjects(particles, ["mesh"]);
    clearArrayObjects(explosions, ["mesh"]);
}

function resetGame() {
    clearGameObjects();

    // Lock the laser and rockets again and clear their effects.
    resetWeapons();

    // Clear any rogue asteroid and its trail, and restart the wait
    // for the next one.
    resetRogue();

    // Clear any lingering retro thruster puffs.
    clearRetroPuffs();

    // Reset input state.
    firing = false;
    pointerSteering = false;
    pointerDown = false;
    pointerDragged = false;

    for (const key of Object.keys(keys)) {
        keys[key] = false;
    }

    steeringMode = "mouse";

    // Cancel a pending automatic restart.
    if (state.restartTimer !== null) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    // Reset score and player state.
    state.score = 0;
    state.lives = 3;
    state.sector = 1;
    state.elapsed = 0;

    // A fresh match clock.
    state.matchTime = 0;
    updateMatchClockHUD(true);

    // Reset warp power-up state.
    warp.active = false;
    warp.remaining = 0;
    warp.elapsed = 0;
    warp.nextMilestone = WARP_SCORE_INTERVAL;

    if (warp.group) {
        warp.group.visible = false;
        warp.group.scale.setScalar(1);
    }

    const warpStatus = $("warp-status");

    if (warpStatus) {
        warpStatus.style.display = "none";
    }

    // ------------------------------------------------------------
    // RESET BLACK HOLE EVENT
    // ------------------------------------------------------------
    
    blackHole.active = false;
    blackHole.triggered = false;
    blackHole.elapsed = 0;
    blackHole.consumedCount = 0;
    blackHole.asteroidSpawnTimer = 0;

    // It moves to wherever the player is when it opens; reset it.
    BLACK_HOLE_POSITION.set(0, 0.35, 0);

    // Cancel a VICTORY banner still waiting to appear.
    if (blackHole.victoryTimer !== null) {
        clearTimeout(blackHole.victoryTimer);
        blackHole.victoryTimer = null;
    }

    // Tidal streams, sparks and flares.
    clearBlackHoleFx();

    if (blackHole.lens) {
        blackHole.lens.visible = false;
    }

    if (blackHole.group) {
        blackHole.group.visible = false;

        blackHole.group.position.copy(
            BLACK_HOLE_POSITION
        );

        blackHole.streaksBack.rotation.y = 0;
        blackHole.streaksFront.rotation.y = 0;
    }


    state.spawnTimer = 0.8;
    state.mineTimer = 8;
    state.pickupTimer = 10;
    state.fireCooldown = 0;
    state.damageCooldown = 0;
    state.screenShake = 0;

    player.position.set(0, 0, 0);
    player.aim.set(0, 0, -1);
    player.velocity.set(0, 0, 0);

    // Jump the camera straight back to the ship.
    updateCameraRig(0, true);

    createPlayer();

    updateHUD();

    $("message").textContent = "SECTOR 01: ENGAGE";
}

function startGame() {
    if (state.loading) return;

    resetGame();

    state.running = true;
    state.gameOver = false;

    $("start-screen").classList.add("hidden");
    $("game-over").classList.add("hidden");

    // Pressing Enter during the 5-second victory banner used to start
    // a new game underneath a banner that never went away.
    const victoryBanner = $("victory-banner");

    if (victoryBanner) {
        victoryBanner.style.display = "none";
    }
}

function endGame() {
    state.running = false;
    state.gameOver = true;

    saveHighScore();

    $("final-score").textContent =
        String(state.score).padStart(6, "0");

    $("game-over").classList.remove("hidden");

    // Nothing schedules an automatic restart, so the old
    // "RESTARTING IN 5 SECONDS" text was misleading.
    $("message").textContent = "SIGNAL LOST";

    // Cancel any previously scheduled restart.
    if (state.restartTimer !== null) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }
}

$("start-button").addEventListener("click", startGame);
$("restart-button").addEventListener("click", startGame);

// ------------------------------------------------------------
// GAME UPDATE
// ------------------------------------------------------------

function updateGame(dt) {
    if (!state.running) return;

    state.elapsed += dt;
    state.fireCooldown = Math.max(0, state.fireCooldown - dt);
    state.damageCooldown = Math.max(0, state.damageCooldown - dt);

    // --------------------------------------------------------
    // BLACK HOLE EVENT
    // --------------------------------------------------------
    
    if (blackHole.active) {
        // Update the ship's engine effects. The black hole steers
        // the ship now, so the retro thrusters fade out.
        updateAfterburners(dt);
        setRetroThrustersActive(false);
        updateRetroThrusters(dt);
    
        // The black hole update handles ship movement,
        // spaghettification, asteroid spawning, and gravity.
        updateBlackHole(dt);

        // Keep existing explosions animating instead of freezing
        // in place for the whole event.
        updateEffects(dt);

        // Weapons stand down: remove beams and rockets, and let
        // any smoke already in the air dissipate.
        clearActiveWeapons();
        updateSmoke(dt);

        // No rogue asteroids during the black hole; any vapor
        // trail already in the arena fades out.
        clearRogueAsteroid();
        updateVaporTrails(dt);

        // Skip normal movement, spawning, and collisions.
        return;
    }

    // --------------------------------------------------------
    // MATCH CLOCK: still alive when it runs out = victory.
    // --------------------------------------------------------

    state.matchTime += dt;

    if (
        state.matchTime >= MATCH_SECONDS &&
        !blackHole.triggered
    ) {
        state.matchTime = MATCH_SECONDS;
        updateMatchClockHUD(true);
        activateBlackHole();
        return;
    }

    updateMatchClockHUD();

    updatePlayer(dt);
    updateAfterburners(dt);
    updateRetroThrusters(dt);
    updateWarp(dt);
    updateBullets(dt);
    updateAsteroids(dt);
    updateMines(dt);
    updatePickups(dt);
    updateEffects(dt);
    updateWeapons(dt);
    updateRogue(dt);
    updateVaporTrails(dt);

    // Gradually increase difficulty.
    const newSector = 1 + Math.floor(state.elapsed / 35);

    if (newSector !== state.sector) {
        state.sector = newSector;
        $("message").textContent = `SECTOR ${String(state.sector).padStart(2, "0")}`;
        updateHUD();
    }

    state.spawnTimer -= dt;

    const spawnInterval = Math.max(
        0.45,
        1.7 - state.sector * 0.09
    );

    if (state.spawnTimer <= 0 && asteroids.length < 24) {
        spawnAsteroid();
        state.spawnTimer = spawnInterval * randomRange(0.7, 1.3);
    }

    state.mineTimer -= dt;

    if (state.mineTimer <= 0 && mines.length < 4) {
        spawnMine();
        state.mineTimer = randomRange(8, 13);
    }

    // Occasional bonus crystals.
    state.pickupTimer -= dt;

    if (state.pickupTimer <= 0 && pickups.length < 2) {
        // Crystals don't move, so place them where they can be seen.
        const position = onscreenEdgePosition();
        createPickup(position);
        state.pickupTimer = randomRange(12, 20);
    }

    resolveCollisions();

    if (state.screenShake > 0) {
        state.screenShake = Math.max(0, state.screenShake - dt);
    }

    // Change the status text after a short warning.
    if (
        $("message").textContent === "WARNING: HULL DAMAGED" &&
        state.damageCooldown <= 0
    ) {
        $("message").textContent = `SECTOR ${String(state.sector).padStart(2, "0")}: ENGAGE`;
    }
}

// ------------------------------------------------------------
// RESIZE AND RENDER
// ------------------------------------------------------------

function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    const aspect = width / height;
    const viewHeight = 32;
    const viewWidth = viewHeight * aspect;

    camera.left = -viewWidth / 2;
    camera.right = viewWidth / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;

    camera.updateProjectionMatrix();

    // Set the pixel ratio first; setPixelRatio() itself resizes the
    // canvas, so the old order resized it twice.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);

    // Update the background for the new screen dimensions.
    updateBackgroundOrientation();
    updateParallax();
}

window.addEventListener("resize", resize);
resize();

function render() {
    const dt = Math.min(clock.getDelta(), 0.04);

    // Subtle starfield movement (only when the starfield is shown).
    if (stars.parent) {
        stars.rotation.y += dt * 0.0015;
    }

    updateGame(dt);

    // The black hole keeps animating after the ship is swallowed.
    updateBlackHoleAftermath(dt);

    // Follow the ship (only while playing, so the view holds still
    // behind the game-over and victory screens).
    if (state.running) {
        updateCameraRig(dt);
    }

    // The camera stays top-down, following the ship, and can shake
    // slightly on damage.
    let shakeX = 0;
    let shakeZ = 0;

    if (state.screenShake > 0) {
        const amount = state.screenShake * 0.12;

        shakeX = (Math.random() - 0.5) * amount;
        shakeZ = (Math.random() - 0.5) * amount;
    }

    camera.position.x = cameraRig.x + shakeX;
    camera.position.z = cameraRig.z + shakeZ;

    updateParallax();
    updateDust();

    // Re-aim at the point now under the cursor, ready for the next
    // frame's steering.
    refreshAim();

    renderer.render(scene, camera);
    requestAnimationFrame(render);
}

// ------------------------------------------------------------
// STARTUP
// ------------------------------------------------------------

async function boot() {
    $("message").textContent = "LOADING BLENDER ASSETS...";

    try {
        await loadAssets();

        state.loading = false;

        updateHUD();
        // startGame() below calls resetGame(), which creates the
        // player, so creating it here as well was wasted work.
        createWarpBubble();
        createBlackHole();

        $("message").textContent = "READY FOR LAUNCH";

        console.info(`ASTEROID DEFENSE ready (build ${GAME_BUILD}).`);
        startGame();
    } catch (error) {
        console.error(error);

        $("message").textContent = "ASSET LOAD ERROR";

        const errorMessage = document.createElement("div");

        errorMessage.style.cssText = `
            position:fixed;
            z-index:20;
            left:50%;
            top:50%;
            transform:translate(-50%,-50%);
            max-width:90vw;
            padding:24px;
            background:#180c24;
            border:2px solid #ff3f9f;
            color:white;
            font:12px monospace;
            line-height:2;
            overflow-wrap:anywhere;
        `;

        errorMessage.textContent =
            `Could not load the Blender models. Check that the assets folder contains all ${Object.keys(assetFiles).length} GLB files and that the game is being served over HTTP. (${error.message})`;

        document.body.appendChild(errorMessage);
    }
}

boot();
render();
