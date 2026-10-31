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
async function loadGame(server, { start = true, search = "", missingTextures = [], lastMap = null } = {}) {
    // (lastMap: what an older version of the game remembered as this
    // browser's last map; it no longer decides anything.)
    const dom = installDom(path.join(publicDir, "index.html"));
    location.search = search;
    globalThis.__missingTextures = missingTextures;
    if (lastMap) localStorage.setItem("asteroidDefense.lastMap", lastMap);

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
    ships, SHIP_DESIGNS, shipExplosions, smokePuffs, damageSmoke, cycleShip, updateHUD, damagePlayer,
    cloak, MAPS, parallaxMeshes, orbitLimb, launchGame, endGame, GAME_LOG,
    get mapName() { return mapName; },
    get multiplayer() { return multiplayer; }
};
`;

    await writeFile(path.join(dir, "game.js"), source);
    await copyFile(path.join(publicDir, "multiplayer.js"), path.join(dir, "multiplayer.js"));
    await copyFile(path.join(publicDir, "name-filter.js"), path.join(dir, "name-filter.js"));
    await copyFile(path.join(publicDir, "ufo.js"), path.join(dir, "ufo.js"));
    await copyFile(path.join(publicDir, "ranks.js"), path.join(dir, "ranks.js"));

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

async function bootOnline(env = {}) {
    const server = await loadWorker(env);
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
    assert.ok(document.body.classList.contains("results-open"), "HUD steps aside for the results");
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
    assert.ok(!document.body.classList.contains("results-open"), "HUD back");
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

    serverShip(game).score = 4200;
    serverShip(game).dirty = true;

    await play(game, 200);
    assert.equal(t.state.score, 4200);

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
    await play(game, 100);

    // Back in the same round, and it says so; the score survived.
    assert.match(dom.el("message").textContent, /RECONNECTED · ROUND 1 · SCORE KEPT/);
    assert.equal(t.state.score, 4200, "score kept");

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

test("warp lens: on the orbit map it draws the planet's edge too (space past it, not clouds); not in deep space", async () => {
    const server = await loadWorker();
    server.down = true;

    for (const [map, on] of [["orbit", 1], ["space", 0]]) {
        const game = await loadGame(server, { search: `?map=${map}` });
        const { t } = game;

        await waitFor(() => t.state.running && t.parallaxMeshes.length === 3, 3000, "running");

        t.activateWarp();
        await play(game, 300);

        const u = t.warpLens.mesh.material.uniforms;

        assert.ok(t.warpLens.mesh.material.fragmentShader.includes("withOrbitLimb"), "the edge is part of the bend");
        assert.equal(u.uLimbOn.value, on, `edge ${on ? "on" : "off"} in ${map}`);

        // The same settings as the edge on screen (one set, shared).
        assert.equal(u.uLimbSize, t.orbitLimb.material.uniforms.uLimbSize);
        assert.equal(u.uLimbShift, t.orbitLimb.material.uniforms.uLimbShift);

        stopGames();
    }
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

test("UFO (solo): visits, turns rocks aside, destroys you if you shoot it, then zooms off", async () => {
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

    // Leave it alone and it leaves you alone. Shoot it: the shot is
    // absorbed, and a plasma blast destroys the ship at once.
    const score = t.state.score;
    t.player.position.set(p.x, 0, p.z);
    t.player.velocity.set(0, 0, 0);
    await play(game, 50, () => faceForward(game));
    assert.equal(t.state.lives, 3, "untouched so far");

    t.fireSelectedWeapon();
    await play(game, 600, () => faceForward(game));

    assert.equal(t.bullets.length, 0, "bullet gone");
    assert.ok(t.asteroids.includes(behind), "the rock behind it is untouched");
    assert.ok(t.ufo.hits.length > 0, "the shield lit up where it was hit");
    assert.equal(t.state.score, score, "no points");

    assert.equal(t.state.lives, 0, "destroyed in one shot");
    assert.equal(t.state.running, false);
    assert.equal(dom.el("message").textContent, "VAPORIZED BY THE UFO");
    assert.equal(t.shipExplosions.length, 1, "the ship blew up");

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

test("black hole vs. warp bubble: the bubble is dragged in with the ship, strains, and collapses at the horizon", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");

    t.activateWarp();
    await play(game, 700);
    assert.equal(t.warp.active, true);

    // The match ends with the bubble up.
    t.state.matchTime = 5 * 60;
    await play(game, 50);
    assert.ok(t.blackHole.active, "black hole");

    const start = t.player.position.clone();
    let stretched = false;
    let followed = true;
    let collapsedBeforeShip = false;

    await playUntil(game, () => !t.warp.active, 8000, "the bubble gives way", () => {
        if (!t.warp.active) return;

        const g = t.warp.group;

        if (Math.hypot(g.position.x - t.player.position.x, g.position.z - t.player.position.z) > 1e-6) followed = false;
        if (g.scale.z > g.scale.x * 1.2) stretched = true;
    });

    collapsedBeforeShip = Boolean(t.player.mesh);

    assert.ok(t.player.position.distanceTo(start) > 3, "the ship was pulled in");
    assert.ok(followed, "the bubble stayed on the ship (not left behind)");
    assert.ok(stretched, "it strained toward the hole");
    assert.ok(collapsedBeforeShip, "it gave way before the ship was swallowed");
    assert.equal(t.warp.group.visible, false, "gone");
    assert.notEqual(dom.el("message").textContent, "WARP FIELD OFFLINE", "the black hole's messages stay up");

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

test("UFO: a solo visit going on when the game gets online leaves the usual way, not in a blink", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t } = game;
    await waitFor(() => t.state.running, 3000, "running");

    // A solo visit, hovering.
    t.ufo.soloDue = [t.state.matchTime];
    await play(game, 3000);
    assert.equal(t.ufo.phase, "observe");

    // The connection comes through.
    server.down = false;

    const phases = [];
    let online = false;

    await play(game, 9000, () => {
        if (t.net.active) online = true;
        if (online && phases.at(-1) !== t.ufo.phase) phases.push(t.ufo.phase);
    });

    assert.ok(online, "went online");
    assert.ok(phases.includes("charge") && phases.includes("depart"), `charged up and departed (${phases.join(" → ")})`);
    assert.equal(t.ufo.phase, "gone", "and then it's gone");
    assert.equal(t.ufo.group.visible, false);

    stopGames();
});

// ---- Ship designs, damage and explosions ---------------------------

test("ships: pick a design on the title screen (remembered); the ship shows damage as the hull drops", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => !t.state.loading, 3000, "models loaded");

    assert.equal(dom.el("ship-picker-name").textContent, "STARFIGHTER");

    // Next ship with the ▶ button, and again with the arrow key.
    dom.el("ship-picker-next").dispatch("click");
    assert.equal(dom.el("ship-picker-name").textContent, "VIPER");
    dom.key("keydown", "ArrowRight");
    assert.equal(dom.el("ship-picker-name").textContent, "WRAITH");
    dom.key("keydown", "ArrowLeft");
    assert.equal(dom.el("ship-picker-name").textContent, "VIPER");
    assert.match(dom.el("ship-picker-image").getAttribute?.("src") ?? dom.el("ship-picker-image").src ?? "", /viper/);
    assert.equal(localStorage.getItem("asteroidDefenseShip"), "viper", "remembered");

    dom.el("start-button").dispatch("click");
    await play(game, 100);

    assert.equal(t.player.hull.name, "assets/ship_viper.glb", "flying the Viper");

    // Yellow: damaged model.  Red: critical model, smoking.
    t.state.lives = 2;
    t.updateHUD();
    assert.equal(t.player.hull.name, "assets/ship_viper_damaged.glb");

    t.state.lives = 1;
    t.updateHUD();
    assert.equal(t.player.hull.name, "assets/ship_viper_critical.glb");

    t.state.spawnTimer = 1e9;
    t.asteroids.length = 0;
    await play(game, 400);
    assert.ok(t.damageSmoke.puffs.length > 3, "smoking");

    // Repaired (a crystal): back to a whole ship.
    t.state.lives = 3;
    t.updateHUD();
    assert.equal(t.player.hull.name, "assets/ship_viper.glb");

    stopGames();
});

test("ships: a missing design falls back to the starfighter; missing damage models fall back too", async () => {
    const server = await loadWorker();
    server.down = true;

    globalThis.__missingModels = new Set(["assets/ship_hornet.glb", "assets/ship_wraith_critical.glb", "assets/ship_wraith_damaged.glb"]);

    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => !t.state.loading, 3000, "models loaded");
    globalThis.__missingModels = null;

    // Chosen on an earlier visit, but its model is missing now.
    t.ships.selected = 3;
    dom.el("start-button").dispatch("click");
    await play(game, 50);

    assert.equal(t.player.hull.name, "assets/starfighter.glb", "starfighter instead of the missing Hornet");

    t.ships.selected = 0;
    t.cycleShip(1); // Viper
    t.cycleShip(1); // Wraith
    assert.equal(dom.el("ship-picker-name").textContent, "WRAITH");
    t.cycleShip(1); // Hornet is missing: skipped, back to the Starfighter
    assert.equal(dom.el("ship-picker-name").textContent, "STARFIGHTER");

    t.cycleShip(-1); // Wraith
    t.state.lives = 1;
    t.updateHUD();
    assert.equal(t.player.hull.name, "assets/ship_wraith.glb", "no critical model: the intact one");

    stopGames();
});

test("ships: destroyed in a solo game, the ship explodes, then the game-over screen appears", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");

    t.state.lives = 1;
    t.state.damageCooldown = 0;
    t.damagePlayer();

    assert.equal(t.state.running, false);
    assert.equal(t.shipExplosions.length, 1, "big explosion");
    assert.equal(t.player.mesh.visible, false, "ship gone");
    assert.ok(dom.el("game-over").classList.contains("hidden"), "game-over waits for the explosion");

    await play(game, 900);
    assert.ok(t.shipExplosions[0].age > 0.5, "the explosion keeps playing");

    await play(game, 700);
    assert.ok(!dom.el("game-over").classList.contains("hidden"), "then the game-over screen");

    await play(game, 600);
    assert.equal(t.shipExplosions.length, 0, "and it cleans up");

    stopGames();
});

test("ships (online): your design goes to the server; the server shares design and hull", async () => {
    const server = await loadWorker();

    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => !t.state.loading, 3000, "models loaded");
    t.cycleShip(1);
    t.cycleShip(1); // Wraith
    dom.el("start-button").dispatch("click");

    await waitFor(() => t.net.active, 3000, "online");
    await play(game, 400);

    assert.equal(t.getNetworkState().design, 2);
    await waitFor(() => serverShip(game).design === 2, 2000, "server knows the design");

    const lobby = quietLobby(server);
    serverShip(game).hull = 1;

    const snap = lobby.snapshotMessage(Date.now()).p.find((p) => String(p[0]) === t.multiplayer.selfId);
    assert.equal(snap[9], 2, "design in the snapshot");
    assert.equal(snap[10], 1, "hull in the snapshot");

    stopGames();
});

test("solo: a hit from the rogue asteroid destroys the ship outright", async () => {
    const server = await loadWorker();
    server.down = true;

    const game = await loadGame(server);
    const { t, dom } = game;

    await waitFor(() => t.state.running, 3000, "running");
    assert.equal(t.state.lives, 3);

    t.damagePlayer(t.state.lives, "rogue");

    assert.equal(t.state.lives, 0);
    assert.equal(t.state.running, false);
    assert.equal(t.shipExplosions.length, 1, "explosion");
    assert.equal(dom.el("message").textContent, "HIT BY THE ROGUE ASTEROID");

    stopGames();
});

test("radar: shown online (bottom right), hidden in a solo game", async () => {
    const game = await bootOnline();
    const { t, dom } = game;

    await play(game, 200);
    assert.equal(dom.el("radar").hidden, false, "online: radar on");

    stopGames();

    const server = await loadWorker();
    server.down = true;

    const solo = await loadGame(server);
    await waitFor(() => solo.t.state.running, 3000, "running");
    await play(solo, 200);

    assert.equal(solo.dom.el("radar").hidden, true, "solo: no radar");

    stopGames();
});

test("cloak: unlocks at 25,000; C or the button toggles it; the ship turns ghostly, can't fire, and the server hides it", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;

    const lobby = quietLobby(server);
    const ship = serverShip(game);

    assert.equal(dom.el("cloak-toggle").hidden, true, "no button before 25,000");

    dom.key("keydown", "KeyC");
    dom.key("keyup", "KeyC");
    assert.equal(t.cloak.active, false, "locked");

    ship.score = 26000;
    ship.dirty = true;
    await play(game, 200, () => faceForward(game));

    assert.equal(t.cloak.unlocked, true);
    assert.equal(dom.el("cloak-toggle").hidden, false, "button appears");

    const realMaterials = [];
    t.player.hull.traverse((c) => { if (c.isMesh) realMaterials.push(c.material); });

    dom.key("keydown", "KeyC");
    dom.key("keyup", "KeyC");

    assert.equal(t.cloak.active, true, "C cloaks");
    assert.equal(dom.el("cloak-toggle").getAttribute("aria-pressed"), "true");
    assert.equal(t.getNetworkState().cloaked, true);

    const worn = [];
    t.player.hull.traverse((c) => { if (c.isMesh) worn.push(c.material); });
    assert.ok(worn.length > 0 && worn.every((m) => m === t.cloak.material), "the hull wears the cloak");

    await play(game, 300, () => faceForward(game));
    assert.equal(ship.cloaked, true, "server knows");

    // No weapons while cloaked.
    lobby.bullets.length = 0;
    dom.key("keydown", "Space");
    await play(game, 300, () => faceForward(game));
    dom.key("keyup", "Space");

    assert.equal(lobby.bullets.length, 0, "can't fire");
    assert.equal(t.bullets.length, 0, "nothing drawn either");
    assert.equal(dom.el("message").textContent, "WEAPONS OFFLINE WHILE CLOAKED");

    // The button turns it off; the ship's own look comes back.
    dom.el("cloak-toggle").dispatch("click");
    assert.equal(t.cloak.active, false, "button uncloaks");

    const back = [];
    t.player.hull.traverse((c) => { if (c.isMesh) back.push(c.material); });
    assert.deepEqual(back, realMaterials, "materials restored");

    await play(game, 300, () => faceForward(game));
    assert.equal(ship.cloaked, false, "server knows");

    stopGames();
});

test("maps: ?map= chooses deep space or low orbit; orbit adds the atmosphere's edge; missing orbit images fall back to space", async () => {
    const server = await loadWorker();
    server.down = true;

    const files = (t) => t.parallaxMeshes.map((m) => m.userData.layer.file);

    const orbit = await loadGame(server, { search: "?map=orbit" });
    await waitFor(() => orbit.t.parallaxMeshes.length === 3, 3000, "orbit layers");

    assert.equal(orbit.t.mapName, "orbit");
    assert.deepEqual(files(orbit.t).sort(), ["bg_orbit_clouds.png", "bg_orbit_ground.jpg", "bg_orbit_haze.png"]);
    assert.equal(orbit.t.orbitLimb.visible, true, "the atmosphere's edge");
    stopGames();

    const space = await loadGame(server, { search: "?map=space" });
    await waitFor(() => space.t.parallaxMeshes.length === 3, 3000, "space layers");

    assert.equal(space.t.mapName, "space");
    assert.deepEqual(files(space.t).sort(), ["bg_nebula.png", "bg_stars_far.png", "bg_stars_near.png"]);
    assert.equal(space.t.orbitLimb.visible, false);
    stopGames();

    const fallback = await loadGame(server, { search: "?map=orbit", missingTextures: ["bg_orbit_ground.jpg"] });
    await waitFor(() => fallback.t.parallaxMeshes.length === 3, 3000, "fallback layers");

    assert.equal(fallback.t.mapName, "space", "fell back to deep space");
    assert.ok(files(fallback.t).includes("bg_nebula.png"));
    assert.equal(fallback.t.orbitLimb.visible, false);
    stopGames();

    // Solo, no choice in the address: the page always opens in low
    // orbit (even if this browser showed it last time)...
    for (const lastMap of [null, "orbit", "space"]) {
        const g = await loadGame(server, { start: false, lastMap });
        await waitFor(() => g.t.parallaxMeshes.length === 3, 3000, "layers");
        assert.equal(g.t.mapName, "orbit", `opens in low orbit (last time: ${lastMap})`);
        stopGames();
    }

    // ...and each new game switches map: orbit, space, orbit.
    const solo = await loadGame(server);
    const { t } = solo;
    const seen = [];

    for (let i = 0; i < 3; i++) {
        if (i > 0) {
            t.endGame();
            t.launchGame();
        }

        await waitFor(() => t.parallaxMeshes.length === 3 && (i === 0 || t.mapName !== seen.at(-1)), 3000, `game ${i + 1}'s map`);
        seen.push(t.mapName);
    }

    assert.deepEqual(seen, ["orbit", "space", "orbit"]);
    stopGames();
});

test("maps: nothing shows until the lobby's map is known, then only that one (no flash of another)", async () => {
    const server = await loadWorker();

    // A lobby already in its second round (deep space).
    const WS = makeBrowserWebSocket(server);
    const other = new WS("ws://game.test/api/ws?v=2&name=OTHER");

    await waitFor(() => server.lobbies()[0]?.instance.round, 2000, "lobby");
    const lobby = server.lobbies()[0].instance;
    lobby.startRound(2, Date.now());
    assert.equal(lobby.round.map, "space");

    // Still connecting: plain black, nothing loaded.
    server.hang = true;
    globalThis.__textureLoads = [];

    const waiting = await loadGame(server, { start: false });
    await play(waiting, 300);

    assert.equal(waiting.t.parallaxMeshes.length, 0, "no map while connecting");
    assert.equal(globalThis.__textureLoads.filter((u) => u.includes("bg_")).length, 0, "none loaded");
    stopGames();
    server.hang = false;

    // Welcomed on the title screen: the lobby's map, and only that.
    globalThis.__textureLoads = [];

    const game = await loadGame(server, { start: false });
    const { t, dom } = game;

    await waitFor(() => t.mapName === "space" && t.parallaxMeshes.length === 3, 3000, "the lobby's map on the title screen");

    await waitFor(() => !t.state.loading, 3000, "models loaded");
    dom.el("start-button").dispatch("click");
    await waitFor(() => t.net.active, 3000, "online");
    await play(game, 200);

    assert.equal(t.mapName, "space");
    assert.ok(!globalThis.__textureLoads.some((u) => u.includes("bg_orbit")), "low orbit never loaded");

    globalThis.__textureLoads = null;
    other.close();
    stopGames();
});

test("game log: a kill flashes up under the score (who, whom, what weapon), then goes", async () => {
    const game = await bootOnline();
    const { t, dom, server } = game;
    const lobby = server.lobbies()[0].instance;

    t.GAME_LOG.showMs = 600;

    // Another pilot, BRAVO.
    const WS = makeBrowserWebSocket(server);
    const other = new WS("ws://game.test/api/ws?v=2&name=BRAVO");
    await waitFor(() => lobby.ships.size === 2 && t.multiplayer.roster.size === 1, 2000, "BRAVO joined");

    const ships = [...lobby.ships.values()];
    const bravo = ships.find((s) => s.name === "BRAVO");
    const me = ships.find((s) => s !== bravo);

    const log = dom.el("game-log");
    assert.equal(log.hidden, true, "empty: hidden");

    Object.assign(bravo, { hull: 1, shieldUntil: 0, hitCooldownUntil: 0 });
    lobby.damageShip(bravo, 1, me, Date.now(), null, "laser");
    await waitFor(async () => { await play(game, 30); return log.children.length === 1; }, 2000, "logged");

    const text = log.children[0].innerHTML.replace(/<[^>]+>/g, "");
    assert.equal(text, "YOU DESTROYED BRAVO · LASER");
    assert.equal(log.hidden, false);
    assert.match(dom.el("message").textContent, /BRAVO DESTROYED · \+2,500/);

    // The other way round, and then what isn't a pilot.
    Object.assign(me, { hull: 1, shieldUntil: 0, hitCooldownUntil: 0 });
    lobby.damageShip(me, 1, bravo, Date.now(), null, "rockets");
    await waitFor(async () => { await play(game, 30); return log.children.length === 2; }, 2000, "logged");
    assert.equal(log.children[0].innerHTML.replace(/<[^>]+>/g, ""), "BRAVO DESTROYED YOU · ROCKETS", "newest on top");

    // At most 4 lines.
    for (let i = 0; i < 4; i++) {
        Object.assign(bravo, { alive: true, hull: 1, shieldUntil: 0, hitCooldownUntil: 0 });
        lobby.damageShip(bravo, 1, null, Date.now(), "mine");
        await play(game, 40);
    }

    await waitFor(async () => { await play(game, 30); return log.children[0].innerHTML.includes("A MINE DESTROYED"); }, 2000, "mine logged");
    assert.equal(log.children.length, 4, "only the latest 4");

    // Then they go.
    await waitFor(async () => { await play(game, 50); return log.children.length === 0; }, 3000, "faded out");
    assert.equal(log.hidden, true);

    other.close();
    stopGames();
});

test("maps online: everyone gets the lobby's map, and each new round switches to a different one", async () => {
    const game = await bootOnline();
    const { t, server } = game;
    const lobby = server.lobbies()[0].instance;

    const first = lobby.round.map;
    assert.ok(["space", "orbit"].includes(first));
    assert.equal(t.net.round.map, first, "told the map");

    await waitFor(async () => { await play(game, 50); return t.mapName === first && t.parallaxMeshes.length === 3; }, 3000, "showing the lobby's map");
    assert.ok(t.parallaxMeshes.every((m) => t.MAPS[first].layers.includes(m.userData.layer)), "its layers");

    for (let i = 0; i < 3; i++) {
        const before = lobby.round.map;
        lobby.startRound(lobby.round.n + 1, Date.now());
        const after = lobby.round.map;

        assert.notEqual(after, before, "never the same map twice running");

        await waitFor(async () => { await play(game, 50); return t.mapName === after && t.parallaxMeshes.length === 3; }, 3000, "switched");
        assert.ok(t.parallaxMeshes.every((m) => t.MAPS[after].layers.includes(m.userData.layer)), "new layers, old ones gone");
        assert.equal(t.orbitLimb.visible, after === "orbit");
    }

    stopGames();

    // ?map= keeps that map whatever the server picks.
    const server2 = await loadWorker();
    const forced = await loadGame(server2, { search: "?map=space" });
    await waitFor(() => forced.t.net.active, 3000, "online");
    const lobby2 = server2.lobbies()[0].instance;

    for (let i = 0; i < 2; i++) {
        lobby2.startRound(lobby2.round.n + 1, Date.now());
        await play(forced, 200);
        assert.equal(forced.t.mapName, "space");
    }

    stopGames();
});

test("movement check: honest flying at full boost in a warp bubble is never corrected", async () => {
    const game = await bootOnline({ MOVE_CHECK: "on" });
    const { t, dom, server } = game;

    quietLobby(server);
    t.activateWarp();

    let corrections = 0;
    const ship = serverShip(game);
    const original = Object.getOwnPropertyDescriptor(ship, "spawnMoved");
    let value = ship.spawnMoved;
    Object.defineProperty(ship, "spawnMoved", {
        get: () => value,
        set: (v) => { if (v) corrections++; value = v; },
        configurable: true
    });

    const from = { x: t.player.position.x, z: t.player.position.z };
    let travelled = 0;
    let last = { ...from };

    dom.key("keydown", "KeyW");
    dom.key("keydown", "ShiftLeft");

    // Zig-zag about at top speed.
    let turn = 0;
    await play(game, 2500, () => {
        turn += 0.05;
        t.player.aim.set(t.player.position.x + Math.sin(turn) * 50, 0, t.player.position.z + Math.cos(turn) * 50);
        travelled += Math.hypot(t.player.position.x - last.x, t.player.position.z - last.z);
        last = { x: t.player.position.x, z: t.player.position.z };
    });

    assert.ok(travelled > 40, `flew ${travelled.toFixed(0)} units`);

    dom.key("keyup", "KeyW");
    dom.key("keyup", "ShiftLeft");

    if (original) Object.defineProperty(ship, "spawnMoved", original);

    assert.equal(corrections, 0, "never put back");
    assert.ok(Math.hypot(ship.x - t.player.position.x, ship.z - t.player.position.z) < 4, "server keeps up");

    stopGames();
});

test("security headers: the import map's hash matches, and the page loads no scripts from other sites", async () => {
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");

    const html = await readFile(path.join(publicDir, "index.html"), "utf8");
    const headers = await readFile(path.join(publicDir, "_headers"), "utf8");

    const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert.ok(map, "import map found");

    const hash = createHash("sha256").update(map[1]).digest("base64");
    assert.ok(headers.includes(`'sha256-${hash}'`), "public/_headers allows this exact import map");

    const imports = JSON.parse(map[1]).imports;
    for (const [name, url] of Object.entries(imports)) {
        assert.ok(url.startsWith("./"), `${name} is served from this site (${url})`);
    }

    assert.ok(!/<script[^>]+src="https?:/i.test(html), "no scripts from other sites");
    assert.match(headers, /frame-ancestors 'none'/);
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
