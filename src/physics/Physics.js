import * as THREE from 'three';

/** Placeholder. The Physics agent replaces with swept collision + rigid bodies. */
export class PhysicsSystem {
  async init(ctx) {
    this.ctx = ctx;
    ctx.physics = {
      raycast: (origin, dir, maxDist = 1000) => {
        const rc = new THREE.Raycaster(origin, dir, 0.01, maxDist);
        const hits = rc.intersectObject(ctx.scene, true);
        return hits[0] || null;
      },
      moveCharacter: (pos, delta) => { pos.add(delta); return { grounded: pos.y <= 1.7 }; },
    };
  }
}
