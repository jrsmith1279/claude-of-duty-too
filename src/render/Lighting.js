import * as THREE from 'three';

/** Placeholder lighting. The Lighting agent replaces with CSM + IBL + probes. */
export class LightingSystem {
  async init(ctx) {
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    sun.position.copy(ctx.sun.clone().multiplyScalar(120));
    sun.castShadow = true;
    sun.shadow.mapSize.set(ctx.quality.shadowMapSize, ctx.quality.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 300;
    const d = 60;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    ctx.scene.add(sun, sun.target);
    ctx.sunLight = sun;
    ctx.scene.add(new THREE.HemisphereLight(0xbcd6f5, 0x4a4035, 0.9));
  }
}
