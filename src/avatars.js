/**
 * Remote-player avatars for multiplayer play mode.
 *
 * Each other player who is currently in play mode is drawn as a simple colored
 * figure with a floating name tag. Network position updates are low-frequency,
 * so positions are eased toward their targets every frame.
 */

import * as THREE from 'three';

const noseMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });

export class Avatars {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.map = new Map(); // playerId -> avatar record
  }

  _buildFigure(color) {
    const figure = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.95, 4, 10), mat);
    body.position.y = 0.85;
    figure.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat);
    head.position.y = 1.62;
    figure.add(head);

    // small nose so facing direction is readable
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.22), noseMat);
    nose.position.set(0, 1.62, -0.3);
    figure.add(nose);

    return figure;
  }

  _buildNameTag(name, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(name).width;
    ctx.fillStyle = 'rgba(8, 9, 12, 0.72)';
    ctx.fillRect(128 - textW / 2 - 16, 14, textW + 32, 36);
    ctx.fillStyle = color;
    ctx.fillText(name, 128, 33);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }),
    );
    sprite.scale.set(1.7, 0.42, 1);
    sprite.position.y = 2.15;
    sprite.renderOrder = 6;
    return sprite;
  }

  /** Create or update an avatar from a network update. */
  set(id, data) {
    let a = this.map.get(id);
    if (!a) {
      const figure = this._buildFigure(data.color || '#cccccc');
      figure.add(this._buildNameTag(data.name || 'Player', data.color || '#cccccc'));
      this.group.add(figure);
      a = { figure, x: data.x || 0, z: data.z || 0, yaw: data.yaw || 0 };
      this.map.set(id, a);
    }
    a.tx = data.x;
    a.tz = data.z;
    a.tyaw = data.yaw;
    a.figure.visible = !!data.playing;
  }

  remove(id) {
    const a = this.map.get(id);
    if (!a) return;
    this.group.remove(a.figure);
    a.figure.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
    });
    this.map.delete(id);
  }

  clear() {
    for (const id of [...this.map.keys()]) this.remove(id);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  /** Ease every avatar toward its latest network position. */
  update(dt) {
    const k = 1 - Math.exp(-13 * dt);
    for (const a of this.map.values()) {
      if (a.tx === undefined) continue;
      a.x += (a.tx - a.x) * k;
      a.z += (a.tz - a.z) * k;
      let dyaw = a.tyaw - a.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      a.yaw += dyaw * k;
      a.figure.position.set(a.x, 0, a.z);
      a.figure.rotation.y = a.yaw;
    }
  }
}
