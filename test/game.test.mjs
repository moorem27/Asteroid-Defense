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
async function loadGame(server, { start = true } = {}) {
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
    activateWarp, deactivateWarp, get warpLens() { return warpLens; },
    getNetworkState,
    fireSelectedWeapon, selectWeapon, checkWeaponUnlocks, createAsteroid,
    ufo, UFO, ufoState, ufoNow,
    get multiplayer() { return multiplayer; }
};
`;

    await writeFile(path.join(dir, "game.js"), source);
    await copyFile(path.join(publicDir, "multiplayer.js"), path.join(dir, "multiplayer.js"));
    await copyFile(path.join(publicDir, "name-filter.js"), path.join(dir, "name-filter.js"));
    await copyFile(path.join(publicDir, "ufo.js"), path.join(dir, "ufo.js"));

    const mod = await import(pathToFileURL(path.join(dir, "game.js")).href);

    const game = { t: mod.__test, dom, server };
    games.push(game);

    // The title screen waits for INSERT COIN; press it once the
    // models have loaded (unless the test wants the title screen).
    if (start) {
        await waitFor(() => !game.t.state.loading, 3000, "models loaded");
        dom.el("start-button").dispatch("click");
    }

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

test("title screen: waits for INSERT COIN; online, the lobby is joined quietly until then", async () => {
    const server = await loadWorker();
    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => !t.state.loading, 3000, "models loaded");
    await waitFor(() => t.multiplayer?.isOnline(), 3000, "lobby joined");
    await play(game, 1500);

    assert.ok(!dom.el("start-screen").classList.contains("hidden"), "title screen still showing");
    assert.ok(!t.state.running, "not playing yet");
    assert.ok(!t.net.active, "not in the shared world yet");
    assert.equal(t.getNetworkState().playing, false, "other pilots don't see this ship yet");

    dom.el("start-button").dispatch("click");
    await play(game, 100);

    assert.ok(dom.el("start-screen").classList.contains("hidden"), "title screen gone");
    assert.ok(t.state.running && t.net.active, "in the shared world");

    stopGames();
});

test("title screen: rounds that end and start while waiting are joined correctly", async () => {
    const server = await loadWorker();
    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => t.multiplayer?.isOnline(), 3000, "lobby joined");
    const lobby = quietLobby(server);

    // Round 1 ends while this player is still on the title screen.
    lobby.round.endsAt = Date.now();
    await play(game, 400);

    // Pressing INSERT COIN during the break shows the results and
    // waits for the next round (no black hole for a ship not in play).
    dom.el("start-button").dispatch("click");
    await play(game, 200);

    assert.ok(dom.el("start-screen").classList.contains("hidden"), "title screen gone");
    assert.ok(!dom.el("round-results").classList.contains("hidden"), "results showing");
    assert.equal(t.state.running, false, "waiting for the next round");
    assert.equal(t.blackHole.active, false);

    // The next round starts by itself.
    lobby.round.nextAt = Date.now();
    await waitFor(async () => {
        await play(game, 50);
        return t.state.running && t.net.round?.n === 2;
    }, 2000, "round 2");

    assert.ok(dom.el("round-results").classList.contains("hidden"));
    // (It may be blinking: new rounds start with the spawn shield.)
    assert.ok(t.player.mesh && !t.net.dead, "ship in play");
    assert.equal(t.getNetworkState().playing, true, "other pilots see it");

    stopGames();
});

test("title screen: a player who waits through a whole round change starts in the new round", async () => {
    const server = await loadWorker();
    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => t.multiplayer?.isOnline(), 3000, "lobby joined");
    const lobby = quietLobby(server);

    lobby.round.endsAt = Date.now();
    await play(game, 300);
    lobby.round.nextAt = Date.now();
    await play(game, 400);

    assert.equal(lobby.round.n, 2);
    assert.ok(!dom.el("start-screen").classList.contains("hidden"), "still on the title screen");

    dom.el("start-button").dispatch("click");
    await play(game, 200);

    assert.ok(t.state.running && t.net.active, "playing");
    assert.equal(t.net.round?.n, 2, "in round 2");
    assert.equal(dom.el("sector").textContent, "02");
    assert.ok(dom.el("round-results").classList.contains("hidden"));

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

test("all-time: passing the record shows it live as NEW RECORD; it resets with the round", async () => {
    const server = await loadWorker();

    const mm = server.env.MATCHMAKER.get(server.env.MATCHMAKER.idFromName("global"));
    await mm.recordScores([{ key: "old", name: "ACE", color: "#ff0000", score: 1000, kills: 0 }]);

    const game = await loadGame(server);
    const { dom } = game;

    await waitFor(() => game.t.net.active, 3000, "online");
    await waitFor(async () => { await play(game, 50); return !dom.el("all-time-best").hidden; }, 2000, "HUD line");

    const line = dom.el("all-time-best");
    const score = dom.el("all-time-score");

    assert.equal(score.textContent, "1,000");
    assert.equal(line.classList.contains("live"), false);

    // Below the record: still the official one.
    const ship = serverShip(game);
    ship.score = 900;
    ship.dirty = true;
    await play(game, 200);

    assert.equal(score.textContent, "1,000");
    assert.equal(line.classList.contains("live"), false);

    // Past it: live.
    ship.score = 1500;
    ship.dirty = true;
    await play(game, 200);

    assert.equal(score.textContent, "1,500");
    assert.equal(line.classList.contains("live"), true);

    // A new round starts at 0: back to the official record (not yet
    // 1,500, since this test skips the round-end report).
    const lobby = quietLobby(server);
    lobby.reportRecords = async () => null;
    lobby.round.endsAt = Date.now();

    await waitFor(async () => { await play(game, 50); return game.t.net.round?.phase === "ended"; }, 3000, "round over");
    assert.equal(line.classList.contains("live"), false, "not live between rounds");

    lobby.round.nextAt = Date.now();
    await waitFor(async () => { await play(game, 50); return game.t.net.round?.n === 2; }, 3000, "round 2");
    await play(game, 200);

    assert.equal(score.textContent, "1,000");
    assert.equal(line.classList.contains("live"), false);

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

test("warp lens: bends the background while the warp is on, follows the ship, then switches off", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t } = game;

    await waitFor(() => t.state.running, 3000, "running");
    await play(game, 200);

    assert.equal(t.warpLens, null, "not created until needed");

    t.activateWarp();
    await play(game, 900);

    const lens = t.warpLens;
    assert.ok(lens, "created");
    assert.equal(lens.mesh.visible, true);
    assert.ok(lens.mesh.material.uniforms.uStrength.value > 0.9, "full strength once grown");
    assert.ok(Math.abs(lens.mesh.position.x - t.player.position.x) < 1e-6, "centered on the ship");
    assert.ok(lens.mesh.material.fragmentShader.includes("uRimStrength"));

    t.deactivateWarp();
    await play(game, 100);

    assert.equal(lens.mesh.visible, false, "off with the warp");

    stopGames();
});

test("reverse jets: fire when slowing down, as strongly as the ship is slowing; reverse unchanged", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");

    // Keyboard steering, quiet world.
    t.state.spawnTimer = 1e9;
    t.state.mineTimer = 1e9;
    t.state.pickupTimer = 1e9;
    dom.key("keydown", "KeyA");
    dom.key("keyup", "KeyA");

    const rt = t.retroThrusters;

    // Full forward thrust: no reverse jets.
    dom.key("keydown", "KeyW");
    await play(game, 900);
    assert.ok(rt.level < 0.05, `cruising: ${rt.level.toFixed(2)}`);

    // Let go: the ship coasts to a stop and the jets fire, then taper
    // off as it slows.
    dom.key("keyup", "KeyW");
    await play(game, 250);

    const early = rt.level;
    assert.ok(early > 0.25 && early < 0.95, `coasting at speed: ${early.toFixed(2)}`);
    assert.equal(t.getNetworkState().thrust, 0, "not sent as reverse");

    await play(game, 900);
    const later = rt.level;
    assert.ok(later < early, `tapering: ${later.toFixed(2)} < ${early.toFixed(2)}`);

    await play(game, 1800);
    assert.ok(rt.level < 0.05, `stopped: ${rt.level.toFixed(2)}`);

    // Braking hard (reverse while moving forward): full.
    dom.key("keydown", "KeyW");
    await play(game, 700);
    dom.key("keyup", "KeyW");
    dom.key("keydown", "KeyS");
    await play(game, 250);
    assert.ok(rt.level > 0.9, `hard brake: ${rt.level.toFixed(2)}`);

    // Holding reverse at full reverse speed: still full, as before.
    await play(game, 1500);
    assert.ok(rt.level > 0.9, `reversing: ${rt.level.toFixed(2)}`);
    assert.equal(t.getNetworkState().thrust, -1);

    // Let go while reversing: slowing from backward motion pushes the
    // ship forward, which these jets can't do, so they go out.
    dom.key("keyup", "KeyS");
    await play(game, 600);
    assert.ok(rt.level < 0.1, `slowing a reverse: ${rt.level.toFixed(2)}`);

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

// ---- UFO visits --------------------------------------------------------

// Run frames until `cond` holds.
async function playUntil(game, cond, ms, label, each = null) {
    const end = Date.now() + ms;

    while (!cond()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
        each?.();
        game.dom.frame();
        await sleep(16);
    }
}

// Put the current visit's hover point at (x, z) and let it settle into
// watching (past materializing).
function settleUfo(t, x, z) {
    const plan = t.ufo.plan;
    const shift = t.ufoNow() - plan.s - 2500;

    plan.s += shift;
    for (const leg of plan.legs) leg[0] += shift;

    plan.legs = [[plan.legs[0][0], x, z]];
    plan.o = 30;
}

test("UFO (solo): visits, shrugs off bullets, lasers and rockets, turns rocks aside, then zooms off", async () => {
    const server = await loadWorker();
    server.down = true;

    // Without ufo.glb a simpler stand-in saucer is drawn.
    globalThis.__missingModels = new Set(["assets/ufo.glb"]);

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");

    globalThis.__missingModels = null;

    t.state.spawnTimer = 1e9;
    t.state.mineTimer = 1e9;
    t.state.pickupTimer = 1e9;
    t.asteroids.length = 0;

    // Visits are scheduled once or twice a match, the first a minute
    // or more in.
    assert.ok(t.ufo.soloDue.length >= 1 && t.ufo.soloDue.length <= 2, "one or two visits");
    assert.ok(t.ufo.soloDue[0] >= 60, "not right away");

    // Bring the first one forward.
    t.ufo.soloDue[0] = t.state.matchTime;
    await play(game, 100);

    assert.ok(t.ufo.plan, "a visit started");
    assert.ok(t.ufo.group.visible, "the saucer is drawn");
    assert.equal(dom.el("message").textContent, "UNIDENTIFIED CRAFT DETECTED");

    const p = t.player.position.clone();
    settleUfo(t, p.x, p.z + 12);
    t.player.velocity.set(0, 0, 0);
    await play(game, 100, () => faceForward(game));

    const s = t.ufoState(t.ufo.plan, t.ufoNow());
    assert.equal(s.phase, "observe");
    assert.ok(s.solid, "shield up");

    const { Vector3 } = await import(pathToFileURL(path.join(here, "fake-three.mjs")).href);

    // A rock right behind it, in the line of fire.
    t.createAsteroid(new Vector3(p.x, 0, p.z + 22), 0.72);
    const behind = t.asteroids.at(-1);
    behind.velocity.set(0, 0, 0);

    const score = t.state.score;

    // Bullets: absorbed.
    t.fireSelectedWeapon();
    await play(game, 600, () => faceForward(game));

    assert.equal(t.bullets.length, 0, "bullet gone");
    assert.ok(t.asteroids.includes(behind), "the rock behind it is untouched");
    assert.ok(t.ufo.hits.length > 0, "the shield lit up where it was hit");
    assert.equal(dom.el("message").textContent, "SHOTS HAVE NO EFFECT");
    assert.equal(t.state.score, score, "no points");

    // Laser: stopped at the shield.
    t.state.score = 20000;
    t.checkWeaponUnlocks();
    t.selectWeapon("laser");
    t.ufo.hits.length = 0;

    t.fireSelectedWeapon();
    await play(game, 300, () => faceForward(game));

    assert.ok(t.asteroids.includes(behind), "the laser didn't reach the rock");
    assert.ok(t.ufo.hits.length > 0, "laser impact on the shield");

    // Rockets: go off against it.
    t.selectWeapon("rockets");
    t.fireSelectedWeapon();
    assert.equal(t.rockets.length, 1, "rocket away");
    await playUntil(game, () => t.rockets.length === 0, 3000, "rocket detonated", () => faceForward(game));
    await play(game, 50, () => faceForward(game));

    assert.ok(t.asteroids.includes(behind), "the rocket didn't get through");
    assert.ok(t.ufo.plan, "still here");

    // Rocks glance off the shield.
    const at = t.ufoState(t.ufo.plan, t.ufoNow());
    t.createAsteroid(new Vector3(at.x + 6, 0, at.z), 0.72);
    const rock = t.asteroids.at(-1);
    rock.velocity.set(-5, 0, 0);

    await play(game, 1200, () => faceForward(game));
    assert.ok(rock.velocity.x > 0, "bounced away");

    // The ship can't fly through it either (and takes no damage).
    const lives = t.state.lives;
    const now = t.ufoState(t.ufo.plan, t.ufoNow());
    t.player.position.set(now.x + 0.5, 0, now.z);
    await play(game, 50);

    const after = t.ufoState(t.ufo.plan, t.ufoNow());
    const gap = Math.hypot(t.player.position.x - after.x, t.player.position.z - after.z);
    assert.ok(gap >= t.UFO.shieldRadius, "pushed outside the shield");
    assert.equal(t.state.lives, lives, "no damage");

    // Time to go: it charges up, then it's gone.
    t.ufo.plan.f = t.ufoNow();
    await play(game, 1000);
    assert.equal(t.ufoState(t.ufo.plan, t.ufoNow()).phase, "charge");

    await playUntil(game, () => !t.ufo.plan, 3000, "gone");
    dom.frame();

    assert.ok(!t.ufo.group.visible, "not drawn any more");
    assert.ok(t.ufo.departLens || t.ufo.streaks.some((x) => x.holder.visible), "left a warp and a streak");

    stopGames();
});

test("UFO (solo): the black hole sends it away", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t } = game;

    await waitFor(() => t.state.running, 3000, "running");

    t.ufo.soloDue[0] = t.state.matchTime;
    await play(game, 100);
    settleUfo(t, t.player.position.x, t.player.position.z + 12);

    t.state.matchTime = 5 * 60;
    await play(game, 100);

    assert.ok(t.blackHole.active, "black hole");
    assert.ok(Number.isFinite(t.ufo.plan.f), "told to leave");

    await playUntil(game, () => !t.ufo.plan, 4000, "gone");

    stopGames();
});

test("UFO (online): the server's visit is drawn, shots are absorbed, and it leaves at round end", async () => {
    const game = await bootOnline();
    const { t } = game;
    const lobby = quietLobby(game.server);

    lobby.asteroids = [];
    lobby.ufoDue = [Date.now()];

    await waitFor(() => t.ufo.plan, 2000, "visit arrives");
    assert.equal(String(t.ufo.plan.w), t.multiplayer.selfId, "it came to watch this pilot");
    assert.ok(t.ufo.net, "on the server's clock");

    await play(game, 100, () => faceForward(game));
    assert.ok(t.ufo.group.visible);

    // Hover it right ahead, as the server sees it too.
    const p = t.player.position;
    settleUfo(t, p.x, p.z + 12);
    lobby.ufo = JSON.parse(JSON.stringify(t.ufo.plan));

    const rock = lobby.spawnAsteroid(p.x, p.z + 22, 0.72, 0, 0);
    serverShip(game).shieldUntil = 0;

    await play(game, 300, () => faceForward(game));

    t.fireSelectedWeapon();
    await play(game, 700, () => faceForward(game));

    assert.ok(lobby.asteroids.includes(rock), "the server's rock is untouched");
    assert.ok(t.ufo.hits.length > 0 || t.ufo.shotNotice, "the shield lit up");

    // The round ends: it leaves (everyone is told).
    lobby.round.endsAt = Date.now();
    await waitFor(() => Number.isFinite(t.ufo.plan?.f) || !t.ufo.plan, 2000, "told to leave");

    stopGames();
});

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
