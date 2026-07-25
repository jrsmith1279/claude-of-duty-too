/**
 * Everything else: glazing (clean and shattered), woven textiles, moulded
 * polymer, rubber and leaf mass. Glass carries its detail almost entirely in
 * roughness — an albedo map on glass is nearly useless — and the broken variant
 * builds true radial-plus-circumferential fracture from hashed impact points.
 */
export const MISC = {
  glass: {
    world: 2.0,
    bump: 0.12,
    cavity: 0.0,
    glsl: /* glsl */ `
Surf gen_glass(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 601.0;

  // float glass is optically flat; all the character is in the contamination
  float smear = smoothstep(0.48, 0.85, fbm01(warp2(uv * 6.0, vec2(6.0), 1.3, 3) + sd, vec2(6.0), 5, 2.0, 0.55));
  float wipe  = smoothstep(0.55, 0.85, fbm01(vec2(uv.x * 26.0, uv.y * 3.0) + 11.0, vec2(26.0, 3.0), 4, 2.0, 0.5));
  float dust  = fbm01(uv * 200.0 + sd * 2.0, vec2(200.0), 4, 2.0, 0.5);

  // rain spots and dried mineral rings
  Cell dropc = cells2(uv * 55.0 + 21.0, vec2(55.0), 1.0);
  float dropR = mix(0.10, 0.26, fract(dropc.id * 41.3));
  float dropPresent = step(0.55, fract(dropc.id * 13.7));
  float drop = (1.0 - smoothstep(dropR * 0.85, dropR, dropc.f1)) * dropPresent;
  float dropRing = (1.0 - smoothstep(dropR, dropR * 1.15, dropc.f1)) * smoothstep(dropR * 0.8, dropR, dropc.f1) * dropPresent;

  // fine wiper scratches
  float scr = sat(scratches(uv, 1.0, 700.0, 4.0, 0.70, sd) * 0.5 + gouges(uv, -3.0, 30.0, 0.06, sd + 3.0));

  float grime = sat(smear * 0.55 + wipe * 0.35 + dust * 0.25 + drop * 0.5 + dropRing * 0.7) * (0.35 + 0.65 * uAge);

  vec3 base = mix(vec3(0.960, 0.972, 0.968), vec3(0.640, 0.630, 0.600), grime * 0.55);
  base = mix(base, vec3(0.86, 0.87, 0.85), dropRing * 0.4);

  s.alb = base;
  s.rough = 0.035 + grime * 0.30 + scr * 0.18 + dropRing * 0.12;
  s.metal = 0.0;
  s.h = 0.72 + (dust - 0.5) * 0.02 - drop * 0.02 + dropRing * 0.02 - scr * 0.02;
  s.ao = 1.0;
  s.op = sat(0.06 + grime * 0.60 + dropRing * 0.25 + scr * 0.15);

  applyMacro(s, uv, 0.04, 0.03, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  glass_broken: {
    world: 2.0,
    bump: 0.9,
    cavity: 0.4,
    glsl: /* glsl */ `
/** Radial + circumferential fracture around one impact. d is a torus-wrapped offset. */
float fracture(vec2 d, float sd, out float shard){
  float r = length(d);
  float a = atan(d.y, d.x) / TAU + 0.5;

  // radial rays, jittered in angle and thinning with distance
  float rays = 13.0;
  float k = a * rays;
  float ri = floor(k);
  float jit = (hash11(ri + sd * 3.1) - 0.5) * 0.55;
  float bend = fbm(vec2(r * 8.0, ri), vec2(8.0, rays), 3, 2.0, 0.5) * 0.20;
  float da = abs(fract(k + jit + bend) - 0.5);
  float radial = 1.0 - smoothstep(0.0, 0.02 + r * 0.06, da * (0.35 + r * 2.2));
  radial *= smoothstep(0.62, 0.10, r);
  radial *= step(0.18, fract(hash11(ri + sd * 7.7)));

  // circumferential cracks linking the rays
  float rings = 5.0;
  float rr = r * rings + fbm(vec2(a * 10.0, 2.0), vec2(10.0, 2.0), 3, 2.0, 0.5) * 0.55;
  float dr = abs(fract(rr) - 0.5);
  float circ = 1.0 - smoothstep(0.0, 0.045, dr);
  circ *= smoothstep(0.55, 0.06, r) * smoothstep(0.03, 0.10, r);
  circ *= step(0.35, fract(hash11(floor(rr) + sd * 5.3)));

  shard = 1.0 - smoothstep(0.03, 0.075, r);   // the hole punched at the centre
  return sat(radial + circ * 0.85);
}

Surf gen_glass_broken(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 631.0;

  float ck = 0.0;
  float hole = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 c = hash21(float(i) * 7.3 + sd);
    vec2 d = fract(uv - c + 0.5) - 0.5;
    float sh;
    ck = max(ck, fracture(d, sd + float(i) * 11.0, sh));
    hole = max(hole, sh);
  }

  // secondary stress craze filling the shards
  float craze = crackNet(uv, vec2(9.0), 0.016, 0.9, 0.45);
  craze *= smoothstep(0.35, 0.75, fbm01(uv * 3.0 + 41.0, vec2(3.0), 4, 2.0, 0.6));
  ck = sat(ck + craze * 0.55);

  // base pane, dirtier than the clean variant
  float smear = smoothstep(0.42, 0.85, fbm01(warp2(uv * 6.0, vec2(6.0), 1.2, 3) + sd, vec2(6.0), 5, 2.0, 0.55));
  float dust = fbm01(uv * 210.0 + sd * 2.0, vec2(210.0), 4, 2.0, 0.5);
  float grime = sat(smear * 0.7 + dust * 0.3) * (0.5 + 0.5 * uAge);

  // fracture surfaces scatter light: bright, rough, slightly milky
  vec3 base = mix(vec3(0.930, 0.945, 0.945), vec3(0.560, 0.550, 0.520), grime * 0.55);
  base = mix(base, vec3(0.880, 0.905, 0.915), ck * 0.85);

  s.alb = base;
  s.rough = 0.045 + grime * 0.28 + ck * 0.42;
  s.metal = 0.0;
  s.h = 0.70 - ck * 0.22 + (dust - 0.5) * 0.02;
  s.ao = 1.0 - ck * 0.30;
  s.op = sat(0.08 + grime * 0.5 + ck * 0.75);

  // missing shards punch right through
  float gone = sat(hole * 1.2 - fbm01(uv * 40.0, vec2(40.0), 3, 2.0, 0.5) * 0.35);
  s.op *= 1.0 - smoothstep(0.35, 0.7, gone);
  s.alb = mix(s.alb, vec3(0.98), smoothstep(0.15, 0.5, gone) * 0.4);
  s.rough = mix(s.rough, 0.55, smoothstep(0.15, 0.5, gone));

  applyMacro(s, uv, 0.05, 0.03, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  fabric_canvas: {
    world: 1.0,
    bump: 0.85,
    cavity: 0.7,
    glsl: /* glsl */ `
Surf gen_fabric_canvas(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 661.0;

  // --- plain weave: warp and weft alternate over and under on a checker
  float N = 96.0;
  vec2 tp = uv * N;
  vec2 ti = floor(tp), tf = fract(tp);
  float chk = mod(ti.x + ti.y, 2.0);

  float warpH = pow(sin(sat(tf.x) * PI), 0.55);
  float weftH = pow(sin(sat(tf.y) * PI), 0.55);
  float top = mix(weftH, warpH, chk);
  float bot = mix(warpH, weftH, chk) * 0.35;
  float h = max(top * 0.85, bot) * 0.75 + 0.12;

  // yarn twist and slub: real thread is not a smooth tube
  float twist = fbm01(vec2(mix(tf.y, tf.x, chk) * 6.0 + ti.x * 3.1 + ti.y * 1.7, 0.5) * vec2(1.0, 1.0), vec2(6.0, 1.0), 3, 2.0, 0.5);
  float slub = fbm01(uv * vec2(N * 0.5, 4.0) + sd, vec2(N * 0.5, 4.0), 3, 2.0, 0.5);
  h += (twist - 0.5) * 0.10 + (slub - 0.5) * 0.06;

  // fibre fuzz breaks the silhouette of every thread
  float fuzz = fbm01(uv * 900.0 + sd * 2.0, vec2(900.0), 3, 2.0, 0.5);
  h += (fuzz - 0.5) * 0.06;

  // --- colour: olive drab duck canvas, per-thread dye variation
  vec3 dye = vec3(0.288, 0.288, 0.198);
  float threadId = mix(ti.y, ti.x, chk);
  dye = jitterHSV(dye, hash32(vec2(threadId, chk) + sd), 0.020, 0.25, 0.28);
  dye *= mix(0.78, 1.18, twist);
  dye *= mix(0.92, 1.08, slub);
  dye = mix(dye, dye * 1.35, sat(top - 0.55) * 0.5);      // thread crowns catch light

  // --- weathering: sun fade on the crowns, dirt in the interstices
  float fade = smoothstep(0.35, 0.85, fbm01(uv * 4.0 + 31.0, vec2(4.0), 4, 2.0, 0.6));
  dye = mix(dye, dye * 0.72 + 0.20, fade * 0.45 * uAge);

  float gap = sat(1.0 - h * 2.2);
  s.alb = dye;
  s.rough = 0.86 + (fuzz - 0.5) * 0.10 - sat(top - 0.6) * 0.08;
  s.h = h;
  s.ao = mix(0.35, 1.0, smoothstep(0.05, 0.6, h));
  applyDirt(s, sat(gap * 0.8) * 0.4 * uAge, vec3(0.20, 0.185, 0.155), 0.06);

  // --- stains, patches and a stitched seam
  float stain = blobs(uv, vec2(5.0), 0.22, 0.34, 0.8, sd + 7.0);
  s.alb = mix(s.alb, s.alb * vec3(0.55, 0.52, 0.46), stain * 0.6);
  s.rough += stain * 0.04;

  float seamD = abs(fract(uv.y * 3.0 + 0.27) - 0.5);
  float seam = 1.0 - smoothstep(0.010, 0.020, seamD);
  float stitch = seam * step(0.5, fract(uv.x * N * 0.25));
  s.h += seam * 0.10 + stitch * 0.10;
  s.alb = mix(s.alb, s.alb * 0.8, seam * 0.4);
  s.alb = mix(s.alb, vec3(0.32, 0.30, 0.24), stitch * 0.5);
  s.ao *= 1.0 - seam * 0.20;

  // frayed edge fibres pulling away
  float fray = smoothstep(0.86, 0.98, fbm01(shear(uv, 2.0) * vec2(400.0, 9.0) + 91.0, vec2(400.0, 9.0), 3, 2.0, 0.5));
  s.alb = mix(s.alb, s.alb * 1.25, fray * 0.4);
  s.h += fray * 0.05;
  s.op = 1.0;

  applyMacro(s, uv, 0.13, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  sandbag: {
    world: 0.7,
    bump: 1.4,
    cavity: 0.9,
    glsl: /* glsl */ `
Surf gen_sandbag(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 691.0;

  // --- coarse polypropylene sacking: fewer, fatter, flatter tapes than canvas
  float N = 34.0;
  vec2 tp = uv * N;
  vec2 ti = floor(tp), tf = fract(tp);
  float chk = mod(ti.x + ti.y, 2.0);
  float warpH = pow(sin(sat(tf.x) * PI), 0.35);
  float weftH = pow(sin(sat(tf.y) * PI), 0.35);
  float top = mix(weftH, warpH, chk);
  float h = top * 0.42 + 0.18;

  // --- the bag is full: broad lumps of sand pushing the weave out
  vec2 wp = warp1(uv * 3.0, vec2(3.0), 0.7, 3);
  float bulge = fbm01(wp + sd, vec2(3.0), 5, 2.0, 0.6);
  float grainLump = fbm01(uv * 18.0 + 11.0, vec2(18.0), 4, 2.0, 0.5);
  h += (bulge - 0.5) * 0.42 + (grainLump - 0.5) * 0.14;

  // --- colour: sun-bleached hessian tan with UV-degraded pale crowns
  vec3 base = vec3(0.470, 0.400, 0.275);
  base = jitterHSV(base, hash32(vec2(mix(ti.y, ti.x, chk), chk) + sd), 0.020, 0.22, 0.22);
  base *= mix(0.80, 1.16, top);
  base *= mix(0.86, 1.12, bulge);

  float bleach = smoothstep(0.4, 0.9, bulge) * smoothstep(0.5, 0.95, top);
  base = mix(base, vec3(0.700, 0.660, 0.560), bleach * 0.45 * (0.4 + 0.6 * uAge));

  // sand dust worked into the weave, and darker damp at the base
  float dust = sat(1.0 - top * 1.4) * 0.6 + fbm01(uv * 60.0 + 3.0, vec2(60.0), 3, 2.0, 0.5) * 0.4;
  base = mix(base, vec3(0.560, 0.500, 0.395), sat(dust) * 0.35);

  float damp = smoothstep(0.55, 0.95, fbm01(uv * 4.0 + 61.0, vec2(4.0), 4, 2.0, 0.6));
  base = mix(base, base * 0.62, damp * 0.5 * uAge);

  s.alb = base;
  s.h = h;
  s.rough = 0.90 + (grainLump - 0.5) * 0.06 - bleach * 0.04;
  s.ao = mix(0.32, 1.0, smoothstep(0.05, 0.62, h)) * mix(0.75, 1.0, smoothstep(0.2, 0.7, bulge));

  // --- degraded tapes: UV has made the polypropylene split and fibrillate
  float split = smoothstep(0.82, 0.97, fbm01(shear(uv, 3.0) * vec2(N * 5.0, 7.0) + 121.0, vec2(N * 5.0, 7.0), 3, 2.0, 0.5));
  split *= uAge;
  s.alb = mix(s.alb, s.alb * 1.3, split * 0.5);
  s.h += split * 0.06;
  s.rough += split * 0.04;

  // --- stitched closure across the top of the bag
  float seamD = abs(fract(uv.y + 0.5) - 0.5);
  float seam = 1.0 - smoothstep(0.020, 0.035, seamD);
  float stitch = seam * smoothstep(0.4, 0.6, fract(uv.x * 22.0));
  s.h -= seam * 0.12;
  s.h += stitch * 0.16;
  s.alb = mix(s.alb, vec3(0.28, 0.25, 0.19), stitch * 0.6);
  s.ao *= 1.0 - seam * 0.35;

  float grit = speckle(uv, 900.0, 0.10);
  s.alb = mix(s.alb, vec3(0.72, 0.66, 0.52), grit * 0.35);
  s.rough += grit * 0.04;

  applyMacro(s, uv, 0.15, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  rubber: {
    world: 0.8,
    bump: 1.05,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_rubber(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 727.0;

  // --- moulded carbon-black rubber: fine pebbled skin from the mould texture
  Cell peb = cells2(uv * 300.0 + sd, vec2(300.0), 1.0);
  float pebble = 1.0 - smoothstep(0.08, 0.40, peb.f1);
  float micro = fbm01(uv * 620.0 + sd * 2.0, vec2(620.0), 3, 2.0, 0.5);
  float broad = fbm01(uv * 8.0 + 5.0, vec2(8.0), 5, 2.0, 0.55);

  float h = 0.58 + pebble * 0.16 + (micro - 0.5) * 0.06 + (broad - 0.5) * 0.08;

  vec3 base = vec3(0.118, 0.115, 0.121);
  base *= mix(0.70, 1.42, sat(pebble * 0.7 + micro * 0.55));
  base *= mix(0.90, 1.12, broad);

  float rough = 0.82 + (micro - 0.5) * 0.10 - pebble * 0.06;

  // --- circumferential sidewall ribs
  float rib = sin(uv.y * 14.0 * TAU) * 0.5 + 0.5;
  rib = pow(rib, 2.0) * smoothstep(0.3, 0.6, broad);
  h += rib * 0.10;
  base *= 1.0 + rib * 0.15;

  // --- mould parting line
  float pl = 1.0 - smoothstep(0.004, 0.010, abs(fract(uv.y + 0.5) - 0.5));
  h += pl * 0.09;
  base *= 1.0 + pl * 0.25;
  rough -= pl * 0.10;

  // --- ozone cracking: a fine crazed network in the flex zones
  float ck = crackNet(uv, vec2(38.0), 0.05, 0.95, 0.4);
  ck *= smoothstep(0.40, 0.80, fbm01(uv * 4.0 + 61.0, vec2(4.0), 4, 2.0, 0.6)) * (0.4 + 0.6 * uAge);
  h -= ck * 0.22;
  base *= 1.0 - ck * 0.35;
  s.ao = 1.0 - ck * 0.5 - pebble * 0.05;
  rough += ck * 0.08;

  // --- blooming: antiozonant migrates out and greys the surface
  float bloom = smoothstep(0.45, 0.9, fbm01(uv * 6.0 + 131.0, vec2(6.0), 5, 2.0, 0.55)) * uAge;
  base = mix(base, vec3(0.235, 0.228, 0.220), bloom * 0.55);
  rough += bloom * 0.08;

  // --- scuffs where it has been dragged over concrete
  float scuff = sat(gouges(uv, 2.0, 26.0, 0.16, sd + 3.0) + scratches(uv, -1.0, 300.0, 5.0, 0.70, sd) * 0.4);
  base = mix(base, vec3(0.185, 0.176, 0.168), scuff * 0.5);
  rough += scuff * 0.08;
  h -= scuff * 0.03;

  // dust clinging to a slightly tacky surface
  float dust = sat(1.0 - h * 1.6 + turb(uv * 12.0 + 91.0, vec2(12.0), 4, 0.55) * 0.5);
  s.alb = base; s.rough = rough; s.h = h;
  applyDirt(s, dust * 0.22 * uAge, vec3(0.30, 0.28, 0.25), 0.04);

  applyMacro(s, uv, 0.10, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  gun_polymer: {
    world: 0.35,
    bump: 1.0,
    cavity: 0.5,
    glsl: /* glsl */ `
Surf gen_gun_polymer(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 761.0;

  // --- moulded grip stipple: staggered rows of truncated pyramids
  float N = 26.0;
  vec2 gp = uv * vec2(N, N);
  float row = floor(gp.y);
  gp.x += mod(row, 2.0) * 0.5;
  vec2 gi = floor(gp);
  vec2 gf = fract(gp) - 0.5;
  float dman = abs(gf.x) + abs(gf.y);
  float pyr = sat(1.0 - dman * 2.15);
  pyr = min(pyr, 0.72) / 0.72;                     // truncated tips
  pyr *= step(0.06, hash12(gi + sd));              // a few cells miss

  // --- polymer skin: fine mould grain plus a faint flow pattern
  float grain = fbm01(uv * 520.0 + sd * 2.0, vec2(520.0), 3, 2.0, 0.5);
  float flow  = fbm01(warp1(uv * 9.0, vec2(9.0), 0.7, 3) + 13.0, vec2(9.0), 5, 2.0, 0.55);
  float speck = speckle(uv, 700.0, 0.06);          // glass-fill flecks

  float h = 0.34 + pyr * 0.46 + (grain - 0.5) * 0.06 + (flow - 0.5) * 0.05;

  vec3 base = vec3(0.128, 0.128, 0.136);
  base *= mix(0.72, 1.38, sat(grain * 0.65 + flow * 0.55));
  base = mix(base, vec3(0.245, 0.238, 0.225), speck * 0.5);

  float rough = 0.66 + (grain - 0.5) * 0.10 - (flow - 0.5) * 0.06;

  // handling polishes the pyramid tips to a low sheen
  float wearField = smoothstep(0.40, 0.85, fbm01(uv * 5.0 + 71.0, vec2(5.0), 5, 2.0, 0.55));
  float polish = smoothstep(0.55, 0.95, pyr) * wearField * mix(0.5, 1.2, uAge);
  rough = mix(rough, 0.34, polish * 0.8);
  base = mix(base, base * 1.5 + 0.010, polish * 0.5);

  // --- mould parting line and an ejector-pin witness mark
  float pl = 1.0 - smoothstep(0.003, 0.008, abs(fract(uv.x + 0.5) - 0.5));
  h += pl * 0.07;
  base *= 1.0 + pl * 0.30;
  rough -= pl * 0.12;

  vec2 ep = fract(uv * vec2(2.0, 3.0)) - 0.5;
  float pin = 1.0 - smoothstep(0.16, 0.19, length(ep));
  pin *= step(0.72, hash12(floor(uv * vec2(2.0, 3.0)) + 3.3));
  h -= pin * 0.05;
  rough += pin * 0.06;
  base *= 1.0 - pin * 0.08;

  s.ao = mix(0.55, 1.0, smoothstep(0.20, 0.75, h));

  // dust and carbon settle between the pyramids
  float valley = sat(1.0 - pyr * 1.6);
  s.alb = base; s.rough = rough; s.h = h;
  applyDirt(s, valley * 0.22 * uAge, vec3(0.13, 0.125, 0.115), 0.05);

  float scuff = sat(gouges(uv, 3.0, 40.0, 0.10, sd + 5.0));
  s.alb = mix(s.alb, vec3(0.18, 0.175, 0.17), scuff * 0.4);
  s.rough += scuff * 0.10;
  s.h -= scuff * 0.03;

  applyMacro(s, uv, 0.08, 0.04, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },

  foliage: {
    world: 1.0,
    bump: 0.9,
    cavity: 0.7,
    alphaTest: true,
    glsl: /* glsl */ `
/** One layer of overlapping leaves. Returns coverage; writes colour/height/local coords. */
float leafLayer(vec2 uv, float period, float sdo, out vec3 col, out float hh, out float vein){
  Cell c = cells2(uv * period + sdo, vec2(period), 1.0);
  float ang = fract(c.id * 61.7) * TAU;
  vec2 p = rot2(ang) * c.r;
  float ay = mix(0.46, 0.68, fract(c.id * 13.3));
  float ax = mix(0.19, 0.30, fract(c.id * 29.1));
  float ty = sat(abs(p.y) / ay);
  float w = ax * (1.0 - ty * ty) * (1.0 + 0.25 * (1.0 - ty));
  float m = smoothstep(0.0, 0.016, w - abs(p.x)) * smoothstep(0.0, 0.020, ay - abs(p.y));

  // serrated margin
  float serr = sin(p.y / ay * 22.0) * 0.010;
  m *= smoothstep(0.0, 0.012, w + serr - abs(p.x));

  // midrib and side veins
  float midrib = 1.0 - smoothstep(0.0, 0.012, abs(p.x));
  float side = 1.0 - smoothstep(0.0, 0.006, abs(fract((p.y / ay) * 7.0 + p.x / max(w, 1e-3) * 0.8) - 0.5) * 0.06);
  vein = sat(midrib * 0.9 + side * 0.55) * m;

  vec3 young = vec3(0.205, 0.365, 0.125);
  vec3 mature = vec3(0.118, 0.238, 0.088);
  vec3 autumnal = vec3(0.435, 0.348, 0.098);
  float t = fract(c.id * 91.7);
  col = mix(young, mature, t);
  col = mix(col, autumnal, smoothstep(0.80, 1.0, fract(c.id * 37.1)));
  col *= mix(0.80, 1.20, fbm01(uv * 180.0 + c.id * 30.0, vec2(180.0), 3, 2.0, 0.5));
  // lamina between the veins is slightly paler and puckered
  float pucker = fbm01(uv * 90.0 + c.id * 11.0, vec2(90.0), 3, 2.0, 0.5);
  col *= mix(0.92, 1.10, pucker);
  col = mix(col, col * 0.55, vein * 0.5);

  hh = m * (0.55 + 0.35 * (1.0 - ty)) + pucker * 0.10 * m - vein * 0.06;
  return m;
}

Surf gen_foliage(vec2 uv){
  Surf s = defaultSurf();
  float sd = uSeed + 797.0;

  vec3 col = vec3(0.0), c1, c2, c3;
  float h1, h2, h3, v1, v2, v3;
  float m1 = leafLayer(uv, 5.0, sd, c1, h1, v1);
  float m2 = leafLayer(uv + vec2(0.31, 0.17), 6.0, sd + 40.0, c2, h2, v2);
  float m3 = leafLayer(uv + vec2(0.63, 0.44), 8.0, sd + 80.0, c3, h3, v3);

  // composite back to front; deeper layers are shadowed by the ones above
  vec3 base = c3 * 0.55;
  float h = h3 * 0.45;
  float vein = v3;
  float shade = m3 * 0.55;
  base = mix(base, c2 * 0.78, m2);
  h = mix(h, 0.25 + h2 * 0.55, m2);
  vein = mix(vein, v2, m2);
  shade = mix(shade, m2 * 0.78, m2);
  base = mix(base, c1, m1);
  h = mix(h, 0.40 + h1 * 0.60, m1);
  vein = mix(vein, v1, m1);
  shade = mix(shade, 1.0, m1);

  float cover = sat(m1 + m2 * 0.9 + m3 * 0.8);

  s.alb = base;
  s.h = h;
  s.rough = 0.52 + vein * 0.18 + (1.0 - shade) * 0.12;
  s.metal = 0.0;
  s.ao = mix(0.42, 1.0, sat(shade)) * (1.0 - vein * 0.15);
  s.op = smoothstep(0.35, 0.55, cover);

  // dust and insect damage
  float dust = fbm01(uv * 40.0 + 21.0, vec2(40.0), 4, 2.0, 0.5);
  applyDirt(s, sat(dust * 0.7 - 0.25) * 0.25 * uAge, vec3(0.30, 0.29, 0.22), 0.06);
  float bite = blobs(uv, vec2(24.0), 0.10, 0.12, 0.4, sd + 3.0);
  s.op *= 1.0 - smoothstep(0.4, 0.8, bite);
  s.alb = mix(s.alb, vec3(0.28, 0.22, 0.09), smoothstep(0.1, 0.4, bite) * 0.5);

  applyMacro(s, uv, 0.12, 0.05, sd);
  s.alb *= uTint;
  s.rough = sat(s.rough + uRoughBias);
  return s;
}
`,
  },
};
