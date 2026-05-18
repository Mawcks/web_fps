/**
 * Turns a Grid into Three.js geometry.
 *
 *  - buildPlayWorld:  the explorable 3D dungeon (floor, ceiling, walls) plus
 *                     AABB colliders for the player.
 *  - buildEditView:   a flat top-down schematic — solid rock vs carved rooms.
 *  - makeTarget:      a shootable target for play mode.
 */

import * as THREE from 'three';
import { ROOM_HEIGHT } from './grid.js';

export const WALL_THICKNESS = 0.25;

const matFloor = new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 0.97, metalness: 0 });
const matCeiling = new THREE.MeshStandardMaterial({ color: 0x33312e, roughness: 1, metalness: 0 });
const matWall = new THREE.MeshStandardMaterial({ color: 0x817b72, roughness: 0.92, metalness: 0 });

const matSolid = new THREE.MeshBasicMaterial({ color: 0x14141a });
const matCarved = new THREE.MeshBasicMaterial({ color: 0x4a5b6e });

/** Free every geometry under a group so rebuilds don't leak GPU memory. */
export function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
  });
}

function wallSpanToBox(seg) {
  const t = WALL_THICKNESS;
  let sx, sz, cx, cz;
  if (seg.axis === 'x') {
    sx = seg.end - seg.start;
    sz = t;
    cx = (seg.start + seg.end) / 2;
    cz = seg.side === 'n' ? seg.line - t / 2 : seg.line + t / 2;
  } else {
    sx = t;
    sz = seg.end - seg.start;
    cx = seg.side === 'w' ? seg.line - t / 2 : seg.line + t / 2;
    cz = (seg.start + seg.end) / 2;
  }
  return { sx, sz, cx, cz };
}

/**
 * Build the playable 3D world.
 * @returns {{ group: THREE.Group, colliders: THREE.Box3[], hasGeometry: boolean }}
 */
export function buildPlayWorld(grid) {
  const group = new THREE.Group();
  const colliders = [];
  const bounds = grid.bounds();
  if (!bounds) return { group, colliders, hasGeometry: false };

  const margin = 1.5;
  const w = bounds.maxX - bounds.minX + margin * 2;
  const d = bounds.maxZ - bounds.minZ + margin * 2;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(midX, 0, midZ);
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matCeiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(midX, ROOM_HEIGHT, midZ);
  group.add(ceiling);

  for (const seg of grid.walls()) {
    const { sx, sz, cx, cz } = wallSpanToBox(seg);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, ROOM_HEIGHT, sz), matWall);
    mesh.position.set(cx, ROOM_HEIGHT / 2, cz);
    group.add(mesh);
    colliders.push(
      new THREE.Box3(
        new THREE.Vector3(cx - sx / 2, 0, cz - sz / 2),
        new THREE.Vector3(cx + sx / 2, ROOM_HEIGHT, cz + sz / 2),
      ),
    );
  }

  return { group, colliders, hasGeometry: true };
}

/** Build the flat top-down editor schematic. */
export function buildEditView(grid) {
  const group = new THREE.Group();

  const solid = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), matSolid);
  solid.rotation.x = -Math.PI / 2;
  solid.position.y = 0;
  group.add(solid);

  const cells = [...grid.open];
  if (cells.length) {
    const positions = new Float32Array(cells.length * 12);
    const normals = new Float32Array(cells.length * 12);
    const indices = new Uint32Array(cells.length * 6);
    let vp = 0;
    let ip = 0;
    let base = 0;
    for (const k of cells) {
      const comma = k.indexOf(',');
      const x = Number(k.slice(0, comma));
      const z = Number(k.slice(comma + 1));
      // four corners of the cell on the y=0 plane
      positions.set([x, 0, z, x + 1, 0, z, x + 1, 0, z + 1, x, 0, z + 1], vp);
      normals.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], vp);
      indices.set([base, base + 2, base + 1, base, base + 3, base + 2], ip);
      vp += 12;
      ip += 6;
      base += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    const carved = new THREE.Mesh(geo, matCarved);
    carved.position.y = 0.05;
    group.add(carved);
  }

  return group;
}
