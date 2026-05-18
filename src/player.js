/**
 * First-person controller.
 *
 * Movement uses accel/decel toward a target velocity. Collision treats walls
 * as 2D rectangles in the XZ plane plus a floor/ceiling clamp. Shooting is
 * hitscan with a spread cone (wider while moving or airborne) and recoil that
 * kicks the view up and recovers.
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { ROOM_HEIGHT } from './grid.js';

const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.15;
const RADIUS = 0.36;
const EYE_DROP = 0.18; // eyes sit this far below the top of the head
const SHOOT_COOLDOWN = 0.1; // ~600 RPM
const SHOOT_RANGE = 80;

// Spread — cone half-angle in radians. Standing still is near pin-point.
const BASE_SPREAD = 0.002;
const MOVE_SPREAD = 0.05; // added at full walk speed, scaled by current speed
const AIR_SPREAD = 0.12; // added while airborne
const SHOT_SPREAD = 0.011; // each shot blooms the cone by this
const MAX_SPREAD = 0.085;
const SPREAD_RECOVER = 9; // bloom decay rate once you stop firing

// Recoil — each shot kicks the view; it recovers when you stop firing.
const RECOIL_PITCH = 0.013; // upward kick per shot
const RECOIL_YAW = 0.006; // random sideways kick per shot
const RECOIL_RECOVER = 7;

/** Nudge a unit direction to a random point inside a cone of `halfAngle`. */
function applySpread(dir, halfAngle) {
  if (halfAngle <= 1e-5) return dir;
  const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  const ang = halfAngle * Math.sqrt(Math.random()); // sqrt → uniform over the disc
  const phi = Math.random() * Math.PI * 2;
  dir
    .multiplyScalar(Math.cos(ang))
    .addScaledVector(right, Math.cos(phi) * Math.sin(ang))
    .addScaledVector(realUp, Math.sin(phi) * Math.sin(ang))
    .normalize();
  return dir;
}

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = new PointerLockControls(camera, domElement); // auto-connects

    this.binds = {
      forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
      jump: 'Space', sprint: 'ShiftLeft', crouch: 'KeyC',
    };
    this.feet = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3(); // horizontal velocity
    this.velY = 0;
    this.onGround = true;
    this.height = STAND_HEIGHT;
    this.enabled = false;
    this.colliders = []; // THREE.Box3[] — movement collision
    this.hitMeshes = []; // meshes the hitscan ray can hit (walls/floor/ceiling)

    this.spread = 0; // accumulated spray bloom
    this._recoilPitch = 0; // recoil added to the view, awaiting recovery
    this._recoilYaw = 0;

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
    this._muzzleLocal = new THREE.Vector3(0, 0.04, -0.52); // barrel tip, gun-space
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

  /** World position of the gun muzzle — the tracer origin. */
  getMuzzle() {
    return this.gun.localToWorld(this._muzzleLocal.clone());
  }

  /** Current spread cone half-angle (radians): movement + air + spray bloom. */
  _inaccuracy() {
    const moveFrac = Math.min(this.vel.length() / this.walkSpeed, 1.5);
    let a = BASE_SPREAD + moveFrac * MOVE_SPREAD + this.spread;
    if (!this.onGround) a += AIR_SPREAD;
    return a;
  }

  spawnAt(x, z, facing = 0) {
    this.feet.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.velY = 0;
    this.onGround = true;
    this.height = STAND_HEIGHT;
    this.spread = 0;
    this._recoilPitch = 0;
    this._recoilYaw = 0;
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
    // unadjustedMovement = raw mouse input with no OS acceleration (Chromium).
    const el = this.domElement;
    let res;
    try {
      res = el.requestPointerLock({ unadjustedMovement: true });
    } catch (err) {
      res = null;
    }
    if (res && typeof res.catch === 'function') {
      res.catch(() => {
        try {
          const fallback = el.requestPointerLock();
          if (fallback && typeof fallback.catch === 'function') fallback.catch(() => {});
        } catch (err) {
          /* pointer lock unavailable */
        }
      });
    }
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

    const b = this.binds;
    const ix = (keys.has(b.right) ? 1 : 0) - (keys.has(b.left) ? 1 : 0);
    const iz = (keys.has(b.back) ? 1 : 0) - (keys.has(b.forward) ? 1 : 0);

    const dir = new THREE.Vector3();
    dir.addScaledVector(right, ix);
    dir.addScaledVector(forward, -iz);
    const moving = dir.lengthSq() > 0;
    if (moving) dir.normalize();

    const crouching = keys.has(b.crouch);
    const sprinting = keys.has(b.sprint) && !crouching && iz < 0;
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

    // recoil recovers — give back the kick a fraction at a time
    const rp = this._recoilPitch * (1 - Math.exp(-RECOIL_RECOVER * dt));
    const ry = this._recoilYaw * (1 - Math.exp(-RECOIL_RECOVER * dt));
    this.camera.rotation.x -= rp;
    this.camera.rotation.y -= ry;
    this._recoilPitch -= rp;
    this._recoilYaw -= ry;
    this.spread += (0 - this.spread) * (1 - Math.exp(-SPREAD_RECOVER * dt));

    this._stepMovement(dt, keys);

    this.velY += this.gravity * dt;
    if (keys.has(this.binds.jump) && this.onGround) {
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
   * Fire a hitscan shot: apply recoil + spread, then raycast world geometry.
   * @returns {null | { to: THREE.Vector3, impact: { point, normal } | null }}
   *          null if still on cooldown.
   */
  shoot() {
    if (this._shootTimer > 0) return null;
    this._shootTimer = SHOOT_COOLDOWN;
    this._gunRecoil = 1;

    // recoil — kick the view up and a little sideways (recovers in update)
    const kickPitch = RECOIL_PITCH * (0.8 + Math.random() * 0.4);
    const kickYaw = (Math.random() - 0.5) * 2 * RECOIL_YAW;
    this.camera.rotation.x += kickPitch;
    this.camera.rotation.y += kickYaw;
    this._recoilPitch += kickPitch;
    this._recoilYaw += kickYaw;

    // shot goes where the (kicked) view points, nudged inside the spread cone
    const from = this.camera.position.clone();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    applySpread(dir, this._inaccuracy());
    this.spread = Math.min(this.spread + SHOT_SPREAD, MAX_SPREAD);

    this._raycaster.set(from, dir);
    this._raycaster.far = SHOOT_RANGE;
    const hits = this._raycaster.intersectObjects(this.hitMeshes, false);
    if (hits.length) {
      const h = hits[0];
      const normal = h.face
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      return { to: h.point.clone(), impact: { point: h.point.clone(), normal } };
    }
    return { to: from.addScaledVector(dir, SHOOT_RANGE), impact: null };
  }
}
