import * as THREE from 'three';
import {
  chamferBox, pipeGeo, corrugatedGeo, clothGeo, lumpGeo, projectUV, jitterColor, hash3,
} from './lib.js';
import { wallFalloff } from './layout.js';

/**
 * Street furniture and hero props.
 *
 * Ground clutter fixes "the floor is bare"; this fixes "the street is a
 * corridor". What a reference frame actually has in it, in rough order of how
 * much each one carries a composition:
 *
 *   1. a burnt-out vehicle. This is the Call of Duty signature prop and it is
 *      built here with the details that make it read as *destroyed* rather than
 *      as a car model: collapsed suspension so the body sits on its rims, glass
 *      gone from every aperture, a door hanging open past its stop, the roof
 *      dished in, the bonnet sprung, and a soot gradient carried in the
 *      per-part vertex tint rather than in a texture.
 *   2. market stalls — bent tube frames under torn canvas, which is the
 *      silhouette that says "market district" faster than any amount of signage.
 *   3. the ordinary stuff that stops a pavement being a ramp: sandbag
 *      emplacements, oil drums, jersey barriers, a dumpster, pallets, crates,
 *      tyre stacks, gas bottles and jerry cans.
 *
 * Everything is placed against the site survey with an occupancy test, so
 * nothing lands inside a wall or on top of anything else, and everything
 * substantial hands back a low-poly collider box rather than putting its art
 * geometry into the BVH.
 */

const _c = new THREE.Color();

let G = null;
function geo() {
  if (G) return G;
  const cb = chamferBox;
  G = {
    // --- vehicle
    hull: cb(1.78, 0.62, 4.15, 0.09),
    cabin: cb(1.66, 0.68, 1.95, 0.11),
    bonnet: cb(1.68, 0.2, 1.15, 0.06),
    boot: cb(1.68, 0.24, 0.95, 0.06),
    pillar: cb(0.1, 0.72, 0.12, 0.02),
    roof: cb(1.5, 0.09, 1.85, 0.04),
    bumper: cb(1.82, 0.26, 0.22, 0.06),
    door: cb(0.09, 0.66, 1.05, 0.03),
    wheel: pipeGeo(0.33, 0.21, 12, true, 0.05).rotateZ(Math.PI / 2),
    rim: pipeGeo(0.2, 0.23, 10, true, 0.03).rotateZ(Math.PI / 2),
    arch: cb(0.06, 0.5, 0.86, 0.02),
    seat: cb(0.46, 0.5, 0.22, 0.05),
    engine: cb(0.9, 0.42, 0.62, 0.06),

    // --- stall
    tube: pipeGeo(0.028, 1, 6, false),
    tubeAlong: pipeGeo(0.028, 1, 6, false).rotateZ(Math.PI / 2),
    counter: cb(1, 0.07, 1, 0.015),
    leg: cb(0.07, 1, 0.07, 0.014),

    // --- generic
    drum: pipeGeo(0.29, 0.88, 14, true, 0.045),
    drumRib: pipeGeo(0.305, 0.05, 14, true, 0.012),
    bottle: pipeGeo(0.16, 0.62, 10, true, 0.07),
    jerry: cb(0.34, 0.46, 0.17, 0.035),
    bucket: pipeGeo(0.14, 0.28, 9, true, 0.03),
    crate: cb(0.66, 0.52, 0.48, 0.022),
    cratePlank: cb(0.7, 0.06, 0.05, 0.008),
    pallet: cb(1.18, 0.035, 0.11, 0.008),
    palletBlock: cb(0.11, 0.09, 0.11, 0.015),
    tyre: (() => {
      const g = new THREE.TorusGeometry(0.31, 0.11, 6, 14);
      g.rotateX(Math.PI / 2);
      projectUV(g);
      return g;
    })(),
    sack: lumpGeo(0.5, 0.16, [1.0, 0.42, 0.62], 1, 5),
    barrier: (() => {
      // Jersey profile: wide splayed foot, waisted middle, narrow top.
      const shape = new THREE.Shape();
      const pts = [[-0.31, 0], [0.31, 0], [0.24, 0.09], [0.13, 0.34], [0.11, 0.82],
        [-0.11, 0.82], [-0.13, 0.34], [-0.24, 0.09]];
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.016, bevelSegments: 1, steps: 1 });
      g.translate(0, 0, -0.5);
      projectUV(g);
      return g;
    })(),
    skip: cb(2.0, 1.02, 1.22, 0.05),
    skipLid: cb(2.06, 0.07, 1.28, 0.025),
    skipRib: cb(0.07, 1.0, 0.06, 0.014),
    skipWheel: pipeGeo(0.09, 0.06, 8, true, 0.015).rotateZ(Math.PI / 2),
    board: cb(1, 0.14, 0.028, 0.006),
    sheet: corrugatedGeo(1, 1, 10, 0.018),
    lump: lumpGeo(0.5, 0.45, [1, 0.6, 1], 1, 9),
  };
  return G;
}

/** Records a coarse collider so the player is stopped by the art, not the BVH soup. */
function collide(out, w, h, d, x, y, z, yaw, surface) {
  out.push({ w, h, d, x, y, z, yaw, surface });
}

// ------------------------------------------------------------------ vehicle

/**
 * A burnt-out saloon. Sits on its rims, doors sprung, glass gone, roof dished.
 * Soot is carried per part: the tint darkens toward the engine bay and toward
 * whatever side is nominated as the fire side, which is what stops it reading
 * as a uniformly brown car.
 */
export function burntCar(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const fire = rand() < 0.5 ? 1 : -1;
  const sootAt = (t) => {
    // t: 0 at the tail, 1 at the nose (the fire usually started in the engine)
    const k = 0.34 + 0.5 * (1 - t) + rand() * 0.14;
    _c.setRGB(k * 1.06, k * 0.99, k * 0.94);
    return _c;
  };
  const put = (key, gm, ox, oy, oz, rx, ry, rz, sx, sy, sz, col, shadow = true) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    bs.addPitched(key, gm, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
      yaw + ry, rx, rz, sx, sy, sz, col, shadow);
  };

  // Body sits low: 0.28 m of ride height gone with the tyres.
  const ride = 0.31;
  put('metal_rusted', g.hull, 0, ride + 0.34, 0, 0, 0, 0.012, 1, 1, 1, sootAt(0.5));
  put('metal_rusted', g.bonnet, 0, ride + 0.66, 1.35, -0.06, 0, 0.03, 1, 1, 1, sootAt(0.95));
  put('metal_rusted', g.boot, 0, ride + 0.66, -1.6, 0.05, 0, -0.02, 1, 1, 1, sootAt(0.05));
  put('metal_rusted', g.cabin, 0, ride + 0.92, -0.15, 0, 0, 0.02, 1, 1, 1, sootAt(0.45));
  // Roof dished in, and shifted a little toward the fire side.
  put('metal_rusted', g.roof, fire * 0.05, ride + 1.19, -0.15, 0.03, 0, fire * 0.06,
    1, 1, 1, sootAt(0.4));
  for (const sx of [-1, 1]) {
    for (const oz of [0.78, -1.05]) {
      put('metal_rusted', g.pillar, sx * 0.78, ride + 1.0, oz, 0, 0, sx * 0.06, 1, 1, 1, sootAt(0.4), false);
    }
  }
  put('metal_rusted', g.bumper, 0, ride + 0.3, 2.06, 0.1, 0, 0.06, 1, 1, 1, sootAt(1));
  put('metal_rusted', g.bumper, 0, ride + 0.32, -2.02, -0.14, 0, -0.1, 1, 1, 1, sootAt(0));

  // Wheel arches, wheels. One corner has lost its wheel entirely.
  const missing = (rand() * 4) | 0;
  let i = 0;
  for (const sx of [-1, 1]) {
    for (const oz of [1.32, -1.28]) {
      put('metal_rusted', g.arch, sx * 0.9, ride + 0.5, oz, 0, 0, 0, 1, 1, 1, sootAt(0.5), false);
      if (i !== missing) {
        _c.setRGB(0.5, 0.49, 0.49);
        put('rubber', g.wheel, sx * 0.86, 0.3, oz, 0, 0, 0, 1, 0.62, 1, _c);
        _c.setRGB(0.72, 0.7, 0.68);
        put('steel_brushed', g.rim, sx * 0.9, 0.3, oz, 0, 0, 0, 1, 1, 1, _c, false);
      } else {
        // The corner it is missing sits on the brake drum.
        _c.setRGB(0.55, 0.5, 0.46);
        put('metal_rusted', g.rim, sx * 0.82, 0.21, oz, 0, 0, 0, 0.7, 1, 0.7, _c);
      }
      i++;
    }
  }

  // A door hanging open past its stop, and the interior it exposes.
  const openSide = fire;
  put('metal_rusted', g.door, openSide * 0.86, ride + 0.72, 0.35, 0, openSide * 0.9, 0.06,
    1, 1, 1, sootAt(0.55));
  put('metal_rusted', g.door, -openSide * 0.9, ride + 0.72, 0.35, 0, 0, 0.02, 1, 1, 1, sootAt(0.55), false);
  for (const sx of [-0.42, 0.42]) {
    _c.setRGB(0.3, 0.29, 0.28);
    put('metal_rusted', g.seat, sx, ride + 0.82, 0.1, -0.18, 0, 0, 1, 1, 1, _c, false);
  }
  _c.setRGB(0.34, 0.32, 0.31);
  put('metal_rusted', g.engine, 0, ride + 0.6, 1.35, 0, 0, 0, 1, 1, 1, _c, false);

  if (colliders) collide(colliders, 1.95, 1.5, 4.3, x, y + 0.75, z, yaw, 'metal_rusted');
  return 22;
}

// -------------------------------------------------------------------- stall

/** Market stall: bent tube frame, plank counter, torn canopy, crates beneath. */
export function marketStall(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const w = 1.9 + rand() * 1.3;
  const d = 1.0 + rand() * 0.6;
  const h = 1.95 + rand() * 0.35;
  const lean = (rand() - 0.5) * 0.09;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (key, gm, ox, oy, oz, pitch, roll, sx, sy, sz, col, shadow = true) =>
    bs.addPitched(key, gm, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
      yaw, pitch, roll, sx, sy, sz, col, shadow);

  jitterColor(_c, rand, 0.3, 0.08, 0.05);
  const frame = _c.clone();
  // Four uprights, one visibly bent.
  let n = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bend = (sx * sz > 0 ? lean * 3 : lean);
      put('metal_rusted', g.tube, sx * w / 2, h / 2, sz * d / 2, bend, bend * 0.6, 1, h, 1, frame);
      n++;
    }
  }
  // Top rails.
  for (const sz of [-1, 1]) {
    put('metal_rusted', g.tubeAlong, 0, h, sz * d / 2, 0, 0, w, 1, 1, frame, true);
    n++;
  }

  // Counter and a plank top.
  jitterColor(_c, rand, 0.3, 0.09, 0.07);
  put('wood_plank', g.counter, 0, 0.92, 0, 0, 0.01, w * 1.02, 1, d * 0.92, _c);
  n++;
  // Goods: crates and sacks on top.
  for (let i = 0, k = 2 + ((rand() * 4) | 0); i < k; i++) {
    const ox = (rand() - 0.5) * w * 0.8, oz = (rand() - 0.5) * d * 0.5;
    if (rand() < 0.5) {
      jitterColor(_c, rand, 0.3, 0.1, 0.06);
      put('wood_plank', g.crate, ox, 0.95 + 0.26, oz, 0, rand() * 0.4 - 0.2,
        0.6 + rand() * 0.3, 0.6, 0.6 + rand() * 0.3, _c);
    } else {
      jitterColor(_c, rand, 0.26, 0.18, 0.1);
      put('sandbag', g.sack, ox, 0.95 + 0.16, oz, 0, rand() * 0.5,
        0.5 + rand() * 0.3, 0.5, 0.4, _c);
    }
    n++;
  }

  // Canopy: torn canvas over the top rails, sagging in the middle.
  const cloth = clothGeo(w * 1.2, d * 1.5, 0.16, rand, 0.2);
  jitterColor(_c, rand, 0.28, 0.35, 0.08);
  put('fabric_canvas', cloth, 0, h + 0.06, 0, -Math.PI / 2 + 0.12, 0, 1, 1, 1, _c);
  n++;
  // A side curtain hanging off one end.
  if (rand() < 0.7) {
    const side = clothGeo(d * 1.1, h * 0.55, 0.06, rand, 0.3);
    put('fabric_canvas', side, (rand() < 0.5 ? -1 : 1) * w / 2, h - h * 0.28, 0,
      0, 0, 1, 1, 1, _c);
    n++;
  }

  if (colliders) collide(colliders, w + 0.2, 1.0, d + 0.2, x, y + 0.5, z, yaw, 'wood_plank');
  return n;
}

// ------------------------------------------------------------------- others

function sandbagWall(bs, rand, x, y, z, yaw, len, rows, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let n = 0;
  const bagW = 0.52;
  const perRow = Math.max(2, Math.round(len / bagW));
  for (let r = 0; r < rows; r++) {
    const inset = r * 0.045;
    for (let i = 0; i < perRow - r; i++) {
      const ox = (i - (perRow - r - 1) / 2) * bagW + (r % 2 ? bagW * 0.5 : 0) * 0.4;
      const oy = 0.13 + r * 0.2;
      const oz = (rand() - 0.5) * 0.05;
      jitterColor(_c, rand, 0.24, 0.07, 0.09);
      bs.addPitched('sandbag', g.sack, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
        yaw + (rand() - 0.5) * 0.16, (rand() - 0.5) * 0.1, 0,
        1.02 + rand() * 0.14, 0.92 + rand() * 0.16, 0.9 - inset, _c, true);
      n++;
    }
  }
  if (colliders) collide(colliders, len, rows * 0.2 + 0.1, 0.55, x, y + (rows * 0.2) / 2, z, yaw, 'sandbag');
  return n;
}

function oilDrum(bs, rand, x, y, z, tipped, colliders) {
  const g = geo();
  const key = rand() < 0.6 ? 'metal_rusted' : 'metal_painted';
  jitterColor(_c, rand, 0.3, 0.14, 0.05);
  const yaw = rand() * 6.2832;
  if (tipped) {
    bs.addPitched(key, g.drum, x, y + 0.3, z, yaw, Math.PI / 2, 0, 1, 1, 1, _c, true);
    for (const o of [-0.26, 0.26]) {
      bs.addPitched(key, g.drumRib, x + Math.cos(yaw) * o, y + 0.3, z + Math.sin(yaw) * o,
        yaw, Math.PI / 2, 0, 1, 1, 1, _c, false);
    }
    if (colliders) collide(colliders, 0.62, 0.6, 0.92, x, y + 0.3, z, yaw, key);
  } else {
    bs.add(key, g.drum, x, y + 0.44, z, 0, yaw, 0, 1, 1, 1, _c, true);
    for (const o of [-0.24, 0.24]) {
      bs.add(key, g.drumRib, x, y + 0.44 + o, z, 0, yaw, 0, 1, 1, 1, _c, false);
    }
    if (colliders) collide(colliders, 0.62, 0.9, 0.62, x, y + 0.45, z, 0, key);
  }
  return 3;
}

function palletStack(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const layers = 1 + ((rand() * 4) | 0);
  let n = 0;
  jitterColor(_c, rand, 0.3, 0.08, 0.06);
  for (let l = 0; l < layers; l++) {
    const oy = 0.05 + l * 0.145;
    const jitter = (rand() - 0.5) * 0.06;
    for (const oz of [-0.42, -0.14, 0.14, 0.42]) {
      bs.addPitched('wood_plank', g.pallet, x + jitter * c + oz * s, y + oy + 0.055,
        z - jitter * s + oz * c, yaw + jitter * 0.2, 0, 0, 1, 1, 1, _c, l === layers - 1);
      n++;
    }
    for (const ox of [-0.5, 0, 0.5]) for (const oz of [-0.42, 0.42]) {
      bs.addPitched('wood_plank', g.palletBlock, x + ox * c + oz * s, y + oy,
        z - ox * s + oz * c, yaw + jitter * 0.2, 0, 0, 1, 1, 1, _c, false);
      n++;
    }
  }
  if (colliders) collide(colliders, 1.25, layers * 0.145 + 0.05, 1.0, x, y + layers * 0.07, z, yaw, 'wood_plank');
  return n;
}

function crateStack(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const n0 = 1 + ((rand() * 3) | 0);
  let n = 0;
  for (let l = 0; l < n0; l++) {
    const ox = (rand() - 0.5) * 0.14, oz = (rand() - 0.5) * 0.14;
    const sc = 0.85 + rand() * 0.4;
    jitterColor(_c, rand, 0.3, 0.09, 0.07);
    const yy = y + 0.27 * sc + l * 0.53 * sc;
    bs.addPitched('wood_plank', g.crate, x + ox * c + oz * s, yy, z - ox * s + oz * c,
      yaw + (rand() - 0.5) * 0.5, 0, 0, sc, sc, sc, _c, true);
    for (const b of [-0.2, 0.2]) {
      bs.addPitched('wood_plank', g.cratePlank, x + ox * c + oz * s, yy + b * sc,
        z - ox * s + oz * c, yaw + (rand() - 0.5) * 0.5, 0, 0, sc, sc, sc, _c, false);
    }
    n += 3;
  }
  if (colliders) collide(colliders, 0.8, n0 * 0.53, 0.65, x, y + n0 * 0.27, z, yaw, 'wood_plank');
  return n;
}

function tyreStack(bs, rand, x, y, z, colliders) {
  const g = geo();
  const n0 = 2 + ((rand() * 4) | 0);
  for (let l = 0; l < n0; l++) {
    _c.setRGB(0.55 + rand() * 0.2, 0.54 + rand() * 0.2, 0.55 + rand() * 0.2);
    bs.add('rubber', g.tyre, x + (rand() - 0.5) * 0.07, y + 0.1 + l * 0.185,
      z + (rand() - 0.5) * 0.07, 0, rand() * 3, 0, 1, 1, 1, _c, true);
  }
  if (colliders) collide(colliders, 0.84, n0 * 0.185 + 0.05, 0.84, x, y + n0 * 0.09, z, 0, 'rubber');
  return n0;
}

function dumpster(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const c = Math.cos(yaw), s = Math.sin(yaw);
  jitterColor(_c, rand, 0.24, 0.18, 0.03);
  const body = _c.clone();
  let n = 0;
  bs.addPitched('metal_painted', g.skip, x, y + 0.62, z, yaw, 0, 0.008, 1, 1, 1, body, true);
  n++;
  for (const ox of [-0.7, -0.24, 0.24, 0.7]) {
    bs.addPitched('metal_painted', g.skipRib, x + ox * c, y + 0.62, z - ox * s,
      yaw, 0, 0.008, 1, 1, 1, body, false);
    n++;
  }
  // Lid, thrown back and hanging over the far side.
  bs.addPitched('metal_painted', g.skipLid, x - 0.58 * s, y + 1.2, z - 0.58 * c,
    yaw, -0.55, 0, 1, 1, 1, body, true);
  n++;
  for (const ox of [-0.85, 0.85]) for (const oz of [-0.5, 0.5]) {
    _c.setRGB(0.4, 0.4, 0.42);
    bs.addPitched('metal_rusted', g.skipWheel, x + ox * c + oz * s, y + 0.09,
      z - ox * s + oz * c, yaw, 0, 0, 1, 1, 1, _c, false);
    n++;
  }
  // Overflowing.
  for (let i = 0, k = 3 + ((rand() * 5) | 0); i < k; i++) {
    const ox = (rand() - 0.5) * 1.7, oz = (rand() - 0.5) * 0.9;
    jitterColor(_c, rand, 0.35, 0.12, 0.06);
    bs.addPitched(rand() < 0.5 ? 'plywood' : 'wood_plank', g.lump,
      x + ox * c + oz * s, y + 1.12 + rand() * 0.16, z - ox * s + oz * c,
      rand() * 3, (rand() - 0.5), 0, 0.3 + rand() * 0.4, 0.22, 0.3 + rand() * 0.3, _c, false);
    n++;
  }
  if (colliders) collide(colliders, 2.1, 1.25, 1.3, x, y + 0.62, z, yaw, 'metal_painted');
  return n;
}

function jersey(bs, rand, x, y, z, yaw, colliders) {
  const g = geo();
  const len = 1.6 + rand() * 1.2;
  jitterColor(_c, rand, 0.16, 0.03, 0.03);
  _c.multiplyScalar(1.06);
  bs.addPitched('concrete_wall', g.barrier, x, y, z, yaw, 0, (rand() - 0.5) * 0.03,
    1, 1, len, _c, true);
  if (colliders) collide(colliders, 0.64, 0.86, len, x, y + 0.43, z, yaw, 'concrete_wall');
  return 1;
}

function smallJunk(bs, rand, x, y, z, colliders) {
  const g = geo();
  const roll = rand();
  const yaw = rand() * 6.2832;
  if (roll < 0.3) {
    jitterColor(_c, rand, 0.3, 0.2, 0.02);
    bs.add('metal_painted', g.jerry, x, y + 0.23, z, 0, yaw, 0.04, 1, 1, 1, _c, true);
  } else if (roll < 0.55) {
    jitterColor(_c, rand, 0.26, 0.16, 0.02);
    bs.add('metal_painted', g.bottle, x, y + 0.31, z, 0, yaw, 0, 1, 1, 1, _c, true);
  } else if (roll < 0.8) {
    jitterColor(_c, rand, 0.34, 0.2, 0.02);
    bs.add('metal_painted', g.bucket, x, y + 0.14, z, (rand() - 0.5) * 2.4, yaw, 0, 1, 1, 1, _c, true);
  } else {
    jitterColor(_c, rand, 0.3, 0.08, 0.06);
    const w = 0.7 + rand() * 0.9;
    bs.addPitched('metal_corrugated', g.sheet, x, y + 0.03, z, yaw, -Math.PI / 2 + 0.1, 0,
      w, w * 0.7, 1, _c, false);
  }
  void colliders;
  return 1;
}

// ------------------------------------------------------------------ placer

/**
 * Places the whole furniture set. Larger items are placed first so they get the
 * good spots, and each one claims its footprint so nothing grows out of it.
 *
 * @returns {{parts:number, colliders:any[], hotspots:{x:number,z:number,r:number}[]}}
 *   `hotspots` are the vehicles, for the decal pass to scorch the ground under.
 */
export function streetFurniture(ctx, site, bs, rand, density = 1) {
  geo();
  const colliders = [];
  const hotspots = [];
  let parts = 0;

  // Vehicles want the carriageway; stalls and junk want the pavement edge.
  const road = site.field((d, corner, surf) =>
    (d < 2.6 || d > 11 ? 0 : 1) * ((surf === 'asphalt' || surf === 'asphalt_worn') ? 1 : 0.15));
  const edge = site.field((d, corner, surf, x, z, indoor) =>
    (d < 0.9 || d > 4.2 ? 0 : 1) * (wallFalloff(d, 2.4, 0.1) + (indoor ? 0.2 : 0)));
  const anywhere = site.field((d) => (d > 12 ? 0 : 1) * (wallFalloff(d, 3.0, 0.25)));

  /** Rejection-sampled placement with a footprint claim. */
  const spot = (field, r, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const p = field.sample(rand);
      if (!p) return null;
      if (!site.free(p.x, p.z, r)) continue;
      site.occupy(p.x, p.z, r);
      return { x: p.x, y: p.y, z: p.z, nx: p.nx, nz: p.nz, dist: p.dist };
    }
    return null;
  };

  // --- 1. Vehicles. Parked askew, roughly along the street.
  const streetYaw = site.facades.length
    ? Math.atan2(site.facades[0].bx - site.facades[0].ax, site.facades[0].bz - site.facades[0].az)
    : 0;
  const cars = Math.max(1, Math.round(3 * density));
  for (let i = 0; i < cars; i++) {
    const p = spot(road, 2.5, 60);
    if (!p) break;
    const yaw = streetYaw + (rand() - 0.5) * 0.9 + (rand() < 0.25 ? Math.PI / 2 : 0);
    parts += burntCar(bs, rand, p.x, p.y, p.z, yaw, colliders);
    hotspots.push({ x: p.x, z: p.z, r: 3.2 });
  }

  // --- 2. Market stalls along the pavement, facing the street.
  const stalls = Math.max(2, Math.round(6 * density));
  for (let i = 0; i < stalls; i++) {
    const p = spot(edge, 1.5, 50);
    if (!p) break;
    const yaw = (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) : rand() * 6.2832;
    parts += marketStall(bs, rand, p.x, p.y, p.z, yaw + Math.PI / 2, colliders);
  }

  // --- 3. Sandbag emplacements at corners.
  const bags = Math.max(1, Math.round(4 * density));
  for (let i = 0; i < bags; i++) {
    const p = spot(edge, 1.6, 50);
    if (!p) break;
    const yaw = (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) + Math.PI / 2 : rand() * 6.2832;
    parts += sandbagWall(bs, rand, p.x, p.y, p.z, yaw, 1.6 + rand() * 1.4, 3 + ((rand() * 2) | 0), colliders);
  }

  // --- 4. Jersey barriers, sometimes in a short run.
  const runs = Math.max(2, Math.round(5 * density));
  for (let i = 0; i < runs; i++) {
    const p = spot(anywhere, 1.4, 40);
    if (!p) break;
    const yaw = streetYaw + (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.25;
    const n = 1 + ((rand() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 2.4;
      const bx = p.x + Math.sin(yaw) * off, bz = p.z + Math.cos(yaw) * off;
      if (site.groundAt(bx, bz) === null) continue;
      site.occupy(bx, bz, 1.1);
      parts += jersey(bs, rand, bx, p.y, bz, yaw + (rand() - 0.5) * 0.12, colliders);
    }
  }

  // --- 5. Dumpsters.
  for (let i = 0, k = Math.max(1, Math.round(2 * density)); i < k; i++) {
    const p = spot(edge, 1.5, 40);
    if (!p) break;
    parts += dumpster(bs, rand, p.x, p.y, p.z,
      (p.nx || p.nz) ? Math.atan2(p.nx, p.nz) + Math.PI / 2 : rand() * 6.2832, colliders);
  }

  // --- 6. The ordinary stuff.
  const drums = Math.round(14 * density);
  for (let i = 0; i < drums; i++) {
    const p = spot(edge, 0.55, 24);
    if (!p) continue;
    parts += oilDrum(bs, rand, p.x, p.y, p.z, rand() < 0.28, colliders);
  }
  for (let i = 0, k = Math.round(7 * density); i < k; i++) {
    const p = spot(edge, 0.85, 24);
    if (!p) continue;
    parts += palletStack(bs, rand, p.x, p.y, p.z, rand() * 6.2832, colliders);
  }
  for (let i = 0, k = Math.round(11 * density); i < k; i++) {
    const p = spot(edge, 0.7, 24);
    if (!p) continue;
    parts += crateStack(bs, rand, p.x, p.y, p.z, rand() * 6.2832, colliders);
  }
  for (let i = 0, k = Math.round(7 * density); i < k; i++) {
    const p = spot(edge, 0.6, 24);
    if (!p) continue;
    parts += tyreStack(bs, rand, p.x, p.y, p.z, colliders);
  }
  for (let i = 0, k = Math.round(24 * density); i < k; i++) {
    const p = spot(edge, 0.35, 16);
    if (!p) continue;
    parts += smallJunk(bs, rand, p.x, p.y, p.z, colliders);
  }

  return { parts, colliders, hotspots };
}

export { geo as furnitureGeo };
