(function () {
  'use strict';

  if (window.JKPiPPlayer && window.JKPiPPlayer.__initialized) {
    return;
  }

  const STORAGE_KEY_LAYOUT = 'jk_pip_layout_v1';
  const SIZE_PRESETS = {
    compact: { width: 420, height: 290 },
    default: { width: 560, height: 376 },
    large: { width: 760, height: 496 },
  };
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 220;

  const pipState = {
    open: false,
    preset: 'default',
    width: SIZE_PRESETS.default.width,
    height: SIZE_PRESETS.default.height,
    x: null,
    y: null,
    dragging: false,
    resizing: false,
    dragPointerId: null,
    resizePointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    resizeStartX: 0,
    resizeStartY: 0,
    resizeStartW: 0,
    resizeStartH: 0,
    scrubbing: false,
    currentDemoUrl: '',
    currentDemoTitle: '',
    prewarmStarted: false,
    playerScriptLoaded: false,
    playerScriptPromise: null,
    uiSyncInterval: null,
    observer: null,
  };

  function loadSavedLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.preset && SIZE_PRESETS[parsed.preset]) {
          pipState.preset = parsed.preset;
        }
        if (typeof parsed.width === 'number' && parsed.width >= MIN_WIDTH) {
          pipState.width = parsed.width;
        }
        if (typeof parsed.height === 'number' && parsed.height >= MIN_HEIGHT) {
          pipState.height = parsed.height;
        }
        if (typeof parsed.x === 'number' && Number.isFinite(parsed.x)) {
          pipState.x = parsed.x;
        }
        if (typeof parsed.y === 'number' && Number.isFinite(parsed.y)) {
          pipState.y = parsed.y;
        }
      }
    } catch (_) {}
  }

  function saveLayout() {
    try {
      localStorage.setItem(
        STORAGE_KEY_LAYOUT,
        JSON.stringify({
          preset: pipState.preset,
          width: pipState.width,
          height: pipState.height,
          x: pipState.x,
          y: pipState.y,
        })
      );
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('jk-pip-styles')) return;
    const style = document.createElement('style');
    style.id = 'jk-pip-styles';
    style.textContent = `
      .jk-play-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin-left: 5px;
        padding: 1px 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.3;
        color: #ffffff !important;
        background: #1f6feb;
        border: 1px solid #388bfd;
        border-radius: 4px;
        cursor: pointer;
        text-decoration: none !important;
        vertical-align: middle;
        user-select: none;
        transition: background 0.12s ease, transform 0.08s ease;
      }
      .jk-play-btn:hover {
        background: #388bfd;
      }
      .jk-play-btn:active {
        transform: scale(0.97);
      }
      .jk-icon-svg {
        display: inline-block;
        vertical-align: middle;
        flex-shrink: 0;
        pointer-events: none;
      }
      #jk-pip-card {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 560px;
        height: 376px;
        min-width: 320px;
        min-height: 220px;
        z-index: 99999;
        display: none;
        flex-direction: column;
        background: #0d1117;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        box-sizing: border-box;
      }
      #jk-pip-card.jk-pip-open {
        display: flex;
      }
      #jk-pip-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 32px;
        padding: 0 8px;
        background: #161b22;
        border-bottom: 1px solid #30363d;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        flex-shrink: 0;
      }
      #jk-pip-header:active {
        cursor: grabbing;
      }
      #jk-pip-header:focus-visible {
        outline: 2px solid #58a6ff;
        outline-offset: -2px;
      }
      #jk-pip-title {
        font-weight: 600;
        color: #f0f6fc;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 60%;
        pointer-events: none;
      }
      .jk-pip-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .jk-pip-hdr-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
        cursor: pointer;
        line-height: 1.2;
      }
      .jk-pip-hdr-btn:hover,
      .jk-pip-hdr-btn.active {
        background: #30363d;
        color: #ffffff;
        border-color: #58a6ff;
      }
      #jk-pip-close {
        background: #da3633;
        border-color: #f85149;
        color: #ffffff;
        font-weight: 700;
      }
      #jk-pip-close:hover {
        background: #f85149;
      }
      #jk-pip-viewport {
        position: relative;
        flex: 1 1 auto;
        width: 100%;
        background: #000000;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #jk-pip-viewport canvas#jk-canvas {
        width: 100%;
        height: 100%;
        display: block;
        background: #000000;
      }
      #jk-pip-status-overlay {
        position: absolute;
        left: 8px;
        top: 8px;
        padding: 3px 8px;
        border-radius: 4px;
        background: rgba(13, 17, 23, 0.82);
        border: 1px solid rgba(48, 54, 61, 0.85);
        color: #58a6ff;
        font-size: 11px;
        pointer-events: none;
        display: none;
      }
      #jk-pip-controls {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 8px;
        background: #161b22;
        border-top: 1px solid #30363d;
        flex-shrink: 0;
        user-select: none;
      }
      .jk-pip-timeline-row {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }
      #jk-pip-seek {
        flex: 1 1 auto;
        height: 5px;
        cursor: pointer;
        accent-color: #58a6ff;
      }
      #jk-pip-time {
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        color: #8b949e;
        min-width: 74px;
        text-align: right;
      }
      .jk-pip-buttons-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        flex-wrap: wrap;
      }
      .jk-pip-btn-group {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .jk-pip-ctrl-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: 3px 7px;
        font-size: 11px;
        cursor: pointer;
        line-height: 1.2;
      }
      .jk-pip-ctrl-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-pip-ctrl-btn.active {
        background: #1f6feb;
        border-color: #58a6ff;
        color: #ffffff;
      }
      .jk-pip-select {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: 2px 4px;
        font-size: 11px;
        cursor: pointer;
      }
      #jk-pip-volume {
        width: 58px;
        height: 4px;
        cursor: pointer;
        accent-color: #58a6ff;
      }
      #jk-pip-resize-handle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        touch-action: none;
        user-select: none;
        z-index: 10;
        background: linear-gradient(135deg, transparent 50%, #58a6ff 50%);
        opacity: 0.7;
      }
      #jk-pip-resize-handle:hover {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  function clampPosition(x, y, width, height) {
    const vw = Math.max(window.innerWidth || 800, MIN_WIDTH);
    const vh = Math.max(window.innerHeight || 600, MIN_HEIGHT);
    const w = Math.min(width, vw);
    const h = Math.min(height, vh);
    const clampedX = Math.max(0, Math.min(vw - w, Math.round(x)));
    const clampedY = Math.max(0, Math.min(vh - h, Math.round(y)));
    return { x: clampedX, y: clampedY };
  }

  function clampSize(width, height) {
    const vw = Math.max(window.innerWidth || 800, MIN_WIDTH);
    const vh = Math.max(window.innerHeight || 600, MIN_HEIGHT);
    const w = Math.max(MIN_WIDTH, Math.min(vw - 16, Math.round(width)));
    const h = Math.max(MIN_HEIGHT, Math.min(vh - 16, Math.round(height)));
    return { width: w, height: h };
  }

  function applyCardGeometry() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const dims = clampSize(pipState.width, pipState.height);
    pipState.width = dims.width;
    pipState.height = dims.height;
    card.style.width = dims.width + 'px';
    card.style.height = dims.height + 'px';

    if (typeof pipState.x === 'number' && typeof pipState.y === 'number') {
      const pos = clampPosition(pipState.x, pipState.y, dims.width, dims.height);
      pipState.x = pos.x;
      pipState.y = pos.y;
      card.style.left = pos.x + 'px';
      card.style.top = pos.y + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    } else {
      card.style.right = '16px';
      card.style.bottom = '16px';
      card.style.left = 'auto';
      card.style.top = 'auto';
    }

    ['compact', 'default', 'large'].forEach((p) => {
      const btn = document.getElementById('jk-pip-size-' + p);
      if (btn) {
        btn.classList.toggle('active', pipState.preset === p);
      }
    });

    const player = window.JKDemoPlayer || window.OpenJKPlayer;
    if (player && typeof player.resize === 'function') {
      player.resize();
    }
  }

  function syncCoordsFromDOM() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    pipState.x = rect.left;
    pipState.y = rect.top;
    pipState.width = rect.width || pipState.width;
    pipState.height = rect.height || pipState.height;
  }

  function formatTimeMMSS(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return mins + ':' + (secs < 10 ? '0' + secs : String(secs));
  }

  function createPiPDOM() {
    if (document.getElementById('jk-pip-card')) {
      return document.getElementById('jk-pip-card');
    }
    injectStyles();
    loadSavedLayout();

    const card = document.createElement('div');
    card.id = 'jk-pip-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'JKA Demo Player');
    card.hidden = true;

    card.innerHTML = `
      <div id="jk-pip-header" class="jk-pip-header" tabindex="0" role="slider" aria-label="Drag player card">
        <span id="jk-pip-title" class="jk-pip-title">JKA Demo Player</span>
        <div class="jk-pip-header-actions">
          <button type="button" id="jk-pip-size-compact" class="jk-pip-hdr-btn jk-pip-preset-btn" data-size-preset="compact" title="Compact size">S</button>
          <button type="button" id="jk-pip-size-default" class="jk-pip-hdr-btn jk-pip-preset-btn active" data-size-preset="default" title="Default size">M</button>
          <button type="button" id="jk-pip-size-large" class="jk-pip-hdr-btn jk-pip-preset-btn" data-size-preset="large" title="Large size">L</button>
          <button type="button" id="jk-pip-close" class="jk-pip-hdr-btn" title="Close player" aria-label="Close player"><svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>
        </div>
      </div>
      <div id="jk-pip-viewport">
        <canvas id="jk-canvas" width="640" height="360" tabindex="-1"></canvas>
        <div id="jk-pip-status-overlay">Loading demo...</div>
      </div>
      <div id="jk-pip-controls">
        <div class="jk-pip-timeline-row">
          <input type="range" id="jk-pip-seek" min="0" max="1000" step="1" value="0" aria-label="Seek timeline" />
          <span id="jk-pip-time">0:00 / 0:00</span>
        </div>
        <div class="jk-pip-buttons-row">
          <div class="jk-pip-btn-group">
            <button type="button" id="jk-pip-play-pause" class="jk-pip-ctrl-btn" title="Play / Pause">Pause</button>
            <button type="button" id="jk-pip-start-over" class="jk-pip-ctrl-btn" title="Start Over (0:00)">0:00</button>
            <button type="button" id="jk-pip-loop" class="jk-pip-ctrl-btn active" title="Loop Demo" aria-pressed="true">Loop: On</button>
          </div>
          <div class="jk-pip-btn-group">
            <select id="jk-pip-speed" class="jk-pip-select" aria-label="Playback speed" title="Playback speed">
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
          </div>
          <div class="jk-pip-btn-group">
            <button type="button" id="jk-pip-mute" class="jk-pip-ctrl-btn" title="Mute / Unmute">Mute</button>
            <input type="range" id="jk-pip-volume" min="0" max="1" step="0.01" value="0.8" aria-label="Volume" />
            <button type="button" id="jk-pip-fullscreen" class="jk-pip-ctrl-btn" title="Fullscreen" aria-label="Fullscreen"><svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg></button>
          </div>
        </div>
      </div>
      <div id="jk-pip-resize-handle" class="jk-pip-resize-handle" title="Resize player"></div>
    `;

    document.body.appendChild(card);
    bindPiPEvents(card);
    applyCardGeometry();
    return card;
  }

  function bindPiPEvents(card) {
    const header = card.querySelector('#jk-pip-header');
    const resizeHandle = card.querySelector('#jk-pip-resize-handle');
    const closeBtn = card.querySelector('#jk-pip-close');
    const playPauseBtn = card.querySelector('#jk-pip-play-pause');
    const startOverBtn = card.querySelector('#jk-pip-start-over');
    const loopBtn = card.querySelector('#jk-pip-loop');
    const seekInput = card.querySelector('#jk-pip-seek');
    const speedSelect = card.querySelector('#jk-pip-speed');
    const muteBtn = card.querySelector('#jk-pip-mute');
    const volumeInput = card.querySelector('#jk-pip-volume');
    const fullscreenBtn = card.querySelector('#jk-pip-fullscreen');

    // Header dragging via Pointer Events
    header.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest('button')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      syncCoordsFromDOM();
      pipState.dragging = true;
      pipState.dragPointerId = e.pointerId;
      const rect = card.getBoundingClientRect();
      pipState.dragOffsetX = e.clientX - rect.left;
      pipState.dragOffsetY = e.clientY - rect.top;
      if (typeof header.setPointerCapture === 'function') {
        try {
          header.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      e.preventDefault();
    });

    const onHeaderPointerMove = (e) => {
      if (!pipState.dragging) return;
      if (pipState.dragPointerId !== null && e.pointerId !== pipState.dragPointerId) return;
      const nextX = e.clientX - pipState.dragOffsetX;
      const nextY = e.clientY - pipState.dragOffsetY;
      const pos = clampPosition(nextX, nextY, pipState.width, pipState.height);
      pipState.x = pos.x;
      pipState.y = pos.y;
      card.style.left = pos.x + 'px';
      card.style.top = pos.y + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    };

    const endHeaderDrag = (e) => {
      if (!pipState.dragging) return;
      if (e && pipState.dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== pipState.dragPointerId) {
        return;
      }
      pipState.dragging = false;
      if (e && typeof header.releasePointerCapture === 'function' && pipState.dragPointerId !== null) {
        try {
          header.releasePointerCapture(pipState.dragPointerId);
        } catch (_) {}
      }
      pipState.dragPointerId = null;
      saveLayout();
    };

    header.addEventListener('pointermove', onHeaderPointerMove);
    window.addEventListener('pointermove', onHeaderPointerMove);
    header.addEventListener('pointerup', endHeaderDrag);
    window.addEventListener('pointerup', endHeaderDrag);
    header.addEventListener('pointercancel', endHeaderDrag);
    window.addEventListener('pointercancel', endHeaderDrag);

    // Keyboard accessibility on header (Arrow keys move card by 20px)
    header.addEventListener('keydown', (e) => {
      const step = 20;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        syncCoordsFromDOM();
        if (e.key === 'ArrowLeft') pipState.x -= step;
        if (e.key === 'ArrowRight') pipState.x += step;
        if (e.key === 'ArrowUp') pipState.y -= step;
        if (e.key === 'ArrowDown') pipState.y += step;
        applyCardGeometry();
        saveLayout();
        e.preventDefault();
      }
    });

    // Resize handle via Pointer Events
    resizeHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      syncCoordsFromDOM();
      pipState.resizing = true;
      pipState.resizePointerId = e.pointerId;
      pipState.resizeStartX = e.clientX;
      pipState.resizeStartY = e.clientY;
      pipState.resizeStartW = pipState.width;
      pipState.resizeStartH = pipState.height;
      pipState.preset = 'custom';
      if (typeof resizeHandle.setPointerCapture === 'function') {
        try {
          resizeHandle.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      e.preventDefault();
      e.stopPropagation();
    });

    const onResizePointerMove = (e) => {
      if (!pipState.resizing) return;
      if (pipState.resizePointerId !== null && e.pointerId !== pipState.resizePointerId) return;
      const dw = e.clientX - pipState.resizeStartX;
      const dh = e.clientY - pipState.resizeStartY;
      const dims = clampSize(pipState.resizeStartW + dw, pipState.resizeStartH + dh);
      pipState.width = dims.width;
      pipState.height = dims.height;
      applyCardGeometry();
    };

    const endResizeDrag = (e) => {
      if (!pipState.resizing) return;
      if (e && pipState.resizePointerId !== null && e.pointerId !== undefined && e.pointerId !== pipState.resizePointerId) {
        return;
      }
      pipState.resizing = false;
      if (e && typeof resizeHandle.releasePointerCapture === 'function' && pipState.resizePointerId !== null) {
        try {
          resizeHandle.releasePointerCapture(pipState.resizePointerId);
        } catch (_) {}
      }
      pipState.resizePointerId = null;
      saveLayout();
    };

    resizeHandle.addEventListener('pointermove', onResizePointerMove);
    window.addEventListener('pointermove', onResizePointerMove);
    resizeHandle.addEventListener('pointerup', endResizeDrag);
    window.addEventListener('pointerup', endResizeDrag);
    resizeHandle.addEventListener('pointercancel', endResizeDrag);
    window.addEventListener('pointercancel', endResizeDrag);

    // Size preset buttons
    ['compact', 'default', 'large'].forEach((presetName) => {
      const btn = card.querySelector('#jk-pip-size-' + presetName);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          setSizePreset(presetName);
        });
      }
    });

    // Close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePiP();
    });

    // Play/Pause
    playPauseBtn.addEventListener('click', () => {
      togglePause();
    });

    // Start Over (0:00)
    startOverBtn.addEventListener('click', () => {
      startOver();
    });

    // Loop toggle
    loopBtn.addEventListener('click', () => {
      toggleLoop();
    });

    // Timeline seek slider (value in milliseconds [0, durationMs])
    seekInput.addEventListener('pointerdown', () => {
      pipState.scrubbing = true;
    });
    const finishScrub = () => {
      if (!pipState.scrubbing) return;
      pipState.scrubbing = false;
    };
    seekInput.addEventListener('pointerup', finishScrub);
    seekInput.addEventListener('pointercancel', finishScrub);
    let lastScrubMs = -1;
    let lastScrubAt = 0;
    seekInput.addEventListener('input', () => {
      const val = parseFloat(seekInput.value);
      if (Number.isFinite(val)) {
        const ms = Math.round(val);
        lastScrubMs = ms;
        lastScrubAt = Date.now();
        seekToMs(ms);
      }
    });
    seekInput.addEventListener('change', () => {
      pipState.scrubbing = false;
      const val = parseFloat(seekInput.value);
      if (Number.isFinite(val)) {
        const ms = Math.round(val);
        if (ms !== lastScrubMs || Date.now() - lastScrubAt > 100) {
          seekToMs(ms);
        } else {
          updateControlState();
        }
      }
    });

    // Speed select (0.25x, 0.5x, 1x, 2x, 4x)
    if (speedSelect) {
      speedSelect.addEventListener('change', () => {
        const speed = parseFloat(speedSelect.value);
        if (Number.isFinite(speed) && speed > 0) {
          setSpeed(speed);
        }
      });
    }

    // Mute & Volume
    muteBtn.addEventListener('click', () => {
      toggleMute();
    });

    const handleVolumeEvent = () => {
      const rawVal = parseFloat(volumeInput.value);
      if (Number.isFinite(rawVal)) {
        const maxVal = parseFloat(volumeInput.max || '1');
        const normalized = maxVal > 1.5 ? rawVal / 100 : rawVal;
        setVolume(normalized);
      }
    };
    volumeInput.addEventListener('input', handleVolumeEvent);
    volumeInput.addEventListener('change', handleVolumeEvent);

    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
      toggleFullscreen();
    });

    // Keep within viewport on window resize
    window.addEventListener('resize', () => {
      if (pipState.open) {
        applyCardGeometry();
      }
    });
  }

  function getPlayer() {
    return window.JKDemoPlayer || window.OpenJKPlayer || null;
  }

  function updateControlState() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const player = getPlayer();
    if (!player) return;

    const status = typeof player.getStatus === 'function' ? player.getStatus() : {};
    const rawMod = window.Module || (typeof player.getModule === 'function' ? player.getModule() : null);
    const mod =
      rawMod && (!rawMod.Asyncify || rawMod.Asyncify.state === 0)
        ? rawMod
        : null;

    const isPaused =
      mod && typeof mod._JK_DemoIsPaused === 'function'
        ? mod._JK_DemoIsPaused() === 1
        : Boolean(status.isPaused);
    const playPauseBtn = document.getElementById('jk-pip-play-pause');
    if (playPauseBtn) {
      playPauseBtn.textContent = isPaused ? 'Play' : 'Pause';
    }

    const loopEnabled =
      mod && typeof mod._JK_DemoGetLoop === 'function'
        ? mod._JK_DemoGetLoop() === 1
        : typeof player.getLoop === 'function'
        ? player.getLoop()
        : true;
    const loopBtn = document.getElementById('jk-pip-loop');
    if (loopBtn) {
      loopBtn.textContent = loopEnabled ? 'Loop: On' : 'Loop: Off';
      loopBtn.classList.toggle('active', Boolean(loopEnabled));
      loopBtn.setAttribute('aria-pressed', loopEnabled ? 'true' : 'false');
    }

    const curSpeed =
      mod && typeof mod._JK_DemoGetSpeed === 'function'
        ? mod._JK_DemoGetSpeed()
        : typeof status.speed === 'number'
        ? status.speed
        : 1.0;
    const speedSelect = document.getElementById('jk-pip-speed');
    if (speedSelect && document.activeElement !== speedSelect) {
      const presets = [0.25, 0.5, 1, 2, 4];
      let closest = 1;
      let minDiff = Infinity;
      for (const p of presets) {
        const d = Math.abs(p - curSpeed);
        if (d < minDiff) {
          minDiff = d;
          closest = p;
        }
      }
      speedSelect.value = String(closest);
    }

    const isMuted =
      mod && typeof mod._JK_DemoIsMuted === 'function'
        ? mod._JK_DemoIsMuted() === 1
        : Boolean(status.muted);
    const curVol =
      mod && typeof mod._JK_DemoGetVolume === 'function'
        ? mod._JK_DemoGetVolume()
        : typeof status.volume === 'number'
        ? status.volume
        : 0.8;
    const muteBtn = document.getElementById('jk-pip-mute');
    if (muteBtn) {
      muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('active', Boolean(isMuted));
    }
    const volInput = document.getElementById('jk-pip-volume');
    if (volInput && document.activeElement !== volInput) {
      volInput.value = String(isMuted ? 0 : curVol);
    }

    const durationMs =
      mod && typeof mod._JK_DemoGetDurationMs === 'function'
        ? mod._JK_DemoGetDurationMs()
        : typeof player.getDurationMs === 'function'
        ? player.getDurationMs()
        : 0;
    const elapsedMs =
      mod && typeof mod._JK_DemoGetCurrentTimeMs === 'function'
        ? Math.max(0, mod._JK_DemoGetCurrentTimeMs())
        : typeof player.getCurrentTimeMs === 'function'
        ? Math.max(0, player.getCurrentTimeMs())
        : 0;

    const timeEl = document.getElementById('jk-pip-time');
    if (timeEl) {
      timeEl.textContent = formatTimeMMSS(elapsedMs) + ' / ' + formatTimeMMSS(durationMs);
    }

    const seekInput = document.getElementById('jk-pip-seek');
    if (seekInput && !pipState.scrubbing) {
      const maxMs = durationMs > 0 ? durationMs : 1000;
      seekInput.max = String(maxMs);
      seekInput.value = String(Math.min(maxMs, Math.max(0, Math.round(elapsedMs))));
    }
  }

  function ensurePlayerScriptLoaded() {
    if (window.JKDemoPlayer || window.OpenJKPlayer) {
      pipState.playerScriptLoaded = true;
      return Promise.resolve(getPlayer());
    }
    if (pipState.playerScriptPromise) {
      return pipState.playerScriptPromise;
    }

    // Configure player.js to prewarm in background muted without auto-playing 1.51ef9.dm_26
    window.JKDemoConfig = Object.assign(
      {
        preload: true,
        preloadOnly: true,
        autoPlay: false,
        muted: true,
        scriptUrl: '/jkplayer/openjk.js',
        wasmUrl: '/jkplayer/openjk.wasm',
      },
      window.JKDemoConfig || {}
    );

    pipState.playerScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src*="/jkplayer/player.js"]');
      if (existing) {
        const check = setInterval(() => {
          if (getPlayer()) {
            clearInterval(check);
            pipState.playerScriptLoaded = true;
            resolve(getPlayer());
          }
        }, 50);
        return;
      }
      const script = document.createElement('script');
      script.src = '/jkplayer/player.js';
      script.async = true;
      script.onload = () => {
        pipState.playerScriptLoaded = true;
        resolve(getPlayer());
      };
      script.onerror = (err) => {
        pipState.playerScriptPromise = null;
        reject(err);
      };
      document.head.appendChild(script);
    });
    return pipState.playerScriptPromise;
  }

  async function startPrewarm() {
    if (pipState.prewarmStarted) return;
    pipState.prewarmStarted = true;
    createPiPDOM();
    try {
      const player = await ensurePlayerScriptLoaded();
      if (player) {
        if (typeof player.prewarm === 'function') {
          await player.prewarm();
        } else if (typeof player.init === 'function') {
          await player.init();
        }
      }
      if (!pipState.uiSyncInterval) {
        pipState.uiSyncInterval = setInterval(updateControlState, 200);
      }
    } catch (err) {
      console.warn('[JKPiPPlayer] Prewarm error:', err);
    }
  }

  function isEligibleDemoHref(href) {
    if (!href || typeof href !== 'string') return false;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('#rpc=lookup')) {
      return false;
    }
    return (
      trimmed.includes('getdemo.php?') ||
      trimmed.includes('mergedemo.php?') ||
      trimmed.includes('trimdemo.php?') ||
      trimmed.includes('rpc=matchdemo')
    );
  }

  function deriveDemoTitle(anchorOrUrl) {
    if (anchorOrUrl && typeof anchorOrUrl === 'object' && anchorOrUrl.nodeType === 1) {
      const href = anchorOrUrl.getAttribute('href') || '';
      const text = (anchorOrUrl.textContent || '').trim();
      const row = anchorOrUrl.closest('tr');
      if (row) {
        const cells = Array.from(row.querySelectorAll(':scope > td')).map((td) =>
          (td.textContent || '').replace(/(?:\u25B6\s*)?Play/g, '').trim()
        );
        const nonEmpty = cells.filter(
          (c) => c && c !== 'Link' && c !== 'Demo' && c !== 'LinkDemo' && c !== 'Match Demo'
        );
        if (nonEmpty.length >= 2) {
          return (text ? text + ' \u2014 ' : '') + nonEmpty.slice(0, 2).join(' \u00B7 ');
        }
      }
      if (text && text !== 'Link') return text;
      return deriveDemoTitle(href);
    }
    const urlStr = String(anchorOrUrl || '');
    try {
      const u = new URL(urlStr, window.location.origin);
      const demoParam = u.searchParams.get('demo');
      if (demoParam) {
        const parts = decodeURIComponent(demoParam).split('/');
        return parts[parts.length - 1] || demoParam;
      }
      if (u.searchParams.get('rpc') === 'matchdemo') {
        return 'Match Highlight #' + (u.searchParams.get('id') || '');
      }
      if (u.pathname.includes('mergedemo.php')) {
        return (
          'Merged POV #' +
          (u.searchParams.get('matchid') || '') +
          ' (Client ' +
          (u.searchParams.get('clientid') || '') +
          ')'
        );
      }
    } catch (_) {}
    return urlStr || 'JKA Demo';
  }

  function decorateDemoLinks(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const isFullDoc = !root || root === document || root === document.body;
    if (
      isFullDoc &&
      /player2\.html/i.test((window.location && window.location.pathname) || '') &&
      !document.querySelector('a[href*="trimdemo.php"]') &&
      (typeof performance === 'undefined' || performance.now() < 15000)
    ) {
      setTimeout(() => decorateDemoLinks(document.body), 200);
      return 0;
    }
    const anchors = scope.querySelectorAll('a[href]');
    let added = 0;
    anchors.forEach((a) => {
      if (a.closest('#jk-pip-card')) return;
      const href = a.getAttribute('href') || '';
      if (!isEligibleDemoHref(href)) {
        if (a.dataset && a.dataset.jkPlayAttached) {
          delete a.dataset.jkPlayAttached;
        }
        return;
      }
      const next = a.nextElementSibling;
      if (next && next.classList && next.classList.contains('jk-play-btn')) {
        next.dataset.demoUrl = href;
        a.dataset.jkPlayAttached = '1';
        return;
      }
      a.dataset.jkPlayAttached = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'jk-play-btn';
      btn.dataset.demoUrl = href;
      btn.title = 'Play demo in browser';
      btn.setAttribute('aria-label', 'Play demo in browser');
      btn.innerHTML =
        '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg><span>Play</span>';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentHref = a.getAttribute('href') || href;
        const label = deriveDemoTitle(a);
        openAndPlay(currentHref, {
          label,
          unmuteOnUserGesture: Boolean(e && e.isTrusted),
        });
      });
      a.insertAdjacentElement('afterend', btn);
      added++;
    });
    return added;
  }

  function observeArchiveDOM() {
    if (pipState.observer || !document.body) return;
    decorateDemoLinks(document.body);
    pipState.observer = new MutationObserver((mutations) => {
      let shouldDecorate = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && !node.classList.contains('jk-play-btn') && node.id !== 'jk-pip-card') {
              shouldDecorate = true;
              break;
            }
          }
        } else if (m.type === 'attributes' && m.attributeName === 'href') {
          shouldDecorate = true;
        }
        if (shouldDecorate) break;
      }
      if (shouldDecorate) {
        decorateDemoLinks(document.body);
      }
    });
    pipState.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  async function openAndPlay(demoUrl, titleOrOpts) {
    let resolvedTitle = '';
    let unmuteOnUserGesture = false;
    if (typeof titleOrOpts === 'string') {
      resolvedTitle = titleOrOpts.trim();
    } else if (titleOrOpts && typeof titleOrOpts === 'object') {
      resolvedTitle = String(titleOrOpts.label || titleOrOpts.title || '').trim();
      unmuteOnUserGesture = Boolean(titleOrOpts.unmuteOnUserGesture);
    }
    if (demoUrl && typeof demoUrl === 'object') {
      if (!resolvedTitle) {
        resolvedTitle = String(demoUrl.label || demoUrl.title || '').trim();
      }
      if (demoUrl.unmuteOnUserGesture) {
        unmuteOnUserGesture = true;
      }
      demoUrl = demoUrl.url || demoUrl.demo || demoUrl.href || '';
    }
    if (!demoUrl || typeof demoUrl !== 'string') return false;

    if (unmuteOnUserGesture) {
      const existingPlayer = getPlayer();
      if (existingPlayer && typeof existingPlayer.unlockAudio === 'function') {
        existingPlayer.unlockAudio();
      }
    }

    const card = createPiPDOM();
    pipState.open = true;
    pipState.currentDemoUrl = demoUrl;
    pipState.currentDemoTitle = resolvedTitle || deriveDemoTitle(demoUrl);

    card.hidden = false;
    card.classList.add('jk-pip-open');
    applyCardGeometry();

    const titleEl = document.getElementById('jk-pip-title');
    if (titleEl) {
      titleEl.textContent = pipState.currentDemoTitle;
      titleEl.title = pipState.currentDemoTitle;
    }

    const overlay = document.getElementById('jk-pip-status-overlay');
    if (overlay) {
      overlay.textContent = 'Loading demo...';
      overlay.style.display = 'block';
    }

    try {
      const player = getPlayer() || (await ensurePlayerScriptLoaded());
      if (!pipState.uiSyncInterval) {
        pipState.uiSyncInterval = setInterval(updateControlState, 200);
      }
      if (player && typeof player.resize === 'function') {
        player.resize();
      }
      const ok = await player.loadDemo({
        url: demoUrl,
        title: pipState.currentDemoTitle,
        label: pipState.currentDemoTitle,
      });
      if (unmuteOnUserGesture && player && typeof player.setMuted === 'function') {
        player.setMuted(false);
      }
      if (player && typeof player.setLoop === 'function') {
        player.setLoop(true);
      }
      if (player && typeof player.resume === 'function') {
        player.resume();
      }
      if (titleEl && (!titleEl.textContent || !titleEl.textContent.trim())) {
        const st = typeof player.getStatus === 'function' ? player.getStatus() : {};
        titleEl.textContent = st.demoName || pipState.currentDemoTitle || 'JKA Demo';
      }
      updateControlState();
      return Boolean(ok);
    } catch (err) {
      console.error('[JKPiPPlayer] Failed to load demo:', err);
      return false;
    } finally {
      if (overlay) {
        overlay.style.display = 'none';
      }
    }
  }

  function closePiP() {
    const card = document.getElementById('jk-pip-card');
    pipState.open = false;
    if (card) {
      card.classList.remove('jk-pip-open');
      card.hidden = true;
    }
    const player = getPlayer();
    if (player) {
      if (typeof player.pause === 'function') player.pause();
      if (typeof player.setMuted === 'function') player.setMuted(true);
    }
  }

  function setSizePreset(presetName) {
    if (!SIZE_PRESETS[presetName]) return;
    pipState.preset = presetName;
    pipState.width = SIZE_PRESETS[presetName].width;
    pipState.height = SIZE_PRESETS[presetName].height;
    applyCardGeometry();
    saveLayout();
  }

  function togglePause() {
    const player = getPlayer();
    if (!player) return false;
    const res =
      typeof player.togglePause === 'function'
        ? player.togglePause()
        : player.isPaused()
        ? player.resume()
        : player.pause();
    updateControlState();
    return res;
  }

  function startOver() {
    const player = getPlayer();
    if (!player) return -1;
    const res =
      typeof player.startOver === 'function'
        ? player.startOver()
        : typeof player.seekToMs === 'function'
        ? player.seekToMs(0)
        : -1;
    updateControlState();
    return res;
  }

  function seekToMs(targetOffsetMs) {
    const player = getPlayer();
    if (!player || typeof player.seekToMs !== 'function') return -1;
    const res = player.seekToMs(targetOffsetMs);
    updateControlState();
    return res;
  }

  function seekToRatio(ratio) {
    const player = getPlayer();
    if (!player) return -1;
    const r = Math.max(0, Math.min(1, Number(ratio) || 0));
    if (typeof player.seekToRatio === 'function') {
      const res = player.seekToRatio(r);
      updateControlState();
      return res;
    }
    const dur = typeof player.getDurationMs === 'function' ? player.getDurationMs() : 0;
    return seekToMs(Math.round(r * dur));
  }

  function setLoop(enabled) {
    const player = getPlayer();
    if (!player || typeof player.setLoop !== 'function') return Boolean(enabled);
    const res = player.setLoop(Boolean(enabled));
    updateControlState();
    return res;
  }

  function getLoop() {
    const player = getPlayer();
    if (!player || typeof player.getLoop !== 'function') return true;
    return player.getLoop();
  }

  function toggleLoop() {
    return setLoop(!getLoop());
  }

  function setSpeed(rate) {
    const player = getPlayer();
    if (!player || typeof player.setSpeed !== 'function') return rate;
    const res = player.setSpeed(rate);
    updateControlState();
    return res;
  }

  function getSpeed() {
    const player = getPlayer();
    if (!player || typeof player.getSpeed !== 'function') return 1.0;
    return player.getSpeed();
  }

  function setVolume(vol) {
    const player = getPlayer();
    if (!player) return vol;
    const v = Math.max(0, Math.min(1, Number(vol) || 0));
    if (typeof player.setVolume === 'function') {
      player.setVolume(v);
    }
    if (v > 0 && typeof player.isMuted === 'function' && player.isMuted()) {
      player.setMuted(false);
    }
    updateControlState();
    return v;
  }

  function getVolume() {
    const player = getPlayer();
    if (!player || typeof player.getVolume !== 'function') return 0.8;
    return player.getVolume();
  }

  function setMuted(muted) {
    const player = getPlayer();
    if (!player || typeof player.setMuted !== 'function') return Boolean(muted);
    const res = player.setMuted(Boolean(muted));
    updateControlState();
    return res;
  }

  function isMuted() {
    const player = getPlayer();
    if (!player || typeof player.isMuted !== 'function') return true;
    return player.isMuted();
  }

  function toggleMute() {
    return setMuted(!isMuted());
  }

  function toggleFullscreen() {
    const card = document.getElementById('jk-pip-card');
    const viewport = document.getElementById('jk-pip-viewport') || card;
    if (!viewport) return;
    try {
      if (!document.fullscreenElement) {
        if (typeof viewport.requestFullscreen === 'function') {
          const p = viewport.requestFullscreen();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } else if (typeof document.exitFullscreen === 'function') {
        const p = document.exitFullscreen();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) {}
  }

  function ensureManifestV2Cached() {
    try {
      const existing = localStorage.getItem('openjk_pk3_manifest_v2');
      if (existing && existing.length > 1000) return;
      fetch('/base/manifest.json')
        .then((r) => (r.ok ? r.text() : ''))
        .then((txt) => {
          if (txt && txt.length > 1000) {
            try {
              localStorage.setItem('openjk_pk3_manifest_v2', txt);
            } catch (_) {}
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  function boot() {
    ensureManifestV2Cached();
    createPiPDOM();
    observeArchiveDOM();
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => startPrewarm(), { timeout: 1500 });
    } else {
      setTimeout(() => startPrewarm(), 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.JKPiPPlayer = {
    __initialized: true,
    init: startPrewarm,
    prewarm: startPrewarm,
    decorateLinks: decorateDemoLinks,
    openAndPlay,
    playDemoUrl: openAndPlay,
    close: closePiP,
    togglePause,
    startOver,
    restart: startOver,
    seekToMs,
    seekToRatio,
    setLoop,
    getLoop,
    toggleLoop,
    setSpeed,
    getSpeed,
    setVolume,
    getVolume,
    setMuted,
    isMuted,
    toggleMute,
    setSizePreset,
    toggleFullscreen,
    isOpen: () => pipState.open,
    getState: () => Object.assign({}, pipState, { ready: Boolean(getPlayer() && getPlayer().getStatus && getPlayer().getStatus().ready) }),
  };
})();
