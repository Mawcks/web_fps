/**
 * Web FPS — carve rooms out of solid rock from a top-down view, then drop into
 * first person to explore and shoot.
 *
 * main.js wires the pieces together: the carve Grid, the top-down Editor, the
 * FPS Player, mesh building, mode switching, targets, and save/load.
 */

import * as THREE from 'three';
import { Grid } from './grid.js';
import { buildPlayWorld, buildEditView, disposeGroup, makeTarget } from './builder.js';
import { Editor } from './editor.js';
import { Player } from './player.js';
import { settings, loadSettings, pointerSpeedFor, mountSettings } from './settings.js';

const EDIT_CAM_HEIGHT = 100;
const TRANSITION_MS = 900;
const TARGET_COUNT = 10;
const SAVE_KEY = 'web_fps_map_v1';

let scene, renderer, container;
let perspCam, orthoCam, activeCamera;
let grid, editor, player, settingsUI;
let gridHelper, editGroup;
let playGroup = null;
let targetsGroup;

let mode = 'edit'; // 'edit' | 'play'
let transition = null; // { start, fromPos, toPos, fromQuat, toQuat }
let playFog; // applied only in play mode — would hide the top-down editor
const targets = [];
const tracers = [];
let muzzleFlash = 0;
let score = 0;
let shots = 0;
let hits = 0;
let firing = false;

const keys = new Set();
const editView = { cx: 0, cz: 0, halfW: 24, halfD: 24, zoom: 1 };
let lastTime = performance.now();

const ui = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  container = document.getElementById('canvas-container');

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0d);
  playFog = new THREE.Fog(0x0a0a0d, 14, 46);

  const aspect = container.clientWidth / container.clientHeight;
  perspCam = new THREE.PerspectiveCamera(76, aspect, 0.05, 500);
  orthoCam = new THREE.OrthographicCamera(-24, 24, 24, -24, 0.1, 1000);
  orthoCam.up.set(0, 0, -1);
  scene.add(perspCam);
  activeCamera = orthoCam;

  scene.add(new THREE.AmbientLight(0x6b7080, 0.55));
  const hemi = new THREE.HemisphereLight(0xaab4c8, 0x2a2620, 0.5);
  scene.add(hemi);

  gridHelper = new THREE.GridHelper(600, 600, 0x3a4452, 0x232a33);
  gridHelper.position.y = 0.08;
  scene.add(gridHelper);

  grid = new Grid();
  loadFromStorage() || seedStarterMap();

  editGroup = buildEditView(grid);
  scene.add(editGroup);

  targetsGroup = new THREE.Group();
  scene.add(targetsGroup);

  player = new Player(perspCam, renderer.domElement);
  player.gun.visible = false;
  player.torch.visible = false;

  editor = new Editor({
    camera: orthoCam,
    domElement: renderer.domElement,
    grid,
    scene,
    onChange: onGridChanged,
  });
  editor.setEnabled(true);

  loadSettings();
  applySettings();
  settingsUI = mountSettings({ onChange: applySettings });

  cacheUi();
  bindUi();
  bindInput();
  window.addEventListener('resize', onResize);

  player.controls.addEventListener('unlock', onPointerUnlock);

  fitEditCamera();
  refreshHud();
  animate();
}

/** A small two-room-and-corridor map so a first run isn't an empty void. */
function seedStarterMap() {
  grid.addOp('carve', -8, -6, 16, 12);
  grid.addOp('carve', 8, -2, 7, 4);
  grid.addOp('carve', 15, -7, 11, 14);
}

/** Push the current settings into the player (sensitivity + keybinds). */
function applySettings() {
  player.binds = settings.binds;
  player.controls.pointerSpeed = pointerSpeedFor(settings.valorantSens);
}

function cacheUi() {
  for (const id of [
    'modeBtn', 'toolBtn', 'undoBtn', 'clearBtn', 'saveBtn', 'loadBtn',
    'exportBtn', 'importBtn', 'gridToggle', 'hud', 'scorePanel', 'lockOverlay',
    'crosshair', 'settingsBtn',
  ]) {
    ui[id] = document.getElementById(id);
  }
  ui.fileInput = document.createElement('input');
  ui.fileInput.type = 'file';
  ui.fileInput.accept = 'application/json,.json';
  ui.fileInput.style.display = 'none';
  document.body.appendChild(ui.fileInput);
}

function bindUi() {
  ui.modeBtn.addEventListener('click', toggleMode);
  ui.toolBtn.addEventListener('click', toggleTool);
  ui.undoBtn.addEventListener('click', () => {
    if (grid.undo()) onGridChanged();
  });
  ui.clearBtn.addEventListener('click', () => {
    grid.clear();
    onGridChanged();
    fitEditCamera();
    flash('Cleared');
  });
  ui.saveBtn.addEventListener('click', saveToStorage);
  ui.loadBtn.addEventListener('click', () => {
    if (loadFromStorage()) {
      onGridChanged();
      fitEditCamera();
      flash('Loaded');
    } else {
      flash('Nothing saved');
    }
  });
  ui.exportBtn.addEventListener('click', exportMap);
  ui.importBtn.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', importMap);
  ui.gridToggle.addEventListener('change', () => {
    gridHelper.visible = ui.gridToggle.checked && mode === 'edit';
  });
  ui.lockOverlay.addEventListener('click', () => {
    if (mode === 'play' && !transition) player.lock();
  });
  ui.settingsBtn.addEventListener('click', () => {
    if (player.isLocked) player.unlock();
    settingsUI.open();
  });
}

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return; // typing in a field, not playing
    if (mode === 'play' && player.isLocked) {
      if (e.code === 'Tab' || Object.values(settings.binds).includes(e.code)) e.preventDefault();
    }
    keys.add(e.code);

    if (e.code === 'KeyP' && !transition) toggleMode();
    if (mode === 'edit') {
      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (grid.undo()) onGridChanged();
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveToStorage();
      }
      if (e.code === 'Digit1') setTool('carve');
      if (e.code === 'Digit2') setTool('erase');
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (mode === 'play' && !transition) {
      if (player.isLocked) firing = true;
      else player.lock();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) firing = false;
  });

  renderer.domElement.addEventListener('wheel', (e) => {
    if (mode !== 'edit') return;
    e.preventDefault();
    editView.zoom = THREE.MathUtils.clamp(editView.zoom * (e.deltaY > 0 ? 1.12 : 0.89), 0.3, 4);
    applyOrthoFrustum();
  }, { passive: false });
}

/** Rebuild the editor schematic after any change to the grid. */
function onGridChanged() {
  scene.remove(editGroup);
  disposeGroup(editGroup);
  editGroup = buildEditView(grid);
  editGroup.visible = mode === 'edit';
  scene.add(editGroup);
  refreshHud();
}

/** ====== Mode switching ====== */
function toggleMode() {
  if (transition) return;
  if (mode === 'edit') enterPlay();
  else enterEdit();
}

function toggleTool() {
  setTool(editor.tool === 'carve' ? 'erase' : 'carve');
}

function setTool(tool) {
  editor.setTool(tool);
  ui.toolBtn.textContent = tool === 'carve' ? 'Tool: Carve' : 'Tool: Erase';
  ui.toolBtn.classList.toggle('erase', tool === 'erase');
}

function enterPlay() {
  if (grid.isEmpty) {
    flash('Carve a room first');
    return;
  }

  const built = buildPlayWorld(grid);
  if (playGroup) {
    scene.remove(playGroup);
    disposeGroup(playGroup);
  }
  playGroup = built.group;
  scene.add(playGroup);
  player.setColliders(built.colliders);

  const spawn = grid.spawnPoint();
  player.spawnAt(spawn.x, spawn.z, 0);
  spawnTargets();

  mode = 'play';
  scene.fog = playFog;
  editor.setEnabled(false);
  editGroup.visible = false;
  gridHelper.visible = false;
  playGroup.visible = true;
  targetsGroup.visible = true;
  player.gun.visible = true;
  player.torch.visible = true;
  document.body.classList.add('playing');

  score = 0;
  shots = 0;
  hits = 0;

  // swoop the camera down from the top-down view into the player's eyes
  const downQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
  const fwdQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
  transition = {
    start: performance.now(),
    fromPos: new THREE.Vector3(spawn.x, EDIT_CAM_HEIGHT, spawn.z),
    toPos: player.camera.position.clone(),
    fromQuat: downQuat,
    toQuat: fwdQuat,
  };
  activeCamera = perspCam;
  ui.modeBtn.textContent = 'Exit Play (P)';
  refreshHud();
}

function enterEdit() {
  mode = 'edit';
  transition = null;
  firing = false;
  scene.fog = null;
  player.enabled = false;
  player.unlock();
  player.gun.visible = false;
  player.torch.visible = false;

  if (playGroup) playGroup.visible = false;
  targetsGroup.visible = false;
  clearTargets();
  editGroup.visible = true;
  gridHelper.visible = ui.gridToggle.checked;
  editor.setEnabled(true);
  document.body.classList.remove('playing');
  ui.lockOverlay.classList.remove('visible');

  activeCamera = orthoCam;
  fitEditCamera();
  ui.modeBtn.textContent = 'Enter Play (P)';
  refreshHud();
}

function onPointerUnlock() {
  if (mode === 'play' && !transition) {
    firing = false;
    ui.lockOverlay.classList.add('visible');
  }
}

/** ====== Targets & shooting ====== */
function spawnTargets() {
  clearTargets();
  const points = grid.randomOpenPoints(TARGET_COUNT);
  for (const p of points) {
    const t = makeTarget();
    placeTarget(t, p);
    t.userData.alive = true;
    t.userData.popT = 0;
    targetsGroup.add(t);
    targets.push(t);
  }
}

function placeTarget(t, p) {
  t.position.set(p.x, 0.9 + Math.random() * 1.6, p.z);
  t.userData.baseY = t.position.y;
  t.scale.setScalar(1);
}

function clearTargets() {
  for (const t of targets) {
    targetsGroup.remove(t);
    t.geometry.dispose();
  }
  targets.length = 0;
}

function handleFiring(dt) {
  if (!firing || !player.isLocked) return;
  const liveTargets = targets.filter((t) => t.userData.alive);
  const shot = player.shoot(liveTargets);
  if (!shot) return;
  shots++;
  muzzleFlash = 1;
  spawnTracer(shot.from, shot.to);
  if (shot.target) {
    hits++;
    score++;
    shot.target.userData.alive = false;
    shot.target.userData.popT = 0.2;
    ui.crosshair.classList.add('hit');
    setTimeout(() => ui.crosshair.classList.remove('hit'), 110);
  }
  refreshHud();
}

function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffe49a, transparent: true, opacity: 0.95 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, life: 0.09, max: 0.09 });
}

function updateTargets(dt) {
  const now = performance.now() * 0.001;
  for (const t of targets) {
    if (t.userData.alive) {
      t.rotation.y += t.userData.spin * dt;
      t.rotation.x += t.userData.spin * 0.4 * dt;
      t.position.y = t.userData.baseY + Math.sin(now * 2 + t.userData.bobPhase) * 0.12;
    } else if (t.userData.popT > 0) {
      t.userData.popT -= dt;
      const f = Math.max(0, t.userData.popT / 0.2);
      t.scale.setScalar(f * f);
      t.rotation.y += 12 * dt;
      if (t.userData.popT <= 0) {
        const p = grid.randomOpenPoints(1)[0];
        if (p) placeTarget(t, p);
        t.userData.alive = true;
      }
    }
  }
}

function updateTracers(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life -= dt;
    if (tr.life <= 0) {
      scene.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
      tracers.splice(i, 1);
    } else {
      tr.line.material.opacity = (tr.life / tr.max) * 0.95;
    }
  }
}

/** ====== Save / load ====== */
function saveToStorage() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(grid.toJSON()));
  flash('Saved');
}

function loadFromStorage() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  try {
    grid.loadJSON(JSON.parse(raw));
    return true;
  } catch (err) {
    console.warn('Failed to load saved map:', err);
    return false;
  }
}

function exportMap() {
  const blob = new Blob([JSON.stringify(grid.toJSON(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'web-fps-map.json';
  a.click();
  URL.revokeObjectURL(url);
  flash('Exported');
}

function importMap(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      grid.loadJSON(JSON.parse(reader.result));
      onGridChanged();
      fitEditCamera();
      flash('Imported');
    } catch (err) {
      flash('Bad map file');
      console.warn(err);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/** ====== Camera & layout ====== */
function fitEditCamera() {
  const b = grid.bounds();
  if (b) {
    editView.cx = (b.minX + b.maxX) / 2;
    editView.cz = (b.minZ + b.maxZ) / 2;
    editView.halfW = (b.maxX - b.minX) / 2 + 6;
    editView.halfD = (b.maxZ - b.minZ) / 2 + 6;
  } else {
    editView.cx = 0;
    editView.cz = 0;
    editView.halfW = 24;
    editView.halfD = 24;
  }
  editView.zoom = 1;
  orthoCam.position.set(editView.cx, EDIT_CAM_HEIGHT, editView.cz);
  orthoCam.lookAt(editView.cx, 0, editView.cz);
  applyOrthoFrustum();
}

function applyOrthoFrustum() {
  const aspect = container.clientWidth / container.clientHeight;
  let halfW = editView.halfW;
  let halfH = editView.halfD;
  if (halfW / aspect > halfH) halfH = halfW / aspect;
  else halfW = halfH * aspect;
  halfW *= editView.zoom;
  halfH *= editView.zoom;
  orthoCam.left = -halfW;
  orthoCam.right = halfW;
  orthoCam.top = halfH;
  orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();
}

function onResize() {
  const aspect = container.clientWidth / container.clientHeight;
  perspCam.aspect = aspect;
  perspCam.updateProjectionMatrix();
  applyOrthoFrustum();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

/** ====== HUD ====== */
function refreshHud() {
  if (mode === 'edit') {
    const cells = grid.open.size;
    ui.hud.textContent = cells
      ? `EDIT · ${cells} cells carved · ${editor.tool} tool`
      : 'EDIT · drag on the map to carve your first room';
    ui.scorePanel.classList.remove('visible');
  } else {
    const acc = shots ? Math.round((hits / shots) * 100) : 0;
    ui.scorePanel.textContent = `Score ${score}   ·   Accuracy ${acc}%`;
    ui.scorePanel.classList.add('visible');
    ui.hud.textContent = 'PLAY · WASD move · Shift sprint · C crouch · Space jump · click to shoot';
  }
}

let flashTimer = null;
function flash(msg) {
  ui.hud.textContent = msg;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(refreshHud, 1100);
}

/** ====== Loop ====== */
function updateTransition() {
  const t = Math.min(1, (performance.now() - transition.start) / TRANSITION_MS);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
  perspCam.position.lerpVectors(transition.fromPos, transition.toPos, e);
  perspCam.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, e);
  if (t >= 1) {
    transition = null;
    player.spawnAt(player.feet.x, player.feet.z, 0);
    player.lock();
    ui.lockOverlay.classList.toggle('visible', !player.isLocked);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (transition) {
    updateTransition();
  } else if (mode === 'play') {
    player.enabled = player.isLocked;
    handleFiring(dt);
    player.update(dt, keys);
    updateTargets(dt);
    updateTracers(dt);
    ui.lockOverlay.classList.toggle('visible', !player.isLocked);
  } else {
    player.update(dt, keys); // keeps the gun viewmodel settled
  }

  muzzleFlash = Math.max(0, muzzleFlash - dt * 9);
  player.torch.intensity = 1.0 + muzzleFlash * 2.4;

  renderer.render(scene, activeCamera);
}

// Dev-only inspection handle (stripped from production builds by Vite).
if (import.meta.env.DEV) {
  window.__wf = {
    get mode() { return mode; },
    get grid() { return grid; },
    get player() { return player; },
    get scene() { return scene; },
    get targets() { return targets; },
    get transition() { return transition; },
    get renderer() { return renderer; },
    enterPlay,
    enterEdit,
  };
}
