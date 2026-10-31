# Asteroid Defense: multiplayer server setup

## How it works

```
Browser ──GET /api/ws (WebSocket)──▶ Worker ──▶ Matchmaker DO ("which lobby?")
                                         │
                                         └──▶ Lobby DO (≤ 20 players, owns the world)
```

- **Worker** (`src/index.js`): serves the game files from `public/` and sends
  each new player to a lobby.
- **Matchmaker** (one Durable Object): tracks every open lobby and how full it
  is. New players go to the fullest lobby that still has room, so people end up
  together. When every lobby is full (or there are none), it opens a new one. A
  player who reconnects is sent back to the lobby they were in.
- **Lobby** (one Durable Object per lobby, up to 20 players) owns the shared
  world. Twenty times a second it simulates:
  - the asteroids, mines, energy crystals and the rogue asteroid
  - every bullet, laser and rocket, and everything they hit
  - every score

  It runs 15-minute rounds, and the highest score wins.
- **Client**: `public/multiplayer.js` carries messages and draws the other
  pilots and everyone's rockets. `public/game.js` turns the server's world into
  the asteroids, mines and crystals you see.

Each browser still flies its own ship, so steering feels instant. Everything
else is decided by the server, so every player sees the same world and nobody
can award themselves points.

## Game rules online

- **Shared world.** Everyone sees the same asteroids, mines, crystals and rogue
  asteroid. Asteroids are rarer than in the solo game: a few around each pilot,
  more as the round goes on.
- **PvP.** Bullets, the laser and rockets all damage other pilots:
  - each damaging hit is worth +200
  - destroying a ship is worth +2,500
  - a destroyed ship respawns after 3 seconds nearby, with full hull, keeping
    its score, and is shielded (blinking) for 3 seconds.

  Asteroids and mines also do damage, and a pilot who was recently hit by
  someone credits that pilot if an asteroid finishes them off.
- **Points** come from destroying asteroids and mines, collecting crystals
  (+500, and they repair one hull point), and hitting or destroying other
  pilots.
- **Warp bubble.** Every 10,000 points gives a warp bubble that makes you immune
  and clears rocks around you.
- **Rounds.** Each round lasts 15 minutes. A live top 5 sits under the high
  score, and a game log under your score flashes up each ship destroyed (who
  destroyed whom and with which weapon, or what got them). At 0:00 the black hole opens and carries everyone out, a results
  screen names the winner, and a new round starts about 20 seconds later.
- **All-time leaderboard.** The server keeps the 10 best scores ever set in any
  lobby:
  - the #1 score shows as "ALL-TIME" under the high score
  - the top 10 shows on the start and game-over screens, and the top 5 on the
    round results, where a new record is announced
  - scores are recorded at the end of each round, and when a player leaves
    mid-round
  - only online scores count, because the server calculates them; solo scores
    stay in the player's own HIGH SCORE.
- **Weapons.** The laser unlocks at 15,000 points and rockets at 20,000. You use
  one at a time:
  - switch with 1 / 2 / 3, Q / E or the mouse wheel; on a phone, tap the weapon
    button under the hull display, which appears once a second weapon unlocks
  - rockets fire with the trigger like the other weapons, and home on the best
    target ahead of them (asteroid, mine or pilot).
- **Laser.** The beam reaches 60 units, a little past the edges of the screen,
  and hits exactly what is drawn, including anything that moves into it while
  it's visible.
- **Ships.** Pilots pick one of four ships on the title (or game-over)
  screen with ◀ / ▶ or the arrow keys; the choice is remembered:
  - every ship has three looks that follow the hull bar: intact (green),
    damaged (yellow: burns and a piece shot off) and critical (red: a wing
    torn open, a dead engine, smoking)
  - a destroyed ship blows apart in a fireball with a shockwave and flying
    debris
  - online, everyone sees each pilot's ship and its damage (the server passes
    both along with the position)
  - the models and the explosion are made by `blender/generate_ships.py`
    (Blender or plain `python3`); any that are missing fall back to the
    starfighter and the normal explosion.
- **UFO visits.** Once or twice a round (once or twice per solo game, too) a
  flying saucer appears near a random pilot, watches for 16–22 seconds,
  following them if they fly off, and then leaves at an impossible speed:
  - everyone in the lobby sees the same saucer, because the server decides when
    and where it appears and what hits it (`public/ufo.js` holds the flight
    plan both sides use)
  - nothing hurts it: its shield absorbs bullets, stops the laser, sets
    rockets off and turns asteroids aside
  - it leaves pilots alone unless they shoot it. Whoever does is destroyed at
    once by a plasma blast (no shield or warp bubble stops it, and nobody gets
    points for it)
  - after three attackers it turns hostile (red lights, a red ring on the
    ground) and blasts any ship that comes within that ring, until it leaves;
    respawns are placed well outside it
  - the model is `public/assets/ufo.glb`, made by `blender/generate_ufo.py`
    (run it with Blender, or with plain `python3`). If the file is missing, the
    game draws a simpler stand-in saucer.

### Clans

A pilot can put a clan tag in front of their callsign, in brackets:
`[KO]FUZZY CAT`. Everyone wearing the same tag is on the same team: their
bullets, lasers and rockets pass harmlessly through each other (the server
enforces it), and nobody scores for hitting a teammate. Pilots with no tag or
a different tag are fair game.

The tag `[PASS]` is special: anyone can wear it, and it means peace. A pilot
wearing `[PASS]` can't damage any other pilot, and no pilot can damage them
(asteroids, mines, the rogue asteroid and the UFO still can).

Tags are 2–4 letters or digits and go through
the same word filter as callsigns. A new name shows straight away, but
renaming in or out of a clan (or into `[PASS]`) only changes who can hurt
whom from that pilot's next respawn or the next round, so it can't be used to
escape a fight.

### Maps

There are two maps. Online, a lobby's first round is always in low orbit
(close to Earth), then the rounds alternate: deep space, low orbit, deep space,
and so on, so it's never the same map twice in a row. Everyone in the lobby
sees the same map; it switches when the next round starts. While the page is
still connecting, no map is shown (plain black), so a map that isn't the one
being played never flashes up: it shows the lobby's map as soon as the server
says which, or low orbit if the game is offline. In solo play each new game
switches map (low orbit, deep space, low orbit, …). Someone joining a lobby partway through a
deep-space round plays that round in deep space. Maps only change the scenery;
the game plays the same.

- **Deep space:** the nebula and star layers.
- **Low orbit:** looking straight down from orbit on a chain of tropical
  islands. The sea and islands far below barely move, clouds drift past faster,
  and thin high cirrus faster still. At the corners of the screen the planet's
  edge curves away, with a thin line of atmosphere and black space with faint
  stars beyond, so it's clear the ships are still in space; near the edge of
  the playfield, the planet's edge slides further into view. Nothing star-like
  appears over the sea or land.

Add `?map=space` or `?map=orbit` to the address to always show that one,
whatever the server picks (handy for testing). The orbit map's images are `public/assets/bg_orbit_ground.jpg`,
`bg_orbit_clouds.png` and `bg_orbit_haze.png`, made by
`blender/generate_islands.py` (plain Python with numpy and Pillow; change
`SEED` in it for a different chain of islands). If they're missing, the game
uses deep space instead.

### Ranks and the cloak

Every pilot starts each round at rank 1 and goes up a rank every 10,000
points. The rank shows in a small box beside their name in the lobby list
(top right) and on the name tag over their ship.

At 25,000 points a ship unlocks a cloaking device: a CLOAK button appears
next to the weapon button (or press C). While cloaked, other pilots can't see
the ship at all, on screen or on the radar, and rockets can't lock on to it.
It can still be hit, and it can't fire. The pilot sees their own ship as a
shimmering blue ghost. The cloak drops when the ship is destroyed, and locks
again at the start of every round. The server enforces all of this
(`public/ranks.js` holds the numbers).

### Dropped connections

If a pilot's connection drops (a phone locking, switching apps, a Wi-Fi blip,
or a deploy restarting the server), the game carries on solo and rejoins as
soon as it can. Coming back within two minutes puts them in the same lobby and
round with their score, about where they were, even if they were the only one
playing; the game shows RECONNECTED · SCORE KEPT. To make that survive the
server restarting, each lobby saves its round and scores every 10 seconds
while people are playing.

### One pilot per browser

Each browser is one pilot. Reloading the page, or opening the game in another
tab, reconnects the same pilot with the same score instead of adding a new
one. If two tabs are open, the one you're looking at is online, and the other
plays solo and shows ONLINE IN ANOTHER TAB. Switching back to it takes over
again.

### Callsigns

Each player can set the name others see: tap the callsign under the logo, type
a new one and press SAVE. It's saved in that browser and applies straight
away, even mid-round. Names are 2-14 letters, digits, spaces, `-` or `_`.

Curse words and slurs are blocked by `public/name-filter.js`, which the game
uses for instant feedback and the server uses to have the final say. It also
catches common disguises such as `SH1T`, `F_U_C_K` and `FUUUCK`, without
blocking clean words like CLASSIC, HELLO or COCKPIT.

No word filter is perfect. If a bad name gets through, add the word to
`BLOCKED_STRONG` (matched anywhere in a name) or `BLOCKED_WORDS` (matched only
as a whole word) at the top of that file and redeploy. Players using a name
that's now blocked get a new `PILOT-####` name the next time they join.

### Controls on phones

Drag a finger to steer the ship toward it and thrust; tap to fire.

### Offline mode

If the server can't be reached, the game plays the original solo game: a
5-minute match where you survive to win and die after 3 hits. It also uses the
new weapon controls and laser.

| Situation | What the player sees |
|---|---|
| Server unreachable, or the page is opened from a plain web server / file | Solo game; HUD shows OFFLINE MODE; it retries in the background (4 s, 8 s, … up to 1 min) and joins a lobby as soon as it can |
| Join takes longer than 6 s | Same as above |
| Connection drops mid-round | Everything on screen becomes a solo game and carries on; it rejoins the same lobby within about a second and gets its score back |
| `multiplayer.js` missing or broken | Solo game; it can't stop the game from starting |
| Lobby full when the player arrives | Server picks another lobby automatically |
| Old cached copy of the game after an update | Version check fails, so that player plays solo until they reload |
| Junk or flooding messages | Dropped (size limit, rate limit, validation); the lobby carries on |
| An error inside the simulation | That step is skipped; the lobby keeps running |

Add `?offline` to the URL to turn multiplayer off on purpose.

## Folder layout

```
asteroid-defense/
├── wrangler.jsonc        Cloudflare configuration
├── package.json
├── src/
│   └── index.js          Worker + Matchmaker + Lobby (the server)
├── public/               Everything the browser loads
│   ├── index.html
│   ├── game.js
│   ├── style.css
│   ├── multiplayer.js
│   ├── name-filter.js    Callsign rules (also used by the server)
│   ├── ranks.js          Ranks and the cloak (also used by the server)
│   └── assets/           ← copy your GLB models and PNGs here
└── test/                 Automated tests (no Cloudflare account needed)
```

## Step by step

### 1. Install Node.js

Wrangler needs Node.js 22 or newer. Check with `node --version`.

On Linux, the version from the system package manager (`apt`) is often too
old. The easiest way to get a current one is nvm, which installs Node in your
home folder:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install --lts
node --version   # v22 or newer
```

On macOS or Windows, install the LTS version from https://nodejs.org.

If you ran `npm install` with an older Node, delete `node_modules` and
`package-lock.json` and run it again.

### 2. Put your assets in place

Copy your game's `assets` folder (all the `.glb` and `.png` files) into
`public/assets/`.

### 3. Install the tools

From the `asteroid-defense` folder:

```bash
npm install
```

### 4. Log in to Cloudflare

```bash
npx wrangler login
```

### 5. Match your existing Worker's name

Open `wrangler.jsonc` and set `"name"` to your existing Worker's name, which is
shown in the Cloudflare dashboard under **Workers & Pages**. The deploy then
updates that Worker and keeps its URL and any custom domain.

If your existing Worker has its own code (not just static files), merge it in
where `src/index.js` calls `env.ASSETS.fetch(request)`.

### 6. Try it on your own computer

```bash
npx wrangler dev
```

Open http://localhost:8787 as two different players, side by side. Each
browser counts as one pilot, so two tabs or windows of the same browser are the
same player (the newer one takes over, and the other shows ONLINE IN ANOTHER
TAB). For a second player, use one of these:
- a private/incognito window
- a different browser
- your phone at `http://<your computer's IP>:8787`, after starting with
  `npx wrangler dev --ip 0.0.0.0`

Check each of these:
- **Joining:** both windows show **ONLINE · 2 PILOTS**, a ROUND number and a
  15:00 clock.
- **Shared world:** the same asteroids appear in both windows.
- **PvP:** shooting the other ship takes away its hull, and destroying it shows
  a respawn countdown on its screen.
- **Offline fallback:** stop the dev server with Ctrl+C. Both windows switch to
  OFFLINE MODE and keep playing solo. Start it again, and within a minute they
  rejoin.

To see the end of a round without waiting 15 minutes, temporarily set
`ROUND_MS` in `src/index.js` to `60 * 1000`.

### 7. Deploy

```bash
npx wrangler deploy
```

The first deploy also creates the two Durable Object classes (the `migrations`
section of `wrangler.jsonc`).

### 8. Check it

- Visit `https://<your-worker-url>/api/health`. It should show
  `{"ok":true,"protocol":2}`.
- Visit `https://<your-worker-url>/api/leaderboard`. It should show
  `{"top":[]}` until the first online round ends, then the scores.
- Open the game on two devices. Both should show ONLINE · 2 PILOTS.
- Watch the server's logs live with `npx wrangler tail`.

### 9. Optional: lock it to your site

Uncomment the `vars` block at the bottom of `wrangler.jsonc`, list your game's
address(es), and deploy again:

```jsonc
"vars": {
    "ALLOWED_ORIGINS": "https://your-game.workers.dev,https://www.yourdomain.com"
}
```

With this set, `wrangler dev` only accepts `http://localhost:8787` if you add it
to the list too.

## Running the tests

```bash
npm test
```

Two suites run against the real server and game code in Node, using small
stand-ins for Cloudflare's runtime, Three.js and the page. Neither needs a
Cloudflare account, the models or a browser.

- **Server and client** (`test/multiplayer.test.mjs`):
  - the shared world, weapons and the laser's reach
  - rockets, PvP and respawns, crystals, mines, the warp bubble and the rogue
    asteroid
  - rounds and results, and reconnecting with the same score
  - the 20-player cap, refused and abusive input, and errors inside the
    simulation
  - the all-time leaderboard: ordering, one entry per player per round,
    surviving restarts, and failing softly
- **The game itself** (`test/game.test.mjs`):
  - offline play and joining a lobby
  - shooting shared asteroids and switching weapons
  - death and respawn, the end-of-round finale, and losing and regaining the
    connection
  - the solo laser and rockets
  - the all-time leaderboard, and the mouse controls

Step 6 is the check against Cloudflare's real runtime and real rendering.

## Security

What's already protected, in the code:

- **The server decides everything that counts:** hits, damage, scores, kills,
  weapon unlocks, the cloak, rates of fire and the all-time list. A modified
  browser can't award itself points.
- **Movement is checked:** the server won't believe a ship moving faster than
  ships can fly (40.5 units a second, boosted in a warp bubble), however often
  it reports, and puts a pilot back if they get far out of step.
- **No hiding by leaving:** a ship has to be flying to fire, and one that stops
  (or goes quiet) stays visible and hittable for 3 seconds.
- **The cloak hides the ship from everyone else:** no event gives its position
  or names it (hits, laser sparks, crystals it picks up, rocks its warp bubble
  clears). Others can still see the crystal vanish or the mine go off.
- **Score farming pays less:** repeat kills of the same pilot in a round are
  worth full, then half, then a quarter from then on (hits on them too). Every
  hit and kill still scores, including between pilots on the same connection.
- **Floods are cut off:** a connection that keeps sending messages faster than
  the game ever does, or sends an oversized one, is closed (every message
  counts toward Cloudflare's daily allowance, even ignored ones).
- **At most 6 connections per IP address (or IPv6 /64) per lobby.**
- **The game connection is always encrypted** (`wss:`), even from a page opened
  as `http://`, except for `wrangler dev` on this computer or the home network.
- **Only the game's own pages can connect:** `ALLOWED_ORIGINS` in
  `wrangler.jsonc` lists amaxcon.com and `wrangler dev` on this computer. To
  play from another device on your home network during `wrangler dev`, add its
  address (e.g. `http://192.168.1.20:8787`).
- **Security headers** (`public/_headers`): the page can only run scripts and
  load files from this site, other sites can't put the game in a frame, and
  the usual `nosniff` / referrer settings.
- **Three.js is served from this site** (`public/vendor/three`, r170), not a
  CDN.

### One thing to set up in the Cloudflare dashboard

Add a rate limiting rule so one address can't open connections endlessly:

1. Open the dashboard, select the **amaxcon.com** zone, then **Security** →
   **WAF** (or **Security rules**) → **Rate limiting rules** → **Create rule**.
2. Name it `Game connections`.
3. **If incoming requests match:** Field *URI Path*, operator *equals*, value
   `/api/ws`.
4. **With the same characteristics:** *IP*.
5. **When rate exceeds:** 20 requests per 10 seconds.
6. **Then take action:** *Block*, for 10 seconds (the shortest choice is fine).
7. Deploy the rule.

A real player reconnects at most a few times a minute, so this never gets in
their way.

Also recommended: **SSL/TLS** → **Edge Certificates** → turn on **Always Use
HTTPS**, and enable **HSTS** there. Then the page itself always loads over
HTTPS. That matters because the page keeps each pilot's token (which holds
their score) in the browser.

### If you edit the import map in index.html

`public/_headers` allows the page's one inline script (the import map) by its
SHA-256 hash, so after changing it, recompute the hash and put it in the
`sha256-...` part of the Content Security Policy:

```
node -e "const s=require('fs').readFileSync('public/index.html','utf8');const m=s.match(/<script type=\"importmap\">([\s\S]*?)<\/script>/);console.log(require('crypto').createHash('sha256').update(m[1]).digest('base64'))"
```

`npm test` checks the two match.

### Checking the Three.js files

To confirm `public/vendor/three` matches the official package:

```
npm pack three@0.170.0 && tar xzf three-0.170.0.tgz
cmp package/build/three.module.js public/vendor/three/build/three.module.js
cmp package/examples/jsm/loaders/GLTFLoader.js public/vendor/three/examples/jsm/loaders/GLTFLoader.js
cmp package/examples/jsm/utils/BufferGeometryUtils.js public/vendor/three/examples/jsm/utils/BufferGeometryUtils.js
rm -rf package three-0.170.0.tgz
```

No output from the `cmp` lines means they're identical.

## Costs and limits

This project uses SQLite-backed Durable Objects, which is what the Workers Free
plan requires. Check
https://developers.cloudflare.com/durable-objects/platform/pricing/ for current
numbers. Things to know:

- **Requests:** each flying player sends 10 updates a second, plus their
  shots. Several WebSocket messages count as one request toward the daily
  allowance.
- **Duration:** a lobby runs its 30-per-second simulation the whole time
  anyone is connected, so it counts toward duration for as long as it has
  players. An empty lobby stops.
- **Storage:** each lobby saves its round every 10 seconds while in play
  (one or two rows written each time; the Free plan allows 100,000 a day).
- **Free plan limits:** going over a daily limit makes further requests fail
  until it resets at midnight UTC. Players simply drop to OFFLINE MODE until
  then.
- **Regular traffic:** the Workers Paid plan raises the limits considerably.

## Making changes later

- **Tuning:**
  - Server rules (scores, damage, cooldowns, how many asteroids, round length)
    are the constants at the top of `src/index.js`.
  - Their client-side mirrors (laser range and width, rocket speed) are in
    `LASER_CONFIG` / `ROCKET_CONFIG` in `game.js`. Keep matching values in step.
- **Protocol:** if you change what the client and server send each other,
  bump `PROTOCOL_VERSION` in both `src/index.js` and `public/multiplayer.js`.
- **Durable Object classes:** never edit or remove the existing `v1`
  migration. Add a new entry with a new tag (`v2`) if you add, rename or remove
  a class.
