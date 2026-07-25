import * as THREE from 'three';

/** Placeholder greybox. The Level agent replaces with the full art-passed map. */
export class LevelSystem {
  async init(ctx) {
    const g = new THREE.Group();
    g.name = 'Level';
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      ctx.materials.get('ground', { color: 0x6f6a5e })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    g.add(ground);
    for (let i = 0; i < 24; i++) {
      const b = new THREE.Mesh(
        new THREE.BoxGeometry(4 + (i % 5) * 2, 3 + (i % 7), 4 + (i % 3) * 3),
        ctx.materials.get('wall', { color: 0x8a8378 })
      );
      b.position.set(Math.cos(i) * (12 + i * 2.2), (3 + (i % 7)) / 2, Math.sin(i * 1.7) * (12 + i * 2.2));
      b.castShadow = b.receiveShadow = true;
      g.add(b);
    }
    ctx.scene.add(g);
    ctx.level = { root: g, colliders: [], spawns: [[0, 1.7, 0]] };
  }
}
