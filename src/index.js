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
import { checkName, randomCallsign, noFriendlyFire } from "../public/name-filter.js";

// UFO visits, shared with the game (public/ufo.js): the flight plan
// and its timing are worked out the same way on both sides.
import { UFO, createUfoPlan, ufoState, ufoFollow, ufoLeave } from "../public/ufo.js";

// Ranks and the cloak, shared with the game (public/ranks.js). A
// cloaked ship is left out of everyone else's snapshots, can't fire,
// and rockets don't home on it; it can still be hit.
import { cloakUnlocked } from "../public/ranks.js";

// Must match PROTOCOL_VERSION in public/multiplayer.js.
const PROTOCOL_VERSION = 2;

const MAX_PLAYERS = 20;

// ---- Timing -------------------------------------------------------

// Simulation step (30 per second), ship snapshots and events every
// step (30 per second: messages from the lobby to players don't count
// toward Cloudflare's request limits, so this costs nothing extra),
// full world resync every second. Players still send their own updates
// 10-20 times a second (multiplayer.js), since those do count.
// If SIM_MS changes, change snapshotIntervalMs in multiplayer.js too.
const SIM_MS = 1000 / 30;
const SNAPSHOT_EVERY = 1;
const WORLD_SYNC_EVERY = Math.round(1000 / SIM_MS);

// The leaderboard (everyone's score, kills and deaths) goes out as soon
// as it changes, but at most this often, so a kill shows beside the
// pilot's name straight away without sending it every step while rocks
// are being shot.
const STANDINGS_MIN_MS = 100;

// New asteroids and mines are considered twice a second.
const SPAWN_CHECK_EVERY = Math.round(500 / SIM_MS);

// Lag compensation. Each pilot sees the other ships slightly in the
// past (their connection, plus the smoothing in multiplayer.js), so
// shots are judged against where the shooter saw the target, not
// where it is now: every shot carries the server time of the picture
// the shooter was looking at ("vt"), and the server keeps a short
// history of where each ship was. A shot can look back at most
// maxRewindMs, so a very laggy connection can't hit ships from long
// ago (and nobody can be hit more than that long after getting away).
// 200 ms covers ordinary and laggy home connections in testing; 150
// was too little for laggy ones.
const LAG = {
    maxRewindMs: 200,
    historyMs: 500
};

const ROUND_MS = 15 * 60 * 1000;

// The scenery for each round (the maps in public/game.js), in order: a
// lobby's first round is in low orbit, close to Earth, then deep space,
// and so on, so it's never the same map twice running. Everyone in the
// lobby sees the same one. Maps only change the background.
const MAP_NAMES = ["orbit", "space"];

function mapForRound(n) {
    const i = (Math.max(1, Math.floor(Number(n) || 1)) - 1) % MAP_NAMES.length;
    return MAP_NAMES[i];
}

// Between rounds: long enough for the black hole finale and the
// results screen.
const INTERMISSION_MS = 22_000;

// ---- Lobby housekeeping --------------------------------------------

const HEARTBEAT_MS = 30_000;
const LOBBY_EXPIRY_MS = 120_000;

// A pilot whose connection drops (a phone locking, an app switch, a
// Wi-Fi blip, a deploy) comes back to the same lobby, round and score
// within this long, even if they were the only one there. The round
// and everyone's scores are saved every RESUME_SAVE_MS while playing
// (and when the lobby empties), so this survives the lobby restarting.
const RESUME_GRACE_MS = 120_000;
const RESUME_SAVE_MS = 10_000;
const RESERVATION_MS = 15_000;
const STALE_MS = 120_000;

const MAX_MESSAGE_BYTES = 2048;
// Players report up to 20 times a second while maneuvering, plus shots
// and keepalives; this leaves headroom above that.
const RATE_CAPACITY = 60;
const RATE_PER_SECOND = 45;

// Abuse. Every message a player sends counts toward Cloudflare's daily
// request allowance (20 messages = 1 request) even if the game ignores
// it, so a connection that keeps flooding past the rate limit, or
// sends an oversized message, is closed rather than just ignored.
// The real game never comes close.
const FLOOD = {
    windowMs: 5000,
    maxDropped: 100,
    closeCode: 4008
};

// At most this many connections from one IP address per lobby (a
// household or a school on one connection still fits). Cloudflare's
// rate limiting rule on /api/ws (see SETUP.md) is the main defense
// against floods of connections. (IPv6 addresses count by their /64,
// which is one household; see addressGroup.)
const MAX_PER_IP = 6;

// At most this many departed pilots' scores are kept per round (the
// best ones), so the saved round stays well under Cloudflare's
// 128 KiB limit for one stored value however many people come and go.
const MAX_DEPARTED = 200;

// Movement. Ships fly themselves (so steering feels instant), but the
// server won't believe a move faster than any ship can go: boosted and
// in a warp bubble a ship does 15 * 1.35 * 2 = 40.5 units/s. Each ship
// has a distance budget that refills at maxSpeed and holds at most
// maxSpeed * (time since its last report + graceSec) + slack, so uneven
// delivery is forgiven but sending reports faster doesn't buy distance.
// A report further than the budget only counts as far as it allows; if
// the pilot's own idea of where they are drifts too far from the
// server's, they're put back.
const MOVE = {
    maxSpeed: 45,
    graceSec: 0.3,
    slack: 3,
    maxGapMs: 1500,
    correctAt: 10
};

const MATCHMAKER_NAME = "global";

// A player can change their callsign at most this often.
const RENAME_COOLDOWN_MS = 3000;

// Close code sent to a connection that the same browser has replaced
// (a reload, or the game opened in another tab). The game doesn't
// reconnect after it.
const CLOSE_REPLACED = 4001;

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
    // A ship that hasn't reported flying (st 1) for this long is treated
    // as absent (not shown, no collisions, nothing spawned for it, can't
    // fire). Leaving the game (st 0 or 2, or going quiet) takes this long
    // to count, so it can't be used to dodge shots mid-fight.
    presentMs: 3000,
    // How far a reported shot origin may be from where the server
    // thinks the ship is.
    maxShotOffset: 6
};

const WEAPON = { BLASTER: 0, LASER: 1, ROCKETS: 2 };

// How many ship designs pilots can pick from (SHIP_DESIGNS in game.js).
const SHIP_DESIGNS = 4;

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

// Score farming (one player shooting their own second ship over and
// over). Pilots on the same IP address (or IPv6 /64) score nothing off
// each other, and each kill of the same pilot in a round is worth less:
// full, half, a quarter, then nothing (hits on them follow suit).
const PVP = {
    repeatKillValue: [1, 0.5, 0.25]
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

// A flying saucer visits a random pilot once or twice a round (see
// UFO VISITS). Times are from the start of the round, in ms.
const UFO_VISITS = {
    first: [2 * 60_000, 6 * 60_000],
    second: [8 * 60_000, 12 * 60_000],
    secondChance: 0.65,

    // No pilot around to visit: try again this much later.
    retryMs: 20_000,

    // Not in the last minute of a round.
    notAfterMs: ROUND_MS - 60_000
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

// Is a connection's Origin (the page it comes from) one of the game's
// own? Compared by site name and port, so the same site counts
// whether the page was opened as http:// or https:// (some browsers
// open http:// links as they are, others upgrade them).
function originAllowed(origin, list) {
    const site = (value) => {
        try {
            const u = new URL(String(value).trim());
            return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : null;
        } catch {
            return null;
        }
    };

    const wanted = site(origin);
    if (!wanted) return false;

    return String(list).split(",").some((entry) => site(entry) === wanted);
}

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

    if (env.ALLOWED_ORIGINS && !originAllowed(request.headers.get("Origin"), env.ALLOWED_ORIGINS)) {
        console.warn(`Refused a connection from origin ${request.headers.get("Origin") ?? "(none)"}`);
        return new Response("Origin not allowed", { status: 403 });
    }

    // A player reconnecting asks to go back to the lobby they were in.
    const wanted = url.searchParams.get("lobby");
    const preferred = wanted && LOBBY_ID_PATTERN.test(wanted) ? wanted : null;

    try {
        const matchmaker = env.MATCHMAKER.get(
            env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        const tried = [];

        // A returning player whose old connection may still be open
        // (a reload, another tab) goes straight to their old lobby: it
        // replaces that connection even when the lobby is full, so it
        // can't linger as a ghost. The lobby only accepts this if it
        // really finds their old connection; otherwise (e.g. they're
        // back the next day) normal matchmaking below takes over.
        if (preferred && url.searchParams.get("token")) {
            const headers = new Headers(request.headers);
            headers.set("X-Lobby-Id", preferred);
            headers.set("X-Replace-Only", "1");

            const lobby = env.LOBBY.get(env.LOBBY.idFromName(preferred));
            const response = await lobby.fetch(new Request(request.url, { headers }));

            if (response.status === 101) {
                return response;
            }

            // 409 (nothing to replace): normal matchmaking still prefers
            // this lobby if it has room. 503 (full): try elsewhere.
            if (response.status === 503) tried.push(preferred);
        }

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

            // Too many connections from this address: don't go looking
            // for another lobby to fill.
            if (response.status === 429) {
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
                name: String(entry.name ?? "PILOT").slice(0, 20),
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

        // An empty lobby stays listed (count 0) until it expires, so a
        // pilot whose connection dropped can go back to it.
        this.lobbies.set(lobbyId, {
            count: count > 0 ? Math.min(MAX_PLAYERS, Math.floor(count)) : 0,
            reserved: 0,
            reservedAt: now,
            updatedAt: now
        });

        this.prune(now);
        await this.save();

        // The all-time list rides back on the lobby's regular check-in,
        // so every open game sees a new record within about 30 s, at no
        // extra cost.
        return { top: this.records.map(publicRecord), minimum: this.minimumScore() };
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

        // Sockets replaced by a newer connection from the same browser.
        // They can be listed for a moment while they close; they're
        // ignored everywhere. (Also flagged in the socket's attachment,
        // in case this object restarts meanwhile.)
        this.replaced = new WeakSet();

        // Scores of players who dropped this round, by token, so a
        // reconnect keeps its score.
        this.departed = new Map();

        this.timer = null;
        this.lastStepAt = 0;
        this.stepCount = 0;
        this.lastStaleCheck = 0;

        // The leaderboard as last sent, and when (see STANDINGS_MIN_MS).
        this.lastStandings = "";
        this.lastStandingsAt = 0;

        // The score needed to reach the all-time top 10, as last heard
        // from the Matchmaker. Players who leave below it aren't
        // reported, which saves a request.
        this.recordMinimum = 0;

        // The all-time list as last sent to this lobby's players, and a
        // fingerprint of it, so it's only re-sent when it changes.
        this.lastRecords = null;
        this.lastRecordsKey = "";

        this.resetWorld();
        this.round = null;

        // The movement check (MOVE). Only the automated tests turn it
        // off, so they can put ships anywhere.
        this.moveCheck = env?.MOVE_CHECK !== "off";

        // When the last pilot left (see RESUME_GRACE_MS), and the saved
        // round from before a restart, if any.
        this.emptiedAt = 0;
        this.resume = null;
        this.lastResumeSave = 0;

        ctx.blockConcurrencyWhile(async () => {
            try {
                this.resume = (await ctx.storage.get("resume")) ?? null;
            } catch {
                this.resume = null;
            }
        });
    }

    // ---------------------------------------------------------
    // KEEPING THE ROUND THROUGH DROPPED CONNECTIONS
    // ---------------------------------------------------------

    // Save the round and every pilot's score (connected or recently
    // departed), so the lobby can carry on after a restart.
    saveResume(now) {
        if (!this.round || this.round.phase !== "playing") return;

        this.lastResumeSave = now;

        const scores = [];

        for (const [token, d] of this.departed) {
            scores.push([token, d.score, d.kills, d.deaths, d.nextWarp, d.x ?? null, d.z ?? null, d.clanName ?? null]);
        }

        for (const s of this.ships.values()) {
            if (s.token) scores.push([s.token, s.score, s.kills, s.deaths, s.nextWarp, round2(s.x), round2(s.z), s.clanName]);
        }

        const resume = {
            savedAt: now,
            round: { n: this.round.n, map: this.round.map, startedAt: this.round.startedAt, endsAt: this.round.endsAt },
            scores
        };

        this.resume = resume;
        this.ctx.storage.put("resume", resume).catch(() => {});
    }

    // A round to carry on with: this one, if the lobby emptied only a
    // moment ago, or the saved one after a restart. Returns true if
    // there was one.
    resumeRound(now) {
        const live = this.round && this.round.phase === "playing" && now < this.round.endsAt;

        if (live && this.emptiedAt && now - this.emptiedAt < RESUME_GRACE_MS) {
            return true;
        }

        const saved = this.resume;

        if (
            !saved?.round ||
            now - saved.savedAt > RESUME_GRACE_MS ||
            now >= saved.round.endsAt
        ) {
            return false;
        }

        this.resetWorld();
        this.departed.clear();

        const map = MAP_NAMES.includes(saved.round.map) ? saved.round.map : mapForRound(saved.round.n);

        this.round = {
            n: saved.round.n,
            map,
            phase: "playing",
            startedAt: saved.round.startedAt,
            endsAt: saved.round.endsAt,
            nextAt: 0,
            results: null
        };

        for (const [token, score, kills, deaths, nextWarp, x, z, clanName] of saved.scores ?? []) {
            if (typeof token !== "string") continue;

            this.departed.set(token, {
                round: saved.round.n,
                score: Number(score) || 0,
                kills: Number(kills) || 0,
                deaths: Number(deaths) || 0,
                nextWarp: Number(nextWarp) || WARP.scoreInterval,
                x: Number.isFinite(x) ? x : null,
                z: Number.isFinite(z) ? z : null,
                clanName: typeof clanName === "string" ? clanName : null
            });
        }

        this.trimDeparted();

        this.scheduleUfo(now);
        return true;
    }

    // Same player back in the same round: their score (and roughly
    // where they were). Returns their old position, or null.
    restoreDeparted(ship) {
        const previous = ship.token ? this.departed.get(ship.token) : null;
        if (!previous || previous.round !== this.round?.n) return null;

        ship.score = previous.score;
        ship.kills = previous.kills;
        ship.deaths = previous.deaths;
        ship.nextWarp = previous.nextWarp;

        // The clan tag they last spawned with (a rename and a reload
        // doesn't change sides any sooner than a respawn would).
        if (previous.clanName) ship.clanName = previous.clanName;

        this.departed.delete(ship.token);

        return Number.isFinite(previous.x) && Number.isFinite(previous.z)
            ? { x: previous.x, z: previous.z }
            : null;
    }

    // Keep only the best MAX_DEPARTED departed scores.
    trimDeparted() {
        if (this.departed.size <= MAX_DEPARTED) return;

        const worst = [...this.departed]
            .sort((a, b) => a[1].score - b[1].score)
            .slice(0, this.departed.size - MAX_DEPARTED);

        for (const [token] of worst) this.departed.delete(token);
    }

    // ---------------------------------------------------------
    // CONNECTIONS
    // ---------------------------------------------------------

    async fetch(request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Expected a WebSocket upgrade", { status: 426 });
        }

        const lobbyId = request.headers.get("X-Lobby-Id");

        // (A replace-only probe of an empty lobby shouldn't write
        // anything: it's about to be refused.)
        if (lobbyId && !this.lobbyId && !request.headers.get("X-Replace-Only")) {
            this.lobbyId = lobbyId;
            await this.ctx.storage.put("lobbyId", lobbyId);
        }

        const url = new URL(request.url);
        const token = sanitizeToken(url.searchParams.get("token"));

        // The same browser connecting again (a reload, or another tab):
        // its old connection is replaced, so it's one pilot, not two.
        // Its score carries over (removePlayer keeps it for this round).
        // Done with no await before the accept below, like the capacity
        // check.
        let replacedAny = false;

        if (token) {
            for (const old of this.liveSockets()) {
                if (readAttachment(old)?.token !== token) continue;

                this.removePlayer(old);
                this.markReplaced(old);

                try {
                    old.close(CLOSE_REPLACED, "Replaced by a newer connection");
                } catch {
                    // Already closed.
                }

                replacedAny = true;
            }
        }

        // Asked to join only if replacing an old connection, and there
        // wasn't one: let the Worker use normal matchmaking.
        if (request.headers.get("X-Replace-Only") && !replacedAny) {
            return new Response("No connection to replace", { status: 409 });
        }

        // Capacity check and accept with no await in between.
        const sockets = this.liveSockets();

        if (sockets.length >= MAX_PLAYERS) {
            return new Response("Lobby full", { status: 503 });
        }

        const ip = request.headers.get("CF-Connecting-IP");

        const address = addressGroup(ip);

        if (address && sockets.filter((ws) => addressGroup(readAttachment(ws)?.ip) === address).length >= MAX_PER_IP) {
            console.warn(`Refused a connection: already ${MAX_PER_IP} from one address in this lobby`);
            return new Response("Too many connections", { status: 429 });
        }

        const now = Date.now();

        // First player into an empty lobby: a fresh world and round,
        // unless pilots were here a moment ago (or before a restart):
        // then the same round carries on, scores and all. (Not when the
        // only player just reconnected.)
        if (sockets.length === 0 && !replacedAny) {
            this.ships.clear();

            if (!this.resumeRound(now)) {
                this.resetWorld();
                this.departed.clear();
                this.round = null;
            }
        }

        if (!this.round && !this.resumeRound(now)) {
            this.startRound(1, now, false);
        }

        this.emptiedAt = 0;

        const name = sanitizeName(url.searchParams.get("name"));

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
        server.serializeAttachment({ id, name, color, token, ip });

        const ship = this.newShip({ id, name, color, token, ip }, now);

        // Same player back in the same round: restore their score, and
        // put them back about where they were.
        const wasAt = this.restoreDeparted(ship);

        // Otherwise start near other pilots, so the lobby feels like a
        // lobby.
        const anchor = wasAt ?? this.randomPresentShip();
        const spawn = wasAt && this.isClearSpot(wasAt.x, wasAt.z, now)
            ? wasAt
            : this.chooseSpawn(anchor?.x ?? 0, anchor?.z ?? 0, now);

        ship.x = spawn.x;
        ship.z = spawn.z;

        this.ships.set(server, ship);

        const players = [];

        for (const ws of this.liveSockets()) {
            const info = readAttachment(ws);
            if (info && ws !== server) {
                const cn = this.ships.get(ws)?.clanName ?? info.name;
                players.push({ id: info.id, name: info.name, color: info.color, cn });
            }
        }

        safeSend(server, {
            t: "welcome",
            v: PROTOCOL_VERSION,
            id,
            name,
            cn: ship.clanName,
            color,
            max: MAX_PLAYERS,
            lobby: this.lobbyId,
            now,
            players,
            round: this.roundInfo(),
            you: this.youInfo(ship, true),
            world: this.worldMessage(now),

            // The all-time list, if this lobby has heard it yet (fresher
            // than the page's cached copy).
            records: this.lastRecords
        });

        this.broadcast({ t: "join", p: { id, name, color, cn: ship.clanName } }, server);

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

    isReplaced(ws) {
        return this.replaced.has(ws) || Boolean(readAttachment(ws)?.replaced);
    }

    markReplaced(ws) {
        this.replaced.add(ws);

        const info = readAttachment(ws);

        if (info) {
            try {
                ws.serializeAttachment({ ...info, replaced: true });
            } catch {
                // Closed already; the WeakSet covers it.
            }
        }
    }

    // Connected players' sockets (not ones being replaced).
    liveSockets() {
        return this.ctx.getWebSockets().filter((ws) => !this.isReplaced(ws));
    }

    removePlayer(ws) {
        // Already removed when it was replaced.
        if (this.isReplaced(ws)) {
            this.ships.delete(ws);
            return;
        }

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
                nextWarp: ship.nextWarp,
                x: round2(ship.x),
                z: round2(ship.z),
                clanName: ship.clanName
            });

            this.trimDeparted();
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

        const remaining = this.liveSockets().filter((s) => s !== ws);

        if (remaining.length === 0) {
            this.stopTimer();

            // Keep the round for anyone coming straight back.
            this.emptiedAt = Date.now();
            this.saveResume(this.emptiedAt);
        }
    }

    // Close an abusive connection.
    kick(ws, reason) {
        console.warn(`Closing a connection: ${reason}`);

        try {
            ws.close(FLOOD.closeCode, reason);
        } catch {
            // Already closed.
        }

        this.removePlayer(ws);
        this.reportCount().catch(() => {});
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
            if (!info || info.replaced || this.replaced.has(ws)) return null;

            const now = Date.now();

            if (!this.round && !this.resumeRound(now)) this.startRound(1, now, false);

            ship = this.newShip(info, now);
            this.restoreDeparted(ship);
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

            // Whose clan tag counts for friendly fire: the name at the
            // last (re)spawn, so a rename mid-fight can't shield anyone.
            clanName: info.name,

            // The connection's address, grouped (see PVP).
            address: addressGroup(info.ip),

            x: 0,
            z: 0,
            r: 0,
            vx: 0,
            vz: 0,
            th: 0,
            st: 0,
            weapon: 0,
            design: 0,
            stateAt: now,

            // The last report of flying (st 1); see SHIP.presentMs.
            playingAt: 0,

            // Distance the ship may still move (see MOVE).
            moveBudget: MOVE.maxSpeed * MOVE.graceSec + MOVE.slack,

            // Increases on every (re)spawn; position reports from an
            // older life are ignored.
            life: 1,
            alive: true,
            hull: SHIP.hull,
            respawnAt: 0,
            shieldUntil: now + SHIP.spawnShieldMs,
            hitCooldownUntil: 0,
            warpUntil: 0,
            cloaked: false,

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
            // The game never sends these.
            this.kick(ws, "Message too large");
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

        if (ship.tokens < 1) {
            // Over the limit: ignored, and if it keeps up, closed.
            if (now - (ship.floodAt ?? 0) > FLOOD.windowMs) {
                ship.floodAt = now;
                ship.dropped = 0;
            }

            ship.dropped = (ship.dropped ?? 0) + 1;

            if (ship.dropped > FLOOD.maxDropped) {
                this.kick(ws, "Too many messages");
            }

            return;
        }

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
            safeSend(ws, { t: "name", id: ship.id, name: ship.name, cn: ship.clanName, rejected: "wait" });
            return;
        }

        ship.lastRename = now;

        const result = checkName(data.name);

        if (!result.ok) {
            safeSend(ws, { t: "name", id: ship.id, name: ship.name, cn: ship.clanName, rejected: result.reason });
            return;
        }

        if (result.name === ship.name) {
            safeSend(ws, { t: "name", id: ship.id, name: ship.name, cn: ship.clanName });
            return;
        }

        ship.name = result.name;

        const info = readAttachment(ws);

        if (info) {
            ws.serializeAttachment({ ...info, name: result.name });
        }

        // (A new clan tag only counts from the next respawn: see
        // placeShip.)
        this.broadcast({ t: "name", id: ship.id, name: result.name, cn: ship.clanName });
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

        // Which ship design this pilot flies (0 = starfighter).
        ship.design = Math.round(finite(data.d, 0, SHIP_DESIGNS - 1) ?? 0);

        // While dead, the ship stays where it was destroyed.
        if (!ship.alive) return;

        // The cloak: only once it's unlocked.
        ship.cloaked = Number(data.ck) === 1 && cloakUnlocked(ship.score);

        // No faster than a ship can fly (see MOVE).
        let nx = x;
        let nz = z;

        if (this.moveCheck && this.round?.phase === "playing") {
            const gap = Math.min(Math.max(0, now - ship.stateAt), MOVE.maxGapMs) / 1000;

            ship.moveBudget = Math.min(
                MOVE.maxSpeed * (gap + MOVE.graceSec) + MOVE.slack,
                ship.moveBudget + MOVE.maxSpeed * gap
            );

            const allowed = ship.moveBudget;
            const dx = x - ship.x;
            const dz = z - ship.z;
            const far = Math.hypot(dx, dz);

            ship.moveBudget -= Math.min(far, allowed);

            if (far > allowed) {
                nx = ship.x + (dx / far) * allowed;
                nz = ship.z + (dz / far) * allowed;

                // Too far apart: put the pilot back where the server
                // has them.
                if (far - allowed > MOVE.correctAt) {
                    ship.spawnMoved = true;
                    ship.dirty = true;
                }
            }
        }

        let vx = finite(data.vx, -80, 80) ?? 0;
        let vz = finite(data.vz, -80, 80) ?? 0;
        const speed = Math.hypot(vx, vz);

        if (speed > MOVE.maxSpeed) {
            vx *= MOVE.maxSpeed / speed;
            vz *= MOVE.maxSpeed / speed;
        }

        ship.x = round2(clamp(nx, -HALF_W, HALF_W));
        ship.z = round2(clamp(nz, -HALF_H, HALF_H));
        ship.r = round2(r % (Math.PI * 2));
        ship.vx = round2(vx);
        ship.vz = round2(vz);
        ship.th = Math.round(finite(data.th, -1, 1) ?? 0);
        ship.stateAt = now;

        if (ship.st === 1) ship.playingAt = now;
    }

    onFire(ship, data, now) {
        if (!this.round || this.round.phase !== "playing") return;
        if (!ship.alive) return;

        // Only a ship that's flying, and so can be seen and hit.
        if (ship.st !== 1 || !this.isPresent(ship, now)) return;

        // No weapons while cloaked.
        if (ship.cloaked) return;

        const weapon = Math.round(finite(data.w, 0, 2) ?? -1);
        if (weapon < 0) return;

        if (weapon === WEAPON.LASER && ship.score < LASER.unlockScore) return;
        if (weapon === WEAPON.ROCKETS && ship.score < ROCKET.unlockScore) return;

        const cooldown = [BULLET.cooldownMs, LASER.cooldownMs, ROCKET.cooldownMs][weapon];

        if (now - ship.lastFire[weapon] < cooldown) return;
        ship.lastFire[weapon] = now;

        // How far back the shooter's view of the other ships was (see
        // LAG).
        const viewedAt = Number(data.vt);
        const rewind = Number.isFinite(viewedAt)
            ? clamp(now - viewedAt, 0, LAG.maxRewindMs)
            : 0;

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
                life: BULLET.life,
                rewind
            });

            this.event(["b", ship.id, round2(x), round2(z), round2(r)]);
        } else if (weapon === WEAPON.LASER) {
            const beam = {
                owner: ship,
                rewind,
                ox: x,
                oz: z,
                dx,
                dz,
                range: LASER.range,
                life: LASER.life,
                hit: new Set()
            };

            // A UFO's shield stops the beam: nothing past it is hit.
            const ufo = this.ufoShield(now);

            if (ufo) {
                const along = segmentHit(x, z, dx, dz, LASER.range, ufo.x, ufo.z, UFO.shieldRadius);

                if (along >= 0) {
                    beam.range = along;
                    this.event(["uh", round2(x + dx * along), round2(z + dz * along), ship.id, 1]);
                    this.ufoAttacked(ship, now);
                }
            }

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

            this.recordShipHistory(now);

            if (now - this.lastResumeSave > RESUME_SAVE_MS) this.saveResume(now);
        } catch (error) {
            // Keep the lobby alive; the next step starts clean.
            console.error("Simulation error:", error);
        }

        try {
            if (this.events.length > 0) {
                this.broadcastRaw(JSON.stringify({ t: "ev", now, e: this.events }));
            }

            this.events = [];

            if (this.privateEvents.size > 0) {
                for (const ws of this.ctx.getWebSockets()) {
                    const list = this.privateEvents.get(this.ships.get(ws));
                    if (list) safeSend(ws, { t: "ev", now, e: list });
                }

                this.privateEvents.clear();
            }

            if (this.stepCount % SNAPSHOT_EVERY === 0) {
                this.broadcastRaw(JSON.stringify(this.snapshotMessage(now)));
            }

            this.sendStandings(now);

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
        this.updateUfo(now);
        this.deflectFromUfo(now);
        this.updateMines(dt);
        this.updateCrystals(dt);
        this.updateBullets(dt, now);
        this.updateBeams(dt, now);
        this.updateRockets(dt, now);
        this.updateWarp(now);
        this.shipCollisions(now);
        this.updateRogue(dt, now);

        if (this.stepCount % SPAWN_CHECK_EVERY === 0) {
            this.spawnThings(now);
            this.despawnFarAsteroids();
        }
    }

    // ---------------------------------------------------------
    // UFO VISITS
    // Once or twice a round a flying saucer appears near a random
    // pilot, watches for a while (gliding after them if they fly off)
    // and then leaves at an impossible speed. Its shield absorbs every
    // shot and turns asteroids aside; nothing can hurt it, and it hurts
    // nobody. Everything about a visit follows from its plan
    // (public/ufo.js), which is sent to every player ("us" events, and
    // "u" in the world message), so everyone sees the same saucer.
    // ---------------------------------------------------------

    scheduleUfo(now) {
        this.ufo = null;
        this.ufoDue = [now + randomRange(...UFO_VISITS.first)];

        if (Math.random() < UFO_VISITS.secondChance) {
            this.ufoDue.push(now + randomRange(...UFO_VISITS.second));
        }
    }

    updateUfo(now) {
        if (this.ufo) {
            const state = ufoState(this.ufo, now);

            if (state.phase === "gone") {
                // Players finish drawing the departure themselves.
                this.ufo = null;
                return;
            }

            // Hostile: it fires at any ship that comes too close.
            if (this.ufo.h) this.ufoDefend(state, now);

            // Keep watching the pilot it came to see.
            const watched = this.findShip(this.ufo.w);

            // (Not while they're cloaked: it would give them away.)
            if (watched && watched.alive && !watched.cloaked && this.isPresent(watched, now)) {
                const p = this.shipPosition(watched, now);

                if (ufoFollow(this.ufo, Math.random, p.x, p.z, now, HALF_W, HALF_H)) {
                    this.event(["us", this.ufo]);
                }
            }

            return;
        }

        if (this.ufoDue.length === 0 || now < this.ufoDue[0]) return;

        const roundTime = now - (this.round?.startedAt ?? now);

        if (roundTime > UFO_VISITS.notAfterMs) {
            this.ufoDue = [];
            return;
        }

        const ship = this.randomPresentShip();

        if (!ship) {
            this.ufoDue[0] = now + UFO_VISITS.retryMs;
            return;
        }

        this.ufoDue.shift();

        const p = this.shipPosition(ship, now);

        this.ufoAnger = 0;
        this.ufoNextShot = 0;

        this.ufo = createUfoPlan(Math.random, {
            id: ++this.ufoCount,
            startMs: now,
            x: p.x,
            z: p.z,
            halfW: HALF_W,
            halfH: HALF_H,
            watch: ship.id
        });

        this.event(["us", this.ufo]);
    }

    // Something hit the UFO's shield: it fires back at whoever did it
    // (bullets still in flight from a ship it already destroyed don't
    // count). Attacked angerLimit times, it turns hostile.
    ufoAttacked(attacker, now) {
        if (!this.ufo || !attacker || !attacker.alive) return;
        if (![...this.ships.values()].includes(attacker)) return;

        this.ufoZap(attacker, now);

        this.ufoAnger = (this.ufoAnger ?? 0) + 1;

        if (this.ufoAnger >= UFO.angerLimit && !this.ufo.h) {
            this.ufo.h = 1;
            this.ufoNextShot = now + UFO.hostileShotMs;
            this.event(["us", this.ufo]);
        }
    }

    // Hostile: one shot at a time at the nearest ship in range (not
    // one that has just respawned and is still shielded).
    ufoDefend(state, now) {
        if (!state.solid || now < (this.ufoNextShot ?? 0)) return;
        if (state.phase !== "observe" && state.phase !== "charge") return;

        let target = null;
        let nearest = UFO.hostileRadius;

        for (const s of this.ships.values()) {
            if (!this.isPresent(s, now) || now < s.shieldUntil) continue;

            const p = this.shipPosition(s, now);
            const d = Math.hypot(p.x - state.x, p.z - state.z);

            if (d < nearest) {
                nearest = d;
                target = s;
            }
        }

        if (!target) return;

        this.ufoNextShot = now + UFO.hostileShotMs;
        this.ufoZap(target, now);
    }

    // A plasma beam from the UFO destroys the ship outright (no shield
    // or warp bubble stops it).
    ufoZap(ship, now) {
        const state = ufoState(this.ufo, now);
        const p = this.shipPosition(ship, now);

        this.event(["up", round2(state.x), round2(state.z), ship.id, round2(p.x), round2(p.z)]);
        this.damageShip(ship, ship.hull, null, now, "ufo");
    }

    // The UFO's position while its shield is up (stopping shots), or
    // null.
    ufoShield(now) {
        if (!this.ufo) return null;

        const state = ufoState(this.ufo, now);

        return state.solid ? state : null;
    }

    // Asteroids glance off the shield (players see the "au" update).
    deflectFromUfo(now) {
        const ufo = this.ufoShield(now);
        if (!ufo) return;

        for (const a of this.asteroids) {
            const dx = a.x - ufo.x;
            const dz = a.z - ufo.z;
            const reach = UFO.shieldRadius + a.radius;
            const d = Math.hypot(dx, dz);

            if (d >= reach || d < 1e-6) continue;

            const nx = dx / d;
            const nz = dz / d;

            a.x = ufo.x + nx * reach;
            a.z = ufo.z + nz * reach;

            const toward = a.vx * nx + a.vz * nz;

            if (toward < 0) {
                a.vx -= 2 * toward * nx;
                a.vz -= 2 * toward * nz;
            }

            this.event(["au", a.id, round2(a.x), round2(a.z), round2(a.vx), round2(a.vz)]);
        }
    }

    findShip(id) {
        if (id === null || id === undefined) return null;

        for (const s of this.ships.values()) {
            if (s.id === id) return s;
        }

        return null;
    }

    // ---------------------------------------------------------
    // ROUNDS
    // ---------------------------------------------------------

    startRound(n, now, announce = true) {
        this.resetWorld();
        this.departed.clear();

        // Orbit first, then alternating (see MAP_NAMES).
        const map = mapForRound(n);

        this.round = {
            n,
            map,
            phase: "playing",
            startedAt: now,
            endsAt: now + ROUND_MS,
            nextAt: 0,
            results: null
        };

        this.scheduleUfo(now);

        for (const ship of this.ships.values()) {
            ship.score = 0;
            ship.kills = 0;
            ship.deaths = 0;
            ship.nextWarp = WARP.scoreInterval;
            ship.warpUntil = 0;
            ship.cloaked = false;
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

        // A visiting UFO leaves as the round ends (the black hole).
        this.ufoDue = [];

        if (this.ufo && ufoLeave(this.ufo, now)) {
            this.event(["us", this.ufo]);
        }

        this.bullets = [];
        this.beams = [];
        this.rockets = [];
        this.rogue = newRogue();

        this.broadcast({ t: "round", now, round: this.roundInfo() });

        // Everyone's final score goes to the all-time list; the updated
        // list follows the results a moment later.
        this.reportRecords([...this.ships.values()])
            .then((top) => {
                if (!top) return;

                this.noteRecords(top);
                this.broadcast({ t: "records", top });
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
            map: r.map,
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
        this.privateEvents = new Map();

        // Kills of each pilot by each other pilot this round (see PVP).
        this.killCounts = new Map();

        // The current UFO visit's plan (public/ufo.js), or null, and
        // when the next ones are due.
        this.ufo = null;
        this.ufoDue = [];
        this.ufoCount = 0;
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

        // (A cloaked ship's warp bubble doesn't say whose it is.)
        this.event(["ad", a.id, round2(a.x), round2(a.z), by && !by.cloaked ? by.id : ""]);

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

            const ufo = this.ufoShield(now);
            if (ufo) consider("u", null, ufo.x, ufo.z, UFO.shieldRadius - BULLET.radius);

            for (const s of this.ships.values()) {
                if (!this.isTarget(s, b.owner, now)) continue;

                // Where the shooter saw it.
                const p = this.seenPosition(s, now, b.rewind);
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
                } else if (best.kind === "u") {
                    // Absorbed by the UFO's shield.
                    this.event(["uh", round2(hx), round2(hz), b.owner.id, 0]);
                    this.ufoAttacked(b.owner, now);
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
        const range = beam.range ?? LASER.range;

        const touches = (x, z, radius) => segmentHit(
            beam.ox, beam.oz, beam.dx, beam.dz, range,
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
            if (beam.hit.has(s) || !this.isTarget(s, beam.owner, now)) continue;

            const p = this.seenPosition(s, now, beam.rewind);
            if (!touches(p.x, p.z, SHIP.radius)) continue;

            beam.hit.add(s);

            // (Where a cloaked ship was hit is for its pilot only.)
            if (s.cloaked) this.eventFor(s, ["lh", round2(p.x), round2(p.z)]);
            else this.event(["lh", round2(p.x), round2(p.z)]);

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
                    if (!this.isTarget(s, rocket.owner, now)) continue;

                    const p = this.shipPosition(s, now);

                    if (dist(rocket, p) < SHIP.radius + ROCKET.contactRadius) { contact = true; break; }
                }
            }

            if (!contact) {
                const ufo = this.ufoShield(now);

                if (ufo && dist(rocket, ufo) < UFO.shieldRadius + ROCKET.contactRadius) {
                    contact = true;

                    // It goes off against the shield, not inside it.
                    const d = dist(rocket, ufo) || 1;
                    const hx = ufo.x + ((rocket.x - ufo.x) / d) * UFO.shieldRadius;
                    const hz = ufo.z + ((rocket.z - ufo.z) / d) * UFO.shieldRadius;

                    this.event(["uh", round2(hx), round2(hz), rocket.owner.id, 2]);
                    this.ufoAttacked(rocket.owner, now);
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
            if (!this.isTarget(s, by, now)) continue;

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
            // A cloaked ship can't be locked on to.
            if (s.cloaked || !this.isTarget(s, rocket.owner, now)) continue;

            const p = this.shipPosition(s, now);
            consider("s", s, p.x, p.z);
        }

        return best;
    }

    targetValid(target, owner, now) {
        if (!target) return false;

        if (target.kind === "a") return this.asteroids.includes(target.ref);
        if (target.kind === "m") return this.mines.includes(target.ref);

        return [...this.ships.values()].includes(target.ref) &&
            !target.ref.cloaked &&
            this.canBeHit(target.ref, now);
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

    // Remember where each ship is (the same positions everyone is sent),
    // for lag compensation.
    recordShipHistory(now) {
        for (const s of this.ships.values()) {
            const trail = s.trail ?? (s.trail = []);

            if (!s.alive) {
                trail.length = 0;
                continue;
            }

            const p = this.shipPosition(s, now);
            trail.push([now, p.x, p.z]);

            while (trail.length > 2 && now - trail[0][0] > LAG.historyMs) trail.shift();
        }
    }

    // Where ship `s` was `rewind` ms ago, as the other pilots saw it.
    seenPosition(s, now, rewind = 0) {
        const trail = s.trail;
        if (!rewind || !trail || trail.length === 0) return this.shipPosition(s, now);

        const t = now - rewind;
        const last = trail[trail.length - 1];

        if (t >= last[0]) return this.shipPosition(s, now);
        if (t <= trail[0][0]) return { x: trail[0][1], z: trail[0][2] };

        for (let i = trail.length - 1; i > 0; i--) {
            const a = trail[i - 1];
            const b = trail[i];

            if (t >= a[0]) {
                const k = (t - a[0]) / Math.max(1, b[0] - a[0]);
                return { x: a[1] + (b[1] - a[1]) * k, z: a[2] + (b[2] - a[2]) * k };
            }
        }

        return this.shipPosition(s, now);
    }

    isPresent(ship, now) {
        return ship.alive && now - ship.playingAt < SHIP.presentMs;
    }

    presentShips(now) {
        return [...this.ships.values()].filter((s) => this.isPresent(s, now));
    }

    randomPresentShip() {
        const now = Date.now();
        // Not a cloaked ship (a UFO or the rogue asteroid turning up
        // beside it, or a pilot spawning next to it, would give it away).
        const present = this.presentShips(now).filter((s) => !s.cloaked);

        return present.length ? present[Math.floor(Math.random() * present.length)] : null;
    }

    // Pilots with the same clan tag ([KO]...) are teammates, and a pilot
    // wearing [PASS] is at peace with everyone: they can't hurt each
    // other.
    sameClan(a, b) {
        if (!a || !b || a === b) return false;

        return noFriendlyFire(a.clanName, b.clanName);
    }

    // Can `owner`'s weapons hit ship `s`? Not their own ship, not a
    // teammate, not a ship that can't be hit right now.
    isTarget(s, owner, now) {
        return s !== owner && !this.sameClan(s, owner) && this.canBeHit(s, now);
    }

    canBeHit(ship, now) {
        return this.isPresent(ship, now) &&
            now >= ship.shieldUntil &&
            now >= ship.warpUntil;
    }

    // cause: "rogue" for the rogue asteroid (it ignores the short
    // cooldown between hits, and players are told what got them).
    // cause "ufo": the UFO's plasma beam, which nothing stops and which
    // no pilot gets credit for.
    damageShip(ship, amount, attacker, now, cause = null) {
        if (!ship.alive) return;

        // Teammates never hurt each other.
        if (attacker && this.sameClan(ship, attacker)) return;
        if (cause !== "ufo" && (now < ship.shieldUntil || now < ship.warpUntil)) return;
        if (now < ship.hitCooldownUntil && cause !== "rogue" && cause !== "ufo") return;

        ship.hull = Math.max(0, ship.hull - amount);
        ship.hitCooldownUntil = now + SHIP.hitCooldownMs;
        ship.dirty = true;

        if (attacker && attacker !== ship) {
            ship.lastHitBy = attacker;
            ship.lastHitAt = now;

            const worth = this.pvpWorth(attacker, ship);
            if (worth > 0) this.addScore(attacker, Math.round(POINTS.shipHit * worth));
        }

        const p = this.shipPosition(ship, now);
        const hit = ["sh", ship.id, ship.hull, attacker ? attacker.id : "", round2(p.x), round2(p.z)];

        // A cloaked ship's hit isn't announced: only the pilot, and
        // whoever shot them (without where it was), hear of it.
        if (ship.cloaked && ship.hull > 0) {
            this.eventFor(ship, hit);
            if (attacker && attacker !== ship) this.eventFor(attacker, [...hit.slice(0, 4), null, null]);
        } else {
            this.event(hit);
        }

        if (ship.hull > 0) return;

        // Destroyed. Whoever hit it last (within a few seconds) gets
        // the kill, even if it was finished off by an asteroid.
        let killer = attacker && attacker !== ship ? attacker : null;

        if (!killer && ship.lastHitBy && now - ship.lastHitAt < 5000 && cause !== "ufo") {
            killer = ship.lastHitBy;
        }

        if (killer && ![...this.ships.values()].includes(killer)) killer = null;
        if (killer && this.sameClan(killer, ship)) killer = null;

        ship.alive = false;
        ship.cloaked = false;
        ship.deaths++;
        ship.respawnAt = now + SHIP.respawnMs;
        ship.warpUntil = 0;
        ship.lastHitBy = null;

        if (killer) {
            const worth = this.pvpWorth(killer, ship);
            const key = this.pvpKey(killer, ship);

            this.killCounts.set(key, (this.killCounts.get(key) ?? 0) + 1);

            if (worth > 0) {
                killer.kills++;
                this.addScore(killer, Math.round(POINTS.shipKill * worth));
            }
        }

        this.event(["sk", ship.id, killer ? killer.id : "", round2(p.x), round2(p.z), cause ?? ""]);
    }

    // Kills of `victim` by `attacker` this round are counted under this
    // key (by browser, so reconnecting doesn't reset it).
    pvpKey(attacker, victim) {
        const who = (s) => s.token ?? `id-${s.id}`;
        return `${who(attacker)}>${who(victim)}`;
    }

    // What hitting or killing `victim` is worth to `attacker`, from 1
    // (full points) down to 0 (see PVP).
    pvpWorth(attacker, victim) {
        if (attacker.address && attacker.address === victim.address) return 0;

        const kills = this.killCounts.get(this.pvpKey(attacker, victim)) ?? 0;

        return PVP.repeatKillValue[kills] ?? 0;
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
        ship.moveBudget = MOVE.maxSpeed * MOVE.graceSec + MOVE.slack;
        ship.dirty = true;
        ship.spawnMoved = true;

        // A fresh start: no history from where it was before.
        if (ship.trail) ship.trail.length = 0;

        // A clan tag changed since the last spawn counts from now on.
        if (ship.clanName !== ship.name) {
            ship.clanName = ship.name;
            this.broadcast({ t: "name", id: ship.id, name: ship.name, cn: ship.clanName });
        }
    }

    // Nothing dangerous right here (for putting a returning pilot back
    // where they were).
    isClearSpot(x, z, now) {
        if (Math.abs(x) > HALF_W - 4 || Math.abs(z) > HALF_H - 4) return false;

        for (const a of this.asteroids) if (Math.hypot(a.x - x, a.z - z) < a.radius + 4) return false;
        for (const m of this.mines) if (Math.hypot(m.x - x, m.z - z) < 5) return false;

        if (this.ufo?.h) {
            const u = ufoState(this.ufo, now);
            if (u.phase !== "gone" && Math.hypot(u.x - x, u.z - z) < UFO.hostileRadius + 6) return false;
        }

        return true;
    }

    chooseSpawn(nearX, nearZ, now, self = null) {
        // Near a hostile UFO: look for a spot well outside its range.
        if (this.ufo?.h) {
            const u = ufoState(this.ufo, now);
            const dx = nearX - u.x;
            const dz = nearZ - u.z;
            const d = Math.hypot(dx, dz);
            const want = UFO.hostileRadius + 30;

            if (u.phase !== "gone" && d < want) {
                const k = d > 0.01 ? 1 / d : 0;
                nearX = u.x + (k ? dx * k : 1) * want;
                nearZ = u.z + (k ? dz * k : 0) * want;
            }
        }

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

            // Never inside a hostile UFO's range.
            if (this.ufo?.h) {
                const u = ufoState(this.ufo, now);

                if (u.phase !== "gone" && Math.hypot(u.x - x, u.z - z) < UFO.hostileRadius + 6) clearance = -100;
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

                // Everyone sees a cloaked ship's crystal go, but not who
                // took it.
                if (ship.cloaked) {
                    this.event(["cc", c.id, ""]);
                    this.eventFor(ship, ["cc", c.id, ship.id]);
                } else {
                    this.event(["cc", c.id, ship.id]);
                }

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

            // A direct hit destroys the ship outright (the spawn shield
            // and the warp bubble still protect it).
            const p = this.shipPosition(s, now);
            if (touches(p.x, p.z, SHIP.radius)) this.damageShip(s, s.hull, null, now, "rogue");
        }
    }

    // ---------------------------------------------------------
    // OUTGOING MESSAGES
    // ---------------------------------------------------------

    event(e) {
        this.events.push(e);
    }

    // An event for one pilot only.
    eventFor(ship, e) {
        const list = this.privateEvents.get(ship);

        if (list) list.push(e);
        else this.privateEvents.set(ship, [e]);
    }

    snapshotMessage(now) {
        const players = [];

        for (const s of this.ships.values()) {
            let flags = 0;

            if (this.isPresent(s, now)) flags |= 1;
            if (now < s.warpUntil) flags |= 2;
            if (now < s.shieldUntil) flags |= 4;

            // Where the ship is now, not where it was when it last
            // reported (reports arrive unevenly).
            const p = s.alive ? this.shipPosition(s, now) : s;

            // Cloaked: listed (so it isn't forgotten), but with nothing
            // that would show where it is, or when it gets hurt (always
            // full hull). Flag 8 = cloaked.
            if (s.cloaked && s.alive) {
                players.push([s.id, 0, 0, 0, 0, 0, 0, 8, 0, s.design ?? 0, SHIP.hull]);
                continue;
            }

            // ... then the ship design and hull, so others can draw the
            // right ship in the right state of damage.
            players.push([s.id, round2(p.x), round2(p.z), s.r, s.vx, s.vz, s.th, flags, s.weapon, s.design ?? 0, s.hull]);
        }

        const rockets = this.rockets.map((r) => [
            r.id, r.owner.id, round2(r.x), round2(r.z), round2(r.h)
        ]);

        return { t: "snap", now, p: players, rk: rockets };
    }

    // Everyone's [id, score, kills, deaths], best first.
    standingsRows() {
        return this.standings().map((s) => [s.id, s.score, s.kills, s.deaths]);
    }

    // The leaderboard, if it changed since it was last sent.
    sendStandings(now) {
        if (now - this.lastStandingsAt < STANDINGS_MIN_MS) return;

        const lb = JSON.stringify(this.standingsRows());
        if (lb === this.lastStandings) return;

        this.lastStandings = lb;
        this.lastStandingsAt = now;
        this.broadcastRaw(`{"t":"lb","now":${now},"lb":${lb}}`);
    }

    worldMessage(now) {
        return {
            t: "world",
            now,
            a: this.asteroids.map(asteroidArray),
            m: this.mines.map(mineArray),
            c: this.crystals.map(crystalArray),
            lb: this.standingsRows(),
            u: this.ufo
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
            ck: ship.cloaked ? 1 : 0,
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
            if (ws !== except && !this.replaced.has(ws)) safeSendRaw(ws, payload);
        }
    }

    async reportCount() {
        if (!this.lobbyId) {
            this.lobbyId = (await this.ctx.storage.get("lobbyId")) ?? null;
        }

        if (!this.lobbyId) return;

        const count = this.liveSockets()
            .filter((ws) => ws.readyState === WebSocket.OPEN)
            .length;

        const matchmaker = this.env.MATCHMAKER.get(
            this.env.MATCHMAKER.idFromName(MATCHMAKER_NAME)
        );

        const result = await matchmaker.report(this.lobbyId, count);

        if (result && Array.isArray(result.top)) {
            this.recordMinimum = Number(result.minimum) || 0;

            if (this.noteRecords(result.top) && count > 0) {
                this.broadcast({ t: "records", top: result.top, sync: true });
            }
        }
    }

    // Remember the latest all-time list. True if it changed.
    noteRecords(top) {
        const key = top.map((r) => `${r.at}:${r.score}:${r.name}`).join("|");

        this.lastRecords = top.map(publicRecord);

        if (key === this.lastRecordsKey) return false;

        this.lastRecordsKey = key;
        return true;
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

// An IP address, or for IPv6 its /64 (one household's network: each
// device there can have its own address), or null. Also null for this
// computer's own address (wrangler dev), so pilots tested side by side
// on one machine count as different players; real connections through
// Cloudflare never come from there.
function addressGroup(ip) {
    if (typeof ip !== "string" || ip === "") return null;

    const lower = ip.toLowerCase();
    if (/^(::ffff:)?127\./.test(lower) || lower === "::1") return null;

    if (!ip.includes(":")) return ip;

    const [head, tail] = ip.toLowerCase().split("::");
    const front = head ? head.split(":") : [];
    const back = tail ? tail.split(":") : [];
    const middle = tail === undefined ? [] : Array(Math.max(0, 8 - front.length - back.length)).fill("0");

    return [...front, ...middle, ...back]
        .slice(0, 4)
        .map((part) => part.replace(/^0+(?=.)/, ""))
        .join(":") + "::/64";
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
export const _internals = { addressGroup, PVP, MAP_NAMES, mapForRound, segmentHit, LASER, ROCKET, BULLET, SHIP, POINTS, ROUND_MS, INTERMISSION_MS, RECORDS_SIZE, CLOSE_REPLACED, UFO_VISITS };
