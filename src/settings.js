/**
 * Settings — mouse sensitivity and keybinds, plus the settings modal.
 *
 * Sensitivity is stored as a Valorant sens value so it can be matched against
 * other shooters. Pointer Lock's `unadjustedMovement` (Chromium) gives raw
 * mouse counts, which makes the conversion exact rather than approximate.
 */

const STORE_KEY = 'web_fps_settings_v1';

// Valorant turns 0.07 degrees per mouse count at 1.0 sensitivity.
const VALORANT_YAW = 0.07;
// PointerLockControls yaws by `movementX * 0.002 * pointerSpeed` radians.
const PLC_FACTOR = 0.002;
const DEG2RAD = Math.PI / 180;

const DEFAULT_BINDS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',
};

const ACTIONS = [
  ['forward', 'Move forward'],
  ['back', 'Move back'],
  ['left', 'Strafe left'],
  ['right', 'Strafe right'],
  ['jump', 'Jump'],
  ['sprint', 'Sprint'],
  ['crouch', 'Crouch'],
];

export const settings = {
  valorantSens: 0.8,
  dpi: 400,
  binds: { ...DEFAULT_BINDS },
};

/** The PointerLockControls.pointerSpeed that reproduces a given Valorant sens. */
export function pointerSpeedFor(valorantSens) {
  return (VALORANT_YAW * valorantSens * DEG2RAD) / PLC_FACTOR;
}

/** Physical centimetres per 360° turn — the cross-game sensitivity metric. */
export function cm360For(valorantSens, dpi) {
  const countsPer360 = 360 / (VALORANT_YAW * valorantSens);
  return (countsPer360 / dpi) * 2.54;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Number.isFinite(d.valorantSens) && d.valorantSens > 0) settings.valorantSens = d.valorantSens;
    if (Number.isFinite(d.dpi) && d.dpi > 0) settings.dpi = d.dpi;
    if (d.binds) {
      for (const action of Object.keys(DEFAULT_BINDS)) {
        if (typeof d.binds[action] === 'string') settings.binds[action] = d.binds[action];
      }
    }
  } catch (err) {
    console.warn('Settings load failed:', err);
  }
}

export function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5) + ' Arrow';
  const named = {
    Space: 'Space',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt',
    AltRight: 'R-Alt',
    Tab: 'Tab',
    Enter: 'Enter',
    Backquote: '`',
  };
  return named[code] || code;
}

/**
 * Build and wire the settings modal.
 * @param {{ onChange: () => void }} opts - called whenever a setting changes
 * @returns {{ open: () => void, close: () => void }}
 */
export function mountSettings({ onChange }) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'settingsModal';
  modal.innerHTML = `
    <div class="settings-card">
      <div class="settings-head">
        <strong>Settings</strong>
        <button class="settings-x" type="button" aria-label="Close">&times;</button>
      </div>
      <section>
        <h3>Mouse</h3>
        <label class="settings-field">
          <span>Valorant sensitivity</span>
          <input id="set-sens" type="number" step="0.01" min="0.01" />
        </label>
        <label class="settings-field">
          <span>Mouse DPI</span>
          <input id="set-dpi" type="number" step="50" min="100" />
        </label>
        <p class="settings-note" id="set-cm360"></p>
        <p class="settings-note">
          Raw mouse input is used in Chrome/Edge, so this matches your in-game feel 1:1.
          CS2 players: convert your sens to the Valorant equivalent.
        </p>
      </section>
      <section>
        <h3>Keybinds</h3>
        <div id="set-binds" class="bind-list"></div>
      </section>
      <div class="settings-foot">
        <button id="set-reset" type="button">Reset to defaults</button>
        <button id="set-done" type="button" class="primary">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const sensInput = modal.querySelector('#set-sens');
  const dpiInput = modal.querySelector('#set-dpi');
  const cm360El = modal.querySelector('#set-cm360');
  const bindList = modal.querySelector('#set-binds');

  modal.querySelector('.settings-card').addEventListener('click', (e) => e.stopPropagation());
  modal.addEventListener('click', () => close());
  modal.querySelector('.settings-x').addEventListener('click', () => close());
  modal.querySelector('#set-done').addEventListener('click', () => close());

  function refreshCm360() {
    cm360El.textContent = `≈ ${cm360For(settings.valorantSens, settings.dpi).toFixed(1)} cm / 360°`;
  }

  let rebinding = false;
  function startRebind(action, btn) {
    if (rebinding) return;
    rebinding = true;
    btn.textContent = 'press a key…';
    btn.classList.add('listening');
    const handler = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // keep the keypress out of the game input
      window.removeEventListener('keydown', handler, true);
      rebinding = false;
      btn.classList.remove('listening');
      if (e.code !== 'Escape') {
        settings.binds[action] = e.code;
        saveSettings();
        onChange();
      }
      btn.textContent = keyLabel(settings.binds[action]);
    };
    window.addEventListener('keydown', handler, true);
  }

  function refreshBinds() {
    bindList.innerHTML = '';
    for (const [action, label] of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'bind-row';
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = keyLabel(settings.binds[action]);
      btn.addEventListener('click', () => startRebind(action, btn));
      row.append(name, btn);
      bindList.appendChild(row);
    }
  }

  sensInput.addEventListener('input', () => {
    const v = parseFloat(sensInput.value);
    if (Number.isFinite(v) && v > 0) {
      settings.valorantSens = v;
      saveSettings();
      onChange();
      refreshCm360();
    }
  });
  dpiInput.addEventListener('input', () => {
    const v = parseFloat(dpiInput.value);
    if (Number.isFinite(v) && v > 0) {
      settings.dpi = v;
      saveSettings();
      refreshCm360();
    }
  });
  modal.querySelector('#set-reset').addEventListener('click', () => {
    settings.valorantSens = 0.8;
    settings.dpi = 400;
    settings.binds = { ...DEFAULT_BINDS };
    saveSettings();
    onChange();
    syncFields();
  });

  function syncFields() {
    sensInput.value = settings.valorantSens;
    dpiInput.value = settings.dpi;
    refreshCm360();
    refreshBinds();
  }

  function open() {
    syncFields();
    modal.classList.add('open');
  }
  function close() {
    modal.classList.remove('open');
  }

  return { open, close };
}
