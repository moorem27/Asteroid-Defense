// ============================================================
// ASTEROID DEFENSE: MULTIPLAYER SERVER (protocol 2)
// Runs on Cloudflare Workers with two Durable Object classes:
//
//   Matchmaker  One global instance. Keeps a list of open lobbies and
//               how full each one is, and hands every new player a
//               lobby: the fullest one with room (so players end up
//               together), or a new one when they are all full. It also
//               keeps the all-time top 10 (see ALL-TIME LEADERBOARD).
//
//   Lobby       One instance per lobby, up to MAX_PLAYERS players.
//               Owns the shared world: it simulates the asteroids,
//               mines, energy crystals, the rogue asteroid, every
//               bullet, laser and rocket, and every hit, 20 times a
//               second. It runs 15-minute rounds; the highest score
//               wins.
//
// Each player's own ship movement is decided by their browser (so
// flying feels instant) and reported 10 times a second. Everything
// else (what got hit, by whom, the score) is decided here, so every
// player sees the same world and nobody can award themselves points.
//
// Reliability:
//  - The Lobby is the only authority on how many players it has. The
//    Matchmaker's counts are a hint; if a lobby turns out to be full,
//    the Worker asks again for another.
//  - Lobbies re-report their player count every 30 seconds; the
//    Matchmaker forgets lobbies it hasn't heard from in two minutes.
//  - Every message from a player is size-checked, rate-limited and
//    validated. A bad message is dropped; it never crashes the lobby.
//    The simulation step is wrapped so one bad frame can't stop it.
//  - A player who drops and reconnects within the same round goes back
//    to the same lobby and keeps their score.
//  - The game never depends on the server: if it can't be reached, the
//    browser plays the original solo game in offline mode.
// ============================================================

import { DurableObject } from "cloudflare:workers";

// Callsign rules, shared with the game (public/name-filter.js).
import { checkName, randomCallsign } from "../public/name-filter.js";

// Must match PROTOCOL_VERSION in public/multiplayer.js.
const PROTOCOL_VERSION = 2;

const MAX_PLAYERS = 20;

// ---- Timing -------------------------------------------------------

// Simulation step (20 per second), ship snapshots every 2 steps
// (10 per second), full world resync every second.
const SIM_MS = 50;
const SNAPSHOT_EVERY = 2;
const WORLD_SYNC_EVERY = 20;

const ROUND_MS = 15 * 60 * 1000;

// Between rounds: long enough for the black hole finale and the
// results screen.
const INTERMISSION_MS = 22_000;

// ---- Lobby housekeeping --------------------------------------------

const HEARTBEAT_MS = 30_000;
const LOBBY_EXPIRY_MS = 120_000;
const RESERVATION_MS = 15_000;
const STALE_MS = 120_000;

const MAX_MESSAGE_BYTES = 2048;
const RATE_CAPACITY = 50;
const RATE_PER_SECOND = 35;

const MATCHMAKER_NAME = "global";

// A player can change their callsign at most this often.
const RENAME_COOLDOWN_MS = 3000;

// ---- All-time leaderboard ---------------------------------------------

// How many all-time scores are kept and shown.
const RECORDS_SIZE = 10;

// GET /api/leaderboard answers are cached at Cloudflare's edge for this
// many seconds, so page loads rarely reach the Matchmaker.
const RECORDS_CACHE_SECONDS = 30;

const PLAYER_COLORS = [
    "#ff5ec8", "#ffd84a", "#7dff6b", "#ff8a3d", "#b18cff",
    "#4dd2ff", "#ff4f6d", "#c6ff3d", "#ffa6e1", "#5cffc9",
    "#ffb84d", "#8fa8ff", "#ff6be6", "#e8ff8a", "#6bffea",
    "#ff9d7a", "#d1a6ff", "#9dff9d", "#ffe0a6", "#a6f0ff"
];

// ---- World (matches game.js) ----------------------------------------

const HALF_W = 230;
const HALF_H = 145;

const SHIP = {
    radius: 0.85,
    hull: 3,
    respawnMs: 3000,
    // Can't be hurt for this long after (re)spawning...
    spawnShieldMs: 3000,
    // ...or for this long after taking a hit.
    hitCooldownMs: 1500,
    // A ship that reports nothing for this long is treated as absent
    // (no collisions, nothing spawned for it).
    presentMs: 3000,
    // How far a reported shot origin may be from where the server
    // thinks the ship is.
    maxShotOffset: 6
};

const WEAPON = { BLASTER: 0, LASER: 1, ROCKETS: 2 };

const BULLET = {
    speed: 31,
    life: 1.15,
    radius: 0.2,
    cooldownMs: 130,
    shipDamage: 1
};

const LASER = {
    unlockScore: 15000,
    cooldownMs: 800,
    range: 60,
    halfWidth: 0.3,
    life: 0.16,
    asteroidDamage: 2,
    shipDamage: 1
};

const ROCKET = {
    unlockScore: 20000,
    cooldownMs: 1400,
    speed: 15,
    turnRate: 3.2,
    life: 3.2,
    contactRadius: 0.35,
    blastRadius: 4.5,
    shipDamage: 2,
    seekRange: 40,
    seekCone: 1.2
};

const POINTS = {
    mine: 250,
    crystal: 500,
    shipHit: 200,
    shipKill: 2500
};

const WARP = {
    scoreInterval: 10000,
    durationMs: 15000,
    radius: 7
};

const ASTEROIDS = {
    // Each player has a few asteroids around them: rarer than the
    // solo game, which allows up to 24 on one screen.
    nearRadius: 45,
    baseTarget: 4,
    maxTarget: 7,
    // One more per player every this many minutes into the round.
    rampMinutes: 3,
    globalCapBase: 10,
    globalCapPerPlayer: 4,
    globalCapMax: 70,
    spawnDistance: [24, 30],
    spawnDelay: [1.2, 2.5],
    despawnDistance: 95,
    maxSpeed: 12
};

const MINES = {
    life: 16,
    radius: 0.8,
    spawnDelay: [12, 18],
    nearRadius: 45
};

const CRYSTALS = {
    life: 12,
    radius: 0.9,
    dropChance: 0.11,
    spawnDelay: [15, 25],
    spawnDistance: [9, 13]
};

const ROGUE = {
    firstDelay: [60, 180],
    interval: [90, 240],
    warningMs: 1400,
    speed: 34,
    radius: 1.6,
    leadIn: 38,
    travel: 80
};

// ============================================================
// WORKER ENTRY POINT
// ============================================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === "/api/ws") {
            return handleJoin(request, env, url);
        }

        if (url.pathname === "/api/leaderboard") {
            return handleLeaderboard(request, env, ctx, url);
        }

        if (url.pathname === "/api/health") {
            return Response.json({ ok: true, protocol: PROTOCOL_VERSION });
        }

        if (url.pathname.startsWith("/api/")) {
            return new Response("Not found", { status: 404 });
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not found", { status: 404 });
    }
};

const LOBBY_ID_PATTERN = /^lobby-[0-9a-f-]{36}$/;

// The all-time top 10, for the start screen and HUD. Cached briefly at
// the edge, so thousands of page loads cost only a few Matchmaker
// requests. (The cache only works on a custom domain; on workers.dev
// every request goes to the Matchmaker, which is still cheap.)
async function handleLeaderboard(request, env, ctx, url) {
    if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
    }

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(`${url.origin}/api/leaderboard`);

    try {
        if (cache) {
            const cached = await cache.match(cacheKey);
            if (cached) return cached;
        }

        const matchmaker = env.MATCHMAKER.get(
            env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        const top = await matchmaker.topScores();

        const response = Response.json(
            { top },
            { headers: { "Cache-Control": `public, max-age=${RECORDS_CACHE_SECONDS}` } }
        );

        if (cache && ctx?.waitUntil) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
        }

        return response;
    } catch (error) {
        console.error("Leaderboard failed:", error);
        return Response.json({ top: [] }, { status: 503 });
    }
}

async function handleJoin(request, env, url) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    if (url.searchParams.get("v") !== String(PROTOCOL_VERSION)) {
        return new Response("Protocol version mismatch", { status: 409 });
    }

    if (env.ALLOWED_ORIGINS) {
        const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
        const origin = request.headers.get("Origin");

        if (!origin || !allowed.includes(origin)) {
            return new Response("Origin not allowed", { status: 403 });
        }
    }

    // A player reconnecting asks to go back to the lobby they were in.
    const wanted = url.searchParams.get("lobby");
    const preferred = wanted && LOBBY_ID_PATTERN.test(wanted) ? wanted : null;

    try {
        const matchmaker = env.MATCHMAKER.get(
            env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        const tried = [];

        for (let attempt = 0; attempt < 3; attempt++) {
            const lobbyId = await matchmaker.assign(
                tried,
                attempt === 0 ? preferred : null
            );

            const headers = new Headers(request.headers);
            headers.set("X-Lobby-Id", lobbyId);

            const lobby = env.LOBBY.get(env.LOBBY.idFromName(lobbyId));
            const response = await lobby.fetch(
                new Request(request.url, { headers })
            );

            if (response.status === 101) {
                return response;
            }

            tried.push(lobbyId);

            if (response.status === 503) {
                await matchmaker.report(lobbyId, MAX_PLAYERS).catch(() => {});
            }
        }

        return new Response("No lobby available", { status: 503 });
    } catch (error) {
        console.error("Join failed:", error);
        return new Response("Server unavailable", { status: 503 });
    }
}

// ============================================================
// MATCHMAKER
// ============================================================

export class Matchmaker extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);

        this.lobbies = new Map();

        // All-time top scores, best first:
        // { key, name, color, score, kills, at }
        this.records = [];

        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get("lobbies");

            if (saved && typeof saved === "object") {
                for (const [id, entry] of Object.entries(saved)) {
                    this.lobbies.set(id, entry);
                }
            }

            const records = await ctx.storage.get("records");

            if (Array.isArray(records)) {
                this.records = records;
            }
        });
    }

    // ---------------------------------------------------------
    // ALL-TIME LEADERBOARD
    // Lobbies report scores at the end of every round, and when a
    // player leaves mid-round. Only scores calculated by the server
    // are reported, so nobody can submit a fake one. Each entry has a
    // key for one player's one round; a later report for the same
    // player and round (e.g. they left, rejoined and finished) replaces
    // it if higher. Called only by Lobby objects, never by browsers.
    // ---------------------------------------------------------

    // entries: [{ key, name, color, score, kills }]
    // Returns the top list (with keys, for the lobby to match its own
    // players) and the score needed to get onto it.
    async recordScores(entries) {
        let changed = false;

        for (const entry of Array.isArray(entries) ? entries.slice(0, 40) : []) {
            const score = Math.floor(Number(entry?.score));

            if (!(score > 0) || typeof entry.key !== "string") continue;

            const record = {
                key: entry.key.slice(0, 120),
                name: String(entry.name ?? "PILOT").slice(0, 16),
                color: typeof entry.color === "string" ? entry.color.slice(0, 9) : "#ffffff",
                score,
                kills: Math.max(0, Math.floor(Number(entry.kills) || 0)),
                at: Date.now()
            };

            const existing = this.records.find((r) => r.key === record.key);

            if (existing) {
                if (record.score > existing.score) {
                    Object.assign(existing, record);
                    changed = true;
                }

                continue;
            }

            if (this.records.length < RECORDS_SIZE || score > this.minimumScore()) {
                this.records.push(record);
                changed = true;
            }
        }

        if (changed) {
            // Best first; ties go to whoever got there first.
            this.records.sort((a, b) => b.score - a.score || a.at - b.at);
            this.records.length = Math.min(this.records.length, RECORDS_SIZE);

            await this.ctx.storage.put("records", this.records);
        }

        return { top: this.records, minimum: this.minimumScore() };
    }

    // The public list (no keys).
    async topScores() {
        return this.records.map(publicRecord);
    }

    // The score to beat to get onto the list.
    minimumScore() {
        return this.records.length < RECORDS_SIZE
            ? 0
            : this.records[this.records.length - 1].score;
    }

    async assign(exclude = [], preferred = null) {
        const now = Date.now();
        this.prune(now);

        const skip = new Set(Array.isArray(exclude) ? exclude : []);

        let bestId = null;

        // Back to the same lobby if it still has room.
        if (
            typeof preferred === "string" &&
            !skip.has(preferred) &&
            this.lobbies.has(preferred) &&
            this.load(this.lobbies.get(preferred), now) < MAX_PLAYERS
        ) {
            bestId = preferred;
        }

        if (!bestId) {
            let bestLoad = -1;

            for (const [id, entry] of this.lobbies) {
                if (skip.has(id)) continue;

                const load = this.load(entry, now);

                if (load < MAX_PLAYERS && load > bestLoad) {
                    bestId = id;
                    bestLoad = load;
                }
            }
        }

        if (!bestId) {
            bestId = `lobby-${crypto.randomUUID()}`;

            this.lobbies.set(bestId, {
                count: 0,
                reserved: 0,
                reservedAt: now,
                updatedAt: now
            });
        }

        const entry = this.lobbies.get(bestId);

        if (now - entry.reservedAt > RESERVATION_MS) {
            entry.reserved = 0;
        }

        entry.reserved += 1;
        entry.reservedAt = now;

        await this.save();

        return bestId;
    }

    async report(lobbyId, count) {
        if (typeof lobbyId !== "string" || !LOBBY_ID_PATTERN.test(lobbyId)) {
            return;
        }

        const now = Date.now();

        if (!(count > 0)) {
            this.lobbies.delete(lobbyId);
        } else {
            this.lobbies.set(lobbyId, {
                count: Math.min(MAX_PLAYERS, Math.floor(count)),
                reserved: 0,
                reservedAt: now,
                updatedAt: now
            });
        }

        this.prune(now);
        await this.save();
    }

    async stats() {
        const now = Date.now();
        this.prune(now);

        return [...this.lobbies].map(([id, entry]) => ({
            id,
            count: entry.count,
            load: this.load(entry, now)
        }));
    }

    load(entry, now) {
        const reserved = now - entry.reservedAt > RESERVATION_MS
            ? 0
            : entry.reserved;

        return entry.count + reserved;
    }

    prune(now) {
        for (const [id, entry] of this.lobbies) {
            if (now - entry.updatedAt > LOBBY_EXPIRY_MS) {
                this.lobbies.delete(id);
            }
        }
    }

    async save() {
        await this.ctx.storage.put("lobbies", Object.fromEntries(this.lobbies));
    }
}

// ============================================================
// LOBBY
// ============================================================

export class Lobby extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);

        this.lobbyId = null;

        // ws -> ship (rebuilt from the socket attachment if missing)
        this.ships = new Map();

        // Scores of players who dropped this round, by token, so a
        // reconnect keeps its score.
        this.departed = new Map();

        this.timer = null;
        this.lastStepAt = 0;
        this.stepCount = 0;
        this.lastStaleCheck = 0;

        // The score needed to reach the all-time top 10, as last heard
        // from the Matchmaker. Players who leave below it aren't
        // reported, which saves a request.
        this.recordMinimum = 0;

        this.resetWorld();
        this.round = null;
    }

    // ---------------------------------------------------------
    // CONNECTIONS
    // ---------------------------------------------------------

    async fetch(request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Expected a WebSocket upgrade", { status: 426 });
        }

        const lobbyId = request.headers.get("X-Lobby-Id");

        if (lobbyId && !this.lobbyId) {
            this.lobbyId = lobbyId;
            await this.ctx.storage.put("lobbyId", lobbyId);
        }

        // Capacity check and accept with no await in between.
        const sockets = this.ctx.getWebSockets();

        if (sockets.length >= MAX_PLAYERS) {
            return new Response("Lobby full", { status: 503 });
        }

        const now = Date.now();

        // First player into an empty lobby: a fresh world and round.
        if (sockets.length === 0) {
            this.resetWorld();
            this.departed.clear();
            this.round = null;
            this.ships.clear();
        }

        if (!this.round) {
            this.startRound(1, now, false);
        }

        const url = new URL(request.url);
        const name = sanitizeName(url.searchParams.get("name"));
        const token = sanitizeToken(url.searchParams.get("token"));

        const usedColors = new Set();
        const usedIds = new Set();

        for (const ws of sockets) {
            const info = readAttachment(ws);

            if (info) {
                usedColors.add(info.color);
                usedIds.add(info.id);
            }
        }

        let id;
        do {
            id = crypto.randomUUID().slice(0, 8);
        } while (usedIds.has(id));

        const color =
            PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[0];

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ id, name, color, token });

        const ship = this.newShip({ id, name, color, token }, now);

        // Same player back in the same round: restore their score.
        const previous = token ? this.departed.get(token) : null;

        if (previous && previous.round === this.round.n) {
            ship.score = previous.score;
            ship.kills = previous.kills;
            ship.deaths = previous.deaths;
            ship.nextWarp = previous.nextWarp;
            this.departed.delete(token);
        }

        // Start near other pilots, so the lobby feels like a lobby.
        const anchor = this.randomPresentShip();
        const spawn = this.chooseSpawn(anchor?.x ?? 0, anchor?.z ?? 0, now);

        ship.x = spawn.x;
        ship.z = spawn.z;

        this.ships.set(server, ship);

        const players = [];

        for (const ws of this.ctx.getWebSockets()) {
            const info = readAttachment(ws);
            if (info && ws !== server) {
                players.push({ id: info.id, name: info.name, color: info.color });
            }
        }

        safeSend(server, {
            t: "welcome",
            v: PROTOCOL_VERSION,
            id,
            name,
            color,
            max: MAX_PLAYERS,
            lobby: this.lobbyId,
            now,
            players,
            round: this.roundInfo(),
            you: this.youInfo(ship, true),
            world: this.worldMessage(now)
        });

        this.broadcast({ t: "join", p: { id, name, color } }, server);

        this.startTimer();

        this.reportCount().catch(() => {});
        this.ensureAlarm().catch(() => {});

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        try {
            this.handleMessage(ws, message);
        } catch (error) {
            console.error("Message error:", error);
        }
    }

    async webSocketClose(ws) {
        this.removePlayer(ws);

        try {
            ws.close(1000, "Goodbye");
        } catch {
            // Already closed.
        }

        await this.reportCount().catch(() => {});
    }

    async webSocketError(ws) {
        this.removePlayer(ws);
        await this.reportCount().catch(() => {});
    }

    async alarm() {
        if (!this.lobbyId) {
            this.lobbyId = (await this.ctx.storage.get("lobbyId")) ?? null;
        }

        this.dropStaleSockets(Date.now());

        await this.reportCount().catch(() => {});

        if (this.ctx.getWebSockets().length > 0) {
            await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
        }
    }

    removePlayer(ws) {
        const ship = this.ships.get(ws) ?? null;
        const info = readAttachment(ws);

        this.ships.delete(ws);

        // A player leaving mid-round still gets their score onto the
        // all-time list.
        if (ship && this.round?.phase === "playing" && ship.score > this.recordMinimum) {
            this.reportRecords([ship]).catch(() => {});
        }

        if (ship && ship.token && this.round) {
            this.departed.set(ship.token, {
                round: this.round.n,
                score: ship.score,
                kills: ship.kills,
                deaths: ship.deaths,
                nextWarp: ship.nextWarp
            });
        }

        // Its rockets disappear with it.
        if (ship) {
            this.rockets = this.rockets.filter((r) => r.owner !== ship);
            this.bullets = this.bullets.filter((b) => b.owner !== ship);
            this.beams = this.beams.filter((b) => b.owner !== ship);

            for (const other of this.ships.values()) {
                if (other.lastHitBy === ship) other.lastHitBy = null;
            }
        }

        if (info) {
            this.broadcast({ t: "leave", id: info.id }, ws);
        }

        const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);

        if (remaining.length === 0) {
            this.stopTimer();
        }
    }

    dropStaleSockets(now) {
        for (const ws of this.ctx.getWebSockets()) {
            const ship = this.getShip(ws);

            if (ship && now - ship.lastSeen > STALE_MS) {
                try {
                    ws.close(4000, "Timed out");
                } catch {
                    // Already gone.
                }

                this.removePlayer(ws);
            }
        }
    }

    // After a restart the in-memory ship list is empty, but the
    // sockets (and their attachments) are still there.
    getShip(ws) {
        let ship = this.ships.get(ws);

        if (!ship) {
            const info = readAttachment(ws);
            if (!info) return null;

            const now = Date.now();

            if (!this.round) this.startRound(1, now, false);

            ship = this.newShip(info, now);
            this.ships.set(ws, ship);
        }

        return ship;
    }

    newShip(info, now) {
        return {
            id: info.id,
            name: info.name,
            color: info.color,
            token: info.token ?? null,

            x: 0,
            z: 0,
            r: 0,
            vx: 0,
            vz: 0,
            th: 0,
            st: 0,
            weapon: 0,
            stateAt: now,

            // Increases on every (re)spawn; position reports from an
            // older life are ignored.
            life: 1,
            alive: true,
            hull: SHIP.hull,
            respawnAt: 0,
            shieldUntil: now + SHIP.spawnShieldMs,
            hitCooldownUntil: 0,
            warpUntil: 0,

            score: 0,
            kills: 0,
            deaths: 0,
            nextWarp: WARP.scoreInterval,

            lastHitBy: null,
            lastHitAt: 0,

            lastFire: [0, 0, 0],
            lastRename: 0,

            nextAsteroidAt: now + 1000,
            nextMineAt: now + randomRange(6, 10) * 1000,
            nextCrystalAt: now + randomRange(8, 14) * 1000,

            lastSeen: now,
            tokens: RATE_CAPACITY,
            tokensAt: now,

            dirty: true,
            spawnMoved: false
        };
    }

    // ---------------------------------------------------------
    // MESSAGES FROM PLAYERS
    // ---------------------------------------------------------

    handleMessage(ws, message) {
        if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) {
            return;
        }

        const ship = this.getShip(ws);
        if (!ship) return;

        const now = Date.now();
        ship.lastSeen = now;

        ship.tokens = Math.min(
            RATE_CAPACITY,
            ship.tokens + ((now - ship.tokensAt) / 1000) * RATE_PER_SECOND
        );
        ship.tokensAt = now;

        if (ship.tokens < 1) return;
        ship.tokens -= 1;

        let data;

        try {
            data = JSON.parse(message);
        } catch {
            return;
        }

        if (!data || typeof data !== "object") return;

        switch (data.t) {
            case "s":
                this.onState(ship, data, now);
                break;

            case "f":
                this.onFire(ship, data, now);
                break;

            case "p":
                safeSend(ws, { t: "pong", now });
                break;

            case "n":
                this.onRename(ws, ship, data, now);
                break;

            default:
                break;
        }

        this.startTimer();
    }

    // A player changing their callsign mid-game. The server's filter
    // has the final say; a rejected name is never shown to anyone.
    onRename(ws, ship, data, now) {
        if (now - ship.lastRename < RENAME_COOLDOWN_MS) {
            safeSend(ws, { t: "name", id: ship.id, name: ship.name, rejected: "wait" });
            return;
        }

        ship.lastRename = now;

        const result = checkName(data.name);

        if (!result.ok) {
            safeSend(ws, { t: "name", id: ship.id, name: ship.name, rejected: result.reason });
            return;
        }

        if (result.name === ship.name) {
            safeSend(ws, { t: "name", id: ship.id, name: ship.name });
            return;
        }

        ship.name = result.name;

        const info = readAttachment(ws);

        if (info) {
            ws.serializeAttachment({ ...info, name: result.name });
        }

        this.broadcast({ t: "name", id: ship.id, name: result.name });
    }

    onState(ship, data, now) {
        // A report from before the latest respawn: ignore it.
        if (Number(data.l) !== ship.life) return;

        const x = finite(data.x, -HALF_W, HALF_W);
        const z = finite(data.z, -HALF_H, HALF_H);
        const r = finite(data.r, -1e6, 1e6);

        if (x === null || z === null || r === null) return;

        ship.st = Math.round(finite(data.st, 0, 2) ?? 0);
        ship.weapon = Math.round(finite(data.w, 0, 2) ?? 0);

        // While dead, the ship stays where it was destroyed.
        if (!ship.alive) return;

        ship.x = round2(x);
        ship.z = round2(z);
        ship.r = round2(r % (Math.PI * 2));
        ship.vx = round2(finite(data.vx, -80, 80) ?? 0);
        ship.vz = round2(finite(data.vz, -80, 80) ?? 0);
        ship.th = Math.round(finite(data.th, -1, 1) ?? 0);
        ship.stateAt = now;
    }

    onFire(ship, data, now) {
        if (!this.round || this.round.phase !== "playing") return;
        if (!ship.alive) return;

        const weapon = Math.round(finite(data.w, 0, 2) ?? -1);
        if (weapon < 0) return;

        if (weapon === WEAPON.LASER && ship.score < LASER.unlockScore) return;
        if (weapon === WEAPON.ROCKETS && ship.score < ROCKET.unlockScore) return;

        const cooldown = [BULLET.cooldownMs, LASER.cooldownMs, ROCKET.cooldownMs][weapon];

        if (now - ship.lastFire[weapon] < cooldown) return;
        ship.lastFire[weapon] = now;

        // Use the reported origin if it's close to where we think the
        // ship is; otherwise our own estimate.
        const est = this.shipPosition(ship, now);

        let x = finite(data.x, -HALF_W - 5, HALF_W + 5);
        let z = finite(data.z, -HALF_H - 5, HALF_H + 5);

        if (x === null || z === null || Math.hypot(x - est.x, z - est.z) > SHIP.maxShotOffset) {
            x = est.x + Math.sin(ship.r) * 1.1;
            z = est.z + Math.cos(ship.r) * 1.1;
        }

        const r = finite(data.r, -1e6, 1e6) ?? ship.r;
        const dx = Math.sin(r);
        const dz = Math.cos(r);

        if (weapon === WEAPON.BLASTER) {
            this.bullets.push({
                owner: ship,
                x,
                z,
                vx: dx * BULLET.speed,
                vz: dz * BULLET.speed,
                life: BULLET.life
            });

            this.event(["b", ship.id, round2(x), round2(z), round2(r)]);
        } else if (weapon === WEAPON.LASER) {
            const beam = {
                owner: ship,
                ox: x,
                oz: z,
                dx,
                dz,
                life: LASER.life,
                hit: new Set()
            };

            this.beams.push(beam);

            this.event(["l", ship.id, round2(x), round2(z), round2(r)]);

            // Hits land the moment it fires.
            this.applyBeam(beam, now);
        } else {
            this.rockets.push({
                id: this.nextId++,
                owner: ship,
                x,
                z,
                h: r,
                life: ROCKET.life,
                target: null
            });
        }
    }

    // ---------------------------------------------------------
    // THE SIMULATION LOOP
    // ---------------------------------------------------------

    startTimer() {
        if (this.timer !== null) return;
        if (this.ctx.getWebSockets().length === 0) return;

        this.lastStepAt = Date.now();
        this.timer = setInterval(() => this.step(), SIM_MS);
    }

    stopTimer() {
        if (this.timer === null) return;

        clearInterval(this.timer);
        this.timer = null;
    }

    step() {
        const sockets = this.ctx.getWebSockets();

        if (sockets.length === 0) {
            this.stopTimer();
            return;
        }

        const now = Date.now();
        const dt = clamp((now - this.lastStepAt) / 1000, 0, 0.1);
        this.lastStepAt = now;
        this.stepCount++;

        // (Events from players' messages since the last step are
        // already queued; they go out with this step's.)

        try {
            if (now - this.lastStaleCheck > 5000) {
                this.lastStaleCheck = now;
                this.dropStaleSockets(now);
            }

            this.updateRound(now);

            if (this.round?.phase === "playing") {
                this.simulate(dt, now);
            }
        } catch (error) {
            // Keep the lobby alive; the next step starts clean.
            console.error("Simulation error:", error);
        }

        try {
            if (this.events.length > 0) {
                this.broadcastRaw(JSON.stringify({ t: "ev", now, e: this.events }));
            }

            this.events = [];

            if (this.stepCount % SNAPSHOT_EVERY === 0) {
                this.broadcastRaw(JSON.stringify(this.snapshotMessage(now)));
            }

            if (this.stepCount % WORLD_SYNC_EVERY === 0 && this.round?.phase === "playing") {
                this.broadcastRaw(JSON.stringify(this.worldMessage(now)));
            }

            this.sendDirtyShips();
        } catch (error) {
            console.error("Send error:", error);
        }
    }

    simulate(dt, now) {
        const ships = [...this.ships.values()];

        for (const ship of ships) {
            if (!ship.alive && now >= ship.respawnAt) {
                this.respawn(ship, now);
            }
        }

        this.moveAsteroids(dt);
        this.updateMines(dt);
        this.updateCrystals(dt);
        this.updateBullets(dt, now);
        this.updateBeams(dt, now);
        this.updateRockets(dt, now);
        this.updateWarp(now);
        this.shipCollisions(now);
        this.updateRogue(dt, now);

        if (this.stepCount % 10 === 0) {
            this.spawnThings(now);
            this.despawnFarAsteroids();
        }
    }

    // ---------------------------------------------------------
    // ROUNDS
    // ---------------------------------------------------------

    startRound(n, now, announce = true) {
        this.resetWorld();
        this.departed.clear();

        this.round = {
            n,
            phase: "playing",
            startedAt: now,
            endsAt: now + ROUND_MS,
            nextAt: 0,
            results: null
        };

        for (const ship of this.ships.values()) {
            ship.score = 0;
            ship.kills = 0;
            ship.deaths = 0;
            ship.nextWarp = WARP.scoreInterval;
            ship.warpUntil = 0;
            ship.lastHitBy = null;

            this.placeShip(ship, now);
        }

        if (announce) {
            this.broadcast({ t: "round", now, round: this.roundInfo() });
            this.broadcastRaw(JSON.stringify(this.worldMessage(now)));

            for (const ship of this.ships.values()) ship.dirty = true;
        }
    }

    endRound(now) {
        const results = this.standings().slice(0, 10).map((s) => ({
            id: s.id,
            name: s.name,
            color: s.color,
            score: s.score,
            kills: s.kills
        }));

        this.round.phase = "ended";
        this.round.nextAt = now + INTERMISSION_MS;
        this.round.results = results;

        this.bullets = [];
        this.beams = [];
        this.rockets = [];
        this.rogue = newRogue();

        this.broadcast({ t: "round", now, round: this.roundInfo() });

        // Everyone's final score goes to the all-time list; the updated
        // list follows the results a moment later.
        this.reportRecords([...this.ships.values()])
            .then((top) => {
                if (top) this.broadcast({ t: "records", top });
            })
            .catch(() => {});
    }

    // The key for one player's one round: the same player reconnecting
    // during a round keeps the same key.
    recordKey(ship) {
        const who = ship.token ?? `id-${ship.id}`;
        return `${who}:${this.lobbyId ?? "lobby"}:${this.round?.startedAt ?? 0}`;
    }

    // Send scores to the Matchmaker. Returns the all-time list (with
    // this lobby's own players marked by id), or null on failure.
    async reportRecords(ships) {
        const entries = ships.map((s) => ({
            key: this.recordKey(s),
            name: s.name,
            color: s.color,
            score: s.score,
            kills: s.kills
        }));

        const matchmaker = this.env.MATCHMAKER.get(
            this.env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        const { top, minimum } = await matchmaker.recordScores(entries);

        this.recordMinimum = Number(minimum) || 0;

        const idByKey = new Map(ships.map((s) => [this.recordKey(s), s.id]));

        return top.map((r) => ({ ...publicRecord(r), id: idByKey.get(r.key) ?? null }));
    }

    updateRound(now) {
        const round = this.round;
        if (!round) return;

        if (round.phase === "playing" && now >= round.endsAt) {
            this.endRound(now);
        } else if (round.phase === "ended" && now >= round.nextAt) {
            this.startRound(round.n + 1, now);
        }
    }

    roundInfo() {
        const r = this.round;

        return {
            n: r.n,
            phase: r.phase,
            endsAt: r.endsAt,
            nextAt: r.nextAt,
            results: r.results
        };
    }

    standings() {
        return [...this.ships.values()].sort(
            (a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths
        );
    }

    // ---------------------------------------------------------
    // WORLD
    // ---------------------------------------------------------

    resetWorld() {
        this.nextId = 1;
        this.asteroids = [];
        this.mines = [];
        this.crystals = [];
        this.bullets = [];
        this.beams = [];
        this.rockets = [];
        this.rogue = newRogue();
        this.events = [];
    }

    moveAsteroids(dt) {
        for (const a of this.asteroids) {
            a.x += a.vx * dt;
            a.z += a.vz * dt;

            // Bounce off the world's edges (game.js does the same).
            if (a.x < -HALF_W + a.radius) { a.x = -HALF_W + a.radius; a.vx = Math.abs(a.vx); }
            if (a.x > HALF_W - a.radius) { a.x = HALF_W - a.radius; a.vx = -Math.abs(a.vx); }
            if (a.z < -HALF_H + a.radius) { a.z = -HALF_H + a.radius; a.vz = Math.abs(a.vz); }
            if (a.z > HALF_H - a.radius) { a.z = HALF_H - a.radius; a.vz = -Math.abs(a.vz); }
        }
    }

    updateMines(dt) {
        for (let i = this.mines.length - 1; i >= 0; i--) {
            const m = this.mines[i];

            m.x += m.vx * dt;
            m.z += m.vz * dt;
            m.life -= dt;

            if (m.life <= 0 || Math.abs(m.x) > HALF_W || Math.abs(m.z) > HALF_H) {
                this.mines.splice(i, 1);
                this.event(["mx", m.id]);
            }
        }
    }

    updateCrystals(dt) {
        for (let i = this.crystals.length - 1; i >= 0; i--) {
            const c = this.crystals[i];

            c.life -= dt;

            if (c.life <= 0) {
                this.crystals.splice(i, 1);
                this.event(["cx", c.id, 0]);
            }
        }
    }

    spawnAsteroid(x, z, size, vx, vz, bornFrom = null) {
        const scale = size * randomRange(0.75, 1.15);

        const a = {
            id: this.nextId++,
            x,
            z,
            vx,
            vz,
            size,
            scale,
            radius: 0.82 * scale,
            model: Math.floor(Math.random() * 3),
            spin: randomRange(-1, 1),
            hp: size >= 1.25 ? 3 : size >= 0.85 ? 2 : 1,
            score: Math.round(100 / Math.max(0.5, size)),
            bornFrom
        };

        this.asteroids.push(a);
        this.event(["as", ...asteroidArray(a)]);

        return a;
    }

    // Fully remove an asteroid. `by` (a ship) scores it; `split`
    // breaks big rocks into two (bullets and lasers only, as in the
    // solo game); `beam` keeps fragments out of the same laser.
    destroyAsteroid(a, by, split, beam = null) {
        const i = this.asteroids.indexOf(a);
        if (i < 0) return;

        this.asteroids.splice(i, 1);
        this.event(["ad", a.id, round2(a.x), round2(a.z), by ? by.id : ""]);

        if (by) this.addScore(by, a.score);

        if (!split) return;

        if (a.size > 0.9) {
            const speed = Math.hypot(a.vx, a.vz) * 1.15 + 0.4;
            const heading = Math.atan2(a.vx, a.vz);

            for (const side of [-1, 1]) {
                const h = heading + side * randomRange(0.35, 0.8);

                this.spawnAsteroid(
                    a.x + randomRange(-0.5, 0.5),
                    a.z + randomRange(-0.5, 0.5),
                    a.size * 0.58,
                    Math.sin(h) * speed,
                    Math.cos(h) * speed,
                    beam
                );
            }
        }

        if (Math.random() < CRYSTALS.dropChance) {
            this.spawnCrystal(a.x, a.z);
        }
    }

    damageAsteroid(a, amount, by, beam = null) {
        a.hp -= amount;

        if (a.hp <= 0) {
            this.destroyAsteroid(a, by, true, beam);
            return true;
        }

        a.scale *= 0.96;
        a.radius *= 0.96;
        this.event(["ah", a.id, a.hp, round3(a.scale)]);

        return false;
    }

    spawnMine(x, z, vx, vz) {
        const m = { id: this.nextId++, x, z, vx, vz, life: MINES.life };

        this.mines.push(m);
        this.event(["ms", ...mineArray(m)]);
    }

    destroyMine(m, by) {
        const i = this.mines.indexOf(m);
        if (i < 0) return;

        this.mines.splice(i, 1);
        this.event(["md", m.id, round2(m.x), round2(m.z), by ? by.id : ""]);

        if (by) this.addScore(by, POINTS.mine);
    }

    spawnCrystal(x, z) {
        const c = {
            id: this.nextId++,
            x: clamp(x, -HALF_W + 1, HALF_W - 1),
            z: clamp(z, -HALF_H + 1, HALF_H - 1),
            life: CRYSTALS.life
        };

        this.crystals.push(c);
        this.event(["cs", ...crystalArray(c)]);
    }

    // ---------------------------------------------------------
    // SPAWNING (around the players, every half second)
    // ---------------------------------------------------------

    spawnThings(now) {
        const present = this.presentShips(now);
        if (present.length === 0) return;

        const minutes = (now - this.round.startedAt) / 60000;

        const target = Math.min(
            ASTEROIDS.maxTarget,
            ASTEROIDS.baseTarget + Math.floor(minutes / ASTEROIDS.rampMinutes)
        );

        const cap = Math.min(
            ASTEROIDS.globalCapMax,
            ASTEROIDS.globalCapBase + ASTEROIDS.globalCapPerPlayer * present.length
        );

        // Asteroids speed up a little as the round goes on.
        const speedBonus = 0.12 * Math.min(12, 1 + Math.floor(minutes));

        for (const ship of shuffle(present)) {
            // Asteroids.
            if (now >= ship.nextAsteroidAt && this.asteroids.length < cap) {
                const near = countNear(this.asteroids, ship.x, ship.z, ASTEROIDS.nearRadius);

                if (near < target) {
                    const p = this.pointAround(ship.x, ship.z, ...ASTEROIDS.spawnDistance);

                    if (p) {
                        const size = Math.random() < 0.2 ? 1.45
                            : Math.random() < 0.55 ? 1.0 : 0.72;

                        const tx = ship.x + randomRange(-3, 3);
                        const tz = ship.z + randomRange(-3, 3);
                        const h = Math.atan2(tx - p.x, tz - p.z);
                        const speed = randomRange(1.6, 3.0) + speedBonus;

                        this.spawnAsteroid(p.x, p.z, size, Math.sin(h) * speed, Math.cos(h) * speed);
                    }
                }

                ship.nextAsteroidAt = now + randomRange(...ASTEROIDS.spawnDelay) * 1000;
            }

            // Mines.
            if (now >= ship.nextMineAt) {
                ship.nextMineAt = now + randomRange(...MINES.spawnDelay) * 1000;

                const near = countNear(this.mines, ship.x, ship.z, MINES.nearRadius);

                if (near === 0 && this.mines.length < 2 + present.length) {
                    const p = this.pointAround(ship.x, ship.z, ...ASTEROIDS.spawnDistance);

                    if (p) {
                        const h = Math.atan2(ship.x - p.x, ship.z - p.z);
                        const speed = randomRange(1.1, 2.0);

                        this.spawnMine(p.x, p.z, Math.sin(h) * speed, Math.cos(h) * speed);
                    }
                }
            }

            // Energy crystals (on screen, so players can race for them).
            if (now >= ship.nextCrystalAt) {
                ship.nextCrystalAt = now + randomRange(...CRYSTALS.spawnDelay) * 1000;

                const near = countNear(this.crystals, ship.x, ship.z, 25);

                if (near === 0 && this.crystals.length < 2 * present.length) {
                    const p = this.pointAround(ship.x, ship.z, ...CRYSTALS.spawnDistance);
                    if (p) this.spawnCrystal(p.x, p.z);
                }
            }
        }
    }

    despawnFarAsteroids() {
        const ships = [...this.ships.values()];
        const limit = ASTEROIDS.despawnDistance;

        for (let i = this.asteroids.length - 1; i >= 0; i--) {
            const a = this.asteroids[i];

            const nearSomeone = ships.some(
                (s) => Math.abs(s.x - a.x) < limit && Math.abs(s.z - a.z) < limit
            );

            if (!nearSomeone) {
                this.asteroids.splice(i, 1);
                this.event(["ar", a.id]);
            }
        }
    }

    // A random point at a given distance from (x, z), inside the world.
    pointAround(x, z, min, max) {
        for (let tries = 0; tries < 8; tries++) {
            const angle = Math.random() * Math.PI * 2;
            const d = randomRange(min, max);
            const px = x + Math.sin(angle) * d;
            const pz = z + Math.cos(angle) * d;

            if (Math.abs(px) < HALF_W - 2 && Math.abs(pz) < HALF_H - 2) {
                return { x: px, z: pz };
            }
        }

        return null;
    }

    // ---------------------------------------------------------
    // WEAPONS
    // ---------------------------------------------------------

    updateBullets(dt, now) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];

            const step = BULLET.speed * dt;
            const dx = b.vx / BULLET.speed;
            const dz = b.vz / BULLET.speed;

            // Earliest thing along this step's path.
            let best = null;
            let bestAlong = Infinity;

            const consider = (kind, ref, x, z, radius) => {
                const along = segmentHit(b.x, b.z, dx, dz, step, x, z, radius + BULLET.radius);

                if (along >= 0 && along < bestAlong) {
                    bestAlong = along;
                    best = { kind, ref };
                }
            };

            for (const a of this.asteroids) consider("a", a, a.x, a.z, a.radius);
            for (const m of this.mines) consider("m", m, m.x, m.z, MINES.radius);

            for (const s of this.ships.values()) {
                if (s === b.owner || !this.canBeHit(s, now)) continue;

                const p = this.shipPosition(s, now);
                consider("s", s, p.x, p.z, SHIP.radius);
            }

            if (best) {
                const hx = b.x + dx * bestAlong;
                const hz = b.z + dz * bestAlong;

                this.bullets.splice(i, 1);

                if (best.kind === "a") {
                    this.event(["bh", round2(hx), round2(hz)]);
                    this.damageAsteroid(best.ref, 1, b.owner);
                } else if (best.kind === "m") {
                    this.destroyMine(best.ref, b.owner);
                } else {
                    this.damageShip(best.ref, BULLET.shipDamage, b.owner, now);
                }

                continue;
            }

            b.x += b.vx * dt;
            b.z += b.vz * dt;
            b.life -= dt;

            if (b.life <= 0 || Math.abs(b.x) > HALF_W + 2 || Math.abs(b.z) > HALF_H + 2) {
                this.bullets.splice(i, 1);
            }
        }
    }

    // A laser beam pierces: everything touching it while it is visible
    // takes damage, once. Its reach is exactly what is drawn.
    applyBeam(beam, now) {
        const touches = (x, z, radius) => segmentHit(
            beam.ox, beam.oz, beam.dx, beam.dz, LASER.range,
            x, z, radius + LASER.halfWidth
        ) >= 0;

        for (const a of [...this.asteroids]) {
            if (beam.hit.has(a) || a.bornFrom === beam) continue;
            if (!touches(a.x, a.z, a.radius)) continue;

            beam.hit.add(a);
            this.event(["lh", round2(a.x), round2(a.z)]);
            this.damageAsteroid(a, LASER.asteroidDamage, beam.owner, beam);
        }

        for (const m of [...this.mines]) {
            if (beam.hit.has(m) || !touches(m.x, m.z, MINES.radius)) continue;

            beam.hit.add(m);
            this.event(["lh", round2(m.x), round2(m.z)]);
            this.destroyMine(m, beam.owner);
        }

        for (const s of this.ships.values()) {
            if (s === beam.owner || beam.hit.has(s) || !this.canBeHit(s, now)) continue;

            const p = this.shipPosition(s, now);
            if (!touches(p.x, p.z, SHIP.radius)) continue;

            beam.hit.add(s);
            this.event(["lh", round2(p.x), round2(p.z)]);
            this.damageShip(s, LASER.shipDamage, beam.owner, now);
        }
    }

    updateBeams(dt, now) {
        for (let i = this.beams.length - 1; i >= 0; i--) {
            const beam = this.beams[i];

            beam.life -= dt;

            if (beam.life <= 0) {
                this.beams.splice(i, 1);
                continue;
            }

            this.applyBeam(beam, now);
        }
    }

    updateRockets(dt, now) {
        for (let i = this.rockets.length - 1; i >= 0; i--) {
            const rocket = this.rockets[i];

            rocket.life -= dt;

            if (!this.targetValid(rocket.target, rocket.owner, now)) {
                rocket.target = this.findRocketTarget(rocket, now);
            }

            if (rocket.target) {
                const tp = this.targetPosition(rocket.target, now);
                const desired = Math.atan2(tp.x - rocket.x, tp.z - rocket.z);
                const diff = Math.atan2(
                    Math.sin(desired - rocket.h),
                    Math.cos(desired - rocket.h)
                );

                rocket.h += clamp(diff, -ROCKET.turnRate * dt, ROCKET.turnRate * dt);
            }

            rocket.x += Math.sin(rocket.h) * ROCKET.speed * dt;
            rocket.z += Math.cos(rocket.h) * ROCKET.speed * dt;

            let contact = false;

            for (const a of this.asteroids) {
                if (dist(rocket, a) < a.radius + ROCKET.contactRadius) { contact = true; break; }
            }

            if (!contact) {
                for (const m of this.mines) {
                    if (dist(rocket, m) < MINES.radius + ROCKET.contactRadius) { contact = true; break; }
                }
            }

            if (!contact) {
                for (const s of this.ships.values()) {
                    if (s === rocket.owner || !this.canBeHit(s, now)) continue;

                    const p = this.shipPosition(s, now);

                    if (dist(rocket, p) < SHIP.radius + ROCKET.contactRadius) { contact = true; break; }
                }
            }

            const outside = Math.abs(rocket.x) > HALF_W || Math.abs(rocket.z) > HALF_H;

            if (contact || outside || rocket.life <= 0) {
                this.rockets.splice(i, 1);
                this.explodeRocket(rocket, now);
            }
        }
    }

    explodeRocket(rocket, now) {
        this.event(["rx", rocket.id, round2(rocket.x), round2(rocket.z)]);

        const by = rocket.owner;

        // Like the solo game: the blast vaporizes rocks without
        // splitting them.
        for (const a of [...this.asteroids]) {
            if (dist(rocket, a) <= ROCKET.blastRadius + a.radius) {
                this.destroyAsteroid(a, by, false);
            }
        }

        for (const m of [...this.mines]) {
            if (dist(rocket, m) <= ROCKET.blastRadius + MINES.radius) {
                this.destroyMine(m, by);
            }
        }

        for (const s of this.ships.values()) {
            if (s === by || !this.canBeHit(s, now)) continue;

            const p = this.shipPosition(s, now);

            if (dist(rocket, p) <= ROCKET.blastRadius + SHIP.radius) {
                this.damageShip(s, ROCKET.shipDamage, by, now);
            }
        }
    }

    // Rockets home on the best target ahead of them: an asteroid, a
    // mine or another pilot.
    findRocketTarget(rocket, now) {
        let best = null;
        let bestScore = Infinity;

        const consider = (kind, ref, x, z) => {
            const dx = x - rocket.x;
            const dz = z - rocket.z;
            const d = Math.hypot(dx, dz);

            if (d > ROCKET.seekRange) return;

            const angle = Math.abs(Math.atan2(
                Math.sin(Math.atan2(dx, dz) - rocket.h),
                Math.cos(Math.atan2(dx, dz) - rocket.h)
            ));

            if (angle > ROCKET.seekCone) return;

            const score = d * (1 + angle);

            if (score < bestScore) {
                bestScore = score;
                best = { kind, ref };
            }
        };

        for (const a of this.asteroids) consider("a", a, a.x, a.z);
        for (const m of this.mines) consider("m", m, m.x, m.z);

        for (const s of this.ships.values()) {
            if (s === rocket.owner || !this.canBeHit(s, now)) continue;

            const p = this.shipPosition(s, now);
            consider("s", s, p.x, p.z);
        }

        return best;
    }

    targetValid(target, owner, now) {
        if (!target) return false;

        if (target.kind === "a") return this.asteroids.includes(target.ref);
        if (target.kind === "m") return this.mines.includes(target.ref);

        return [...this.ships.values()].includes(target.ref) && this.canBeHit(target.ref, now);
    }

    targetPosition(target, now) {
        return target.kind === "s" ? this.shipPosition(target.ref, now) : target.ref;
    }

    // ---------------------------------------------------------
    // SHIPS
    // ---------------------------------------------------------

    // Where a ship is now, from its last report.
    shipPosition(ship, now) {
        const ahead = Math.min(0.2, Math.max(0, (now - ship.stateAt) / 1000));

        return {
            x: ship.x + ship.vx * ahead,
            z: ship.z + ship.vz * ahead
        };
    }

    isPresent(ship, now) {
        return ship.alive && ship.st === 1 && now - ship.stateAt < SHIP.presentMs;
    }

    presentShips(now) {
        return [...this.ships.values()].filter((s) => this.isPresent(s, now));
    }

    randomPresentShip() {
        const now = Date.now();
        const present = this.presentShips(now);

        return present.length ? present[Math.floor(Math.random() * present.length)] : null;
    }

    canBeHit(ship, now) {
        return this.isPresent(ship, now) &&
            now >= ship.shieldUntil &&
            now >= ship.warpUntil;
    }

    damageShip(ship, amount, attacker, now) {
        if (!ship.alive) return;
        if (now < ship.shieldUntil || now < ship.warpUntil) return;
        if (now < ship.hitCooldownUntil) return;

        ship.hull = Math.max(0, ship.hull - amount);
        ship.hitCooldownUntil = now + SHIP.hitCooldownMs;
        ship.dirty = true;

        if (attacker && attacker !== ship) {
            ship.lastHitBy = attacker;
            ship.lastHitAt = now;
            this.addScore(attacker, POINTS.shipHit);
        }

        const p = this.shipPosition(ship, now);

        this.event(["sh", ship.id, ship.hull, attacker ? attacker.id : "", round2(p.x), round2(p.z)]);

        if (ship.hull > 0) return;

        // Destroyed. Whoever hit it last (within a few seconds) gets
        // the kill, even if it was finished off by an asteroid.
        let killer = attacker && attacker !== ship ? attacker : null;

        if (!killer && ship.lastHitBy && now - ship.lastHitAt < 5000) {
            killer = ship.lastHitBy;
        }

        if (killer && ![...this.ships.values()].includes(killer)) killer = null;

        ship.alive = false;
        ship.deaths++;
        ship.respawnAt = now + SHIP.respawnMs;
        ship.warpUntil = 0;
        ship.lastHitBy = null;

        if (killer) {
            killer.kills++;
            this.addScore(killer, POINTS.shipKill);
        }

        this.event(["sk", ship.id, killer ? killer.id : "", round2(p.x), round2(p.z)]);
    }

    respawn(ship, now) {
        this.placeShip(ship, now);
        this.event(["sr", ship.id, round2(ship.x), round2(ship.z)]);
    }

    // Full hull, a new life number and a safe spot near where it was.
    placeShip(ship, now) {
        const spot = this.chooseSpawn(ship.x, ship.z, now, ship);

        ship.x = spot.x;
        ship.z = spot.z;
        ship.vx = 0;
        ship.vz = 0;
        ship.stateAt = now;
        ship.life++;
        ship.alive = true;
        ship.hull = SHIP.hull;
        ship.shieldUntil = now + SHIP.spawnShieldMs;
        ship.hitCooldownUntil = 0;
        ship.dirty = true;
        ship.spawnMoved = true;
    }

    chooseSpawn(nearX, nearZ, now, self = null) {
        let best = { x: clamp(nearX, -HALF_W + 10, HALF_W - 10), z: clamp(nearZ, -HALF_H + 10, HALF_H - 10) };
        let bestClearance = -1;

        for (let i = 0; i < 16; i++) {
            const angle = Math.random() * Math.PI * 2;
            const d = randomRange(10, 28);

            const x = clamp(nearX + Math.sin(angle) * d, -HALF_W + 10, HALF_W - 10);
            const z = clamp(nearZ + Math.cos(angle) * d, -HALF_H + 10, HALF_H - 10);

            let clearance = 50;

            for (const a of this.asteroids) clearance = Math.min(clearance, Math.hypot(a.x - x, a.z - z) - a.radius);
            for (const m of this.mines) clearance = Math.min(clearance, Math.hypot(m.x - x, m.z - z));

            for (const s of this.ships.values()) {
                if (s === self || !s.alive) continue;
                clearance = Math.min(clearance, Math.hypot(s.x - x, s.z - z) * 0.5);
            }

            if (clearance > bestClearance) {
                bestClearance = clearance;
                best = { x: round2(x), z: round2(z) };
            }
        }

        return best;
    }

    addScore(ship, amount) {
        ship.score += amount;
        ship.dirty = true;

        // A warp bubble at every 10,000 points, as in the solo game.
        while (ship.score >= ship.nextWarp) {
            ship.nextWarp += WARP.scoreInterval;

            if (ship.alive) {
                ship.warpUntil = Date.now() + WARP.durationMs;
                this.event(["w", ship.id, ship.warpUntil]);
            }
        }
    }

    // The warp bubble clears asteroids and mines around the ship.
    updateWarp(now) {
        for (const ship of this.ships.values()) {
            if (!ship.alive || now >= ship.warpUntil || !this.isPresent(ship, now)) continue;

            const p = this.shipPosition(ship, now);

            for (const a of [...this.asteroids]) {
                if (Math.hypot(a.x - p.x, a.z - p.z) < WARP.radius) {
                    this.destroyAsteroid(a, ship, false);
                }
            }

            for (const m of [...this.mines]) {
                if (Math.hypot(m.x - p.x, m.z - p.z) < WARP.radius) {
                    this.destroyMine(m, null);
                }
            }
        }
    }

    shipCollisions(now) {
        for (const ship of this.ships.values()) {
            if (!this.isPresent(ship, now)) continue;

            const p = this.shipPosition(ship, now);

            for (const a of this.asteroids) {
                const dx = a.x - p.x;
                const dz = a.z - p.z;
                const d = Math.hypot(dx, dz);

                if (d >= SHIP.radius + a.radius) continue;

                this.damageShip(ship, 1, null, now);

                // Knock the asteroid away (as the solo game does).
                if (d > 0.001) {
                    const push = now < ship.warpUntil ? 8 : 4;

                    a.vx += (dx / d) * push;
                    a.vz += (dz / d) * push;

                    const speed = Math.hypot(a.vx, a.vz);

                    if (speed > ASTEROIDS.maxSpeed) {
                        a.vx *= ASTEROIDS.maxSpeed / speed;
                        a.vz *= ASTEROIDS.maxSpeed / speed;
                    }

                    a.x += (dx / d) * 0.35;
                    a.z += (dz / d) * 0.35;

                    this.event(["au", a.id, round2(a.x), round2(a.z), round2(a.vx), round2(a.vz)]);
                }
            }

            for (const m of [...this.mines]) {
                if (Math.hypot(m.x - p.x, m.z - p.z) >= SHIP.radius + MINES.radius) continue;

                this.destroyMine(m, null);
                this.damageShip(ship, 1, null, now);
            }

            for (const c of [...this.crystals]) {
                if (Math.hypot(c.x - p.x, c.z - p.z) >= SHIP.radius + CRYSTALS.radius) continue;

                this.crystals.splice(this.crystals.indexOf(c), 1);
                this.event(["cc", c.id, ship.id]);

                this.addScore(ship, POINTS.crystal);
                ship.hull = Math.min(SHIP.hull, ship.hull + 1);
                ship.dirty = true;
            }
        }
    }

    // ---------------------------------------------------------
    // ROGUE ASTEROID
    // ---------------------------------------------------------

    updateRogue(dt, now) {
        const rogue = this.rogue;

        if (rogue.phase === "idle") {
            if (this.presentShips(now).length === 0) return;

            rogue.timer -= dt;

            if (rogue.timer > 0) return;

            const target = this.randomPresentShip();
            if (!target) return;

            const angle = Math.random() * Math.PI * 2;
            const dx = Math.sin(angle);
            const dz = Math.cos(angle);

            // Passes close by the target, from off their screen.
            const offset = randomRange(-6, 6);

            rogue.x = target.x - dx * ROGUE.leadIn + dz * offset;
            rogue.z = target.z - dz * ROGUE.leadIn - dx * offset;
            rogue.dx = dx;
            rogue.dz = dz;
            rogue.launchAt = now + ROGUE.warningMs;
            rogue.travelled = 0;
            rogue.destroyed = 0;
            rogue.phase = "warning";

            this.event(["rg", round2(rogue.x), round2(rogue.z), round3(dx), round3(dz), rogue.launchAt]);
            return;
        }

        if (rogue.phase === "warning") {
            if (now >= rogue.launchAt) rogue.phase = "flying";
            return;
        }

        const step = ROGUE.speed * dt;

        this.rogueSweep(rogue, step, now);

        rogue.x += rogue.dx * step;
        rogue.z += rogue.dz * step;
        rogue.travelled += step;

        if (rogue.travelled >= ROGUE.travel) {
            this.event(["ro", rogue.destroyed]);
            this.rogue = newRogue(false);
        }
    }

    rogueSweep(rogue, step, now) {
        const touches = (x, z, radius) => segmentHit(
            rogue.x, rogue.z, rogue.dx, rogue.dz, step, x, z, ROGUE.radius + radius
        ) >= 0;

        for (const a of [...this.asteroids]) {
            if (touches(a.x, a.z, a.radius)) {
                this.destroyAsteroid(a, null, false);
                rogue.destroyed++;
            }
        }

        for (const m of [...this.mines]) {
            if (touches(m.x, m.z, MINES.radius)) {
                this.destroyMine(m, null);
                rogue.destroyed++;
            }
        }

        for (const c of [...this.crystals]) {
            if (touches(c.x, c.z, CRYSTALS.radius)) {
                this.crystals.splice(this.crystals.indexOf(c), 1);
                this.event(["cx", c.id, 1]);
                rogue.destroyed++;
            }
        }

        this.bullets = this.bullets.filter((b) => !touches(b.x, b.z, BULLET.radius));

        for (const r of [...this.rockets]) {
            if (touches(r.x, r.z, ROCKET.contactRadius)) {
                this.rockets.splice(this.rockets.indexOf(r), 1);
                this.event(["rz", r.id, round2(r.x), round2(r.z)]);
            }
        }

        for (const s of this.ships.values()) {
            if (!this.isPresent(s, now)) continue;

            const p = this.shipPosition(s, now);
            if (touches(p.x, p.z, SHIP.radius)) this.damageShip(s, 1, null, now);
        }
    }

    // ---------------------------------------------------------
    // OUTGOING MESSAGES
    // ---------------------------------------------------------

    event(e) {
        this.events.push(e);
    }

    snapshotMessage(now) {
        const players = [];

        for (const s of this.ships.values()) {
            let flags = 0;

            if (s.alive && s.st === 1 && now - s.stateAt < SHIP.presentMs) flags |= 1;
            if (now < s.warpUntil) flags |= 2;
            if (now < s.shieldUntil) flags |= 4;

            players.push([s.id, s.x, s.z, s.r, s.vx, s.vz, s.th, flags, s.weapon]);
        }

        const rockets = this.rockets.map((r) => [
            r.id, r.owner.id, round2(r.x), round2(r.z), round2(r.h)
        ]);

        return { t: "snap", now, p: players, rk: rockets };
    }

    worldMessage(now) {
        return {
            t: "world",
            now,
            a: this.asteroids.map(asteroidArray),
            m: this.mines.map(mineArray),
            c: this.crystals.map(crystalArray),
            lb: this.standings().map((s) => [s.id, s.score, s.kills, s.deaths])
        };
    }

    youInfo(ship, includeSpawn = false) {
        const now = Date.now();

        const you = {
            sc: ship.score,
            hull: ship.hull,
            alive: ship.alive,
            lf: ship.life,
            rs: ship.alive ? 0 : Math.max(0, ship.respawnAt - now),
            sh: ship.shieldUntil,
            w: ship.warpUntil,
            k: ship.kills,
            d: ship.deaths
        };

        if (includeSpawn || ship.spawnMoved) {
            you.sp = [ship.x, ship.z];
        }

        return you;
    }

    sendDirtyShips() {
        for (const ws of this.ctx.getWebSockets()) {
            const ship = this.ships.get(ws);

            if (!ship || !ship.dirty) continue;

            safeSend(ws, { t: "you", now: Date.now(), ...this.youInfo(ship) });

            ship.dirty = false;
            ship.spawnMoved = false;
        }
    }

    broadcast(message, except = null) {
        this.broadcastRaw(JSON.stringify(message), except);
    }

    broadcastRaw(payload, except = null) {
        for (const ws of this.ctx.getWebSockets()) {
            if (ws !== except) safeSendRaw(ws, payload);
        }
    }

    async reportCount() {
        if (!this.lobbyId) {
            this.lobbyId = (await this.ctx.storage.get("lobbyId")) ?? null;
        }

        if (!this.lobbyId) return;

        const count = this.ctx
            .getWebSockets()
            .filter((ws) => ws.readyState === WebSocket.OPEN)
            .length;

        const matchmaker = this.env.MATCHMAKER.get(
            this.env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        await matchmaker.report(this.lobbyId, count);
    }

    async ensureAlarm() {
        const existing = await this.ctx.storage.getAlarm();

        if (existing === null) {
            await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
        }
    }
}

// ============================================================
// HELPERS
// ============================================================

function newRogue(first = true) {
    const [min, max] = first ? ROGUE.firstDelay : ROGUE.interval;

    return {
        phase: "idle",
        timer: randomRange(min, max),
        x: 0,
        z: 0,
        dx: 0,
        dz: 1,
        launchAt: 0,
        travelled: 0,
        destroyed: 0
    };
}

// What players see of an all-time record (the key stays private).
function publicRecord(r) {
    return { name: r.name, color: r.color, score: r.score, kills: r.kills, at: r.at };
}

// [id, x, z, vx, vz, size, model, scale, spin, hp]
function asteroidArray(a) {
    return [
        a.id, round2(a.x), round2(a.z), round3(a.vx), round3(a.vz),
        a.size, a.model, round3(a.scale), round2(a.spin), a.hp
    ];
}

// [id, x, z, vx, vz, life]
function mineArray(m) {
    return [m.id, round2(m.x), round2(m.z), round3(m.vx), round3(m.vz), round2(m.life)];
}

// [id, x, z, life]
function crystalArray(c) {
    return [c.id, round2(c.x), round2(c.z), round2(c.life)];
}

// Distance along a segment (from (ox, oz), direction (dx, dz), length
// `len`) at which it first comes within `radius` of (px, pz), or -1.
function segmentHit(ox, oz, dx, dz, len, px, pz, radius) {
    const rx = px - ox;
    const rz = pz - oz;
    const along = rx * dx + rz * dz;
    const perpSq = rx * rx + rz * rz - along * along;
    const rSq = radius * radius;

    if (perpSq > rSq) return -1;

    const entry = along - Math.sqrt(rSq - perpSq);

    if (entry > len || along + Math.sqrt(rSq - perpSq) < 0) return -1;

    return Math.max(0, entry);
}

function countNear(list, x, z, radius) {
    let n = 0;

    for (const item of list) {
        if (Math.abs(item.x - x) < radius && Math.abs(item.z - z) < radius) n++;
    }

    return n;
}

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }

    return list;
}

function randomRange(min, max) {
    return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

function finite(value, min, max) {
    const n = Number(value);

    if (!Number.isFinite(n)) return null;

    return Math.min(max, Math.max(min, n));
}

function readAttachment(ws) {
    try {
        return ws.deserializeAttachment() ?? null;
    } catch {
        return null;
    }
}

function safeSend(ws, message) {
    safeSendRaw(ws, JSON.stringify(message));
}

function safeSendRaw(ws, payload) {
    try {
        ws.send(payload);
    } catch {
        // The socket closed under us; webSocketClose cleans up.
    }
}

// A callsign that passes the rules, or a random PILOT-#### if not.
function sanitizeName(raw) {
    const result = checkName(raw);

    return result.ok ? result.name : randomCallsign();
}

function sanitizeToken(raw) {
    const token = String(raw ?? "");

    return /^[0-9a-f-]{16,36}$/i.test(token) ? token.toLowerCase() : null;
}

// Exposed for tests.
export const _internals = { segmentHit, LASER, ROCKET, BULLET, SHIP, POINTS, ROUND_MS, INTERMISSION_MS, RECORDS_SIZE };
