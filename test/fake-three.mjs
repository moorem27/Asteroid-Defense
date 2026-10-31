// A small stand-in for the parts of Three.js that game.js and
// multiplayer.js use, so the real game code can run in Node for tests.
// Transforms ignore rotation (enough for top-down hit-test checks).

export const SRGBColorSpace = "srgb";
export const UVMapping = 300;
export const ClampToEdgeWrapping = 1001;
export const RepeatWrapping = 1000;
export const ACESFilmicToneMapping = 4;
export const AdditiveBlending = 2;
export const DoubleSide = 2;

export class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y) { this.x = x; this.y = y; return this; }
}

export class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { this.x = this.y = this.z = s; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiply(v) { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    clampLength(min, max) {
        const l = this.length();
        if (l > max) this.multiplyScalar(max / l);
        else if (l < min && l > 0) this.multiplyScalar(min / l);
        return this;
    }
}

class Euler {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; return this; }
    clone() { return new Euler().copy(this); }
}

export class Color {
    constructor(v) { this.value = v; this.r = 1; this.g = 1; this.b = 1; }
    set(v) { this.value = v; return this; }
    setHSL() { return this; }
}

export class Object3D {
    constructor() {
        this.position = new Vector3();
        this.rotation = new Euler();
        this.scale = new Vector3(1, 1, 1);
        this.up = new Vector3(0, 1, 0);
        this.children = [];
        this.parent = null;
        this.visible = true;
        this.userData = {};
        this.name = "";
        this.renderOrder = 0;
        this.frustumCulled = true;
    }

    add(...objects) {
        for (const o of objects) {
            if (o.parent) o.parent.remove(o);
            o.parent = this;
            this.children.push(o);
        }
        return this;
    }

    remove(o) {
        const i = this.children.indexOf(o);
        if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
        return this;
    }

    traverse(fn) {
        fn(this);
        for (const c of [...this.children]) c.traverse(fn);
    }

    getObjectByName(name) {
        if (this.name === name) return this;

        for (const c of this.children) {
            const found = c.getObjectByName(name);
            if (found) return found;
        }

        return undefined;
    }

    clone(recursive = true) {
        const copy = this.cloneSelf();
        copy.position.copy(this.position);
        copy.rotation.copy(this.rotation);
        copy.scale.copy(this.scale);
        copy.visible = this.visible;
        copy.name = this.name;
        copy.userData = { ...this.userData };

        if (recursive) {
            for (const c of this.children) copy.add(c.clone(true));
        }

        return copy;
    }

    cloneSelf() { return new this.constructor(); }

    updateMatrixWorld() {}
    lookAt() {}

    // World transform without rotation: scale and translation.
    worldTransform() {
        let s = { x: 1, y: 1, z: 1 };
        let t = { x: 0, y: 0, z: 0 };
        const chain = [];

        for (let o = this; o; o = o.parent) chain.unshift(o);

        for (const o of chain) {
            t = { x: t.x + s.x * o.position.x, y: t.y + s.y * o.position.y, z: t.z + s.z * o.position.z };
            s = { x: s.x * o.scale.x, y: s.y * o.scale.y, z: s.z * o.scale.z };
        }

        return { s, t };
    }
}

export class Scene extends Object3D {}
export class Group extends Object3D {}

export class Mesh extends Object3D {
    constructor(geometry = null, material = null) {
        super();
        this.isMesh = true;
        this.geometry = geometry;
        this.material = material;
    }
    cloneSelf() { return new Mesh(this.geometry, this.material); }
}

export class Points extends Mesh {}
export class Line extends Mesh {}
export class Sprite extends Mesh {
    constructor(material) { super(null, material); this.isMesh = false; }
}

export class Light extends Object3D {
    constructor(color, intensity = 1) { super(); this.intensity = intensity; }
}
export class HemisphereLight extends Light {}
export class AmbientLight extends Light {}
export class DirectionalLight extends Light {}
export class PointLight extends Light {}

class Material {
    constructor(opts = {}) {
        this.opacity = 1;
        this.transparent = false;
        this.depthWrite = true;
        Object.assign(this, opts);
        this.color = new Color(opts.color);
        this.userData = {};
        this.disposed = false;
    }
    clone() {
        const c = new this.constructor({});
        Object.assign(c, this);
        c.color = new Color(this.color?.value);
        c.userData = { ...this.userData };
        return c;
    }
    dispose() { this.disposed = true; }
}

export class MeshBasicMaterial extends Material {}
export class MeshStandardMaterial extends Material {}
export class PointsMaterial extends Material {}
export class LineBasicMaterial extends Material {}
export class SpriteMaterial extends Material {}
export class ShaderMaterial extends Material {}

class Geometry {
    constructor() { this.attributes = {}; this.box = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }; }
    rotateX() { return this; }
    setAttribute(name, attr) { this.attributes[name] = attr; return this; }
    setFromPoints() { return this; }
    setIndex(index) { this.index = index; return this; }
    dispose() {}
}

export class BufferGeometry extends Geometry {}
export class PlaneGeometry extends Geometry {}
export class SphereGeometry extends Geometry {}
export class RingGeometry extends Geometry {}
export class TetrahedronGeometry extends Geometry {}

export class BufferAttribute {
    constructor(array, size) { this.array = array; this.itemSize = size; this.needsUpdate = false; }
}

export class Texture {
    constructor() {
        this.image = { width: 1024, height: 1024 };
        this.repeat = new Vector2(1, 1);
        this.offset = new Vector2(0, 0);
        this.isTexture = true;
    }
    dispose() {}
}

export class CanvasTexture extends Texture {}

export class TextureLoader {
    // Files listed in globalThis.__missingTextures fail to load.
    load(url, onLoad, onProgress, onError) {
        // (Tests can list what was loaded in globalThis.__textureLoads.)
        globalThis.__textureLoads?.push(String(url));

        const missing = (globalThis.__missingTextures ?? []).some((f) => String(url).endsWith(f));

        setTimeout(() => (missing ? onError?.(new Error("404")) : onLoad?.(new Texture())), 0);
        return new Texture();
    }
}

export class FogExp2 {
    constructor(color, density) { this.color = color; this.density = density; }
}

export class OrthographicCamera extends Object3D {
    constructor(left, right, top, bottom) {
        super();
        Object.assign(this, { left, right, top, bottom });
    }
    updateProjectionMatrix() {}
}

export class Plane {
    constructor(normal = new Vector3(0, 1, 0), constant = 0) {
        this.normal = normal;
        this.constant = constant;
    }
}

// Top-down orthographic picking: screen up is world -Z.
export class Raycaster {
    constructor() {
        this.camera = null;
        this.ndc = new Vector2();
        this.ray = {
            intersectPlane: (plane, target) => {
                const c = this.camera;
                return target.set(
                    c.position.x + this.ndc.x * c.right,
                    0,
                    c.position.z - this.ndc.y * c.top
                );
            }
        };
    }
    setFromCamera(ndc, camera) {
        this.ndc.set(ndc.x, ndc.y);
        this.camera = camera;
    }
}

export class Box3 {
    constructor() {
        this.min = new Vector3(Infinity, Infinity, Infinity);
        this.max = new Vector3(-Infinity, -Infinity, -Infinity);
    }

    setFromObject(object) {
        this.min.set(Infinity, Infinity, Infinity);
        this.max.set(-Infinity, -Infinity, -Infinity);

        object.traverse((o) => {
            if (!o.isMesh || !o.geometry?.box) return;

            const { s, t } = o.worldTransform();
            const b = o.geometry.box;

            for (const i of [0, 1, 2]) {
                const axis = "xyz"[i];
                const a = t[axis] + s[axis] * b.min[i];
                const c = t[axis] + s[axis] * b.max[i];

                this.min[axis] = Math.min(this.min[axis], a, c);
                this.max[axis] = Math.max(this.max[axis], a, c);
            }
        });

        return this;
    }

    getSize(target) {
        return target.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z);
    }

    getCenter(target) {
        return target.set(
            (this.max.x + this.min.x) / 2,
            (this.max.y + this.min.y) / 2,
            (this.max.z + this.min.z) / 2
        );
    }
}

export class Clock {
    constructor() { this.last = performance.now(); }
    getDelta() {
        const now = performance.now();
        const dt = (now - this.last) / 1000;
        this.last = now;
        return dt;
    }
}

export class WebGLRenderer {
    constructor() {
        this.domElement = globalThis.document.createElement("canvas");
        this.capabilities = { getMaxAnisotropy: () => 8 };
        this.renders = 0;
    }
    setPixelRatio() {}
    setSize() {}
    render() { this.renders++; }
}

export const MathUtils = {
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    damp: (x, y, lambda, dt) => x + (y - x) * (1 - Math.exp(-lambda * dt)),
    smoothstep: (x, min, max) => {
        if (x <= min) return 0;
        if (x >= max) return 1;
        const t = (x - min) / (max - min);
        return t * t * (3 - 2 * t);
    }
};
