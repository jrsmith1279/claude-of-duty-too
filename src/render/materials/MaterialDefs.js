import * as THREE from 'three';

/**
 * Physical parameters for every material key in the architecture contract.
 *
 * Values are chosen from measured references rather than eyeballed: dielectric
 * albedos stay inside the 30-240 sRGB range real surfaces occupy, metals are
 * binary (metalness 1 with a metalness map carving out paint and dirt),
 * roughness follows the surface finish, and glass is a real transmissive
 * dielectric at IOR 1.52 with a millimetre-scale thickness.
 *
 * Geometry convention: UVs are world scaled, 1 UV unit = 1 metre. `uv` is
 * therefore "texture tiles per metre" and `tileM = 1 / uv` is the physical size
 * of one tile. Meshes that cannot honour that convention should ask for
 * `{ uvScale: n }` or a triplanar variant.
 *
 * Fields:
 *   uv        tiles per metre for UV-projected materials
 *   tri       tiles per metre for world-space triplanar projection (0 = off)
 *   pom       parallax depth in metres (0 = off)
 *   detail    [uv multiplier, strength] of the high-frequency detail normal
 *   macro     [cycles per metre, albedo/roughness swing] of the macro variation
 *   wet       [porosity, puddle affinity] response to the global wetness
 *   grime     0..1 amount of ground grime, streaking and settled dust
 *   grimeless surfaces set grime 0; transmissive surfaces set noAlbedoMap so the
 *             albedo never dims the light they transmit
 *   props     extra three.js material properties (clearcoat, sheen, ...)
 */
export const MATERIAL_DEFS = {
  concrete_wall: {
    color: 0x8b8781, roughness: 0.93, metalness: 0.0, env: 1.0, normalScale: 1.0,
    uv: 0.4, pom: 0.008, detail: [7, 0.55], macro: [0.032, 0.17], wet: [0.9, 0.05], grime: 0.8,
  },
  concrete_floor: {
    color: 0x82807a, roughness: 0.87, metalness: 0.0, env: 1.0, normalScale: 0.9,
    uv: 0.35, pom: 0.007, detail: [8, 0.5], macro: [0.028, 0.2], wet: [0.9, 0.75], grime: 0.55,
  },
  brick: {
    color: 0x77463a, roughness: 0.9, metalness: 0.0, env: 1.0, normalScale: 1.1,
    uv: 0.5, pom: 0.018, detail: [8, 0.45], macro: [0.04, 0.12], wet: [0.95, 0.05], grime: 0.85,
  },
  plaster: {
    color: 0xb4ada1, roughness: 0.94, metalness: 0.0, env: 1.0, normalScale: 0.8,
    uv: 0.3, pom: 0.005, detail: [9, 0.5], macro: [0.045, 0.11], wet: [0.85, 0.05], grime: 0.9,
  },
  stucco: {
    color: 0xa39b8e, roughness: 0.96, metalness: 0.0, env: 1.0, normalScale: 1.15,
    uv: 0.6, pom: 0.009, detail: [7, 0.6], macro: [0.05, 0.13], wet: [0.9, 0.05], grime: 0.7,
  },
  asphalt: {
    color: 0x2d2d2f, roughness: 0.94, metalness: 0.0, env: 1.0, normalScale: 1.0,
    uv: 0.33, pom: 0.01, detail: [8, 0.6], macro: [0.026, 0.22], wet: [0.8, 1.0], grime: 0.3,
  },
  asphalt_worn: {
    color: 0x37363a, roughness: 0.86, metalness: 0.0, env: 1.05, normalScale: 0.85,
    uv: 0.3, pom: 0.008, detail: [8, 0.5], macro: [0.022, 0.2], wet: [0.75, 0.95], grime: 0.45,
  },
  dirt: {
    color: 0x473827, roughness: 0.96, metalness: 0.0, env: 0.95, normalScale: 1.1,
    tri: 0.4, pom: 0.012, detail: [6, 0.55], macro: [0.028, 0.22], wet: [1.0, 0.85], grime: 0.0,
  },
  gravel: {
    color: 0x67615a, roughness: 0.93, metalness: 0.0, env: 0.95, normalScale: 1.2,
    tri: 0.55, pom: 0.02, detail: [5, 0.5], macro: [0.05, 0.15], wet: [0.85, 0.6], grime: 0.0,
  },
  sand: {
    color: 0xa08a6a, roughness: 0.89, metalness: 0.0, env: 1.0, normalScale: 0.9,
    tri: 0.45, pom: 0.01, detail: [7, 0.45], macro: [0.02, 0.13], wet: [0.85, 0.4], grime: 0.0,
  },
  rubble: {
    color: 0x6a665e, roughness: 0.93, metalness: 0.0, env: 0.95, normalScale: 1.2,
    tri: 0.5, pom: 0.022, detail: [5, 0.55], macro: [0.045, 0.16], wet: [0.85, 0.45], grime: 0.35,
  },
  wood_plank: {
    color: 0x6a4d33, roughness: 0.74, metalness: 0.0, env: 1.0, normalScale: 0.95,
    uv: 0.5, pom: 0.005, detail: [8, 0.4], macro: [0.06, 0.14], wet: [0.7, 0.1], grime: 0.45,
  },
  wood_painted: {
    color: 0x8d8579, roughness: 0.5, metalness: 0.0, env: 1.1, normalScale: 0.8,
    uv: 0.5, pom: 0.004, detail: [8, 0.35], macro: [0.05, 0.12], wet: [0.35, 0.1], grime: 0.55,
    props: { clearcoat: 0.22, clearcoatRoughness: 0.4 },
  },
  plywood: {
    color: 0x967245, roughness: 0.82, metalness: 0.0, env: 1.0, normalScale: 0.85,
    uv: 0.35, pom: 0.004, detail: [8, 0.4], macro: [0.05, 0.13], wet: [0.75, 0.1], grime: 0.5,
  },
  metal_painted: {
    color: 0x59666b, roughness: 0.38, metalness: 1.0, metalnessNoMap: 0.15, env: 1.15, normalScale: 0.75,
    uv: 0.5, pom: 0.003, detail: [9, 0.3], macro: [0.06, 0.09], wet: [0.15, 0.15], grime: 0.5,
    props: { clearcoat: 0.35, clearcoatRoughness: 0.26 },
  },
  metal_rusted: {
    color: 0x6b4530, roughness: 0.78, metalness: 1.0, metalnessNoMap: 0.4, env: 1.05, normalScale: 1.1,
    uv: 0.45, pom: 0.006, detail: [8, 0.5], macro: [0.05, 0.16], wet: [0.5, 0.2], grime: 0.55,
  },
  metal_corrugated: {
    color: 0x8a8d90, roughness: 0.46, metalness: 1.0, metalnessNoMap: 0.85, env: 1.15, normalScale: 0.9,
    uv: 0.35, pom: 0.03, detail: [9, 0.35], macro: [0.05, 0.11], wet: [0.2, 0.15], grime: 0.45,
    props: { clearcoat: 0.15, clearcoatRoughness: 0.35 },
  },
  steel_brushed: {
    color: 0xb0b4b8, roughness: 0.29, metalness: 1.0, metalnessNoMap: 1.0, env: 1.25, normalScale: 0.6,
    uv: 1.0, pom: 0.0, detail: [10, 0.25], macro: [0.12, 0.06], wet: [0.1, 0.1], grime: 0.25,
    props: { anisotropy: 0.55, anisotropyRotation: 0.0 },
  },
  gun_metal: {
    color: 0x2a2c30, roughness: 0.25, metalness: 1.0, metalnessNoMap: 1.0, env: 1.3, normalScale: 0.7,
    uv: 4.0, pom: 0.0, detail: [6, 0.3], macro: [0, 0], wet: [0, 0], grime: 0.0,
    props: { anisotropy: 0.3 },
  },
  gun_polymer: {
    color: 0x212327, roughness: 0.45, metalness: 0.0, env: 1.15, normalScale: 0.85,
    uv: 5.0, pom: 0.0, detail: [6, 0.4], macro: [0, 0], wet: [0, 0], grime: 0.0,
    props: { clearcoat: 0.3, clearcoatRoughness: 0.45 },
  },
  gun_wood: {
    color: 0x4e321d, roughness: 0.33, metalness: 0.0, env: 1.2, normalScale: 0.6,
    uv: 3.0, pom: 0.0, detail: [6, 0.25], macro: [0, 0], wet: [0, 0], grime: 0.0,
    props: { clearcoat: 0.55, clearcoatRoughness: 0.13 },
  },
  glass: {
    color: 0xf2f6f4, roughness: 0.04, metalness: 0.0, env: 1.4, normalScale: 0.3,
    uv: 0.25, pom: 0.0, detail: [0, 0], macro: [0.03, 0.05], wet: [0.05, 0.0], grime: 0.22,
    transmissive: true, noAlbedoMap: true,
    props: {
      transmission: 0.96, ior: 1.52, thickness: 0.008, specularIntensity: 1.0,
      attenuationColor: 0xdff0e8, attenuationDistance: 3.0, side: THREE.DoubleSide, depthWrite: true,
    },
  },
  glass_broken: {
    color: 0xe6ece9, roughness: 0.3, metalness: 0.0, env: 1.3, normalScale: 1.4,
    uv: 0.5, pom: 0.0, detail: [7, 0.5], macro: [0.05, 0.08], wet: [0.05, 0.0], grime: 0.3,
    transmissive: true, noAlbedoMap: true,
    props: {
      transmission: 0.72, ior: 1.52, thickness: 0.01, specularIntensity: 1.0,
      attenuationColor: 0xdcece4, attenuationDistance: 2.0, side: THREE.DoubleSide, depthWrite: true,
    },
  },
  fabric_canvas: {
    color: 0x7a7054, roughness: 0.95, metalness: 0.0, env: 0.95, normalScale: 1.0,
    uv: 0.8, pom: 0.0, detail: [8, 0.5], macro: [0.08, 0.1], wet: [0.9, 0.05], grime: 0.5,
    props: { sheen: 0.45, sheenRoughness: 0.75, sheenColor: 0x8f8468 },
  },
  sandbag: {
    color: 0x877a5c, roughness: 0.96, metalness: 0.0, env: 0.95, normalScale: 1.2,
    uv: 1.3, pom: 0.008, detail: [7, 0.55], macro: [0.25, 0.14], wet: [0.95, 0.1], grime: 0.6,
    props: { sheen: 0.3, sheenRoughness: 0.85, sheenColor: 0x8a7f60 },
  },
  tile_roof: {
    color: 0x854737, roughness: 0.82, metalness: 0.0, env: 1.05, normalScale: 1.1,
    uv: 0.55, pom: 0.02, detail: [8, 0.45], macro: [0.05, 0.14], wet: [0.85, 0.3], grime: 0.6,
  },
  tarmac_line: {
    color: 0xcfc9ba, roughness: 0.68, metalness: 0.0, env: 1.0, normalScale: 0.7,
    uv: 0.4, pom: 0.003, detail: [8, 0.4], macro: [0.05, 0.16], wet: [0.6, 0.8], grime: 0.85,
  },
  rubber: {
    color: 0x191a1c, roughness: 0.82, metalness: 0.0, env: 0.9, normalScale: 1.0,
    uv: 1.5, pom: 0.004, detail: [7, 0.45], macro: [0.3, 0.08], wet: [0.15, 0.1], grime: 0.3,
    props: { specularIntensity: 0.72 },
  },
  foliage: {
    color: 0x46672c, roughness: 0.62, metalness: 0.0, env: 1.0, normalScale: 0.8,
    uv: 1.0, pom: 0.0, detail: [0, 0], macro: [0.35, 0.16], wet: [0.3, 0.0], grime: 0.0,
    translucency: [0.32, 0.5, 0.16], alphaTest: 0.42,
    props: { side: THREE.DoubleSide, sheen: 0.25, sheenRoughness: 0.6, sheenColor: 0x9ab86a },
  },
  bark: {
    color: 0x473a2c, roughness: 0.9, metalness: 0.0, env: 0.95, normalScale: 1.3,
    uv: 1.0, pom: 0.016, detail: [6, 0.5], macro: [0.2, 0.15], wet: [0.9, 0.0], grime: 0.35,
  },
};

export const MATERIAL_KEYS = Object.keys(MATERIAL_DEFS);

/**
 * Generic names other systems reach for before they settle on a contract key.
 * These resolve to the nearest real surface and are forced triplanar, because
 * a mesh asking for "wall" almost certainly does not have world-scaled UVs and
 * world-space projection is the only way to get the tiling right regardless.
 */
export const KEY_ALIASES = {
  ground: 'concrete_floor',
  floor: 'concrete_floor',
  wall: 'concrete_wall',
  ceiling: 'plaster',
  road: 'asphalt',
  pavement: 'concrete_floor',
  terrain: 'dirt',
  metal: 'metal_painted',
  steel: 'steel_brushed',
  wood: 'wood_plank',
  cloth: 'fabric_canvas',
  leaf: 'foliage',
  window: 'glass',
  debris: 'rubble',
};

/** Per-tier shader budget. `pomMax` of 0 compiles the parallax path out. */
export const QUALITY_TIERS = {
  low: { pomMax: 0, triplanar: false, detail: false, macro: true, procNormals: true, detailFade: [4, 12], pomFade: [3, 8] },
  medium: { pomMax: 10, triplanar: true, detail: true, macro: true, procNormals: true, detailFade: [6, 18], pomFade: [4, 11] },
  high: { pomMax: 18, triplanar: true, detail: true, macro: true, procNormals: true, detailFade: [8, 26], pomFade: [5, 15] },
  ultra: { pomMax: 24, triplanar: true, detail: true, macro: true, procNormals: true, detailFade: [10, 34], pomFade: [6, 18] },
};
