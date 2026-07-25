import * as THREE from 'three';

/**
 * Placeholder composer. The PostFX agent replaces this with the full stack:
 * TAA -> GTAO -> SSR -> volumetrics -> bloom -> motion blur -> DOF -> grade.
 * Until then it just draws the world then the viewmodel on top.
 */
export class PostFX {
  async init(ctx) { this.ctx = ctx; }
  resize() {}
  lateUpdate(dt, ctx) {
    const r = ctx.renderer;
    r.clear();
    r.render(ctx.scene, ctx.camera);
    r.autoClear = false;
    r.clearDepth();
    r.render(ctx.viewScene, ctx.viewCamera);
    r.autoClear = true;
  }
}
