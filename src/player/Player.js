import * as THREE from 'three';

/** Placeholder. The Player agent replaces with the full movement/stance model. */
export class PlayerSystem {
  async init(ctx) {
    this.ctx = ctx;
    this.yaw = 0; this.pitch = 0;
    this.pos = new THREE.Vector3(0, 1.7, 8);
    this.vel = new THREE.Vector3();
    this.override = false;
    ctx.bus.on('camera:override', (v) => { this.override = v; });
    ctx.canvas.addEventListener('click', () => ctx.input.requestLock());
    ctx.player = { position: this.pos, velocity: this.vel, health: 100, state: 'stand' };
  }
  update(dt, ctx) {
    if (this.override) return;
    const inp = ctx.input;
    this.yaw -= inp.mouse.dx * inp.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - inp.mouse.dy * inp.sensitivity, -1.5, 1.5);
    const speed = inp.action('sprint') ? 7.2 : 4.4;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (inp.action('forward')) wish.add(fwd);
    if (inp.action('back')) wish.sub(fwd);
    if (inp.action('right')) wish.add(right);
    if (inp.action('left')) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed * dt);
    this.pos.add(wish);
    ctx.camera.position.copy(this.pos);
    ctx.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
