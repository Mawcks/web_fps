/**
 * First-person controller.
 *
 * Movement uses accel/decel toward a target velocity. Collision treats walls
 * as 2D rectangles in the XZ plane (they always span full room height, so the
 * player can never be on top of one) plus a floor/ceiling clamp. Shooting is
 * hitscan: a ray that hits the nearest target unless a wall blocks it first.
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { ROOM_HEIGHT } from './grid.js';

const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.15;
const RADIUS = 0.36;
const EYE_DROP = 0.18; // eyes sit this far below the top of the head
const SHOOT_COOLDOWN = 0.14;
const SHOOT_RANGE = 80;

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.controls = new PointerLockControls(camera, domElement); // auto-connects

    this.feet = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(); // horizontal velocity
    this.velY = 0;
    this.onGround = true;
    this.height = STAND_HEIGHT;
    this.enabled = false;
    this.colliders = []; // THREE.Box3[]

    this.walkSpeed = 4.8;
    this.sprintSpeed = 7.6;
    this.crouchSpeed = 2.6;
    this.accel = 22;
    this.decel = 18;
    this.airAccel = 6;
    this.jumpSpeed = 6.2;
    this.gravity = -19;

    this._shootTimer = 0;
    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = SHOOT_RANGE;

    this._buildGun();
    this.torch = new THREE.PointLight(0xfff0d8, 1.0, 26, 1.6);
    this.torch.position.set(0, 0, 0);
    camera.add(this.torch);
  }

  _buildGun() {
    const gun = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.6, metalness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.5, metalness: 0.3 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.34), dark);
    body.position.set(0, -0.02, -0.05);
    gun.add(body);

    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.4), dark);
    barrel.position.set(0, 0.03, -0.32);
    gun.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.12), dark);
    grip.position.set(0, -0.15, 0.06);
    grip.rotation.x = 0.35;
    gun.add(grip);

    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.05), accent);
    sight.position.set(0, 0.11, -0.06);
    gun.add(sight);

    this._gunRest = new THREE.Vector3(0.26, -0.26, -0.55);
    gun.position.copy(this._gunRest);
    gun.rotation.y = -0.06;
    this.gun = gun;
    this._gunRecoil = 0;
    this.camera.add(gun);
  }

  setColliders(boxes) {
    this.colliders = boxes;
  }

  spawnAt(x, z, facing = 0) {
    this.feet.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.velY = 0;
    this.onGround = true;
    this.height = STAND_HEIGHT;
    this.camera.rotation.set(0, facing, 0, 'YXZ');
    this._applyCamera();
  }

  _applyCamera() {
    this.camera.position.set(
      this.feet.x,
      this.feet.y + this.height - EYE_DROP,
      this.feet.z,
    );
  }

  lock() {
    this.controls.lock();
  }

  unlock() {
    this.controls.unlock();
  }

  get isLocked() {
    return this.controls.isLocked;
  }

  _stepMovement(dt, keys) {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const ix = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const iz = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);

    const dir = new THREE.Vector3();
    dir.addScaledVector(right, ix);
    dir.addScaledVector(forward, -iz);
    const moving = dir.lengthSq() > 0;
    if (moving) dir.normalize();

    const crouching = keys.has('KeyC'); // Ctrl avoided — Ctrl+W closes the tab
    const sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !crouching && iz < 0;
    const maxSpeed = !moving
      ? 0
      : crouching
        ? this.crouchSpeed
        : sprinting
          ? this.sprintSpeed
          : this.walkSpeed;

    const target = dir.multiplyScalar(maxSpeed);
    const speedingUp = target.lengthSq() > this.vel.lengthSq();
    const rate = this.onGround ? (speedingUp ? this.accel : this.decel) : this.airAccel;
    this.vel.lerp(target, 1 - Math.exp(-rate * dt));
    if (maxSpeed > 0 && this.vel.lengthSq() > maxSpeed * maxSpeed) this.vel.setLength(maxSpeed);

    // crouch height eases in/out
    const targetHeight = crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    this.height += (targetHeight - this.height) * (1 - Math.exp(-12 * dt));
  }

  _resolveHorizontal() {
    let { x, z } = this.feet;
    const r = RADIUS;
    for (let pass = 0; pass < 2; pass++) {
      let touched = false;
      for (const w of this.colliders) {
        const minX = x - r,
          maxX = x + r,
          minZ = z - r,
          maxZ = z + r;
        if (maxX <= w.min.x || minX >= w.max.x) continue;
        if (maxZ <= w.min.z || minZ >= w.max.z) continue;
        const overlapX = Math.min(maxX, w.max.x) - Math.max(minX, w.min.x);
        const overlapZ = Math.min(maxZ, w.max.z) - Math.max(minZ, w.min.z);
        if (overlapX < overlapZ) {
          x += x < (w.min.x + w.max.x) / 2 ? -overlapX : overlapX;
        } else {
          z += z < (w.min.z + w.max.z) / 2 ? -overlapZ : overlapZ;
        }
        touched = true;
      }
      if (!touched) break;
    }
    this.feet.x = x;
    this.feet.z = z;
  }

  update(dt, keys) {
    // gun recoil always eases back so it settles even between modes
    this._gunRecoil += (0 - this._gunRecoil) * (1 - Math.exp(-16 * dt));
    this.gun.position.z = this._gunRest.z + this._gunRecoil * 0.12;
    this.gun.position.y = this._gunRest.y + this._gunRecoil * 0.04;
    this.gun.rotation.x = this._gunRecoil * 0.25;
    if (this._shootTimer > 0) this._shootTimer -= dt;

    if (!this.enabled) return;

    this._stepMovement(dt, keys);

    this.velY += this.gravity * dt;
    if (keys.has('Space') && this.onGround) {
      this.velY = this.jumpSpeed;
      this.onGround = false;
    }

    this.feet.x += this.vel.x * dt;
    this.feet.z += this.vel.z * dt;
    this._resolveHorizontal();

    this.feet.y += this.velY * dt;
    if (this.feet.y <= 0) {
      this.feet.y = 0;
      this.velY = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    const head = this.feet.y + this.height;
    if (head > ROOM_HEIGHT) {
      this.feet.y = ROOM_HEIGHT - this.height;
      if (this.velY > 0) this.velY = 0;
    }

    // viewmodel bob while walking
    const speed = this.vel.length();
    const bob = Math.sin(performance.now() * 0.012) * Math.min(speed / this.walkSpeed, 1) * 0.012;
    this.gun.position.x = this._gunRest.x;
    this.gun.position.y += bob;

    this._applyCamera();
  }

  /**
   * Fire a hitscan shot.
   * @returns {null | { target: THREE.Object3D|null, from: THREE.Vector3, to: THREE.Vector3 }}
   *          null if still on cooldown.
   */
  shoot(targets) {
    if (this._shootTimer > 0) return null;
    this._shootTimer = SHOOT_COOLDOWN;
    this._gunRecoil = 1;

    const from = this.camera.position.clone();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this._raycaster.set(from, dir);

    // nearest wall along the ray blocks the shot
    let wallDist = SHOOT_RANGE;
    const tmp = new THREE.Vector3();
    for (const box of this.colliders) {
      if (this._raycaster.ray.intersectBox(box, tmp)) {
        const d = from.distanceTo(tmp);
        if (d < wallDist) wallDist = d;
      }
    }

    let target = null;
    let endDist = wallDist;
    const hits = this._raycaster.intersectObjects(targets, false);
    if (hits.length && hits[0].distance < wallDist) {
      target = hits[0].object;
      endDist = hits[0].distance;
    }

    const to = from.clone().addScaledVector(dir, endDist);
    return { target, from, to };
  }
}
