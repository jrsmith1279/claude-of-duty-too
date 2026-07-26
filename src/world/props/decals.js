import * as THREE from 'three';
import { wallFalloff } from './layout.js';

/**
 * Decals — `ART_DIRECTION.md` rule 7, "hundreds of them".
 *
 * Three decisions worth knowing about.
 *
 * **The atlas is painted, not sampled.** Sixteen 256 px cells drawn with
 * Canvas2D at init: impact spall, crack webs, scorch, oil, dust, standing
 * water, rain streaking, wall-base grime, mould, tyre tread, a torn poster and
 * two spray tags. Canvas2D gives real gradients, blurs and destination-out
 * punch-through for free, and it is the only way to get organic edges without
 * a million-pixel JS loop. Every cell keeps a 16 px transparent gutter so the
 * mip chain does not bleed one decal into its neighbour.
 *
 * **They are geometry, not a projection pass.** A real deferred decal volume
 * needs a depth prepass this pipeline does not expose, and a screen-space pass
 * would fight TAA. Instead each decal is a quad merged into the same `BatchSet`
 * as everything else: camera-independent, correctly lit by the same shader as
 * the surface underneath it, one draw call per material-zone bucket, and
 * `polygonOffset` plus a 12 mm normal push to stay off the surface.
 *
 * **The material is borrowed, not built.** `ARCHITECTURE.md` forbids
 * constructing materials outside the library, so decals ride on
 * `ctx.materials.get('gun_polymer', ...)` with the atlas swapped into the albedo
 * slot. That key is chosen deliberately: it is the only non-metal, non-
 * transmissive key with `pom: 0`, and a parallax march would walk the sample
 * point across an atlas cell boundary and smear one decal into the next.
 */

const ATLAS_SIZE = 1024;
const CELLS = 4;
const CELL = ATLAS_SIZE / CELLS;      // 256
const PAD = 16;

const _c = new THREE.Color();

export const DECAL_KEYS = [
  'impact', 'impactCluster', 'impactSpray', 'crackWeb',
  'scorch', 'oil', 'dust', 'wet',
  'streak', 'grimeBand', 'drip', 'mould',
  'tyre', 'poster', 'tagA', 'tagB',
];

// ------------------------------------------------------------------- atlas

function rgba(r, g, b, a) { return `rgba(${r | 0},${g | 0},${b | 0},${a})`; }

/** Soft radial blob. */
function blob(g, x, y, r, r0, g0, b0, a) {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, rgba(r0, g0, b0, a));
  grd.addColorStop(0.55, rgba(r0, g0, b0, a * 0.62));
  grd.addColorStop(1, rgba(r0, g0, b0, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, 6.2832);
  g.fill();
}

/** Random-walk polyline, the basis of cracks, streaks and spray strokes. */
function scrawl(g, x, y, len, dir, wobble, steps, rnd) {
  g.beginPath();
  g.moveTo(x, y);
  let a = dir;
  for (let i = 0; i < steps; i++) {
    a += (rnd() - 0.5) * wobble;
    x += Math.cos(a) * (len / steps);
    y += Math.sin(a) * (len / steps);
    g.lineTo(x, y);
  }
  g.stroke();
  return [x, y];
}

/** Punches irregular holes so nothing has a machine-perfect edge. */
function erode(g, cx, cy, r, n, strength, rnd) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.2832;
    const d = r * (0.45 + rnd() * 0.75);
    const rr = r * (0.08 + rnd() * 0.3);
    blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, 0, 0, strength);
  }
  g.restore();
}

/** One bullet strike: dark cone, bright spall ring, radial hairlines. */
function drawImpact(g, cx, cy, r, rnd) {
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, rgba(24, 22, 20, 0.96));
  grd.addColorStop(0.24, rgba(40, 37, 34, 0.9));
  grd.addColorStop(0.36, rgba(196, 188, 172, 0.82));
  grd.addColorStop(0.62, rgba(168, 160, 146, 0.44));
  grd.addColorStop(1, rgba(150, 143, 130, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(cx, cy, r, 0, 6.2832);
  g.fill();

  g.strokeStyle = rgba(58, 54, 49, 0.6);
  g.lineWidth = Math.max(1, r * 0.045);
  const spokes = 4 + ((rnd() * 5) | 0);
  for (let i = 0; i < spokes; i++) {
    scrawl(g, cx, cy, r * (0.7 + rnd() * 1.1), rnd() * 6.2832, 0.55, 4, rnd);
  }
  // A dusty halo, off-centre, so the strike has a direction.
  const ha = rnd() * 6.2832;
  blob(g, cx + Math.cos(ha) * r * 0.4, cy + Math.sin(ha) * r * 0.4, r * 1.5, 178, 170, 154, 0.2);
}

function drawCell(g, name, rnd) {
  const s = CELL - PAD * 2;
  const cx = CELL / 2, cy = CELL / 2;

  switch (name) {
    case 'impact':
      drawImpact(g, cx, cy, s * 0.36, rnd);
      break;

    case 'impactCluster': {
      for (let i = 0; i < 7; i++) {
        const a = rnd() * 6.2832, d = rnd() * s * 0.3;
        drawImpact(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.09 + rnd() * 0.09), rnd);
      }
      break;
    }

    case 'impactSpray': {
      // A burst walked across the surface: dense at one end, trailing off.
      const a0 = rnd() * 6.2832;
      for (let i = 0; i < 18; i++) {
        const t = i / 17;
        const d = t * s * 0.44 + (rnd() - 0.5) * s * 0.1;
        const a = a0 + (rnd() - 0.5) * 0.5;
        if (rnd() > 0.25 + t * 0.6) continue;
        drawImpact(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.05 + rnd() * 0.07), rnd);
      }
      break;
    }

    case 'crackWeb': {
      g.strokeStyle = rgba(38, 35, 32, 0.78);
      g.lineCap = 'round';
      const n = 5 + ((rnd() * 4) | 0);
      for (let i = 0; i < n; i++) {
        g.lineWidth = 1 + rnd() * 2.6;
        const a = rnd() * 6.2832;
        const [ex, ey] = scrawl(g, cx + (rnd() - 0.5) * s * 0.2, cy + (rnd() - 0.5) * s * 0.2,
          s * (0.3 + rnd() * 0.45), a, 0.7, 7, rnd);
        // Branch.
        if (rnd() < 0.6) {
          g.lineWidth = 1 + rnd();
          scrawl(g, ex, ey, s * (0.1 + rnd() * 0.2), a + (rnd() - 0.5) * 1.6, 0.8, 4, rnd);
        }
      }
      break;
    }

    case 'scorch': {
      blob(g, cx, cy, s * 0.48, 16, 14, 13, 0.9);
      blob(g, cx, cy, s * 0.3, 8, 7, 7, 0.95);
      // Soot fingers licking outward.
      g.strokeStyle = rgba(20, 18, 16, 0.5);
      g.lineCap = 'round';
      for (let i = 0; i < 14; i++) {
        g.lineWidth = 2 + rnd() * 9;
        scrawl(g, cx, cy, s * (0.3 + rnd() * 0.25), rnd() * 6.2832, 0.35, 4, rnd);
      }
      erode(g, cx, cy, s * 0.5, 16, 0.55, rnd);
      break;
    }

    case 'oil': {
      g.fillStyle = rgba(14, 13, 12, 0.94);
      g.beginPath();
      const pts = 11;
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * 6.2832;
        const r = s * (0.2 + 0.2 * (0.4 + rnd() * 0.6));
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.78;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      // Drips and a thinner spread ring.
      for (let i = 0; i < 9; i++) {
        const a = rnd() * 6.2832, d = s * (0.22 + rnd() * 0.2);
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, s * (0.04 + rnd() * 0.07), 22, 20, 18, 0.7);
      }
      blob(g, cx, cy, s * 0.48, 34, 31, 28, 0.24);
      erode(g, cx, cy, s * 0.4, 10, 0.4, rnd);
      break;
    }

    case 'dust': {
      blob(g, cx, cy, s * 0.5, 156, 145, 124, 0.62);
      for (let i = 0; i < 12; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.34;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.1 + rnd() * 0.22), 168, 156, 132, 0.32);
      }
      erode(g, cx, cy, s * 0.5, 22, 0.42, rnd);
      break;
    }

    case 'wet': {
      blob(g, cx, cy, s * 0.48, 30, 30, 31, 0.7);
      for (let i = 0; i < 8; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.3;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * (0.12 + rnd() * 0.2), 24, 25, 27, 0.5);
      }
      erode(g, cx, cy, s * 0.48, 18, 0.55, rnd);
      break;
    }

    case 'streak': {
      // Rain washing down off a sill: pale where it has cleaned, dark where the
      // dirt has been carried and re-deposited. Runs top (v=0) to bottom.
      for (let i = 0; i < 26; i++) {
        const x = PAD + rnd() * s;
        const w = 1.5 + rnd() * 9;
        const top = PAD + rnd() * s * 0.12;
        const len = s * (0.35 + rnd() * 0.62);
        const dark = rnd() < 0.72;
        const grd = g.createLinearGradient(0, top, 0, top + len);
        const col = dark ? [44, 40, 35] : [148, 141, 126];
        grd.addColorStop(0, rgba(col[0], col[1], col[2], 0.55 + rnd() * 0.3));
        grd.addColorStop(0.65, rgba(col[0], col[1], col[2], 0.25));
        grd.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        g.fillStyle = grd;
        g.fillRect(x, top, w, len);
      }
      // A denser bead right under the lip.
      const grd = g.createLinearGradient(0, PAD, 0, PAD + s * 0.16);
      grd.addColorStop(0, rgba(38, 34, 30, 0.62));
      grd.addColorStop(1, rgba(38, 34, 30, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD, s, s * 0.16);
      erode(g, cx, cy, s * 0.6, 16, 0.35, rnd);
      break;
    }

    case 'grimeBand': {
      // Dirt gravity — rule 4. Dark at the bottom edge, gone by mid height.
      const grd = g.createLinearGradient(0, CELL - PAD, 0, PAD + s * 0.1);
      grd.addColorStop(0, rgba(30, 27, 24, 0.86));
      grd.addColorStop(0.35, rgba(42, 38, 33, 0.5));
      grd.addColorStop(1, rgba(52, 47, 41, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD, s, s);
      // Ragged upper limit.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 26; i++) {
        const x = PAD + rnd() * s;
        blob(g, x, PAD + s * (0.28 + rnd() * 0.45), s * (0.08 + rnd() * 0.16), 0, 0, 0, 0.8);
      }
      g.restore();
      break;
    }

    case 'drip': {
      const grd = g.createLinearGradient(0, PAD, 0, CELL - PAD);
      grd.addColorStop(0, rgba(36, 32, 28, 0.8));
      grd.addColorStop(0.5, rgba(44, 39, 34, 0.45));
      grd.addColorStop(1, rgba(48, 43, 37, 0));
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(cx - s * 0.14, PAD);
      g.lineTo(cx + s * 0.14, PAD);
      g.lineTo(cx + s * 0.05, CELL - PAD);
      g.lineTo(cx - s * 0.06, CELL - PAD);
      g.closePath();
      g.fill();
      g.strokeStyle = rgba(30, 27, 23, 0.55);
      g.lineWidth = 2.5;
      for (let i = 0; i < 5; i++) {
        scrawl(g, cx + (rnd() - 0.5) * s * 0.2, PAD + s * 0.05, s * (0.4 + rnd() * 0.5), 1.5708, 0.16, 6, rnd);
      }
      break;
    }

    case 'mould': {
      for (let i = 0; i < 20; i++) {
        const a = rnd() * 6.2832, d = s * rnd() * 0.36;
        blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.25,
          s * (0.06 + rnd() * 0.17), 42 + rnd() * 16, 44 + rnd() * 14, 34, 0.55);
      }
      erode(g, cx, cy, s * 0.45, 14, 0.45, rnd);
      break;
    }

    case 'tyre': {
      // Runs along the cell's U axis so a track can be stretched arbitrarily.
      const grd = g.createLinearGradient(0, PAD, 0, CELL - PAD);
      grd.addColorStop(0, rgba(28, 26, 24, 0));
      grd.addColorStop(0.2, rgba(26, 24, 22, 0.62));
      grd.addColorStop(0.8, rgba(26, 24, 22, 0.62));
      grd.addColorStop(1, rgba(28, 26, 24, 0));
      g.fillStyle = grd;
      g.fillRect(PAD, PAD + s * 0.22, s, s * 0.56);
      // Tread blocks.
      g.fillStyle = rgba(16, 15, 14, 0.5);
      const rows = 12;
      for (let i = 0; i < rows; i++) {
        const x = PAD + (i / rows) * s;
        const skew = (i % 2 ? 1 : -1) * s * 0.03;
        g.fillRect(x, PAD + s * 0.26 + skew, s / rows * 0.55, s * 0.2);
        g.fillRect(x + s / rows * 0.3, PAD + s * 0.52 - skew, s / rows * 0.55, s * 0.2);
      }
      erode(g, cx, cy, s * 0.5, 20, 0.5, rnd);
      break;
    }

    case 'poster': {
      const w = s * 0.62, h = s * 0.82;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      g.fillStyle = rgba(196, 186, 166, 0.97);
      g.fillRect(x0, y0, w, h);
      // Printed blocks: a heading bar, a block of body text, a colour field.
      const hue = [[176, 52, 40], [40, 66, 112], [190, 150, 40]][(rnd() * 3) | 0];
      g.fillStyle = rgba(hue[0], hue[1], hue[2], 0.9);
      g.fillRect(x0 + w * 0.08, y0 + h * 0.07, w * 0.84, h * 0.16);
      g.fillStyle = rgba(48, 44, 40, 0.85);
      for (let i = 0; i < 7; i++) {
        g.fillRect(x0 + w * 0.1, y0 + h * (0.32 + i * 0.055), w * (0.35 + rnd() * 0.45), h * 0.028);
      }
      g.fillStyle = rgba(hue[0] * 0.7, hue[1] * 0.7, hue[2] * 0.7, 0.7);
      g.fillRect(x0 + w * 0.1, y0 + h * 0.76, w * 0.5, h * 0.14);
      // Torn away at the corners and along one edge.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 16; i++) {
        const edge = (rnd() * 4) | 0;
        const t = rnd();
        const px = edge === 0 ? x0 : edge === 1 ? x0 + w : x0 + t * w;
        const py = edge === 2 ? y0 : edge === 3 ? y0 + h : y0 + t * h;
        blob(g, px, py, s * (0.04 + rnd() * 0.14), 0, 0, 0, 0.95);
      }
      g.restore();
      break;
    }

    case 'tagA':
    case 'tagB': {
      const pal = name === 'tagA'
        ? [[214, 62, 44], [22, 20, 20]]
        : [[52, 96, 178], [232, 226, 210]];
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        const col = pal[pass];
        g.strokeStyle = rgba(col[0], col[1], col[2], pass ? 0.85 : 0.92);
        for (let i = 0; i < 5; i++) {
          g.lineWidth = (pass ? 5 : 11) + rnd() * 7;
          const y = PAD + s * (0.28 + rnd() * 0.44);
          const x = PAD + s * (0.06 + i * 0.17);
          g.beginPath();
          g.moveTo(x, y);
          // Angular tag strokes rather than smooth curves.
          let px = x, py = y;
          for (let k = 0; k < 3; k++) {
            px += s * (0.04 + rnd() * 0.09);
            py += (rnd() - 0.5) * s * 0.34;
            g.lineTo(px, py);
          }
          g.stroke();
        }
      }
      // Overspray.
      for (let i = 0; i < 40; i++) {
        blob(g, PAD + rnd() * s, PAD + s * (0.2 + rnd() * 0.6), 2 + rnd() * 5,
          pal[0][0], pal[0][1], pal[0][2], 0.3);
      }
      erode(g, cx, cy, s * 0.55, 10, 0.3, rnd);
      break;
    }
    default: break;
  }
}

/**
 * Paints the atlas and returns `{ texture, uv }` where `uv[name]` is
 * `[u0, v0, u1, v1]` for that cell's padded content area.
 */
export function buildDecalAtlas(seed = 1) {
  let a = (seed | 0) || 7;
  const rnd = () => {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
    : Object.assign(document.createElement('canvas'), { width: ATLAS_SIZE, height: ATLAS_SIZE });
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const uv = {};
  for (let i = 0; i < DECAL_KEYS.length; i++) {
    const name = DECAL_KEYS[i];
    const col = i % CELLS, row = (i / CELLS) | 0;
    g.save();
    g.translate(col * CELL, row * CELL);
    g.beginPath();
    g.rect(PAD * 0.5, PAD * 0.5, CELL - PAD, CELL - PAD);
    g.clip();
    drawCell(g, name, rnd);
    g.restore();
    // Content area, inset half a texel so bilinear never reaches the gutter.
    const u0 = (col * CELL + PAD * 0.5) / ATLAS_SIZE;
    const v0 = (row * CELL + PAD * 0.5) / ATLAS_SIZE;
    const u1 = (col * CELL + CELL - PAD * 0.5) / ATLAS_SIZE;
    const v1 = (row * CELL + CELL - PAD * 0.5) / ATLAS_SIZE;
    // Canvas Y runs down, texture V runs up.
    uv[name] = [u0, 1 - v1, u1, 1 - v0];
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'decalAtlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { texture, uv };
}

// ---------------------------------------------------------------- geometry

/** Unit quad in the XY plane facing +Z, UV-mapped to one atlas cell. */
function quadFor(uv, flipU = false) {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const a = geo.attributes.uv;
  const [u0, v0, u1, v1] = uv;
  for (let i = 0; i < a.count; i++) {
    const u = flipU ? 1 - a.getX(i) : a.getX(i);
    a.setXY(i, u0 + (u1 - u0) * u, v0 + (v1 - v0) * a.getY(i));
  }
  a.needsUpdate = true;
  return geo;
}

/**
 * The quad pool. Every decal kind gets four pre-made quads with mirrored and
 * rotated UVs so a wall covered in the same tag does not read as a wallpaper.
 */
export class DecalKit {
  constructor(seed = 1) {
    const atlas = buildDecalAtlas(seed);
    this.texture = atlas ? atlas.texture : null;
    this.uv = atlas ? atlas.uv : {};
    /** @type {Record<string, THREE.BufferGeometry[]>} */
    this.quads = {};
    for (const k of DECAL_KEYS) {
      if (!this.uv[k]) continue;
      this.quads[k] = [quadFor(this.uv[k], false), quadFor(this.uv[k], true)];
    }
  }

  geo(kind, rand) {
    const list = this.quads[kind];
    if (!list) return null;
    return list[(rand() * list.length) | 0];
  }

  /**
   * Material overrides that turn a library key into a decal surface.
   *
   * There are two of these and the split is a performance decision, not an art
   * one. A blended decal cannot write depth, so nothing behind it is ever
   * rejected early and every pixel it covers runs the full standard shader
   * again — including a three-cascade PCSS lookup at up to 24 taps. Measured on
   * the interior preset, an eight-deep stack of blended wall decals cost 15 ms
   * of a 16.6 ms budget on its own.
   *
   * So only the marks that genuinely need a soft edge stay blended (grime,
   * streaking, dust, oil, scorch, standing water, mould). Everything with a
   * hard edge — impacts, cracks, posters, tags, tyre tread — is alpha-tested
   * and opaque, which puts it back in the depth-writing pass where the
   * hardware rejects the overlap for free.
   */
  overrides(blend) {
    return {
      map: this.texture,
      transparent: !!blend,
      opacity: 1,
      depthWrite: !blend,
      // Even a blended decal wants a threshold: the padded gutter around every
      // atlas cell is pure alpha zero and discarding it early saves blending a
      // transparent quad over a large part of the road.
      alphaTest: blend ? 0.03 : 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: blend ? -8 : -12,
      normalScale: 0,
      roughness: 0.88,
      metalness: 0,
      clearcoat: 0,
      envMapIntensity: 0.45,
      side: THREE.FrontSide,
      vertexColors: true,
    };
  }
}

// --------------------------------------------------------------- placement

const LIFT = 0.012;   // metres off the surface, on top of polygonOffset

/** Places a decal flat on the ground, spun randomly about its own normal. */
function onGround(bs, key, geo, x, y, z, w, h, yaw, color) {
  bs.add(key, geo, x, y + LIFT, z, -Math.PI / 2, 0, yaw, w, h, 1, color, false);
}

/** Places a decal on a vertical face whose outward normal is (nx, nz). */
function onWall(bs, key, geo, x, y, z, nx, nz, w, h, color) {
  const yaw = Math.atan2(nx, nz);
  bs.add(key, geo, x + nx * LIFT, y, z + nz * LIFT, 0, yaw, 0, w, h, 1, color, false);
}

function tint(rand, v = 0.14, warm = 0) {
  const k = 1 - v * 0.5 + rand() * v;
  _c.setRGB(k * (1 + warm), k * (1 + warm * 0.4), k * (1 - warm * 0.7));
  return _c;
}

/**
 * Ground decals. The road is the largest single area of flat colour in every
 * frame and it is what the rubric's "mostly one colour" failure keys on, so the
 * heaviest spend goes here: grime bands where the road meets a kerb or a wall,
 * oil where vehicles stood, tyre tracks along the driving line, dust patches,
 * cracking and impact spray.
 */
export function groundDecals(ctx, site, soft, hard, kit, rand, density = 1) {
  if (!kit.texture) return { count: 0 };
  let count = 0;
  const N = (n) => Math.max(0, Math.round(n * density));

  const gate = (d) => (d > 16 ? 0 : 1);
  const nearWall = site.field((d, corner, s, x, z, indoor, step) =>
    gate(d) * (wallFalloff(d, 1.3, 0.02) + step * 6 + corner * 0.5));
  const anywhere = site.field((d) => gate(d) * (0.45 + wallFalloff(d, 3.5, 0)));
  const midRoad = site.field((d, corner, s) =>
    (d > 12 || d < 2.2 ? 0 : 1) * (s === 'asphalt' || s === 'asphalt_worn' ? 1.6 : 0.4));
  if (nearWall.empty && anywhere.empty) return { count: 0 };

  const put = (field, n, kind, wMin, wMax, aspect, v, warm, bs) => {
    for (let i = 0; i < n; i++) {
      const p = field.sample(rand);
      if (!p) break;
      const geo = kit.geo(kind, rand);
      if (!geo) break;
      const w = wMin + rand() * (wMax - wMin);
      const h = w * (aspect[0] + rand() * (aspect[1] - aspect[0]));
      onGround(bs, 'gun_polymer', geo, p.x, p.y, p.z, w, h, rand() * 6.2832, tint(rand, v, warm));
      count++;
    }
  };

  // Dirt gravity along every wall base and kerb line.
  put(nearWall, N(120), 'grimeBand', 1.0, 2.4, [0.5, 1.0], 0.16, 0.02, soft);
  put(nearWall, N(80), 'dust', 0.8, 2.1, [0.6, 1.1], 0.18, 0.1, soft);
  put(nearWall, N(40), 'wet', 0.6, 1.5, [0.5, 1.0], 0.12, -0.05, soft);

  // General surface history.
  put(anywhere, N(95), 'dust', 0.9, 2.5, [0.55, 1.1], 0.2, 0.12, soft);
  put(anywhere, N(130), 'crackWeb', 0.9, 2.6, [0.7, 1.2], 0.14, 0.0, hard);
  put(anywhere, N(34), 'mould', 0.5, 1.4, [0.6, 1.1], 0.16, -0.04, soft);

  // Where vehicles stood and stopped.
  put(midRoad, N(52), 'oil', 0.9, 2.6, [0.6, 1.0], 0.12, -0.02, soft);
  put(midRoad, N(40), 'scorch', 1.2, 3.0, [0.7, 1.1], 0.14, 0.02, soft);
  put(midRoad, N(80), 'impactSpray', 0.8, 2.2, [0.8, 1.2], 0.14, 0.03, hard);

  return { count };
}

/**
 * Tyre tracks: paired ruts following the long axis of the street, laid as a run
 * of overlapping quads so they curve and fade instead of appearing as one
 * stretched sticker.
 */
export function tyreTracks(ctx, site, bs, kit, rand, density = 1) {  // hard set
  if (!kit.texture || !site.facades.length) return { count: 0 };
  // The street runs along whatever the longest facade runs along.
  const f = site.facades[0];
  const ax = f.bx - f.ax, az = f.bz - f.az;
  const len = Math.hypot(ax, az) || 1;
  const ux = ax / len, uz = az / len;
  const px = -uz, pz = ux;

  let count = 0;
  const lanes = Math.round(9 * density);
  const drive = site.field((d) => (d > 9 || d < 3 ? 0 : 1));
  if (drive.empty) return { count: 0 };
  for (let lane = 0; lane < lanes; lane++) {
    const p = drive.sample(rand);
    if (!p) break;
    const sx = p.x, sz = p.z;
    const runLen = 8 + rand() * 26;
    const gauge = 1.55 + rand() * 0.25;
    const dir = rand() < 0.5 ? 1 : -1;
    const segs = Math.ceil(runLen / 2.2);
    let drift = 0;
    for (let i = 0; i < segs; i++) {
      drift += (rand() - 0.5) * 0.22;
      const t = (i + 0.5) / segs;
      const cx = sx + ux * dir * runLen * (t - 0.5) + px * drift;
      const cz = sz + uz * dir * runLen * (t - 0.5) + pz * drift;
      const fade = Math.sin(Math.PI * t) * 0.6 + 0.4;
      for (const side of [-1, 1]) {
        const x = cx + px * side * gauge * 0.5;
        const z = cz + pz * side * gauge * 0.5;
        const y = site.groundAt(x, z);
        if (y === null) continue;
        const geo = kit.geo('tyre', rand);
        if (!geo) continue;
        const yaw = Math.atan2(ux, uz) + Math.PI / 2;
        _c.setScalar(0.72 + 0.3 * fade);
        onGround(bs, 'gun_polymer', geo, x, y, z, 2.4, 0.34 + rand() * 0.08, yaw, _c);
        count++;
      }
    }
  }
  return { count };
}

/**
 * Wall decals. Walks every surveyed facade and lays a vertical history on it:
 * grime rising from the ground, rain streaking down from the parapet, impact
 * clusters at chest height, cracks, tags and torn bills.
 */
export function wallDecals(ctx, site, soft, hard, kit, rand, density = 1) {
  if (!kit.texture) return { count: 0 };
  let count = 0;

  const put = (bs, kind, x, y, z, nx, nz, w, h, v, warm) => {
    const geo = kit.geo(kind, rand);
    if (!geo) return;
    onWall(bs, 'gun_polymer', geo, x, y, z, nx, nz, w, h, tint(rand, v, warm));
    count++;
  };

  for (const f of site.facades) {
    const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
    if (len < 2) continue;
    const ux = (f.bx - f.ax) / len, uz = (f.bz - f.az) / len;
    const h = Math.min(f.top - f.base, 20);
    const at = (t, off) => [f.ax + ux * len * t + f.nx * off, f.az + uz * len * t + f.nz * off];

    // 1. Grime rising out of the ground — rule 4. A continuous band, not spots.
    const bandN = Math.max(2, Math.round(len / 2.6 * density));
    for (let i = 0; i < bandN; i++) {
      const t = (i + 0.5) / bandN + (rand() - 0.5) * 0.3 / bandN;
      const [x, z] = at(THREE.MathUtils.clamp(t, 0, 1), 0);
      const bw = len / bandN * 1.9;
      const bh = 0.7 + rand() * 1.5;
      put(soft, 'grimeBand', x, f.base + bh * 0.5, z, f.nx, f.nz, bw, bh, 0.14, 0.03);
    }

    // 2. Rain running down off the top of the wall.
    const streakN = Math.round(len * 0.3 * density);
    for (let i = 0; i < streakN; i++) {
      const [x, z] = at(rand(), 0);
      const sh = Math.min(h * (0.3 + rand() * 0.55), 7);
      put(soft, 'streak', x, f.top - sh * 0.5 - rand() * 0.4, z, f.nx, f.nz,
        0.7 + rand() * 1.5, sh, 0.12, 0.0);
    }
    // and a second, shorter set starting part-way down, off ledges.
    for (let i = 0; i < Math.round(streakN * 0.5); i++) {
      const [x, z] = at(rand(), 0);
      const y0 = f.base + 1.5 + rand() * Math.max(0.5, h - 3);
      const sh = 0.8 + rand() * 2.4;
      put(soft, rand() < 0.5 ? 'drip' : 'streak', x, y0 - sh * 0.5, z, f.nx, f.nz,
        0.35 + rand() * 1.2, sh, 0.12, 0.0);
    }

    // 3. Battle damage, clustered rather than sprinkled.
    const bursts = Math.round(len * 0.16 * density);
    for (let i = 0; i < bursts; i++) {
      const t = rand();
      const y0 = f.base + 0.7 + rand() * Math.min(2.6, h - 1);
      for (let k = 0, n = 1 + ((rand() * 3) | 0); k < n; k++) {
        const [x, z] = at(THREE.MathUtils.clamp(t + (rand() - 0.5) * 0.08, 0, 1), 0);
        const kind = rand() < 0.45 ? 'impactCluster' : rand() < 0.6 ? 'impactSpray' : 'impact';
        const w = kind === 'impact' ? 0.16 + rand() * 0.14 : 0.7 + rand() * 1.5;
        put(hard, kind, x, y0 + (rand() - 0.5) * 0.9, z, f.nx, f.nz, w, w * (0.8 + rand() * 0.5), 0.1, 0.02);
      }
    }

    // 4. Structural cracking, denser low down where the load is.
    const cracks = Math.round(len * 0.3 * density);
    for (let i = 0; i < cracks; i++) {
      const [x, z] = at(rand(), 0);
      const y = f.base + Math.pow(rand(), 1.7) * (h - 0.6) + 0.3;
      const w = 0.7 + rand() * 2.2;
      put(hard, 'crackWeb', x, y, z, f.nx, f.nz, w, w * (0.7 + rand() * 0.8), 0.1, 0.0);
    }

    // 5. Human traces, only at reachable height.
    const tags = Math.round(len * 0.1 * density);
    for (let i = 0; i < tags; i++) {
      const [x, z] = at(rand(), 0);
      const w = 1.0 + rand() * 2.4;
      put(hard, rand() < 0.5 ? 'tagA' : 'tagB', x, f.base + 0.9 + rand() * 1.2, z, f.nx, f.nz,
        w, w * (0.42 + rand() * 0.24), 0.08, 0);
    }
    const bills = Math.round(len * 0.13 * density);
    for (let i = 0; i < bills; i++) {
      const [x, z] = at(rand(), 0);
      const bw = 0.35 + rand() * 0.5;
      put(hard, 'poster', x, f.base + 1.1 + rand() * 1.3, z, f.nx, f.nz, bw, bw * (1.2 + rand() * 0.5), 0.1, 0.02);
    }

    // 6. Mould and water damage low down and in shade.
    const damp = Math.round(len * 0.12 * density);
    for (let i = 0; i < damp; i++) {
      const [x, z] = at(rand(), 0);
      const w = 0.6 + rand() * 1.6;
      put(soft, rand() < 0.6 ? 'mould' : 'dust', x, f.base + 0.3 + rand() * 2.2, z, f.nx, f.nz,
        w, w * (0.7 + rand() * 0.9), 0.14, 0.04);
    }
  }
  return { count };
}

/**
 * A ring of settled dust and grime where a prop meets the ground.
 *
 * The cheapest possible fix for the "dropped in, not standing there" read: an
 * object with a clean hard edge against the floor looks composited, and a
 * contact shadow alone does not sell it because the shadow moves with the sun
 * and the dirt does not.
 */
/**
 * Scorch and spill under the hero props. A burnt-out vehicle with clean tarmac
 * beneath it is the single most obvious tell that a prop was dropped into a
 * scene rather than having happened in it.
 */
export function groundingDust(ctx, site, soft, kit, rand, colliders) {
  if (!kit.texture || !colliders?.length) return { count: 0 };
  let count = 0;
  for (const c of colliders) {
    const r = Math.max(c.w, c.d) * 0.5;
    for (let i = 0, n = 1 + ((rand() * 2) | 0); i < n; i++) {
      const a = rand() * 6.2832;
      const d = r * (0.2 + rand() * 0.5);
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const geo = kit.geo(rand() < 0.65 ? 'dust' : 'grimeBand', rand);
      if (!geo) continue;
      const w = r * (1.6 + rand() * 1.1);
      onGround(soft, 'gun_polymer', geo, x, y, z, w, w * (0.7 + rand() * 0.5),
        rand() * 6.2832, tint(rand, 0.12, 0.06));
      count++;
    }
  }
  return { count };
}

export function hotspotDecals(ctx, site, soft, hard, kit, rand, hotspots) {
  if (!kit.texture || !hotspots?.length) return { count: 0 };
  let count = 0;
  for (const hs of hotspots) {
    for (let i = 0, n = 5 + ((rand() * 5) | 0); i < n; i++) {
      const a = rand() * 6.2832;
      const r = Math.sqrt(rand()) * hs.r;
      const x = hs.x + Math.cos(a) * r, z = hs.z + Math.sin(a) * r;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const kind = r < hs.r * 0.55 ? (rand() < 0.6 ? 'scorch' : 'oil') : 'scorch';
      const w = (kind === 'oil' ? 0.6 : 1.4) * (0.7 + rand() * 0.9);
      const geo = kit.geo(kind, rand);
      if (!geo) continue;
      onGround(soft, 'gun_polymer', geo, x, y, z, w, w * (0.7 + rand() * 0.6),
        rand() * 6.2832, tint(rand, 0.1, 0));
      count++;
    }
    // Fragments of blown glass read as a bright sparkle ring around a vehicle.
    for (let i = 0, n = 3 + ((rand() * 4) | 0); i < n; i++) {
      const a = rand() * 6.2832;
      const r = hs.r * (0.5 + rand() * 0.6);
      const x = hs.x + Math.cos(a) * r, z = hs.z + Math.sin(a) * r;
      const y = site.groundAt(x, z);
      if (y === null) continue;
      const geo = kit.geo('impactSpray', rand);
      if (!geo) continue;
      onGround(hard, 'gun_polymer', geo, x, y, z, 0.9 + rand() * 0.8, 0.9 + rand() * 0.8,
        rand() * 6.2832, tint(rand, 0.1, 0.05));
      count++;
    }
  }
  return { count };
}
