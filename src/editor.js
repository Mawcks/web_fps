/**
 * Top-down editing.
 *
 * Click-drag on the map to mark a rectangle of cells. The current tool decides
 * whether that carves rooms out of the rock or fills them back in. A live
 * preview quad tracks the hover cell and the active drag.
 */

import * as THREE from 'three';

export class Editor {
  constructor({ camera, domElement, scene, onCarve }) {
    this.camera = camera;
    this.domElement = domElement;
    this.onCarve = onCarve;
    this.tool = 'carve';
    this.enabled = false;

    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._dragStart = null;
    this._rect = null; // { x, z, w, d } in cells

    this._preview = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthTest: false }),
    );
    this._preview.rotation.x = -Math.PI / 2;
    this._preview.position.y = 0.12;
    this._preview.renderOrder = 10;
    this._preview.visible = false;
    scene.add(this._preview);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    domElement.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this._dragStart = null;
      this._rect = null;
      this._preview.visible = false;
    }
  }

  setTool(tool) {
    this.tool = tool;
  }

  _cell(e) {
    const r = this.domElement.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      return null;
    }
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    this._raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hit = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._plane, hit)) return null;
    return { x: Math.floor(hit.x), z: Math.floor(hit.z) };
  }

  _rectFrom(a, b) {
    const x = Math.min(a.x, b.x);
    const z = Math.min(a.z, b.z);
    return { x, z, w: Math.abs(a.x - b.x) + 1, d: Math.abs(a.z - b.z) + 1 };
  }

  _showPreview(rect) {
    const carve = this.tool === 'carve';
    this._preview.material.color.setHex(carve ? 0x6cf0ff : 0xff6b6b);
    this._preview.scale.set(rect.w, rect.d, 1);
    this._preview.position.x = rect.x + rect.w / 2;
    this._preview.position.z = rect.z + rect.d / 2;
    this._preview.visible = true;
  }

  _onDown(e) {
    if (!this.enabled || e.button !== 0) return;
    const c = this._cell(e);
    if (!c) return;
    this._dragStart = c;
    this._rect = this._rectFrom(c, c);
    this._showPreview(this._rect);
  }

  _onMove(e) {
    if (!this.enabled) return;
    const c = this._cell(e);
    if (this._dragStart) {
      if (c) {
        this._rect = this._rectFrom(this._dragStart, c);
        this._showPreview(this._rect);
      }
    } else if (c) {
      this._showPreview({ x: c.x, z: c.z, w: 1, d: 1 });
    } else {
      this._preview.visible = false;
    }
  }

  _onUp(e) {
    if (!this.enabled || e.button !== 0 || !this._dragStart) return;
    const rect = this._rect;
    this._dragStart = null;
    this._rect = null;
    if (rect) {
      this.onCarve(this.tool === 'carve' ? 'carve' : 'fill', rect.x, rect.z, rect.w, rect.d);
    }
  }
}
