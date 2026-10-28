// ============================================================
// ASTEROID DEFENSE: MULTIPLAYER CLIENT (protocol 2)
//
// Joins a lobby on the game's Cloudflare server. In a lobby the
// server owns the world (asteroids, mines, crystals, the rogue
// asteroid, every hit and every score); this module carries messages
// both ways and draws the other pilots, their shots and everyone's
// rockets. game.js handles the world itself through the handlers it
// passes in.
//
// Reliability rules:
//  - Nothing in here can stop the game. Every entry point catches its
//    own errors, and game.js loads this file with a dynamic import.
//  - If the server can't be reached, the HUD shows OFFLINE MODE and
//    the game plays the original solo game. It keeps retrying in the
//    background and joins a lobby as soon as one is available.
//  - After a dropped connection it rejoins the same lobby (and keeps
//    its score for the round) within about a second.
//  - Add ?offline to the URL to switch multiplayer off entirely.
// ============================================================

// Callsign rules (shared with the server).
import { checkName, nameProblem, randomCallsign } from "./name-filter.js";

// Must match PROTOCOL_VERSION in src/index.js.
const PROTOCOL_VERSION = 2;

const CONFIG = {
    // Seconds between ship updates while flying (the server needs
    // them for collisions), and while on a menu or game-over screen.
    sendInterval: 0.1,
    idleSendInterval: 1.0,

    joinTimeoutMs: 6000,
    keepaliveMs: 15000,

    // The server sends ten updates a second; this long with nothing
    // means the connection is dead.
    silenceTimeoutMs: 10000,

    retryAfterDropMs: 800,
    retryBaseMs: 4000,
    retryMaxMs: 60000,

    // Other ships are drawn this far in the past, so there are always
    // two updates to move smoothly between.
    renderDelayMs: 120,
    maxExtrapolateMs: 250,

    hideAfterMs: 3000,
    forgetAfterMs: 10000,

    shotSpeed: 31,
    shotLife: 1.15,
    maxRemoteShots: 300,

    rocketSmokeInterval: 0.035,

    maxBufferedBytes: 64 * 1024
};

const STATUS_IDLE = 0;
const STATUS_PLAYING = 1;
const STATUS_AWAY = 2;

const FLAG_VISIBLE = 1;
const FLAG_WARP = 2;
const FLAG_SHIELD = 4;

export class Multiplayer {
    /**
     * @param {object} options
     * @param {object} options.THREE
     * @param {object} options.scene
     * @param {Function} options.createShipModel   New ship model (may
     *        throw until models have loaded).
     * @param {Function} [options.createRocketModel] New rocket model.
     * @param {Function} [options.spawnSmoke]      (x, z, heading) smoke puff.
     * @param {number}  [options.shipScale]
     * @param {HTMLElement} [options.statusElement]
     * @param {HTMLElement} [options.leaderboardElement]
     * @param {object}  [options.handlers]  online(welcome), offline(),
     *        world(msg), events(list, now), you(msg), round(round, now),
     *        records(top), message(text), dialog(open)
     * @param {object}  [options.callsign]  The name button and box:
     *        { button, label, dialog, form, input, error, cancel }
     * @param {string}  [options.serverUrl]
     * @param {Function} [options.WebSocketImpl] For tests.
     */
    constructor(options) {
        this.THREE = options.THREE;
        this.scene = options.scene;
        this.createShipModel = options.createShipModel;
        this.createRocketModel = options.createRocketModel ?? null;
        this.spawnSmoke = options.spawnSmoke ?? null;
        this.shipScale = options.shipScale ?? 1;
        this.statusElement = options.statusElement ?? null;
        this.leaderboardElement = options.leaderboardElement ?? null;
        this.handlers = options.handlers ?? {};
        this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket ?? null;

        this.url = options.serverUrl ?? defaultServerUrl();
        this.enabled = Boolean(this.url && this.WebSocketImpl) && !offlineRequested();

        this.name = loadPilotName();
        this.token = loadPilotToken();

        this.status = "offline";
        this.socket = null;
        this.welcomed = false;
        this.selfId = null;
        this.selfName = null;
        this.selfColor = null;
        this.lobbyId = loadLobbyId();

        this.failures = 0;
        this.retryTimer = null;
        this.joinTimer = null;
        this.keepaliveTimer = null;
        this.lastReceived = 0;

        this.offsetSamples = [];
        this.clockOffset = null;

        this.sendClock = 0;
        this.lastLocal = null;

        // id -> { name, color }
        this.roster = new Map();

        // id -> remote ship
        this.remotes = new Map();

        // id -> rocket
        this.rockets = new Map();

        this.remoteShots = [];
        this.shotPool = [];

        this.standings = [];
        this.lastLeaderboardHtml = "";

        this.lastErrorLog = 0;
        this.shared = null;

        this.callsignUi = null;
        this.setupCallsign(options.callsign);

        this.setStatus(this.enabled ? "connecting" : "offline");
        this.renderLeaderboard();

        if (this.enabled && typeof window !== "undefined") {
            window.addEventListener("online", () => this.connectSoon(0));

            document.addEventListener("visibilitychange", () => {
                this.guard(() => this.sendState());
            });
        }
    }

    // ---------------------------------------------------------
    // PUBLIC API (all safe to call at any time)
    // ---------------------------------------------------------

    connect() {
        this.guard(() => this.openSocket());
    }

    /**
     * Once per frame.
     * @param {number} dt
     * @param {object} local { playing, x, z, r, vx, vz, thrust, life, weapon }
     */
    update(dt, local) {
        this.guard(() => {
            this.lastLocal = local;
            this.sendClock += dt;

            const interval = local?.playing
                ? CONFIG.sendInterval
                : CONFIG.idleSendInterval;

            if (this.sendClock >= interval) {
                this.sendClock = 0;
                this.sendState();
            }

            this.updateRemotes();
            this.updateRockets(dt);
            this.updateRemoteShots(dt);
        });
    }

    // Ask the server to fire. Returns true if the request was sent.
    fire(weapon, x, z, r) {
        let sent = false;

        this.guard(() => {
            sent = this.send({
                t: "f",
                w: weapon,
                x: round2(x),
                z: round2(z),
                r: round2(r)
            });
        });

        return sent;
    }

    isOnline() {
        return this.status === "online";
    }

    pilotCount() {
        return this.isOnline() ? this.roster.size + 1 : 1;
    }

    // Best estimate of the server's clock (ms).
    serverNow() {
        return this.clockOffset === null ? Date.now() : now() + this.clockOffset;
    }

    nameOf(id) {
        if (id === this.selfId) return this.selfName ?? "YOU";
        return this.roster.get(String(id))?.name ?? "A PILOT";
    }

    colorOf(id) {
        if (id === this.selfId) return this.selfColor ?? "#ffffff";
        return this.roster.get(String(id))?.color ?? "#ffffff";
    }

    // Where the other pilots' ships are drawn (for bullet sparks).
    remoteShipPositions() {
        const list = [];

        for (const remote of this.remotes.values()) {
            const g = remote.visual?.group;
            if (g && g.visible) list.push({ x: g.position.x, z: g.position.z });
        }

        return list;
    }

    // ---------------------------------------------------------
    // CONNECTION
    // ---------------------------------------------------------

    openSocket() {
        if (!this.enabled || this.socket) return;

        clearTimeout(this.retryTimer);
        this.retryTimer = null;

        if (this.status !== "online") {
            this.setStatus(this.failures === 0 ? "connecting" : "offline");
        }

        const params = new URLSearchParams({
            v: String(PROTOCOL_VERSION),
            name: this.name
        });

        if (this.token) params.set("token", this.token);
        if (this.lobbyId) params.set("lobby", this.lobbyId);

        let ws;

        try {
            ws = new this.WebSocketImpl(`${this.url}?${params}`);
        } catch (error) {
            this.log("Could not open a connection:", error);
            this.scheduleRetry(false);
            return;
        }

        this.socket = ws;
        this.welcomed = false;

        ws.onmessage = (event) => this.guard(() => this.handleMessage(ws, event.data));
        ws.onclose = () => this.guard(() => this.handleClose(ws));
        ws.onerror = () => {};

        this.joinTimer = setTimeout(() => {
            this.guard(() => {
                if (this.socket === ws && !this.welcomed) {
                    this.log("Join timed out.");
                    this.abandon(ws);
                }
            });
        }, CONFIG.joinTimeoutMs);
    }

    abandon(ws) {
        try {
            ws.onmessage = null;
            ws.onclose = null;
            ws.close();
        } catch {
            // Ignore.
        }

        this.handleClose(ws);
    }

    handleClose(ws) {
        if (ws !== this.socket) return;

        const wasWelcomed = this.welcomed;

        this.socket = null;
        this.welcomed = false;
        this.selfId = null;

        clearTimeout(this.joinTimer);
        clearInterval(this.keepaliveTimer);
        this.joinTimer = null;
        this.keepaliveTimer = null;

        this.clearRemotes();
        this.roster.clear();
        this.standings = [];

        this.setStatus("offline");
        this.renderLeaderboard();

        if (wasWelcomed) {
            this.call("offline");
        }

        this.scheduleRetry(wasWelcomed);
    }

    scheduleRetry(afterDrop) {
        if (!this.enabled) return;

        let delay;

        if (afterDrop) {
            this.failures = 0;
            delay = CONFIG.retryAfterDropMs;
        } else {
            this.failures++;
            delay = Math.min(
                CONFIG.retryMaxMs,
                CONFIG.retryBaseMs * 2 ** Math.min(this.failures - 1, 6)
            );
        }

        delay *= 0.75 + Math.random() * 0.5;

        this.connectSoon(delay);
    }

    connectSoon(delay) {
        if (!this.enabled || this.socket) return;

        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), delay);
    }

    send(message) {
        const ws = this.socket;

        if (!ws || !this.welcomed || ws.readyState !== 1) return false;
        if (ws.bufferedAmount > CONFIG.maxBufferedBytes) return false;

        try {
            ws.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    sendState() {
        if (!this.isOnline()) return;

        const local = this.lastLocal;
        const hidden = typeof document !== "undefined" && document.hidden;

        let st = STATUS_IDLE;

        if (hidden) st = STATUS_AWAY;
        else if (local?.playing) st = STATUS_PLAYING;

        this.send({
            t: "s",
            l: local?.life ?? 0,
            x: round2(local?.x ?? 0),
            z: round2(local?.z ?? 0),
            r: round2(local?.r ?? 0),
            vx: round2(local?.vx ?? 0),
            vz: round2(local?.vz ?? 0),
            th: local?.thrust > 0 ? 1 : local?.thrust < 0 ? -1 : 0,
            st,
            w: local?.weapon ?? 0
        });
    }

    // ---------------------------------------------------------
    // INCOMING
    // ---------------------------------------------------------

    handleMessage(ws, raw) {
        if (ws !== this.socket || typeof raw !== "string") return;

        this.lastReceived = now();

        let data;

        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        if (!data || typeof data !== "object") return;

        if (Number.isFinite(data.now)) this.syncClock(data.now);

        if (data.t === "welcome") {
            this.onWelcome(data);
            return;
        }

        if (!this.welcomed) return;

        switch (data.t) {
            case "join":
                this.addRoster(data.p);
                break;

            case "leave":
                this.removeRoster(data.id);
                break;

            case "snap":
                this.onSnapshot(data);
                break;

            case "world":
                if (Array.isArray(data.lb)) {
                    this.standings = data.lb;
                    this.renderLeaderboard();
                }

                this.call("world", data);
                break;

            case "ev":
                if (Array.isArray(data.e)) this.onEvents(data.e, data.now);
                break;

            case "you":
                this.call("you", data);
                break;

            case "name":
                this.onName(data);
                break;

            case "records":
                // The all-time list, right after a round ends.
                if (Array.isArray(data.top)) this.call("records", data.top);
                break;

            case "round":
                if (data.round?.phase === "playing") {
                    this.standings = [];
                    this.renderLeaderboard();
                }

                this.call("round", data.round, data.now);
                break;

            default:
                break;
        }
    }

    // The smallest delay seen is the best estimate of the offset.
    syncClock(serverTime) {
        const sample = serverTime - now();

        this.offsetSamples.push(sample);
        if (this.offsetSamples.length > 40) this.offsetSamples.shift();

        this.clockOffset = Math.max(...this.offsetSamples);
    }

    onWelcome(data) {
        if (data.v !== PROTOCOL_VERSION) {
            this.log("Server protocol mismatch; playing offline.");
            this.enabled = false;
            this.abandon(this.socket);
            return;
        }

        clearTimeout(this.joinTimer);
        this.joinTimer = null;

        this.welcomed = true;
        this.failures = 0;
        this.selfId = String(data.id);
        this.selfName = String(data.name ?? this.name);

        // The server turned our saved callsign down (its rules can be
        // stricter than an older copy of this page's): use its choice.
        if (data.name && data.name !== this.name) {
            this.name = this.selfName;
            savePilotName(this.name);
            this.updateCallsignButton();

            this.call("message", `CALLSIGN NOT ALLOWED — FLYING AS ${this.name}`);
        }
        this.selfColor = data.color;

        if (typeof data.lobby === "string") {
            this.lobbyId = data.lobby;
            saveLobbyId(data.lobby);
        }

        this.clearRemotes();
        this.roster.clear();

        if (Array.isArray(data.players)) {
            for (const p of data.players) this.addRoster(p);
        }

        this.standings = Array.isArray(data.world?.lb) ? data.world.lb : [];

        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(() => {
            this.guard(() => {
                const ws = this.socket;
                if (!ws) return;

                if (now() - this.lastReceived > CONFIG.silenceTimeoutMs) {
                    this.log("Connection went silent; reconnecting.");
                    this.abandon(ws);
                    return;
                }

                this.send({ t: "p" });
            });
        }, CONFIG.keepaliveMs);

        this.setStatus("online");
        this.renderLeaderboard();

        console.info(
            `Multiplayer: joined lobby as ${this.selfName} ` +
            `(${this.pilotCount()}/${data.max} pilots).`
        );

        this.call("online", data);
    }

    onSnapshot(data) {
        const t = now();

        if (Array.isArray(data.p)) {
            for (const e of data.p) {
                if (!Array.isArray(e) || e.length < 9) continue;

                const id = String(e[0]);
                if (id === this.selfId) continue;

                const remote = this.ensureRemote(id);
                if (!remote) continue;

                const sample = {
                    t,
                    x: num(e[1]),
                    z: num(e[2]),
                    r: num(e[3]),
                    vx: num(e[4]),
                    vz: num(e[5]),
                    th: num(e[6]),
                    flags: num(e[7])
                };

                const last = remote.samples[remote.samples.length - 1];

                // Reappearing (respawned, back from a menu): jump
                // there instead of sliding across the map.
                if (
                    !last ||
                    !(last.flags & FLAG_VISIBLE) ||
                    Math.hypot(last.x - sample.x, last.z - sample.z) > 15
                ) {
                    remote.samples.length = 0;
                }

                remote.samples.push(sample);
                if (remote.samples.length > 10) remote.samples.shift();

                remote.lastListed = t;
            }

            for (const remote of [...this.remotes.values()]) {
                if (t - remote.lastListed > CONFIG.forgetAfterMs) {
                    this.disposeVisual(remote);
                    this.remotes.delete(remote.id);
                }
            }
        }

        if (Array.isArray(data.rk)) {
            const seen = new Set();

            for (const e of data.rk) {
                if (!Array.isArray(e) || e.length < 5) continue;

                const id = String(e[0]);
                seen.add(id);

                let rocket = this.rockets.get(id);

                if (!rocket) {
                    rocket = { id, owner: String(e[1]), samples: [], visual: null, smokeClock: 0 };
                    this.rockets.set(id, rocket);
                }

                rocket.samples.push({ t, x: num(e[2]), z: num(e[3]), h: num(e[4]) });
                if (rocket.samples.length > 8) rocket.samples.shift();
            }

            for (const rocket of [...this.rockets.values()]) {
                if (!seen.has(rocket.id)) this.removeRocket(rocket.id);
            }
        }
    }

    onEvents(list, eventTime) {
        const lag = Math.max(0, Math.min(0.5, (this.serverNow() - num(eventTime)) / 1000));

        for (const e of list) {
            if (!Array.isArray(e)) continue;

            const type = e[0];

            if (type === "b") {
                // Another pilot's shot (our own are already on screen).
                const owner = String(e[1]);

                if (owner !== this.selfId) {
                    this.spawnRemoteShot(owner, num(e[2]), num(e[3]), num(e[4]), lag);
                }
            } else if (type === "rx" || type === "rz") {
                this.removeRocket(String(e[1]));
            } else if (type === "sk") {
                // A ship was destroyed: hide it right away.
                const remote = this.remotes.get(String(e[1]));

                if (remote) {
                    remote.samples.length = 0;
                    if (remote.visual) remote.visual.group.visible = false;
                }
            }
        }

        this.call("events", list, num(eventTime));
    }

    // ---------------------------------------------------------
    // ROSTER AND OTHER SHIPS
    // ---------------------------------------------------------

    addRoster(p) {
        if (!p || p.id === undefined) return;

        const id = String(p.id);
        if (id === this.selfId) return;

        this.roster.set(id, {
            name: String(p.name ?? "PILOT").slice(0, 16),
            color: typeof p.color === "string" ? p.color : "#ffffff"
        });

        this.ensureRemote(id);
        this.updateStatusText();
        this.renderLeaderboard();
    }

    removeRoster(id) {
        id = String(id);

        this.roster.delete(id);

        const remote = this.remotes.get(id);

        if (remote) {
            this.disposeVisual(remote);
            this.remotes.delete(id);
        }

        this.standings = this.standings.filter((s) => String(s[0]) !== id);

        this.updateStatusText();
        this.renderLeaderboard();
    }

    ensureRemote(id) {
        let remote = this.remotes.get(id);
        if (remote) return remote;

        const info = this.roster.get(id);
        if (!info) return null;

        remote = {
            id,
            name: info.name,
            color: info.color,
            samples: [],
            visual: null,
            lastListed: now()
        };

        this.remotes.set(id, remote);

        return remote;
    }

    clearRemotes() {
        for (const remote of this.remotes.values()) this.disposeVisual(remote);
        this.remotes.clear();

        for (const id of [...this.rockets.keys()]) this.removeRocket(id);

        for (const shot of this.remoteShots) {
            shot.mesh.visible = false;
            this.shotPool.push(shot.mesh);
        }

        this.remoteShots.length = 0;
    }

    updateRemotes() {
        const t = now();
        const renderTime = t - CONFIG.renderDelayMs;

        for (const remote of this.remotes.values()) {
            const samples = remote.samples;
            const last = samples[samples.length - 1];

            const show =
                last &&
                (last.flags & FLAG_VISIBLE) &&
                t - last.t < CONFIG.hideAfterMs;

            if (!show) {
                if (remote.visual) remote.visual.group.visible = false;
                continue;
            }

            const visual = remote.visual ?? this.createVisual(remote);
            if (!visual) continue;

            const pose = samplePose(samples, renderTime);

            visual.group.position.set(pose.x, 0, pose.z);
            visual.ship.rotation.y = pose.r;

            // Just (re)spawned: blink.
            visual.group.visible = (last.flags & FLAG_SHIELD)
                ? Math.floor(t / 120) % 2 === 0
                : true;

            const thrusting = pose.th > 0;
            visual.engine.visible = thrusting;

            if (thrusting) {
                visual.engine.scale.set(1, 1, 0.85 + Math.random() * 0.3);
            }

            visual.bubble.visible = Boolean(last.flags & FLAG_WARP);

            if (visual.bubble.visible) {
                visual.bubble.scale.setScalar(1 + Math.sin(t / 160) * 0.05);
            }
        }
    }

    createVisual(remote) {
        const THREE = this.THREE;

        let ship;

        try {
            ship = this.createShipModel();
        } catch {
            return null;
        }

        if (!ship) return null;

        const shared = this.getSharedResources();
        const color = new THREE.Color(remote.color);

        const group = new THREE.Group();
        group.name = `RemotePilot_${remote.id}`;

        ship.scale.setScalar(this.shipScale);
        ship.position.y = 0.3;
        group.add(ship);

        const ringMaterial = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false
        });

        const ring = new THREE.Mesh(shared.ringGeometry, ringMaterial);
        ring.position.y = 0.05;
        group.add(ring);

        const engineMaterial = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            fog: false
        });

        const enginePivot = new THREE.Group();
        const engine = new THREE.Mesh(shared.engineGeometry, engineMaterial);
        engine.position.set(0, 0, -1.3);
        engine.visible = false;
        enginePivot.add(engine);
        enginePivot.scale.setScalar(1 / (this.shipScale || 1));
        ship.add?.(enginePivot);

        // A simple bubble while that pilot's warp field is up.
        const bubbleMaterial = new THREE.MeshBasicMaterial({
            color: 0x35dfff,
            transparent: true,
            opacity: 0.18,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            fog: false
        });

        const bubble = new THREE.Mesh(shared.bubbleGeometry, bubbleMaterial);
        bubble.position.y = 0.3;
        bubble.visible = false;
        group.add(bubble);

        const label = makeLabel(THREE, remote.name, remote.color);

        if (label) {
            label.position.set(0, 1, -2.1);
            group.add(label);
        }

        group.visible = false;
        this.scene.add(group);

        remote.visual = {
            group,
            ship,
            engine,
            bubble,
            label,
            materials: [ringMaterial, engineMaterial, bubbleMaterial]
        };

        return remote.visual;
    }

    disposeVisual(remote) {
        const visual = remote.visual;
        if (!visual) return;

        this.scene.remove(visual.group);

        for (const material of visual.materials) material.dispose?.();

        if (visual.label) {
            visual.label.material.map?.dispose?.();
            visual.label.material.dispose?.();
        }

        remote.visual = null;
    }

    // ---------------------------------------------------------
    // ROCKETS (everyone's, including our own, come from the server)
    // ---------------------------------------------------------

    updateRockets(dt) {
        const renderTime = now() - CONFIG.renderDelayMs;

        for (const rocket of this.rockets.values()) {
            if (rocket.samples.length === 0) continue;

            if (!rocket.visual) {
                if (!this.createRocketModel) continue;

                try {
                    rocket.visual = this.createRocketModel();
                } catch {
                    continue;
                }

                if (!rocket.visual) continue;

                this.scene.add(rocket.visual.mesh);
            }

            const pose = sampleRocket(rocket.samples, renderTime);
            const visual = rocket.visual;

            visual.mesh.position.set(pose.x, 0.45, pose.z);
            visual.mesh.rotation.y = pose.h;

            visual.flame?.scale.set(1, 1, 0.8 + Math.random() * 0.45);

            if (this.spawnSmoke) {
                rocket.smokeClock -= dt;

                while (rocket.smokeClock <= 0) {
                    rocket.smokeClock += CONFIG.rocketSmokeInterval;

                    this.spawnSmoke(
                        pose.x - Math.sin(pose.h) * 0.6,
                        pose.z - Math.cos(pose.h) * 0.6,
                        pose.h
                    );
                }
            }
        }
    }

    removeRocket(id) {
        const rocket = this.rockets.get(id);
        if (!rocket) return;

        if (rocket.visual) this.scene.remove(rocket.visual.mesh);

        this.rockets.delete(id);
    }

    // ---------------------------------------------------------
    // OTHER PILOTS' BULLETS (visual; the server decides hits)
    // ---------------------------------------------------------

    spawnRemoteShot(owner, x, z, r, lag = 0) {
        if (this.remoteShots.length >= CONFIG.maxRemoteShots) return;

        const THREE = this.THREE;
        const shared = this.getSharedResources();

        let mesh = this.shotPool.pop();

        if (!mesh) {
            mesh = new THREE.Mesh(
                shared.shotGeometry,
                new THREE.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: true,
                    opacity: 0.95,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending,
                    fog: false
                })
            );

            this.scene.add(mesh);
        }

        const vx = Math.sin(r) * CONFIG.shotSpeed;
        const vz = Math.cos(r) * CONFIG.shotSpeed;

        mesh.material.color.set(this.colorOf(owner));
        mesh.position.set(x + vx * lag, 0.45, z + vz * lag);
        mesh.visible = true;

        this.remoteShots.push({ mesh, vx, vz, life: CONFIG.shotLife - lag });
    }

    updateRemoteShots(dt) {
        for (let i = this.remoteShots.length - 1; i >= 0; i--) {
            const shot = this.remoteShots[i];

            shot.life -= dt;

            if (shot.life <= 0) {
                shot.mesh.visible = false;
                this.shotPool.push(shot.mesh);
                this.remoteShots.splice(i, 1);
                continue;
            }

            shot.mesh.position.x += shot.vx * dt;
            shot.mesh.position.z += shot.vz * dt;
        }
    }

    // Remove any remote shot passing (x, z), e.g. where it hit.
    stopShotsNear(x, z, radius = 1.2) {
        this.guard(() => {
            for (let i = this.remoteShots.length - 1; i >= 0; i--) {
                const p = this.remoteShots[i].mesh.position;

                if (Math.hypot(p.x - x, p.z - z) < radius) {
                    this.remoteShots[i].mesh.visible = false;
                    this.shotPool.push(this.remoteShots[i].mesh);
                    this.remoteShots.splice(i, 1);
                }
            }
        });
    }

    getSharedResources() {
        if (this.shared) return this.shared;

        const THREE = this.THREE;

        const ringGeometry = new THREE.RingGeometry(1.15, 1.35, 32);
        ringGeometry.rotateX(-Math.PI / 2);

        this.shared = {
            ringGeometry,
            engineGeometry: new THREE.SphereGeometry(0.28, 10, 8),
            shotGeometry: new THREE.SphereGeometry(0.16, 8, 6),
            bubbleGeometry: new THREE.SphereGeometry(3.4, 20, 14)
        };

        return this.shared;
    }

    // ---------------------------------------------------------
    // CALLSIGN (the name other pilots see)
    // A small button under the logo opens a box to type a new one.
    // It's checked as you type (name-filter.js), saved in this
    // browser, and sent to the lobby straight away; the server checks
    // it again and has the final say.
    // ---------------------------------------------------------

    setupCallsign(ui) {
        if (!ui?.button || !ui.dialog || !ui.form || !ui.input) return;

        this.callsignUi = ui;

        ui.button.addEventListener("click", (event) => {
            event.preventDefault?.();
            this.guard(() => this.openNameDialog());
        });

        ui.cancel?.addEventListener("click", (event) => {
            event.preventDefault?.();
            this.guard(() => this.closeNameDialog());
        });

        ui.form.addEventListener("submit", (event) => {
            event.preventDefault?.();
            this.guard(() => this.submitNameDialog());
        });

        ui.input.addEventListener("input", () => {
            this.guard(() => {
                const result = checkName(ui.input.value);
                this.showNameError(
                    ui.input.value.trim() === "" || result.ok ? "" : nameProblem(result.reason)
                );
            });
        });

        ui.input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault?.();
                this.guard(() => this.closeNameDialog());
            }
        });

        this.updateCallsignButton();
    }

    updateCallsignButton() {
        const button = this.callsignUi?.button;
        if (!button) return;

        // Only useful when multiplayer is on.
        button.hidden = !this.enabled;

        const label = this.callsignUi.label ?? button;
        const text = this.name;

        if (label.textContent !== text) label.textContent = text;
    }

    openNameDialog() {
        const ui = this.callsignUi;
        if (!ui) return;

        ui.input.value = this.name;
        this.showNameError("");

        ui.dialog.classList.remove("hidden");

        this.call("dialog", true);

        try {
            ui.input.focus();
            ui.input.select?.();
        } catch {
            // Some phones won't focus without another tap; that's fine.
        }
    }

    closeNameDialog() {
        const ui = this.callsignUi;
        if (!ui) return;

        ui.dialog.classList.add("hidden");

        try {
            ui.input.blur();
        } catch {
            // Ignore.
        }

        this.call("dialog", false);
    }

    submitNameDialog() {
        const result = this.setName(this.callsignUi.input.value);

        if (result.ok) {
            this.closeNameDialog();
        } else {
            this.showNameError(nameProblem(result.reason));
        }
    }

    showNameError(text) {
        const el = this.callsignUi?.error;
        if (el && el.textContent !== text) el.textContent = text;
    }

    /**
     * Change this pilot's callsign.
     * @returns {{ ok: boolean, name: string, reason?: string }}
     */
    setName(raw) {
        const result = checkName(raw);

        if (!result.ok) return result;

        this.name = result.name;
        savePilotName(result.name);
        this.updateCallsignButton();

        // In a lobby: tell everyone now. (Otherwise it's used on the
        // next join.)
        if (this.isOnline()) {
            this.send({ t: "n", name: result.name });
        }

        return result;
    }

    // A pilot's callsign changed (ours, confirmed or refused; or
    // someone else's).
    onName(data) {
        const id = String(data.id);
        const name = String(data.name ?? "").slice(0, 16);

        if (!name) return;

        if (id === this.selfId) {
            this.selfName = name;

            if (data.rejected) {
                // The server's copy stands; show it, and say why.
                this.name = name;
                savePilotName(name);
                this.updateCallsignButton();

                this.call(
                    "message",
                    data.rejected === "wait"
                        ? "WAIT A MOMENT BEFORE CHANGING CALLSIGN AGAIN"
                        : `${nameProblem(data.rejected)} — STILL ${name}`
                );
            } else {
                this.call("message", `CALLSIGN SET: ${name}`);
            }

            this.renderLeaderboard();
            return;
        }

        const info = this.roster.get(id);
        if (!info) return;

        info.name = name;

        const remote = this.remotes.get(id);

        if (remote) {
            remote.name = name;
            this.refreshLabel(remote);
        }

        this.renderLeaderboard();
    }

    // Redraw a pilot's name tag.
    refreshLabel(remote) {
        const visual = remote.visual;
        if (!visual) return;

        if (visual.label) {
            visual.group.remove(visual.label);
            visual.label.material.map?.dispose?.();
            visual.label.material.dispose?.();
        }

        visual.label = makeLabel(this.THREE, remote.name, remote.color);

        if (visual.label) {
            visual.label.position.set(0, 1, -2.1);
            visual.group.add(visual.label);
        }
    }

    // ---------------------------------------------------------
    // HUD
    // ---------------------------------------------------------

    setStatus(status) {
        this.status = status;
        this.updateStatusText();
    }

    updateStatusText() {
        const el = this.statusElement;
        if (!el) return;

        let text;
        let cls;

        if (this.status === "online") {
            const count = this.pilotCount();
            text = count === 1 ? "ONLINE · WAITING FOR PILOTS" : `ONLINE · ${count} PILOTS`;
            cls = "online";
        } else if (this.status === "connecting") {
            text = "LINKING TO SERVER...";
            cls = "connecting";
        } else {
            text = "OFFLINE MODE";
            cls = "offline";
        }

        if (el.textContent !== text) el.textContent = text;
        if (el.dataset && el.dataset.state !== cls) el.dataset.state = cls;
    }

    // Top 5, plus your own place if you're further down.
    renderLeaderboard() {
        const el = this.leaderboardElement;
        if (!el) return;

        if (!this.isOnline()) {
            if (!el.hidden) el.hidden = true;
            this.lastLeaderboardHtml = "";
            return;
        }

        const rows = [];
        const selfIndex = this.standings.findIndex((s) => String(s[0]) === this.selfId);

        this.standings.forEach((s, i) => {
            if (i < 5 || i === selfIndex) {
                if (i === selfIndex && i >= 5) rows.push(`<li class="lb-gap">···</li>`);

                const id = String(s[0]);
                const me = id === this.selfId;
                const name = me ? "YOU" : this.nameOf(id);

                rows.push(
                    `<li class="${me ? "lb-me" : ""}">` +
                    `<span class="lb-rank">${i + 1}</span>` +
                    `<span class="lb-name" style="color:${escapeHtml(this.colorOf(id))}">${escapeHtml(name)}</span>` +
                    `<span class="lb-score">${formatScore(num(s[1]))}</span>` +
                    `</li>`
                );
            }
        });

        const html = rows.join("");

        if (html !== this.lastLeaderboardHtml) {
            el.innerHTML = html;
            this.lastLeaderboardHtml = html;
        }

        el.hidden = rows.length === 0;
    }

    // ---------------------------------------------------------
    // SAFETY
    // ---------------------------------------------------------

    call(name, ...args) {
        const fn = this.handlers[name];

        if (typeof fn !== "function") return;

        try {
            fn(...args);
        } catch (error) {
            this.log(`Multiplayer handler "${name}" failed (ignored):`, error);
        }
    }

    guard(fn) {
        try {
            fn();
        } catch (error) {
            this.log("Multiplayer error (ignored):", error);
        }
    }

    log(...args) {
        const t = now();

        if (t - this.lastErrorLog < 3000) return;

        this.lastErrorLog = t;
        console.warn(...args);
    }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function round2(n) {
    return Math.round(num(n) * 100) / 100;
}

function lerpAngle(a, b, t) {
    return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

function formatScore(n) {
    return Math.floor(n).toLocaleString("en-US");
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

function samplePose(samples, renderTime) {
    const first = samples[0];
    const last = samples[samples.length - 1];

    if (samples.length === 1 || renderTime <= first.t) return first;

    if (renderTime >= last.t) {
        const ahead = Math.min(renderTime - last.t, CONFIG.maxExtrapolateMs) / 1000;

        return {
            x: last.x + last.vx * ahead,
            z: last.z + last.vz * ahead,
            r: last.r,
            th: last.th
        };
    }

    for (let i = samples.length - 2; i >= 0; i--) {
        const a = samples[i];
        const b = samples[i + 1];

        if (renderTime >= a.t) {
            const span = b.t - a.t;
            const k = span > 0 ? (renderTime - a.t) / span : 1;

            return {
                x: a.x + (b.x - a.x) * k,
                z: a.z + (b.z - a.z) * k,
                r: lerpAngle(a.r, b.r, k),
                th: k < 0.5 ? a.th : b.th
            };
        }
    }

    return last;
}

function sampleRocket(samples, renderTime) {
    const first = samples[0];
    const last = samples[samples.length - 1];

    if (samples.length === 1 || renderTime <= first.t) return first;

    if (renderTime >= last.t) {
        // Rockets fly at a constant 15 units/s along their heading.
        const ahead = Math.min(renderTime - last.t, CONFIG.maxExtrapolateMs) / 1000;

        return {
            x: last.x + Math.sin(last.h) * 15 * ahead,
            z: last.z + Math.cos(last.h) * 15 * ahead,
            h: last.h
        };
    }

    for (let i = samples.length - 2; i >= 0; i--) {
        const a = samples[i];
        const b = samples[i + 1];

        if (renderTime >= a.t) {
            const span = b.t - a.t;
            const k = span > 0 ? (renderTime - a.t) / span : 1;

            return {
                x: a.x + (b.x - a.x) * k,
                z: a.z + (b.z - a.z) * k,
                h: lerpAngle(a.h, b.h, k)
            };
        }
    }

    return last;
}

function makeLabel(THREE, name, color) {
    if (typeof document === "undefined") return null;

    try {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 48;

        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        ctx.font = "bold 26px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillStyle = color;
        ctx.fillText(name, 128, 24);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            fog: false
        });

        const sprite = new THREE.Sprite(material);
        sprite.scale.set(5.3, 1, 1);
        sprite.renderOrder = 5;

        return sprite;
    } catch {
        return null;
    }
}

function defaultServerUrl() {
    if (typeof location === "undefined") return null;

    if (location.protocol !== "https:" && location.protocol !== "http:") {
        return null;
    }

    const scheme = location.protocol === "https:" ? "wss:" : "ws:";

    return `${scheme}//${location.host}/api/ws`;
}

function offlineRequested() {
    try {
        return new URLSearchParams(location.search).has("offline");
    } catch {
        return false;
    }
}

const NAME_KEY = "asteroidDefensePilotName";

// The saved callsign, if it still passes the rules; otherwise a new
// random one.
function loadPilotName() {
    try {
        const saved = localStorage.getItem(NAME_KEY);
        const result = checkName(saved);

        if (saved && result.ok) return result.name;

        const name = randomCallsign();
        localStorage.setItem(NAME_KEY, name);

        return name;
    } catch {
        return randomCallsign();
    }
}

function savePilotName(name) {
    try {
        localStorage.setItem(NAME_KEY, name);
    } catch {
        // Storage unavailable: the name lasts for this visit.
    }
}

// A random id that lets the server give back your score if you
// reconnect during a round. Per tab, so two tabs are two pilots.
function loadPilotToken() {
    const key = "asteroidDefensePilotToken";

    try {
        const saved = sessionStorage.getItem(key);
        if (saved) return saved;

        const token = randomToken();
        sessionStorage.setItem(key, token);

        return token;
    } catch {
        return randomToken();
    }
}

function randomToken() {
    try {
        return crypto.randomUUID();
    } catch {
        return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    }
}

function loadLobbyId() {
    try {
        return sessionStorage.getItem("asteroidDefenseLobby");
    } catch {
        return null;
    }
}

function saveLobbyId(id) {
    try {
        sessionStorage.setItem("asteroidDefenseLobby", id);
    } catch {
        // Ignore.
    }
}

// Exposed for tests.
export const _internals = { samplePose, sampleRocket, CONFIG, PROTOCOL_VERSION };
