/**
 * Bullet-hole decals.
 *
 * Each wall/floor/ceiling hit stamps a small textured quad aligned to the
 * surface. A fixed pool caps the count — the oldest hole is recycled once
 * the pool is full.
 */

import * as THREE from 'three';

const MAX_DECALS = 48;

function makeHoleTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(6, 6, 8, 0.95)');
  g.addColorStop(0.5, 'rgba(26, 22, 19, 0.6)');
  g.addColorStop(1, 'rgba(26, 22, 19, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  ctx.beginPath();
  ctx.arc(32, 32, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}

export class Decals {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this._geo = new THREE.PlaneGeometry(1, 1);
    this._mat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, // sit on top of the wall without z-fighting
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.pool = [];
  }

  /** Stamp a bullet hole at a world-space impact point + surface normal. */
  add(point, normal) {
    let m;
    if (this.pool.length >= MAX_DECALS) {
      m = this.pool.shift();
    } else {
      m = new THREE.Mesh(this._geo, this._mat);
      this.group.add(m);
    }
    const size = 0.12 + Math.random() * 0.07;
    m.scale.set(size, size, size);
    m.position.copy(point).addScaledVector(normal, 0.012);
    m.lookAt(point.clone().add(normal));
    m.rotateZ(Math.random() * Math.PI * 2);
    this.pool.push(m);
  }

  clear() {
    for (const m of this.pool) this.group.remove(m);
    this.pool.length = 0;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }
}
