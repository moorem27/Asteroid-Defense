// Tests for the callsign rules (public/name-filter.js).
// Run with: npm test

import assert from "node:assert/strict";

import { checkName, cleanName, nameProblem, NAME_MAX } from "../public/name-filter.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Names that must be refused, including common disguises.
const BLOCKED = [
    "fuck", "F U C K", "F_U_C_K", "F-U-C-K", "FUUUUCK", "FVCK", "PHUCK",
    "SH1T", "5HIT", "BULLSHIT", "BITCHES", "B1TCH",
    "ASS", "A S S", "ASS HAT", "DUMBASS", "A55H0LE",
    "CUM", "T1TS", "TITS", "B00BS", "SEXY",
    "HELL", "DAMN", "CR4P", "PISS",
    "RAPE", "RAPIST",
    "N1GGER", "NIGGGGER", "NIGGA", "FAGG0T", "FAG", "SPIC", "COON",
    "PU55Y", "D1CK", "COCKS", "WH0RE", "SLUT", "P0RN",
    "HITLER", "NAZI", "KKK",
    "XXFUCKXX", "ACE FUCK"
];

// Clean names that contain a blocked word somewhere inside.
const ALLOWED = [
    "MAVERICK", "GOOSE", "STARDUST", "PILOT-4821", "ACE 99", "XO",
    "CLASSIC", "CLASS ACE", "ASSASSIN", "BASS", "PASSAGE", "MISSILE",
    "HELLO", "SHELLY", "SPICY", "COCKPIT", "PEACOCK", "HANCOCK",
    "SCUNTHORPE", "CUMULUS", "TITAN", "ESSEX", "SUSSEX", "SEXTANT",
    "GRAPE", "DRAPE", "SNIGGLE", "NIGHTHAWK", "NIGHT OWL", "NIGERIA",
    "DICKENS", "ANALYST", "ARSENAL", "RACCOON", "COCOON", "SHITAKE",
    "PRICKLE", "BOOMER", "THOTH", "PAKISTAN", "SCRAPPY", "PISSARRO",
    "HELLCAT"
];

test("blocks curse words and slurs, including disguised spellings", () => {
    const missed = BLOCKED.filter((name) => checkName(name).ok);
    assert.deepEqual(missed, [], `let through: ${missed.join(", ")}`);
});

test("allows clean names that contain a blocked word inside them", () => {
    const wrong = ALLOWED.filter((name) => !checkName(name).ok);
    assert.deepEqual(wrong, [], `wrongly blocked: ${wrong.join(", ")}`);
});

test("reserved names are refused", () => {
    for (const name of ["YOU", "Y O U", "admin", "MODERATOR", "SERVER", "SYSTEM"]) {
        const result = checkName(name);
        assert.equal(result.ok, false, name);
        assert.equal(result.reason, "reserved", name);
    }
});

test("cleaning: uppercase, allowed characters only, trimmed, length-limited", () => {
    assert.equal(cleanName("  ace   pilot!! "), "ACE PILOT");
    assert.equal(cleanName("<script>"), "SCRIPT");
    assert.equal(cleanName("é ñ 😀 ok"), "OK");
    assert.equal(cleanName("abcdefghijklmnopqrstuvwxyz").length, NAME_MAX);

    assert.equal(checkName("a").reason, "short");
    assert.equal(checkName("@@@").reason, "short");
    assert.equal(checkName("").reason, "short");
    assert.equal(checkName(null).reason, "short");

    // What's checked is exactly what would be shown (after cutting to
    // the length limit).
    assert.equal(checkName("ABCDEFGHIJKLMFUCK").ok, true, "the bad part is cut off");
    assert.equal(checkName("ABCDEFGHIJFUCK").ok, false);
});

test("problem messages", () => {
    assert.match(nameProblem("short"), /2-14/);
    assert.match(nameProblem("blocked"), /ISN'T ALLOWED/);
    assert.match(nameProblem("reserved"), /RESERVED/);
});

let failed = 0;

for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}\n    ${error.message}`);
    }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);

process.exit(failed ? 1 : 0);
