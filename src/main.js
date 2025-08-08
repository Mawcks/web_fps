import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

/** ====== Config ====== */
const BLOCK_HEIGHT = 3;
const EDIT_CAM_HEIGHT = 120;
const TRANSITION_MS = 1000;

/** ====== State ====== */
let scene, renderer, controls;
let playMode = false;
let activeCamera;         // current camera used for render/raycast
let perspCam;             // perspective (play)
let orthoCam;             // orthographic (edit)

const keys = new Set();
const colliders = [];
const rectangles = [];

let gridHelper, groundMesh, drawPlane;
let dragStart = null;
let dragRectEl = null;

let hudEl, modeBtn, gridToggle, container;

const PLAYER = {
  height: 1.8,
  crouchHeight: 1.2,
  radius: 0.4,
  pos: new THREE.Vector3(0, 2, 5),
  velY: 0,
  onGround: false,

  // movement tuning
  walkSpeed: 4.6,
  crouchSpeed: 3.4,
  accel: 18.0,
  decel: 16.0,
  airAccel: 4.0,

  jump: 5.5,
  gravity: -14.0,
};

// horizontal velocity
const moveVel = new THREE.Vector3();

let lastTime = performance.now();

/** transition */
let transitioning = false;
let transitionStart = 0;
let camFrom = new THREE.Vector3();
let camTo = new THREE.Vector3();

/** ====== Init ====== */
document.addEventListener('DOMContentLoaded', () => {
  container = document.getElementById('canvas-container');
  modeBtn = document.getElementById('modeBtn');
  hudEl = document.getElementById('hud');
  gridToggle = document.getElementById('gridToggle');

  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  // scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0c0c);

  // cameras
  const aspect = container.clientWidth / container.clientHeight;
  perspCam = new THREE.PerspectiveCamera(75, aspect, 0.1, 2000);
  perspCam.position.set(PLAYER.pos.x, PLAYER.height, PLAYER.pos.z);

  const frustumSize = 200; // world units visible vertically in edit
  const halfW = (frustumSize * aspect) / 2;
  const halfH = frustumSize / 2;
  orthoCam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 2000);
  orthoCam.position.set(PLAYER.pos.x, EDIT_CAM_HEIGHT, PLAYER.pos.z);
  orthoCam.up.set(0, 0, -1);  // keep +Z down screen
  orthoCam.lookAt(PLAYER.pos.x, 0, PLAYER.pos.z);

  activeCamera = orthoCam; // start in EDIT

  // lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(10, 20, 10);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  scene.add(dir);

  // ground
  const groundGeo = new THREE.PlaneGeometry(500, 500);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0, roughness: 1 });
  groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  groundMesh.userData.isGround = true;
  scene.add(groundMesh);

  // draw plane
  const drawMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0 });
  drawPlane = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), drawMat);
  drawPlane.rotation.x = -Math.PI / 2;
  drawPlane.position.y = 0.01;
  drawPlane.userData.isDrawPlane = true;
  scene.add(drawPlane);

  // grid
  gridHelper = new THREE.GridHelper(500, 500, 0x4b4b4b, 0x2f2f2f);
  gridHelper.position.y = 0.02;
  gridHelper.visible = true;
  scene.add(gridHelper);

  // controls (for play)
  controls = new PointerLockControls(perspCam, renderer.domElement);
  controls.connect();

  // UI
  modeBtn.addEventListener('click', toggleMode);
  document.getElementById('saveBtn').addEventListener('click', saveLayout);
  document.getElementById('loadBtn').addEventListener('click', loadLayout);
  document.getElementById('clearBtn').addEventListener('click', clearLayout);
  gridToggle.addEventListener('change', () => (gridHelper.visible = gridToggle.checked));

  // keyboard
  window.addEventListener('keydown', (e) => {
    // prevent browser shortcuts in play (bookmark, find, etc.)
    if (playMode && controls.isLocked) {
      e.preventDefault();
    }

    keys.add(e.code);

    if (e.code === 'KeyP') toggleMode();

    // Save: only plain "S" in EDIT. Ctrl/Cmd+S saves anywhere.
    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveLayout();
    } else if (e.code === 'KeyS' && !playMode) {
      saveLayout();
    }

    if (e.code === 'KeyL' && !playMode) loadLayout(); // load only in edit
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !playMode) undoLast();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // mouse (edit)
  renderer.domElement.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // pointer lock try
  const tryLock = () => {
    if (playMode && !transitioning && !controls.isLocked) controls.lock();
  };
  renderer.domElement.addEventListener('click', tryLock);
  container.addEventListener('click', tryLock);

  // resize
  window.addEventListener('resize', onResize);

  // drag overlay
  dragRectEl = document.createElement('div');
  dragRectEl.id = 'dragRect';
  dragRectEl.style.display = 'none';
  dragRectEl.style.pointerEvents = 'none';
  container.appendChild(dragRectEl);

  updateHud();
  animate();
});

/** ====== Helpers ====== */
function onResize() {
  const aspect = container.clientWidth / container.clientHeight;
  // update persp
  perspCam.aspect = aspect;
  perspCam.updateProjectionMatrix();
  // update ortho
  const frustumSize = 200;
  const halfW = (frustumSize * aspect) / 2;
  const halfH = frustumSize / 2;
  orthoCam.left = -halfW; orthoCam.right = halfW;
  orthoCam.top = halfH; orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();

  renderer.setSize(container.clientWidth, container.clientHeight);
}

function updateHud() {
  hudEl.textContent = playMode
      ? 'Mode: PLAY — WASD (accel/decel), Space jump, Ctrl crouch, P to edit'
      : 'Mode: EDIT (Top-Down) — Click-drag to add walls. Ctrl+Z undo.';
}

function snap(v, step = 1) { return Math.round(v / step) * step; }

/** Use CANVAS rect for overlay alignment */
function worldToScreen(v) {
  const rect = renderer.domElement.getBoundingClientRect();
  const proj = v.clone().project(activeCamera);
  return {
    x: (proj.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-proj.y * 0.5 + 0.5) * rect.height + rect.top,
  };
}

function worldFromMouse(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  const ray = new THREE.Raycaster();
  ray.setFromCamera({ x, y }, activeCamera);
  const hits = ray.intersectObject(drawPlane, false);
  return hits.length ? hits[0].point.clone() : null;
}

/** ====== Mode Toggle & Transition ====== */
function toggleMode() {
  if (!playMode) {
    // EDIT -> PLAY
    playMode = true;
    transitioning = true;
    transitionStart = performance.now();
    camFrom.copy(orthoCam.position);
    camTo.set(PLAYER.pos.x, PLAYER.height, PLAYER.pos.z);
    // start play from above and zoom to player
    perspCam.position.copy(camFrom);
    perspCam.lookAt(camTo.x, camTo.y, camTo.z - 1);
    activeCamera = perspCam;
    modeBtn.textContent = 'Exit Play';
    gridHelper.visible = false;
  } else {
    // PLAY -> EDIT
    playMode = false;
    transitioning = false;
    controls.unlock();
    modeBtn.textContent = 'Enter Play';
    gridHelper.visible = gridToggle.checked;
    // pop back to top-down above current player x/z
    orthoCam.position.set(PLAYER.pos.x, EDIT_CAM_HEIGHT, PLAYER.pos.z);
    orthoCam.lookAt(PLAYER.pos.x, 0, PLAYER.pos.z);
    activeCamera = orthoCam;
  }
  updateHud();
}

/** ====== Edit Mode Drawing ====== */
function onMouseDown(e) {
  if (playMode || transitioning) return;
  const p = worldFromMouse(e);
  if (!p) return;
  dragStart = new THREE.Vector3(snap(p.x, 1), 0, snap(p.z, 1));
  showDragRect(e.clientX, e.clientY, 0, 0);
}
function onMouseMove(e) {
  if (playMode || transitioning || !dragStart) return;
  const p = worldFromMouse(e);
  if (!p) return;
  const end = new THREE.Vector3(snap(p.x, 1), 0, snap(p.z, 1));
  drawDragOverlay(dragStart, end);
}
function onMouseUp(e) {
  if (playMode || transitioning || !dragStart) return;
  const p = worldFromMouse(e);
  if (!p) { hideDragRect(); dragStart = null; return; }
  const end = new THREE.Vector3(snap(p.x, 1), 0, snap(p.z, 1));
  addRectFromCorners(dragStart, end, BLOCK_HEIGHT);
  dragStart = null;
  hideDragRect();
}

function addRectFromCorners(a, b, h) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  const w = Math.max(1, maxX - minX);
  const d = Math.max(1, maxZ - minZ);
  const mesh = makeBlock(minX + w / 2, h / 2, minZ + d / 2, w, h, d);
  scene.add(mesh);
  colliders.push(mesh);
  rectangles.push({ x: minX, z: minZ, w, d, h });
}

function undoLast() {
  if (rectangles.length === 0) return;
  rectangles.pop();
  const mesh = colliders.pop();
  if (mesh) scene.remove(mesh);
}

/** Drag overlay */
function showDragRect(x, y, w, h) {
  dragRectEl.style.display = 'block';
  dragRectEl.style.left = `${x}px`;
  dragRectEl.style.top = `${y}px`;
  dragRectEl.style.width = `${w}px`;
  dragRectEl.style.height = `${h}px`;
}
function hideDragRect() { dragRectEl.style.display = 'none'; }
function drawDragOverlay(a, b) {
  const corners = [
    new THREE.Vector3(a.x, 0, a.z),
    new THREE.Vector3(b.x, 0, a.z),
    new THREE.Vector3(b.x, 0, b.z),
    new THREE.Vector3(a.x, 0, b.z),
  ];
  const pts = corners.map(worldToScreen);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  dragRectEl.style.left = `${Math.min(...xs)}px`;
  dragRectEl.style.top = `${Math.min(...ys)}px`;
  dragRectEl.style.width = `${Math.max(0, Math.max(...xs) - Math.min(...xs))}px`;
  dragRectEl.style.height = `${Math.max(0, Math.max(...ys) - Math.min(...ys))}px`;
}

/** ====== Save / Load ====== */
function saveLayout() {
  localStorage.setItem('web_fps_layout', JSON.stringify(rectangles));
  flashHud('Saved.');
}
function loadLayout() {
  const raw = localStorage.getItem('web_fps_layout');
  if (!raw) { flashHud('Nothing saved.'); return; }
  clearLayout(true);
  const arr = JSON.parse(raw);
  for (const r of arr) {
    const mesh = makeBlock(r.x + r.w / 2, r.h / 2, r.z + r.d / 2, r.w, r.h, r.d);
    scene.add(mesh);
    colliders.push(mesh);
    rectangles.push(r);
  }
  flashHud('Loaded.');
}
function clearLayout(silent = false) {
  for (const m of colliders) scene.remove(m);
  colliders.length = 0;
  rectangles.length = 0;
  if (!silent) flashHud('Cleared.');
}
function flashHud(msg) {
  const prev = hudEl.textContent;
  hudEl.textContent = msg + ' ' + prev;
  setTimeout(updateHud, 900);
}

/** ====== Blocks / Colliders ====== */
function makeBlock(cx, cy, cz, w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.aabb = new THREE.Box3().setFromObject(mesh);
  return mesh;
}

/** ====== Movement & Physics ====== */
function getPlayerHalfExtents(crouching) {
  const h = (crouching ? PLAYER.crouchHeight : PLAYER.height);
  return new THREE.Vector3(PLAYER.radius, h * 0.5, PLAYER.radius);
}

function resolveCollisions(pos, half) {
  const playerMin = new THREE.Vector3(pos.x - half.x, pos.y - half.y, pos.z - half.z);
  const playerMax = new THREE.Vector3(pos.x + half.x, pos.y + half.y, pos.z + half.z);

  if (playerMin.y < 0) pos.y += (0 - playerMin.y);

  for (const m of colliders) {
    m.userData.aabb = m.userData.aabb || new THREE.Box3();
    m.userData.aabb.setFromObject(m);
    const a = m.userData.aabb;
    if (!a.intersectsBox(new THREE.Box3(playerMin, playerMax))) continue;

    const overlapX1 = a.max.x - playerMin.x;
    const overlapX2 = playerMax.x - a.min.x;
    const resolveX = (overlapX1 < overlapX2) ? overlapX1 : -overlapX2;

    const overlapY1 = a.max.y - playerMin.y;
    const overlapY2 = playerMax.y - a.min.y;
    const resolveY = (overlapY1 < overlapY2) ? overlapY1 : -overlapY2;

    const overlapZ1 = a.max.z - playerMin.z;
    const overlapZ2 = playerMax.z - a.min.z;
    const resolveZ = (overlapZ1 < overlapZ2) ? overlapZ1 : -overlapZ2;

    const ax = Math.abs(resolveX), ay = Math.abs(resolveY), az = Math.abs(resolveZ);
    if (ax <= ay && ax <= az) pos.x += resolveX;
    else if (ay <= ax && ay <= az) pos.y += resolveY;
    else pos.z += resolveZ;

    playerMin.set(pos.x - half.x, pos.y - half.y, pos.z - half.z);
    playerMax.set(pos.x + half.x, pos.y + half.y, pos.z + half.z);
  }

  return pos;
}

/** Accel/decel step */
function stepMovement(dt) {
  // forward from camera (flattened)
  const forward = new THREE.Vector3();
  perspCam.getWorldDirection(forward);
  forward.y = 0; forward.normalize();

  // RIGHT = forward x up  (fixes A/D)
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  // input
  const input = new THREE.Vector3(
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      0,
      (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0)
  );

  // world-space desired direction
  const desiredDir = new THREE.Vector3();
  desiredDir.addScaledVector(right, input.x);
  desiredDir.addScaledVector(forward, -input.z);
  if (desiredDir.lengthSq() > 0) desiredDir.normalize();

  const crouching = keys.has('ControlLeft') || keys.has('ControlRight');
  const maxSpeed = desiredDir.lengthSq() > 0 ? (crouching ? PLAYER.crouchSpeed : PLAYER.walkSpeed) : 0;

  const targetVel = desiredDir.clone().multiplyScalar(maxSpeed);

  const speedingUp = targetVel.lengthSq() > moveVel.lengthSq();
  const accelRate = PLAYER.onGround
      ? (speedingUp ? PLAYER.accel : PLAYER.decel)
      : PLAYER.airAccel;

  const alpha = 1 - Math.exp(-accelRate * dt);
  moveVel.lerp(targetVel, alpha);

  if (maxSpeed > 0 && moveVel.lengthSq() > maxSpeed * maxSpeed) moveVel.setLength(maxSpeed);
}

/** ====== Update & Loop ====== */
function update(dt) {
  if (transitioning) {
    const t = Math.min(1, (performance.now() - transitionStart) / TRANSITION_MS);
    const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
    // animate on perspCam
    perspCam.position.lerpVectors(camFrom, camTo, ease);
    perspCam.lookAt(camTo.x, camTo.y, camTo.z - 1);
    if (t >= 1) { transitioning = false; perspCam.position.copy(camTo); }
    return;
  }

  if (!playMode) return;

  stepMovement(dt);

  // gravity & jump
  PLAYER.velY += PLAYER.gravity * dt;
  if ((keys.has('Space') || keys.has('KeyJ')) && PLAYER.onGround) {
    PLAYER.velY = PLAYER.jump;
    PLAYER.onGround = false;
  }

  // candidate
  const pos = perspCam.position.clone();

  // horizontal
  pos.x += moveVel.x * dt;
  pos.z += moveVel.z * dt;
  pos.copy(resolveCollisions(pos, getPlayerHalfExtents(keys.has('ControlLeft') || keys.has('ControlRight'))));

  // vertical
  pos.y += PLAYER.velY * dt;
  const beforeY = pos.y;
  pos.copy(resolveCollisions(pos, getPlayerHalfExtents(keys.has('ControlLeft') || keys.has('ControlRight'))));
  if (pos.y === beforeY) {
    if (PLAYER.velY < 0) PLAYER.onGround = true;
    PLAYER.velY = 0;
  } else {
    PLAYER.onGround = false;
  }

  const minY = getPlayerHalfExtents(keys.has('ControlLeft') || keys.has('ControlRight')).y;
  if (pos.y < minY) { pos.y = minY; PLAYER.velY = 0; PLAYER.onGround = true; }

  perspCam.position.copy(pos);
  PLAYER.pos.copy(pos); // keep in sync for returning to edit
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  renderer.render(scene, activeCamera);
  update(dt);
}

/** pointer lock */
controls.addEventListener('unlock', () => { /* noop */ });

/** ====== Save / Load ====== */
function saveLayout() {
  localStorage.setItem('web_fps_layout', JSON.stringify(rectangles));
  flashHud('Saved.');
}
function loadLayout() {
  const raw = localStorage.getItem('web_fps_layout');
  if (!raw) { flashHud('Nothing saved.'); return; }
  clearLayout(true);
  const arr = JSON.parse(raw);
  for (const r of arr) {
    const mesh = makeBlock(r.x + r.w / 2, r.h / 2, r.z + r.d / 2, r.w, r.h, r.d);
    scene.add(mesh);
    colliders.push(mesh);
    rectangles.push(r);
  }
  flashHud('Loaded.');
}
function clearLayout(silent = false) {
  for (const m of colliders) scene.remove(m);
  colliders.length = 0;
  rectangles.length = 0;
  if (!silent) flashHud('Cleared.');
}
function flashHud(msg) {
  const prev = hudEl.textContent;
  hudEl.textContent = msg + ' ' + prev;
  setTimeout(updateHud, 900);
}

/** ====== Drag overlay utils ====== */
function showDragRect(x, y, w, h) {
  dragRectEl.style.display = 'block';
  dragRectEl.style.left = `${x}px`;
  dragRectEl.style.top = `${y}px`;
  dragRectEl.style.width = `${w}px`;
  dragRectEl.style.height = `${h}px`;
}
function hideDragRect() { dragRectEl.style.display = 'none'; }

/** ====== Blocks / Colliders ====== */
function makeBlock(cx, cy, cz, w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.aabb = new THREE.Box3().setFromObject(mesh);
  return mesh;
}

function drawDragOverlay(a, b) {
  const corners = [
    new THREE.Vector3(a.x, 0, a.z),
    new THREE.Vector3(b.x, 0, a.z),
    new THREE.Vector3(b.x, 0, b.z),
    new THREE.Vector3(a.x, 0, b.z),
  ];
  const pts = corners.map(worldToScreen);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  dragRectEl.style.left = `${Math.min(...xs)}px`;
  dragRectEl.style.top = `${Math.min(...ys)}px`;
  dragRectEl.style.width = `${Math.max(0, Math.max(...xs) - Math.min(...xs))}px`;
  dragRectEl.style.height = `${Math.max(0, Math.max(...ys) - Math.min(...ys))}px`;
}
