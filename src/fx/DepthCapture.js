import * as THREE from 'three';

/**
 * Quarter-resolution linear scene depth, for soft particle edges.
 *
 * The main render already has a depth buffer, but particles are drawn *into*
 * that same pass — you cannot sample the attachment you are writing. So this
 * takes its own depth-only snapshot just before the world render, with three
 * things keeping it cheap:
 *
 *  1. **It only runs while soft particles are actually alive.** No smoke on
 *     screen, no cost at all — the common case.
 *  2. **Quarter resolution and a short far plane.** Soft fading is a
 *     centimetres-scale effect on things within a few tens of metres; geometry
 *     past `FAR` is frustum-culled out of the pass entirely, which on a street
 *     with a 70 m sightline removes most of the draw calls.
 *  3. **Shadow maps are pinned off for the pass**, otherwise `renderer.render`
 *     would re-render every cascade a second time per frame.
 *
 * A single override `ShaderMaterial` means one program and no material sorting;
 * it routes through three's own vertex chunks so instanced and skinned geometry
 * (props, vegetation, bots) land in the right place.
 */

const FAR = 95;
const SCALE = 0.25;
const CLEAR = new THREE.Color(1e4, 0, 0);

const DEPTH_VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vDepth;
void main(){
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vDepth = -mvPosition.z;
}
`;

const DEPTH_FRAG = /* glsl */ `
precision highp float;
varying float vDepth;
void main(){ gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }
`;

export class DepthCapture {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = ctx.quality?.tier !== 'low';
    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.lastDrawCalls = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, FAR);
    this.rt = null;
    this._prevCam = new THREE.Vector3(1e9, 1e9, 1e9);
    this._prevQuat = new THREE.Quaternion();
  }

  get texture() { return this.rt ? this.rt.texture : null; }

  _ensure(renderer) {
    const size = renderer.getDrawingBufferSize(_sizeScratch);
    const w = Math.max(64, Math.round(size.x * SCALE));
    const h = Math.max(64, Math.round(size.y * SCALE));
    if (this.rt && this.width === w && this.height === h) return;
    this.rt?.dispose();
    this.width = w;
    this.height = h;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
  }

  /**
   * @param {THREE.Object3D} hide FX root, excluded so particles never occlude
   *   each other's soft fade.
   * @returns {THREE.Texture|null}
   */
  capture(hide) {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const cam = ctx.camera;
    if (!this.enabled || !renderer || !cam) return null;
    this._ensure(renderer);
    if (!this.rt) return null;

    this.frame++;
    // A frame-late depth buffer at quarter resolution is invisible while the
    // camera is still, which is most of the time and every screenshot.
    const still =
      this._prevCam.distanceToSquared(cam.position) < 1e-6 &&
      Math.abs(this._prevQuat.dot(cam.quaternion)) > 0.999995;
    if (still && this.frame > 1) return this.rt.texture;
    this._prevCam.copy(cam.position);
    this._prevQuat.copy(cam.quaternion);

    const scene = ctx.scene;
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevBackground = scene.background;
    const prevVisible = hide ? hide.visible : false;
    const calls0 = renderer.info.render.calls;
    renderer.getClearColor(_clearScratch);
    const prevAlpha = renderer.getClearAlpha();

    this.camera.fov = cam.fov;
    this.camera.aspect = cam.aspect;
    this.camera.near = cam.near;
    this.camera.far = FAR;
    this.camera.position.copy(cam.position);
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    if (hide) hide.visible = false;
    scene.overrideMaterial = this.material;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setClearColor(CLEAR, 1);
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(_clearScratch, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    if (hide) hide.visible = prevVisible;
    this.lastDrawCalls = renderer.info.render.calls - calls0;

    return this.rt.texture;
  }

  dispose() {
    this.rt?.dispose();
    this.material.dispose();
  }
}

const _sizeScratch = new THREE.Vector2();
const _clearScratch = new THREE.Color();
