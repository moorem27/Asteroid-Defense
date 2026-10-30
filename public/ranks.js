/*
============================================================
ASTEROID DEFENSE: RANKS AND THE CLOAK (shared by the game and the server)

Every pilot starts a round at rank 1 and goes up a rank every
RANK_POINTS points. The rank is shown beside their name in the lobby
list and over their ship.

At CLOAK_UNLOCK_SCORE a ship gets a cloaking device: while it's on,
other pilots can't see the ship at all (not on screen, not on the
radar), but it can still be hit, and it can't fire. The server
enforces both.
============================================================
*/

export const RANK_POINTS = 10000;
export const CLOAK_UNLOCK_SCORE = 25000;

/** The rank for a score: 1 below 10,000, 2 from 10,000, and so on. */
export function rankOf(score) {
    const s = Number(score);
    return 1 + Math.floor((Number.isFinite(s) && s > 0 ? s : 0) / RANK_POINTS);
}

/** True once a score has unlocked the cloak. */
export function cloakUnlocked(score) {
    return Number(score) >= CLOAK_UNLOCK_SCORE;
}
