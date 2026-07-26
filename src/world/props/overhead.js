import * as THREE from 'three';
import {
  chamferBox, pipeGeo, corrugatedGeo, clothGeo, cableGeo, lumpGeo, projectUV, jitterColor,
} from './lib.js';

/**
 * Vertical interest — `ART_DIRECTION.md` rule 6: "the upper third of the frame
 * must not be empty sky".
 *
 * Two frames drive this module. The eye-level street shots have nothing above
 * the parapet line, and the establishing camera looks down on rooftops that are
 * bare grey slabs. Both are fixed with the same kind of content, placed against
 * the survey's facade segments and roof rectangles.
 *
 * The single cheapest thing in the game is the cable run. A catenary tube is a
 * few dozen triangles, it reads at any distance because it is pure silhouette
 * against sky, and a street with wires strung across it is instantly a *place*
 * rather than a corridor of boxes. Everything else here — awnings, laundry,
 * roof plant, water tanks, vent stacks — is doing the same job with more
 * geometry.
 *
 * Rooftops also get a parapet. The blockout caps each block with a solid slab
 * and no upstand, which from above reads as a table rather than a roof; a
 * 0.55 m ring round the edge changes that for four boxes.
 */

const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

let G = null;
function geo() {
  if (G) return G;
  G = {
    // Along local X so the placement helpers only have to yaw.
    barAlong: pipeGeo(0.03, 1, 6, false).rotateZ(Math.PI / 2),
    barOut: pipeGeo(0.028, 1, 6, false).rotateX(Math.PI / 2),
    post: pipeGeo(0.04, 1, 6, false),
    sheet: corrugatedGeo(1, 1, 12, 0.016),
    canvas: null,        // built per-instance: the sag has to match the span
    tank: pipeGeo(0.62, 1.35, 12, true, 0.05),
    tankLid: pipeGeo(0.3, 0.1, 10, true, 0.02),
    stack: pipeGeo(0.12, 1, 8, true, 0.02),
    cowl: pipeGeo(0.2, 0.18, 8, true, 0.04),
    acBig: chamferBox(1.35, 0.85, 1.05, 0.05),
    acFan: pipeGeo(0.4, 0.09, 12, true, 0.02),
    acLouvre: chamferBox(1.2, 0.06, 0.9, 0.012),
    plinth: chamferBox(1.7, 0.16, 1.4, 0.03),
    parapet: chamferBox(1, 0.55, 0.26, 0.035),
    coping: chamferBox(1, 0.07, 0.34, 0.02),
    crate: chamferBox(0.62, 0.5, 0.44, 0.022),
    shackWall: corrugatedGeo(1, 1, 10, 0.02),
    step: chamferBox(1.05, 0.05, 0.28, 0.008),
    rail: pipeGeo(0.022, 1, 5, false).rotateZ(Math.PI / 2),
    railPost: pipeGeo(0.02, 1, 5, false),
    grate: chamferBox(1, 0.05, 1, 0.008),
    dish: (() => {
      const pts = [];
      for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(new THREE.Vector2(t * 0.5, t * t * 0.2)); }
      const g = new THREE.LatheGeometry(pts, 14);
      g.rotateX(Math.PI / 2 - 0.3);
      projectUV(g);
      return g;
    })(),
    lump: lumpGeo(0.5, 0.4, [1, 0.5, 1], 1, 3),
  };
  return G;
}

/** First hit looking straight across from a point, or null. */
function acrossFrom(ctx, x, y, z, nx, nz, maxDist) {
  const phys = ctx.physics;
  if (!phys?.raycast) return null;
  _o.set(x, y, z);
  _d.set(nx, 0, nz);
  const hit = phys.raycast(_o, _d, maxDist);
  if (!hit) return null;
  return { x: hit.point.x, y: hit.point.y, z: hit.point.z, d: hit.distance };
}

// ------------------------------------------------------------------- cables

/**
 * Power and telephone runs strung across the street, plus laundry lines lower
 * down. Anchors come from opposing facade pairs found by raycasting straight
 * out from one wall until it hits another.
 */
export function overheadLines(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;
  const done = [];

  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 5) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const h = f.top - f.base;
    if (h < 4) continue;

    const spans = Math.max(1, Math.round(len / 11 * density));
    for (let i = 0; i < spans; i++) {
      const t = (i + 0.5) / spans;
      const ax = f.ax + ux * len * t, az = f.az + uz * len * t;
      // Two runs per span: a high power pair and a lower service line.
      for (let pass = 0; pass < 2; pass++) {
        const y = f.base + h * (pass ? 0.42 : 0.66) + (rand() - 0.5) * 0.6;
        if (y > f.top - 0.6) continue;
        const far = acrossFrom(ctx, ax + f.nx * 0.4, y, az + f.nz * 0.4, f.nx, f.nz, 34);
        if (!far || far.d < 5) continue;
        // Only the near half of a facade pair should draw the span.
        const key = `${Math.round((ax + far.x) * 2)}|${Math.round((az + far.z) * 2)}|${Math.round(y * 2)}`;
        if (done.includes(key)) continue;
        done.push(key);

        const lines = pass ? 1 : 2 + ((rand() * 2) | 0);
        for (let k = 0; k < lines; k++) {
          const off = (k - (lines - 1) / 2) * 0.28;
          _a.set(ax + f.nx * 0.25 + ux * off, y + (rand() - 0.5) * 0.12, az + f.nz * 0.25 + uz * off);
          _b.set(far.x - f.nx * 0.25 + ux * off, y + (rand() - 0.5) * 0.3, far.z - f.nz * 0.25 + uz * off);
          const sag = 0.6 + far.d * (0.035 + rand() * 0.03);
          const cable = cableGeo(_a, _b, sag, 0.024 + rand() * 0.012, 12, 4);
          _c.setRGB(0.5, 0.5, 0.52);
          bs.addMatrix('rubber', cable, IDENTITY, _c, false);
          parts++;
        }

        // Washing pegged to the lower line, and a stub bracket at each end.
        if (pass === 1 && rand() < 0.55) {
          const nCloth = 2 + ((rand() * 4) | 0);
          for (let k = 0; k < nCloth; k++) {
            const s = 0.18 + (k + rand() * 0.6) / (nCloth + 1) * 0.64;
            const cx = ax + (far.x - ax) * s + f.nx * 0.25 * (1 - 2 * s);
            const cz = az + (far.z - az) * s + f.nz * 0.25 * (1 - 2 * s);
            const drop = Math.sin(Math.PI * s) * (0.6 + far.d * 0.05);
            const cw = 0.35 + rand() * 0.5, ch = 0.5 + rand() * 0.7;
            const cloth = clothGeo(cw, ch, 0.1, rand, 0.12);
            jitterColor(_c, rand, 0.3, 0.5, 0);
            bs.add('fabric_canvas', cloth, cx, y - drop - ch * 0.5, cz,
              0, Math.atan2(ux, uz) + (rand() - 0.5) * 0.5, 0, 1, 1, 1, _c, true);
            parts++;
          }
        }
        void g;
      }
    }
  }
  return { parts };
}

// ------------------------------------------------------------------ awnings

/**
 * Shopfront awnings over the pavement. Alternating corrugated-steel lean-tos on
 * angle brackets and torn canvas on bent tube frames, which is the single most
 * recognisable silhouette in the reference frames.
 */
export function awnings(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;
  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 5) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const yaw = Math.atan2(f.nx, f.nz);
    const n = Math.round(len / 9 * density);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.35 + rand() * 0.3) / Math.max(1, n);
      const cx = f.ax + ux * len * t, cz = f.az + uz * len * t;
      // Only where there is pavement to stand under.
      const gy = site.groundAt(cx + f.nx * 1.4, cz + f.nz * 1.4);
      if (gy === null) continue;
      const w = 2.2 + rand() * 2.6;
      const depth = 1.1 + rand() * 0.8;
      const y = f.base + 2.7 + rand() * 0.5;
      const droop = 0.22 + rand() * 0.25;
      const metal = rand() < 0.5;

      // Frame: two rakers and a front rail.
      jitterColor(_c, rand, 0.3, 0.08, 0.05);
      for (const s of [-1, 1]) {
        const ox = cx + ux * s * w * 0.45, oz = cz + uz * s * w * 0.45;
        bs.addPitched('metal_rusted', g.barOut, ox + f.nx * depth * 0.5, y - droop * 0.5,
          oz + f.nz * depth * 0.5, yaw, Math.atan2(droop, depth), 0, 1, 1, depth * 1.12, _c, true);
        parts++;
      }
      bs.add('metal_rusted', g.barAlong, cx + f.nx * depth, y - droop,
        cz + f.nz * depth, 0, yaw, 0, w * 1.05, 1, 1, _c, true);
      parts++;

      // The pitch has to be applied about the awning's own long axis, which is
      // why these go through addPitched rather than add: the default XYZ Euler
      // rotates about world X and stands the sheet on its edge on any wall that
      // does not face along Z.
      const pitch = -Math.PI / 2 + Math.atan2(droop, depth);
      if (metal) {
        jitterColor(_c, rand, 0.2, 0.05, 0.05);
        _c.multiplyScalar(0.82);
        bs.addPitched('metal_corrugated', g.sheet, cx + f.nx * depth * 0.5, y - droop * 0.5,
          cz + f.nz * depth * 0.5, yaw, pitch, 0, w, depth * 1.08, 1, _c, true);
        parts++;
      } else {
        const cloth = clothGeo(w, depth * 1.15, droop * 1.6, rand, 0.16);
        jitterColor(_c, rand, 0.26, 0.28, 0.1);
        bs.addPitched('fabric_canvas', cloth, cx + f.nx * depth * 0.5, y - droop * 0.4,
          cz + f.nz * depth * 0.5, yaw, pitch, 0, 1, 1, 1, _c, true);
        parts++;
        // A torn flap hanging off the front edge.
        if (rand() < 0.6) {
          const flap = clothGeo(w * (0.25 + rand() * 0.4), 0.5 + rand() * 0.6, 0.06, rand, 0.3);
          bs.add('fabric_canvas', flap, cx + ux * (rand() - 0.5) * w * 0.6 + f.nx * depth,
            y - droop - 0.3, cz + uz * (rand() - 0.5) * w * 0.6 + f.nz * depth,
            0, yaw, 0, 1, 1, 1, _c, true);
          parts++;
        }
      }
    }
  }
  return { parts };
}

// ----------------------------------------------------------------- rooftops

/**
 * Roof plant. The establishing camera looks straight down at these, so this is
 * where that shot is won or lost: parapet, then AC plant on plinths, water
 * tanks, vent stacks, dishes, stacked crates, a corrugated shack and debris.
 */
export function rooftops(ctx, site, bs, rand, density = 1) {
  const g = geo();
  let parts = 0;

  for (const r of site.roofs) {
    const hw = r.w / 2, hd = r.d / 2;
    const y = r.y;

    // --- Parapet ring. Four upstands with a coping, inset off the edge.
    jitterColor(_c, rand, 0.14, 0.03, 0.04);
    const inset = 0.13;
    for (let side = 0; side < 4; side++) {
      const alongX = side < 2;
      const s = side % 2 ? 1 : -1;
      const L = (alongX ? r.w : r.d) - inset * 2;
      const px = alongX ? r.x : r.x + s * (hw - inset);
      const pz = alongX ? r.z + s * (hd - inset) : r.z;
      const yaw = alongX ? 0 : Math.PI / 2;
      bs.add('concrete_wall', g.parapet, px, y + 0.275, pz, 0, yaw, 0, L, 1, 1, _c, true);
      bs.add('concrete_floor', g.coping, px, y + 0.575, pz, 0, yaw, 0, L, 1, 1, _c, true);
      parts += 2;
    }

    // Everything else lands inside a margin so it never floats off the edge.
    const mx = Math.max(0.5, hw - 1.6), mz = Math.max(0.5, hd - 1.6);
    const at = () => [r.x + (rand() * 2 - 1) * mx, r.z + (rand() * 2 - 1) * mz];

    // --- Condenser units on concrete plinths.
    const units = Math.max(1, Math.round((r.w * r.d) / 55 * density));
    for (let i = 0; i < units; i++) {
      const [x, z] = at();
      const yaw = (rand() * 4 | 0) * Math.PI / 2 + (rand() - 0.5) * 0.2;
      const sc = 0.8 + rand() * 0.55;
      _c.setRGB(1.0, 1.0, 1.02);
      bs.add('concrete_floor', g.plinth, x, y + 0.08, z, 0, yaw, 0, sc, 1, sc, _c, true);
      jitterColor(_c, rand, 0.16, 0.04, 0.02);
      _c.multiplyScalar(1.08);
      bs.add('metal_painted', g.acBig, x, y + 0.16 + 0.425 * sc, z, 0, yaw, 0, sc, sc, sc, _c, true);
      bs.add('steel_brushed', g.acLouvre, x, y + 0.16 + 0.86 * sc, z, 0, yaw, 0, sc, 1, sc, _c, false);
      bs.add('metal_rusted', g.acFan, x, y + 0.16 + 0.9 * sc, z, 0, yaw, 0, sc, 1, sc, _c, false);
      parts += 4;
    }

    // --- Water tanks on a short stand.
    const tanks = rand() < 0.75 ? 1 + ((rand() * 2) | 0) : 0;
    for (let i = 0; i < tanks; i++) {
      const [x, z] = at();
      const sc = 0.8 + rand() * 0.4;
      jitterColor(_c, rand, 0.18, 0.06, 0.05);
      for (const [dx, dz] of [[-0.4, -0.35], [0.4, -0.35], [-0.4, 0.35], [0.4, 0.35]]) {
        bs.add('metal_rusted', g.post, x + dx * sc, y + 0.3, z + dz * sc, 0, 0, 0,
          1, 0.6, 1, _c, false);
      }
      _c.multiplyScalar(1.06);
      bs.add('metal_corrugated', g.tank, x, y + 0.6 + 0.675 * sc, z, 0, rand() * 3, 0, sc, sc, sc, _c, true);
      bs.add('metal_rusted', g.tankLid, x + 0.16 * sc, y + 0.6 + 1.4 * sc, z, 0, 0, 0, sc, sc, sc, _c, false);
      parts += 6;
    }

    // --- Vent stacks and cowls.
    const stacks = Math.round(2 + rand() * 4 * density);
    for (let i = 0; i < stacks; i++) {
      const [x, z] = at();
      const hgt = 0.7 + rand() * 1.5;
      jitterColor(_c, rand, 0.3, 0.09, 0.07);
      bs.add('metal_rusted', g.stack, x, y + hgt / 2, z, 0, 0, 0, 1, hgt, 1, _c, true);
      bs.add('metal_rusted', g.cowl, x, y + hgt + 0.06, z, 0, rand() * 3, 0, 1, 1, 1, _c, false);
      parts += 2;
    }

    // --- Dishes and aerials pointed roughly the same way, as they would be.
    const bearing = rand() * 6.2832;
    const dishes = Math.round(1 + rand() * 3 * density);
    for (let i = 0; i < dishes; i++) {
      const [x, z] = at();
      const hgt = 0.5 + rand() * 0.9;
      _c.setRGB(1.14, 1.12, 1.06);
      bs.add('metal_rusted', g.post, x, y + hgt / 2, z, 0, 0, 0, 0.7, hgt, 0.7, _c, false);
      bs.add('metal_painted', g.dish, x, y + hgt + 0.1, z, 0, bearing + (rand() - 0.5) * 0.4, 0,
        0.85, 0.85, 0.85, _c, true);
      parts += 2;
    }

    // --- A stair head / plant shack in corrugated steel.
    if (r.w > 8 && r.d > 8 && rand() < 0.8) {
      const [x, z] = at();
      const w = 1.8 + rand() * 1.4, d = 1.5 + rand() * 1.2, hh = 2.0 + rand() * 0.5;
      const yaw = (rand() - 0.5) * 0.6;
      jitterColor(_c, rand, 0.24, 0.07, 0.05);
      for (let s = 0; s < 4; s++) {
        const alongX = s < 2;
        const sg = s % 2 ? 1 : -1;
        const px = x + (alongX ? 0 : sg * w / 2) * Math.cos(yaw) - (alongX ? sg * d / 2 : 0) * Math.sin(yaw);
        const pz = z + (alongX ? sg * d / 2 : 0) * Math.cos(yaw) + (alongX ? 0 : sg * w / 2) * Math.sin(yaw);
        bs.add('metal_corrugated', g.shackWall, px, y + hh / 2, pz,
          0, yaw + (alongX ? 0 : Math.PI / 2), 0, alongX ? w : d, hh, 1, _c, true);
      }
      _c.multiplyScalar(0.95);
      bs.add('concrete_floor', g.plinth, x, y + hh + 0.06, z, 0, yaw, 0, w / 1.7 * 1.1, 1, d / 1.4 * 1.1, _c, true);
      parts += 5;
    }

    // --- Crates, sandbags and rubbish so it is not a showroom.
    const junk = Math.round((r.w * r.d) / 32 * density);
    for (let i = 0; i < junk; i++) {
      const [x, z] = at();
      const roll = rand();
      if (roll < 0.35) {
        jitterColor(_c, rand, 0.3, 0.08, 0.06);
        const stack = 1 + ((rand() * 3) | 0);
        for (let k = 0; k < stack; k++) {
          bs.add('wood_plank', g.crate, x + (rand() - 0.5) * 0.12, y + 0.25 + k * 0.5,
            z + (rand() - 0.5) * 0.12, 0, rand() * 3, 0, 1, 1, 1, _c, true);
        }
        parts += stack;
      } else if (roll < 0.6) {
        jitterColor(_c, rand, 0.22, 0.05, 0.1);
        bs.add('sandbag', g.lump, x, y + 0.11, z, 0, rand() * 3, 0,
          0.7 + rand() * 0.4, 0.45, 0.5, _c, true);
        parts++;
      } else {
        jitterColor(_c, rand, 0.3, 0.05, 0.05);
        bs.add('rubble', g.lump, x, y + 0.07, z, (rand() - 0.5), rand() * 3, (rand() - 0.5),
          0.3 + rand() * 0.5, 0.3, 0.4, _c, false);
        parts++;
      }
    }

    // --- Conduit snaking between the plant.
    const runs = Math.round(1 + rand() * 2 * density);
    for (let i = 0; i < runs; i++) {
      const [x, z] = at();
      const L = 2 + rand() * Math.min(r.w, r.d) * 0.5;
      const yaw = (rand() * 2 | 0) * Math.PI / 2;
      jitterColor(_c, rand, 0.2, 0.05, 0.03);
      bs.add('metal_painted', g.barAlong, x, y + 0.13, z, 0, yaw, 0, L, 1, 1, _c, false);
      parts++;
    }
  }
  return { parts };
}

/**
 * A fire escape bolted to the tallest facade that has room for one: three
 * landings, stringers and a handrail. Pure silhouette against the sky, and the
 * one piece of geometry that reads unmistakably as "city block".
 */
export function fireEscape(ctx, site, bs, rand) {
  const g = geo();
  const candidates = site.facades.filter((f) => f.top - f.base > 8 && Math.hypot(f.bx - f.ax, f.bz - f.az) > 8);
  if (!candidates.length) return { parts: 0 };
  let parts = 0;
  const count = Math.min(2, candidates.length);
  for (let c = 0; c < count; c++) {
    const f = candidates[(c * 7 + 1) % candidates.length];
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const yaw = Math.atan2(f.nx, f.nz);
    const t = 0.25 + rand() * 0.5;
    const cx = f.ax + ux * len * t, cz = f.az + uz * len * t;
    const levels = Math.min(4, Math.floor((f.top - f.base - 2) / 3.3));
    const depth = 1.25;
    jitterColor(_c, rand, 0.22, 0.06, 0.05);

    for (let l = 1; l <= levels; l++) {
      const y = f.base + l * 3.3;
      const px = cx + f.nx * depth * 0.5, pz = cz + f.nz * depth * 0.5;
      bs.add('metal_rusted', g.grate, px, y, pz, 0, yaw, 0, 2.6, 1, depth, _c, true);
      // Handrail: top rail plus four stanchions on the outer edge.
      const ox = cx + f.nx * depth, oz = cz + f.nz * depth;
      bs.add('metal_rusted', g.rail, ox, y + 0.95, oz, 0, yaw, 0, 2.6, 1, 1, _c, false);
      for (let k = 0; k < 4; k++) {
        const s = (k / 3 - 0.5) * 2.4;
        bs.add('metal_rusted', g.railPost, ox + ux * s, y + 0.48, oz + uz * s, 0, 0, 0, 1, 0.95, 1, _c, false);
      }
      // Stair flight down to the level below, as a run of treads.
      if (l > 1) {
        for (let k = 0; k < 9; k++) {
          const s = (k / 8 - 0.5) * 2.2;
          bs.add('metal_rusted', g.step, cx + ux * s + f.nx * (depth * 0.75),
            y - 3.3 + (k / 8) * 3.0, cz + uz * s + f.nz * (depth * 0.75),
            0, yaw, 0, 0.85, 1, 1, _c, false);
        }
        parts += 9;
      }
      parts += 6;
    }
  }
  return { parts };
}
