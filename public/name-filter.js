// ============================================================
// CALLSIGN (PLAYER NAME) RULES
// Shared by the game (instant feedback while typing) and the server
// (src/index.js imports this file), so the server always has the final
// say: a name it rejects is never shown to anyone.
//
// What it does:
//  - Keeps names short and plain: letters, digits, spaces, - and _.
//  - Blocks curse words and slurs, including common disguises:
//    digits for letters (SH1T), separators (F_U_C_K, F U C K),
//    stretched letters (FUUUCK) and a few phonetic spellings.
//  - Avoids blocking clean words that happen to contain a bad one
//    (CLASS, HELLO, SPICY, COCKPIT, ASSASSIN, SCUNTHORPE).
//  - Reserves names that could be mistaken for the game or staff.
//
// No word filter is perfect. To block a word that gets through, add it
// to BLOCKED_STRONG (matched anywhere) or BLOCKED_WORDS (matched as a
// whole word) below, and redeploy.
// ============================================================

export const NAME_MIN = 2;
export const NAME_MAX = 14;

// The built-in lists are stored encoded, so the repository doesn't
// display them as plain text. (To read them: atob() the string.)
const ENCODED_LISTS = "eyJzdHJvbmciOlsiRlVDSyIsIkZVSyIsIkZVQ0MiLCJGQ1VLIiwiRlZDSyIsIlBIVUNLIiwiUEhVSyIsIkZVUSIsIk1PVEhFUkYiLCJTSElUIiwiU0hZVCIsIkNVTlQiLCJLVU5UIiwiQklUQ0giLCJCSUNIIiwiQklBVENIIiwiQllUQ0giLCJXSE9SRSIsIlNMVVQiLCJESUNLIiwiQ09DSyIsIlBVU1NZIiwiUFVTU0kiLCJQRU5JUyIsIlZBR0lOQSIsIkFTU0hPTEUiLCJBU1NIQVQiLCJBU1NXSVBFIiwiRFVNQkFTUyIsIkpBQ0tBU1MiLCJGQVRBU1MiLCJTTUFSVEFTUyIsIkJBREFTUyIsIktJQ0tBU1MiLCJCQVNUQVJEIiwiQk9MTE9DSyIsIldBTksiLCJUV0FUIiwiRElMRE8iLCJKSVpaIiwiSklaTSIsIkNMSVQiLCJET1VDSEUiLCJDVU1TSE9UIiwiQ1VNU0xVVCIsIkJMT1dKT0IiLCJIQU5ESk9CIiwiUklNSk9CIiwiQk9ORVIiLCJQT1JOIiwiSEVOVEFJIiwiTlVERVMiLCJPUkdBU00iLCJNQVNUVVJCIiwiUkFQSVNUIiwiTklHR0VSIiwiTklHR0EiLCJOSUdHQUgiLCJOSUdHVUgiLCJOSUdMRVQiLCJGQUdHT1QiLCJGQUdPVCIsIkZBR0dJVCIsIkRZS0UiLCJUUkFOTlkiLCJSRVRBUkQiLCJLSUtFIiwiQ0hJTksiLCJXRVRCQUNLIiwiQkVBTkVSIiwiR09PSyIsIlJBR0hFQUQiLCJUT1dFTEhFQUQiLCJLS0siLCJOQVpJIiwiSElUTEVSIiwiU0lFR0hFSUwiXSwid29yZHMiOlsiQVNTIiwiQVJTRSIsIkFOVVMiLCJDVU0iLCJUSVQiLCJUSVRTIiwiVElUVFkiLCJUSVRUSUVTIiwiQk9PQiIsIkJPT0JTIiwiQk9PQklFUyIsIlNFWCIsIlNFWFkiLCJIT0UiLCJUSE9UIiwiRkFHIiwiTklHIiwiUkFQRSIsIlJBUEVEIiwiUkFQRVkiLCJTUElDIiwiQ09PTiIsIlBBS0kiLCJORUdSTyIsIlBJU1MiLCJQSVNTRUQiLCJDUkFQIiwiREFNTiIsIkhFTEwiLCJQUklDSyIsIlNFTUVOIiwiT1JHWSJdfQ==";

// Your own additions (plain text is fine).
const BLOCKED_STRONG = [];
const BLOCKED_WORDS = [];

// Clean words that contain a blocked one; removed before checking.
const ALLOWED = [
    "COCKPIT", "COCKPITS", "COCKTAIL", "COCKATOO", "COCKATIEL", "COCKROACH",
    "PEACOCK", "HANCOCK", "HITCHCOCK", "WOODCOCK", "SHITAKE", "SHIITAKE",
    "SCUNTHORPE", "DICKENS", "DICKINSON", "WANKEL"
];

// Names that could be mistaken for the game itself or its staff.
const RESERVED = [
    "YOU", "ADMIN", "ADMINISTRATOR", "MOD", "MODERATOR", "SERVER", "SYSTEM",
    "OWNER", "DEV", "DEVELOPER", "STAFF", "OFFICIAL"
];

let lists = null;

function getLists() {
    if (lists) return lists;

    let decoded = { strong: [], words: [] };

    try {
        decoded = JSON.parse(atob(ENCODED_LISTS));
    } catch {
        // Fall back to the plain-text additions only.
    }

    lists = {
        strong: [...decoded.strong, ...BLOCKED_STRONG].map((w) => w.toUpperCase()),
        words: [...decoded.words, ...BLOCKED_WORDS].map((w) => w.toUpperCase())
    };

    return lists;
}

// Uppercase, only A-Z 0-9 space - _, single spaces, trimmed, cut to
// NAME_MAX. This is exactly what other players will see.
export function cleanName(raw) {
    return String(raw ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9 _-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, NAME_MAX)
        .trim();
}

// Digits read as letters: one reading with 1 as I, one with 1 as L.
function deLeet(text, one) {
    return text
        .replace(/0/g, "O")
        .replace(/1/g, one)
        .replace(/3/g, "E")
        .replace(/4/g, "A")
        .replace(/5/g, "S")
        .replace(/6/g, "G")
        .replace(/7/g, "T")
        .replace(/8/g, "B")
        .replace(/9/g, "G");
}

// Runs of the same letter shortened: to 2 (FUUUCK -> FUUCK) or 1.
const shrinkTo2 = (t) => t.replace(/([A-Z])\1{2,}/g, "$1$1");
const shrinkTo1 = (t) => t.replace(/([A-Z])\1+/g, "$1");

const hasDoubleLetter = (w) => /([A-Z])\1/.test(w);

function removeAllowed(text) {
    let result = text;

    for (const word of ALLOWED) {
        result = result.split(word).join("");
    }

    return result;
}

/**
 * Check a name someone typed.
 * @returns {{ ok: boolean, name: string, reason?: string }}
 *   name:   the cleaned name (what would be shown)
 *   reason: "short" | "reserved" | "blocked"
 */
export function checkName(raw) {
    const name = cleanName(raw);

    if (name.replace(/[^A-Z0-9]/g, "").length < NAME_MIN) {
        return { ok: false, name, reason: "short" };
    }

    const { strong, words } = getLists();

    for (const one of ["I", "L"]) {
        const text = deLeet(name, one);

        // The whole name with spaces and separators removed, so
        // F U C K and F_U_C_K are caught too.
        const compact = text.replace(/[^A-Z]/g, "");

        if (RESERVED.includes(compact)) {
            return { ok: false, name, reason: "reserved" };
        }

        const cleaned = removeAllowed(compact);
        const two = shrinkTo2(cleaned);
        const single = shrinkTo1(cleaned);

        for (const bad of strong) {
            if (cleaned.includes(bad) || two.includes(bad)) {
                return { ok: false, name, reason: "blocked" };
            }

            // FUUCK -> FUCK. Only for words without a double letter of
            // their own, or shortening them would catch clean words.
            if (!hasDoubleLetter(bad) && single.includes(bad)) {
                return { ok: false, name, reason: "blocked" };
            }
        }

        // Whole words, and the whole name squeezed together.
        const pieces = text
            .split(/[^A-Z]+/)
            .filter(Boolean)
            .map(removeAllowed);

        pieces.push(compact);

        for (const piece of pieces) {
            for (const candidate of new Set([piece, shrinkTo2(piece), shrinkTo1(piece)])) {
                for (const bad of words) {
                    if (
                        candidate === bad ||
                        candidate === bad + "S" ||
                        candidate === bad + "Z"
                    ) {
                        return { ok: false, name, reason: "blocked" };
                    }
                }
            }
        }
    }

    return { ok: true, name };
}

// A short message for each reason, for the name box.
export function nameProblem(reason) {
    if (reason === "short") return `USE ${NAME_MIN}-${NAME_MAX} LETTERS OR NUMBERS`;
    if (reason === "reserved") return "THAT CALLSIGN IS RESERVED";
    if (reason === "blocked") return "THAT CALLSIGN ISN'T ALLOWED";
    return "";
}

// A random default, e.g. PILOT-4821.
export function randomCallsign() {
    return `PILOT-${Math.floor(1000 + Math.random() * 9000)}`;
}
