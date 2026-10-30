/*
============================================================
ASTEROID DEFENSE: UFO VISITS (shared by the game and the server)

Once or twice a game, a flying saucer appears near a pilot, hovers
and watches for a while, then charges up and leaves at an impossible
speed. Nothing can hurt it: its shield absorbs every shot.

A visit is a small "plan" (plain JSON) and everything about it, where
the saucer is, what it's doing, whether shots hit its shield, is
worked out from the plan and the clock. The server (src/index.js)
makes the plans online and sends them to everyone, so every pilot in
a lobby sees the same saucer in the same place; in a solo game,
game.js makes them itself.

Plan:
  id     visit number
  s      start time (ms; server time online)
  o      seconds spent watching
  d      departure direction (radians)
  a      hover phase (radians), so visits don't all look alike
  w      who it's watching (ship id online; null solo)
  legs   [[ms, x, z], ...]: where it hovers, from each time on. A new
         leg is added when the watched pilot flies away, and it glides
         over to keep watching.
  f      (optional) time (ms) it was told to leave early (end of a
         round, or the black hole)
  h      (optional) 1 once it has turned hostile (it was attacked
         UFO.angerLimit times)
============================================================
*/

export const UFO = {
    // The shield's hit circle (world units). The saucer is about 3.4
    // across; shots stop here, a little outside the hull.
    shieldRadius: 2.6,

    // Materializing (seconds). Shots pass through for the first part,
    // while it's still mostly not there.
    arriveSec: 1.8,
    solidAfterSec: 0.7,

    // Watching (seconds), chosen per visit.
    observeMin: 16,
    observeMax: 22,

    // Powering up before leaving.
    chargeSec: 1.5,

    // Leaving: a short drift backward, then gone.
    windupSec: 0.28,
    windupDistance: 0.9,
    zoomSec: 0.4,
    zoomDistance: 1600,

    // Lazy figure-eight around the hover point.
    hoverRadius: 2.2,
    hoverSpeed: 0.55,

    // Gliding to a new hover point (seconds).
    glideSec: 2.6,

    // Where it appears, relative to the pilot it watches: up to this
    // far to the side, and between these distances ahead/behind (so
    // it's on screen even on a phone held upright).
    sideways: 6,
    nearAhead: 7.5,
    farAhead: 10.5,

    // A new hover point once the pilot is this far from the current
    // one, at most this often (ms), and at most this many legs.
    followDistance: 15,
    followEveryMs: 3000,
    maxLegs: 10,

    // Shoot it and it fires back: a plasma beam that destroys the
    // attacker outright. After this many attackers it turns hostile and
    // fires at any ship that comes within hostileRadius (one shot every
    // hostileShotMs), until it leaves.
    angerLimit: 3,
    hostileRadius: 14,
    hostileShotMs: 900
};

// Seconds from the start until each phase ends.
function phaseTimes(plan) {
    const arrive = UFO.arriveSec;
    let observeEnd = arrive + plan.o;

    // Told to leave early: start charging now (but not before it has
    // finished arriving).
    if (Number.isFinite(plan.f)) {
        observeEnd = Math.max(arrive, Math.min(observeEnd, (plan.f - plan.s) / 1000));
    }

    const chargeEnd = observeEnd + UFO.chargeSec;
    const windupEnd = chargeEnd + UFO.windupSec;
    const goneAt = windupEnd + UFO.zoomSec;

    return { arrive, observeEnd, chargeEnd, windupEnd, goneAt };
}

/** Milliseconds from the plan's start until the saucer is gone. */
export function ufoDuration(plan) {
    return phaseTimes(plan).goneAt * 1000;
}

/** A point near (x, z) where a visit can hover, inside the world. */
export function ufoHoverPoint(random, x, z, halfW, halfH) {
    const side = (random() * 2 - 1) * UFO.sideways;
    const ahead = (UFO.nearAhead + random() * (UFO.farAhead - UFO.nearAhead)) * (random() < 0.5 ? -1 : 1);

    const margin = UFO.shieldRadius + UFO.hoverRadius + 1;

    return [
        clamp(x + side, -halfW + margin, halfW - margin),
        clamp(z + ahead, -halfH + margin, halfH - margin)
    ];
}

/**
 * A new visit near (x, z), starting at `startMs`.
 * `random` is a function returning [0, 1) (Math.random).
 */
export function createUfoPlan(random, { id, startMs, x, z, halfW, halfH, watch = null }) {
    const [hx, hz] = ufoHoverPoint(random, x, z, halfW, halfH);

    return {
        id,
        s: startMs,
        o: round2(UFO.observeMin + random() * (UFO.observeMax - UFO.observeMin)),
        d: round3(random() * Math.PI * 2),
        a: round3(random() * Math.PI * 2),
        w: watch,
        legs: [[startMs, round2(hx), round2(hz)]]
    };
}

/**
 * Glide to keep watching a pilot now at (x, z), if they've flown far
 * enough away. Returns true if the plan changed.
 */
export function ufoFollow(plan, random, x, z, nowMs, halfW, halfH) {
    const state = ufoState(plan, nowMs);

    if (state.phase !== "observe") return false;
    if (plan.legs.length >= UFO.maxLegs) return false;

    const last = plan.legs[plan.legs.length - 1];

    if (nowMs - last[0] < UFO.followEveryMs) return false;
    if (Math.hypot(x - last[1], z - last[2]) < UFO.followDistance) return false;

    // Don't start a glide that would still be going when it leaves.
    const times = phaseTimes(plan);
    if ((nowMs - plan.s) / 1000 + UFO.glideSec > times.observeEnd) return false;

    const [hx, hz] = ufoHoverPoint(random, x, z, halfW, halfH);
    plan.legs.push([nowMs, round2(hx), round2(hz)]);

    return true;
}

/** Tell a visit to leave now (if it isn't already leaving). */
export function ufoLeave(plan, nowMs) {
    if (Number.isFinite(plan.f) && plan.f <= nowMs) return false;

    const state = ufoState(plan, nowMs);
    if (state.phase !== "arrive" && state.phase !== "observe") return false;

    plan.f = nowMs;
    return true;
}

function smooth(t) {
    const k = clamp(t, 0, 1);
    return k * k * (3 - 2 * k);
}

// The hover point at time `nowMs` (gliding between legs).
function anchorAt(plan, nowMs) {
    const legs = plan.legs;

    let x = legs[0][1];
    let z = legs[0][2];

    for (let i = 1; i < legs.length; i++) {
        const [t, lx, lz] = legs[i];
        if (nowMs < t) break;

        const k = smooth((nowMs - t) / (UFO.glideSec * 1000));

        x += (lx - x) * k;
        z += (lz - z) * k;
    }

    return [x, z];
}

/**
 * Where the saucer is and what it's doing at `nowMs`:
 *   phase      "waiting" | "arrive" | "observe" | "charge" | "depart" | "gone"
 *   x, z       position
 *   progress   0..1 through the current phase
 *   t          seconds since the start
 *   solid      true when its shield stops shots
 *   dirX/dirZ  departure direction
 */
export function ufoState(plan, nowMs) {
    const t = (nowMs - plan.s) / 1000;
    const times = phaseTimes(plan);

    const dirX = Math.sin(plan.d);
    const dirZ = Math.cos(plan.d);

    const out = { phase: "gone", x: 0, z: 0, progress: 1, t, solid: false, dirX, dirZ };

    if (t < 0) {
        out.phase = "waiting";
        out.progress = 0;
        [out.x, out.z] = anchorAt(plan, plan.s);
        return out;
    }

    if (t >= times.goneAt) return out;

    // The hover point plus a lazy figure-eight. The figure-eight eases
    // in as it arrives and out as it charges.
    const freeze = Math.min(nowMs, plan.s + times.chargeEnd * 1000);
    const [ax, az] = anchorAt(plan, freeze);

    const ht = Math.min(t, times.chargeEnd);
    const swing = smooth(ht / times.arrive) * (1 - smooth((ht - times.observeEnd) / UFO.chargeSec) * 0.7);
    const p = plan.a + ht * UFO.hoverSpeed;

    let x = ax + Math.sin(p) * UFO.hoverRadius * swing;
    let z = az + Math.sin(p * 2) * UFO.hoverRadius * 0.45 * swing;

    if (t < times.arrive) {
        out.phase = "arrive";
        out.progress = t / times.arrive;
    } else if (t < times.observeEnd) {
        out.phase = "observe";
        out.progress = (t - times.arrive) / Math.max(0.001, times.observeEnd - times.arrive);
    } else if (t < times.chargeEnd) {
        out.phase = "charge";
        out.progress = (t - times.observeEnd) / UFO.chargeSec;
    } else {
        out.phase = "depart";

        const u = t - times.chargeEnd;
        let d;

        if (u < UFO.windupSec) {
            // Easing backward, like drawing a breath...
            d = -UFO.windupDistance * Math.sin((u / UFO.windupSec) * Math.PI / 2);
        } else {
            // ...then gone: a cubic run-up to an absurd distance.
            const k = (u - UFO.windupSec) / UFO.zoomSec;
            d = -UFO.windupDistance + UFO.zoomDistance * k * k * k;
        }

        x += dirX * d;
        z += dirZ * d;
        out.progress = u / (UFO.windupSec + UFO.zoomSec);
    }

    out.x = x;
    out.z = z;

    // Shots pass through while it's materializing and once it's
    // zooming away; the rest of the time the shield takes them.
    out.solid = t >= UFO.solidAfterSec && t < times.windupEnd;

    return out;
}

/** Ms timestamp at which the zoom begins (the instant it vanishes). */
export function ufoZoomAt(plan) {
    return plan.s + phaseTimes(plan).windupEnd * 1000;
}

/** A plan from the network, checked; or null. */
export function readUfoPlan(raw) {
    if (!raw || typeof raw !== "object") return null;

    const n = (v) => Number.isFinite(Number(v));

    if (![raw.id, raw.s, raw.o, raw.d, raw.a].every(n)) return null;
    if (!Array.isArray(raw.legs) || raw.legs.length === 0 || raw.legs.length > 32) return null;

    const legs = [];

    for (const leg of raw.legs) {
        if (!Array.isArray(leg) || leg.length < 3 || !leg.every(n)) return null;
        legs.push([Number(leg[0]), Number(leg[1]), Number(leg[2])]);
    }

    const plan = {
        id: Number(raw.id),
        s: Number(raw.s),
        o: clamp(Number(raw.o), 0, 60),
        d: Number(raw.d),
        a: Number(raw.a),
        w: raw.w ?? null,
        legs
    };

    if (raw.f !== null && raw.f !== undefined && n(raw.f)) plan.f = Number(raw.f);
    if (raw.h) plan.h = 1;

    return plan;
}

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}
