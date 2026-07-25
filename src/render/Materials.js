import * as THREE from 'three';

/** Placeholder material library. The Materials agent replaces with full PBR set. */
export class MaterialLibrary {
  async init(ctx) {
    this.cache = new Map();
    ctx.materials = this;
  }
  get(name, overrides = {}) {
    const key = name + JSON.stringify(overrides);
    if (this.cache.has(key)) return this.cache.get(key);
    const m = new THREE.MeshStandardMaterial({ color: 0x9a9186, roughness: 0.9, metalness: 0, ...overrides });
    m.name = name;
    this.cache.set(key, m);
    return m;
  }
}
