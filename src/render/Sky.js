import * as THREE from 'three';

/** Placeholder sky. The Sky agent replaces with physical atmosphere + clouds. */
export class SkySystem {
  async init(ctx) {
    ctx.scene.background = new THREE.Color(0x8fb2d4);
    ctx.scene.fog = new THREE.FogExp2(0xa8bed6, 0.006);
    ctx.sun = new THREE.Vector3(0.4, 0.55, 0.3).normalize();
  }
}
