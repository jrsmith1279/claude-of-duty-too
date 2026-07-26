import * as THREE from 'three';
import { Ephemeris } from './sky/Ephemeris.js';
import { AtmosphereLUT } from './sky/AtmosphereLUT.js';
import { CloudCache } from './sky/CloudCache.js';
import { NoiseVolume } from './sky/NoiseVolume.js';
import { SkyDome } from './sky/SkyDome.js';
import { installAerialPerspective, AP } from './sky/AerialPerspective.js';
import {
  SKY_EXPOSURE, MOON_SCATTER_LIFT, CLOUD_SUN_GAIN, MAX_DISK_RADIANCE,
  SOLAR_SPECTRUM, SUN_ANGULAR_RADIUS,
} from './sky/constants.js';

// Fog chunks must be patched before any material compiles, so this runs at
// import time rather than in init().
installAerialPerspective();

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _cMoon = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

const TIERS = {
  low: { lut: [192, 96], cloud: [512, 256], slices: 16, cube: 96, noise: 64 },
  medium: { lut: [256, 128], cloud: [768, 384], slices: 14, cube: 128, noise: 96 },
  high: { lut: [320, 160], cloud: [1024, 512], slices: 12, cube: 192, noise: 128 },
  ultra: { lut: [384, 192], cloud: [1280, 640], slices: 12, cube: 256, noise: 128 },
};

/**
 * Physically based sky, atmosphere, clouds and image-based lighting.
 *
 * Three caches, each amortised so no single frame pays for all of it:
 *  - an equirect inscattering LUT (Rayleigh + Mie + ozone, sun *and* moon in one
 *    MRT raymarch) rebuilt only when a body actually moves,
 *  - an equirect volumetric cloud map, one horizontal band per frame,
 *  - a PMREM environment probe, throttled to 0.5 s and a 0.6 degree sun step.
 *
 * The dome shader itself is two texture fetches plus the analytic pieces that
 * must stay sharp: the Mie aureole, the limb-darkened sun disk, the lunar
 * terminator and the star field.
 */
export class SkySystem {
  constructor() {
    this.t01 = 0.32;
    this._dirty = true;
    this._firstFrame = true;
    this._envTimer = 0;
    this._envSunDir = new THREE.Vector3(0, -1, 0);
    this._lutSunDir = new THREE.Vector3(0, -1, 0);
    this._time = 0;
    this._cloudPhase = 0;
    this._lastFullCloud = -10;
    this.coverage = 0.60;
    this.windSpeed = 1.0;
  }

  async init(ctx) {
    this.ctx = ctx;
    const tier = TIERS[ctx.quality?.tier] || TIERS.high;
    this.tier = tier;

    this.eph = new Ephemeris();
    this.lut = new AtmosphereLUT(tier.lut[0], tier.lut[1]);
    this.clouds = new CloudCache(tier.cloud[0], tier.cloud[1], tier.slices);
    this.noise = new NoiseVolume(tier.noise, 512);
    this.dome = new SkyDome();

    const u = this.dome.uniforms;
    u.uSunLut.value = this.lut.sunTexture;
    u.uMoonLut.value = this.lut.moonTexture;
    u.uCloudMap.value = this.clouds.texture;
    this.clouds.material.uniforms.uNoiseVol.value = this.noise.volume;
    this.clouds.material.uniforms.uWeather.value = this.noise.weather;

    ctx.scene.add(this.dome.mesh);

    // Height fog: the fallback colour matters only for materials that miss the
    // shared uniform; the real work happens in the patched chunk.
    this.fog = new THREE.FogExp2(0x8fa8c0, 0.0045);
    ctx.scene.fog = this.fog;
    AP.enabled = true;
    AP.density = 0.0052;
    AP.heightFalloff = 0.011;
    AP.maxOpacity = 0.85;
    AP.anisotropy = 0.62;
    AP.startDistance = 3;
    AP.referenceHeight = 0;
    AP.groundFalloff = 0.40;

    this.cubeTarget = new THREE.WebGLCubeRenderTarget(tier.cube, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.cubeCamera = new THREE.CubeCamera(1, 4000, this.cubeTarget);
    this.pmrem = null;
    this.pmremTarget = null;

    /** @type {THREE.Color} */
    this.skyColor = new THREE.Color(0.4, 0.55, 0.8);
    this.horizonColor = new THREE.Color(0.6, 0.66, 0.75);
    this.groundColor = new THREE.Color(0.1, 0.1, 0.1);

    ctx.sky = {
      setTimeOfDay: (t) => this.setTimeOfDay(t),
      get timeOfDay() { return this.__sys.t01; },
      sunDirection: this.eph.sunDirection,
      moonDirection: this.eph.moonDirection,
      sunColor: this.eph.sunColor,
      moonColor: this.eph.moonColor,
      skyColor: this.skyColor,
      horizonColor: this.horizonColor,
      groundColor: this.groundColor,
      intensity: 1,
      sunIntensity: 1,
      moonIntensity: 0,
      moonPhase: 0.5,
      envMap: null,
      cubeMap: this.cubeTarget.texture,
      /** Aerial perspective parameters, live. Materials/postfx may read these. */
      aerial: AP,
      fog: this.fog,
      exposure: SKY_EXPOSURE,
      /**
       * Physically motivated print exposure. A real night is ~10 stops under
       * daylight; a graded film night is printed 2-3 stops up, never matched to
       * daylight. Auto-exposure should clamp against this or the moon-lit sky
       * comes back as a blue midday.
       */
      exposureScale: 1,
      /** Linear HDR sky radiance in a world direction (CPU, allocation free). */
      sample: (dir, target) => this._sampleRadiance(dir, target),
      setCoverage: (v) => { this.coverage = THREE.MathUtils.clamp(v, 0, 1); this._dirty = true; },
      setWindSpeed: (v) => { this.windSpeed = Math.max(0, v); },
      __sys: this,
    };

    // The placeholder lighting system reads ctx.sun during its own init.
    ctx.sun = this.eph.sunDirection;

    ctx.bus?.on('sky:timeOfDay', (t) => this.setTimeOfDay(t));

    this.setTimeOfDay(this.t01);
    this._applyUniforms();
  }

  setTimeOfDay(t01) {
    if (typeof t01 !== 'number' || !Number.isFinite(t01)) return;
    this.t01 = ((t01 % 1) + 1) % 1;
    this._dirty = true;
    this._applyUniforms();
  }

  /** Recompute every CPU-side quantity the shaders and other systems consume. */
  _applyUniforms() {
    const eph = this.eph.setTimeOfDay(this.t01);
    const u = this.dome.uniforms;
    const cu = this.clouds.material.uniforms;

    u.uSunDir.value.copy(eph.sunDirection);
    u.uMoonDir.value.copy(eph.moonDirection);
    u.uStarRot.value.copy(eph.starRotation);

    const scatter = SKY_EXPOSURE;
    u.uSunScatter.value.set(
      SOLAR_SPECTRUM[0] * scatter, SOLAR_SPECTRUM[1] * scatter, SOLAR_SPECTRUM[2] * scatter,
    );

    // Night ramp: stars and the moon-lit sky come up through civil twilight.
    const night = THREE.MathUtils.clamp(smoothstep(0.045, -0.075, eph.sunDirection.y), 0, 1);
    u.uNight.value = night;

    const moonUp = THREE.MathUtils.clamp((eph.moonDirection.y + 0.02) / 0.08, 0, 1);
    const moonGain = eph.moonIntensity * MOON_SCATTER_LIFT * night * moonUp * scatter;
    u.uMoonScatter.value.set(
      eph.moonColor.r * moonGain, eph.moonColor.g * moonGain, eph.moonColor.b * moonGain,
    );

    // Mie tint: the aureole reddens because the light reaching the haze near the
    // observer has already been through the same slant path as the disk.
    u.uSunMieTint.value.set(eph.sunTransmittance.r, eph.sunTransmittance.g, eph.sunTransmittance.b);
    u.uMoonMieTint.value.set(
      eph.moonTransmittance.r * 0.85, eph.moonTransmittance.g * 0.92, eph.moonTransmittance.b,
    );

    // Sun disk: irradiance over the 6.8e-5 sr solid angle, capped so a half
    // float bloom buffer can never see an infinity.
    const solidAngle = Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS;
    let dr = eph.sunIrradiance.r / solidAngle * scatter;
    let dg = eph.sunIrradiance.g / solidAngle * scatter;
    let db = eph.sunIrradiance.b / solidAngle * scatter;
    const dmax = Math.max(dr, dg, db, 1e-6);
    if (dmax > MAX_DISK_RADIANCE) {
      const k = MAX_DISK_RADIANCE / dmax;
      dr *= k; dg *= k; db *= k;
    }
    u.uSunRadiance.value.set(dr, dg, db);
    u.uSunGlare.value.set(
      eph.sunIrradiance.r * scatter, eph.sunIrradiance.g * scatter, eph.sunIrradiance.b * scatter,
    );

    // Moon surface: lit by the unattenuated sun, then dimmed by our own air.
    const mt = eph.moonTransmittance;
    const moonVis = moonUp * (0.25 + 0.75 * night);
    const ms = 0.42 * scatter * moonVis;
    u.uMoonSurface.value.set(
      SOLAR_SPECTRUM[0] * mt.r * ms, SOLAR_SPECTRUM[1] * mt.g * ms, SOLAR_SPECTRUM[2] * mt.b * ms,
    );
    u.uEarthshine.value.set(
      0.020 * scatter * moonVis * 0.7, 0.024 * scatter * moonVis * 0.8, 0.034 * scatter * moonVis,
    );

    // Airglow (557.7 nm dominant) and sodium light pollution from the city.
    u.uAirglow.value.set(0.00055 * night, 0.00090 * night, 0.00110 * night);
    u.uPollution.value.set(0.0115 * night, 0.0061 * night, 0.0024 * night);
    u.uStarBrightness.value = 1.0;
    u.uMoonSize.value = 2.0;

    // Ambient colours. Sampled from the same integral the dome uses, so the
    // clouds, the fog and the sky are lit by one consistent model.
    this._sampleRadiance(_up, this.skyColor);
    _v.set(eph.sunDirection.x, 0.06, eph.sunDirection.z);
    if (_v.lengthSq() < 1e-6) _v.set(1, 0.06, 0);
    _v.normalize();
    this._sampleRadiance(_v, this.horizonColor);
    _v2.set(-eph.sunDirection.x, 0.10, -eph.sunDirection.z).normalize();
    this._sampleRadiance(_v2, _c3);
    this.horizonColor.lerp(_c3, 0.35);
    this.groundColor.copy(this.horizonColor).multiplyScalar(0.22);

    // Clouds sit at 3 km so they see a shorter slant path than the ground does,
    // but at a grazing sun that path is still nearly as long — hence the ramp.
    const cExp = THREE.MathUtils.lerp(0.92, 0.42, THREE.MathUtils.clamp(eph.sunDirection.y * 3.2, 0, 1));
    const cloudT = Math.pow(Math.max(eph.sunTransmittance.r, 1e-4), cExp);
    const cloudTg = Math.pow(Math.max(eph.sunTransmittance.g, 1e-4), cExp);
    const cloudTb = Math.pow(Math.max(eph.sunTransmittance.b, 1e-4), cExp);
    const cg = CLOUD_SUN_GAIN * scatter;
    cu.uSunDir.value.copy(eph.sunDirection);
    cu.uMoonDir.value.copy(eph.moonDirection);
    cu.uSunLight.value.set(
      SOLAR_SPECTRUM[0] * cloudT * cg, SOLAR_SPECTRUM[1] * cloudTg * cg, SOLAR_SPECTRUM[2] * cloudTb * cg,
    );
    const cml = eph.moonIntensity * MOON_SCATTER_LIFT * 0.20 * night * moonUp * scatter * CLOUD_SUN_GAIN;
    cu.uMoonLight.value.set(eph.moonColor.r * cml, eph.moonColor.g * cml, eph.moonColor.b * cml);
    cu.uSkyTop.value.set(this.skyColor.r, this.skyColor.g, this.skyColor.b);
    cu.uSkyBottom.value.set(this.groundColor.r, this.groundColor.g, this.groundColor.b);
    cu.uHaze.value.set(this.horizonColor.r, this.horizonColor.g, this.horizonColor.b);
    cu.uCloudCoverage.value = this.coverage;
    cu.uCloudDensity.value = 1.0;
    cu.uCirrusAmount.value = this.ctx?.quality?.tier === 'low' ? 0.0 : 0.34;

    // Aerial perspective feed.
    AP.setSunDir(eph.sunDirection);
    _c.copy(this.horizonColor).multiplyScalar(0.82);
    _c.r += u.uPollution.value.x * 0.75;
    _c.g += u.uPollution.value.y * 0.75;
    _c.b += u.uPollution.value.z * 0.75;
    AP.setAmbientColor(_c);
    const inscatter = 0.0095 * scatter;
    _c2.setRGB(
      eph.sunIrradiance.r * inscatter, eph.sunIrradiance.g * inscatter, eph.sunIrradiance.b * inscatter,
    );
    AP.setSunColor(_c2);
    // Zenith end of the inscatter gradient. Slightly muted from the true dome
    // radiance so haze against sky still separates from the sky itself.
    _c.copy(this.skyColor).multiplyScalar(0.90);
    AP.setZenithColor(_c);
    // ART_DIRECTION.md wants heavy airborne dust: visibly desaturated and
    // lifted blacks past 40 m. At 0.0052/m that is ~19% opacity at 40 m, ~30%
    // at 70 m (the market street's long sightline) and ~0.6 at 200 m, which
    // reads as three depth planes without erasing the far one.
    AP.density = 0.00520 + 0.00230 * (1 - eph.intensity);
    AP.heightFalloff = 0.011;

    // Fallback colour for anything that misses the shared uniform.
    this.fog.color.setRGB(
      Math.min(this.horizonColor.r, 1), Math.min(this.horizonColor.g, 1), Math.min(this.horizonColor.b, 1),
    );
    this.fog.density = 0.0045;

    const api = this.ctx?.sky;
    if (api) {
      api.intensity = eph.intensity;
      api.exposureScale = THREE.MathUtils.lerp(2.6, 1.0, eph.intensity);
      api.sunIntensity = eph.sunIntensity;
      api.moonIntensity = eph.moonIntensity;
      api.moonPhase = eph.moonPhase;
    }
  }

  _sampleRadiance(dir, target) {
    this.eph.sampleSky(dir, target);
    target.multiplyScalar(SKY_EXPOSURE);
    if (this.eph.moonIntensity > 0 && this.eph.moonDirection.y > 0) {
      this.eph.sampleSky(dir, _cMoon, this.eph.moonDirection);
      const g = this.eph.moonIntensity * MOON_SCATTER_LIFT * SKY_EXPOSURE;
      target.r += _cMoon.r * g;
      target.g += _cMoon.g * g;
      target.b += _cMoon.b * g;
    }
    return target;
  }

  update(dt, ctx) {
    const renderer = ctx.renderer;
    if (!renderer) return;

    this._time += dt;
    const u = this.dome.uniforms;
    u.uTime.value = this._time;
    this._cloudPhase += dt * this.windSpeed;
    const eph = this.eph;

    // The cloud volume bakes over the first few frames; until it exists the
    // cache would sample garbage, so hold the cloud pass and keep the sky clear.
    if (!this.noise.ready) {
      this.noise.step(renderer, 12);
      if (this.noise.ready) this._dirty = true;
      if (this._firstFrame) {
        this.lut.setLights(eph.sunDirection, eph.moonDirection);
        this.lut.render(renderer, 1);
        this._lutSunDir.copy(eph.sunDirection);
        this._firstFrame = false;
        this._regenerateEnvironment(renderer, ctx);
      }
      return;
    }

    if (this._dirty || this._firstFrame) {
      this.lut.setLights(eph.sunDirection, eph.moonDirection);
      this.lut.render(renderer, 1);
      // A full cloud refresh is ~12 frames of work in one frame. Fine for a
      // discrete time-of-day jump, ruinous if a slider drags it every frame.
      const canFull = this._firstFrame || (this._time - this._lastFullCloud) > 0.4;
      this.clouds.render(renderer, this._cloudPhase, canFull);
      if (canFull) this._lastFullCloud = this._time;
      this._lutSunDir.copy(eph.sunDirection);
      this._dirty = false;
      this._firstFrame = false;
      if (this._envTimer > 0.25 || !this.pmremTarget) {
        this._regenerateEnvironment(renderer, ctx);
        this._envTimer = 0;
      }
      return;
    }

    // The LUT only depends on the light directions; nothing else can stale it.
    if (this._lutSunDir.dot(eph.sunDirection) < 0.99996) {
      this.lut.setLights(eph.sunDirection, eph.moonDirection);
      this.lut.render(renderer, 3);
      this._lutSunDir.copy(eph.sunDirection);
    }

    this.clouds.render(renderer, this._cloudPhase, false);

    this._envTimer += dt;
    if (this._envTimer >= 0.5 && this._envSunDir.dot(eph.sunDirection) < 0.99994) {
      this._regenerateEnvironment(renderer, ctx);
      this._envTimer = 0;
    }
  }

  _regenerateEnvironment(renderer, ctx) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    this.cubeCamera.update(renderer, this.dome.envScene);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.pmrem.compileCubemapShader();
    }
    try {
      this.pmremTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.pmremTarget);
    } catch (e) {
      console.warn('Sky: PMREM generation failed', e);
      return;
    }
    renderer.setRenderTarget(prevTarget);

    const envMap = this.pmremTarget.texture;
    ctx.scene.environment = envMap;
    // Deliberately NOT `scene.background`. The dome is a camera-locked box with
    // depthTest off at renderOrder -1000, so it already covers every pixel; a
    // scene background would be a second full-screen pass that is then entirely
    // overdrawn. The cube is still published as `ctx.sky.cubeMap` for anything
    // that wants to sample it.
    ctx.scene.background = null;
    ctx.scene.environmentIntensity = 1;
    if (ctx.sky) ctx.sky.envMap = envMap;
    // The texture factory may expose envMap as a getter that proxies ctx.sky.
    try { if (ctx.textures && !this._envMapReadonly) ctx.textures.envMap = envMap; }
    catch { this._envMapReadonly = true; }
    this._envSunDir.copy(this.eph.sunDirection);
  }

  dispose() {
    this.lut?.dispose();
    this.clouds?.dispose();
    this.noise?.dispose();
    this.dome?.dispose();
    this.cubeTarget?.dispose();
    this.pmremTarget?.dispose();
    this.pmrem?.dispose();
  }
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
