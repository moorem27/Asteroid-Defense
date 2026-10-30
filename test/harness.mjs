// A small in-memory stand-in for the parts of the Cloudflare Workers
// runtime the server uses: Durable Object namespaces and stubs (fetch
// and RPC), storage and alarms, WebSocketPair, the WebSocket
// Hibernation API (acceptWebSocket / getWebSockets / attachments),
// and Response status 101. It also provides a fake browser WebSocket
// that connects to the Worker, so public/multiplayer.js can be tested
// against src/index.js end to end in Node.
//
// It is not workerd: final checks should still be done with
// `npx wrangler dev` and two browser tabs (see SETUP.md).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------
// Response that allows status 101 and carries a webSocket.
// ------------------------------------------------------------

const NativeResponse = globalThis.Response;

export class WorkerResponse {
    constructor(body = null, init = {}) {
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket ?? null;
        this.body = body;
        this.headers = new Headers(init.headers ?? {});
    }

    static json(data, init = {}) {
        return new WorkerResponse(JSON.stringify(data), {
            ...init,
            headers: { "content-type": "application/json" }
        });
    }

    get ok() {
        return this.status >= 200 && this.status < 300;
    }

    async text() {
        return this.body == null ? "" : String(this.body);
    }

    async json() {
        return JSON.parse(await this.text());
    }

    clone() {
        return new WorkerResponse(this.body, { status: this.status, headers: this.headers });
    }
}

// ------------------------------------------------------------
// WebSocketPair
// ------------------------------------------------------------

// A number, or a function returning one per message (for jitter).
let deliveryDelayMs = 0;

function nextDelay() {
    return typeof deliveryDelayMs === "function" ? deliveryDelayMs() : deliveryDelayMs;
}

export function setNetworkDelay(ms) {
    deliveryDelayMs = ms;
}

class PairEnd {
    constructor() {
        this.readyState = 1;
        this.peer = null;
        this.attachment = null;
        this.onDeliver = null;
        this.onRemoteClose = null;
        this.sent = 0;
    }

    send(data) {
        if (this.readyState !== 1) throw new Error("WebSocket is closed");
        this.sent++;

        const peer = this.peer;
        const payload = String(data);

        // Like TCP: delays vary, but messages never overtake each other.
        const at = Math.max(Date.now() + nextDelay(), this.lastDeliverAt ?? 0);
        this.lastDeliverAt = at;

        setTimeout(() => {
            if (peer.readyState === 1 || peer.readyState === 2) {
                peer.onDeliver?.(payload);
            }
        }, Math.max(0, at - Date.now()));
    }

    close(code = 1000, reason = "") {
        if (this.readyState >= 2) return;

        this.readyState = 3;
        const peer = this.peer;

        setTimeout(() => {
            if (peer.readyState < 2) {
                peer.readyState = 3;
                peer.onRemoteClose?.(code, reason);
            }
        }, nextDelay());
    }

    serializeAttachment(value) {
        this.attachment = structuredClone(value);
    }

    deserializeAttachment() {
        return this.attachment === null ? null : structuredClone(this.attachment);
    }
}

export class WebSocketPair {
    constructor() {
        const a = new PairEnd();
        const b = new PairEnd();
        a.peer = b;
        b.peer = a;
        this[0] = a;
        this[1] = b;
    }
}

// ------------------------------------------------------------
// Durable Objects
// ------------------------------------------------------------

export class DurableObject {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
}

class Storage {
    constructor(owner) {
        this.owner = owner;
        this.data = new Map();
        this.alarmAt = null;
        this.alarmTimer = null;
        this.writes = 0;
    }

    async get(key) {
        return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
    }

    async put(key, value) {
        this.writes++;
        this.data.set(key, structuredClone(value));
    }

    async getAlarm() {
        return this.alarmAt;
    }

    async setAlarm(time) {
        this.alarmAt = time;
        clearTimeout(this.alarmTimer);

        // Tests trigger alarms by hand, rather than waiting 30 s.
    }

    async deleteAlarm() {
        this.alarmAt = null;
    }
}

class State {
    constructor(owner) {
        this.owner = owner;
        this.storage = new Storage(owner);
        this.sockets = [];
        this.ready = Promise.resolve();
    }

    blockConcurrencyWhile(fn) {
        this.ready = Promise.resolve().then(fn);
        return this.ready;
    }

    acceptWebSocket(ws) {
        this.sockets.push(ws);

        ws.onDeliver = (message) => {
            this.owner.instance.webSocketMessage(ws, message);
        };

        ws.onRemoteClose = (code, reason) => {
            this.forget(ws);
            this.owner.instance.webSocketClose(ws, code, reason, true);
        };

        // When the object itself closes the socket, it stops being
        // listed too.
        const close = ws.close.bind(ws);

        ws.close = (code, reason) => {
            close(code, reason);
            this.forget(ws);
        };
    }

    forget(ws) {
        const i = this.sockets.indexOf(ws);
        if (i >= 0) this.sockets.splice(i, 1);
    }

    getWebSockets() {
        return [...this.sockets];
    }
}

class Namespace {
    constructor(cls, envRef, label) {
        this.cls = cls;
        this.envRef = envRef;
        this.label = label;
        this.objects = new Map();
    }

    idFromName(name) {
        return { name: String(name) };
    }

    entry(id) {
        let entry = this.objects.get(id.name);

        if (!entry) {
            entry = { name: id.name };
            entry.state = new State(entry);
            entry.instance = new this.cls(entry.state, this.envRef.env);
            this.objects.set(id.name, entry);
        }

        return entry;
    }

    get(id) {
        const entry = this.entry(id);

        return new Proxy({}, {
            get: (_, prop) => {
                if (prop === "then") return undefined;

                return async (...args) => {
                    await entry.state.ready;

                    if (prop === "fetch") {
                        return entry.instance.fetch(args[0]);
                    }

                    // RPC: arguments and results are copied, as they
                    // would be across the network.
                    const result = await entry.instance[prop](
                        ...structuredClone(args)
                    );

                    return result === undefined ? undefined : structuredClone(result);
                };
            }
        });
    }

    // Simulate Cloudflare restarting an object (in-memory state lost,
    // storage and accepted sockets kept, as with hibernation).
    restart(name) {
        const entry = this.objects.get(name);
        if (!entry) return;

        entry.instance = new this.cls(entry.state, this.envRef.env);
    }
}

// ------------------------------------------------------------
// Load the Worker with the stand-in runtime.
// ------------------------------------------------------------

export async function loadWorker(env = {}) {
    globalThis.WebSocketPair = WebSocketPair;
    globalThis.Response = WorkerResponse;

    const source = await readFile(path.join(here, "../src/index.js"), "utf8");

    const harnessUrl = pathToFileURL(path.join(here, "harness.mjs")).href;

    const patched = source.replace(
        'import { DurableObject } from "cloudflare:workers";',
        `import { DurableObject } from ${JSON.stringify(harnessUrl)};`
    );

    if (patched === source) {
        throw new Error("Could not patch the cloudflare:workers import.");
    }

    const filterUrl = pathToFileURL(path.join(here, "../public/name-filter.js")).href;
    const ufoUrl = pathToFileURL(path.join(here, "../public/ufo.js")).href;
    const ranksUrl = pathToFileURL(path.join(here, "../public/ranks.js")).href;
    const withFilter = patched
        .replace('"../public/name-filter.js"', JSON.stringify(filterUrl))
        .replace('"../public/ufo.js"', JSON.stringify(ufoUrl))
        .replace('"../public/ranks.js"', JSON.stringify(ranksUrl));

    const outDir = path.join(here, ".build");
    await mkdir(outDir, { recursive: true });

    const outFile = path.join(outDir, `worker-${Date.now()}-${Math.random()}.mjs`);
    await writeFile(outFile, withFilter);

    const mod = await import(pathToFileURL(outFile).href);

    const envRef = { env: null };

    const fullEnv = {
        ...env,
        MATCHMAKER: new Namespace(mod.Matchmaker, envRef, "Matchmaker"),
        LOBBY: new Namespace(mod.Lobby, envRef, "Lobby")
    };

    envRef.env = fullEnv;

    const server = {
        mod,
        env: fullEnv,

        // Test switches.
        down: false,
        hang: false,

        async fetch(url, headers = {}) {
            const request = new Request(url, { headers });
            return mod.default.fetch(request, fullEnv);
        },

        lobbies() {
            return [...fullEnv.LOBBY.objects.values()].map((e) => ({
                name: e.name,
                sockets: e.state.sockets.length,
                instance: e.instance,
                state: e.state
            }));
        },

        async matchmakerStats() {
            const stub = fullEnv.MATCHMAKER.get(fullEnv.MATCHMAKER.idFromName("global"));
            return stub.stats();
        }
    };

    return server;
}

// ------------------------------------------------------------
// A browser-like WebSocket that connects to the harness Worker.
// ------------------------------------------------------------

export function makeBrowserWebSocket(server) {
    return class FakeBrowserWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.bufferedAmount = 0;
            this.onopen = null;
            this.onmessage = null;
            this.onclose = null;
            this.onerror = null;
            this.end = null;

            setTimeout(() => this.connect(), 0);
        }

        async connect() {
            if (server.hang) return; // never answers

            if (server.down) {
                this.fail();
                return;
            }

            const httpUrl = this.url.replace(/^ws/, "http");

            let response;

            try {
                response = await server.fetch(httpUrl, { Upgrade: "websocket" });
            } catch {
                this.fail();
                return;
            }

            if (this.readyState === 3) {
                // Closed by the client while connecting.
                response.webSocket?.close(1000, "client gone");
                return;
            }

            if (response.status !== 101 || !response.webSocket) {
                this.fail(response.status);
                return;
            }

            const end = response.webSocket;
            this.end = end;

            end.onDeliver = (data) => {
                this.onmessage?.({ data });
            };

            end.onRemoteClose = (code, reason) => {
                this.readyState = 3;
                this.onclose?.({ code, reason });
            };

            this.readyState = 1;
            this.onopen?.({});
        }

        fail(status) {
            this.httpStatus = status;
            this.readyState = 3;
            this.onerror?.({});
            this.onclose?.({ code: 1006 });
        }

        send(data) {
            if (this.readyState !== 1) throw new Error("not open");
            this.end.send(data);
        }

        close() {
            if (this.readyState === 3) return;

            const wasOpen = this.readyState === 1;
            this.readyState = 3;

            if (wasOpen && this.end) {
                this.end.close(1000, "client closed");
            }

            setTimeout(() => this.onclose?.({ code: 1000 }), 0);
        }
    };
}

// ------------------------------------------------------------
// The handful of Three.js pieces multiplayer.js uses.
// ------------------------------------------------------------

class Vec3 {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { this.x = this.y = this.z = s; return this; }
}

class Object3D {
    constructor() {
        this.position = new Vec3();
        this.rotation = new Vec3();
        this.scale = new Vec3().setScalar(1);
        this.children = [];
        this.visible = true;
        this.parent = null;
    }
    add(...objects) {
        for (const o of objects) { o.parent = this; this.children.push(o); }
        return this;
    }
    remove(o) {
        const i = this.children.indexOf(o);
        if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
        return this;
    }
}

class FakeColor {
    constructor(v) { this.value = v; }
    set(v) { this.value = v; return this; }
}

class Material {
    constructor(opts = {}) { Object.assign(this, opts); this.color = new FakeColor(opts.color); this.disposed = false; }
    dispose() { this.disposed = true; }
}

class Geometry {
    rotateX() { return this; }
    dispose() {}
}

export const FakeTHREE = {
    Group: class extends Object3D {},
    Mesh: class extends Object3D {
        constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
    },
    Sprite: class extends Object3D {
        constructor(material) { super(); this.material = material; }
    },
    Color: FakeColor,
    MeshBasicMaterial: Material,
    SpriteMaterial: Material,
    CanvasTexture: class { dispose() {} },
    RingGeometry: Geometry,
    SphereGeometry: Geometry,
    AdditiveBlending: 2,
    DoubleSide: 2,
    SRGBColorSpace: "srgb"
};

export function makeScene() {
    return new Object3D();
}

export function makeShip() {
    return new FakeTHREE.Group();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check, timeoutMs = 3000, label = "condition") {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (await check()) return;
        await sleep(10);
    }

    throw new Error(`Timed out waiting for ${label}`);
}
