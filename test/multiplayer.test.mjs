// End-to-end tests for the multiplayer server (src/index.js) and
// client (public/multiplayer.js), using the in-memory Workers
// runtime in harness.mjs. Run with: npm test

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
    loadWorker,
    makeBrowserWebSocket,
    FakeTHREE,
    makeScene,
    makeShip,
    sleep,
    waitFor,
    setNetworkDelay
} from "./harness.mjs";

import { Multiplayer, _internals } from "../public/multiplayer.js";

const here = path.dirname(fileURLToPath(import.meta.url));

Object.assign(_internals.CONFIG, {
    joinTimeoutMs: 400,
    retryAfterDropMs: 60,
    retryBaseMs: 120,
    retryMaxMs: 500,
    keepaliveMs: 200,
    silenceTimeoutMs: 5000,
    forgetAfterMs: 600
});

const URL_WS = "ws://game.test/api/ws";
const V = _internals.PROTOCOL_VERSION;

// ------------------------------------------------------------
// Raw protocol clients (for testing the server's rules exactly)
// ------------------------------------------------------------

const openSockets = [];

async function rawClient(server, name, { token, lobby } = {}) {
    const WS = makeBrowserWebSocket(server);
    const params = new URLSearchParams({ v: String(V), name });

    if (token) params.set("token", token);
    if (lobby) params.set("lobby", lobby);

    const ws = new WS(`${URL_WS}?${params}`);
    openSockets.push(ws);

    const c = {
        ws,
        welcome: null,
        you: null,
        events: [],
        snaps: [],
        worlds: [],
        rounds: [],
        closed: false,

        send(message) {
            ws.send(JSON.stringify(message));
        },

        // Report this ship's position (and that it is flying).
        state(x, z, r = 0, extra = {}) {
            this.send({ t: "s", l: this.you.lf, x, z, r, vx: 0, vz: 0, th: 0, st: 1, w: 0, ...extra });
        },

        fire(w, x, z, r = 0) {
            this.send({ t: "f", w, x, z, r });
        },

        eventsOf(type) {
            return this.events.filter((e) => e[0] === type);
        },

        get id() {
            return this.welcome.id;
        }
    };

    ws.onmessage = ({ data }) => {
        const m = JSON.parse(data);

        if (m.t === "welcome") {
            c.welcome = m;
            c.you = m.you;
        } else if (m.t === "you") {
            c.you = { ...c.you, ...m };
        } else if (m.t === "ev") {
            c.events.push(...m.e);
        } else if (m.t === "snap") {
            c.snaps.push(m);
        } else if (m.t === "world") {
            c.worlds.push(m);
        } else if (m.t === "round") {
            c.rounds.push(m.round);
        }
    };

    ws.onclose = () => { c.closed = true; };

    await waitFor(() => c.welcome, 2000, `${name} welcomed`);

    return c;
}

// A lobby with no random spawns or rogue asteroids, so tests control
// exactly what is in the world.
function quietLobby(server) {
    const lobby = server.lobbies()[0].instance;

    lobby.spawnThings = () => {};
    lobby.despawnFarAsteroids = () => {};
    lobby.rogue.timer = 1e9;

    return lobby;
}

function shipOf(lobby, client) {
    return [...lobby.ships.values()].find((s) => s.id === client.id);
}

// Make ships hittable right away (skip the spawn shield).
function unshield(lobby) {
    for (const s of lobby.ships.values()) s.shieldUntil = 0;
}

// Keep reporting positions for `ms` (ships count as present only
// while they report).
async function hold(clients, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        for (const [c, x, z, r] of clients) c.state(x, z, r ?? 0);
        await sleep(50);
    }
}

// ------------------------------------------------------------
// Client-module helpers
// ------------------------------------------------------------

const clients = [];

function makeClient(server, name = "TESTER", extra = {}) {
    const scene = makeScene();
    const calls = { online: [], offline: 0, events: [], world: [], you: [], round: [] };

    const leaderboard = { hidden: true, innerHTML: "" };

    const mp = new Multiplayer({
        THREE: FakeTHREE,
        scene,
        createShipModel: makeShip,
        createRocketModel: () => ({ mesh: new FakeTHREE.Group(), flame: new FakeTHREE.Group() }),
        spawnSmoke: () => { calls.smoke = (calls.smoke ?? 0) + 1; },
        shipScale: 1.15,
        serverUrl: URL_WS,
        WebSocketImpl: makeBrowserWebSocket(server),
        leaderboardElement: leaderboard,
        handlers: {
            online: (w) => calls.online.push(w),
            offline: () => { calls.offline++; },
            events: (list) => calls.events.push(...list),
            world: (m) => calls.world.push(m),
            you: (m) => calls.you.push(m),
            round: (r) => calls.round.push(r)
        },
        ...extra
    });

    mp.name = name;
    mp.scene = scene;
    mp.calls = calls;
    mp.leaderboard = leaderboard;
    mp.connect();

    clients.push(mp);

    return mp;
}

function shutdown(mp) {
    mp.enabled = false;
    clearTimeout(mp.retryTimer);
    if (mp.socket) mp.abandon(mp.socket);
}

function shutdownAll() {
    for (const mp of clients.splice(0)) shutdown(mp);

    for (const ws of openSockets.splice(0)) {
        try { ws.close(); } catch { /* already closed */ }
    }
}

async function runFrames(players, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        for (const [mp, local] of players) {
            mp.update(0.016, typeof local === "function" ? local() : local);
        }

        await sleep(16);
    }
}

function local(mp, x, z, extra = {}) {
    return {
        playing: true, x, z, r: 0, vx: 0, vz: 0, thrust: 0,
        life: mp.lastWelcomeLife ?? 1, weapon: 0, ...extra
    };
}

// ------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- Joining -------------------------------------------------------

test("welcome carries the round (15 min), this pilot, and the shared world", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");

    const w = a.welcome;

    assert.equal(w.v, V);
    assert.equal(w.round.phase, "playing");
    assert.ok(Math.abs(w.round.endsAt - Date.now() - 15 * 60 * 1000) < 2000, "15-minute round");
    assert.equal(w.you.hull, 3);
    assert.equal(w.you.sc, 0);
    assert.ok(Array.isArray(w.you.sp), "spawn point");
    assert.ok(Array.isArray(w.world.a) && Array.isArray(w.world.m) && Array.isArray(w.world.c));
    assert.match(w.lobby, /^lobby-/);

    shutdownAll();
});

test("asteroids are shared: everyone gets the same ones, and they move the same", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    const rock = lobby.spawnAsteroid(10, 10, 1.0, 2, 0);

    await waitFor(() => a.eventsOf("as").length && b.eventsOf("as").length, 1000, "spawn events");

    assert.equal(a.eventsOf("as")[0][1], rock.id);
    assert.equal(b.eventsOf("as")[0][1], rock.id);

    await waitFor(() => a.worlds.length >= 1 && b.worlds.length >= 1, 2000, "world syncs");

    const inA = a.worlds.at(-1).a.find((x) => x[0] === rock.id);
    const inB = b.worlds.at(-1).a.find((x) => x[0] === rock.id);

    assert.ok(inA && inB);
    assert.ok(inA[1] > 10, "it moved along +x");
    assert.equal(inA[3], 2);

    shutdownAll();
});

test("asteroids are rarer: a lone pilot gets a handful around them, not a screenful", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "SOLO");
    const lobby = server.lobbies()[0].instance;
    lobby.rogue.timer = 1e9;

    // Simulate a long stretch quickly: spawn checks with no delay.
    const ship = shipOf(lobby, a);
    ship.st = 1;

    for (let i = 0; i < 40; i++) {
        ship.stateAt = Date.now();
        ship.nextAsteroidAt = 0;
        lobby.spawnThings(Date.now());
    }

    const near = lobby.asteroids.filter((r) => Math.hypot(r.x - ship.x, r.z - ship.z) < 45).length;

    assert.ok(near >= 3 && near <= 7, `asteroids near the pilot: ${near}`);

    shutdownAll();
});

// ---- Weapons vs. the world -------------------------------------------

test("a bullet destroys a small asteroid and scores for the shooter (seen by everyone)", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    const rock = lobby.spawnAsteroid(0, 8, 0.72, 0, 0);

    await hold([[a, 0, 0], [b, 30, 30]], 150);
    a.fire(0, 0, 1.1, 0);

    await waitFor(() => a.eventsOf("ad").length, 1500, "destroyed");

    const ad = a.eventsOf("ad")[0];
    assert.equal(ad[1], rock.id);
    assert.equal(ad[4], a.id, "credited to ALPHA");

    await waitFor(() => a.you.sc === rock.score, 1000, "score");
    await waitFor(() => b.eventsOf("ad").length === 1, 1000, "B saw it");
    assert.equal(b.you.sc, 0);

    shutdownAll();
});

test("laser: hits exactly what it reaches (range 60), splits rocks, spares its own fragments", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 15000;

    const inBeam = lobby.spawnAsteroid(0, 30, 1.0, 0, 0);     // hp 2: destroyed, splits
    const beside = lobby.spawnAsteroid(5, 30, 0.72, 0, 0);    // 5 units off the beam
    const beyond = lobby.spawnAsteroid(0, 75, 0.72, 0, 0);    // past the beam's reach
    const behind = lobby.spawnAsteroid(0, -10, 0.72, 0, 0);   // behind the ship

    await hold([[a, 0, 0]], 150);
    a.fire(1, 0, 1.1, 0);
    await hold([[a, 0, 0]], 400);

    const ids = lobby.asteroids.map((r) => r.id);

    assert.ok(!ids.includes(inBeam.id), "rock in the beam destroyed");
    assert.ok(ids.includes(beside.id), "rock beside the beam untouched");
    assert.ok(ids.includes(beyond.id), "rock beyond 60 units untouched");
    assert.ok(ids.includes(behind.id), "rock behind the ship untouched");

    const fragments = lobby.asteroids.filter((r) => r.bornFrom);
    assert.equal(fragments.length, 2, "split into two, which the same beam did not hit");
    assert.ok(a.eventsOf("lh").length >= 1, "laser impact shown");

    shutdownAll();
});

test("laser: also hits a rock that moves into the beam while it is visible", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 15000;

    // Just off the beam when fired, crossing into it fast.
    const crosser = lobby.spawnAsteroid(1.6, 20, 0.72, -12, 0);

    await hold([[a, 0, 0]], 150);
    a.fire(1, 0, 1.1, 0);
    await hold([[a, 0, 0]], 400);

    assert.ok(!lobby.asteroids.includes(crosser), "hit while crossing");

    shutdownAll();
});

test("locked weapons and over-fast firing are refused", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);

    a.fire(1, 0, 1.1, 0); // laser: locked
    a.fire(2, 0, 1.1, 0); // rockets: locked

    for (let i = 0; i < 10; i++) a.fire(0, 0, 1.1, 0);

    await sleep(30);

    assert.equal(lobby.beams.length, 0);
    assert.equal(lobby.rockets.length, 0);
    assert.equal(lobby.bullets.length, 1, "one bullet per cooldown");

    shutdownAll();
});

test("a shot reported far from the ship fires from where the server thinks it is", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);

    a.fire(0, 100, 100, 0);
    await sleep(20);

    const bullet = lobby.bullets[0];
    assert.ok(bullet && Math.hypot(bullet.x, bullet.z) < 3, "fired from the ship, not (100, 100)");

    shutdownAll();
});

test("rockets fire on the trigger, home on a target ahead, and vaporize without splitting", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 20000;

    const target = lobby.spawnAsteroid(4, 14, 1.45, 0, 0);
    const neighbor = lobby.spawnAsteroid(6, 15, 0.72, 0, 0);

    await hold([[a, 0, 0]], 300);

    assert.equal(lobby.rockets.length, 0, "nothing fires by itself");

    a.fire(2, 0.55, 0.3, 0);

    await waitFor(() => a.snaps.some((s) => s.rk.length > 0), 1000, "rocket in snapshots");
    await waitFor(() => a.eventsOf("rx").length, 3000, "exploded");

    assert.ok(!lobby.asteroids.includes(target), "target destroyed");
    assert.ok(!lobby.asteroids.includes(neighbor), "neighbor in the blast destroyed");
    assert.equal(lobby.asteroids.length, 0, "no fragments");

    shutdownAll();
});

// ---- PvP -------------------------------------------------------------

test("bullets damage other pilots; a kill scores a bonus and the victim respawns", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0], [b, 0, 6]], 150);
    unshield(lobby);

    a.fire(0, 0, 1.1, 0);
    await hold([[a, 0, 0], [b, 0, 6]], 300);

    assert.equal(b.you.hull, 2, "B lost a hull point");
    assert.equal(a.you.sc, 200, "hit bonus");

    // Finish B off (skip the hit cooldown).
    shipOf(lobby, b).hitCooldownUntil = 0;
    shipOf(lobby, b).hull = 1;

    a.fire(0, 0, 1.1, 0);
    await sleep(160);
    a.fire(0, 0, 1.1, 0);
    await hold([[a, 0, 0], [b, 0, 6]], 300);

    const kill = b.eventsOf("sk").find((e) => e[1] === b.id);
    assert.ok(kill, "B destroyed");
    assert.equal(kill[2], a.id, "by ALPHA");
    assert.equal(b.you.alive, false);
    assert.equal(a.you.sc, 200 + 200 + 2500);

    const oldLife = b.you.lf;

    // Reports from the dead ship are ignored...
    b.state(50, 50);
    await sleep(50);
    assert.notEqual(shipOf(lobby, b).x, 50);

    // ...and it comes back after about 3 seconds, at full hull,
    // keeping its score.
    await waitFor(() => b.you.alive === true, 4000, "respawn");

    assert.equal(b.you.hull, 3);
    assert.equal(b.you.lf, oldLife + 1);
    assert.ok(Array.isArray(b.you.sp));
    assert.ok(b.eventsOf("sr").some((e) => e[1] === b.id));

    shutdownAll();
});

test("laser and rockets hit other pilots too; the spawn shield protects", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 20000;

    // Shielded (just spawned): no damage.
    await hold([[a, 0, 0], [b, 0, 20]], 150);
    a.fire(1, 0, 1.1, 0);
    await hold([[a, 0, 0], [b, 0, 20]], 200);
    assert.equal(b.you.hull, 3, "shield held");

    unshield(lobby);
    shipOf(lobby, a).lastFire = [0, 0, 0];

    a.fire(1, 0, 1.1, 0);
    await hold([[a, 0, 0], [b, 0, 20]], 300);
    assert.equal(b.you.hull, 2, "laser hit");

    shipOf(lobby, b).hitCooldownUntil = 0;
    a.fire(2, 0, 1.1, 0);
    await hold([[a, 0, 0], [b, 0, 20]], 2500);

    assert.ok(b.you.hull === 0 || b.you.alive === false, "rocket finished B (2 damage)");

    shutdownAll();
});

test("pilots can't hurt themselves", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    unshield(lobby);
    shipOf(lobby, a).score = 20000;

    // A rock right next to the ship, so the rocket bursts at once.
    lobby.spawnAsteroid(0, 2.2, 0.72, 0, 0);

    await hold([[a, 0, 0]], 150);
    a.fire(2, 0, 1.1, 0);
    await hold([[a, 0, 0]], 600);

    assert.equal(a.you.hull, 3);

    shutdownAll();
});

// ---- Ship vs. the world ----------------------------------------------

test("mines and asteroids damage ships; crystals score and repair", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);
    unshield(lobby);

    lobby.spawnMine(0.5, 0, 0, 0);
    await hold([[a, 0, 0]], 200);

    assert.equal(a.you.hull, 2, "mine hit");
    assert.ok(a.eventsOf("md").length === 1);

    lobby.spawnCrystal(0.5, 0.5);
    await hold([[a, 0, 0]], 200);

    assert.equal(a.you.hull, 3, "repaired");
    assert.equal(a.you.sc, 500);
    assert.ok(a.eventsOf("cc").some((e) => e[2] === a.id));

    shipOf(lobby, a).hitCooldownUntil = 0;
    lobby.spawnAsteroid(1, 0, 1.0, 0, 0);
    await hold([[a, 0, 0]], 200);

    assert.equal(a.you.hull, 2, "asteroid hit");
    assert.ok(a.eventsOf("au").length >= 1, "asteroid knocked away (shared)");

    shutdownAll();
});

test("warp bubble at 10,000 points: immune, and clears rocks around the ship", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);
    unshield(lobby);

    shipOf(lobby, a).score = 9950;
    lobby.spawnAsteroid(0, 8, 0.72, 0, 0);

    a.fire(0, 0, 1.1, 0);
    await hold([[a, 0, 0]], 400);

    assert.ok(a.eventsOf("w").some((e) => e[1] === a.id), "warp event");

    const near = lobby.spawnAsteroid(3, 3, 1.0, 0, 0);
    await hold([[a, 0, 0]], 200);

    assert.ok(!lobby.asteroids.includes(near), "cleared by the bubble");
    assert.equal(a.you.hull, 3);

    shutdownAll();
});

test("the rogue asteroid is shared and destroys what's in its path", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0], [b, 20, 20]], 150);

    lobby.rogue.timer = 0;

    await hold([[a, 0, 0], [b, 20, 20]], 150);

    const warning = a.eventsOf("rg")[0];
    assert.ok(warning, "rogue announced");
    assert.deepEqual(b.eventsOf("rg")[0], warning, "same rogue for everyone");

    // Put a rock right on its path.
    const r = lobby.rogue;
    const t = 50;
    const rock = lobby.spawnAsteroid(r.x + r.dx * t, r.z + r.dz * t, 1.0, 0, 0);

    await hold([[a, 0, 0], [b, 20, 20]], 4500);

    assert.ok(!lobby.asteroids.includes(rock), "destroyed by the rogue");
    assert.ok(a.eventsOf("ro").length === 1, "passed");

    shutdownAll();
});

// ---- Rounds and the leaderboard ----------------------------------------

test("round end: results ranked by score; then a fresh round resets scores", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 3000;
    shipOf(lobby, b).score = 7000;
    shipOf(lobby, b).kills = 2;

    await waitFor(() => a.worlds.length > 0, 2000, "leaderboard sync");
    const lb = a.worlds.at(-1).lb;
    assert.equal(lb[0][0], b.id, "leaderboard order");

    lobby.round.endsAt = Date.now();

    await waitFor(() => a.rounds.some((r) => r.phase === "ended"), 1000, "round over");

    const ended = a.rounds.find((r) => r.phase === "ended");
    assert.equal(ended.results[0].name, "BRAVO");
    assert.equal(ended.results[0].score, 7000);
    assert.equal(ended.results[1].name, "ALPHA");

    // No firing between rounds.
    a.fire(0, 0, 1.1, 0);
    await sleep(60);
    assert.equal(lobby.bullets.length, 0);

    lobby.round.nextAt = Date.now();

    await waitFor(() => a.rounds.some((r) => r.phase === "playing" && r.n === 2), 1000, "round 2");
    await waitFor(() => a.you.sc === 0 && b.you.sc === 0, 1000, "scores reset");

    assert.ok(Array.isArray(a.you.sp), "new spawn point");

    shutdownAll();
});

test("reconnecting in the same round returns to the same lobby with the same score", async () => {
    const server = await loadWorker();
    const token = "0123456789abcdef0123456789abcdef";

    const a = await rawClient(server, "ALPHA", { token });
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 4200;
    shipOf(lobby, a).kills = 1;

    const lobbyId = a.welcome.lobby;

    a.ws.close();
    await waitFor(() => lobby.ships.size === 1, 1000, "A gone");

    const again = await rawClient(server, "ALPHA", { token, lobby: lobbyId });

    assert.equal(again.welcome.lobby, lobbyId);
    assert.equal(again.welcome.you.sc, 4200);
    assert.equal(again.welcome.you.k, 1);

    assert.ok(b.closed === false);

    shutdownAll();
});

// ---- Lobbies and the matchmaker -----------------------------------------

test("the 21st player gets a second lobby; 45 simultaneous joins never overfill", async () => {
    const server = await loadWorker();

    const players = [];

    for (let i = 0; i < 21; i++) {
        players.push(makeClient(server, `P${i}`));
        await waitFor(() => players[i].isOnline(), 2000, `player ${i}`);
    }

    assert.deepEqual(server.lobbies().map((l) => l.sockets).sort((x, y) => y - x), [20, 1]);

    shutdownAll();

    const server2 = await loadWorker();
    const burst = [];

    for (let i = 0; i < 45; i++) burst.push(makeClient(server2, `B${i}`));

    await waitFor(() => burst.every((p) => p.isOnline()), 5000, "all online");

    const counts = server2.lobbies().map((l) => l.sockets);
    assert.ok(counts.every((c) => c <= 20), `${counts}`);
    assert.equal(counts.reduce((s, c) => s + c, 0), 45);

    shutdownAll();
});

test("refused requests: wrong version, not a WebSocket, other origins", async () => {
    const server = await loadWorker({ ALLOWED_ORIGINS: "https://good.example" });

    assert.equal((await server.fetch(`http://game.test/api/ws?v=1`, { Upgrade: "websocket", Origin: "https://good.example" })).status, 409);
    assert.equal((await server.fetch(`http://game.test/api/ws?v=${V}`, { Origin: "https://good.example" })).status, 426);
    assert.equal((await server.fetch(`http://game.test/api/ws?v=${V}`, { Upgrade: "websocket", Origin: "https://evil.example" })).status, 403);

    const ok = await server.fetch(`http://game.test/api/ws?v=${V}`, { Upgrade: "websocket", Origin: "https://good.example" });
    assert.equal(ok.status, 101);
    ok.webSocket.close();

    assert.equal((await server.fetch("http://game.test/api/health")).status, 200);
});

test("junk, floods and bad numbers never break the lobby", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    quietLobby(server);

    const junk = [
        "not json", "{", "null", "[]", "x".repeat(10_000),
        JSON.stringify({ t: "s", l: 1, x: "NaN", z: 0, r: 0 }),
        JSON.stringify({ t: "s", l: 1, x: Infinity, z: 0, r: 0 }),
        JSON.stringify({ t: "f", w: 99, x: 0, z: 0, r: 0 }),
        JSON.stringify({ t: "f", w: "laser" }),
        JSON.stringify({ t: "zzz" })
    ];

    for (const m of junk) b.ws.send(m);
    for (let i = 0; i < 500; i++) b.state(i, 0);

    await sleep(1200);

    b.state(99999, -99999);
    await hold([[a, 1, 1]], 300);

    const snap = a.snaps.at(-1);
    const bRow = snap.p.find((p) => p[0] === b.id);

    assert.equal(bRow[1], 230, "x clamped to the world");
    assert.equal(bRow[2], -145, "z clamped to the world");
    assert.ok(!a.closed && !b.closed);

    shutdownAll();
});

test("the simulation survives an exception and keeps running", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    let thrown = 0;
    const original = lobby.moveAsteroids.bind(lobby);

    lobby.moveAsteroids = (dt) => {
        if (thrown++ < 3) throw new Error("boom");
        original(dt);
    };

    const before = a.snaps.length;
    await hold([[a, 0, 0]], 500);

    assert.ok(a.snaps.length > before + 2, "snapshots keep coming");

    shutdownAll();
});

test("silent connections are dropped; stale lobbies forgotten", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = server.lobbies()[0];

    shipOf(lobby.instance, b).lastSeen = Date.now() - 10 * 60_000;

    await lobby.instance.alarm();
    await waitFor(() => lobby.state.sockets.length === 1, 1000, "B dropped");

    const realNow = Date.now;

    try {
        assert.equal((await server.matchmakerStats()).length, 1);
        Date.now = () => realNow() + 5 * 60_000;
        assert.equal((await server.matchmakerStats()).length, 0);
    } finally {
        Date.now = realNow;
    }

    assert.ok(a);
    shutdownAll();
});

// ---- The client module -----------------------------------------------

test("client: joins, forwards world/events/you/round, draws rockets, renders the leaderboard", async () => {
    const server = await loadWorker();

    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");

    await waitFor(() => a.isOnline() && b.isOnline(), 2000, "online");
    await waitFor(() => a.remotes.size === 1, 2000, "roster");

    assert.equal(a.calls.online.length, 1);
    assert.equal(a.pilotCount(), 2);

    const lobby = quietLobby(server);
    const shipA = shipOf(lobby, { id: a.selfId });
    shipA.score = 20000;

    // Fly both for a moment so they count as present.
    const life = () => a.calls.online[0].you.lf;

    await runFrames([
        [a, () => ({ playing: true, x: 0, z: 0, r: 0, vx: 0, vz: 0, thrust: 0, life: life(), weapon: 2 })],
        [b, () => ({ playing: true, x: 30, z: 30, r: 0, vx: 0, vz: 0, thrust: 0, life: b.calls.online[0].you.lf, weapon: 0 })]
    ], 300);

    lobby.spawnAsteroid(0, 14, 1.0, 0, 0);
    assert.equal(a.fire(2, 0, 1.1, 0), true);

    await runFrames([
        [a, () => ({ playing: true, x: 0, z: 0, r: 0, vx: 0, vz: 0, thrust: 0, life: life(), weapon: 2 })],
        [b, () => ({ playing: true, x: 30, z: 30, r: 0, vx: 0, vz: 0, thrust: 0, life: b.calls.online[0].you.lf, weapon: 0 })]
    ], 1500);

    assert.ok(a.calls.events.some((e) => e[0] === "as"), "events forwarded");
    assert.ok(a.calls.events.some((e) => e[0] === "rx"), "rocket exploded");
    assert.ok((a.calls.smoke ?? 0) > 3, "rocket drawn with smoke");
    assert.equal(a.rockets.size, 0, "rocket removed after exploding");
    assert.ok(a.calls.world.length >= 1, "world forwarded");
    assert.ok(a.calls.you.some((y) => y.sc > 0), "score forwarded");

    // Leaderboard: both pilots, ALPHA first, shown as YOU.
    assert.equal(a.leaderboard.hidden, false);
    assert.match(a.leaderboard.innerHTML, /YOU/);
    assert.match(a.leaderboard.innerHTML, /BRAVO/);
    assert.ok(a.leaderboard.innerHTML.indexOf("YOU") < a.leaderboard.innerHTML.indexOf("BRAVO"));

    // Server clock estimate is close.
    assert.ok(Math.abs(a.serverNow() - Date.now()) < 200);

    shutdownAll();
});

test("client: drop → offline handler → rejoins the same lobby and keeps the score", async () => {
    const server = await loadWorker();

    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");

    await waitFor(() => a.isOnline() && b.isOnline() && a.remotes.size === 1, 2000, "online");

    const lobby = server.lobbies()[0];
    const ship = shipOf(lobby.instance, { id: a.selfId });
    ship.score = 1234;

    const aSocket = lobby.state.sockets.find((ws) => ws.deserializeAttachment().id === a.selfId);
    aSocket.close(1012, "restart");
    lobby.instance.removePlayer(aSocket);

    await waitFor(() => a.calls.offline === 1, 1000, "offline handler");
    assert.equal(a.leaderboard.hidden, true);

    await waitFor(() => a.calls.online.length === 2, 2000, "rejoined");

    const welcome = a.calls.online[1];
    assert.equal(welcome.lobby, a.calls.online[0].lobby, "same lobby");
    assert.equal(welcome.you.sc, 1234, "score kept");

    shutdownAll();
});

test("client: server unreachable → offline, harmless calls, joins when it returns", async () => {
    const server = await loadWorker();
    server.down = true;

    const a = makeClient(server, "SOLO");
    await sleep(100);

    assert.equal(a.status, "offline");
    assert.equal(a.fire(0, 0, 0, 0), false);

    for (let i = 0; i < 10; i++) a.update(0.016, { playing: true, x: i, z: i, r: 0, life: 1, weapon: 0 });

    server.down = false;
    await waitFor(() => a.isOnline(), 3000, "joins");

    shutdownAll();

    const server2 = await loadWorker();
    server2.hang = true;

    const b = makeClient(server2, "WAIT");
    await waitFor(() => b.status === "offline", 1500, "join timeout");
    server2.hang = false;
    await waitFor(() => b.isOnline(), 3000, "joins on retry");

    shutdownAll();
});

test("client: other pilots' ships interpolate, hide when destroyed, show warp", async () => {
    setNetworkDelay(30);

    try {
        const server = await loadWorker();

        const a = makeClient(server, "ALPHA");
        const b = makeClient(server, "BRAVO");

        await waitFor(() => a.remotes.size === 1 && b.isOnline(), 3000, "roster");

        const bLife = () => b.calls.online[0].you.lf;

        let x = 0;
        await runFrames([
            [a, { playing: true, x: 0, z: 0, r: 0, life: 1, weapon: 0 }],
            [b, () => ({ playing: true, x: (x += 0.25), z: 0, r: 0, vx: 15, vz: 0, life: bLife(), weapon: 0 })]
        ], 700);

        const remote = [...a.remotes.values()][0];
        assert.ok(remote.visual?.group.visible, "drawn");
        assert.ok(remote.visual.group.position.x > 0 && remote.visual.group.position.x <= x + 5);

        const lobby = server.lobbies()[0].instance;
        const shipB = shipOf(lobby, { id: b.selfId });

        shipB.warpUntil = Date.now() + 5000;
        await runFrames([[a, { playing: true, x: 0, z: 0, r: 0, life: 1, weapon: 0 }], [b, () => ({ playing: true, x, z: 0, r: 0, life: bLife(), weapon: 0 })]], 300);
        assert.equal(remote.visual.bubble.visible, true, "warp bubble shown");

        shipB.warpUntil = 0;
        shipB.shieldUntil = 0;
        lobby.damageShip(shipB, 3, null, Date.now());

        await runFrames([[a, { playing: true, x: 0, z: 0, r: 0, life: 1, weapon: 0 }]], 200);
        assert.equal(remote.visual.group.visible, false, "hidden once destroyed");

        shutdownAll();
    } finally {
        setNetworkDelay(0);
    }
});

test("interpolation math", () => {
    const { samplePose, sampleRocket } = _internals;

    const samples = [
        { t: 0, x: 0, z: 0, r: 0, vx: 10, vz: 0, th: 0 },
        { t: 100, x: 10, z: 0, r: Math.PI * 0.9, vx: 10, vz: 0, th: 1 }
    ];

    assert.equal(samplePose(samples, 50).x, 5);
    assert.equal(samplePose(samples, 10_000).x, 12.5, "extrapolation capped");

    const wrap = samplePose([
        { t: 0, x: 0, z: 0, r: Math.PI - 0.1, vx: 0, vz: 0, th: 0 },
        { t: 100, x: 0, z: 0, r: -Math.PI + 0.1, vx: 0, vz: 0, th: 0 }
    ], 50);
    assert.ok(Math.abs(Math.abs(wrap.r) - Math.PI) < 1e-9, "short way round");

    const rocket = sampleRocket([{ t: 0, x: 0, z: 0, h: 0 }], 100);
    assert.equal(rocket.x, 0);
});

// ------------------------------------------------------------

let failed = 0;

for (const { name, fn } of tests) {
    const started = Date.now();

    try {
        await fn();
        console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}\n    ${error.stack?.split("\n").slice(0, 4).join("\n    ")}`);
        shutdownAll();
    }

    await sleep(50);
}

await rm(path.join(here, ".build"), { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);

process.exit(failed ? 1 : 0);
