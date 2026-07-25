# HANDOFF — Claude of Duty

**Paused:** 2026-07-25, after Wave 1 (rendering + simulation foundation).
**Repo:** `/Users/jacksmith/Documents/github/jack/claude-of-duty` (git, no remote)
**Last good commit:** `93cc934` — *wave1: procedural PBR textures, material shaders,
atmosphere, CSM lighting, BVH physics, player movement, postfx stack*

---

## 30-second summary

The engine and the whole rendering pipeline are **built and working**. ~17,400 lines
across 80 files. The harness renders 10 fixed camera presets headless on a real GPU
with **zero console errors at 42 fps**.

What is missing is **content, exposure and grade** — the game currently renders a
placeholder greybox beautifully. Wave 2 (level art, props, weapons, FX, AI, audio,
HUD) has not started. No visual critic loop has run yet.

Do not judge the project by the current screenshots: the level is still the 27-line
placeholder from the scaffold. The renderer under it is real.

---

## Resume in three commands

```bash
cd /Users/jacksmith/Documents/github/jack/claude-of-duty
npm run dev                 # play it: http://localhost:5173  (click to lock pointer)
node tools/shoot.mjs        # render all 10 presets to shots/ + shots/report.json
node tools/contact.mjs --dir shots --out shots/_sheet.png --cols 3   # review them at a glance
```

If anything is broken on resume: `git reset --hard 93cc934` is a known-good state.

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

Assessed from `shots/integrated/` (contact sheet at `shots/_wave1_sheet.png`).

1. **Exposure is blown out.** Sky and everything past ~30 m is clipped pure white in
   7 of 10 shots. This single defect makes the frames look worse than the geometry
   deserves. → `src/render/passes/ExposurePass.js`. Either auto-exposure is metering
   off a dark foreground and over-compensating, or the fixed EV is several stops hot.
   Check `renderer.toneMappingExposure` in `Renderer.js` isn't double-applying on top
   of the pass.
2. **The grade is monochrome blue-grey.** `docs/ART_DIRECTION.md` calls for a
   warm-key / cool-fill split; there is no warm anywhere. → `passes/GradePass.js` +
   `passes/LUT.js`; confirm `ctx.sky.sunColor` actually reaches the sun light and that
   the active LUT isn't stuck on `neutral`.
3. **Fog is pure white and far too dense.** It erases depth instead of layering it.
   Aerial perspective should tint toward the sky colour in the view direction and
   should still leave the far plane readable. → `src/render/sky/AerialPerspective.js`.
4. **Golden hour renders as night** — stars visible at TOD 0.09. The preset TOD values
   in `tools/shoot.mjs` were authored before the real ephemeris existed and no longer
   map to the intended sun elevations. → retune `SHOTS[*].tod` against `sky/Ephemeris.js`.
5. **The `interior` preset camera is inside a wall**, and `weapon`/`ads`/`combat`
   presets show no weapon and no bots. Both are expected — those systems are Wave 2 —
   but the preset coordinates were authored for the ASHFALL layout that does not
   exist yet, and must be re-aimed once the level lands.
6. **42 fps at 1080p**, against a 60 target. Not yet profiled. 94 draw calls and 832
   triangles means it is entirely fill/post cost, not geometry — start by timing the
   post passes individually.
7. **Still greybox.** No architecture, props, clutter, decals or vegetation. This is
   Wave 2 and is the single largest remaining chunk of work.

Genuinely good already: close-up material response, the night shot's moon/star/blue
grade, shadow softness, and the sense of atmospheric distance (once the fog is fixed).

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
misleading until exposure and grade are right.

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
- **A Wave 1 integration agent was still running when we paused.** It had already
  produced all 10 screenshots cleanly; it was in its "read each PNG and fix cheap
  wins" stage. If the working tree has uncommitted changes on resume, that is its
  work — `git diff` it, keep what is good.
- **`refs/`, `shots/`, `blind/`, `dist/`, `node_modules/` are gitignored.** The
  reference screenshots are official Activision press images used locally and
  transiently for critique; they are never redistributed or shipped with the build.
- The architecture contract in `docs/ARCHITECTURE.md` is what let 7 agents write
  17k lines simultaneously without a single merge conflict. Keep enforcing disjoint
  file ownership and the `ctx` API boundaries when you fan out Wave 2.
