import * as THREE from 'three';

/** Placeholder. The Texture agent replaces with GPU-generated PBR texture sets. */
export class TextureFactory {
  async init(ctx) {
    this.cache = new Map();
    ctx.textures = this;
  }
  get() { return null; }
}
