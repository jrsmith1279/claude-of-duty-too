import * as THREE from 'three';
import { chamferBox, pipeGeo, corrugatedGeo, lumpGeo, projectUV, jitterColor, twoSided } from './lib.js';

/**
 * Wall break-up — `ART_DIRECTION.md` rule 1: "no unbroken surface larger than
 * ~3 m".
 *
 * The blockout's facades are 15 x 19 m untextured-looking slabs, and no amount
 * of shader detail rescues a surface that has nothing *on* it: what tells the
 * eye a wall is a building is the horizontal rhythm of floor levels and the
 * grid of openings, both of which are silhouette, not texture.
 *
 * So the order of value here is: string courses first (they cut a 19 m wall
 * into readable storeys for almost no geometry), then window bays, then the
 * services — drainpipes, conduit, meter cabinets, vents, split AC units,
 * satellite dishes. Everything is derived from the surveyed facade segment, so
 * a taller building gets more storeys and a longer one more bays without
 * anybody choosing where.
 *
 * The windows are the one non-obvious trick. The shell is solid, so there is no
 * hole to look through — instead each opening is a five-sided reveal box pushed
 * *into* the wall with a near-black back panel. From outside, a recessed dark
 * rectangle with a lit sill and a jamb shadow is indistinguishable from a real
 * opening, and it costs eight boxes rather than a re-cut wall mesh.
 */

const _c = new THREE.Color();
const _dark = new THREE.Color();

const STOREY = 3.3;          // m between string courses
const BAY = 3.6;             // m between window centres
const WIN_W = 1.15;
const WIN_H = 1.55;
const REVEAL = 0.3;          // how far the opening is recessed

// Geometry is generated once and shared; every instance is a transform.
let G = null;
function geo() {
  if (G) return G;
  const thin = (w, h, d, c = 0.012) => chamferBox(w, h, d, c);
  G = {
    band: chamferBox(1, 0.2, 0.11, 0.025),        // string course, scaled in X
    sill: chamferBox(1, 0.09, 0.19, 0.022),
    lintel: chamferBox(1, 0.16, 0.13, 0.022),
    revealBack: thin(1, 1, 0.05),
    revealSide: thin(0.06, 1, 1),
    revealTop: thin(1, 0.06, 1),
    frameV: thin(0.07, 1, 0.07, 0.01),
    frameH: thin(1, 0.07, 0.07, 0.01),
    board: thin(1, 0.16, 0.028, 0.006),
    shard: (() => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.35, 0, -0.1, 0.5, 0,
        -0.5, -0.5, 0, -0.1, 0.5, 0, 0.5, -0.35, 0,
      ]);
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.computeVertexNormals();
      projectUV(g);
      return g;
    })(),
    shutter: twoSided(corrugatedGeo(1, 1, 16, 0.012)),
    pipe: pipeGeo(0.055, 1, 8, false),
    // Rotated at build time so the unit length lies along local X (the facade
    // direction) or local Z (out of the wall); the placement helper only ever
    // yaws, so anything not vertical has to arrive pre-oriented.
    pipeAlong: pipeGeo(0.026, 1, 6, false).rotateZ(Math.PI / 2),
    pipeOut: pipeGeo(0.022, 1, 5, false).rotateX(Math.PI / 2),
    bracket: chamferBox(0.09, 0.05, 0.16, 0.012),
    box: chamferBox(0.4, 0.56, 0.2, 0.03),
    boxLid: chamferBox(0.44, 0.05, 0.24, 0.015),
    vent: chamferBox(0.5, 0.36, 0.13, 0.02),
    slat: chamferBox(0.44, 0.03, 0.06, 0.006),
    ac: chamferBox(0.86, 0.56, 0.34, 0.035),
    acGrille: chamferBox(0.7, 0.44, 0.03, 0.008),
    acFoot: chamferBox(0.06, 0.09, 0.4, 0.012),
    dish: (() => {
      // Shallow spherical cap: a lathe of a parabola, back-facing removed by
      // keeping it double-thin rather than open.
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push(new THREE.Vector2(t * 0.42, t * t * 0.16));
      }
      const g = new THREE.LatheGeometry(pts, 14);
      // Open toward +Z and cocked 17 degrees up, which is roughly where a
      // geostationary bird sits from this latitude and, more to the point,
      // catches the sun as a bright disc against a shadowed wall.
      g.rotateX(Math.PI / 2 - 0.3);
      projectUV(g);
      return g;
    })(),
    patch: lumpGeo(0.5, 0.42, [1, 1, 0.09], 1, 7),
  };
  return G;
}

/** Local frame of a facade: `u` runs along it, `n` points out of it. */
function frame(f) {
  const dx = f.bx - f.ax, dz = f.bz - f.az;
  const len = Math.hypot(dx, dz) || 1;
  return {
    len, ux: dx / len, uz: dz / len, nx: f.nx, nz: f.nz,
    yaw: Math.atan2(f.nx, f.nz),
  };
}

/**
 * Places a box-like part on a facade. `t` runs 0..1 along the segment, `y` is
 * world height, `out` is metres proud of the wall face (negative = recessed).
 * Sizes are given in facade-local (along, up, out) metres.
 */
function put(bs, key, g, fr, f, t, y, out, along, up, depth, color, shadow = true) {
  const x = f.ax + fr.ux * fr.len * t + fr.nx * out;
  const z = f.az + fr.uz * fr.len * t + fr.nz * out;
  bs.add(key, g, x, y, z, 0, fr.yaw, 0, along, up, depth, color, shadow);
}

/**
 * @param {any} ctx
 * @param {import('./layout.js').Site} site
 * @param {import('./layout.js').BatchSet} bs
 * @param {() => number} rand
 */
export function facadeDetail(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;
  /** @type {{x:number,y:number,z:number,nx:number,nz:number,w:number}[]} */
  const sills = [];

  for (const f of site.facades) {
    const fr = frame(f);
    if (fr.len < 2.4) continue;
    const h = f.top - f.base;
    if (h < 2.4) continue;

    // Per-building tint so no two facades sit at the same value — rule 5.
    jitterColor(_c, rand, 0.2, 0.05, 0.05);
    const wallTint = _c.clone();
    _dark.setRGB(0.1, 0.1, 0.105);

    // --- 1. String courses. One 19 m wall becomes six readable storeys.
    const storeys = Math.max(1, Math.floor(h / STOREY));
    for (let s = 1; s <= storeys; s++) {
      const y = f.base + s * (h / (storeys + 0.15));
      if (y > f.top - 0.5) break;
      _c.copy(wallTint).multiplyScalar(1.06);
      put(bs, 'concrete_wall', g.band, fr, f, 0.5, y, 0.055, fr.len + 0.1, 1, 1, _c, true);
      parts++;
    }
    // A heavier plinth at the bottom: buildings do not meet the ground flush.
    _c.copy(wallTint).multiplyScalar(0.94);
    put(bs, 'concrete_wall', g.band, fr, f, 0.5, f.base + 0.28, 0.075,
      fr.len + 0.1, 2.6, 1.5, _c, true);
    parts++;

    // --- 2. Window bays.
    const bays = Math.max(1, Math.round(fr.len / BAY));
    const floors = Math.max(1, Math.floor((h - 1.0) / STOREY));
    for (let fl = 0; fl < floors; fl++) {
      const yc = f.base + 1.35 + fl * STOREY;
      if (yc + WIN_H * 0.5 > f.top - 0.7) break;
      for (let b = 0; b < bays; b++) {
        const t = (b + 0.5) / bays;
        if (rand() < 0.1) continue;                 // a blank panel here and there
        const ww = WIN_W * (0.85 + rand() * 0.4);
        const wh = WIN_H * (0.85 + rand() * 0.35);
        parts += window_(bs, g, fr, f, t, yc, ww, wh, rand, wallTint);
        sills.push({
          x: f.ax + fr.ux * fr.len * t + fr.nx * 0.1,
          z: f.az + fr.uz * fr.len * t + fr.nz * 0.1,
          y: yc - wh * 0.5 - 0.05, nx: fr.nx, nz: fr.nz, w: ww,
        });
      }
    }

    // --- 3. Rainwater goods. A drainpipe every few metres, full height.
    const pipes = Math.max(1, Math.round(fr.len / 7 * density));
    for (let i = 0; i < pipes; i++) {
      const t = (i + 0.5 + (rand() - 0.5) * 0.3) / pipes;
      const key = rand() < 0.45 ? 'metal_rusted' : 'metal_painted';
      jitterColor(_c, rand, 0.28, 0.08, 0.06);
      const top = f.top - 0.1, bot = f.base + 0.35;
      put(bs, key, g.pipe, fr, f, t, (top + bot) / 2, 0.09, 1, top - bot, 1, _c, true);
      // Shoe at the bottom, kicking out over the pavement.
      put(bs, key, g.pipe, fr, f, t, bot - 0.16, 0.155, 1, 0.42, 1, _c, true);
      parts += 2;
      for (let k = 0; k < Math.max(2, ((top - bot) / 2.4) | 0); k++) {
        const y = bot + 0.6 + k * 2.4;
        if (y > top) break;
        put(bs, key, g.bracket, fr, f, t, y, 0.05, 1, 1, 1, _c, false);
        parts++;
      }
    }

    // --- 4. Conduit: a horizontal run with a couple of drops off it.
    if (rand() < 0.8) {
      const y = f.base + 2.4 + rand() * 0.7;
      const span = 0.5 + rand() * 0.45;
      jitterColor(_c, rand, 0.24, 0.06, 0.03);
      put(bs, 'metal_painted', g.pipeAlong, fr, f, 0.5, y, 0.06, fr.len * span, 1, 1, _c, false);
      parts++;
      for (let k = 0, n = 1 + ((rand() * 3) | 0); k < n; k++) {
        const t = 0.5 + (rand() - 0.5) * span;
        const drop = 0.6 + rand() * 1.2;
        put(bs, 'metal_painted', g.pipeAlong, fr, f, t, y - drop / 2, 0.06, 1, 1, 1, _c, false);
        put(bs, 'metal_painted', g.pipe, fr, f, t, y - drop / 2, 0.06, 0.5, drop, 0.5, _c, false);
        parts += 2;
      }
    }

    // --- 5. Meter cabinets, vents, and the odd AC unit.
    const boxes = Math.round(fr.len * 0.14 * density);
    for (let i = 0; i < boxes; i++) {
      const t = rand();
      const y = f.base + 1.1 + rand() * 0.7;
      jitterColor(_c, rand, 0.3, 0.1, 0.02);
      put(bs, 'metal_painted', g.box, fr, f, t, y, 0.1, 1, 1, 1, _c, true);
      put(bs, 'metal_painted', g.boxLid, fr, f, t, y + 0.3, 0.11, 1, 1, 1, _c, false);
      parts += 2;
    }
    const vents = Math.round(fr.len * 0.1 * density);
    for (let i = 0; i < vents; i++) {
      const t = rand();
      const y = f.base + 1.6 + rand() * Math.max(0.6, h - 3);
      jitterColor(_c, rand, 0.26, 0.06, 0.04);
      put(bs, 'metal_rusted', g.vent, fr, f, t, y, 0.06, 1, 1, 1, _c, true);
      for (let k = 0; k < 4; k++) {
        put(bs, 'metal_rusted', g.slat, fr, f, t, y - 0.12 + k * 0.08, 0.11, 1, 1, 1, _c, false);
      }
      parts += 5;
    }

    // --- 6. Split AC units. Every one gets a rust streak below it from the
    // decal pass, because condensate is the most reliable dirt source there is.
    const acs = Math.round(fr.len * 0.11 * density);
    for (let i = 0; i < acs; i++) {
      const t = rand();
      const y = f.base + 2.3 + rand() * Math.max(0.5, h - 4);
      jitterColor(_c, rand, 0.16, 0.03, 0.04);
      _c.multiplyScalar(1.1);
      put(bs, 'metal_painted', g.ac, fr, f, t, y, 0.2, 1, 1, 1, _c, true);
      put(bs, 'metal_painted', g.acGrille, fr, f, t, y, 0.375, 1, 1, 1, _c, false);
      for (const s of [-1, 1]) {
        const off = s * 0.44;
        const x = f.ax + fr.ux * (fr.len * t + off) + fr.nx * 0.19;
        const z = f.az + fr.uz * (fr.len * t + off) + fr.nz * 0.19;
        bs.add('metal_rusted', g.acFoot, x, y - 0.33, z, 0, fr.yaw, 0, 1, 1, 1, _c, false);
      }
      parts += 4;
      sills.push({
        x: f.ax + fr.ux * fr.len * t + fr.nx * 0.06,
        z: f.az + fr.uz * fr.len * t + fr.nz * 0.06,
        y: y - 0.3, nx: fr.nx, nz: fr.nz, w: 0.8,
      });
    }

    // --- 7. Satellite dishes: pure silhouette, and instantly reads as lived in.
    const dishes = Math.round(fr.len * 0.06 * density);
    for (let i = 0; i < dishes; i++) {
      const t = rand();
      const y = f.base + 2.8 + rand() * Math.max(0.5, h - 4.5);
      const tilt = (rand() - 0.5) * 0.4;
      const spin = fr.yaw + (rand() - 0.5) * 0.9;
      const x = f.ax + fr.ux * fr.len * t + fr.nx * 0.55;
      const z = f.az + fr.uz * fr.len * t + fr.nz * 0.55;
      _c.setRGB(1.12, 1.1, 1.05);
      bs.add('metal_painted', g.dish, x, y + tilt * 0.05, z, 0, spin, 0, 1, 1, 1, _c, true);
      put(bs, 'metal_rusted', g.pipeOut, fr, f, t, y, 0.28, 1, 1, 0.56, _c, false);
      parts += 2;
    }
  }

  return { parts, sills };
}

/** One window: recessed reveal, frame, sill, lintel, and whatever fills it. */
function window_(bs, g, fr, f, t, yc, ww, wh, rand, wallTint) {
  let n = 0;
  const dark = _dark.setRGB(0.09, 0.09, 0.1);

  // Back of the reveal, and the four returns. The dark back and the shadow it
  // sits in are what sell the hole.
  put(bs, 'concrete_wall', g.revealBack, fr, f, t, yc, -REVEAL, ww, wh, 1, dark, false);
  for (const s of [-1, 1]) {
    const off = s * (ww / 2);
    const x = f.ax + fr.ux * (fr.len * t + off) + fr.nx * (-REVEAL / 2);
    const z = f.az + fr.uz * (fr.len * t + off) + fr.nz * (-REVEAL / 2);
    _c.copy(wallTint).multiplyScalar(0.7);
    bs.add('concrete_wall', g.revealSide, x, yc, z, 0, fr.yaw, 0, 1, wh, REVEAL, _c, false);
    n++;
  }
  _c.copy(wallTint).multiplyScalar(0.6);
  put(bs, 'concrete_wall', g.revealTop, fr, f, t, yc + wh / 2, -REVEAL / 2, ww, 1, REVEAL, _c, false);
  _c.copy(wallTint).multiplyScalar(1.08);
  put(bs, 'concrete_floor', g.revealTop, fr, f, t, yc - wh / 2, -REVEAL / 2 + 0.02, ww, 1, REVEAL, _c, false);
  n += 3;

  // Sill, proud of the wall so it throws a line of shade and starts a streak.
  _c.copy(wallTint).multiplyScalar(1.12);
  put(bs, 'concrete_floor', g.sill, fr, f, t, yc - wh / 2 - 0.05, 0.055, ww + 0.28, 1, 1, _c, true);
  // Lintel.
  _c.copy(wallTint).multiplyScalar(1.02);
  put(bs, 'concrete_wall', g.lintel, fr, f, t, yc + wh / 2 + 0.1, 0.03, ww + 0.24, 1, 1, _c, true);
  n += 2;

  // Frame.
  const frameKey = rand() < 0.55 ? 'wood_plank' : 'metal_painted';
  jitterColor(_c, rand, 0.28, 0.1, 0.03);
  for (const s of [-1, 1]) {
    const off = s * (ww / 2 - 0.03);
    const x = f.ax + fr.ux * (fr.len * t + off) + fr.nx * (-0.05);
    const z = f.az + fr.uz * (fr.len * t + off) + fr.nz * (-0.05);
    bs.add(frameKey, g.frameV, x, yc, z, 0, fr.yaw, 0, 1, wh, 1, _c, false);
  }
  put(bs, frameKey, g.frameH, fr, f, t, yc + wh / 2 - 0.03, -0.05, ww, 1, 1, _c, false);
  put(bs, frameKey, g.frameH, fr, f, t, yc - wh / 2 + 0.03, -0.05, ww, 1, 1, _c, false);
  put(bs, frameKey, g.frameV, fr, f, t, yc, -0.05, 1, wh, 1, _c, false);
  n += 5;

  // What is left in the opening.
  const roll = rand();
  if (roll < 0.24) {
    // Boarded up.
    const boards = 2 + ((rand() * 3) | 0);
    jitterColor(_c, rand, 0.3, 0.08, 0.07);
    for (let i = 0; i < boards; i++) {
      const y = yc - wh * 0.35 + (i / Math.max(1, boards - 1)) * wh * 0.7;
      put(bs, 'wood_plank', g.board, fr, f, t, y, -0.06, ww * (1 + rand() * 0.1),
        1 + rand() * 0.5, 1, _c, false);
      n++;
    }
  } else if (roll < 0.42) {
    // Roller shutter, part way down. Rusted stock rather than galvanised:
    // metal_corrugated is metalness 1 at roughness 0.46 and in a shaded
    // opening it mirrors the sky as a bright blue-white blind.
    jitterColor(_c, rand, 0.24, 0.07, 0.06);
    _c.multiplyScalar(0.85);
    const drop = 0.35 + rand() * 0.6;
    put(bs, 'metal_rusted', g.shutter, fr, f, t, yc + wh * (0.5 - drop / 2), -0.07,
      ww * 0.98, wh * drop, 1, _c, false);
    n++;
  } else if (roll < 0.72) {
    // Blown glass: a few shards still gripped by the frame.
    const shards = 2 + ((rand() * 4) | 0);
    for (let i = 0; i < shards; i++) {
      // Glass shards ride the metal_painted bucket, lightly tinted. The real
      // glass keys are transmissive, which needs a scene copy every frame for
      // six triangles, and steel_brushed at metalness 1 mirrors the sky so hard
      // that a shard in a shaded opening reads as a white slash.
      _c.setRGB(0.62, 0.66, 0.66);
      const corner = i % 4;
      const sx = (corner & 1 ? 1 : -1) * ww * 0.28;
      const sy = (corner & 2 ? 1 : -1) * wh * 0.3;
      const x = f.ax + fr.ux * (fr.len * t + sx) + fr.nx * (-0.09);
      const z = f.az + fr.uz * (fr.len * t + sx) + fr.nz * (-0.09);
      bs.add('metal_painted', g.shard, x, yc + sy, z, 0, fr.yaw + (rand() - 0.5) * 0.2,
        rand() * 6.28, ww * (0.22 + rand() * 0.22), wh * (0.22 + rand() * 0.26), 1, _c, false);
      n++;
    }
  }
  return n;
}

export { geo as facadeGeo };
