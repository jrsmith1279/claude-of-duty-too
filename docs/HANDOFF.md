# HANDOFF — Claude of Duty

**Paused:** 2026-07-25, after Wave 1 + its integration pass.
**Repo:** `/Users/jacksmith/Documents/github/jack/claude-of-duty` (git, no remote)
**Last good commit:** `4c0fd00` — *wave1 integration: radiometric sun/sky agreement,
GPU tier detection, contract-complete greybox, worldUV*

---

## 30-second summary

The engine and the whole rendering pipeline are **built, integrated and working**.
~17,700 lines across 82 files. The harness renders 10 fixed camera presets headless
on a real GPU with **zero console errors at 60 fps** (1600×900, 210 draws).

The frames now show a real street: kerbs, lamp posts, brick and concrete facades,
cobbled and asphalt ground, an archway, staggered rooflines. `night` and
`goldenhour` are genuinely good. It is still a **blockout** — no props, clutter,
decals, weapons, AI or HUD — but it is a contract-complete blockout that exercises
every integration path.

Wave 2 (content) has not started. No visual critic loop has run yet.

---

## Resume in three commands

```bash
cd /Users/jacksmith/Documents/github/jack/claude-of-duty
npm run dev                 # play it: http://localhost:5173  (click to lock pointer)
node tools/shoot.mjs        # render all 10 presets to shots/ + shots/report.json
node tools/contact.mjs --dir shots --out shots/_sheet.png --cols 3   # review them at a glance
```

If anything is broken on resume: `git reset --hard 4c0fd00` is a known-good state.

---

## What the integration pass did (recovered work)

The Wave 1 integration agent **died mid-run on an expired login**. It had already
written its changes to disk but never committed or reported. I verified the build,
re-rendered all 10 presets, reviewed them, and committed its work as `4c0fd00`.
Nothing was lost, but **it never finished its checklist** — see "not done" below.

What it fixed, and why each mattered:

- **`src/render/Lighting.js` — the real cause of the blown exposure.** The sun's
  intensity was a hardcoded `SUN_PEAK = 3.7` while the sky dome, PMREM probe and
  aerial-perspective inscatter were all authored in `ctx.sky.exposure` units. The
  two were **2.9 stops apart** (sun delivering 2.84 against a dome assuming 21.1),
  so auto-exposure keyed to the ground and clipped the sky to flat white. Now the
  key light is derived from `sky.sunIntensity × sky.exposure`, so the elevation
  ramp comes from real airmass and the two systems agree by construction.
- **`src/core/Engine.js` — GPU tier detection.** `deviceMemory`/`hardwareConcurrency`
  alone put every modern laptop on `ultra`, which is a discrete-GPU preset (2048²
  textures, 8-step GTAO, 32-step volumetrics, 24-step POM) — measured at 26 ms/frame
  on the M2 against a 16.6 ms budget. Integrated parts now cap at `high`.
  **This is the 42 → 60 fps win.**
- **`src/world/Level.js` (+323 lines) — contract-complete blockout.** Publishes
  every field `ARCHITECTURE.md` promises (`bounds`, `spawns`, `lightSpecs`,
  `coverPoints`, `navPolys`) and registers its own colliders. Before this, three
  integration paths were dead code that had never executed against real data. Also
  adds `worldUV()`, which rewrites box UVs to metres so geometry meets the
  1-unit-per-metre convention — this let it drop the triplanar path, which was
  costing **14 ms of a 21 ms budget** in three texture fetches per map per pixel.
- **`src/main.js`** — `window.__COD__` was being *replaced* after `engine.init()`,
  silently dropping every hook systems attached during their own init. Several Wave 1
  agents had each independently grown a re-attach-on-update workaround for it.
- **`src/render/Sky.js`** — stop double-drawing the dome as `scene.background`; it
  was a full-screen pass immediately overdrawn by the camera-locked dome.
- **`tools/shoot.mjs`** — `goldenhour` was `tod: 0.09`, which under the contract's
  anchors is **02:10, full night**. It had been rendering as moonlit pre-dawn while
  being reviewed as a golden-hour shot. Now `0.76`.

**What it did NOT get to** (it died before these): reading each PNG and fixing cheap
visual wins, and its own final report. So no one has yet done a careful per-shot
review with fixes — that is the first task on resume.

---

## What is actually done

### Infrastructure (all verified working)

| thing | file | state |
|---|---|---|
| Fixed-step engine, 120 Hz sim / variable render, system registry | `src/core/Engine.js` | done |
| Pointer-lock input, edge-triggered actions, rebindable | `src/core/Input.js` | done |
| Quality tiering (low/medium/high/ultra) from device probe | `src/core/Engine.js` | done |
| **Screenshot harness** — 10 presets, headless, real GPU | `tools/shoot.mjs` | done |
| **Blind A/B sheet builder** — randomised panels, separate answer key, source cropping | `tools/blind.mjs` | done |
| **Contact sheet builder** | `tools/contact.mjs` | done |
| 20 official Activision reference frames + scored catalog | `refs/`, `refs/catalog.json` | done |

The harness runs on **ANGLE Metal / Apple M2**, not SwiftShader — verified via
`WEBGL_debug_renderer_info`. What the critics judge is what you would actually see.

### Wave 1 subsystems (landed, integrated, rendering)

- **`src/assets/`** — GPU-procedural PBR texture generation. GLSL noise library
  (value/simplex/worley/fBm/domain-warp/ridged), 30 material generators split across
  `generators/{masonry,ground,metal,wood,misc}.js`. Renders to render targets, packs
  ORM, derives normals from height. **This came out well** — see the `interior` shot,
  which is accidentally a close-up of the concrete: aggregate pitting, hairline
  cracks, form-tie holes and rain streaking are all there and read correctly.
- **`src/render/Materials.js` + `materials/`** — PBR library with `onBeforeCompile`
  injections for triplanar, detail normals, macro variation, POM, wetness.
- **`src/render/Sky.js` + `sky/`** — atmospheric scattering LUT, cloud cache, celestial
  ephemeris (real sun/moon elevation), aerial perspective, PMREM env regeneration.
- **`src/render/Lighting.js` + `lighting/`** — cascaded shadow maps, PCSS shaders,
  dynamic light pool with budget enforcement, indirect/irradiance approximation.
- **`src/physics/`** — hand-written binned-SAH BVH in flat typed arrays, swept capsule
  character controller, rigid bodies, Verlet ragdoll, debug draw.
- **`src/player/`** — movement config, springs, view motion, mantle/vault, camera rig,
  physics bridge. Honours the `camera:override` event the harness needs.
- **`src/render/PostFX.js` + `passes/`** — TAA, GTAO, SSR, volumetrics, bloom, motion
  blur, DOF, exposure, LUT grade, sharpen, composite, viewmodel pass.

---

## What is wrong right now — ranked, with the likely fix

Assessed from `shots/postint/` (contact sheet at `shots/_postint_sheet.png`),
rendered and reviewed after the integration commit.

**Fixed since the last handoff:** blown exposure (root cause was the sun/sky stop
mismatch, not the exposure pass), golden hour rendering as night, and the 42 fps.

1. **Still clipping to white toward the sun.** `ads`, `materials`, `street`, `weapon`
   and `skyline` all blow out to flat white down the street axis. Much improved, but
   the sun sits almost exactly along the street heading, so every ground-level preset
   shoots straight into it. Two things to try, in order: **re-aim the sun azimuth** so
   it rakes *across* the street rather than down it (this is what `ART_DIRECTION.md`
   asks for — the half-sun/half-shadow split is the whole shot), and check the
   auto-exposure metering weights in `passes/ExposurePass.js` aren't centre-weighted
   onto the bright end of the corridor.
2. **The grade is still largely neutral.** There is warmth in `goldenhour` now, but
   the noon presets have no warm-key/cool-fill separation. → `passes/GradePass.js` +
   `passes/LUT.js`; confirm the active look isn't stuck on `neutral`.
3. **Aerial perspective reads as white haze, not coloured depth.** It should tint
   toward the sky colour in the view direction and leave the far plane readable.
   → `src/render/sky/AerialPerspective.js`. Partly downstream of #1.
4. **`goldenhour` has a flat, unlit left block** — the facade facing camera-left gets
   almost no light and no bounce, so it reads as a cardboard cutout. Likely the
   indirect/irradiance term not picking up the low sun. → `render/lighting/Indirect.js`.
5. **`weapon`/`ads`/`combat` presets show no weapon and no bots.** Expected — Wave 2 —
   but the presets need re-aiming once weapons and AI exist.
6. **Still a blockout.** No props, clutter, decals, vegetation or interiors. Every
   surface is clean and undamaged, violating most of the `ART_DIRECTION.md` density
   rules. This is Wave 2 and is the single largest remaining chunk of work.

Genuinely good already: material response at close range (brick and concrete both
hold up), the `night` shot end to end, `interior`'s archway framing, shadow softness,
cobblestone and asphalt ground surfaces, and the lamp-post fixtures.

---

## The plan from here

### Wave 2 — content (not started)
Eight agents on disjoint files, same pattern as Wave 1 (which worked well: 7 parallel
agents, zero merge conflicts, one integration pass):

| agent | owns | spec |
|---|---|---|
| level | `src/world/Level.js` | `docs/ART_DIRECTION.md` — ASHFALL, three-lane, 110×80 m |
| props | `src/world/Props.js` | density rules in ART_DIRECTION §"Density rules" |
| vegetation | `src/world/Vegetation.js` | instanced, wind |
| weapons | `src/weapons/**` | `docs/GAMEPLAY.md` — 6 weapons, procedural viewmodels |
| fx | `src/fx/**` | impacts, tracers, decals, muzzle, smoke, shells |
| ai | `src/ai/**` | `docs/GAMEPLAY.md` — navmesh, behaviour tree, ragdoll death |
| audio | `src/audio/**` | `docs/GAMEPLAY.md` — all WebAudio synthesis, no files |
| hud | `src/ui/**` | `docs/GAMEPLAY.md` — must support `setVisible(false)` |

Before firing Wave 2, **fix defects 1–4 above first**. They are cheap, they are in
Wave 1 files nobody else will touch, and every screenshot Wave 2 produces will be
misleading until the sun azimuth and grade are right. Defect #1 in particular is
mostly a *sun direction* decision, and it should be made deliberately as art
direction rather than discovered later — it determines the composition of every
ground-level shot in the game.

### Wave 3 — the blind critic loop (not started)
Per camera preset, loop until pass:
1. `node tools/shoot.mjs --shots <name>`
2. `node tools/blind.mjs --a shots/<name>.png --b refs/<matched>.jpg --out blind/<name>`
   (use `refs/catalog.json` for the match; use `--bcrop` for `interior`/`materials`,
   which have no clean full-frame reference)
3. Hostile critic agent reads **only** the sheet, scores against `docs/CRITIC_RUBRIC.md`
4. Fix agent applies the top-5 fixes
5. Repeat

**Pass condition:** TOTAL ≥ 78/100, zero automatic failures, **and** blind confidence
≤ 65 %. The confidence term is the real bar — it means the critic genuinely cannot
tell which panel is ours.

---

## Things you should know before continuing

- **The scope call I made:** the game deliberately avoids photoreal humans. Procedural
  skin/cloth/faces lose a blind test instantly and no amount of iteration fixes that.
  The whole art direction is aimed at environment, light, atmosphere and surface,
  where a good renderer can genuinely trade blows. `refs/catalog.json` scores every
  reference frame for character-dominance so the critic never compares our empty
  street against a CoD hero close-up.
- **Honest expectation:** individual environment frames reaching coin-flip confidence
  is achievable. Matching the full game — animation, audio, content volume, mocap —
  is thousands of person-years and will not happen. Judge this on the frames.
- **Long-running agents can die on auth expiry and lose their report.** That is what
  happened to the Wave 1 integrator — its file edits survived on disk but its summary
  and its remaining checklist did not. When fanning out Wave 2, have each agent commit
  its own work as it goes rather than only at the end, so a mid-run death costs the
  report and not the work.
- **The parallel-agent pattern works well.** 7 agents, 17k lines, zero merge
  conflicts, one integration pass. The thing that made it work is `ARCHITECTURE.md`:
  disjoint file ownership, a written `ctx` API contract, and every agent told to
  verify with `vite build` + the screenshot harness before reporting. Keep all three.
- **`refs/`, `shots/`, `blind/`, `dist/`, `node_modules/` are gitignored.** The
  reference screenshots are official Activision press images used locally and
  transiently for critique; they are never redistributed or shipped with the build.
- The architecture contract in `docs/ARCHITECTURE.md` is what let 7 agents write
  17k lines simultaneously without a single merge conflict. Keep enforcing disjoint
  file ownership and the `ctx` API boundaries when you fan out Wave 2.
