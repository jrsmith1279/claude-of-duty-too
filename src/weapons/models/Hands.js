import * as THREE from 'three';
import { Part, chamferBox, cyl, capsuleZ, sphere, prep } from '../GunKit.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Gloved hands.
 *
 * `ART_DIRECTION.md` rules out photoreal humans, and it is right to — but a
 * weapon floating in space with nothing holding it is the single loudest tell
 * a first-person shooter can have, and every Call of Duty frame has hands in
 * it. The resolution is to model what is actually visible in a real frame:
 * *gloves*. A nomex tactical glove is dark, matte, seamed fabric over simple
 * forms. No skin, no fingernails, no subsurface scattering, no rigged fingers
 * — just correctly proportioned shapes wrapped round the grip and handguard,
 * mostly in the shadow of the weapon.
 *
 * Both hands are built once, in the local space of the model's `gripRear` and
 * `gripFront` nodes, so every weapon gets hands for free as long as it
 * publishes those two nodes at the right place.
 */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/**
 * A curled finger: a chain of tapering capsules, each rotated a little further
 * round than the last, so the knuckles read as knuckles.
 *
 * @param dir     unit direction the finger sets off in
 * @param curl    total curl in radians across the whole finger
 * @param axis    curl axis
 */
function finger(base, dirX, dirY, dirZ, curl, axisX, axisY, axisZ, len = 0.056, r0 = 0.0085) {
  const segs = [0.42, 0.33, 0.25];
  const parts = [];
  const pos = new THREE.Vector3(base[0], base[1], base[2]);
  const dir = new THREE.Vector3(dirX, dirY, dirZ).normalize();
  const axis = new THREE.Vector3(axisX, axisY, axisZ).normalize();
  const rot = new THREE.Quaternion();
  let r = r0;
  for (let i = 0; i < segs.length; i++) {
    const L = len * segs[i];
    const rEnd = r * 0.86;
    // Capsule along Z, then aim it down `dir`.
    const g = new THREE.CapsuleGeometry((r + rEnd) * 0.5, Math.max(1e-4, L - r), 2, 7);
    g.rotateX(Math.PI / 2);
    rot.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    _v.copy(pos).addScaledVector(dir, L * 0.5);
    _m4.compose(_v, rot, _s);
    g.applyMatrix4(_m4);
    parts.push(prep(g));
    // Knuckle bead at each joint keeps the silhouette from reading as a tube.
    if (i < segs.length - 1) {
      const k = sphere(rEnd * 1.06, 7);
      k.translate(pos.x + dir.x * L, pos.y + dir.y * L, pos.z + dir.z * L);
      parts.push(prep(k));
    }
    pos.addScaledVector(dir, L);
    dir.applyAxisAngle(axis, curl * segs[i] / 0.42 * 0.5);
    r = rEnd;
  }
  return mergeGeometries(parts, false);
}

/** Trigger hand: wraps the pistol grip, index finger on the trigger. */
function buildTriggerHand(p, trigger) {
  // Palm, on the shooter's side of the grip.
  p.add('glove', chamferBox(0.0250, 0.0780, 0.0470, { r: 0.0110, bevel: 0.0025, curveSegments: 3 }), { x: 0.0215, y: -0.0085, z: 0.0055, rz: -0.06 });
  // Heel of the hand, thicker at the base.
  p.add('glove', chamferBox(0.0240, 0.0260, 0.0430, { r: 0.0110, bevel: 0.0025 }), { x: 0.0230, y: -0.0400, z: 0.0140, rx: -0.12 });
  // Padded back-of-hand panel — the one piece of a tactical glove that is not
  // fabric, and the thing that makes it read as a glove rather than a mitten.
  p.add('glove_pad', chamferBox(0.0050, 0.0480, 0.0320, { r: 0.0060, bevel: 0.0014 }), { x: 0.0340, y: -0.0060, z: 0.0080, rz: -0.06 });

  // Three curled fingers round the front of the grip.
  for (let i = 0; i < 3; i++) {
    const y = -0.0010 - i * 0.0185;
    p.add('glove', finger([0.0175, y, -0.0130], -0.10, -0.12, -1.0, 2.3, 1, 0, 0, 0.052 - i * 0.004, 0.0082 - i * 0.0006), {});
  }
  // Index finger, straighter, reaching the trigger.
  p.add('glove', finger([0.0170, 0.0195, -0.0120], -0.16, -0.05, -1.0, 1.15, 1, 0, 0, 0.055, 0.0086), {});
  // Thumb round the back of the grip.
  p.add('glove', finger([0.0195, 0.0210, 0.0180], -0.55, -0.30, -0.78, 0.85, 0.4, -0.5, 0.6, 0.048, 0.0098), {});

  // Wrist and cuff running down out of frame.
  p.add('glove', cyl(0.0230, 0.0265, 0.0420, 12), { x: 0.0270, y: -0.0620, z: 0.0300, rx: 1.20 });
  p.add('sleeve', cyl(0.0290, 0.0310, 0.0460, 12), { x: 0.0320, y: -0.0910, z: 0.0430, rx: 1.20 });
  p.add('glove_pad', ring(0.0288, 0.0034, 12, 5), { x: 0.0292, y: -0.0740, z: 0.0357, rx: 1.20 });
}

/** Support hand: C-clamp on the handguard, thumb forward along the top. */
function buildSupportHand(p, radius) {
  const R = radius;
  // Palm pressed against the left flank of the handguard.
  p.add('glove', chamferBox(0.0230, 0.0520, 0.0800, { r: 0.0100, bevel: 0.0025, curveSegments: 3 }), { x: -(R + 0.0130), y: -0.0090, z: 0.0000, rz: 0.10 });
  p.add('glove_pad', chamferBox(0.0048, 0.0380, 0.0620, { r: 0.0070, bevel: 0.0014 }), { x: -(R + 0.0250), y: -0.0060, z: 0.0000, rz: 0.10 });
  // Four fingers reaching over the top of the handguard.
  for (let i = 0; i < 4; i++) {
    const z = -0.0270 + i * 0.0180;
    p.add('glove', finger([-(R + 0.0075), -0.0230 + i * 0.0010, z], 0.30, 0.95, 0.0, 2.5, 0, 0, -1, 0.050 - i * 0.003, 0.0082 - i * 0.0005), {});
  }
  // Thumb laid forward along the top-left rail, the modern C-clamp grip.
  p.add('glove', finger([-(R + 0.0055), 0.0130, 0.0180], 0.22, 0.16, -0.96, 0.35, 1, 0, 0, 0.058, 0.0098), {});
  // Wrist dropping away below-left.
  p.add('glove', cyl(0.0225, 0.0260, 0.0400, 12), { x: -(R + 0.0230), y: -0.0420, z: 0.0250, rx: 1.05, rz: 0.30 });
  p.add('sleeve', cyl(0.0285, 0.0305, 0.0480, 12), { x: -(R + 0.0330), y: -0.0680, z: 0.0410, rx: 1.05, rz: 0.30 });
}

function ring(radius, thickness, seg, tubeSeg) {
  return new THREE.TorusGeometry(radius, thickness, tubeSeg, seg);
}

/**
 * @returns {{ rear: THREE.Group, front: THREE.Group }} parented to the model's
 *          grip nodes by the caller.
 */
export function buildHands(resolve, opts = {}) {
  const rearPart = new Part('handRear', resolve);
  buildTriggerHand(rearPart, opts.trigger);
  const rear = rearPart.build();

  const frontPart = new Part('handFront', resolve);
  buildSupportHand(frontPart, opts.gripRadius ?? 0.0218);
  const front = frontPart.build();

  return { rear, front };
}
