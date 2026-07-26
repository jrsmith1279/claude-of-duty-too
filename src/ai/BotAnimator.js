import * as THREE from 'three';
import { LIMB, restPos, GRIP_L, GRIP_R, SIGHT } from './BotRig.js';

/**
 * Procedural locomotion for one bot. No clips, no keyframe data: the pose is
 * solved every frame from the bot's velocity, facing, stance and aim target.
 *
 * The core idea is that **feet are planted in world space**, not in body space.
 * A foot picks a spot on the ground, stays exactly there while the body moves
 * over it, and only moves during an explicit swing. Sliding feet are the single
 * loudest animation tell in a game, and they are impossible here by
 * construction — the same mechanism gives turn-in-place shuffles, stopping
 * without a skate, and correct steps on the kerb, all for free.
 *
 * Everything above the ankles is spring-driven: hip height falls out of leg
 * reach, the pelvis rolls and yaws with the stride, the chest counter-rotates
 * against the pelvis, and the weapon is placed so its sight sits in front of
 * the eye with the hands IK'd onto its grips. The arms therefore never swing
 * independently — a soldier's arms are locked to his rifle and the swing you
 * see is torso counter-rotation, which is what makes a rifle carry read as a
 * rifle carry rather than as a jog.
 *
 * Solved in "rig space" (the bot's own frame: +Z forward, origin at the feet)
 * so a planted foot is the only thing that needs a world round-trip.
 */

// ------------------------------------------------------------------ constants

const REST = {
  hips: restPos('hips'),
  spine: restPos('spine'),
  chest: restPos('chest'),
  neck: restPos('neck'),
  head: restPos('head'),
  shoulderL: restPos('shoulderL'), armL: restPos('armL'),
  forearmL: restPos('forearmL'), handL: restPos('handL'),
  shoulderR: restPos('shoulderR'), armR: restPos('armR'),
  forearmR: restPos('forearmR'), handR: restPos('handR'),
  thighL: restPos('thighL'), shinL: restPos('shinL'), footL: restPos('footL'), toeL: restPos('toeL'),
  thighR: restPos('thighR'), shinR: restPos('shinR'), footR: restPos('footR'), toeR: restPos('toeR'),
  weapon: restPos('weapon'),
};

const ANKLE_Y = REST.footL.y;                       // sole on the ground = ankle at this height
const LEG_MAX = (LIMB.thigh + LIMB.shin) * 0.985;
const ARM_MAX = (LIMB.upperArm + LIMB.forearm) * 0.995;
const HIP_HALF = LIMB.hipHalf;

const STANCE = {
  stand: { hip: 0.940, lean: 0.02, width: 1.00, eye: 1.664 },
  crouch: { hip: 0.700, lean: 0.16, width: 1.30, eye: 1.240 },
};

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// Module scratch — the animator runs for every bot every frame and must not
// allocate a byte.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _eu = new THREE.Euler();

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

function shortAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Critically-damped second-order spring. Used for anything that has weight:
 * hips, lean, aim. A lerp cannot overshoot and a body that never overshoots
 * reads as weightless.
 */
class Spring {
  constructor(value = 0, freq = 9) { this.x = value; this.v = 0; this.freq = freq; }
  step(target, dt) {
    const w = this.freq;
    const a = (target - this.x) * w * w - this.v * 2 * w;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

/** One foot's planting state. Plant positions are WORLD space. */
class Foot {
  constructor(side) {
    this.side = side;                       // -1 left, +1 right
    this.plant = new THREE.Vector3();       // where the sole is standing
    this.prev = new THREE.Vector3();        // where the swing came from
    this.target = new THREE.Vector3();      // where the swing is going
    this.pos = new THREE.Vector3();         // current sole position (world)
    this.plantYaw = 0;
    this.prevYaw = 0;
    this.targetYaw = 0;
    this.swinging = false;
    this.t = 0;
    this.duration = 0.3;
    this.lift = 0.08;
    this.pitch = 0;
    this.heel = 0;
  }
}

export class BotAnimator {
  /**
   * @param {Map<string, THREE.Bone>} bones  from `createSkeleton().byName`
   */
  constructor(bones) {
    this.bones = bones;
    this.feet = [new Foot(-1), new Foot(1)];
    this.phase = 0;
    this.hipSpring = new Spring(STANCE.stand.hip, 13);
    this.leanX = new Spring(0, 8);
    this.leanZ = new Spring(0, 8);
    this.aimBlend = new Spring(0, 7);
    this.crouchBlend = new Spring(0, 9);
    this.aimYaw = new Spring(0, 11);
    this.aimPitch = new Spring(0, 11);
    this.recoil = new Spring(0, 26);
    this.bobT = 0;
    this.speedSmooth = 0;
    this.yaw = 0;
    this.prevYaw = 0;
    this.turnRate = 0;
    this.initialised = false;

    // Rig-space forward kinematics cache for the bones the solver needs.
    this._P = { hips: new THREE.Vector3(), spine: new THREE.Vector3(), chest: new THREE.Vector3() };
    this._Q = { hips: new THREE.Quaternion(), spine: new THREE.Quaternion(), chest: new THREE.Quaternion() };
    this._weaponP = new THREE.Vector3();
    this._weaponQ = new THREE.Quaternion();
    this._muzzle = new THREE.Vector3();
  }

  bone(name) { return this.bones.get(name); }

  /** Snap both feet under the bot; call on spawn and after a teleport. */
  reset(pos, yaw) {
    this.yaw = yaw;
    this.prevYaw = yaw;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    for (const f of this.feet) {
      const lx = f.side * HIP_HALF;
      f.plant.set(pos.x + c * lx, pos.y, pos.z - s * lx);
      f.pos.copy(f.plant);
      f.prev.copy(f.plant);
      f.target.copy(f.plant);
      f.plantYaw = f.prevYaw = f.targetYaw = yaw;
      f.swinging = false;
      f.t = 0;
    }
    this.phase = 0.5;
    this.hipSpring.x = STANCE.stand.hip;
    this.hipSpring.v = 0;
    this.initialised = true;
  }

  /**
   * @param {object} s  bot state:
   *   pos (Vector3, feet, world), yaw, speed, velocity, crouch (0..1),
   *   aiming (0..1), aimPoint (Vector3|null), groundAt(x, z) -> y, dt
   */
  update(s) {
    const dt = Math.min(s.dt, 0.05);
    if (!this.initialised) this.reset(s.pos, s.yaw);

    this.prevYaw = this.yaw;
    this.yaw = s.yaw;
    this.turnRate = damp(this.turnRate, shortAngle(this.yaw - this.prevYaw) / Math.max(dt, 1e-4), 8, dt);
    this.speedSmooth = damp(this.speedSmooth, s.speed, 9, dt);

    const crouch = this.crouchBlend.step(s.crouch || 0, dt);
    const aim = this.aimBlend.step(s.aiming || 0, dt);

    this._stepFeet(s, dt, crouch);
    this._solveBody(s, dt, crouch, aim);
    this._solveLegs(s, crouch);
    this._solveUpper(s, dt, crouch, aim);
  }

  // ----------------------------------------------------------------- footwork

  _stepFeet(s, dt, crouch) {
    const st = crouch > 0.5 ? STANCE.crouch : STANCE.stand;
    const speed = this.speedSmooth;
    const running = speed > 2.6;
    // Stride grows with speed: a 1.4 m/s walk steps ~0.75 m, a 4.5 m/s run ~1.3 m.
    const stride = THREE.MathUtils.clamp(0.52 + speed * 0.185, 0.5, 1.34);
    const swingTime = THREE.MathUtils.clamp(0.42 - speed * 0.045, 0.17, 0.42);

    if (speed > 0.12) this.phase += (speed * dt) / (2 * stride);
    this.phase -= Math.floor(this.phase);

    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    // Where the body wants this foot, ignoring the gait: hip width, opened out
    // in a crouch, and pushed ahead by half a stride's worth of travel.
    const lead = Math.min(speed * 0.16, 0.34);

    let swingingCount = 0;
    for (const f of this.feet) if (f.swinging) swingingCount++;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const lx = f.side * HIP_HALF * st.width;
      const nx = s.pos.x + c * lx + s.velocity.x * lead;
      const nz = s.pos.z - sn * lx + s.velocity.z * lead;

      if (f.swinging) {
        f.t += dt / f.duration;
        if (f.t >= 1) {
          f.t = 1;
          f.swinging = false;
          f.plant.copy(f.target);
          f.plantYaw = f.targetYaw;
          if (s.onFootDown) s.onFootDown(f, speed);
        }
        const t = f.t;
        // Ease-out horizontally so the foot decelerates into the plant, and a
        // sine arc vertically. Both are what separates a step from a slide.
        const e = t * t * (3 - 2 * t);
        const eo = 1 - (1 - t) * (1 - t);
        f.pos.lerpVectors(f.prev, f.target, eo);
        f.pos.y = THREE.MathUtils.lerp(f.prev.y, f.target.y, e) + Math.sin(Math.PI * t) * f.lift;
        // Dorsiflex through the swing so the toe clears the ground, and land
        // heel-first. Positive pitch is toe-down.
        f.pitch = -Math.sin(Math.PI * t) * (running ? 0.42 : 0.26);
        continue;
      }

      f.pos.copy(f.plant);
      // Toe-off: `heel` is set by the hip solver when the leg runs out of reach.
      f.pitch = damp(f.pitch, (f.heel || 0) * 0.62, 16, dt);

      // Step triggers. Either the gait says it is this foot's turn, or the foot
      // has been left too far behind — which is what produces a turn-in-place
      // shuffle and a settle-after-stopping without any special case.
      const err = Math.hypot(f.plant.x - nx, f.plant.z - nz);
      const yawErr = Math.abs(shortAngle(f.plantYaw - this.yaw));
      const trigger = f.side < 0 ? 0.0 : 0.5;
      const phaseHit = speed > 0.35 && crossed(this.phase, this.phase - (speed * dt) / (2 * stride), trigger);
      const strayed = err > (speed > 0.35 ? stride * 0.95 : 0.30) || yawErr > 0.55;
      if (!phaseHit && !strayed) continue;
      // One foot on the ground at a time, except in a run, where a short
      // flight phase is correct and is most of what makes a run read as a run.
      if (swingingCount > 0 && !(running && this.feet[1 - i].t > 0.62)) continue;

      f.prev.copy(f.pos);
      f.prevYaw = f.plantYaw;
      const over = phaseHit ? stride * 0.5 : Math.min(err * 0.65, 0.4);
      const dirx = speed > 0.35 ? s.velocity.x / Math.max(speed, 1e-3) : 0;
      const dirz = speed > 0.35 ? s.velocity.z / Math.max(speed, 1e-3) : 0;
      f.target.set(nx + dirx * over, s.pos.y, nz + dirz * over);
      f.target.y = s.groundAt ? s.groundAt(f.target.x, f.target.z, s.pos.y) : s.pos.y;
      f.targetYaw = this.yaw;
      f.duration = swingTime;
      f.lift = 0.045 + speed * 0.028 + Math.abs(f.target.y - f.prev.y) * 0.5;
      f.t = 0;
      f.swinging = true;
      swingingCount++;
    }
  }

  // ------------------------------------------------------------------ torso

  _solveBody(s, dt, crouch, aim) {
    const st = crouch > 0.5 ? STANCE.crouch : STANCE.stand;
    const speed = this.speedSmooth;
    const hipBase = THREE.MathUtils.lerp(STANCE.stand.hip, STANCE.crouch.hip, crouch);

    // Gait bob: two dips per cycle (one per foot strike), sunk deeper the
    // faster the bot moves.
    const gait = this.phase * Math.PI * 2;
    const bobAmp = Math.min(0.012 + speed * 0.0125, 0.055) * (1 - crouch * 0.5);
    let hipTarget = s.pos.y + hipBase - Math.abs(Math.sin(gait)) * bobAmp * 2 + bobAmp;

    // Hip height is then whatever the legs can actually reach. Two things do
    // the work at full stride, and without both the ankle IK simply cannot
    // touch its target and the foot floats:
    //   - the pelvis drops, exactly as a real one does at double support;
    //   - the trailing heel comes off the ground, which buys back ~8 cm of
    //     reach and is the single most recognisable moment in a walk cycle.
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (let pass = 0; pass < 2; pass++) {
      for (const f of this.feet) {
        if (f.swinging) { f.heel = 0; continue; }
        const lx = f.side * HIP_HALF;
        const jx = s.pos.x + c * lx, jz = s.pos.z - sn * lx;
        const dxz = Math.hypot(f.pos.x - jx, f.pos.z - jz);
        const vert = Math.sqrt(Math.max(LEG_MAX * LEG_MAX - dxz * dxz, 0.02));
        let limit = f.pos.y + ANKLE_Y + vert + (REST.hips.y - REST.thighL.y);
        f.heel = THREE.MathUtils.clamp((hipTarget - limit) / 0.11, 0, 1);
        limit += f.heel * 0.088;
        hipTarget = Math.min(hipTarget, Math.max(limit, f.pos.y + 0.46));
      }
    }
    this.hipSpring.step(hipTarget, dt);

    // Lean: forward into acceleration and speed, inward into a turn.
    const leanPitch = st.lean + Math.min(speed * 0.055, 0.26) + crouch * 0.06;
    const leanRoll = THREE.MathUtils.clamp(-this.turnRate * 0.10 * Math.min(speed, 4) / 4, -0.16, 0.16);
    this.leanX.step(leanPitch, dt);
    this.leanZ.step(leanRoll, dt);

    const hips = this.bone('hips');
    const gaitAmp = THREE.MathUtils.clamp(speed / 3.6, 0, 1);
    // Pelvic list: the swing-side hip drops, and the pelvis counter-rotates
    // against the shoulders. Both are small and both are load-bearing.
    const list = Math.sin(gait) * 0.085 * gaitAmp;
    const pelvisYaw = -Math.sin(gait) * 0.16 * gaitAmp;
    const sway = Math.sin(gait) * (0.020 + 0.022 * gaitAmp);

    hips.position.set(
      sway * (1 - crouch * 0.4),
      this.hipSpring.x - s.pos.y,
      -0.02 - crouch * 0.05 - Math.min(speed * 0.012, 0.05),
    );
    _eu.set(this.leanX.x * 0.45, pelvisYaw, this.leanZ.x + list, 'YXZ');
    hips.quaternion.setFromEuler(_eu);
    this._P.hips.copy(hips.position);
    this._Q.hips.copy(hips.quaternion);

    // Spine and chest carry the rest of the lean plus the counter-rotation.
    const spine = this.bone('spine');
    _eu.set(this.leanX.x * 0.30, -pelvisYaw * 0.55, this.leanZ.x * 0.4 - list * 0.4, 'YXZ');
    spine.quaternion.setFromEuler(_eu);
    fk(this._P.hips, this._Q.hips, REST.hips, REST.spine, spine.quaternion, this._P.spine, this._Q.spine);

    // Torso twist toward the aim, so a bot walking one way while watching
    // another is not a mannequin bolted to its hips.
    const twist = THREE.MathUtils.clamp(shortAngle((s.aimYaw ?? this.yaw) - this.yaw), -0.9, 0.9);
    const chest = this.bone('chest');
    _eu.set(
      this.leanX.x * 0.25 - aim * 0.05,
      -pelvisYaw * 0.9 + twist * 0.55 + aim * 0.16,
      this.leanZ.x * 0.3 - list * 0.3,
      'YXZ',
    );
    chest.quaternion.setFromEuler(_eu);
    fk(this._P.spine, this._Q.spine, REST.spine, REST.chest, chest.quaternion, this._P.chest, this._Q.chest);
    this._twist = twist;
  }

  // ------------------------------------------------------------------- legs

  _solveLegs(s, crouch) {
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (const f of this.feet) {
      const S = f.side < 0 ? 'L' : 'R';
      // Sole (world) -> ankle target (rig space). A raised heel pivots the
      // ankle up and forward over the ball of the foot.
      const wx = f.pos.x - s.pos.x, wz = f.pos.z - s.pos.z;
      const heel = f.heel || 0;
      const yawRel0 = shortAngle(f.plantYaw - this.yaw);
      _a.set(
        c * wx - sn * wz + Math.sin(yawRel0) * heel * 0.045,
        f.pos.y - s.pos.y + ANKLE_Y + heel * 0.088,
        sn * wx + c * wz + Math.cos(yawRel0) * heel * 0.045,
      );

      const thighRest = f.side < 0 ? REST.thighL : REST.thighR;
      _b.copy(thighRest).sub(REST.hips).applyQuaternion(this._Q.hips).add(this._P.hips);

      // Knee points forward, opened out in a crouch and rolled with the lean.
      _c.set(f.side * (0.20 + crouch * 0.42), 0.06, 1).normalize();
      solveTwoBone(_b, _a, LIMB.thigh, LIMB.shin, _c, _d, _e);

      const thigh = this.bone('thigh' + S);
      const shin = this.bone('shin' + S);
      const foot = this.bone('foot' + S);

      _f.copy(f.side < 0 ? REST.shinL : REST.shinR).sub(thighRest).normalize();
      _q0.setFromUnitVectors(_f, _d);                       // thigh, rig space
      _q1.copy(this._Q.hips).invert().multiply(_q0);
      thigh.quaternion.copy(_q1);

      _f.copy(f.side < 0 ? REST.footL : REST.footR)
        .sub(f.side < 0 ? REST.shinL : REST.shinR).normalize();
      _q2.setFromUnitVectors(_f, _e);                       // shin, rig space
      _q1.copy(_q0).invert().multiply(_q2);
      shin.quaternion.copy(_q1);

      // The ankle is solved in rig space, not relative to the shin, so the sole
      // stays flat on the ground whatever the leg is doing.
      const yawRel = shortAngle(f.plantYaw - this.yaw) * (f.swinging ? 1 - f.t : 1);
      _eu.set(f.pitch, yawRel, 0, 'YXZ');
      _q3.setFromEuler(_eu);
      _q1.copy(_q2).invert().multiply(_q3);
      foot.quaternion.copy(_q1);
      const toe = this.bone('toe' + S);
      _eu.set(Math.max(0, -f.pitch) * 0.8 + (f.swinging ? 0 : 0.02), 0, 0, 'YXZ');
      toe.quaternion.setFromEuler(_eu);
    }
  }

  // ------------------------------------------------- weapon, arms, head

  _solveUpper(s, dt, crouch, aim) {
    const speed = this.speedSmooth;
    const gait = this.phase * Math.PI * 2;
    const recoil = this.recoil.step(0, dt);

    // Aim direction in rig space.
    const hipDrop = this.hipSpring.x - s.pos.y -
      THREE.MathUtils.lerp(STANCE.stand.hip, STANCE.crouch.hip, crouch);
    const eyeY = THREE.MathUtils.lerp(STANCE.stand.eye, STANCE.crouch.eye, crouch) + hipDrop;
    _g.set(0, eyeY - 0.02, 0.06);                     // eye, rig space
    if (s.aimPoint) {
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      const wx = s.aimPoint.x - s.pos.x, wz = s.aimPoint.z - s.pos.z;
      _a.set(c * wx - sn * wz, s.aimPoint.y - s.pos.y, sn * wx + c * wz).sub(_g);
      if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
      _a.normalize();
    } else {
      _a.set(0, -0.05, 1).normalize();
    }
    const wantYaw = Math.atan2(_a.x, _a.z);
    const wantPitch = Math.asin(THREE.MathUtils.clamp(_a.y, -1, 1));
    this.aimYaw.step(THREE.MathUtils.clamp(wantYaw, -1.25, 1.25), dt);
    this.aimPitch.step(THREE.MathUtils.clamp(wantPitch, -0.85, 0.7), dt);
    const ay = this.aimYaw.x, ap = this.aimPitch.x;
    _a.set(Math.sin(ay) * Math.cos(ap), Math.sin(ap), Math.cos(ay) * Math.cos(ap));

    // ---- weapon placement -------------------------------------------------
    // Aimed: the sight sits a cheek-weld in front of the eye and the bore is
    // on the aim line, so the head, the optic and the shot all agree.
    // Low ready: the weapon drops and cants, muzzle down and out.
    lookQuat(_a, _q0);                                    // bore -> aim, rig space
    const bobY = Math.sin(gait * 2) * 0.010 * Math.min(speed / 3, 1);
    const bobX = Math.sin(gait) * 0.016 * Math.min(speed / 3, 1);

    _b.copy(_g).addScaledVector(_a, 0.235 - recoil * 0.06);   // sight target
    _b.x += 0.030 + bobX * 0.4;
    _b.y += bobY;
    _c.copy(SIGHT).applyQuaternion(_q0);
    _b.sub(_c);                                              // aimed weapon origin

    // Low-ready pose, in rig space: held across the body, muzzle down.
    _eu.set(-0.62 + ap * 0.35, ay * 0.55 - 0.16, 0.32, 'YXZ');
    _q1.setFromEuler(_eu);
    _d.set(0.150 + bobX, 1.150 - crouch * 0.19 + bobY, 0.180 - crouch * 0.02);
    _d.y += this.hipSpring.x - s.pos.y - STANCE.stand.hip;

    this._weaponP.lerpVectors(_d, _b, aim);
    this._weaponQ.copy(_q1).slerp(_q0, aim);
    // Recoil: straight back down the bore, with a muzzle rise.
    this._weaponP.addScaledVector(_a, -recoil * 0.055);
    _eu.set(-recoil * 0.22, 0, 0, 'YXZ');
    _q2.setFromEuler(_eu);
    this._weaponQ.multiply(_q2);

    const weapon = this.bone('weapon');
    _q3.copy(this._Q.chest).invert();
    weapon.position.copy(this._weaponP).sub(this._P.chest).applyQuaternion(_q3);
    weapon.quaternion.copy(_q3).multiply(this._weaponQ);

    // ---- head: eyes on the aim line --------------------------------------
    const headYaw = shortAngle(ay - this._twist * 0.55);
    const neck = this.bone('neck');
    const head = this.bone('head');
    _eu.set(ap * 0.30 - 0.02, headYaw * 0.38, 0, 'YXZ');
    neck.quaternion.setFromEuler(_eu);
    _eu.set(ap * 0.55 + aim * 0.10, headYaw * 0.62, aim * 0.13, 'YXZ');
    head.quaternion.setFromEuler(_eu);

    // ---- arms: hands onto the grips --------------------------------------
    this._solveArm('R', GRIP_R, aim, crouch);
    this._solveArm('L', GRIP_L, aim, crouch);
  }

  /**
   * Clavicle + two-bone arm IK onto a grip point on the weapon. The clavicle
   * protracts toward the target, which is both what a shoulder actually does
   * and what buys the support arm the ~5 cm of reach it needs to hold a
   * shouldered rifle without the elbow locking straight.
   */
  _solveArm(S, grip, aim, crouch) {
    const left = S === 'L';
    _a.copy(grip).applyQuaternion(this._weaponQ).add(this._weaponP);  // grip, rig

    const shoulderRest = left ? REST.shoulderL : REST.shoulderR;
    const armRest = left ? REST.armL : REST.armR;
    _b.copy(shoulderRest).sub(REST.chest).applyQuaternion(this._Q.chest).add(this._P.chest);

    // Protraction: swing the clavicle toward the grip, capped hard.
    _c.copy(_a).sub(_b);
    const reach = _c.length();
    const slack = THREE.MathUtils.clamp((reach - ARM_MAX * 0.82) / (ARM_MAX * 0.35), 0, 1);
    const prot = slack * (left ? 0.55 : 0.30) * (0.4 + aim * 0.6);
    const clav = this.bone('shoulder' + S);
    _eu.set(-slack * 0.12, left ? prot : -prot, left ? -prot * 0.35 : prot * 0.35, 'YXZ');
    clav.quaternion.setFromEuler(_eu);

    _q0.copy(this._Q.chest).multiply(clav.quaternion);               // clavicle, rig
    _b.copy(armRest).sub(shoulderRest).applyQuaternion(_q0);
    _d.copy(shoulderRest).sub(REST.chest).applyQuaternion(this._Q.chest).add(this._P.chest).add(_b);

    // Elbow points down, out and back — never up, which is the tell for a
    // naive IK arm.
    _c.set(left ? -0.75 : 0.75, -0.92, -0.45 + crouch * 0.1).normalize();
    solveTwoBone(_d, _a, LIMB.upperArm, LIMB.forearm, _c, _e, _f);

    const arm = this.bone('arm' + S);
    const fore = this.bone('forearm' + S);
    const hand = this.bone('hand' + S);
    _g.copy(left ? REST.forearmL : REST.forearmR).sub(armRest).normalize();
    _q1.setFromUnitVectors(_g, _e);
    _q2.copy(_q0).invert().multiply(_q1);
    arm.quaternion.copy(_q2);

    _g.copy(left ? REST.handL : REST.handR).sub(left ? REST.forearmL : REST.forearmR).normalize();
    _q2.setFromUnitVectors(_g, _f);
    _q3.copy(_q1).invert().multiply(_q2);
    fore.quaternion.copy(_q3);

    // Wrist: roll the hand onto the grip so the knuckles face the weapon.
    // Set outright rather than smoothed — a wrist that integrates its own
    // offset every frame walks off to a fixed point that is not the pose.
    _q3.copy(_q2).invert().multiply(this._weaponQ);
    _eu.set(left ? -0.35 : -0.5, 0, left ? 0.5 : -0.35, 'YXZ');
    _q1.setFromEuler(_eu);
    hand.quaternion.copy(_q3).multiply(_q1);
  }

  /** Kick the weapon on a shot. */
  fire(strength = 1) {
    this.recoil.x += 0.55 * strength;
    this.recoil.v += 5.5 * strength;
  }

  /** Muzzle position in world space (needs the pivot transform). */
  muzzleWorld(pos, yaw, muzzleLocal, out) {
    _a.copy(muzzleLocal).applyQuaternion(this._weaponQ).add(this._weaponP);
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    out.set(pos.x + c * _a.x + sn * _a.z, pos.y + _a.y, pos.z - sn * _a.x + c * _a.z);
    return out;
  }
}

// -------------------------------------------------------------------- helpers

/** True when `trigger` was crossed going forward between two phase samples. */
function crossed(now, before, trigger) {
  const a = before - Math.floor(before);
  const b = now - Math.floor(now);
  if (a <= b) return trigger > a && trigger <= b;
  return trigger > a || trigger <= b;   // wrapped
}

/** Forward kinematics for one bone with an unmodified rest offset. */
function fk(parentP, parentQ, parentRest, childRest, localQ, outP, outQ) {
  outP.copy(childRest).sub(parentRest).applyQuaternion(parentQ).add(parentP);
  outQ.copy(parentQ).multiply(localQ);
}

const _ik0 = new THREE.Vector3();
const _ik1 = new THREE.Vector3();
const _ik2 = new THREE.Vector3();
const _ikq = new THREE.Quaternion();

/**
 * Two-bone analytic IK. Writes unit directions for the upper and lower segment
 * into `outUpper` / `outLower`. Out-of-reach targets straighten the limb rather
 * than failing, which is both stable and what a real limb does.
 */
function solveTwoBone(root, target, l1, l2, pole, outUpper, outLower) {
  _ik0.copy(target).sub(root);
  let len = _ik0.length();
  if (len < 1e-5) { _ik0.set(0, -1, 0); len = 1; }
  _ik0.multiplyScalar(1 / len);
  const maxLen = (l1 + l2) * 0.999;
  const minLen = Math.abs(l1 - l2) * 1.001 + 1e-4;
  len = THREE.MathUtils.clamp(len, minLen, maxLen);

  const cosA = THREE.MathUtils.clamp((l1 * l1 + len * len - l2 * l2) / (2 * l1 * len), -1, 1);
  const alpha = Math.acos(cosA);

  _ik1.crossVectors(_ik0, pole);
  if (_ik1.lengthSq() < 1e-8) {
    _ik1.crossVectors(_ik0, Math.abs(_ik0.y) > 0.95 ? FWD : UP);
    if (_ik1.lengthSq() < 1e-8) _ik1.set(1, 0, 0);
  }
  _ik1.normalize();
  _ikq.setFromAxisAngle(_ik1, alpha);
  outUpper.copy(_ik0).applyQuaternion(_ikq).normalize();
  _ik2.copy(root).addScaledVector(outUpper, l1);
  outLower.copy(target).sub(_ik2);
  if (outLower.lengthSq() < 1e-8) outLower.copy(outUpper);
  outLower.normalize();
}

const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lm = new THREE.Matrix4();

/** Quaternion whose +Z axis is `dir`, with world up as the roll reference. */
function lookQuat(dir, out) {
  _lx.crossVectors(UP, dir);
  if (_lx.lengthSq() < 1e-6) _lx.set(1, 0, 0);
  _lx.normalize();
  _ly.crossVectors(dir, _lx);
  _lm.makeBasis(_lx, _ly, dir);
  return out.setFromRotationMatrix(_lm);
}
