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

---

## Integration visual pass (resumed)

Picks up the checklist the Wave 1 integrator died before finishing. Ten presets
re-rendered after every change at 1600x900 into `shots/fix/`, contact sheet at
`shots/_fix_sheet.png`, and every claim below was checked against the PNG, not
inferred. Baseline for comparison: `docs/state-at-pause.png` / `shots/base/`.

**Final harness numbers:** 60 fps, 178 draw calls, 2180 tris, 32 programs,
`errors: []`, ANGLE Metal / Apple M2. (Draw calls fell 210 -> 178 purely from
cascade culling once the sun moved off the street axis.)

Each item was committed separately, so a mid-run death costs the report and not
the work: `3851819`, `97c399e`, `070d121`, `5095307`, `a784463`.

### 1. Sun azimuth — FIXED. `src/render/sky/constants.js`

`NORTH_OFFSET` -90 deg -> **-25 deg**. That is the map's compass orientation and
it is the only knob; every other sun/moon/star consumer derives from it.

The street runs along Z. At -90 the mid-morning sun came up 6 deg off the street
axis, so `street`/`ads`/`weapon`/`materials`/`skyline` all shot into the disk.
At -25 the sun bearing is +66 deg from the street axis at tod 0.30 (the
"MORNING RAID" primary look) and +71 deg at 0.32, elevation unchanged at
23-28 deg. Rationale, written up in full in the comment on the constant:

- the disk sits outside a 70 deg-fov frame looking down the street;
- the sun is on the +X (east) side, so the west facades are in hard sun and the
  east facades fall to sky fill — the warm-key / cool-fill split;
- the east blocks' staggered heights (10.5 / 15.5 / 8.0 / 19.0 m) cast across
  the 22.8 m facade-to-facade corridor, so the road is mostly shadow with a
  sunlit pool opening mid-corridor behind the short 8 m block;
- light rakes into the west room's east-facing doorway, so `interior` gets a
  real shaft;
- at golden hour the same offset swings the low sun round to -X, which turns the
  establishing camera's back-light into a cross-frame rake.

**Evidence:** in the baseline `street`/`ads`/`weapon` the far half of the frame
is a single white field with no shadow anywhere on the road. After: a hard
shadow edge runs diagonally across the asphalt, the west facades are cream and
the east facades are blue-shadowed, and the sky resolves as blue with clouds.
This is the highest-value change in the pass by a wide margin.

### 2. Auto-exposure metering — FIXED. `src/render/passes/ExposurePass.js`

Yes, the residual clipping was metering. The meter was a centre-weighted log
average, which on a half-sun / half-shadow street keys to the shadow half.

The seed pass now accumulates the **second moment** of log luminance as well as
the first; adapt keys off `exp(mean + 0.62 * sigma)` — log luminance is close
enough to normal that this is a percentile, roughly the 73rd — with sigma capped
at 1.75 so a night frame of black street plus three sodium lamps does not meter
itself into the ground. Centre weighting widened (Gaussian 2.0 -> 1.15). The
luminance chain moved to `FloatType`: the variance is a difference of two
similar second moments and half float loses it in the noise.

**Evidence:** pixels sitting at the display ceiling, across the daytime presets,
went from 8-17% of the frame to 0-1.1%. `street` 16.6% -> 0.08%. The sky is
still bright, as intended; the concrete is no longer white.

### 3. Grade — FIXED. `src/render/passes/LUT.js`

The active look was **not** stuck on neutral — `PostFX._updateLook` was already
crossfading to `warm_desert` by day and `night_teal` at night with
`lutStrength` 1. The look itself was near-neutral: `sat` 1.07 with a mild shadow
pull, so noon read blue-grey.

Added `otBoost` to the bake: project the residual chroma onto a
luminance-neutral orange/teal axis (unit chroma of a saturated orange, dot with
the luma weights ~2e-4) and re-add a fraction of it. `warm_desert` now runs
`sat` 0.88 — the ~12% global desaturation ART_DIRECTION asks for — plus
`otBoost` 0.42, so greens and magentas stay muted while warm keys and cool fills
keep their chroma. Split tone strengthened both ways, `blackLift` 0.013 ->
**0.022** so the toe stops above the 0.02 the spec requires. `night_teal` and
`cold_urban` get a gentler boost and the same lift.

**Evidence:** `street` mean saturation 0.34 -> 0.43 with 1st-percentile luma
6.4 -> 8.8 (nothing crushed). Visually the frame now separates into cream
sunlit concrete against blue-teal shadow instead of one grey.

### 4. Aerial perspective — FIXED. `src/render/sky/AerialPerspective.js`, `src/render/Sky.js`

Two independent faults.

*Colour:* the inscatter was a single constant (horizon radiance x 0.82) for
every view ray, so it painted one flat sheet over the frame. The shader now
blends horizon -> zenith radiance by view elevation and darkens toward a
ground-bounce term looking down, on top of the existing HG sun lobe.
`apParams` grew 4 -> 5 vec4s for the zenith colour and ground falloff.

*Amount:* density was 0.0011/m, i.e. **6% opacity across the market street's
70 m sightline** — invisible, against ART_DIRECTION's "visibly desaturate and
lift the blacks at 40 m+". Now 0.0052/m: ~19% at 40 m, ~30% at 70 m, ~0.6 at
200 m, capped at 0.85 so the far plane stays readable.

**Evidence:** `skyline` now resolves three depth planes — crisp foreground
masonry, lightly hazed mid blocks, far lamps and barriers still legible inside
strong haze — and the haze is blue looking up and warm looking toward the sun
rather than white everywhere.

### 5. Golden-hour unlit facade — FIXED, but mostly by item 1. `src/render/lighting/Indirect.js`

The specific symptom (the camera-left block reading as a cardboard cutout) was
resolved by the sun re-aim: at tod 0.76 the -25 deg offset puts the low sun off
to camera-left, so both blocks now take a warm key. See `shots/fix/goldenhour.png`.

Two genuine defects in the indirect term were still there and are fixed:

1. **The sky fill had no azimuth.** One averaged horizon colour was projected
   round the whole ring, so a facade facing the sun's half of the sky got the
   same fill as one facing away. The horizon band and the ground bounce now vary
   with alignment to the sun's azimuth (ring gain 0.60-1.72 at low sun, flat at
   high sun, mean ~1.15, so it redistributes rather than adds). The circumsolar
   lobe was broadened off `d^3` — SH9 cannot carry a tight lobe and the deringer
   was eating most of it.
2. **The ambient floor floored nothing.** "Never let an interior fall to pure
   black; the hemisphere is the floor" was a fixed 0.05 intensity against an HDR
   `skyColor` in `sky.exposure` units — under 2% of the real fill at noon. It is
   now anchored to the DC term of the projected sky and opens up as sky
   visibility closes down.

**Evidence:** median luma `interior` 34.6 -> 43.0, `night` 43.4 -> 50.6,
`street` 30.3 -> 38.5, with no change in ceiling pixels. In `interior` the brick
around the doorway now carries visible tone and detail instead of reading as a
flat silhouette.

**Still wrong here:** the fix barely moved the *street* shadow side, because at
`ambientScale` 0.32 the probe is only a third of the sky fill — `scene.environment`
(PMREM of the dome, `envMapIntensity` 1) supplies the rest and is untouched by
any of this. The measured lit/shadow contrast on concrete is 3.2 stops, which is
physically about right, so this is not an under-lighting bug; see the tone-range
note below.

### Top remaining visual defects, ranked

1. **Our histogram is hotter than the reference frames.** Measured against
   `refs/` (mw3_03/04/06/07/09): real CoD daylight sits at p95 150-225 and p99
   197-242. Ours is p95 240-247, p99 245-250. Their frames have far more
   highlight compression and a higher median. The next move is the tone curve,
   not the lighting: a real shoulder before the LUT, or a lower `whiteCut` with
   the S-curve pivot raised. `refs/` plus the scratch histogram tool make this
   measurable rather than a matter of taste.
2. **Shadowed asphalt reads very dark and very blue** (12,18,40 sRGB in the
   `street` foreground). Partly (1); partly that `asphalt`'s albedo in
   `MaterialDefs.js` is 0x2d2d2f = 0.027 linear, below real aged asphalt
   (0.07-0.10). Worth raising, but it touches every ground surface so it wants
   its own pass.
3. **`establishing` and `goldenhour` are framed into a wall.** The preset camera
   at (26, 9.5, 34) sits behind the east block row (x 11.4..26.4, parapet top
   11.4 m at z 9.5..22.5), so it looks at brick, not at the map. That is why
   "three depth planes in `establishing`" cannot be demonstrated in that frame —
   `skyline` had to stand in. Fixing it is a one-line camera move in
   `tools/shoot.mjs`, which was out of scope for this pass. **Do this first next
   time** — it is the shot the whole map should be judged on and it is currently
   blind.
4. **No shadow on the near foreground road in `street`/`ads`/`weapon`.** The
   camera stands inside the shadow of a 15.5 m block, so the bottom half of the
   frame is one unbroken dark field. Wave 2 clutter fixes this by construction;
   until then the frames are bottom-heavy.
5. Everything in the pre-existing list from item 5 and 6 above (no weapon, no
   bots, still a blockout) is unchanged and still true.
