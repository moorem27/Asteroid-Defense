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
import { createUfoPlan, ufoState, UFO } from "../public/ufo.js";

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

    ws.onclose = (event) => {
        c.closed = true;
        c.closeCode = event?.code;
    };

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
    lobby.ufoDue = [];

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

function makeClient(server, name = "TESTER", { token, ...extra } = {}) {
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
    if (token) mp.token = token;
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
        ship.stateAt = ship.playingAt = Date.now();
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

    await hold([[a, 0, 0]], 150);

    // Just off the beam when fired, crossing into it fast. (Spawned
    // right before firing, or it would already be past.)
    const crosser = lobby.spawnAsteroid(1.6, 20, 0.72, -12, 0);
    crosser.radius = 0.5;

    a.fire(1, 0, 1.1, 0);

    await sleep(10);
    assert.ok(lobby.asteroids.includes(crosser), "not touching the beam when it fired");

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

// ---- UFO visits -------------------------------------------------------

// A visit hovering at (x, z), already watching (past materializing).
function placeUfo(lobby, x, z, watch = null) {
    const now = Date.now();

    lobby.ufo = createUfoPlan(Math.random, { id: 99, startMs: now - 2500, x, z, halfW: 230, halfH: 145, watch });
    lobby.ufo.legs = [[now - 2500, x, z]];
    lobby.ufo.o = 30;

    return lobby.ufo;
}

test("UFO: once or twice a round, it visits a pilot; everyone gets the plan; then it's gone", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = server.lobbies()[0].instance;

    // Scheduled for this round: one or two visits, minutes in.
    const start = lobby.round.startedAt;
    assert.ok(lobby.ufoDue.length >= 1 && lobby.ufoDue.length <= 2, "one or two visits");
    assert.ok(lobby.ufoDue[0] - start >= 2 * 60_000, "not right away");

    lobby.spawnThings = () => {};
    lobby.ufoDue = [Date.now()];

    await hold([[a, 0, 0], [b, 40, 20]], 200);

    await waitFor(() => a.eventsOf("us").length && b.eventsOf("us").length, 1000, "plan sent");

    const plan = a.eventsOf("us")[0][1];
    const watched = plan.w === a.id ? [0, 0] : [40, 20];

    assert.ok([a.id, b.id].includes(plan.w), "watching a pilot in the lobby");
    assert.ok(Math.hypot(plan.legs[0][1] - watched[0], plan.legs[0][2] - watched[1]) < 13, "near them");
    assert.deepEqual(b.eventsOf("us")[0][1], plan, "same plan for everyone");

    await waitFor(() => a.worlds.some((w) => w.u?.id === plan.id), 2000, "in the world sync");

    // Long past its departure: forgotten.
    lobby.ufo.s -= 60_000;
    for (const leg of lobby.ufo.legs) leg[0] -= 60_000;

    await waitFor(() => lobby.ufo === null, 500, "gone");
    await waitFor(() => a.worlds.at(-1).u === null, 2000, "world says none");

    shutdownAll();
});

test("UFO: it glides after the pilot it's watching", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);
    placeUfo(lobby, 0, 10, a.id);
    lobby.ufo.legs[0][0] -= 5000;

    await hold([[a, 60, 0]], 300);

    const us = a.eventsOf("us").at(-1);
    assert.ok(us, "plan update sent");
    assert.equal(us[1].legs.length, 2, "a new hover point");
    assert.ok(Math.hypot(us[1].legs[1][1] - 60, us[1].legs[1][2]) < 13, "near where the pilot went");

    shutdownAll();
});

test("UFO: its shield absorbs shots and turns asteroids aside", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 20000;
    placeUfo(lobby, 0, 14);

    const behind = lobby.spawnAsteroid(0, 30, 0.72, 0, 0);
    let x = ufoState(lobby.ufo, Date.now()).x;

    await hold([[a, x, 0]], 150);
    x = ufoState(lobby.ufo, Date.now()).x;
    a.fire(0, x, 1.1, 0);

    await waitFor(() => a.eventsOf("uh").length, 1000, "bullet absorbed");

    const bh = a.eventsOf("uh")[0];
    assert.equal(bh[3], a.id);
    assert.equal(bh[4], 0, "a bullet");
    assert.equal(a.eventsOf("bh").length, 0, "it hit nothing else");
    assert.ok(lobby.asteroids.includes(behind), "nothing got through to the rock behind it");

    // A rock flying at it glances off (and that isn't an attack).
    const s = ufoState(lobby.ufo, Date.now());
    const rock = lobby.spawnAsteroid(s.x + 6, s.z, 0.72, -8, 0);

    await waitFor(() => rock.vx > 0, 1500, "bounced");
    await waitFor(() => a.eventsOf("au").some((e) => e[1] === rock.id), 1000, "everyone told");

    const now = ufoState(lobby.ufo, Date.now());
    assert.ok(Math.hypot(rock.x - now.x, rock.z - now.z) >= UFO.shieldRadius, "outside the shield");

    shutdownAll();
});

test("UFO: shoot it and it destroys you with one plasma blast; three attackers and it turns hostile", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const c = await rawClient(server, "CHARLIE");
    const d = await rawClient(server, "DELTA");
    const lobby = quietLobby(server);

    for (const ship of lobby.ships.values()) ship.score = 20000;

    placeUfo(lobby, 0, 14);

    const ux = () => ufoState(lobby.ufo, Date.now()).x;

    // Everyone well away, except the one about to fire.
    const positions = { a: [ux(), 0], b: [60, -40], c: [-60, -40], d: [60, 60] };
    const holdAll = (ms) => hold([[a, ...positions.a], [b, ...positions.b], [c, ...positions.c], [d, ...positions.d]], ms);

    await holdAll(150);
    unshield(lobby);

    // It doesn't attack anyone who leaves it alone.
    assert.equal(a.eventsOf("up").length, 0);

    // ALPHA fires a bullet: vaporized.
    positions.a = [ux(), 0];
    await holdAll(60);
    a.fire(0, positions.a[0], 1.1, 0);

    await waitFor(() => a.eventsOf("up").length === 1, 1000, "plasma blast");
    assert.equal(a.eventsOf("up")[0][3], a.id, "at the attacker");
    await waitFor(() => a.eventsOf("sk").some((e) => e[1] === a.id && e[5] === "ufo"), 1000, "ALPHA destroyed");
    assert.equal(shipOf(lobby, a).alive, false);

    // Shots still in the air from a ship it already destroyed don't count.
    assert.equal(lobby.ufoAnger, 1);

    // BRAVO tries the laser (from out of range of nothing: it fired).
    positions.a = [200, 140];
    positions.b = [ux(), -2];
    await holdAll(1100);
    b.fire(1, positions.b[0], -0.9, 0);
    await waitFor(() => a.eventsOf("sk").some((e) => e[1] === b.id && e[5] === "ufo"), 1000, "BRAVO destroyed");

    // CHARLIE's rocket goes off on the shield; CHARLIE is destroyed too.
    positions.b = [-200, 140];
    positions.c = [ux(), -2];
    await holdAll(300);
    c.fire(2, positions.c[0], -0.9, 0);
    await waitFor(() => a.eventsOf("sk").some((e) => e[1] === c.id && e[5] === "ufo"), 3000, "CHARLIE destroyed");

    // Three attackers: hostile, and everyone is told.
    await waitFor(() => a.eventsOf("us").some((e) => e[1].h === 1), 1000, "hostile");
    assert.equal(lobby.ufo.h, 1);

    // DELTA (who never fired) stays out of range: safe.
    positions.c = [200, -140];
    await holdAll(1200);
    assert.ok(shipOf(lobby, d).alive, "out of range: safe");

    // DELTA comes close: destroyed.
    const s = ufoState(lobby.ufo, Date.now());
    positions.d = [s.x + 8, s.z];
    await holdAll(1500);

    assert.ok(a.eventsOf("sk").some((e) => e[1] === d.id && e[5] === "ufo"), "came too close");

    // No points for anyone from the UFO's kills.
    for (const ship of lobby.ships.values()) assert.equal(ship.kills, 0);

    // Respawns land well outside its range.
    lobby.respawn(shipOf(lobby, d), Date.now());
    const now = ufoState(lobby.ufo, Date.now());
    const sd = shipOf(lobby, d);
    assert.ok(Math.hypot(sd.x - now.x, sd.z - now.z) > UFO.hostileRadius, "respawned outside its range");

    shutdownAll();
});

test("UFO: leaves when the round ends; a new round schedules new visits", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 100);
    placeUfo(lobby, 0, 14, a.id);

    lobby.round.endsAt = Date.now();

    await waitFor(() => a.eventsOf("us").some((e) => Number.isFinite(e[1].f)), 1000, "told to leave");

    lobby.round.nextAt = Date.now();
    await waitFor(() => a.rounds.some((r) => r.phase === "playing" && r.n === 2), 1000, "next round");

    assert.equal(lobby.ufo, null);
    assert.ok(lobby.ufoDue.length >= 1, "new visits scheduled");

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
    assert.equal(kill[6], "blaster", "with the blaster (for the game log)");
    assert.equal(kill[7], 2500, "worth 2,500");
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

test("clans: pilots with the same [TAG] can't hurt each other; everyone else can", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "[KO]ALPHA");
    const b = await rawClient(server, "[KO]BRAVO");
    const c = await rawClient(server, "[ZZ]CHARLIE");
    const d = await rawClient(server, "DELTA");
    const lobby = quietLobby(server);

    assert.equal(a.welcome.name, "[KO]ALPHA", "tag kept in the name");

    for (const ship of lobby.ships.values()) ship.score = 20000;

    // BRAVO right in front of ALPHA; the others off to the side.
    const where = { a: [0, 0], b: [0, 6], c: [30, 0], d: [-30, 0] };
    const holdAll = (ms) => hold([[a, ...where.a], [b, ...where.b], [c, ...where.c], [d, ...where.d]], ms);

    await holdAll(150);
    unshield(lobby);

    // Bullets, the laser and a rocket at a teammate: nothing.
    a.fire(0, 0, 1.1, 0);
    await holdAll(300);
    a.fire(1, 0, 1.1, 0);
    await holdAll(300);
    a.fire(2, 0, 1.1, 0);
    await holdAll(1500);

    assert.equal(shipOf(lobby, b).hull, 3, "teammate untouched");
    assert.equal(a.eventsOf("sh").filter((e) => e[1] === b.id).length, 0);
    assert.equal(shipOf(lobby, a).score, 20000, "no points for hitting a teammate");

    // A different tag, or none: fair game.
    where.c = [0, 6];
    where.b = [40, 40];
    await holdAll(1500);
    unshield(lobby);
    a.fire(0, 0, 1.1, 0);
    await waitFor(() => a.eventsOf("sh").some((e) => e[1] === c.id), 1500, "hit CHARLIE ([ZZ])");

    where.c = [30, 0];
    where.d = [0, 6];
    await holdAll(1500);
    unshield(lobby);
    a.fire(0, 0, 1.1, 0);
    await waitFor(() => a.eventsOf("sh").some((e) => e[1] === d.id), 1500, "hit DELTA (no tag)");

    // Renaming into the clan doesn't help mid-fight: the new tag only
    // counts from the next respawn.
    const shipD = shipOf(lobby, d);

    d.send({ t: "n", name: "[KO]DELTA" });
    await waitFor(() => shipD.name === "[KO]DELTA", 1000, "renamed");

    const hull = shipD.hull;
    shipD.hitCooldownUntil = 0;
    shipOf(lobby, a).lastFire = [0, 0, 0];
    a.fire(0, 0, 1.1, 0);
    await holdAll(400);
    assert.equal(shipD.hull, hull - 1, "still fair game until respawning");

    // Respawned: a teammate.
    lobby.placeShip(shipD, Date.now());
    await holdAll(300);
    unshield(lobby);
    shipD.hitCooldownUntil = 0;
    shipOf(lobby, a).lastFire = [0, 0, 0];

    a.fire(0, 0, 1.1, 0);
    await holdAll(500);
    assert.equal(shipD.hull, 3, "now a teammate");

    shutdownAll();
});

test("clans: [PASS] can't hurt anyone, and nobody can hurt them", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "[PASS]ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    for (const ship of lobby.ships.values()) ship.score = 20000;

    const where = { a: [0, 0], b: [0, 6] };
    const holdAll = (ms) => hold([[a, ...where.a], [b, ...where.b]], ms);

    await holdAll(150);
    unshield(lobby);

    a.fire(0, 0, 1.1, 0);
    await holdAll(300);
    a.fire(2, 0, 1.1, 0);
    await holdAll(1500);
    assert.equal(shipOf(lobby, b).hull, 3, "[PASS] can't hurt others");

    // The other way round.
    where.a = [0, 6];
    where.b = [0, 0];
    await holdAll(300);
    b.fire(0, 0, 1.1, 0);
    await holdAll(300);
    b.fire(2, 0, 1.1, 0);
    await holdAll(1500);
    assert.equal(shipOf(lobby, a).hull, 3, "and nobody can hurt [PASS]");

    // Asteroids still can.
    unshield(lobby);
    const ship = shipOf(lobby, a);
    lobby.spawnAsteroid(ship.x, ship.z, 1.0, 0, 0);
    await holdAll(300);
    assert.ok(ship.hull < 3, "asteroids still count");

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

test("the rogue asteroid destroys a ship it hits outright; the pilot respawns", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0]], 150);
    unshield(lobby);

    const ship = shipOf(lobby, a);
    assert.equal(ship.hull, 3, "full hull");

    // Sweep it straight across the ship.
    const now = Date.now();
    lobby.rogueSweep({ x: -10, z: 0, dx: 1, dz: 0, destroyed: 0 }, 20, now);

    assert.equal(ship.alive, false, "destroyed in one hit");
    assert.equal(ship.hull, 0);

    await waitFor(() => a.eventsOf("sk").length === 1, 1000, "destroyed event");
    assert.equal(a.eventsOf("sk")[0][5], "rogue", "the rogue asteroid did it");

    await waitFor(() => a.eventsOf("sr").length === 1, 5000, "respawned");
    assert.equal(ship.hull, 3, "back with a full hull");

    // The spawn shield and the warp bubble still protect a ship.
    lobby.rogueSweep({ x: -10, z: ship.z, dx: 1, dz: 0, destroyed: 0 }, 40, Date.now());
    assert.equal(ship.alive, true, "spawn shield");

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

// ---- One pilot per browser ------------------------------------------------

const TOKEN = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

test("same browser again: the old connection is replaced, not a second pilot; score kept", async () => {
    const server = await loadWorker();

    const a1 = await rawClient(server, "ALPHA", { token: TOKEN });
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a1).score = 3000;
    shipOf(lobby, a1).kills = 2;

    const a2 = await rawClient(server, "ALPHA", { token: TOKEN, lobby: a1.welcome.lobby });

    await waitFor(() => a1.closed, 1000, "old connection closed");

    assert.equal(a1.closeCode, 4001, "told it was replaced");
    assert.equal(lobby.ships.size, 2, "two pilots, not three");
    assert.equal(lobby.liveSockets().length, 2);
    assert.equal(a2.welcome.you.sc, 3000, "score carried over");
    assert.equal(a2.welcome.you.k, 2);
    assert.equal(a2.welcome.players.length, 1, "sees only BRAVO");

    await waitFor(() => b.snaps.length > 0 && b.snaps.at(-1).p.length === 2, 1000, "B's snapshots");

    const ids = b.snaps.at(-1).p.map((p) => p[0]).sort();
    assert.deepEqual(ids, [a2.id, b.id].sort(), "the old pilot is gone for others");

    shutdownAll();
});

test("same browser again: works in a full lobby, and a lone player keeps the round", async () => {
    const server = await loadWorker();

    const me = await rawClient(server, "ME", { token: TOKEN });
    const lobby = quietLobby(server);

    shipOf(lobby, me).score = 777;
    const round = lobby.round.n;
    const rock = lobby.spawnAsteroid(5, 5, 1, 0, 0);

    // Alone in the lobby: reconnecting doesn't reset the world.
    const again = await rawClient(server, "ME", { token: TOKEN, lobby: me.welcome.lobby });

    assert.equal(again.welcome.you.sc, 777);
    assert.equal(lobby.round.n, round);
    assert.ok(lobby.asteroids.includes(rock), "same world");

    // Fill the lobby, then reconnect again: still accepted.
    for (let i = 0; i < 19; i++) await rawClient(server, `P${i}`);

    assert.equal(lobby.liveSockets().length, 20);

    const third = await rawClient(server, "ME", { token: TOKEN, lobby: me.welcome.lobby });

    assert.equal(third.welcome.lobby, me.welcome.lobby, "same lobby despite being full");
    assert.equal(lobby.liveSockets().length, 20);

    shutdownAll();
});

test("dropped and back: a pilot alone in a lobby returns to the same lobby, round, score and place", async () => {
    const server = await loadWorker();

    const me = await rawClient(server, "ME", { token: TOKEN });
    const lobbyId = me.welcome.lobby;
    const lobby = server.lobbies()[0].instance;
    const round = lobby.round.startedAt;

    const ship = shipOf(lobby, me);
    ship.score = 23456;
    ship.kills = 3;
    await hold([[me, 30, -20]], 150);

    // The phone locks: the connection drops, and the lobby is empty.
    me.ws.close();
    await waitFor(() => server.lobbies()[0].state.sockets.length === 0, 1000, "left");
    await sleep(200);

    const back = await rawClient(server, "ME", { token: TOKEN, lobby: lobbyId });

    assert.equal(back.welcome.lobby, lobbyId, "same lobby");
    assert.equal(lobby.round.startedAt, round, "same round");

    const again = shipOf(lobby, back);
    assert.equal(again.score, 23456, "score kept");
    assert.equal(again.kills, 3);
    assert.ok(Math.hypot(again.x - 30, again.z + 20) < 12, "back about where it was");

    shutdownAll();
});

test("maps: low orbit first, then alternating every round; sent to everyone; survives a restart", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA", { token: TOKEN });
    const entry = [...server.env.LOBBY.objects.values()][0];
    const lobby = entry.instance;

    assert.equal(a.welcome.round.map, "orbit", "a new lobby starts in low orbit (in the welcome)");

    let previous = lobby.round.map;
    const seen = [previous];

    for (let i = 0; i < 6; i++) {
        lobby.startRound(lobby.round.n + 1, Date.now());
        assert.notEqual(lobby.round.map, previous, "different every round");
        previous = lobby.round.map;
        seen.push(previous);
    }

    assert.deepEqual(seen, ["orbit", "space", "orbit", "space", "orbit", "space", "orbit"]);

    await waitFor(() => a.rounds.some((r) => r.map === previous), 1000, "announced");

    // Saved with the round: a restarted lobby carries on with it.
    lobby.saveResume(Date.now());
    a.ws.close();
    await waitFor(() => entry.state.sockets.length === 0, 1000, "left");

    entry.instance.stopTimer();
    entry.instance = new server.mod.Lobby(entry.state, server.env);
    await entry.state.ready;

    const back = await rawClient(server, "ALPHA", { token: TOKEN, lobby: a.welcome.lobby });
    assert.equal(back.welcome.round.map, previous, "same map after the restart");

    shutdownAll();
});

test("lobby restart (a deploy): pilots who come back within two minutes carry on the same round with their scores", async () => {
    const server = await loadWorker();

    const a = await rawClient(server, "ALPHA", { token: TOKEN });
    const b = await rawClient(server, "BRAVO", { token: "f0e1d2c3b4a5968778695a4b3c2d1e0f" });
    const lobbyId = a.welcome.lobby;
    const entry = [...server.env.LOBBY.objects.values()][0];
    const round = entry.instance.round;

    shipOf(entry.instance, a).score = 31000;
    shipOf(entry.instance, b).score = 9000;
    entry.instance.saveResume(Date.now());

    // Everyone is disconnected and the lobby starts over with nothing
    // in memory.
    a.ws.close();
    b.ws.close();
    await waitFor(() => entry.state.sockets.length === 0, 1000, "disconnected");

    entry.instance.stopTimer();
    entry.instance = new server.mod.Lobby(entry.state, server.env);
    await entry.state.ready;

    const a2 = await rawClient(server, "ALPHA", { token: TOKEN, lobby: lobbyId });
    const b2 = await rawClient(server, "BRAVO", { token: "f0e1d2c3b4a5968778695a4b3c2d1e0f", lobby: lobbyId });

    const lobby = entry.instance;
    assert.equal(a2.welcome.lobby, lobbyId);
    assert.equal(b2.welcome.lobby, lobbyId);
    assert.equal(lobby.round.n, round.n, "same round");
    assert.equal(lobby.round.endsAt, round.endsAt, "same clock");
    assert.equal(shipOf(lobby, a2).score, 31000);
    assert.equal(shipOf(lobby, b2).score, 9000);
    assert.equal(a2.you.sc, 31000, "told their score");

    shutdownAll();
});

test("privacy: an empty lobby's saved round (pilot IDs, scores) is deleted once nobody can come back to it", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA", { token: TOKEN });
    const entry = [...server.env.LOBBY.objects.values()][0];
    const lobby = entry.instance;

    shipOf(lobby, a).score = 1234;
    a.ws.close();
    await waitFor(() => entry.state.sockets.length === 0, 1000, "left");

    const saved = await entry.state.storage.get("resume");
    assert.ok(saved?.scores.some((s) => s[0] === TOKEN), "saved for a quick return");

    // The heartbeat alarm while it can still be resumed: kept, and an
    // alarm set for when it expires.
    await lobby.alarm();
    assert.ok(await entry.state.storage.get("resume"), "kept while it can be resumed");
    assert.ok(entry.state.storage.alarmAt >= saved.savedAt + server.mod._internals.RESUME_GRACE_MS, "checked again when it expires");

    // Expired: gone.
    await lobby.forgetStaleResume(saved.savedAt + server.mod._internals.RESUME_GRACE_MS + 1);
    assert.equal(await entry.state.storage.get("resume"), undefined, "deleted");
    assert.equal(lobby.resume, null);

    shutdownAll();
});

test("same browser back later: joins where the players are, not its old empty lobby", async () => {
    const server = await loadWorker();

    const me = await rawClient(server, "ME", { token: TOKEN });
    const oldLobby = me.welcome.lobby;

    me.ws.close();
    await waitFor(() => server.lobbies()[0].state.sockets.length === 0, 1000, "left");

    // Much later: the empty lobby has been forgotten.
    const lobby = server.lobbies()[0].instance;
    lobby.emptiedAt -= 10 * 60_000;
    if (lobby.resume) lobby.resume.savedAt -= 10 * 60_000;

    for (const e of server.env.MATCHMAKER.objects.values()) {
        for (const l of e.instance.lobbies.values()) l.updatedAt -= 10 * 60_000;
    }

    await waitFor(async () => (await server.matchmakerStats()).length === 0, 1000, "lobby forgotten");

    const other = await rawClient(server, "OTHER");
    assert.notEqual(other.welcome.lobby, oldLobby);

    const back = await rawClient(server, "ME", { token: TOKEN, lobby: oldLobby });

    assert.equal(back.welcome.lobby, other.welcome.lobby, "with the other player");
    assert.equal(back.welcome.players.length, 1);

    shutdownAll();
});

test("client: a replaced tab stops reconnecting, shows ONLINE IN ANOTHER TAB, and can take over again", async () => {
    const server = await loadWorker();

    const status1 = { textContent: "", dataset: {} };

    const tab1 = makeClient(server, "ALPHA", { token: TOKEN, statusElement: status1 });
    await waitFor(() => tab1.isOnline(), 2000, "tab 1 online");

    const tab2 = makeClient(server, "ALPHA", { token: TOKEN });
    await waitFor(() => tab2.isOnline(), 2000, "tab 2 online");

    await waitFor(() => tab1.status === "elsewhere", 1000, "tab 1 replaced");

    assert.equal(tab1.calls.offline, 1);
    assert.equal(status1.textContent, "ONLINE IN ANOTHER TAB");

    // It doesn't fight back on its own.
    await sleep(600);
    assert.equal(tab1.socket, null);
    assert.equal(tab2.isOnline(), true);
    assert.equal(server.lobbies()[0].instance.liveSockets().length, 1);

    // Switching back to tab 1 takes the session back.
    tab1.resumeIfReplaced();

    await waitFor(() => tab1.isOnline(), 2000, "tab 1 back");
    await waitFor(() => tab2.status === "elsewhere", 1000, "tab 2 replaced");

    await sleep(300);
    assert.equal(server.lobbies()[0].instance.liveSockets().length, 1, "never two");

    shutdownAll();
});

// ---- Callsigns ----------------------------------------------------------

test("callsigns: a blocked name on join becomes PILOT-####", async () => {
    const server = await loadWorker();

    const a = await rawClient(server, "FUCK FACE");
    const b = await rawClient(server, "ADMIN");
    const c = await rawClient(server, "maverick");

    assert.match(a.welcome.name, /^PILOT-\d{4}$/);
    assert.match(b.welcome.name, /^PILOT-\d{4}$/);
    assert.equal(c.welcome.name, "MAVERICK");

    shutdownAll();
});

test("callsigns: renames apply live for everyone; bad ones are refused; rate-limited", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    const names = [];

    const listen = (client) => {
        const orig = client.ws.onmessage;
        client.ws.onmessage = ({ data }) => {
            const m = JSON.parse(data);
            if (m.t === "name") names.push({ to: client.welcome.name, ...m });
            orig({ data });
        };
    };

    listen(a);
    listen(b);

    a.send({ t: "n", name: "Goose" });
    await waitFor(() => names.filter((n) => n.name === "GOOSE").length === 2, 1000, "both told");

    assert.equal(shipOf(lobby, a).name, "GOOSE");

    // A reconnect keeps it (stored on the socket).
    const ws = lobby.ctx.getWebSockets().find((s) => s.deserializeAttachment().id === a.id);
    assert.equal(ws.deserializeAttachment().name, "GOOSE");

    // Too soon.
    a.send({ t: "n", name: "ICEMAN" });
    await waitFor(() => names.some((n) => n.rejected === "wait"), 1000, "rate limited");
    assert.equal(shipOf(lobby, a).name, "GOOSE");

    // A blocked name, after the cooldown: only A hears about it.
    shipOf(lobby, a).lastRename = 0;
    names.length = 0;

    a.send({ t: "n", name: "SH1THEAD" });
    await waitFor(() => names.some((n) => n.rejected === "blocked"), 1000, "refused");

    assert.equal(shipOf(lobby, a).name, "GOOSE");
    assert.ok(names.every((n) => n.to === "ALPHA"), "nobody else saw it");

    shutdownAll();
});

test("callsigns (client): setName checks, saves, sends; other pilots update their roster and tag", async () => {
    const server = await loadWorker();

    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");

    await waitFor(() => a.remotes.size === 1 && b.remotes.size === 1, 2000, "rosters");

    const bad = a.setName("f u c k");
    assert.equal(bad.ok, false);
    assert.equal(a.name, "ALPHA");

    const good = a.setName("viper");
    assert.equal(good.ok, true);
    assert.equal(a.name, "VIPER");

    await waitFor(() => b.nameOf(a.selfId) === "VIPER", 1000, "B sees the new name");

    shutdownAll();
});

// ---- All-time leaderboard -----------------------------------------------

function matchmakerOf(server) {
    return server.env.MATCHMAKER.get(server.env.MATCHMAKER.idFromName("global"));
}

test("all-time: keeps the top 10, best first, one entry per player per round", async () => {
    const server = await loadWorker();
    const mm = matchmakerOf(server);

    const entries = [];

    for (let i = 1; i <= 14; i++) {
        entries.push({ key: `k${i}`, name: `P${i}`, color: "#fff", score: i * 1000, kills: i });
    }

    entries.push({ key: "zero", name: "ZERO", color: "#fff", score: 0, kills: 0 });

    let result = await mm.recordScores(entries);

    assert.equal(result.top.length, 10);
    assert.equal(result.top[0].score, 14000);
    assert.equal(result.top[9].score, 5000);
    assert.equal(result.minimum, 5000);
    assert.ok(!result.top.some((r) => r.name === "ZERO"), "zero scores ignored");

    // The same player's same round, higher: replaced, not duplicated.
    result = await mm.recordScores([{ key: "k6", name: "P6", color: "#fff", score: 20000, kills: 9 }]);

    assert.equal(result.top[0].name, "P6");
    assert.equal(result.top.filter((r) => r.name === "P6").length, 1);

    // ...lower: ignored.
    result = await mm.recordScores([{ key: "k6", name: "P6", color: "#fff", score: 1, kills: 0 }]);
    assert.equal(result.top[0].score, 20000);

    // A score below the cut doesn't get in.
    result = await mm.recordScores([{ key: "low", name: "LOW", color: "#fff", score: 100 }]);
    assert.ok(!result.top.some((r) => r.name === "LOW"));

    // The public list has no keys, and it survives a restart.
    server.env.MATCHMAKER.restart("global");

    const top = await matchmakerOf(server).topScores();
    assert.equal(top.length, 10);
    assert.equal(top[0].score, 20000);
    assert.ok(top.every((r) => !("key" in r)), "keys stay private");
});

test("all-time: round end reports everyone and sends the list to the lobby", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 12345;
    shipOf(lobby, b).score = 678;

    lobby.round.endsAt = Date.now();

    let records = null;

    a.ws.onmessage = ((orig) => ({ data }) => {
        const m = JSON.parse(data);
        if (m.t === "records") records = m.top;
        orig({ data });
    })(a.ws.onmessage);

    await waitFor(() => records, 2000, "records message");

    assert.equal(records[0].name, "ALPHA");
    assert.equal(records[0].score, 12345);
    assert.equal(records[0].id, a.id, "this lobby's player marked");
    assert.equal(records[1].id, b.id);

    const response = await server.fetch("http://game.test/api/leaderboard");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.top[0].score, 12345);
    assert.ok(body.top.every((r) => !("key" in r) && !("id" in r)));

    shutdownAll();
});

test("all-time: a player who leaves mid-round still makes the list, once", async () => {
    const token = "fedcba9876543210fedcba9876543210";

    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA", { token });
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    shipOf(lobby, a).score = 5000;

    a.ws.close();
    await waitFor(async () => (await matchmakerOf(server).topScores()).length === 1, 1000, "recorded on leave");

    // Rejoins the same round, scores more, round ends.
    const again = await rawClient(server, "ALPHA", { token, lobby: a.welcome.lobby });
    shipOf(lobby, again).score = 9000;

    lobby.round.endsAt = Date.now();
    await waitFor(async () => (await matchmakerOf(server).topScores())[0]?.score === 9000, 2000, "updated");

    const top = await matchmakerOf(server).topScores();
    assert.equal(top.filter((r) => r.name === "ALPHA").length, 1, "one entry for that round");

    assert.ok(b);
    shutdownAll();
});

test("all-time: a record set elsewhere reaches open games on the next check-in, once", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    const synced = [];
    const orig = a.ws.onmessage;

    a.ws.onmessage = ({ data }) => {
        const m = JSON.parse(data);
        if (m.t === "records") synced.push(m);
        orig({ data });
    };

    // Another lobby's player sets a record (straight to the Matchmaker).
    await matchmakerOf(server).recordScores([
        { key: "elsewhere", name: "ACE", color: "#f00", score: 9999, kills: 0 }
    ]);

    // This lobby's regular 30-second check-in.
    await lobby.alarm();
    await waitFor(() => synced.length === 1, 1000, "sync message");

    assert.equal(synced[0].sync, true);
    assert.equal(synced[0].top[0].name, "ACE");
    assert.ok(!("key" in synced[0].top[0]), "keys stay private");

    // Nothing changed: not sent again.
    await lobby.alarm();
    await sleep(100);
    assert.equal(synced.length, 1);

    // A player joining now gets it in their welcome.
    const b = await rawClient(server, "BRAVO");
    assert.equal(b.welcome.records?.[0]?.score, 9999);

    shutdownAll();
});

test("all-time: the leaderboard endpoint fails softly", async () => {
    const server = await loadWorker();

    server.env.MATCHMAKER.get = () => {
        throw new Error("down");
    };

    const response = await server.fetch("http://game.test/api/leaderboard");

    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).top, []);
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

test("junk and bad numbers never break the lobby", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    quietLobby(server);

    const junk = [
        "not json", "{", "null", "[]",
        JSON.stringify({ t: "s", l: 1, x: "NaN", z: 0, r: 0 }),
        JSON.stringify({ t: "s", l: 1, x: Infinity, z: 0, r: 0 }),
        JSON.stringify({ t: "f", w: 99, x: 0, z: 0, r: 0 }),
        JSON.stringify({ t: "f", w: "laser" }),
        JSON.stringify({ t: "zzz" })
    ];

    for (const m of junk) b.ws.send(m);

    await sleep(300);

    b.state(99999, -99999);
    await hold([[a, 1, 1]], 300);

    const snap = a.snaps.at(-1);
    const bRow = snap.p.find((p) => p[0] === b.id);

    assert.equal(bRow[1], 230, "x clamped to the world");
    assert.equal(bRow[2], -145, "z clamped to the world");
    assert.ok(!a.closed && !b.closed);

    shutdownAll();
});

test("abuse: a flooding connection, or one sending an oversized message, is closed; others play on", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const c = await rawClient(server, "CHARLIE");
    const lobby = quietLobby(server);

    // A burst like the real game's (it never sends more than about 30
    // a second) is fine.
    for (let i = 0; i < 50; i++) a.state(1, 1);
    await sleep(200);
    assert.equal(a.closed, false, "a short burst is fine");

    // Hundreds at once: closed.
    for (let i = 0; i < 500; i++) {
        try { b.state(i % 50, 0); } catch { break; }
    }

    await waitFor(() => b.closed, 2000, "flooder closed");

    // One huge message: closed.
    c.ws.send("x".repeat(10_000));
    await waitFor(() => c.closed, 2000, "oversized closed");

    await hold([[a, 1, 1]], 300);
    assert.equal(a.closed, false);
    assert.equal(lobby.liveSockets().length, 1, "only the honest pilot left");
    assert.ok(a.snaps.length > 0);

    shutdownAll();
});

test("at most 6 connections from one IP address per lobby", async () => {
    const server = await loadWorker();
    server.clientIp = "203.0.113.7";

    const same = [];
    for (let i = 0; i < 6; i++) same.push(await rawClient(server, `P${i}X`));

    const lobby = server.lobbies()[0].instance;
    assert.equal(lobby.liveSockets().length, 6);

    // The seventh is turned away (and not sent off to fill another
    // lobby).
    const extra = rawClient(server, "EXTRA");
    await assert.rejects(extra);
    assert.equal(server.lobbies().length, 1, "no new lobby for it");

    // Someone else is fine.
    server.clientIp = "198.51.100.20";
    const other = await rawClient(server, "OTHER");
    assert.equal(other.welcome.lobby, same[0].welcome.lobby);

    shutdownAll();
});

test("movement: a ship can't move faster than ships fly; a pilot far out of step is put back", async () => {
    const server = await loadWorker({ MOVE_CHECK: "on" });
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);
    const ship = shipOf(lobby, a);

    const start = { x: ship.x, z: ship.z };

    // An honest flight at full warp speed: followed exactly.
    let x = start.x;
    for (let i = 0; i < 10; i++) {
        x += 40 * 0.05;
        a.state(x, start.z);
        await sleep(50);
    }

    assert.ok(Math.abs(ship.x - x) < 0.01, "honest movement accepted");

    // A teleport across the map: only as far as a ship could have gone,
    // and the pilot is told where they really are.
    const before = a.you?.sp;
    a.state(x + 150, start.z);
    await sleep(80);

    assert.ok(ship.x - x < 20, `moved only ${(ship.x - x).toFixed(1)} units`);
    await waitFor(() => a.you?.sp && a.you.sp !== before && Math.abs(a.you.sp[0] - ship.x) < 1, 1000, "put back");

    // Reported speed is capped too (other players' screens use it).
    a.state(ship.x, start.z, 0, { vx: 80, vz: 0 });
    await sleep(30);
    assert.ok(ship.vx <= 45);

    shutdownAll();
});

test("allowed origins: with ALLOWED_ORIGINS set, only those pages can connect", async () => {
    const server = await loadWorker({ ALLOWED_ORIGINS: "https://amaxcon.com, http://localhost:8787" });

    server.origin = "https://amaxcon.com";
    const ok = await rawClient(server, "GOOD");
    assert.ok(ok.welcome);

    // The same site opened as http:// (some browsers don't upgrade).
    server.origin = "http://amaxcon.com";
    const plain = await rawClient(server, "PLAIN");
    assert.ok(plain.welcome);

    // A different port or site is not the same.
    server.origin = "http://localhost:9999";
    await assert.rejects(rawClient(server, "PORT"));

    server.origin = "https://amaxcon.com.evil.example";
    await assert.rejects(rawClient(server, "LOOKALIKE"));

    server.origin = "https://evil.example";
    await assert.rejects(rawClient(server, "BAD"));

    server.origin = null;
    await assert.rejects(rawClient(server, "NOORIGIN"));

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

test("client: a kill shows beside the pilot's name on everyone's leaderboard straight away", async () => {
    const server = await loadWorker();
    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");
    const c = makeClient(server, "CHARLIE");

    await waitFor(() => a.isOnline() && b.isOnline() && c.isOnline(), 2000, "online");

    const lobby = quietLobby(server);
    const frames = (ms) => runFrames([[a, local(a, 0, 0)], [b, local(b, 0, 6)], [c, local(c, 40, 40)]], ms);

    await frames(300);

    const shipA = shipOf(lobby, { id: a.selfId });
    const shipB = shipOf(lobby, { id: b.selfId });

    // Just after a full resync, so only the immediate update can show it.
    await waitFor(() => lobby.stepCount % 30 === 1, 2000, "just after a resync");

    Object.assign(shipB, { hull: 1, shieldUntil: 0, hitCooldownUntil: 0 });
    lobby.damageShip(shipB, 1, shipA, Date.now());

    await frames(300);

    for (const mp of [a, b, c]) {
        const row = mp.standings.find((s) => String(s[0]) === a.selfId);
        assert.deepEqual(row.slice(1, 3), [2700, 1], "score and kill in the standings");
        assert.match(mp.leaderboard.innerHTML, /2,700/, "shown on the board");
    }

    assert.ok(a.leaderboard.innerHTML.indexOf("YOU") < a.leaderboard.innerHTML.indexOf("BRAVO"), "and top of it");

    shutdownAll();
});

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

test("clans (client): teammates are recognized by tag, so your shots pass their ships", async () => {
    const server = await loadWorker();
    const a = makeClient(server, "[KO]ALPHA");
    const b = makeClient(server, "[KO]BRAVO");
    const c = makeClient(server, "CHARLIE");

    await waitFor(() => a.remotes.size === 2 && b.isOnline() && c.isOnline(), 3000, "roster");
    unshield(server.lobbies()[0].instance);

    await runFrames([
        [a, local(a, 0, 0)], [b, local(b, 5, 5)], [c, local(c, -5, 5)]
    ], 600);

    assert.equal(a.isTeammate(b.selfId), true);
    assert.equal(a.isTeammate(c.selfId), false);
    assert.equal(c.isTeammate(a.selfId), false, "no tag: no teammates");

    const ships = a.remoteShipPositions();
    assert.equal(ships.length, 2);
    assert.equal(ships.find((s) => s.id === b.selfId).ally, true);
    assert.equal(ships.find((s) => s.id === c.selfId).ally, false);

    shutdownAll();
});

test("client: a ship inside a warp bubble is flagged (so the radar leaves it off)", async () => {
    const server = await loadWorker();

    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");
    const c = makeClient(server, "CHARLIE");

    await waitFor(() => a.remotes.size === 2 && b.isOnline() && c.isOnline(), 3000, "roster");

    const lobby = server.lobbies()[0].instance;
    unshield(lobby);
    shipOf(lobby, { id: b.selfId }).warpUntil = Date.now() + 5000;

    await runFrames([
        [a, local(a, 0, 0)], [b, local(b, 5, 5)], [c, local(c, -5, 5)]
    ], 600);

    let ships = a.remoteShipPositions();
    assert.equal(ships.find((s) => s.id === b.selfId).warp, true, "warping");
    assert.equal(ships.find((s) => s.id === c.selfId).warp, false, "not warping");

    // Bubble gone: back on the radar.
    shipOf(lobby, { id: b.selfId }).warpUntil = 0;

    await runFrames([
        [a, local(a, 0, 0)], [b, local(b, 5, 5)], [c, local(c, -5, 5)]
    ], 600);

    ships = a.remoteShipPositions();
    assert.equal(ships.find((s) => s.id === b.selfId).warp, false, "bubble over");

    shutdownAll();
});

test("lag compensation: shots are judged against where the shooter saw the target (up to 200 ms back)", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    await hold([[a, 0, 0], [b, 8, 10]], 200);
    lobby.stopTimer();

    const shipA = shipOf(lobby, a);
    const shipB = shipOf(lobby, b);

    // B is at (8, 10) now; A fires straight up the z axis from (0, 0),
    // where B was a moment ago.
    const shoot = (trail, vt) => {
        const now = Date.now();

        lobby.bullets.length = 0;
        unshield(lobby);
        shipA.lastFire = [0, 0, 0];
        shipB.hitCooldownUntil = 0;
        shipB.hull = 3;
        shipB.x = 8; shipB.z = 10; shipB.vx = 0; shipB.vz = 0;
        shipB.stateAt = now;
        shipB.trail = trail.map(([dt, x, z]) => [now - dt, x, z]);

        const shot = { w: 0, x: 0, z: 1.1, r: 0 };
        if (vt !== undefined) shot.vt = now - vt;

        lobby.onFire(shipA, shot, now);
        for (let i = 0; i < 4; i++) lobby.updateBullets(0.1, now);

        return shipB.hull < 3;
    };

    const sawItThere = [[400, 0, 10], [120, 0, 10], [0, 8, 10]];

    assert.equal(shoot(sawItThere), false, "no view time: judged where B is now (a miss)");
    assert.equal(shoot(sawItThere, 150), true, "seen 150 ms ago at (0, 10): a hit");
    assert.equal(shoot(sawItThere, 50), false, "seen 50 ms ago, B had already moved: a miss");

    // No further back than 200 ms.
    const longAgo = [[450, 0, 10], [210, 0, 10], [190, 8, 10], [0, 8, 10]];
    assert.equal(shoot(longAgo, 300), false, "a view from 300 ms ago only counts as 200");
    assert.equal(shoot(longAgo, 205), false, "205 ms also counts as 200");

    // The client sends the time of the picture it shows.
    const mp = makeClient(server, "CHARLIE");
    await waitFor(() => mp.isOnline(), 3000, "online");
    const before = mp.serverNow();
    assert.ok(mp.viewServerTime() < before && mp.viewServerTime() > before - 200, "view time is a little in the past");

    shutdownAll();
});

test("cloak: only from 25,000; a cloaked ship is hidden from others, can't fire, can still be hit; death ends it", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);

    const report = async (ck, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            a.state(3, 4, 0, { ck });
            b.state(-3, 4, 0);
            await sleep(50);
        }
    };

    await report(1, 200);
    unshield(lobby);

    const shipA = shipOf(lobby, a);
    assert.equal(shipA.cloaked, false, "locked below 25,000");
    assert.equal(b.eventsOf("ck").length, 0, "nothing announced while locked");

    shipA.score = 26000;
    await report(1, 300);
    assert.equal(shipA.cloaked, true, "cloaked");

    // Announced once (for the game log): who, never where.
    await waitFor(() => b.eventsOf("ck").length > 0, 2000, "cloak event");
    assert.deepEqual(b.eventsOf("ck"), [["ck", a.id, 1]], "once, though reported many times");

    const row = lobby.snapshotMessage(Date.now()).p.find((p) => p[0] === a.id);
    assert.deepEqual(row.slice(1, 8), [0, 0, 0, 0, 0, 0, 8], "no position, not visible, flag 8");

    // No weapons.
    a.fire(0, 3, 5.1, 0);
    await sleep(30);
    assert.equal(lobby.bullets.length, 0, "can't fire while cloaked");

    // Rockets won't lock on.
    assert.equal(lobby.targetValid({ kind: "s", ref: shipA }, shipOf(lobby, b), Date.now()), false);

    // Still hit; the hit doesn't say where.
    lobby.damageShip(shipA, 1, shipOf(lobby, b), Date.now());
    assert.equal(shipA.hull, 2, "takes damage");

    await waitFor(() => b.eventsOf("sh").length > 0, 2000, "hit event");
    const hit = b.eventsOf("sh")[0];
    assert.equal(hit[4], null, "no position");
    assert.equal(hit[5], null, "no position");

    // Uncloaked: announced, back in view, and can fire.
    await report(0, 200);
    assert.equal(shipA.cloaked, false);

    await waitFor(() => b.eventsOf("ck").length > 1, 2000, "uncloak event");
    assert.deepEqual(b.eventsOf("ck").at(-1), ["ck", a.id, 0]);

    const back = lobby.snapshotMessage(Date.now()).p.find((p) => p[0] === a.id);
    assert.equal(back[7] & 1, 1, "visible again");
    assert.equal(back[1], 3);

    a.fire(0, 3, 5.1, 0);
    await sleep(30);
    assert.equal(lobby.bullets.length, 1, "fires again");

    // Destroyed while cloaked: the cloak goes.
    await report(1, 200);
    assert.equal(shipA.cloaked, true);

    shipA.hitCooldownUntil = 0;
    const announced = b.eventsOf("ck").length;
    lobby.damageShip(shipA, shipA.hull, null, Date.now(), "rogue");
    assert.equal(shipA.cloaked, false, "death ends the cloak");

    // (The kill is logged; no separate "uncloaked".)
    await waitFor(() => b.eventsOf("sk").length > 0, 2000, "kill event");
    assert.equal(b.eventsOf("ck").length, announced, "death isn't announced as uncloaking");

    shutdownAll();
});

test("clans: a new tag counts from the next respawn, even across a reload", async () => {
    const server = await loadWorker();
    const token = "0123456789abcdef0123";
    const a = await rawClient(server, "[KO]ALPHA");
    const d = await rawClient(server, "DELTA", { token });
    const lobby = quietLobby(server);

    d.send({ t: "n", name: "[KO]DELTA" });
    await waitFor(() => shipOf(lobby, d).name === "[KO]DELTA", 1000, "renamed");

    // Reloading the page doesn't switch sides any sooner.
    const again = await rawClient(server, "[KO]DELTA", { token });
    const ship = shipOf(lobby, again);

    assert.equal(again.welcome.cn, "DELTA", "told which tag counts");
    assert.equal(lobby.sameClan(ship, shipOf(lobby, a)), false, "not a teammate yet");

    lobby.placeShip(ship, Date.now());
    assert.equal(lobby.sameClan(ship, shipOf(lobby, a)), true, "after respawning, a teammate");

    shutdownAll();
});

test("presence: a ship that isn't flying can't fire, and stopping takes 3 s to protect it", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);
    const shipB = shipOf(lobby, b);

    // B says it isn't flying (st 0): hidden, and its shots are refused.
    const idle = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            a.state(0, 0);
            b.state(0, 6, Math.PI, { st: 0 });
            await sleep(50);
        }
    };

    await idle(150);
    unshield(lobby);

    b.fire(0, 0, 4.9, Math.PI);
    await sleep(30);
    assert.equal(lobby.bullets.length, 0, "can't fire while not flying");

    const row = lobby.snapshotMessage(Date.now()).p.find((p) => p[0] === b.id);
    assert.equal(row[7] & 1, 0, "not shown");

    // Flying for a moment, then claiming not to be: still hittable.
    b.state(0, 6, Math.PI);
    await sleep(30);
    b.state(0, 6, Math.PI, { st: 0 });
    await sleep(30);

    a.fire(0, 0, 1.1, 0);
    await idle(300);
    assert.equal(shipB.hull, 2, "hit despite switching off");

    // Gone quiet: after 3 s it can't fire from where it was.
    await hold([[a, 0, 0]], 3100);
    shipB.lastFire = [0, 0, 0];
    b.fire(0, 0, 4.9, Math.PI);
    await sleep(30);
    assert.equal(lobby.bullets.filter((x) => x.owner === shipB).length, 0, "silent ship can't fire");

    shutdownAll();
});

test("movement: reporting more often doesn't buy speed", async () => {
    const server = await loadWorker({ MOVE_CHECK: "on" });
    const a = await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);
    const ship = shipOf(lobby, a);

    const x0 = ship.x;
    const dir = x0 > 0 ? -1 : 1;
    const start = Date.now();

    // 18 units every 50 ms (360 units/s), which once got through.
    let x = x0;
    for (let i = 0; i < 10; i++) {
        x += dir * 18;
        a.state(x, ship.z);
        await sleep(50);
    }

    const seconds = (Date.now() - start) / 1000;
    const moved = Math.abs(ship.x - x0);

    assert.ok(moved <= 45 * seconds + 20, `moved ${moved.toFixed(1)} units in ${seconds.toFixed(2)} s`);

    shutdownAll();
});

test("cloak: hits, laser sparks, crystal pickups and warp kills don't give a cloaked ship away", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    const c = await rawClient(server, "CHARLIE");
    const lobby = quietLobby(server);
    const shipA = shipOf(lobby, a);

    shipA.score = 26000;
    shipOf(lobby, b).score = 20000;

    // A cloaked straight ahead of B; C watching from afar.
    const report = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            a.state(0, 20, 0, { ck: 1 });
            b.state(0, 0);
            c.state(40, 40);
            await sleep(50);
        }
    };

    await report(200);
    unshield(lobby);
    assert.equal(shipA.cloaked, true);

    // B's laser hits A.
    b.fire(1, 0, 1.1, 0);
    await report(300);

    assert.equal(shipA.hull, 2, "hit");
    assert.ok(a.eventsOf("lh").length >= 1, "the cloaked pilot sees the spark");
    assert.equal(b.eventsOf("lh").length, 0, "the shooter doesn't");
    assert.equal(c.eventsOf("lh").length, 0, "nor does anyone else");

    assert.ok(a.eventsOf("sh").some((e) => e[1] === a.id && e[4] !== null), "the pilot hears of the hit");
    assert.ok(b.eventsOf("sh").some((e) => e[1] === a.id && e[4] === null), "the shooter: a hit, but not where");
    assert.equal(c.eventsOf("sh").filter((e) => e[1] === a.id).length, 0, "bystanders hear nothing");

    const row = lobby.snapshotMessage(Date.now()).p.find((p) => p[0] === a.id);
    assert.equal(row[10], 3, "snapshots don't show the damage");

    // A takes a crystal.
    lobby.spawnCrystal(0, 20.5);
    await report(200);

    assert.ok(c.eventsOf("cc").some((e) => e[2] === ""), "others see the crystal go...");
    assert.ok(!c.eventsOf("cc").some((e) => e[2] === a.id), "...but not who took it");
    assert.ok(a.eventsOf("cc").some((e) => e[2] === a.id), "the pilot knows");

    // A's warp bubble clears a rock.
    shipA.warpUntil = Date.now() + 5000;
    lobby.spawnAsteroid(0, 22, 0.72, 0, 0);
    await report(200);

    const cleared = c.eventsOf("ad").at(-1);
    assert.ok(cleared, "rock cleared");
    assert.equal(cleared[4], "", "not credited by name");
    assert.ok(shipA.score > 26000 + 500, "still scores");

    shutdownAll();
});

test("pvp points: every hit and kill scores, for everyone (same address too); repeat kills are worth less, never nothing", async () => {
    const server = await loadWorker();

    // Two pilots on one home connection, and two on another.
    server.clientIp = "203.0.113.7";
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");

    server.clientIp = "2001:db8:1:2::10";
    const c = await rawClient(server, "CHARLIE");

    server.clientIp = "2001:0db8:0001:0002:abcd::1";
    const e = await rawClient(server, "ECHO");

    server.clientIp = "198.51.100.20";
    const d = await rawClient(server, "DELTA");

    const lobby = quietLobby(server);
    const [sa, sb, sc, sd, se] = [a, b, c, d, e].map((x) => shipOf(lobby, x));

    const hit = (victim, attacker) => {
        Object.assign(victim, { alive: true, hull: 3, hitCooldownUntil: 0, shieldUntil: 0, warpUntil: 0 });
        const before = attacker.score;
        lobby.damageShip(victim, 1, attacker, Date.now(), null, "blaster");
        return attacker.score - before;
    };

    const kill = (victim, killer) => {
        Object.assign(victim, { alive: true, hull: 1, hitCooldownUntil: 0, shieldUntil: 0, warpUntil: 0 });
        const before = killer.score;
        lobby.damageShip(victim, 1, killer, Date.now(), null, "blaster");
        return killer.score - before;
    };

    assert.equal(hit(sb, sa), 200, "a hit on a pilot at the same address scores");
    assert.equal(kill(sb, sa), 2700, "and so does the kill");
    assert.equal(kill(sc, se), 2700, "same IPv6 network too");

    // Hit + kill: 2700, then half, then a quarter from then on.
    const values = [];
    for (let i = 0; i < 5; i++) values.push(kill(sa, sd));

    assert.deepEqual(values, [2700, 1350, 675, 675, 675]);
    assert.equal(sd.kills, 5, "every kill counts");
    assert.equal(hit(sa, sd), 50, "hits on them: a quarter too");

    assert.equal(kill(sc, sd), 2700, "someone else: full points");

    // The kill event says what it was worth (never "no points").
    await waitFor(() => d.eventsOf("sk").length >= 7, 1000, "kill events");
    assert.ok(d.eventsOf("sk").every((k) => k[7] > 0), "every kill worth something");

    shutdownAll();
});

test("game log: a kill says what weapon did it and what it was worth; other deaths say what got the ship", async () => {
    const server = await loadWorker();
    server.clientIp = "198.51.100.1";
    const a = await rawClient(server, "ALPHA");
    server.clientIp = "198.51.100.2";
    const b = await rawClient(server, "BRAVO");
    const lobby = quietLobby(server);
    const [sa, sb] = [a, b].map((x) => shipOf(lobby, x));

    const lastKill = async () => {
        await waitFor(() => a.eventsOf("sk").length > seen, 1000, "kill event");
        seen = a.eventsOf("sk").length;
        return a.eventsOf("sk").at(-1);
    };
    let seen = 0;

    const ready = (ship, hull = 1) => Object.assign(ship, { alive: true, hull, hitCooldownUntil: 0, shieldUntil: 0, warpUntil: 0 });

    // Laser: full points.
    ready(sb);
    lobby.damageShip(sb, 1, sa, Date.now(), null, "laser");
    let kill = await lastKill();
    assert.deepEqual([kill[2], kill[6], kill[7]], [a.id, "laser", 2500]);

    // Hit with rockets, then finished off by an asteroid: still ALPHA's
    // kill, with rockets (the second kill of BRAVO: half points).
    ready(sb, 2);
    lobby.damageShip(sb, 1, sa, Date.now(), null, "rockets");
    sb.hitCooldownUntil = 0;
    lobby.damageShip(sb, 1, null, Date.now(), "asteroid");
    kill = await lastKill();
    assert.deepEqual([kill[2], kill[5], kill[6], kill[7]], [a.id, "asteroid", "rockets", 1250]);

    // A mine with nobody to credit.
    ready(sa);
    lobby.damageShip(sa, 1, null, Date.now(), "mine");
    kill = await lastKill();
    assert.deepEqual([kill[1], kill[2], kill[5], kill[6], kill[7]], [a.id, "", "mine", "", 0]);

    shutdownAll();
});

test("departed scores: only the best are kept, so the saved round stays small", async () => {
    const server = await loadWorker();
    await rawClient(server, "ALPHA");
    const lobby = quietLobby(server);

    for (let i = 0; i < 250; i++) {
        lobby.departed.set(`token-${i}`, { round: lobby.round.n, score: i, kills: 0, deaths: 0, nextWarp: 10000 });
    }

    lobby.trimDeparted();

    assert.equal(lobby.departed.size, 200);
    assert.equal(Math.min(...[...lobby.departed.values()].map((d) => d.score)), 50, "the lowest went");

    shutdownAll();
});

test("client: connects with wss: except on this computer or the home network", () => {
    const { isLocalHost } = _internals;

    for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "10.0.0.5", "172.20.1.1", "[::1]", "pc.local"]) {
        assert.equal(isLocalHost(host), true, host);
    }

    for (const host of ["amaxcon.com", "www.amaxcon.com", "game.test", "172.32.0.1", "8.8.8.8"]) {
        assert.equal(isLocalHost(host), false, host);
    }
});

test("client: ranks beside names (a new one every 10,000), and a cloaked pilot vanishes from view and the radar", async () => {
    const server = await loadWorker();

    const a = makeClient(server, "ALPHA");
    const b = makeClient(server, "BRAVO");

    await waitFor(() => a.remotes.size === 1 && b.isOnline(), 3000, "roster");

    const lobby = server.lobbies()[0].instance;
    unshield(lobby);

    const shipB = shipOf(lobby, { id: b.selfId });
    shipB.score = 34000;

    let cloaked = false;
    const frames = (ms) => runFrames([
        [a, local(a, 0, 0)], [b, () => local(b, 5, 5, { cloaked })]
    ], ms);

    await frames(1400);

    assert.equal(a.rankOf(b.selfId), 4, "34,000 points: rank 4");
    assert.match(a.leaderboard.innerHTML, /class="lb-lvl"[^>]*>4</, "rank 4 in the list");
    assert.match(a.leaderboard.innerHTML, /class="lb-lvl"[^>]*>1</, "rank 1 for a new pilot");
    assert.equal(a.remotes.get(b.selfId).rank, 4);
    assert.ok(a.remoteShipPositions().some((s) => s.id === b.selfId), "seen");

    cloaked = true;
    await frames(600);

    assert.equal(shipB.cloaked, true);
    assert.ok(!a.remoteShipPositions().some((s) => s.id === b.selfId), "gone from view and the radar");
    assert.equal(a.remotes.get(b.selfId).visual.group.visible, false);

    cloaked = false;
    await frames(600);
    assert.ok(a.remoteShipPositions().some((s) => s.id === b.selfId), "back");

    shutdownAll();
});

test("client: other pilots' ships show their chosen design and damage, and smoke when critical", async () => {
    const server = await loadWorker();

    const made = [];
    const smoke = [];

    const a = makeClient(server, "ALPHA", {
        createShipModel: (design, damage) => {
            made.push([design, damage]);
            const ship = makeShip();
            ship.kind = `${design}:${damage}`;
            return ship;
        },
        smokePoints: () => [[0.5, 0.1, -0.3]],
        spawnSmoke: (x, z) => smoke.push([x, z])
    });
    const b = makeClient(server, "BRAVO");

    await waitFor(() => a.remotes.size === 1 && b.isOnline(), 3000, "roster");
    unshield(server.lobbies()[0].instance);

    const bLife = () => b.calls.online[0].you.lf;
    const frames = (ms) => runFrames([
        [a, { playing: true, x: 0, z: 0, r: 0, life: 1, weapon: 0 }],
        [b, () => ({ playing: true, x: 5, z: 0, r: 0, life: bLife(), weapon: 0, design: 3 })]
    ], ms);

    await frames(500);

    const remote = [...a.remotes.values()][0];
    assert.equal(remote.visual.ship.kind, "3:0", "the Hornet, intact");

    const shipB = shipOf(server.lobbies()[0].instance, { id: b.selfId });

    shipB.hull = 2;
    await frames(300);
    assert.equal(remote.visual.ship.kind, "3:1", "damaged");

    shipB.hull = 1;
    await frames(400);
    assert.equal(remote.visual.ship.kind, "3:2", "critical");
    assert.ok(smoke.length > 0, "smoking");
    assert.ok(remote.visual.group.children.includes(remote.visual.ship), "one ship model in the group");
    assert.equal(a.designOf(b.selfId), 3);

    shutdownAll();
});

test("client: other pilots' ships interpolate, hide when destroyed, show warp", async () => {
    setNetworkDelay(30);

    try {
        const server = await loadWorker();

        const a = makeClient(server, "ALPHA");
        const b = makeClient(server, "BRAVO");

        await waitFor(() => a.remotes.size === 1 && b.isOnline(), 3000, "roster");

        // No spawn shield, so the ship isn't blinking when checked.
        unshield(server.lobbies()[0].instance);

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

        // A stand-in for game.js's background-bending lens.
        const lensCalls = [];
        a.createWarpLens = () => ({
            update: (...args) => lensCalls.push(args),
            dispose: () => {}
        });

        shipB.warpUntil = Date.now() + 5000;
        await runFrames([[a, { playing: true, x: 0, z: 0, r: 0, life: 1, weapon: 0 }], [b, () => ({ playing: true, x, z: 0, r: 0, life: bLife(), weapon: 0 })]], 300);
        assert.equal(remote.visual.bubble.visible, true, "warp bubble shown");
        assert.ok(lensCalls.length > 0 && lensCalls.at(-1)[5] > 0.5, "lens bending around their bubble");

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

// ---- Responsiveness ----------------------------------------------------

test("server sends ship positions 20 times a second, moved on to 'now'", async () => {
    const server = await loadWorker();
    const a = await rawClient(server, "ALPHA");
    const b = await rawClient(server, "BRAVO");
    quietLobby(server);

    // B reports once: at x = 0, moving +x at 10 units/s.
    b.send({ t: "s", l: b.you.lf, x: 0, z: 0, r: 0, vx: 10, vz: 0, th: 1, st: 1, w: 0 });

    const before = a.snaps.length;
    await sleep(1000);

    const rate = a.snaps.length - before;
    assert.ok(rate >= 17, `${rate} snapshots in 1 s`);

    // A snapshot ~150 ms after the report shows B ~1.5 units along.
    a.snaps.length = 0;
    b.send({ t: "s", l: b.you.lf, x: 0, z: 0, r: 0, vx: 10, vz: 0, th: 1, st: 1, w: 0 });
    await sleep(150);

    const row = a.snaps.at(-1).p.find((p) => p[0] === b.id);
    assert.ok(row[1] > 0.8 && row[1] <= 2.05, `x = ${row[1]}`);

    shutdownAll();
});

test("client: sends at once when turning or braking; fewer messages when cruising straight", async () => {
    const server = await loadWorker();
    const a = makeClient(server, "ALPHA");
    await waitFor(() => a.isOnline(), 2000, "online");

    let sent = 0;
    const realSend = a.socket.send.bind(a.socket);
    a.socket.send = (data) => {
        if (JSON.parse(data).t === "s") sent++;
        realSend(data);
    };

    // Frames at exactly 60 fps, counted rather than timed, so the
    // result doesn't depend on how busy the computer running the tests
    // is.
    const frames = async (n, local) => {
        for (let i = 0; i < n; i++) {
            a.update(1 / 60, local());
            if (i % 10 === 9) await sleep(0);
        }
    };

    // Cruising straight at a steady speed (one second).
    let x = 0;
    await frames(60, () => ({ playing: true, x: (x += 10 / 60), z: 0, r: 0, vx: 10, vz: 0, thrust: 1, life: 1, weapon: 0 }));
    const cruising = sent;

    // Turning hard the whole time (one second).
    sent = 0;
    let r = 0;
    await frames(60, () => ({ playing: true, x, z: 0, r: (r += 0.05), vx: 10, vz: 0, thrust: 1, life: 1, weapon: 0 }));
    const turning = sent;

    assert.ok(cruising >= 8 && cruising <= 12, `cruising: ${cruising}/s`);
    assert.ok(turning >= 16 && turning <= 21, `turning: ${turning}/s`);

    // Letting go of the throttle is sent at once (well before 100 ms).
    await frames(8, () => ({ playing: true, x, z: 0, r, vx: 10, vz: 0, thrust: 1, life: 1, weapon: 0 }));
    sent = 0;
    await frames(4, () => ({ playing: true, x, z: 0, r, vx: 10, vz: 0, thrust: 0, life: 1, weapon: 0 }));
    assert.ok(sent >= 1, "thrust change sent within 4 frames (67 ms)");

    shutdownAll();
});

test("client: the smoothing delay adapts to the connection (small when steady, larger when jittery)", async () => {
    try {
        setNetworkDelay(25);

        let server = await loadWorker();
        let a = makeClient(server, "ALPHA");
        let b = makeClient(server, "BRAVO");
        await waitFor(() => a.remotes.size === 1 && b.isOnline(), 8000, "online");
        await runFrames([[a, local(a, 0, 0)], [b, local(b, 5, 5)]], 1500);

        const steady = a.renderDelay();
        assert.ok(steady <= 80, `steady connection: ${steady.toFixed(0)} ms (was 120)`);

        shutdownAll();

        // 20-120 ms per message, like a busy mobile connection.
        setNetworkDelay(() => 20 + Math.random() * 100);

        server = await loadWorker();
        a = makeClient(server, "ALPHA");
        b = makeClient(server, "BRAVO");

        // Joining over a jittery connection can take a retry or two.
        await waitFor(() => a.remotes.size === 1 && b.isOnline(), 8000, "online");
        await runFrames([[a, local(a, 0, 0)], [b, local(b, 5, 5)]], 2000);

        const jittery = a.renderDelay();
        assert.ok(jittery > steady + 30, `jittery connection: ${jittery.toFixed(0)} ms`);
        assert.ok(jittery <= 160);

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
