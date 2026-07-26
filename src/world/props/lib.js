import * as THREE from 'three';

/**
 * Geometry toolkit shared by every prop module.
 *
 * Two ideas drive all of it.
 *
 * **Draw calls, not triangles, are the scarce resource.** The frame budget is
 * 350 draws and the blockout already spends 178; the triangle budget is 3.5 M
 * and the blockout spends 2.2 k. So the primitive here is not `InstancedMesh`
 * but `Batch` — a merge buffer that swallows hundreds of small transformed
 * geometries and emits one `BufferGeometry`. A merged pile of 400 rubble
 * chunks costs exactly the same one draw call as an InstancedMesh of 400
 * rubble chunks, while allowing every chunk to be a *different shape*, which is
 * what actually breaks up a silhouette. Instancing is kept for the cases where
 * the shape genuinely repeats and the count is in the thousands (gravel).
 *
 * **Nothing in this game may have a sharp 90 degree edge** (`ART_DIRECTION.md`
 * rule 3). `chamferBox` is therefore the box primitive: same call signature as
 * `THREE.BoxGeometry` plus a chamfer width, and the bevel quads it adds are
 * what catch a specular line along every edge and stop a crate reading as an
 * untextured cuboid.
 *
 * UV convention is the library's: 1 UV unit = 1 metre, so every generator here
 * writes metre-scaled UVs and materials tile at their authored physical size.
 */

const _m4 = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** Deterministic PRNG. Every prop layout is seeded so shots are comparable. */
export function makeRng(seed) {
  let a = (seed | 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap deterministic 3-in 1-out hash, for per-vertex displacement. */
export function hash3(x, y, z) {
  let h = Math.imul(Math.round(x * 8192) ^ 0x27d4eb2d, 0x9e3779b1);
  h = Math.imul(h ^ Math.round(y * 8192), 0x85ebca6b);
  h = Math.imul(h ^ Math.round(z * 8192), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// --------------------------------------------------------------------- UVs

/**
 * Rewrites box-style 0..1-per-face UVs into metres so the material library's
 * per-key repeat lands the tile at its authored physical size. Same trick
 * `Level.js` uses; duplicated rather than imported because that file belongs to
 * another agent and its exports are not part of the contract.
 */
export function worldUV(geo) {
  geo.computeBoundingBox();
  geo.boundingBox.getSize(_size);
  const uv = geo.attributes.uv, nrm = geo.attributes.normal;
  if (!uv || !nrm) return geo;
  const size = [_size.x, _size.y, _size.z];
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let su, sv;
    if (ax > ay && ax > az) { su = size[2]; sv = size[1]; }
    else if (ay > az) { su = size[0]; sv = size[2]; }
    else { su = size[0]; sv = size[1]; }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Multiplies existing UVs — for lathes/tubes whose 0..1 span a known length. */
export function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Projects UVs from world position on the dominant axis of each face, in
 * metres. The general fallback for anything without a sane UV layout
 * (lathes, tubes, jittered convex hulls) that must not be triplanar.
 */
export function projectUV(geo) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let uv = geo.attributes.uv;
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    if (ax > ay && ax > az) uv.setXY(i, z, y);
    else if (ay > az) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
  return geo;
}

// -------------------------------------------------------------- primitives

/**
 * A box with every edge bevelled: 6 inset faces, 12 edge quads, 8 corner
 * triangles. 44 triangles against BoxGeometry's 12, which at this project's
 * triangle headroom is free, and it is the difference between "a crate" and
 * "a grey cuboid".
 *
 * @param {number} w @param {number} h @param {number} d
 * @param {number} c chamfer width in metres (clamped to a third of the box)
 */
export function chamferBox(w, h, d, c = 0.02) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  c = Math.min(c, hx * 0.6, hy * 0.6, hz * 0.6);
  const inner = [hx - c, hy - c, hz - c];
  const outer = [hx, hy, hz];

  // corner[sx][sy][sz][axis] -> the vertex belonging to the `axis` face.
  const vert = (sx, sy, sz, axis) => {
    const s = [sx, sy, sz];
    return [
      s[0] * (axis === 0 ? outer[0] : inner[0]),
      s[1] * (axis === 1 ? outer[1] : inner[1]),
      s[2] * (axis === 2 ? outer[2] : inner[2]),
    ];
  };

  const tris = [];
  const quad = (a, b, cc, d2) => { tris.push(a, b, cc, a, cc, d2); };
  const S = [-1, 1];

  // 6 inset faces
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const sa of S) {
      const corner = (su, sv) => {
        const s = [0, 0, 0]; s[axis] = sa; s[u] = su; s[v] = sv;
        return vert(s[0], s[1], s[2], axis);
      };
      quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1));
    }
  }
  // 12 edge bevels: fix two signs, sweep the third axis
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const su of S) for (const sv of S) {
      const at = (sa, faceAxis) => {
        const s = [0, 0, 0]; s[axis] = sa; s[u] = su; s[v] = sv;
        return vert(s[0], s[1], s[2], faceAxis);
      };
      quad(at(-1, u), at(1, u), at(1, v), at(-1, v));
    }
  }
  // 8 corners
  for (const sx of S) for (const sy of S) for (const sz of S) {
    tris.push(vert(sx, sy, sz, 0), vert(sx, sy, sz, 1), vert(sx, sy, sz, 2));
  }

  const n = tris.length;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = tris[i][0]; pos[i * 3 + 1] = tris[i][1]; pos[i * 3 + 2] = tris[i][2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  fixWindingConvex(geo);
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/**
 * Flips any triangle whose normal faces the origin. Valid for convex shapes
 * built around their own centre, which is every generator here; it removes the
 * need to get the winding right by hand in three nested sign loops.
 */
export function fixWindingConvex(geo) {
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    if (nx * mx + ny * my + nz * mz < 0) {
      p[i + 3] = cx; p[i + 4] = cy; p[i + 5] = cz;
      p[i + 6] = bx; p[i + 7] = by; p[i + 8] = bz;
    }
  }
  geo.attributes.position.needsUpdate = true;
  return geo;
}

/**
 * A faceted convex lump: an icosahedron pushed around by a positional hash.
 * The hash is evaluated on the *direction*, so the duplicated vertices of a
 * non-indexed mesh all move together and the hull stays closed.
 *
 * @param {number} r radius
 * @param {number} amp 0..1 displacement amplitude
 * @param {number[]} [squash] per-axis scale applied after displacement
 */
export function lumpGeo(r, amp, squash = [1, 1, 1], detail = 0, seed = 0) {
  const geo = new THREE.IcosahedronGeometry(r, detail).toNonIndexed();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    const dx = x / l, dy = y / l, dz = z / l;
    const n = hash3(dx + seed * 3.17, dy - seed * 1.93, dz + seed * 7.71);
    const n2 = hash3(dx * 3.1 + 11.3, dy * 3.1 - 4.7, dz * 3.1 + 9.1);
    const k = r * (1 + amp * (n - 0.5) * 2 + amp * 0.45 * (n2 - 0.5));
    pos.setXYZ(i, dx * k * squash[0], dy * k * squash[1], dz * k * squash[2]);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A thin slab with a jagged broken edge — brick halves, concrete plate. */
export function shardGeo(w, h, d, rand, chip = 0.35) {
  const geo = chamferBox(w, h, d, Math.min(w, h, d) * 0.12);
  const pos = geo.attributes.position;
  const hx = w / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x < hx * 0.55) continue;
    // Only the +X end breaks up, so the shard keeps one clean fracture face.
    const n = hash3(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setX(i, x - w * chip * n);
    pos.setY(i, pos.getY(i) * (1 - 0.25 * n));
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** A tapered splinter: one end square, the other drawn to a ragged point. */
export function splinterGeo(len, w, h, rand) {
  const geo = chamferBox(len, h, w, Math.min(w, h) * 0.2);
  const pos = geo.attributes.position;
  const hl = len / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = THREE.MathUtils.clamp((x + hl) / len, 0, 1);
    const k = 1 - 0.82 * t * t;
    const n = hash3(x, pos.getY(i), pos.getZ(i));
    pos.setY(i, pos.getY(i) * k * (0.7 + 0.6 * n));
    pos.setZ(i, pos.getZ(i) * k);
    if (t > 0.9) pos.setX(i, x - len * 0.18 * n);
  }
  geo.computeVertexNormals();
  projectUV(geo);
  return geo;
}

/** Bent sheet metal / torn roofing: a strip with per-row bend and curl. */
export function bentPlateGeo(w, h, segs, bend, rand) {
  const geo = new THREE.PlaneGeometry(w, h, segs, Math.max(1, segs >> 1));
  const pos = geo.attributes.position;
  const ph = rand() * 6.28, ph2 = rand() * 6.28;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = x / w, v = y / h;
    pos.setZ(i, bend * (Math.sin(u * 5.1 + ph) * 0.6 + Math.sin(v * 3.7 + ph2) * 0.4 + u * u * 1.4));
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/** Corrugated sheet — awnings, shutters, shack walls. Ribs run along X. */
export function corrugatedGeo(w, h, ribs = 14, depth = 0.02) {
  const geo = new THREE.PlaneGeometry(w, h, ribs * 2, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin((x / w) * ribs * Math.PI * 2) * depth);
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/** A sagging cloth quad: catenary droop plus a torn, ragged lower edge. */
export function clothGeo(w, h, sag, rand, torn = 0.0) {
  const nx = 8, ny = 6;
  const geo = new THREE.PlaneGeometry(w, h, nx, ny);
  const pos = geo.attributes.position;
  const ph = rand() * 10;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = (x / w) + 0.5, v = (y / h) + 0.5;
    // Cross-wise catenary + a lengthwise ripple; the cloth hangs from v = 1.
    const drop = sag * 4 * u * (1 - u);
    const ripple = Math.sin(u * 9.3 + ph) * sag * 0.16 * v;
    pos.setY(i, y - drop * v);
    pos.setZ(i, ripple);
    if (torn > 0 && v < 0.18) {
      const n = hash3(x * 3.3, ph, 0.5);
      pos.setY(i, pos.getY(i) + torn * n * h);
    }
  }
  geo.computeVertexNormals();
  scaleUV(geo, w, h);
  return geo;
}

/**
 * A hanging cable in a real catenary between two points, as a low-radial tube.
 * Cables are the cheapest possible fix for `ART_DIRECTION.md` rule 6 (an empty
 * upper third of frame) and they read at any distance because they are a
 * silhouette, not a surface.
 */
export function cableGeo(a, b, sag, radius = 0.022, segs = 14, radial = 4) {
  const pts = [];
  const span = Math.hypot(b.x - a.x, b.z - a.z) || 0.001;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // cosh-shaped droop normalised so the ends stay pinned.
    const k = 2.6;
    const droop = (Math.cosh(k * (t - 0.5)) - Math.cosh(k * 0.5)) / (1 - Math.cosh(k * 0.5));
    pts.push(new THREE.Vector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - sag * droop,
      a.z + (b.z - a.z) * t,
    ));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, segs, radius, radial, false);
  scaleUV(geo, span + sag, radius * 6.28);
  return geo;
}

/** Rounded cylinder with chamfered rims — drums, posts, pipes. */
export function pipeGeo(r, len, radial = 8, capped = true, chamfer = 0) {
  const geo = new THREE.CylinderGeometry(r, r, len, radial, 1, !capped);
  scaleUV(geo, r * 6.28, len);
  if (chamfer > 0) {
    const pos = geo.attributes.position;
    const hl = len / 2;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (Math.abs(Math.abs(y) - hl) < 1e-4) {
        const k = 1 - chamfer / r;
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
        pos.setY(i, y - Math.sign(y) * chamfer * 0.5);
      }
    }
    geo.computeVertexNormals();
  }
  return geo;
}

// ------------------------------------------------------------------ merging

/**
 * Accumulates transformed geometries and emits one merged, non-indexed
 * `BufferGeometry` with position / normal / uv / color.
 *
 * Colour goes into a vertex-colour attribute, which the material library's
 * surface shader multiplies into albedo (`color_fragment`) and folds into its
 * ambient-occlusion term. That is `ART_DIRECTION.md` rule 5 — per-instance hue
 * and value jitter — for the price of three floats a vertex, and it is what
 * stops four hundred rubble chunks reading as four hundred copies.
 */
export class Batch {
  constructor(name = 'batch') {
    this.name = name;
    this._parts = [];
    this.tris = 0;
  }

  get empty() { return this._parts.length === 0; }

  /**
   * @param {THREE.BufferGeometry} geo source (not modified, not retained after build)
   * @param {THREE.Matrix4} m world transform
   * @param {THREE.Color|null} color per-part tint, or null for white
   */
  addMatrix(geo, m, color) {
    const pos = geo.attributes.position;
    if (!pos) return this;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    this._parts.push({ geo, m: m.clone(), r: color ? color.r : 1, g: color ? color.g : 1, b: color ? color.b : 1 });
    this.tris += count / 3;
    return this;
  }

  /** Convenience: position + euler + uniform-or-vector scale. */
  add(geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, color = null) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.addMatrix(geo, _m4, color);
  }

  /** Merged geometry, or null if nothing was added. Clears the part list. */
  build() {
    if (!this._parts.length) return null;
    let total = 0;
    for (const p of this._parts) {
      const idx = p.geo.index;
      total += idx ? idx.count : p.geo.attributes.position.count;
    }
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const color = new Float32Array(total * 3);
    let o = 0;

    for (const p of this._parts) {
      const g = p.geo;
      const sp = g.attributes.position;
      const sn = g.attributes.normal;
      const su = g.attributes.uv;
      const sc = g.attributes.color;
      const idx = g.index;
      const n = idx ? idx.count : sp.count;
      _m3.getNormalMatrix(p.m);
      for (let i = 0; i < n; i++) {
        const j = idx ? idx.getX(i) : i;
        _v.set(sp.getX(j), sp.getY(j), sp.getZ(j)).applyMatrix4(p.m);
        position[(o + i) * 3] = _v.x; position[(o + i) * 3 + 1] = _v.y; position[(o + i) * 3 + 2] = _v.z;
        if (sn) {
          _v2.set(sn.getX(j), sn.getY(j), sn.getZ(j)).applyMatrix3(_m3).normalize();
          normal[(o + i) * 3] = _v2.x; normal[(o + i) * 3 + 1] = _v2.y; normal[(o + i) * 3 + 2] = _v2.z;
        }
        if (su) { uv[(o + i) * 2] = su.getX(j); uv[(o + i) * 2 + 1] = su.getY(j); }
        const cr = sc ? sc.getX(j) : 1, cg = sc ? sc.getY(j) : 1, cb = sc ? sc.getZ(j) : 1;
        color[(o + i) * 3] = cr * p.r; color[(o + i) * 3 + 1] = cg * p.g; color[(o + i) * 3 + 2] = cb * p.b;
      }
      o += n;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(color, 3));
    out.computeBoundingSphere();
    out.computeBoundingBox();
    out.name = this.name;
    this._parts.length = 0;
    return out;
  }
}

// ------------------------------------------------------------------ colour

/**
 * Value/hue jitter around a base tint. Kept centred near 1.0: the surface
 * shader also reads vertex colour as a baked occlusion term, so a very dark
 * instance tint would double-dip into the indirect lighting.
 */
export function jitterColor(out, rand, value = 0.16, hue = 0.02, warm = 0) {
  const v = 1 - value * 0.5 + rand() * value;
  const h = (rand() - 0.5) * hue;
  out.setRGB(
    THREE.MathUtils.clamp(v * (1 + h + warm), 0.25, 1.25),
    THREE.MathUtils.clamp(v * (1 + h * 0.2 + warm * 0.45), 0.25, 1.25),
    THREE.MathUtils.clamp(v * (1 - h * 0.9 - warm * 0.75), 0.25, 1.25),
  );
  return out;
}

export const scratch = { v: _v, v2: _v2, v3: _v3, q: _q, e: _e, m4: _m4, c: _c, box: _box };
