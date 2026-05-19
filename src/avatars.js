/**
 * Remote-player avatars for multiplayer play mode.
 *
 * Each other player in play mode is drawn as a colored figure with a name tag.
 * Position snapshots are buffered and rendered at a fixed delay behind server
 * time, interpolating between the two snapshots that straddle the render time.
 * That fixed, reconstructable delay is what lets the server reproduce exactly
 * what the shooter saw.
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

  /** Buffer a position snapshot for an avatar (creating it on first sight). */
  set(id, data) {
    let a = this.map.get(id);
    if (!a) {
      const figure = this._buildFigure(data.color || '#cccccc');
      figure.add(this._buildNameTag(data.name || 'Player', data.color || '#cccccc'));
      this.group.add(figure);
      a = { figure, snaps: [], x: 0, z: 0, alive: true, playing: false };
      this.map.set(id, a);
    }
    if (Number.isFinite(data.st)) {
      a.snaps.push({ st: data.st, x: data.x || 0, z: data.z || 0, yaw: data.yaw || 0 });
      if (a.snaps.length > 40) a.snaps.shift();
    }
    a.playing = !!data.playing;
    a.figure.visible = a.playing && a.alive;
  }

  /** Show/hide an avatar by alive state — a dead player's figure is hidden. */
  setAlive(id, alive) {
    const a = this.map.get(id);
    if (!a) return;
    a.alive = alive;
    a.figure.visible = a.playing && a.alive;
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

  /** Render every avatar at `renderSt` (server time) by interpolating snapshots. */
  update(renderSt) {
    for (const a of this.map.values()) {
      const s = a.snaps;
      if (s.length === 0) continue;
      let x, z, yaw;
      if (renderSt <= s[0].st) {
        ({ x, z, yaw } = s[0]);
      } else if (renderSt >= s[s.length - 1].st) {
        ({ x, z, yaw } = s[s.length - 1]);
      } else {
        let i = s.length - 1;
        while (i > 0 && s[i - 1].st > renderSt) i--;
        const b = s[i - 1];
        const c = s[i];
        const f = (renderSt - b.st) / ((c.st - b.st) || 1);
        let dyaw = c.yaw - b.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        x = b.x + (c.x - b.x) * f;
        z = b.z + (c.z - b.z) * f;
        yaw = b.yaw + dyaw * f;
      }
      a.x = x;
      a.z = z;
      a.figure.position.set(x, 0, z);
      a.figure.rotation.y = yaw;
    }
  }
}
