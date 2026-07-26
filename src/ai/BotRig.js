import * as THREE from 'three';

/**
 * Procedural soldier: skeleton, skinned geometry, hitbox volumes.
 *
 * Deliberate scope call (see `docs/ART_DIRECTION.md`): we do not attempt
 * photoreal humans. What a bot has to do is read as a *soldier silhouette* at
 * 10-30 m against a bright street and move correctly. So the effort goes into
 * proportion, gear read (helmet dome, plate carrier bulk, magazine pouches,
 * boot mass) and the skeleton that drives it — not into skin, faces or cloth.
 * The face is a balaclava and goggles: no skin shader, and it is what the
 * reference frames actually show anyway.
 *
 * Two geometries per bot, not fourteen meshes: everything soft is one skinned
 * mesh on the cloth material, everything hard (helmet, plates, boots, weapon)
 * is a second one on the gun material. Both geometries are built ONCE at
 * startup and shared by every bot — each bot only owns its own `THREE.Skeleton`.
 * That is 2 draw calls per visible bot, and the cascaded shadow map only sees a
 * bot in the one or two cascades its depth slice touches.
 *
 * Everything is authored in metres at a 1.80 m eye-to-heel scale, with joint
 * heights taken from standard anthropometry (hip 0.94, knee 0.50, shoulder
 * 1.46, eye 1.66) because getting the *joint* heights right is most of what
 * makes a walk cycle look human.
 */

// [name, parent, rest world x, y, z]. Rest orientation is identity for every
// bone, so an animator's local quaternion is just "rotation about this joint"
// with no bind-pose basis to fight.
export const BONE_DEFS = [
  ['hips', null, 0, 0.940, 0],
  ['spine', 'hips', 0, 1.090, 0.005],
  ['chest', 'spine', 0, 1.290, 0.005],
  ['neck', 'chest', 0, 1.500, -0.008],
  ['head', 'neck', 0, 1.585, 0],
  ['shoulderL', 'chest', -0.062, 1.462, 0],
  ['armL', 'shoulderL', -0.186, 1.452, 0],
  ['forearmL', 'armL', -0.204, 1.172, 0.012],
  ['handL', 'forearmL', -0.216, 0.922, 0.020],
  ['shoulderR', 'chest', 0.062, 1.462, 0],
  ['armR', 'shoulderR', 0.186, 1.452, 0],
  ['forearmR', 'armR', 0.204, 1.172, 0.012],
  ['handR', 'forearmR', 0.216, 0.922, 0.020],
  ['thighL', 'hips', -0.096, 0.925, 0],
  ['shinL', 'thighL', -0.100, 0.495, 0.006],
  ['footL', 'shinL', -0.100, 0.085, -0.014],
  ['toeL', 'footL', -0.100, 0.030, 0.120],
  ['thighR', 'hips', 0.096, 0.925, 0],
  ['shinR', 'thighR', 0.100, 0.495, 0.006],
  ['footR', 'shinR', 0.100, 0.085, -0.014],
  ['toeR', 'footR', 0.100, 0.030, 0.120],
  // Driven directly by the animator rather than parented to a hand: the aim
  // pose decides where the weapon is and the arms IK onto it, which is both how
  // it works in life and the only way to get the sight line to agree with the head.
  ['weapon', 'chest', 0.150, 1.180, 0.230],
];

export const BONE_INDEX = new Map(BONE_DEFS.map((b, i) => [b[0], i]));

/** Rest world position of a bone, for offset maths at build time. */
export function restPos(name) {
  const b = BONE_DEFS[BONE_INDEX.get(name)];
  return new THREE.Vector3(b[2], b[3], b[4]);
}

// Limb lengths the IK solver needs; derived once so they cannot drift from the
// skeleton above.
export const LIMB = (() => {
  const d = (a, b) => restPos(a).distanceTo(restPos(b));
  return {
    thigh: d('thighL', 'shinL'),
    shin: d('shinL', 'footL'),
    upperArm: d('armL', 'forearmL'),
    forearm: d('forearmL', 'handL'),
    hipY: restPos('hips').y,
    ankleY: restPos('footL').y,
    hipHalf: Math.abs(restPos('thighL').x),
    shoulderY: restPos('armL').y,
  };
})();

/**
 * Hitboxes in bone space. `mult` is the damage multiplier from
 * `docs/GAMEPLAY.md`. Limbs are two boxes each so a bent knee or a shouldered
 * elbow still has a volume where the geometry actually is.
 */
export const HITBOX_DEFS = [
  { part: 'head', bone: 'head', off: [0, 0.098, 0.004], half: [0.098, 0.115, 0.110], mult: 1.9 },
  { part: 'chest', bone: 'chest', off: [0, 0.098, 0], half: [0.175, 0.135, 0.135], mult: 1.0 },
  { part: 'stomach', bone: 'spine', off: [0, 0.020, 0], half: [0.150, 0.115, 0.120], mult: 1.05 },
  { part: 'armL', bone: 'armL', off: [-0.006, -0.140, 0], half: [0.072, 0.160, 0.072], mult: 0.85 },
  { part: 'armL', bone: 'forearmL', off: [-0.006, -0.125, 0], half: [0.062, 0.145, 0.062], mult: 0.85 },
  { part: 'armR', bone: 'armR', off: [0.006, -0.140, 0], half: [0.072, 0.160, 0.072], mult: 0.85 },
  { part: 'armR', bone: 'forearmR', off: [0.006, -0.125, 0], half: [0.062, 0.145, 0.062], mult: 0.85 },
  { part: 'legL', bone: 'thighL', off: [0, -0.215, 0], half: [0.096, 0.230, 0.100], mult: 0.85 },
  { part: 'legL', bone: 'shinL', off: [0, -0.205, 0], half: [0.078, 0.220, 0.086], mult: 0.85 },
  { part: 'legR', bone: 'thighR', off: [0, -0.215, 0], half: [0.096, 0.230, 0.100], mult: 0.85 },
  { part: 'legR', bone: 'shinR', off: [0, -0.205, 0], half: [0.078, 0.220, 0.086], mult: 0.85 },
];

/** Where the hands grip the weapon, in weapon-bone local space. */
export const GRIP_R = new THREE.Vector3(0.004, -0.052, -0.012);
export const GRIP_L = new THREE.Vector3(-0.004, -0.040, 0.255);
/** Bore origin and the eye/sight line, weapon local. */
export const MUZZLE = new THREE.Vector3(0, 0.052, 0.530);
export const SIGHT = new THREE.Vector3(0, 0.128, 0.090);

// --------------------------------------------------------------------- build

/**
 * Accumulates transformed primitives into one interleaved skinned geometry.
 * Build-time only, so it is allowed to allocate.
 */
class SkinBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.BufferGeometry} geo  disposed after use
   * @param {THREE.Matrix4} m           placement into bot-local space
   * @param {number} colour             sRGB hex tint, multiplied over the map
   * @param {(x,y,z)=>Array} skin       bot-local position -> [[boneName, w], ...]
   * @param {number} uvScale            UV metres multiplier
   */
  add(geo, m, colour, skin, uvScale = 2.6) {
    geo.applyMatrix4(m);
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    const u = geo.attributes.uv;
    const base = this.pos.length / 3;
    // Vertex colour is consumed in linear space; setHex does the conversion
    // when colour management is on, which it is.
    this._c.setHex(colour);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z);
      this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      this.uv.push((u ? u.getX(i) : 0) * uvScale, (u ? u.getY(i) : 0) * uvScale);
      this.col.push(this._c.r, this._c.g, this._c.b);

      const w = skin(x, y, z);
      let i0 = 0, w0 = 0, i1 = 0, w1 = 0, i2 = 0, w2 = 0, i3 = 0, w3 = 0;
      let total = 0;
      for (let k = 0; k < w.length && k < 4; k++) total += w[k][1];
      if (total <= 0) total = 1;
      if (w[0]) { i0 = BONE_INDEX.get(w[0][0]); w0 = w[0][1] / total; }
      if (w[1]) { i1 = BONE_INDEX.get(w[1][0]); w1 = w[1][1] / total; }
      if (w[2]) { i2 = BONE_INDEX.get(w[2][0]); w2 = w[2][1] / total; }
      if (w[3]) { i3 = BONE_INDEX.get(w[3][0]); w3 = w[3][1] / total; }
      this.si.push(i0, i1, i2, i3);
      this.sw.push(w0, w1, w2, w3);
    }
    const gi = geo.index;
    if (gi) for (let i = 0; i < gi.count; i++) this.idx.push(base + gi.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
    return this;
  }

  finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    // A bind-pose bounding sphere is far too tight once a bot lies down as a
    // ragdoll or throws an arm out; a generous manual one keeps culling honest
    // without a per-frame recompute.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1.1, -0.4, -1.1), new THREE.Vector3(1.1, 2.1, 1.1),
    );
    return g;
  }
}

const rigid = (name) => () => [[name, 1]];

/**
 * Linear blend between two bones along a world axis. `soft` is the half-width
 * of the transition in metres; outside it the vertex is rigid to one bone.
 */
function blendY(a, b, yA, yB) {
  return (x, y) => {
    const t = THREE.MathUtils.clamp((y - yA) / (yB - yA || 1), 0, 1);
    const s = t * t * (3 - 2 * t);
    return [[a, 1 - s], [b, s]];
  };
}

/** Three-way spine blend so the torso deforms instead of shearing at one seam. */
function blendSpine(y) {
  const hips = 1 - THREE.MathUtils.smoothstep(y, 0.98, 1.12);
  const chest = THREE.MathUtils.smoothstep(y, 1.14, 1.30);
  const spine = Math.max(0, 1 - hips - chest);
  return [['hips', hips], ['spine', spine], ['chest', chest]];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Placement matrix: position, XYZ euler, scale. */
function at(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s).clone();
}

const _rv = new THREE.Vector3();
const _rc = new THREE.Vector3();

/**
 * Rounded box. A hard 90° edge reads as an untextured box at any distance, and
 * on a body it reads as LEGO; every hard edge on a bot gets a radius.
 *
 * The naive "clamp the corners inwards" version this replaces did nothing at
 * all — with one segment per axis *every* vertex is a corner, so clamping them
 * all just produced a slightly smaller box. Real rounding needs interior
 * vertices to hold the flat of the face, hence the forced minimum of two
 * segments: each vertex is projected onto the surface of the box's Minkowski
 * sum with a sphere of radius `r`, which is exactly a rounded box.
 */
function rbox(w, h, d, r = 0.02, seg = 1) {
  const s = Math.max(2, seg + 1);
  const g = new THREE.BoxGeometry(w, h, d, s, s, s);
  const rr = Math.min(r, w * 0.42, h * 0.42, d * 0.42);
  const hx = w / 2 - rr, hy = h / 2 - rr, hz = d / 2 - rr;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _rv.fromBufferAttribute(p, i);
    _rc.set(
      THREE.MathUtils.clamp(_rv.x, -hx, hx),
      THREE.MathUtils.clamp(_rv.y, -hy, hy),
      THREE.MathUtils.clamp(_rv.z, -hz, hz),
    );
    _rv.sub(_rc);
    const l = _rv.length();
    if (l > 1e-6) _rv.multiplyScalar(rr / l).add(_rc); else _rv.copy(_rc);
    p.setXYZ(i, _rv.x, _rv.y, _rv.z);
  }
  // BoxGeometry keeps one vertex per face corner, so this averages within a
  // face and not across the rounded edge: the flat stays flat, the radius
  // catches a highlight, and adjacent faces still meet exactly.
  g.computeVertexNormals();
  return g;
}

/** Tapered limb segment, origin at its top, running down -Y for `len`. */
function limb(rTop, rBot, len, radial = 8) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, radial, 1, false);
  g.translate(0, -len / 2, 0);
  return g;
}

function sphere(r, wSeg = 10, hSeg = 7) {
  return new THREE.SphereGeometry(r, wSeg, hSeg);
}

// Tactical palette. These multiply the cloth/gun albedo maps, so they read
// darker in frame than they do here — tuned against the actual screenshot.
const C = {
  fatigue: 0x968f76,   // dusty olive-tan combat shirt/trousers
  fatigueDark: 0x7b7660,
  carrier: 0x545849,   // plate carrier, coyote-green
  pouch: 0x605f4c,
  strap: 0x42423a,
  boot: 0x332e28,
  glove: 0x2b2b28,
  helmet: 0x4f534a,
  helmetTrim: 0x35382f,
  goggle: 0x181b1f,
  face: 0x24231f,      // balaclava
  gunDark: 0x9aa0a4,   // multiplies the gun_metal map
  gunPoly: 0x7d8288,
  optic: 0x40464b,
  packA: 0x625f4c,
};

/** The cloth half of the body. */
function buildBody() {
  const b = new SkinBuilder();
  const spineSkin = (x, y) => blendSpine(y);

  // Pelvis + hips.
  b.add(rbox(0.300, 0.230, 0.215, 0.05), at(0, 0.985, 0.005), C.fatigue, spineSkin);
  // Belt.
  b.add(rbox(0.312, 0.062, 0.228, 0.02), at(0, 0.905, 0.005), C.strap, rigid('hips'));
  // Torso: waist to chest, wider and deeper at the top.
  b.add(rbox(0.310, 0.290, 0.210, 0.055, 2), at(0, 1.190, 0.004), C.fatigue, spineSkin);
  b.add(rbox(0.335, 0.230, 0.225, 0.055, 2), at(0, 1.355, 0.004), C.fatigue, spineSkin);
  // Trapezius wedge so the neck does not grow out of a flat shelf.
  b.add(rbox(0.290, 0.090, 0.185, 0.05), at(0, 1.452, 0.002), C.fatigue, rigid('chest'));

  // Neck.
  b.add(limb(0.058, 0.062, 0.10, 8), at(0, 1.552, -0.006), C.face, rigid('neck'));

  // Head: skull, balaclava lower face, goggles.
  b.add(sphere(0.104, 12, 9), at(0, 1.683, 0.004, 0, 0, 0, 0.92, 1.10, 1.02), C.face, rigid('head'));
  b.add(rbox(0.150, 0.090, 0.170, 0.045), at(0, 1.628, 0.020), C.face, rigid('head'));

  // Arms. Deltoid caps are rigid to the upper arm so the shoulder does not
  // pinch when the arm comes up to a firing position.
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    b.add(sphere(0.076, 10, 8), at(s * 0.186, 1.452, 0, 0, 0, 0, 1.0, 1.05, 1.0),
      C.fatigueDark, rigid('arm' + S));
    b.add(limb(0.062, 0.050, 0.272), at(s * 0.190, 1.446, 0.004), C.fatigue,
      blendY('arm' + S, 'forearm' + S, 1.245, 1.172));
    b.add(sphere(0.052, 8, 6), at(s * 0.204, 1.172, 0.010), C.fatigue, rigid('forearm' + S));
    // Rolled sleeve cuff — a hard line on the forearm is a strong read.
    b.add(limb(0.052, 0.041, 0.240), at(s * 0.206, 1.170, 0.012), C.fatigueDark,
      blendY('forearm' + S, 'hand' + S, 0.985, 0.935));
    b.add(rbox(0.056, 0.098, 0.092, 0.022), at(s * 0.218, 0.892, 0.026), C.glove, rigid('hand' + S));
  }

  // Legs.
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    // Combat trousers, not tights: the legs were reading as two poles with a
    // stripe of bright street between them.
    b.add(limb(0.122, 0.094, 0.435, 9), at(s * 0.096, 0.932, 0.004), C.fatigue,
      blendY('thigh' + S, 'shin' + S, 0.585, 0.495));
    b.add(sphere(0.086, 9, 7), at(s * 0.100, 0.495, 0.008), C.fatigue, rigid('shin' + S));
    b.add(limb(0.094, 0.070, 0.330, 9), at(s * 0.100, 0.492, 0.006), C.fatigue,
      blendY('shin' + S, 'foot' + S, 0.260, 0.190));
    // Blousing over the boot: a distinct step in the silhouette at the ankle.
    b.add(limb(0.088, 0.079, 0.078, 9), at(s * 0.100, 0.182, 0.002), C.fatigueDark,
      rigid('shin' + S));
  }
  return b.finish();
}

/** The hard half: armour, helmet, boots, pouches, weapon. */
function buildGear() {
  const b = new SkinBuilder();

  // Plate carrier: front and back plates plus a cummerbund, sitting proud of
  // the torso. This is most of the upper-body silhouette.
  b.add(rbox(0.330, 0.330, 0.075, 0.030), at(0, 1.288, 0.118), C.carrier, rigid('chest'), 2.2);
  b.add(rbox(0.330, 0.350, 0.070, 0.030), at(0, 1.288, -0.112), C.carrier, rigid('chest'), 2.2);
  b.add(rbox(0.352, 0.190, 0.245, 0.035), at(0, 1.180, 0.004), C.carrier, rigid('spine'), 2.2);
  // Shoulder straps.
  for (const s of [-1, 1]) {
    b.add(rbox(0.078, 0.062, 0.250, 0.020), at(s * 0.108, 1.432, 0.010), C.strap, rigid('chest'), 2.2);
  }
  // Magazine pouches, front, three across — the read that says "soldier".
  for (let i = -1; i <= 1; i++) {
    b.add(rbox(0.088, 0.150, 0.062, 0.018), at(i * 0.094, 1.192, 0.170, 0.10), C.pouch, rigid('chest'), 2.4);
  }
  // Admin pouch and a radio on the left strap.
  b.add(rbox(0.130, 0.095, 0.055, 0.016), at(-0.070, 1.352, 0.162), C.pouch, rigid('chest'), 2.4);
  b.add(rbox(0.062, 0.115, 0.048, 0.014), at(0.128, 1.372, 0.086), C.helmetTrim, rigid('chest'), 2.4);
  b.add(limb(0.006, 0.006, 0.170, 5), at(0.128, 1.560, 0.086, -0.22), C.helmetTrim, rigid('chest'), 2.4);
  // Assault pack.
  b.add(rbox(0.300, 0.360, 0.150, 0.045), at(0, 1.300, -0.212), C.packA, rigid('chest'), 2.0);
  b.add(rbox(0.230, 0.110, 0.090, 0.025), at(0, 1.180, -0.300), C.pouch, rigid('chest'), 2.4);
  // Hip pouches / dump pouch.
  for (const s of [-1, 1]) {
    b.add(rbox(0.090, 0.130, 0.080, 0.020), at(s * 0.168, 0.918, -0.030), C.pouch, rigid('hips'), 2.4);
  }
  // Knee pads.
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    b.add(rbox(0.110, 0.150, 0.060, 0.028), at(s * 0.100, 0.520, 0.062), C.helmetTrim, rigid('shin' + S), 2.4);
  }

  // Boots. Authored so the sole sits exactly on y = 0 in the rest pose — the
  // foot IK plants the ankle at ground + 0.085, and a sole modelled below the
  // origin would bury itself in the road.
  for (const s of [-1, 1]) {
    const S = s < 0 ? 'L' : 'R';
    b.add(rbox(0.120, 0.106, 0.286, 0.026), at(s * 0.100, 0.066, 0.030), C.boot, rigid('foot' + S), 2.4);
    b.add(rbox(0.128, 0.034, 0.300, 0.014), at(s * 0.100, 0.017, 0.032), C.helmetTrim, rigid('foot' + S), 2.4);
    // Toe box, so the boot is not one slab from heel to tip.
    b.add(rbox(0.108, 0.070, 0.090, 0.030), at(s * 0.100, 0.050, 0.145), C.boot, rigid('toe' + S), 2.4);
  }

  // Sling, worn across the chest. It is skinned to the torso rather than to the
  // weapon: a strap that has to stretch between two independently animated
  // bones is a rig problem with no visual payoff at 15 m, and the read we want
  // is just the diagonal line across the plate carrier.
  b.add(rbox(0.048, 0.400, 0.028, 0.012), at(-0.052, 1.300, 0.148, 0, 0, -0.52), C.strap, rigid('chest'), 2.4);
  b.add(rbox(0.044, 0.230, 0.026, 0.012), at(-0.150, 1.400, -0.030, 0, 0.9, -0.30), C.strap, rigid('chest'), 2.4);

  // Helmet: dome, brim, NVG mount, side rails.
  const dome = new THREE.SphereGeometry(0.128, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.58);
  b.add(dome, at(0, 1.672, 0.002, 0, 0, 0, 1.0, 1.06, 1.08), C.helmet, rigid('head'), 2.0);
  b.add(rbox(0.228, 0.034, 0.248, 0.016), at(0, 1.678, 0.010), C.helmet, rigid('head'), 2.2);
  b.add(rbox(0.052, 0.052, 0.040, 0.010), at(0, 1.742, 0.108), C.helmetTrim, rigid('head'), 2.4);
  b.add(rbox(0.013, 0.026, 0.128, 0.006), at(-0.112, 1.698, 0.012), C.helmetTrim, rigid('head'), 2.4);
  b.add(rbox(0.013, 0.026, 0.128, 0.006), at(0.112, 1.698, 0.012), C.helmetTrim, rigid('head'), 2.4);
  // Goggles pushed up on the brim: a bright specular line at eye level, which
  // is what makes a helmeted head read as a head and not a lump.
  b.add(rbox(0.190, 0.052, 0.060, 0.020), at(0, 1.706, 0.092, -0.15), C.goggle, rigid('head'), 3.0);

  buildWeapon(b);
  return b.finish();
}

/**
 * Carbine, authored in weapon-bone local space: bore along +Z at y = 0.052,
 * origin at the web of the firing hand. ~0.86 m overall.
 */
function buildWeapon(b) {
  const w = restPos('weapon');
  const put = (geo, x, y, z, rx = 0, ry = 0, rz = 0, colour = C.gunDark, uv = 3.4) =>
    b.add(geo, at(w.x + x, w.y + y, w.z + z, rx, ry, rz), colour, rigid('weapon'), uv);

  // Lower + upper receiver.
  put(rbox(0.044, 0.082, 0.230, 0.010), 0, 0.020, 0.062, 0, 0, 0, C.gunPoly);
  put(rbox(0.046, 0.062, 0.300, 0.010), 0, 0.078, 0.070);
  // Charging handle / dust cover ridge.
  put(rbox(0.050, 0.016, 0.120, 0.005), 0, 0.112, -0.040);
  // Pistol grip.
  put(rbox(0.038, 0.115, 0.052, 0.014), 0, -0.048, -0.028, 0.32, 0, 0, C.gunPoly);
  // Trigger guard.
  put(rbox(0.030, 0.012, 0.070, 0.005), 0, -0.016, 0.032);
  // Magazine, raked forward like a STANAG curve.
  put(rbox(0.032, 0.185, 0.072, 0.010), 0, -0.075, 0.088, 0.20, 0, 0, C.gunPoly);
  // Handguard with a rail top.
  put(rbox(0.048, 0.060, 0.270, 0.010), 0, 0.070, 0.300, 0, 0, 0, C.gunPoly);
  put(rbox(0.036, 0.012, 0.270, 0.004), 0, 0.104, 0.300);
  // Barrel + muzzle device.
  put(new THREE.CylinderGeometry(0.011, 0.011, 0.110, 8), 0, 0.052, 0.480, Math.PI / 2);
  put(new THREE.CylinderGeometry(0.017, 0.015, 0.058, 8), 0, 0.052, 0.552, Math.PI / 2);
  // Collapsible stock: buffer tube, cheek riser, butt pad.
  put(new THREE.CylinderGeometry(0.019, 0.019, 0.190, 8), 0, 0.072, -0.130, Math.PI / 2);
  put(rbox(0.042, 0.070, 0.150, 0.014), 0, 0.062, -0.185, 0, 0, 0, C.gunPoly);
  put(rbox(0.048, 0.104, 0.028, 0.010), 0, 0.054, -0.268, 0, 0, 0, C.gunPoly);
  // Optic: mount, tube, glass face.
  put(rbox(0.034, 0.032, 0.070, 0.008), 0, 0.120, 0.090, 0, 0, 0, C.optic);
  put(new THREE.CylinderGeometry(0.024, 0.024, 0.098, 10), 0, 0.148, 0.092, Math.PI / 2, 0, 0, C.optic);
  put(new THREE.CylinderGeometry(0.021, 0.021, 0.006, 10), 0, 0.148, 0.044, Math.PI / 2, 0, 0, C.goggle);
  // Vertical foregrip and a sling loop: two things that break the tube.
  put(rbox(0.026, 0.078, 0.030, 0.010), 0, 0.020, 0.330, -0.12, 0, 0, C.gunPoly);
  put(rbox(0.030, 0.026, 0.014, 0.005), 0, 0.040, -0.052);
}

let _shared = null;

/** Both bot geometries, built once and shared by every bot in the pool. */
export function getRigGeometry() {
  if (!_shared) _shared = { body: buildBody(), gear: buildGear() };
  return _shared;
}

/**
 * A fresh bone hierarchy in the rest pose plus the Skeleton bound to it.
 * Bones are `THREE.Bone` so three's own skinning path drives them.
 */
export function createSkeleton() {
  const bones = [];
  const byName = new Map();
  for (const [name, parent, x, y, z] of BONE_DEFS) {
    const bone = new THREE.Bone();
    bone.name = name;
    const p = parent ? byName.get(parent) : null;
    if (p) {
      const pd = BONE_DEFS[BONE_INDEX.get(parent)];
      bone.position.set(x - pd[2], y - pd[3], z - pd[4]);
      p.add(bone);
    } else {
      bone.position.set(x, y, z);
    }
    bone.userData.rest = new THREE.Vector3(x, y, z);
    bones.push(bone);
    byName.set(name, bone);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { bones, byName, root, skeleton };
}

export function disposeRigGeometry() {
  if (!_shared) return;
  _shared.body.dispose();
  _shared.gear.dispose();
  _shared = null;
}
