import * as THREE from 'three';
import { makeRng, Batch } from './props/lib.js';
import { Site, BatchSet } from './props/layout.js';
import { scatterGround, rubblePiles, wallDrifts, wallBerms } from './props/clutter.js';
import {
  DecalKit, groundDecals, wallDecals, tyreTracks, hotspotDecals, groundingDust,
} from './props/decals.js';
import { facadeDetail } from './props/facade.js';
import { overheadLines, awnings, rooftops, fireEscape } from './props/overhead.js';
import { streetFurniture } from './props/furniture.js';

/**
 * Everything in the world that is not the building shell.
 *
 * The blockout renders correctly and is completely empty, and emptiness — not
 * shader quality — is what loses a blind comparison against a real Call of Duty
 * frame. `docs/CRITIC_RUBRIC.md` fails a shot outright for a bare ground plane;
 * `docs/ART_DIRECTION.md` lists eight density rules and the blockout satisfies
 * none of them. This system is the fix, and it is organised around the two
 * budgets that actually constrain the answer.
 *
 * **Draw calls, not triangles.** 350 budget, 178 spent by the shell, and a
 * shadow caster costs one draw per cascade on top of its own. So no prop is
 * ever its own mesh: `BatchSet` merges everything into buffers keyed by
 * material x spatial zone x casts-shadow. Ten thousand pieces come out as a few
 * dozen draws, each still frustum-culled to a 30 m band of street.
 *
 * **Placement must outlive the level.** `Level.js` belongs to another agent and
 * is expected to be rewritten. Nothing here knows a single map coordinate:
 * `Site` surveys the world at init through `ctx.physics.raycast` and hands back
 * walkable ground, a distance transform to the nearest obstruction, exposed
 * facade segments and rooftop rectangles. Every module places against those.
 *
 * Published API:
 * ```js
 * ctx.props = {
 *   root,                  // THREE.Group, added to the scene
 *   setDensity(0..1),      // hides the optional detail tiers, instantly
 *   density,               // current value
 *   stats,                 // { pieces, decals, draws, ... }
 *   site,                  // the survey, for anything that wants to place things
 * }
 * ```
 */

const SEED = 0x5eed1;

export class PropSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.density = 1;
    /** @type {THREE.Mesh[][]} meshes bucketed by the density tier that owns them. */
    this.tiers = [[], [], []];
    this.stats = { pieces: 0, decals: 0, draws: 0, tris: 0, rays: 0, ms: 0 };
    this._colliders = [];
    this._staticId = -1;

    const root = new THREE.Group();
    root.name = 'Props';
    this.root = root;

    // Publish first, populate second: a later system that resolves ctx.props
    // during its own init must never see undefined, and nothing here may throw.
    ctx.props = {
      root,
      density: 1,
      stats: this.stats,
      site: null,
      setDensity: (v) => this.setDensity(v),
    };

    const parent = ctx.level?.root || ctx.scene;
    if (parent) parent.add(root); else return;

    const t0 = (globalThis.performance || Date).now();
    try {
      this._build(ctx);
    } catch (e) {
      console.warn('[props] build failed, continuing with what landed', e);
    }
    this.stats.ms = Math.round(((globalThis.performance || Date).now() - t0) * 10) / 10;
    ctx.props.site = this.site || null;
    this._registerColliders(ctx);
  }

  // ------------------------------------------------------------------ build

  _build(ctx) {
    const rand = makeRng(SEED);
    const site = new Site(ctx);
    site.survey();
    this.site = site;
    this.stats.rays = site.rayCount;

    // Tier 0 is the frame; tiers 1 and 2 are shed by setDensity in that order.
    // Only the core tier is worth splitting spatially and worth casting
    // shadows: it holds the readable silhouettes. Gravel and litter are merged
    // whole-map and never cast — 3 cascade draws for a 4 cm stone is the
    // definition of a bad trade against a 350 draw budget.
    const core = new BatchSet('core');
    const detail = new BatchSet('detail', Infinity, false);
    const fine = new BatchSet('fine', Infinity, false);
    // Decals get their own set: they need a different material configuration
    // (blended, depth-write off, polygon-offset) and a render order after the
    // opaque props they sit on.
    const decalSoft = new BatchSet('decalSoft', Infinity, false);
    const decalHard = new BatchSet('decalHard', Infinity, false);

    let pieces = 0;
    // Structure before scatter: the facade and roof passes claim their ground
    // with site.occupy(), and the clutter fields respect it.
    pieces += facadeDetail(ctx, site, core, rand, 1).parts;
    pieces += rooftops(ctx, site, core, rand, 1).parts;
    pieces += awnings(ctx, site, core, rand, 1).parts;
    pieces += overheadLines(ctx, site, core, rand, 1).parts;
    pieces += fireEscape(ctx, site, core, rand).parts;
    const furniture = streetFurniture(ctx, site, core, rand, 1);
    pieces += furniture.parts;
    this._colliders = furniture.colliders;
    pieces += rubblePiles(ctx, site, core, rand, 1).pieces;
    pieces += wallDrifts(ctx, site, detail, rand, 1).pieces;
    pieces += wallBerms(ctx, site, core, rand, 1).pieces;
    pieces += scatterGround(ctx, site, fine, rand, 1).pieces;

    const kit = new DecalKit(0xd3ca1);
    this.decalKit = kit;
    let dec = 0;
    dec += groundDecals(ctx, site, decalSoft, decalHard, kit, rand, 1).count;
    dec += tyreTracks(ctx, site, decalHard, kit, rand, 1).count;
    dec += wallDecals(ctx, site, decalSoft, decalHard, kit, rand, 1).count;
    dec += hotspotDecals(ctx, site, decalSoft, decalHard, kit, rand, furniture.hotspots).count;
    dec += groundingDust(ctx, site, decalSoft, kit, rand, this._colliders).count;

    // Tier order is "what to shed first", and that is decided by cost per unit
    // of frame, not by how much geometry it is. The blended decals are one mesh
    // and they are the single most expensive thing here, because a transparent
    // surface writes no depth and every pixel it covers re-runs the standard
    // shader with a three-cascade PCSS lookup. So they go last-in, first-out.
    this.tiers[0] = core.build(ctx, this.root);
    this.tiers[1] = detail.build(ctx, this.root);
    this.tiers[1].push(...fine.build(ctx, this.root));
    this.tiers[1].push(...decalHard.build(ctx, this.root, { overrides: kit.overrides(false) }));
    this.tiers[2] = decalSoft.build(ctx, this.root, {
      overrides: kit.overrides(true), renderOrder: 3,
    });

    this.stats.pieces = pieces;
    this.stats.decals = dec;
    this._tally();
  }

  _tally() {
    let draws = 0, tris = 0;
    for (const tier of this.tiers) {
      for (const m of tier) {
        if (!m.visible) continue;
        draws++;
        if (m.castShadow) draws += Math.max(0, (this.ctx.quality?.cascades || 3) - 1);
        const pos = m.geometry.attributes.position;
        tris += pos ? pos.count / 3 : 0;
      }
    }
    this.stats.draws = draws;
    this.stats.tris = Math.round(tris);
  }

  /**
   * Colliders are registered as one merged soup with a PROPS mask, and only for
   * things a player can actually stand on or be stopped by. Bedding six
   * thousand gravel chips into the BVH would cost more than it is worth and
   * would make the character controller trip over pebbles.
   */
  _registerColliders(ctx) {
    const phys = ctx.physics;
    if (!phys?.addStatic || !this._colliders?.length) return;
    const layer = phys.LAYER?.PROPS || 2;
    // One merged soup per surface key, so a bullet still gets the right impact
    // material without one addStatic call per crate.
    const bySurface = new Map();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const c of this._colliders) {
      let b = bySurface.get(c.surface);
      if (!b) { b = new Batch('collider:' + c.surface); bySurface.set(c.surface, b); }
      e.set(0, c.yaw || 0, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(c.x, c.y, c.z), q, new THREE.Vector3(c.w, c.h, c.d));
      b.addMatrix(unit, m, null);
    }
    this.staticIds = [];
    for (const [surface, batch] of bySurface) {
      const g = batch.build();
      if (!g) continue;
      const id = phys.addStatic(g, undefined, { material: surface, mask: layer });
      if (id > 0) this.staticIds.push(id);
      g.dispose();
    }
    unit.dispose();
    phys.buildStaticBVH?.();
  }

  // -------------------------------------------------------------- runtime

  /**
   * 1 keeps everything; lower values shed the optional tiers so a weak GPU can
   * still hold 60. Visibility only — nothing is rebuilt, so it is instant and
   * reversible.
   */
  setDensity(v) {
    const d = THREE.MathUtils.clamp(Number(v) || 0, 0, 1);
    this.density = d;
    if (this.ctx?.props) this.ctx.props.density = d;
    const thresholds = [0, 0.34, 0.67];
    for (let t = 0; t < this.tiers.length; t++) {
      const on = d > thresholds[t] - 1e-6;
      for (const m of this.tiers[t]) m.visible = on;
    }
    this._tally();
    return d;
  }

  update(dt, ctx) {
    // main.js merges into window.__COD__ rather than replacing it, but the
    // harness may load before this system has run, so attach lazily.
    const api = globalThis.window && window.__COD__;
    if (api && !api.setPropDensity) {
      api.setPropDensity = (v) => this.setDensity(v);
      api.propStats = () => this.stats;
    }
  }

  dispose() {
    for (const tier of this.tiers) {
      for (const m of tier) m.geometry?.dispose();
      tier.length = 0;
    }
    this.root?.removeFromParent();
  }
}
