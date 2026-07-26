import * as THREE from 'three';
import { buildAtlases, PT } from './Atlas.js';
import { ParticleField, resetSpec } from './ParticleField.js';
import { DepthCapture } from './DepthCapture.js';
import { Decals } from './Decals.js';
import { Tracers } from './Tracers.js';
import { Shells } from './Shells.js';
import { Impacts } from './Impacts.js';
import { Smoke } from './Smoke.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { Explosions } from './Explosions.js';

/**
 * Combat FX — impacts, tracers, muzzle flashes, smoke, explosions, decals,
 * shells, blood, screen shake.
 *
 * ## Draw-call budget
 * The entire FX layer is **five draw calls, and zero when nothing is
 * happening**: one alpha-blended lit particle field, one additive field, one
 * tracer ribbon batch, one decal batch and one instanced brass batch. Every one
 * of them drops its instance count to zero when its pool is empty, so an idle
 * frame costs nothing at all. A quarter-resolution depth snapshot is taken only
 * while soft particles are alive, only when the camera has moved, and with a
 * 95 m far plane so most of the street is culled out of it.
 *
 * ## Allocation
 * Nothing here allocates after `init()`. Particles are written through one
 * shared `SPEC` descriptor, physics bodies come from the physics pool, lights
 * from the lighting pool, and every vector is module scope.
 *
 * ## Screen shake
 * The player owns `ctx.camera`, so shake is applied as a delta in `lateUpdate`
 * — after the player has written the camera for the frame and before PostFX
 * renders it — and explicitly undone if nobody overwrote it. It is disabled
 * entirely while the harness holds `camera:override`, because a shaking
 * screenshot is a useless screenshot.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sunView = new THREE.Vector3();
const _col = new THREE.Color();
const DOWN = new THREE.Vector3(0, -1, 0);

/** Cheap deterministic 1-D noise, so shake never allocates or repeats visibly. */
function n1(t) {
  return Math.sin(t * 12.9898) * 0.5 + Math.sin(t * 5.233 + 1.7) * 0.32 + Math.sin(t * 27.61 + 4.1) * 0.18;
}

export class FXSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.time = 0;
    this.frozen = false;
    this.enabled = true;

    this.root = new THREE.Group();
    this.root.name = 'FX';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    const atlases = buildAtlases(ctx.renderer, ctx.quality);
    this.atlases = atlases;

    const tier = ctx.quality?.tier || 'high';
    const cap = tier === 'low' ? 0.45 : tier === 'medium' ? 0.7 : 1;

    this.lit = new ParticleField(atlases.particles, Math.round(1100 * cap), { lit: true });
    this.add = new ParticleField(atlases.particles, Math.round(760 * cap), { lit: false });
    this.tracers = new Tracers(72);
    this.decals = new Decals(ctx, atlases.decals, Math.round(320 * cap));
    this.shells = new Shells(ctx, Math.round(56 * cap));
    this.smoke = new Smoke(this.lit);
    this.impacts = new Impacts(ctx, this.lit, this.add, this.decals);
    this.muzzle = new MuzzleFlash(ctx, this.add, this.smoke);
    this.explosions = new Explosions(ctx, this.lit, this.add, this.smoke, this.decals, this);
    this.depth = new DepthCapture(ctx);

    this.root.add(this.decals.mesh, this.lit.mesh, this.add.mesh, this.tracers.mesh, this.shells.mesh);

    // Smoke shading gains. Physically these are albedo/pi and a hemisphere
    // integral; they are exposed because the only honest way to set them is to
    // look at a frame with smoke in it next to a reference.
    this.smokeSunGain = 0.34;
    this.smokeAmbientGain = 0.52;
    this.additiveGain = 1.0;

    // Screen shake state.
    this.trauma = 0;
    this.traumaDecay = 1.6;
    this._shakeActive = false;
    this._basePos = new THREE.Vector3();
    this._baseQuat = new THREE.Quaternion();
    this._lastPos = new THREE.Vector3();
    this._lastQuat = new THREE.Quaternion();
    this._override = false;

    this._tracerCounter = 0;
    this.tracerEvery = 3;

    this._stageArmed = false;
    this._stagePending = 0;
    this._staged = false;

    ctx.bus?.on('camera:override', (v) => this._onOverride(!!v));
    // The lighting system already pulses on `weapon:fired`; remember the frame
    // so `muzzleFlash()` does not stack a second light on top of it.
    ctx.bus?.on('weapon:fired', () => { this.muzzle.externalLightFrame = this.muzzle.frame; });

    const self = this;
    ctx.fx = {
      impact: (point, normal, surfaceKey, energy) => self.impact(point, normal, surfaceKey, energy),
      decal: (point, normal, kind, size) => self.decals.add(point, normal, kind, size),
      tracer: (from, to, speed, opts) => self.tracer(from, to, speed, opts),
      muzzleFlash: (worldMatrix, scale, opts) => self.muzzleFlash(worldMatrix, scale, opts),
      shellEject: (worldMatrix, velocity, caliber) => self.shells.eject(worldMatrix, velocity, caliber),
      smoke: (pos, opts) => self.smokeAt(pos, opts),
      explosion: (pos, radius, opts) => self.explosions.explode(pos, radius, opts),
      bloodHit: (pos, normal, dir, energy) => self.impacts.bloodHit(pos, normal, dir, energy),
      screenShake: (amount, duration) => self.screenShake(amount, duration),
      hitmarker: (kind) => self.hitmarker(kind),

      // --- extras beyond the contract, all optional to call ------------------
      dustPuff: (pos, opts) => self.smoke.puff(pos, opts),
      smokeColumn: (pos, opts) => self.smoke.column(pos, opts),
      clear: () => self.clearAll(),
      setEnabled: (v) => { self.enabled = !!v; self.root.visible = !!v; },
      get stats() {
        return {
          lit: self.lit.used, additive: self.add.used, decals: self.decals.count,
          shells: self.shells.live, depthDraws: self.depth.lastDrawCalls,
        };
      },
      tune: (k, v) => { if (k in self) self[k] = v; },
    };

    this._installAutomation();
  }

  // ------------------------------------------------------------------- public

  impact(point, normal, surfaceKey, energy) {
    if (!point) return;
    this.impacts.impact(point, normal, surfaceKey, energy);
  }

  /**
   * Roughly one round in three is lit, like a real belt mix. Pass
   * `{ force: true }` for a guaranteed tracer.
   */
  tracer(from, to, speed = 880, opts) {
    if (!from || !to) return -1;
    this._tracerCounter++;
    if (!opts?.force && this.tracerEvery > 1 && this._tracerCounter % this.tracerEvery !== 0) return -1;
    return this.tracers.fire(from, to, speed, opts);
  }

  muzzleFlash(worldMatrix, scale, opts) {
    this.muzzle.flash(worldMatrix, scale, opts);
  }

  smokeAt(pos, opts) {
    if (!pos) return null;
    if (opts?.column) return this.smoke.column(pos, opts);
    if (opts?.haze) return this.smoke.haze(pos, opts);
    this.smoke.puff(pos, opts);
    return null;
  }

  screenShake(amount = 0.4, duration = 0.4) {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
    this.traumaDecay = 1 / Math.max(0.08, duration);
  }

  hitmarker(kind = 'hit') {
    const hud = this.ctx.hud;
    if (hud?.hitmarker) hud.hitmarker(kind);
    else if (hud?.crosshair?.hitmarker) hud.crosshair.hitmarker(kind);
    else this.ctx.bus?.emit?.('fx:hitmarker', kind);
    this.ctx.audio?.play?.(kind === 'kill' ? 'hitmarker_kill' : 'hitmarker', { gain: 0.6 });
  }

  clearAll() {
    this.lit.clear();
    this.add.clear();
    this.tracers.clear();
    this.smoke.clear();
    this.shells.clear();
    this.muzzle.releaseStaticLights();
    this.trauma = 0;
  }

  // ------------------------------------------------------------------- update

  update(dt, ctx) {
    if (!this.enabled) return;
    const step = this.frozen ? 0 : Math.min(dt, 0.1);
    this.time += step;

    this.smoke.update(step);
    this.muzzle.update(step);

    this.lit.update(this.time);
    this.add.update(this.time);
    this.tracers.update(this.time);
    this.decals.update(this.time);
    this.shells.update();

    this._pushLighting(ctx);

    if (this._stagePending > 0 && --this._stagePending === 0) this._buildStage();
  }

  lateUpdate(dt, ctx) {
    if (!this.enabled) return;

    // Soft particles need geometry depth; take the snapshot only when there is
    // something to soften.
    const wantDepth = this.lit.alive || this.add.alive;
    const tex = wantDepth ? this.depth.capture(this.root) : null;
    this.lit.setDepth(tex);
    this.add.setDepth(tex);

    this._applyShake(dt, ctx);
  }

  _pushLighting(ctx) {
    const lighting = ctx.lighting;
    const sky = ctx.sky;
    const cam = ctx.camera;
    if (!cam) return;

    const sunDir = lighting?.sunDirection || sky?.sunDirection;
    if (sunDir) _v.copy(sunDir); else _v.set(0.3, 0.8, 0.2);
    if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
    _sunView.copy(_v).transformDirection(cam.matrixWorldInverse).normalize();

    const key = lighting?.keyIntensity ?? 3;
    if (sky?.sunColor) _col.copy(sky.sunColor); else _col.setRGB(1, 0.95, 0.86);
    const u = this.lit.uniforms;
    u.uSunDirView.value.copy(_sunView);
    u.uSunColor.value.setRGB(
      _col.r * key * this.smokeSunGain,
      _col.g * key * this.smokeSunGain,
      _col.b * key * this.smokeSunGain,
    );
    if (sky?.skyColor) _col.copy(sky.skyColor); else _col.setRGB(0.35, 0.45, 0.62);
    const ag = this.smokeAmbientGain;
    u.uAmbient.value.setRGB(_col.r * ag, _col.g * ag, _col.b * ag);
    // Ground bounce: warm, a third of the sky, so a puff has a dark warm belly
    // instead of being uniformly blue-filled from every direction.
    const gg = ag * 0.30 * (0.25 + 0.75 * Math.max(0, Math.min(1, key * 0.05)));
    u.uGround.value.setRGB(
      (_col.r * 0.5 + 0.42) * gg, (_col.g * 0.5 + 0.34) * gg, (_col.b * 0.5 + 0.26) * gg,
    );
    u.uUpView.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    this.add.uniforms.uGain.value = this.additiveGain;
  }

  _applyShake(dt, ctx) {
    const cam = ctx.camera;
    if (!cam) return;

    // Undo last frame's shake if nothing else moved the camera since.
    if (this._shakeActive &&
      cam.position.equals(this._lastPos) &&
      Math.abs(cam.quaternion.dot(this._lastQuat)) > 0.9999999) {
      cam.position.copy(this._basePos);
      cam.quaternion.copy(this._baseQuat);
    }
    this._shakeActive = false;

    if (this.trauma > 0 && !this.frozen) this.trauma = Math.max(0, this.trauma - dt * this.traumaDecay);
    if (this._override || this.frozen || this.trauma <= 0.001) return;

    this._basePos.copy(cam.position);
    this._baseQuat.copy(cam.quaternion);

    const s = this.trauma * this.trauma;
    const t = this.time * 26;
    _e.set(s * 0.055 * n1(t), s * 0.048 * n1(t + 31.7), s * 0.070 * n1(t + 71.3), 'XYZ');
    _q.setFromEuler(_e);
    cam.quaternion.multiply(_q);

    _v3.set(s * 0.035 * n1(t + 11.1), s * 0.030 * n1(t + 53.9), s * 0.014 * n1(t + 91.5));
    _v3.applyQuaternion(cam.quaternion);
    cam.position.add(_v3);
    cam.updateMatrixWorld(true);

    this._lastPos.copy(cam.position);
    this._lastQuat.copy(cam.quaternion);
    this._shakeActive = true;
  }

  dispose() {
    this.clearAll();
    this.lit.dispose();
    this.add.dispose();
    this.tracers.dispose();
    this.decals.dispose();
    this.shells.dispose();
    this.depth.dispose();
    this.atlases?.dispose?.();
    this.root.parent?.remove(this.root);
  }

  // -------------------------------------------------------------------- stage

  _onOverride(active) {
    this._override = active;
    if (!active) { this.clearStage(); return; }
    if (this._stageArmed) {
      this._stageArmed = false;
      // Build one frame later: `setCamera` emits before the camera's world
      // matrix has been refreshed, and the tableau is laid out with raycasts
      // from that camera.
      this._stagePending = 2;
    } else if (this._staged || this._stagePending) {
      this.clearStage();
    }
  }

  clearStage() {
    this._stagePending = 0;
    this.frozen = false;
    if (!this._staged) return;
    this._staged = false;
    this.lit.clear();
    this.add.clear();
    this.tracers.clear();
    this.smoke.clear();
    this.shells.clear();
    this.muzzle.releaseStaticLights();
  }

  /** Runs `fn` as if it had happened `age` seconds ago. */
  _at(age, fn) {
    const t = this.time;
    this.lit.time = t - age;
    this.add.time = t - age;
    fn();
    this.lit.time = t;
    this.add.time = t;
  }

  /** Raycast from the camera along a yaw/pitch offset from its forward axis. */
  _probe(cam, yawDeg, pitchDeg, maxDist, out) {
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const y = yawDeg * Math.PI / 180;
    const p = pitchDeg * Math.PI / 180;
    _v.copy(_fwd).multiplyScalar(Math.cos(y) * Math.cos(p))
      .addScaledVector(_right, Math.sin(y) * Math.cos(p))
      .addScaledVector(_up, Math.sin(p))
      .normalize();
    const hit = this.ctx.physics?.raycast?.(cam.position, _v, maxDist, 1 | 2);
    if (hit) {
      out.point.copy(hit.point);
      out.normal.copy(hit.normal);
      out.distance = hit.distance;
      out.material = hit.material;
      out.hit = true;
    } else {
      out.point.copy(cam.position).addScaledVector(_v, maxDist * 0.6);
      out.normal.copy(_v).multiplyScalar(-1);
      out.distance = maxDist * 0.6;
      out.material = null;
      out.hit = false;
    }
    return out;
  }

  /**
   * Freezes a firefight: rounds mid-flight, a wall being chewed up, an enemy
   * muzzle lit, brass in the air, a smoke column that has been burning for
   * seconds and low dust hanging in the sun.
   *
   * Everything is placed by raycasting from the shot camera, so it lands on
   * whatever geometry the level actually has rather than on hardcoded
   * coordinates that rot the moment the level changes.
   */
  _buildStage() {
    const ctx = this.ctx;
    const cam = ctx.camera;
    if (!cam) return;
    cam.updateMatrixWorld(true);
    this.clearStage();
    this._staged = true;

    const A = _stageHitA;
    const B = _stageHitB;
    const G = _stageHitG;

    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const camPos = cam.position;

    // --- the wall taking fire ------------------------------------------------
    this._probe(cam, -21, 2.5, 55, A);
    this._probe(cam, -14, -1.0, 55, B);
    this._probe(cam, 4, -14, 24, G);
    // `_probe` clobbers the basis vectors; restore them.
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    // Scars: this wall has been shot at for a while, not just now.
    if (A.hit) {
      for (let i = 0; i < 9; i++) {
        _v2.set(0, 1, 0).cross(A.normal);
        if (_v2.lengthSq() < 1e-6) _v2.set(1, 0, 0);
        _v2.normalize();
        _p.copy(A.normal).cross(_v2).normalize();
        _v.copy(A.point)
          .addScaledVector(_v2, (Math.random() - 0.5) * 1.7)
          .addScaledVector(_p, (Math.random() - 0.5) * 1.3);
        this.decals.add(_v, A.normal, 'bullet_concrete', 0.16 + Math.random() * 0.14, 1);
      }
      this.decals.add(A.point, A.normal, 'spall', 1.1, 0.7);
    }

    // Two fresh impacts at different ages so the dust has structure.
    if (A.hit) this._at(0.30, () => this.impacts.impact(A.point, A.normal, A.material || 'concrete_wall', 1.7));
    if (B.hit) this._at(0.08, () => this.impacts.impact(B.point, B.normal, B.material || 'concrete_wall', 2.1));
    if (G.hit) this._at(0.18, () => this.impacts.impact(G.point, G.normal, G.material || 'asphalt', 1.4));

    // --- enemy positions and muzzle flash ------------------------------------
    _v.copy(camPos).addScaledVector(_fwd, 15).addScaledVector(_right, -2.9);
    _v.y = camPos.y - 0.28;
    _v2.copy(_v).sub(camPos);
    const dist = Math.max(1e-3, _v2.length());
    _v2.multiplyScalar(1 / dist);
    const blocked = ctx.physics?.raycast?.(camPos, _v2, dist, 1 | 2);
    if (blocked) _v.copy(camPos).addScaledVector(_v2, Math.max(6, blocked.distance * 0.70));
    const enemy = _stageEnemy.copy(_v);

    _v2.copy(camPos).sub(enemy).normalize();
    this._at(0.012, () => this.muzzle.flash(enemy, 1.6, { dir: _v2, persist: 5.0 }));

    // A second shooter further back and to the other side.
    _v.copy(camPos).addScaledVector(_fwd, 25).addScaledVector(_right, 4.2);
    _v.y = camPos.y - 0.42;
    _v2.copy(_v).sub(camPos);
    const d2 = Math.max(1e-3, _v2.length());
    _v2.multiplyScalar(1 / d2);
    const blocked2 = ctx.physics?.raycast?.(camPos, _v2, d2, 1 | 2);
    if (blocked2) _v.copy(camPos).addScaledVector(_v2, Math.max(9, blocked2.distance * 0.7));
    const far = _stageEnemy2.copy(_v);
    _v2.copy(camPos).sub(far).normalize();
    this._at(0.02, () => this.muzzle.flash(far, 1.0, { dir: _v2, persist: 5.0, light: false }));

    // --- rounds in flight -----------------------------------------------------
    _p.copy(camPos).addScaledVector(_right, 1.5).addScaledVector(_up, 0.25).addScaledVector(_fwd, -3);
    this.tracers.fire(enemy, _p, 880, { age: 0.0165, width: 0.05, intensity: 7.5 });

    _p.copy(camPos).addScaledVector(_right, -1.1).addScaledVector(_up, -0.55).addScaledVector(_fwd, -2);
    this.tracers.fire(far, _p, 900, { age: 0.030, width: 0.045, intensity: 6.0 });

    if (A.hit) {
      _p.copy(camPos).addScaledVector(_right, 0.20).addScaledVector(_up, -0.10).addScaledVector(_fwd, 0.62);
      this.tracers.fire(_p, A.point, 900, {
        age: (A.distance / 900) * 0.42, width: 0.045, intensity: 8.5,
        color: [1.0, 0.86, 0.45],
      });
    }
    // A third, high and crossing, so the rounds are not all parallel.
    _v.copy(camPos).addScaledVector(_fwd, 30).addScaledVector(_right, -9).addScaledVector(_up, 2.2);
    _p.copy(camPos).addScaledVector(_right, 6).addScaledVector(_up, 1.6).addScaledVector(_fwd, 4);
    this.tracers.fire(_v, _p, 850, { age: 0.019, width: 0.038, intensity: 5.0 });

    // --- brass in the air ------------------------------------------------------
    for (let i = 0; i < 5; i++) {
      const f = i / 4;
      _p.copy(camPos)
        .addScaledVector(_right, 0.16 + f * 0.62)
        .addScaledVector(_up, -0.06 + f * 0.46 - f * f * 0.40)
        .addScaledVector(_fwd, 0.52 - f * 0.14);
      _e.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      _q2.setFromEuler(_e);
      this.shells.place(_p, _q2, 'rifle');
    }

    // --- environment: burning column, hanging dust, scorch ---------------------
    _v.copy(camPos).addScaledVector(_fwd, 27).addScaledVector(_right, 6.5);
    _v.y = camPos.y + 3;
    const groundHit = ctx.physics?.raycast?.(_v, DOWN, 12, 1 | 2);
    if (groundHit) {
      _p.copy(groundHit.point);
      const col = this.smoke.column(_p, {
        rate: 8, duration: 60, radius: 0.35, rise: 2.1, spread: 0.30,
        size0: 0.45, size1: 2.5, life: 4.2, alpha: 0.55, lifeVar: 0.5,
        drag: 0.5, gravity: 0.34, turb: 0.62, fadeOut: 0.45,
        r0: 0.055, g0: 0.050, b0: 0.046, r1: 0.40, g1: 0.385, b1: 0.365,
      });
      this.smoke.prime(col, 4.6, 32);
      this.decals.add(_p, groundHit.normal, 'scorch', 3.4, 0.85);
      this.decals.add(_p, groundHit.normal, 'oil', 1.6, 0.6);
    }

    // Low haze drifting across the middle of the street, primed so it is
    // already spread out rather than emerging from a point.
    _v.copy(camPos).addScaledVector(_fwd, 15).addScaledVector(_right, -1.5);
    _v.y = camPos.y - 0.9;
    const haze = this.smoke.haze(_v, { rate: 3, duration: 60, radius: 3.4, alpha: 0.055, life: 10, size1: 3.2 });
    this.smoke.prime(haze, 9, 26);

    // Airborne motes catching the sun — what makes a lit volume read as air.
    for (let i = 0; i < 14; i++) {
      const d = 2.5 + Math.random() * 20;
      _p.copy(camPos)
        .addScaledVector(_fwd, d)
        .addScaledVector(_right, (Math.random() - 0.5) * d * 0.55)
        .addScaledVector(_up, (Math.random() - 0.35) * d * 0.22);
      const px = _p.x, py = _p.y, pz = _p.z;
      const size = 0.012 + Math.random() * 0.05 * (d / 12);
      this._at(2 + Math.random() * 6, () => {
        const s = resetSpec();
        s.x = px; s.y = py; s.z = pz;
        s.vx = (Math.random() - 0.5) * 0.12;
        s.vy = (Math.random() - 0.3) * 0.08;
        s.vz = (Math.random() - 0.5) * 0.12;
        s.life = 30; s.drag = 0.2; s.gravity = 0.005; s.turb = 0.02;
        s.size0 = size; s.size1 = size * 1.3;
        s.tile = PT.SOFT; s.soft = 0.4;
        s.r0 = 0.72; s.g0 = 0.69; s.b0 = 0.62;
        s.r1 = 0.72; s.g1 = 0.69; s.b1 = 0.62;
        s.a0 = 0.20; s.a1 = 0.20;
        s.fadeIn = 0.02; s.fadeOut = 0.1;
        this.lit.spawn(s);
      });
    }

    // Settle one update so every field has uploaded, then stop the clock.
    this.lit.update(this.time);
    this.add.update(this.time);
    this.tracers.update(this.time);
    this.shells.update();
    this.frozen = true;
  }

  // ---------------------------------------------------------------- automation

  _installAutomation() {
    const api = (window.__COD__ = window.__COD__ || {});
    const self = this;

    // `stageCombat` is shared with the AI agent (bots) — chain rather than
    // clobber, whichever order the two systems install in.
    const install = () => {
      const prev = api.stageCombat;
      if (prev && prev.__fx) return;
      const wrapped = function stageCombat(...args) {
        let r;
        try { r = prev?.apply(this, args); } catch (e) { console.warn('FX: upstream stageCombat threw', e); }
        self._stageArmed = true;
        return r;
      };
      wrapped.__fx = true;
      api.stageCombat = wrapped;
    };
    install();
    this.ctx.bus?.on('engine:ready', install);

    api.fx = {
      explode: (r = 6) => {
        const cam = self.ctx.camera;
        _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
        _v.copy(cam.position).addScaledVector(_fwd, 9);
        _v.y = Math.max(0.4, _v.y - 1.2);
        self.explosions.explode(_v, r);
      },
      shoot: (n = 1) => {
        const cam = self.ctx.camera;
        _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
        for (let i = 0; i < n; i++) {
          const hit = self.ctx.physics?.raycast?.(cam.position, _fwd, 120, 1 | 2);
          if (hit) {
            self.impact(hit.point, hit.normal, hit.material, 1.4);
            self.tracer(cam.position, hit.point, 880, { force: true });
          }
        }
      },
      shake: (a = 0.7, d = 0.6) => self.screenShake(a, d),
      clear: () => self.clearAll(),
      unfreeze: () => { self.frozen = false; },
      stage: () => { self._stageArmed = true; self._stagePending = 2; },
      get stats() { return self.ctx.fx.stats; },
    };
  }
}

const _stageEnemy = new THREE.Vector3();
const _stageEnemy2 = new THREE.Vector3();
const makeHit = () => ({
  point: new THREE.Vector3(), normal: new THREE.Vector3(),
  distance: 0, material: null, hit: false,
});
const _stageHitA = makeHit();
const _stageHitB = makeHit();
const _stageHitG = makeHit();
