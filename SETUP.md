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
  score. At 0:00 the black hole opens and carries everyone out, a results
  screen names the winner, and a new round starts about 20 seconds later.
- **Weapons.** The laser unlocks at 15,000 points and rockets at 20,000. You use
  one at a time:
  - switch with 1 / 2 / 3, Q / E or the mouse wheel; on a phone, tap the weapon
    button under the hull display, which appears once a second weapon unlocks
  - rockets fire with the trigger like the other weapons, and home on the best
    target ahead of them (asteroid, mine or pilot).
- **Laser.** The beam reaches 60 units, a little past the edges of the screen,
  and hits exactly what is drawn, including anything that moves into it while
  it's visible.

### Controls on phones

The touch controls are a floating thumbstick:
- **Steer:** put a finger down anywhere and slide it. Up/down is thrust
  forward/reverse, left/right is turn. How far you slide sets how fast, so small
  slides give fine control.
- **Coast:** lift the finger and the ship coasts to a stop.
- **Fire:** tap for one shot. Hold a finger still to keep firing. Put a second
  finger down while steering to fire on the move.

To change how the thumbstick feels, edit `TOUCH_CONFIG` near the top of
`game.js`:

| Setting | What it does |
|---|---|
| `stickRadius` | How far you slide for full power |
| `deadZone` | How much movement near the center is ignored |
| `turnRate` | How fast the ship turns at full slide |
| `turnSmoothing` | Higher is snappier, lower is smoother |

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
│   └── assets/           ← copy your GLB models and PNGs here
└── test/                 Automated tests (no Cloudflare account needed)
```

## Step by step

### 1. Install Node.js

You need Node.js 20 or newer. Check with `node --version`. If you don't have
it, install the LTS version from https://nodejs.org.

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

Open http://localhost:8787 in **two** browser windows side by side. To try the
touch controls, use your browser's device emulation, or open
`http://<your computer's IP>:8787` on your phone after starting with
`npx wrangler dev --ip 0.0.0.0`.

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
- **The game itself** (`test/game.test.mjs`):
  - offline play and joining a lobby
  - shooting shared asteroids and switching weapons
  - death and respawn, the end-of-round finale, and losing and regaining the
    connection
  - the solo laser and rockets
  - the touch thumbstick and firing, and the unchanged mouse controls

Step 6 is the check against Cloudflare's real runtime and real rendering.

## Costs and limits

This project uses SQLite-backed Durable Objects, which is what the Workers Free
plan requires. Check
https://developers.cloudflare.com/durable-objects/platform/pricing/ for current
numbers. Things to know:

- **Requests:** each flying player sends 10 updates a second, plus their
  shots. Several WebSocket messages count as one request toward the daily
  allowance.
- **Duration:** a lobby runs its 20-per-second simulation the whole time
  anyone is connected, so it counts toward duration for as long as it has
  players. An empty lobby stops.
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
