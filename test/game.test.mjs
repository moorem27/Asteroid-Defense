// Runs the real public/game.js (with stand-ins for Three.js, the
// models and the page) against the real server code, to check the
// game's online and offline flows end to end. Run with: npm test

import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { loadWorker, makeBrowserWebSocket, sleep, waitFor } from "./harness.mjs";
import { installDom } from "./fake-dom.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "../public");

let gameCount = 0;
const games = [];

// Load a fresh copy of game.js (and multiplayer.js) wired to the
// stand-ins and to `server`.
async function loadGame(server) {
    const dom = installDom(path.join(publicDir, "index.html"));

    globalThis.WebSocket = makeBrowserWebSocket(server);

    // The game's fetch("/api/leaderboard") goes to the test server.
    globalThis.fetch = async (url) => {
        if (server.down) throw new Error("offline");
        return server.fetch(new URL(url, "http://game.test").href);
    };

    const dir = path.join(here, ".build", `game-${++gameCount}`);
    await mkdir(dir, { recursive: true });

    let source = await readFile(path.join(publicDir, "game.js"), "utf8");

    const three = pathToFileURL(path.join(here, "fake-three.mjs")).href;
    const gltf = pathToFileURL(path.join(here, "fake-gltf.mjs")).href;

    source = source
        .replace('import * as THREE from "three";', `import * as THREE from ${JSON.stringify(three)};`)
        .replace(
            'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";',
            `import { GLTFLoader } from ${JSON.stringify(gltf)};`
        );

    source += `
export const __test = {
    state, net, player, asteroids, mines, pickups, bullets, rockets,
    weapons, assets, blackHole, warp, LASER_CONFIG,
    retroThrusters, canvas: renderer.domElement, records,
    fireSelectedWeapon, selectWeapon, checkWeaponUnlocks, createAsteroid,
    get multiplayer() { return multiplayer; }
};
`;

    await writeFile(path.join(dir, "game.js"), source);
    await copyFile(path.join(publicDir, "multiplayer.js"), path.join(dir, "multiplayer.js"));
    await copyFile(path.join(publicDir, "name-filter.js"), path.join(dir, "name-filter.js"));

    const mod = await import(pathToFileURL(path.join(dir, "game.js")).href);

    const game = { t: mod.__test, dom, server };
    games.push(game);

    return game;
}

function stopGames() {
    for (const g of games.splice(0)) {
        const mp = g.t.multiplayer;

        if (mp) {
            mp.enabled = false;
            clearTimeout(mp.retryTimer);
            if (mp.socket) mp.abandon(mp.socket);
        }
    }
}

// Run animation frames for `ms` (and an optional per-frame hook).
async function play(game, ms, each = null) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        each?.();
        game.dom.frame();
        await sleep(16);
    }
}

// Keep the ship pointing "up" the screen (+Z) at its position.
function faceForward(game) {
    const { player } = game.t;
    player.rotation = 0;
    player.aim.set(player.position.x, 0, player.position.z + 100);
}

function quietLobby(server) {
    const lobby = server.lobbies()[0].instance;
    lobby.spawnThings = () => {};
    lobby.despawnFarAsteroids = () => {};
    lobby.rogue.timer = 1e9;
    return lobby;
}

function serverShip(game) {
    const lobby = game.server.lobbies()[0].instance;
    const id = game.t.multiplayer.selfId;
    return [...lobby.ships.values()].find((s) => s.id === id);
}

async function bootOnline() {
    const server = await loadWorker();
    const game = await loadGame(server);

    await waitFor(() => game.t.net.active, 3000, "online");
    await play(game, 100);

    return game;
}

// ------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("offline: the solo game boots and plays when the server is unreachable", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");
    await play(game, 1500);

    assert.equal(t.net.active, false);
    assert.equal(dom.el("net-status").textContent, "OFFLINE MODE");
    assert.ok(t.asteroids.length > 0, "solo asteroids spawn");
    assert.ok(t.asteroids.every((a) => a.netId === undefined));
    assert.equal(dom.el("leaderboard").hidden, true);
    assert.notEqual(dom.el("sector-label").textContent, "ROUND");

    stopGames();
});

test("online: joins a lobby, shows ROUND and the 15:00 clock, and mirrors server asteroids", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    assert.match(dom.el("net-status").textContent, /ONLINE/);
    assert.equal(dom.el("sector-label").textContent, "ROUND");
    assert.match(dom.el("match-time").textContent, /^1[45]:\d\d$/);
    assert.equal(dom.el("leaderboard").hidden, false);

    const lobby = quietLobby(server);
    const p = t.player.position;
    const rock = lobby.spawnAsteroid(p.x + 6, p.z + 6, 1.0, 1.5, 0);

    await play(game, 200);

    const mirror = t.asteroids.find((a) => a.netId === rock.id);
    assert.ok(mirror, "server asteroid appears in the game");

    await play(game, 1200);

    assert.ok(Math.abs(mirror.position.x - rock.x) < 0.6, `x ${mirror.position.x} vs ${rock.x}`);
    assert.ok(Math.abs(mirror.position.z - rock.z) < 0.6);

    stopGames();
});

test("online: firing destroys a shared asteroid (server decides) and the score arrives", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);

    // Spawn shield off so nothing else matters; aim straight ahead.
    await play(game, 100, () => faceForward(game));

    const p = t.player.position;
    const rock = lobby.spawnAsteroid(p.x, p.z + 8, 0.72, 0, 0);

    await play(game, 200, () => faceForward(game));

    dom.key("keydown", "Space");
    await play(game, 250, () => faceForward(game));
    dom.key("keyup", "Space");

    await play(game, 500, () => faceForward(game));

    assert.ok(!lobby.asteroids.includes(rock), "destroyed on the server");
    assert.ok(!t.asteroids.some((a) => a.netId === rock.id), "and in the game");
    assert.equal(t.state.score, rock.score);
    assert.equal(dom.el("score").textContent, String(rock.score).padStart(6, "0"));

    stopGames();
});

test("weapons: unlock, switch with keys and the button, rockets only on the trigger", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);
    const ship = serverShip(game);

    assert.equal(dom.el("weapon-switch").hidden, true, "no button with one weapon");

    ship.score = 20000;
    ship.dirty = true;

    await play(game, 200, () => faceForward(game));

    assert.equal(t.weapons.laserUnlocked && t.weapons.rocketsUnlocked, true);
    assert.equal(dom.el("weapon-switch").hidden, false, "button appears");
    assert.equal(t.weapons.selected, "blaster", "selection unchanged by unlocking");

    dom.key("keydown", "Digit3");
    assert.equal(t.weapons.selected, "rockets");
    assert.equal(dom.el("weapon-name").textContent, "ROCKETS");

    dom.el("weapon-switch").dispatch("click");
    assert.equal(t.weapons.selected, "blaster", "button cycles");

    dom.key("keydown", "KeyQ");
    assert.equal(t.weapons.selected, "rockets", "Q cycles back");

    // Nothing fires by itself.
    const p = t.player.position;
    const rock = lobby.spawnAsteroid(p.x, p.z + 12, 1.45, 0, 0);

    await play(game, 1500, () => faceForward(game));
    assert.equal(lobby.rockets.length, 0, "no automatic rockets");

    // The trigger fires one.
    dom.key("keydown", "Space");
    await play(game, 100, () => faceForward(game));
    dom.key("keyup", "Space");

    await waitFor(() => !lobby.asteroids.includes(rock), 3000, "rocket hit");
    await play(game, 200, () => faceForward(game));

    assert.ok(!t.asteroids.some((a) => a.netId === rock.id));

    stopGames();
});

test("PvP: destroyed by another pilot → respawn countdown → back in the fight", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);
    const ship = serverShip(game);

    await play(game, 100);

    // Another pilot (raw) does it, so the kill is credited.
    ship.shieldUntil = 0;
    const killer = lobby.newShip({ id: "killer01", name: "VIPER", color: "#ff0000" }, Date.now());
    lobby.ships.set({ fake: true }, killer);

    lobby.damageShip(ship, 3, killer, Date.now());

    await play(game, 300);

    assert.equal(t.net.dead, true);
    assert.match(dom.el("message").textContent, /DESTROYED BY .* RESPAWN IN [123]/);
    assert.equal(t.player.mesh.visible, false);

    await waitFor(async () => { await play(game, 50); return !t.net.dead; }, 4500, "respawn");

    assert.equal(t.state.lives, 3);
    assert.equal(Math.round(t.player.position.x * 100) / 100, ship.x);

    stopGames();
});

test("round end: black hole finale, results screen, then a fresh round", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);
    serverShip(game).score = 1500;

    lobby.round.endsAt = Date.now();

    await play(game, 300);
    assert.equal(t.blackHole.active, true, "black hole opens");

    await waitFor(async () => {
        await play(game, 50);
        return !dom.el("round-results").classList.contains("hidden");
    }, 8000, "results shown");

    assert.match(dom.el("results-winner").innerHTML, /YOU WIN/);
    assert.match(dom.el("results-list").innerHTML, /1,500/);
    assert.equal(dom.el("match-label").textContent, "NEXT ROUND");

    // Enter between rounds does nothing.
    dom.key("keydown", "Enter");
    assert.equal(t.state.running, false);

    lobby.round.nextAt = Date.now();

    await waitFor(async () => {
        await play(game, 50);
        return t.state.running && t.net.round?.n === 2;
    }, 2000, "round 2");

    await play(game, 300);

    assert.equal(dom.el("round-results").classList.contains("hidden"), true);
    assert.equal(t.state.score, 0);
    assert.equal(t.blackHole.active, false);
    assert.equal(dom.el("sector").textContent, "02");

    stopGames();
});

test("all-time leaderboard: shown at startup, updated at round end, your record highlighted", async () => {
    const server = await loadWorker();

    // An existing record from another day.
    const mm = server.env.MATCHMAKER.get(server.env.MATCHMAKER.idFromName("global"));
    await mm.recordScores([{ key: "old", name: "ACE", color: "#ff0000", score: 1000, kills: 0 }]);

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.net.active, 3000, "online");
    await waitFor(() => !dom.el("all-time-best").hidden, 2000, "HUD line");

    assert.equal(dom.el("all-time-score").textContent, "1,000");
    assert.equal(dom.el("records-start-box").hidden, false);
    assert.match(dom.el("records-start").innerHTML, /ACE/);

    const lobby = quietLobby(server);
    serverShip(game).score = 4321;
    lobby.round.endsAt = Date.now();

    await waitFor(async () => {
        await play(game, 50);
        return dom.el("all-time-score").textContent === "4,321";
    }, 8000, "new record in the HUD");

    await waitFor(async () => {
        await play(game, 50);
        return !dom.el("round-results").classList.contains("hidden");
    }, 8000, "results");

    assert.equal(dom.el("results-record").hidden, false);
    assert.equal(dom.el("results-record").textContent, "NEW ALL-TIME RECORD!");
    assert.match(dom.el("records-results").innerHTML, /rec-you/);
    assert.match(dom.el("records-results").innerHTML, /\(YOU\)/);
    assert.match(dom.el("records-results").innerHTML, /ACE/);

    stopGames();
});

test("all-time leaderboard: hidden (and harmless) when the server is unreachable", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");
    await play(game, 300);

    assert.equal(dom.el("all-time-best").hidden, true);
    assert.equal(dom.el("records-start-box").hidden, true);
    assert.equal(t.records.top.length, 0);

    stopGames();
});

test("callsign: the button opens the box; typing doesn't fly or fire; bad names are refused; good ones apply", async () => {
    const game = await bootOnline();
    const { t, dom } = game;

    const button = dom.el("callsign");
    const dialog = dom.el("callsign-dialog");
    const input = dom.el("callsign-input");
    const form = dom.el("callsign-form");

    assert.equal(button.hidden, false, "button shown");
    assert.match(dom.el("callsign-name").textContent, /^PILOT-\d{4}$/);

    button.dispatch("click");
    assert.equal(dialog.classList.contains("hidden"), false, "box open");
    assert.equal(input.value, dom.el("callsign-name").textContent, "prefilled");

    // Typing W and Space into the box doesn't thrust or fire.
    const typing = { closest: () => input };
    const before = t.bullets.length;

    dom.key("keydown", "KeyW", typing);
    dom.key("keydown", "Space", typing);
    await play(game, 300);

    assert.equal(t.bullets.length, before, "no shots");
    assert.ok(t.player.velocity.length() < 0.5, "no thrust");

    dom.key("keyup", "KeyW", typing);
    dom.key("keyup", "Space", typing);

    // A blocked name: refused with a message, box stays open.
    input.value = "SH1T";
    input.dispatch("input");
    assert.match(dom.el("callsign-error").textContent, /ISN'T ALLOWED/);

    form.dispatch("submit");
    assert.equal(dialog.classList.contains("hidden"), false);

    // A good one: saved, sent, box closes.
    input.value = "iceman";
    input.dispatch("input");
    assert.equal(dom.el("callsign-error").textContent, "");

    form.dispatch("submit");

    assert.equal(dialog.classList.contains("hidden"), true, "box closed");
    assert.equal(dom.el("callsign-name").textContent, "ICEMAN");
    assert.equal(localStorage.getItem("asteroidDefensePilotName"), "ICEMAN");

    await waitFor(async () => {
        await play(game, 50);
        return serverShip(game).name === "ICEMAN";
    }, 2000, "server has it");

    assert.match(dom.el("message").textContent, /CALLSIGN SET: ICEMAN/);

    stopGames();
});

test("connection lost mid-game: carries on solo, then rejoins", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);
    const p = t.player.position;
    lobby.spawnAsteroid(p.x + 10, p.z, 1.0, 0, 0);

    await play(game, 200);

    server.down = true;

    const entry = server.lobbies()[0];
    const ws = entry.state.sockets[0];
    ws.close(1012, "restart");
    entry.instance.removePlayer(ws);

    await play(game, 300);

    assert.equal(t.net.active, false);
    assert.equal(t.state.running, true, "still playing");
    assert.match(dom.el("message").textContent, /OFFLINE MODE/);
    assert.equal(dom.el("net-status").textContent, "OFFLINE MODE");
    assert.ok(t.asteroids.length >= 1 && t.asteroids.every((a) => a.netId === undefined), "rocks kept, now solo");

    // Solo spawning resumes.
    await play(game, 2000);
    assert.ok(t.asteroids.length >= 2);

    server.down = false;

    await waitFor(async () => { await play(game, 50); return t.net.active; }, 8000, "rejoined");

    stopGames();
});

test("solo laser: the drawn beam matches its hit area (range, width, moving rocks)", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t } = game;

    await waitFor(() => t.state.running, 3000, "running");
    await play(game, 100);

    // The beam model was exported centered and 0.2 wide; it must now
    // start at the origin, run 1 unit, and be exactly 2 x halfWidth.
    const { Box3, Vector3 } = await import(pathToFileURL(path.join(here, "fake-three.mjs")).href);
    const box = new Box3().setFromObject(t.assets.laserBeam);
    const size = box.getSize(new Vector3());

    assert.ok(Math.abs(box.min.z) < 1e-9 && Math.abs(box.max.z - 1) < 1e-9, "starts at 0, length 1");
    assert.ok(Math.abs(size.x - t.LASER_CONFIG.halfWidth * 2) < 1e-9, "width matches the hit area");

    // A quiet world.
    t.state.spawnTimer = 1e9;
    t.state.mineTimer = 1e9;
    t.state.pickupTimer = 1e9;
    t.asteroids.length = 0;

    t.state.score = 15000;
    t.checkWeaponUnlocks();
    t.selectWeapon("laser");

    const p = t.player.position.clone();

    const place = (dx, dz, size, vx = 0) => {
        t.createAsteroid(p.clone().add(new Vector3(dx, 0, dz)), size);
        const rock = t.asteroids[t.asteroids.length - 1];
        rock.velocity.set(vx, 0, 0);
        return rock;
    };

    // Solo mode retires rocks ~40 units off screen, so check the reach
    // with a shorter beam: drawn length and hit length are the same
    // setting.
    t.LASER_CONFIG.range = 25;

    const near = place(0, 20, 0.72);
    const beyond = place(0, 30, 0.72);
    const beside = place(4, 20, 0.72);
    // Starts just clear of the beam; solo asteroids are capped at
    // about 5.6 units/s, so it crosses in well under the beam's life.
    const crosser = place(1.5, 12, 0.72, -5.5);

    await play(game, 50, () => faceForward(game));

    t.fireSelectedWeapon();
    await play(game, 250, () => faceForward(game));

    assert.ok(!t.asteroids.includes(near), "rock in the beam destroyed");
    assert.ok(t.asteroids.includes(beyond), "rock past the beam's reach untouched");
    assert.ok(t.asteroids.includes(beside), "rock beside the beam untouched");
    assert.ok(!t.asteroids.includes(crosser), "rock that moved into the visible beam hit");

    // The drawn beam is exactly the configured reach.
    t.LASER_CONFIG.range = 60;

    stopGames();
});

test("solo rockets: none without the trigger; one per trigger pull", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t } = game;

    await waitFor(() => t.state.running, 3000, "running");

    t.state.score = 20000;
    t.checkWeaponUnlocks();
    t.selectWeapon("rockets");

    await play(game, 2500);
    assert.equal(t.rockets.length, 0, "no automatic launches");

    t.fireSelectedWeapon();
    t.fireSelectedWeapon(); // cooldown: still one

    assert.equal(t.rockets.length, 1);

    stopGames();
});

// ---- Touch controls ------------------------------------------------

async function soloGame() {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    await waitFor(() => game.t.state.running, 3000, "running");

    // A quiet world.
    game.t.state.spawnTimer = 1e9;
    game.t.state.mineTimer = 1e9;
    game.t.state.pickupTimer = 1e9;

    return game;
}

function touchEvent(game, type, id, x, y) {
    game.t.canvas.dispatch(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0 });
}

test("mouse controls are unchanged: drag steers toward the cursor, click fires", async () => {
    const game = await soloGame();
    const { t } = game;

    const mouse = (type, x, y) => t.canvas.dispatch(type, {
        pointerId: 9, pointerType: "mouse", clientX: x, clientY: y, button: 0
    });

    // Cursor straight right of center: world +X.
    mouse("pointermove", 1200, 360);
    mouse("pointerdown", 1200, 360);
    mouse("pointermove", 1210, 360);

    await play(game, 800);

    assert.ok(t.player.velocity.x > 5, "flies toward the cursor");
    assert.ok(Math.abs(Math.sin(t.player.rotation) - 1) < 0.2, "faces it");

    mouse("pointerup", 1210, 360);

    t.bullets.length = 0;
    await play(game, 300);

    mouse("pointerdown", 1210, 360);
    mouse("pointerup", 1210, 360);

    assert.equal(t.bullets.length, 1, "click fires");

    stopGames();
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
        console.log(`  ✗ ${name}\n    ${error.stack?.split("\n").slice(0, 5).join("\n    ")}`);
        stopGames();
    }

    await sleep(50);
}

await rm(path.join(here, ".build"), { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);

process.exit(failed ? 1 : 0);
