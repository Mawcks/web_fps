/**
 * Web FPS — carve rooms out of solid rock from a top-down view, then drop into
 * first person to explore and shoot.
 *
 * main.js wires the pieces together: the carve Grid, the top-down Editor, the
 * FPS Player, mesh building, mode switching, targets, and save/load.
 */

import * as THREE from 'three';
import { Grid } from './grid.js';
import { buildPlayWorld, buildEditView, disposeGroup } from './builder.js';
import { Editor } from './editor.js';
import { Player } from './player.js';
import { settings, loadSettings, pointerSpeedFor, mountSettings, applyCrosshairTo } from './settings.js';
import { Net } from './net.js';
import { Avatars } from './avatars.js';
import { Decals } from './decals.js';

const EDIT_CAM_HEIGHT = 100;
const TRANSITION_MS = 900;
const SAVE_KEY = 'web_fps_map_v1';

let scene, renderer, container;
let perspCam, orthoCam, activeCamera;
let grid, editor, player, settingsUI, net, avatars, decals;
let gridHelper, editGroup;
let playGroup = null;

let mode = 'edit'; // 'edit' | 'play'
let transition = null; // { start, fromPos, toPos, fromQuat, toQuat }
let playFog; // applied only in play mode — would hide the top-down editor
const tracers = [];
let muzzleFlash = 0;
let firing = false;

const keys = new Set();
const editView = { cx: 0, cz: 0, halfW: 24, halfD: 24, zoom: 1 };
let lastTime = performance.now();
let lastMoveSent = 0;
let mpFirstState = false;

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

  player = new Player(perspCam, renderer.domElement);
  player.gun.visible = false;
  player.torch.visible = false;

  net = new Net();
  avatars = new Avatars(scene);
  avatars.setVisible(false);
  decals = new Decals(scene);
  decals.setVisible(false);

  editor = new Editor({
    camera: orthoCam,
    domElement: renderer.domElement,
    scene,
    onCarve: handleCarveIntent,
  });
  editor.setEnabled(true);

  loadSettings();

  cacheUi();
  applySettings();
  settingsUI = mountSettings({ onChange: applySettings });
  bindUi();
  bindMpUi();
  bindInput();
  setupNet();
  window.addEventListener('resize', onResize);

  player.controls.addEventListener('unlock', onPointerUnlock);

  ui.mpName.value = localStorage.getItem('web_fps_name') || '';
  ui.mpServer.value = defaultServerUrl();
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    ui.mpCode.value = roomParam.toUpperCase().slice(0, 4);
    openMpModal();
  }

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

/** Push the current settings into the player and crosshair. */
function applySettings() {
  player.binds = settings.binds;
  player.controls.pointerSpeed = pointerSpeedFor(settings.valorantSens);
  applyCrosshairTo(ui.crosshair, settings.crosshair);
}

function cacheUi() {
  for (const id of [
    'modeBtn', 'toolBtn', 'undoBtn', 'clearBtn', 'saveBtn', 'loadBtn',
    'exportBtn', 'importBtn', 'gridToggle', 'hud', 'scorePanel', 'lockOverlay',
    'crosshair', 'settingsBtn', 'mpBtn', 'mpPanel', 'mpModal', 'mpCloseBtn',
    'mpJoinView', 'mpRoomView', 'mpName', 'mpServer', 'mpCreateBtn', 'mpCode',
    'mpJoinBtn', 'mpError', 'mpRoomCode', 'mpCopyBtn', 'mpLeaveBtn',
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
  ui.undoBtn.addEventListener('click', doUndo);
  ui.clearBtn.addEventListener('click', () => {
    if (net.inRoom) {
      flash('Clear is off in multiplayer');
      return;
    }
    grid.clear();
    onGridChanged();
    fitEditCamera();
    flash('Cleared');
  });
  ui.saveBtn.addEventListener('click', saveToStorage);
  ui.loadBtn.addEventListener('click', () => {
    if (net.inRoom) {
      flash('Load is off in multiplayer');
      return;
    }
    if (loadFromStorage()) {
      onGridChanged();
      fitEditCamera();
      flash('Loaded');
    } else {
      flash('Nothing saved');
    }
  });
  ui.exportBtn.addEventListener('click', exportMap);
  ui.importBtn.addEventListener('click', () => {
    if (net.inRoom) {
      flash('Import is off in multiplayer');
      return;
    }
    ui.fileInput.click();
  });
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
        doUndo();
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

  rebuildPlayWorld();

  const spawn = grid.spawnPoint();
  player.spawnAt(spawn.x, spawn.z, 0);

  mode = 'play';
  scene.fog = playFog;
  editor.setEnabled(false);
  editGroup.visible = false;
  gridHelper.visible = false;
  playGroup.visible = true;
  avatars.setVisible(true);
  decals.clear();
  decals.setVisible(true);
  player.gun.visible = true;
  player.torch.visible = true;
  document.body.classList.add('playing');

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
  avatars.setVisible(false);
  decals.setVisible(false);
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

/** ====== Shooting ====== */
function handleFiring() {
  if (!firing || !player.isLocked) return;
  const shot = player.shoot();
  if (!shot) return;
  muzzleFlash = 1;
  spawnTracer(shot.to);
  if (shot.impact) decals.add(shot.impact.point, shot.impact.normal);
}

function spawnTracer(to) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffe9a6, transparent: true, opacity: 1 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, life: 0.06, max: 0.06, to: to.clone() });
}

function updateTracers(dt) {
  if (tracers.length === 0) return;
  const muzzle = player.getMuzzle(); // near-end tracks the gun, not a stale point
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life -= dt;
    if (tr.life <= 0) {
      scene.remove(tr.line);
      tr.line.geometry.dispose();
      tr.line.material.dispose();
      tracers.splice(i, 1);
    } else {
      const pos = tr.line.geometry.attributes.position;
      pos.setXYZ(0, muzzle.x, muzzle.y, muzzle.z);
      pos.setXYZ(1, tr.to.x, tr.to.y, tr.to.z);
      pos.needsUpdate = true;
      tr.line.material.opacity = tr.life / tr.max;
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

/** ====== Multiplayer ====== */
function defaultServerUrl() {
  const fromParam = new URLSearchParams(location.search).get('server');
  if (fromParam) return fromParam;
  if (location.port === '5173') return 'ws://localhost:8787'; // Vite dev server
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function handleCarveIntent(type, x, z, w, d) {
  if (net.inRoom) {
    net.carve(type, x, z, w, d);
  } else {
    grid.addOp(type, x, z, w, d);
    onGridChanged();
  }
}

function doUndo() {
  if (net.inRoom) net.undo();
  else if (grid.undo()) onGridChanged();
}

/** Rebuild the 3D play world from the current grid (also used on live edits). */
function rebuildPlayWorld() {
  const built = buildPlayWorld(grid);
  if (playGroup) {
    scene.remove(playGroup);
    disposeGroup(playGroup);
  }
  playGroup = built.group;
  playGroup.visible = mode === 'play';
  scene.add(playGroup);
  player.setColliders(built.colliders);
  player.hitMeshes = playGroup.children;
}

function setupNet() {
  net.on('joined', () => {
    mpFirstState = true;
    avatars.clear();
    showMpRoomView();
  });
  net.on('state', (m) => {
    grid.loadJSON({ ops: m.ops });
    onGridChanged();
    if (mode === 'play') rebuildPlayWorld();
    renderRoster(m.players);
    if (mpFirstState) {
      mpFirstState = false;
      fitEditCamera();
    }
  });
  net.on('reject', (m) => flash(m.reason));
  net.on('error', (m) => {
    mpError(m.reason);
    net.disconnect();
  });
  net.on('moved', (m) => avatars.set(m.id, m));
  net.on('left', (m) => avatars.remove(m.id));
  net.on('closed', (m) => {
    resetMpUi();
    if (m.wasInRoom) flash('Disconnected from the room');
  });
  net.on('neterror', (m) => mpError((m && m.reason) || 'Connection error'));
}

function bindMpUi() {
  ui.mpBtn.addEventListener('click', () => {
    if (player.isLocked) player.unlock();
    openMpModal();
  });
  ui.mpModal.addEventListener('click', () => ui.mpModal.classList.remove('open'));
  ui.mpModal.querySelector('.settings-card').addEventListener('click', (e) => e.stopPropagation());
  ui.mpCloseBtn.addEventListener('click', () => ui.mpModal.classList.remove('open'));
  ui.mpCreateBtn.addEventListener('click', () => connectToRoom(true));
  ui.mpJoinBtn.addEventListener('click', () => connectToRoom(false));
  ui.mpCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectToRoom(false);
  });
  ui.mpLeaveBtn.addEventListener('click', () => {
    net.disconnect();
    resetMpUi();
    flash('Left the room');
  });
  ui.mpCopyBtn.addEventListener('click', copyInviteLink);
}

function connectToRoom(create) {
  const name = (ui.mpName.value.trim() || 'Player').slice(0, 16);
  ui.mpName.value = name;
  localStorage.setItem('web_fps_name', name);
  mpError('');
  const url = ui.mpServer.value.trim() || defaultServerUrl();
  if (create) {
    net.connect(url, { create: true, name });
  } else {
    const code = ui.mpCode.value.trim().toUpperCase();
    if (code.length !== 4) {
      mpError('Enter the 4-character room code');
      return;
    }
    net.connect(url, { room: code, name });
  }
}

function openMpModal() {
  if (net.inRoom) showMpRoomView();
  else showMpJoinView();
  ui.mpModal.classList.add('open');
}

function showMpJoinView() {
  ui.mpJoinView.hidden = false;
  ui.mpRoomView.hidden = true;
}

function showMpRoomView() {
  ui.mpJoinView.hidden = true;
  ui.mpRoomView.hidden = false;
  ui.mpRoomCode.textContent = net.room || '----';
}

function resetMpUi() {
  avatars.clear();
  ui.mpPanel.hidden = true;
  showMpJoinView();
}

function mpError(text) {
  ui.mpError.textContent = text || '';
}

function copyInviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', net.room);
  const server = ui.mpServer.value.trim();
  if (server && server !== defaultServerUrl()) url.searchParams.set('server', server);
  navigator.clipboard.writeText(url.toString()).then(
    () => flash('Invite link copied'),
    () => flash('Copy failed'),
  );
}

function renderRoster(players) {
  if (!net.inRoom) {
    ui.mpPanel.hidden = true;
    return;
  }
  ui.mpPanel.hidden = false;
  ui.mpPanel.textContent = '';
  const head = document.createElement('div');
  head.className = 'mp-head';
  head.append('Room ');
  const code = document.createElement('b');
  code.textContent = net.room;
  head.append(code);
  ui.mpPanel.append(head);
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'mp-row' + (p.id === net.selfId ? ' self' : '');
    const dot = document.createElement('span');
    dot.className = 'mp-dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'mp-name';
    name.textContent = p.name;
    const bar = document.createElement('span');
    bar.className = 'mp-bar';
    const fill = document.createElement('i');
    fill.style.width = Math.min(100, (p.used / net.tileBudget) * 100) + '%';
    bar.append(fill);
    const tiles = document.createElement('span');
    tiles.className = 'mp-tiles';
    tiles.textContent = `${p.used} / ${net.tileBudget}`;
    row.append(dot, name, bar, tiles);
    ui.mpPanel.append(row);
  }
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
  } else {
    ui.hud.textContent = 'PLAY · WASD move · Shift sprint · C crouch · Space jump · P to edit';
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
    handleFiring();
    player.update(dt, keys);
    updateTracers(dt);
    ui.lockOverlay.classList.toggle('visible', !player.isLocked);
  } else {
    player.update(dt, keys); // keeps the gun viewmodel settled
  }

  if (net.inRoom) {
    avatars.update(dt);
    if (now - lastMoveSent > 80) {
      lastMoveSent = now;
      net.move(player.feet.x, player.feet.z, player.camera.rotation.y, mode === 'play' && !transition);
    }
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
    get transition() { return transition; },
    get renderer() { return renderer; },
    get net() { return net; },
    get avatars() { return avatars; },
    get decals() { return decals; },
    enterPlay,
    enterEdit,
  };
}
