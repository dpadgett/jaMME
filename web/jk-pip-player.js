(function () {
  'use strict';

  if (window.JKPiPPlayer && window.JKPiPPlayer.__initialized) {
    return;
  }

  function installDocumentTitleGuard() {
    if (typeof document === 'undefined' || document.__jkTitleGuardInstalled) return;
    try {
      const proto =
        (typeof Document !== 'undefined' && Document.prototype) ||
        Object.getPrototypeOf(document);
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'title') : null;
      if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
      const isEngineWindowTitle = (val) => {
        const s = String(val == null ? '' : val).trim();
        if (!s) return true;
        return (
          /^jedi\s*knight/i.test(s) ||
          /^openjk(?:\s*\(mp\))?$/i.test(s) ||
          /^jamme$/i.test(s) ||
          /^unnamed window$/i.test(s)
        );
      };
      Object.defineProperty(document, 'title', {
        configurable: true,
        enumerable: desc.enumerable !== false,
        get() {
          return desc.get.call(document);
        },
        set(nextVal) {
          const cfg = window.JKDemoConfig || {};
          if (cfg.preserveDocumentTitle !== false && isEngineWindowTitle(nextVal)) {
            return;
          }
          desc.set.call(document, nextVal);
        },
      });
      document.__jkTitleGuardInstalled = true;
    } catch (_) {}
  }

  installDocumentTitleGuard();

  const STORAGE_KEY_LAYOUT = 'jk_pip_layout_v1';
  const STORAGE_KEY_PLAYER_PREFS = 'openjk_player_prefs_v1';

  function readPersistedThirdPersonPref() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (!raw) return true;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.thirdPerson === 'boolean') {
        return parsed.thirdPerson;
      }
    } catch (_) {}
    return true;
  }

  function writePersistedThirdPersonPref(enabled) {
    try {
      let existing = {};
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      }
      existing.thirdPerson = Boolean(enabled);
      localStorage.setItem(STORAGE_KEY_PLAYER_PREFS, JSON.stringify(existing));
    } catch (_) {}
  }

  function readPersistedMusicPref() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (!raw) return true;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.musicEnabled === 'boolean') {
        return parsed.musicEnabled;
      }
      if (parsed && typeof parsed.music === 'boolean') {
        return parsed.music;
      }
    } catch (_) {}
    return true;
  }

  function writePersistedMusicPref(enabled) {
    try {
      let existing = {};
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      }
      existing.musicEnabled = Boolean(enabled);
      localStorage.setItem(STORAGE_KEY_PLAYER_PREFS, JSON.stringify(existing));
    } catch (_) {}
  }

  function clampGammaPref(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 1.0;
    return Math.round(Math.min(3.0, Math.max(0.5, num)) * 100) / 100;
  }

  function clampOverbrightPref(val) {
    const num = Math.round(Number(val));
    if (!Number.isFinite(num)) return 0;
    return Math.min(3, Math.max(0, num));
  }

  function readPersistedLightingPrefs() {
    const defaults = { gamma: 1.0, overbright: 0 };
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.gamma === 'number' && Number.isFinite(parsed.gamma)) {
          defaults.gamma = clampGammaPref(parsed.gamma);
        }
        if (typeof parsed.overbright === 'number' && Number.isFinite(parsed.overbright)) {
          defaults.overbright = clampOverbrightPref(parsed.overbright);
        }
      }
    } catch (_) {}
    return defaults;
  }

  function writePersistedLightingPrefs(patch) {
    try {
      let existing = {};
      const raw = localStorage.getItem(STORAGE_KEY_PLAYER_PREFS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      }
      if (patch && typeof patch.gamma === 'number') {
        existing.gamma = clampGammaPref(patch.gamma);
      }
      if (patch && typeof patch.overbright === 'number') {
        existing.overbright = clampOverbrightPref(patch.overbright);
      }
      localStorage.setItem(STORAGE_KEY_PLAYER_PREFS, JSON.stringify(existing));
    } catch (_) {}
  }

  const LIGHTING_PRESETS = {
    stock: { gamma: 1.0, overbright: 0, label: 'Stock' },
    overbright: { gamma: 1.0, overbright: 2, label: 'Overbright' },
    gamma2: { gamma: 2.0, overbright: 0, label: 'Gamma 2' },
    bright: { gamma: 1.4, overbright: 1, label: 'Bright+' },
  };
  const SIZE_PRESETS = {
    compact: { width: 420, height: 290 },
    default: { width: 560, height: 376 },
    large: { width: 760, height: 496 },
  };
  const MIN_WIDTH = 220;
  const MIN_HEIGHT = 204;
  const HARD_MIN_WIDTH = 220;
  const HARD_MIN_HEIGHT = 204;

  const ICON_FULLSCREEN_ENTER =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>';
  const ICON_FULLSCREEN_EXIT =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/></svg>';
  const ICON_BRIGHTNESS =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.7"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/></svg>';
  const ICON_CLIP =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="3" width="9.4" height="10" rx="1.6"/><path d="M11.2 6.4L14.5 4.5v7l-3.3-1.9"/></svg>';
  const ICON_MUSIC_ON =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.2V3.8l7-1.6v8.4"/><circle cx="4.2" cy="12.2" r="1.8"/><circle cx="11.2" cy="10.6" r="1.8"/></svg>';
  const ICON_MUSIC_OFF =
    '<svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.2V4.5m0-1.7v1l7-1.6v6.2"/><circle cx="4.2" cy="12.2" r="1.8"/><circle cx="11.2" cy="10.6" r="1.8"/><path d="M2 2l12 12"/></svg>';
  const ICON_PLAY_OVERLAY =
    '<svg class="jk-icon-svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M7 5.5v13l11-6.5-11-6.5z"/></svg>';
  const ICON_PAUSE_OVERLAY =
    '<svg class="jk-icon-svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

  const FS_CONTROLS_HIDE_DELAY_MS = 2800;
  const initialLightingPrefs = readPersistedLightingPrefs();

  const pipState = {
    open: false,
    hasSavedLayout: false,
    preset: 'default',
    thirdPerson: readPersistedThirdPersonPref(),
    musicEnabled: readPersistedMusicPref(),
    gamma: initialLightingPrefs.gamma,
    overbright: initialLightingPrefs.overbright,
    lightingOpen: false,
    scrubbingGamma: false,
    width: SIZE_PRESETS.default.width,
    height: SIZE_PRESETS.default.height,
    x: null,
    y: null,
    mobileDocUnit: 1,
    dragging: false,
    resizing: false,
    dragPointerId: null,
    resizePointerId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragStartClientX: 0,
    dragStartClientY: 0,
    dragStartX: 0,
    dragStartY: 0,
    resizeStartX: 0,
    resizeStartY: 0,
    resizeStartW: 0,
    resizeStartH: 0,
    resizeStartCardX: 0,
    resizeStartCardY: 0,
    resizeDir: 'se',
    resizeHandleEl: null,
    scrubbing: false,
    currentDemoUrl: '',
    currentDemoTitle: '',
    loadFailed: false,
    prewarmStarted: false,
    playerScriptLoaded: false,
    playerScriptPromise: null,
    uiSyncInterval: null,
    observer: null,
    tapFlashTimer: null,
    fsControlsTimer: null,
    lastKnownPaused: false,
  };

  function isCoarsePointer() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (_) {
      return false;
    }
  }

  function primeSharedAudioOnUserGesture() {
    try {
      const sdlCtx =
        window.Module && window.Module.SDL2 && window.Module.SDL2.audioContext
          ? window.Module.SDL2.audioContext
          : null;
      const RawCtx =
        window.__jkOrigAudioContext || window.AudioContext || window.webkitAudioContext;
      if (!RawCtx && !sdlCtx) return null;
      let ctx = sdlCtx && sdlCtx.state !== 'closed' ? sdlCtx : window.__jkSharedAudioCtx;
      if (!ctx || ctx.state === 'closed') {
        try {
          ctx = new RawCtx({ sampleRate: 44100, latencyHint: 'interactive' });
        } catch (_) {
          try {
            ctx = new RawCtx({ latencyHint: 'interactive' });
          } catch (_2) {
            ctx = new RawCtx();
          }
        }
        window.__jkSharedAudioCtx = ctx;
      }
      if (ctx && typeof ctx.resume === 'function' && ctx.state !== 'running') {
        ctx.resume().catch(() => {});
      }
      if (ctx && !ctx.__jkUnlockedOnce && typeof ctx.createBuffer === 'function') {
        ctx.__jkUnlockedOnce = true;
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        if (typeof src.start === 'function') src.start(0);
      }
      const existingPlayer = window.JKDemoPlayer || window.OpenJKPlayer || null;
      if (existingPlayer && typeof existingPlayer.unlockAudio === 'function') {
        existingPlayer.unlockAudio();
      }
      return ctx;
    } catch (_) {
      return null;
    }
  }

  function getViewportRect() {
    const scrollX = Number(window.scrollX ?? window.pageXOffset) || 0;
    const scrollY = Number(window.scrollY ?? window.pageYOffset) || 0;
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      const left = Number(vv.offsetLeft) || 0;
      const top = Number(vv.offsetTop) || 0;
      return {
        left,
        top,
        pageLeft: typeof vv.pageLeft === 'number' && Number.isFinite(vv.pageLeft) ? vv.pageLeft : scrollX + left,
        pageTop: typeof vv.pageTop === 'number' && Number.isFinite(vv.pageTop) ? vv.pageTop : scrollY + top,
        width: Number(vv.width),
        height: Number(vv.height),
        scale: Number(vv.scale) || 1,
      };
    }
    return {
      left: 0,
      top: 0,
      pageLeft: scrollX,
      pageTop: scrollY,
      width: Math.max(window.innerWidth || 800, HARD_MIN_WIDTH),
      height: Math.max(window.innerHeight || 600, HARD_MIN_HEIGHT),
      scale: 1,
    };
  }

  function isMobileDocMode() {
    if (isCoarsePointer()) return true;
    const vp = getViewportRect();
    const scale = vp && vp.scale > 0.05 ? vp.scale : 1;
    return vp.width * scale < 640;
  }

  function lockLandscapeIfMobile() {
    if (!isMobileDocMode()) return;
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
        const p = window.screen.orientation.lock('landscape');
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) {}
  }

  function unlockOrientationIfSupported() {
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
        window.screen.orientation.unlock();
      }
    } catch (_) {}
  }

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function isCardFullscreen() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return false;
    return getFullscreenElement() === card || card.classList.contains('jk-pip-pseudo-fullscreen');
  }

  function loadSavedLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        pipState.hasSavedLayout = true;
        if (parsed.preset === 'custom' || (parsed.preset && SIZE_PRESETS[parsed.preset])) {
          pipState.preset = parsed.preset;
        }
        if (typeof parsed.width === 'number' && parsed.width >= HARD_MIN_WIDTH) {
          pipState.width = parsed.width;
        }
        if (typeof parsed.height === 'number' && parsed.height >= HARD_MIN_HEIGHT) {
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
    pipState.hasSavedLayout = true;
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
        -webkit-user-select: none;
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
        --jk-ui-scale: 1;
        container: jk-card / inline-size;
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 560px;
        height: 376px;
        min-width: 0;
        min-height: 0;
        z-index: 99999;
        display: none;
        flex-direction: column;
        background: #0d1117;
        color: #c9d1d9;
        border: calc(1px * var(--jk-ui-scale, 1)) solid #30363d;
        border-radius: calc(8px * var(--jk-ui-scale, 1));
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        overflow: hidden;
        overflow: clip;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: calc(12px * var(--jk-ui-scale, 1));
        box-sizing: border-box;
      }
      #jk-pip-card .jk-icon-svg {
        width: calc(12px * var(--jk-ui-scale, 1));
        height: calc(12px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card .jk-pip-drag-grip {
        width: calc(10px * var(--jk-ui-scale, 1));
        height: calc(14px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card #jk-pip-tap-indicator .jk-icon-svg {
        width: calc(24px * var(--jk-ui-scale, 1));
        height: calc(24px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-open {
        display: flex;
      }
      #jk-pip-card:fullscreen,
      #jk-pip-card:-webkit-full-screen {
        inset: 0 !important;
        left: 0 !important;
        top: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        width: 100dvw !important;
        height: 100dvh !important;
        max-width: none !important;
        max-height: none !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      #jk-pip-card:fullscreen.jk-pip-force-landscape,
      #jk-pip-card:-webkit-full-screen.jk-pip-force-landscape {
        inset: auto !important;
        left: 0 !important;
        top: 0 !important;
        right: auto !important;
        bottom: auto !important;
        width: 100vh !important;
        height: 100vw !important;
        width: 100dvh !important;
        height: 100dvw !important;
        transform-origin: 0 0 !important;
        transform: translateX(100vw) rotate(90deg) !important;
        transform: translateX(100dvw) rotate(90deg) !important;
      }
      #jk-pip-card.jk-pip-pseudo-fullscreen {
        max-width: none !important;
        max-height: none !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      #jk-pip-card:fullscreen .jk-pip-size-group,
      #jk-pip-card:-webkit-full-screen .jk-pip-size-group,
      #jk-pip-card.jk-pip-pseudo-fullscreen .jk-pip-size-group,
      #jk-pip-card:fullscreen .jk-pip-header-divider,
      #jk-pip-card:-webkit-full-screen .jk-pip-header-divider,
      #jk-pip-card.jk-pip-pseudo-fullscreen .jk-pip-header-divider,
      #jk-pip-card:fullscreen .jk-pip-drag-grip,
      #jk-pip-card:-webkit-full-screen .jk-pip-drag-grip,
      #jk-pip-card.jk-pip-pseudo-fullscreen .jk-pip-drag-grip,
      #jk-pip-card:fullscreen .jk-pip-resize-zone,
      #jk-pip-card:-webkit-full-screen .jk-pip-resize-zone,
      #jk-pip-card.jk-pip-pseudo-fullscreen .jk-pip-resize-zone {
        display: none !important;
      }
      #jk-pip-card:fullscreen #jk-pip-header,
      #jk-pip-card:-webkit-full-screen #jk-pip-header,
      #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-header {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 20;
        cursor: default;
        border-bottom: none;
        background: linear-gradient(180deg, rgba(13, 17, 23, 0.88) 0%, rgba(13, 17, 23, 0.52) 72%, rgba(13, 17, 23, 0) 100%);
        padding-top: calc(4px + env(safe-area-inset-top, 0px));
        padding-left: calc(10px + env(safe-area-inset-left, 0px));
        padding-right: calc(10px + env(safe-area-inset-right, 0px));
        padding-bottom: 10px;
        translate: 0 0;
        opacity: 1;
        transition: translate 0.26s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
      }
      #jk-pip-card:fullscreen .jk-pip-drag-handle,
      #jk-pip-card:-webkit-full-screen .jk-pip-drag-handle,
      #jk-pip-card.jk-pip-pseudo-fullscreen .jk-pip-drag-handle {
        cursor: default;
      }
      #jk-pip-card:fullscreen #jk-pip-controls,
      #jk-pip-card:-webkit-full-screen #jk-pip-controls,
      #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-controls {
        display: flex !important;
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 20;
        border-top: none;
        background: linear-gradient(0deg, rgba(13, 17, 23, 0.92) 0%, rgba(13, 17, 23, 0.68) 72%, rgba(13, 17, 23, 0) 100%);
        padding-top: 14px;
        padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
        padding-left: calc(10px + env(safe-area-inset-left, 0px));
        padding-right: calc(10px + env(safe-area-inset-right, 0px));
        translate: 0 0;
        opacity: 1;
        transition: translate 0.26s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
      }
      #jk-pip-card:fullscreen #jk-pip-status-overlay,
      #jk-pip-card:-webkit-full-screen #jk-pip-status-overlay,
      #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-status-overlay {
        top: calc(46px + env(safe-area-inset-top, 0px));
      }
      #jk-pip-card.jk-pip-fs-controls-hidden #jk-pip-header {
        translate: 0 -110%;
        opacity: 0;
        pointer-events: none;
      }
      #jk-pip-card.jk-pip-fs-controls-hidden #jk-pip-controls {
        translate: 0 110%;
        opacity: 0;
        pointer-events: none;
      }
      #jk-pip-card.jk-pip-fs-controls-hidden #jk-pip-viewport canvas#jk-canvas {
        cursor: none;
      }
      @media (prefers-reduced-motion: reduce) {
        #jk-pip-card:fullscreen #jk-pip-header,
        #jk-pip-card:-webkit-full-screen #jk-pip-header,
        #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-header,
        #jk-pip-card:fullscreen #jk-pip-controls,
        #jk-pip-card:-webkit-full-screen #jk-pip-controls,
        #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-controls {
          transition: opacity 0.15s ease;
        }
      }
      #jk-pip-header {
        display: flex;
        align-items: safe center;
        justify-content: space-between;
        gap: calc(6px * var(--jk-ui-scale, 1));
        min-block-size: calc(34px * var(--jk-ui-scale, 1));
        padding: calc(3px * var(--jk-ui-scale, 1)) calc(8px * var(--jk-ui-scale, 1));
        background: #161b22;
        border-bottom: 1px solid #30363d;
        cursor: grab;
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
        flex-shrink: 0;
        box-sizing: border-box;
      }
      #jk-pip-header:active {
        cursor: grabbing;
      }
      .jk-pip-drag-handle {
        display: flex;
        align-items: center;
        gap: calc(6px * var(--jk-ui-scale, 1));
        flex: 1 1 auto;
        min-width: 0;
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        cursor: grab;
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
        border-radius: 4px;
        padding: 2px 4px;
      }
      .jk-pip-drag-handle:active {
        cursor: grabbing;
      }
      .jk-pip-drag-handle:focus-visible {
        outline: 2px solid #58a6ff;
        outline-offset: 1px;
      }
      .jk-pip-drag-grip {
        color: #8b949e;
        flex-shrink: 0;
        opacity: 0.75;
      }
      #jk-pip-title {
        font-weight: 600;
        color: #f0f6fc;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        pointer-events: none;
      }
      .jk-pip-header-actions {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }
      .jk-pip-size-group {
        display: inline-flex;
        align-items: center;
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      .jk-pip-header-divider {
        width: 1px;
        height: calc(16px * var(--jk-ui-scale, 1));
        background: #30363d;
        margin-inline: calc(12px * var(--jk-ui-scale, 1));
        flex-shrink: 0;
        pointer-events: none;
      }
      .jk-pip-hdr-btn {
        position: relative;
        z-index: 12;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        min-inline-size: calc(24px * var(--jk-ui-scale, 1));
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(7px * var(--jk-ui-scale, 1));
        font-size: calc(11px * var(--jk-ui-scale, 1));
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
        min-height: 0;
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
        cursor: pointer;
      }
      #jk-pip-tap-indicator {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) scale(0.82);
        width: calc(52px * var(--jk-ui-scale, 1));
        height: calc(52px * var(--jk-ui-scale, 1));
        border-radius: 999px;
        background: rgba(13, 17, 23, 0.78);
        border: calc(1px * var(--jk-ui-scale, 1)) solid rgba(240, 246, 252, 0.25);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.22s ease, transform 0.22s ease;
        z-index: 6;
      }
      #jk-pip-tap-indicator.jk-pip-tap-visible {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      #jk-pip-status-overlay {
        position: absolute;
        left: calc(10px * var(--jk-ui-scale, 1));
        right: calc(10px * var(--jk-ui-scale, 1));
        top: calc(10px * var(--jk-ui-scale, 1));
        max-width: calc(340px * var(--jk-ui-scale, 1));
        padding: calc(7px * var(--jk-ui-scale, 1)) calc(10px * var(--jk-ui-scale, 1));
        border-radius: calc(6px * var(--jk-ui-scale, 1));
        background: rgba(13, 17, 23, 0.90);
        border: calc(1px * var(--jk-ui-scale, 1)) solid rgba(56, 139, 253, 0.45);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
        color: #e6edf3;
        font-size: calc(11px * var(--jk-ui-scale, 1));
        pointer-events: none;
        display: none;
        z-index: 5;
      }
      .jk-pip-status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: calc(8px * var(--jk-ui-scale, 1));
        margin-bottom: calc(5px * var(--jk-ui-scale, 1));
      }
      #jk-pip-status-text {
        color: #e6edf3;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #jk-pip-status-pct {
        color: #58a6ff;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }
      .jk-pip-progress-track {
        width: 100%;
        height: calc(4px * var(--jk-ui-scale, 1));
        background: rgba(48, 54, 61, 0.9);
        border-radius: 2px;
        overflow: hidden;
      }
      #jk-pip-progress-bar {
        width: 4%;
        height: 100%;
        background: linear-gradient(90deg, #1f6feb, #58a6ff);
        border-radius: 2px;
        transition: width 0.12s ease-out;
      }
      #jk-pip-controls {
        display: flex;
        flex-direction: column;
        gap: calc(5px * var(--jk-ui-scale, 1));
        padding: calc(6px * var(--jk-ui-scale, 1)) calc(14px * var(--jk-ui-scale, 1)) calc(12px * var(--jk-ui-scale, 1));
        background: #161b22;
        border-top: 1px solid #30363d;
        flex-shrink: 0;
        -webkit-user-select: none;
        user-select: none;
        box-sizing: border-box;
      }
      .jk-pip-timeline-row {
        display: flex;
        align-items: safe center;
        gap: calc(6px * var(--jk-ui-scale, 1));
        inline-size: 100%;
      }
      #jk-pip-seek {
        position: relative;
        z-index: 12;
        flex: 1 1 auto;
        min-inline-size: 0;
        min-block-size: calc(18px * var(--jk-ui-scale, 1));
        margin: 0;
        cursor: pointer;
        accent-color: #58a6ff;
      }
      #jk-pip-time {
        font-variant-numeric: tabular-nums;
        font-size: calc(11px * var(--jk-ui-scale, 1));
        color: #8b949e;
        min-inline-size: calc(68px * var(--jk-ui-scale, 1));
        text-align: right;
        flex-shrink: 0;
      }
      .jk-pip-buttons-row {
        display: flex;
        align-items: safe center;
        justify-content: space-between;
        gap: calc(5px * var(--jk-ui-scale, 1));
        flex-wrap: wrap;
        flex-wrap: balance;
      }
      .jk-pip-btn-group {
        display: flex;
        align-items: safe center;
        gap: calc(5px * var(--jk-ui-scale, 1));
        min-inline-size: 0;
      }
      .jk-pip-primary-group {
        margin-inline-end: calc(8px * var(--jk-ui-scale, 1));
      }
      .jk-pip-secondary-group {
        flex-wrap: wrap;
        flex-wrap: balance;
      }
      .jk-pip-audio-group {
        margin-inline-start: auto;
        flex: 1 1 auto;
        justify-content: flex-end;
      }
      #jk-pip-play-pause {
        min-inline-size: calc(54px * var(--jk-ui-scale, 1));
        font-weight: 600;
      }
      #jk-pip-camera {
        min-inline-size: calc(62px * var(--jk-ui-scale, 1));
        font-variant-numeric: tabular-nums;
      }
      .jk-pip-ctrl-btn {
        position: relative;
        z-index: 12;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        min-inline-size: calc(24px * var(--jk-ui-scale, 1));
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: calc(3px * var(--jk-ui-scale, 1)) calc(8px * var(--jk-ui-scale, 1));
        font-size: calc(11px * var(--jk-ui-scale, 1));
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
      .jk-pip-ctrl-btn.jk-pip-light-boosted:not(.active) {
        border-color: #58a6ff;
        color: #79c0ff;
      }
      #jk-pip-lighting-btn,
      #jk-pip-export-btn,
      #jk-pip-music {
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      .jk-pip-music-icon {
        display: inline-flex;
        align-items: center;
      }
      .jk-pip-timeline-row[hidden] {
        display: none !important;
      }
      #jk-pip-lighting-panel {
        position: absolute;
        right: calc(10px * var(--jk-ui-scale, 1));
        bottom: calc(64px * var(--jk-ui-scale, 1));
        width: min(calc(252px * var(--jk-ui-scale, 1)), calc(100% - 20px * var(--jk-ui-scale, 1)));
        max-height: calc(100% - 70px * var(--jk-ui-scale, 1));
        overflow-y: auto;
        padding: calc(8px * var(--jk-ui-scale, 1)) calc(10px * var(--jk-ui-scale, 1));
        background: rgba(22, 27, 34, 0.97);
        border: 1px solid #30363d;
        border-radius: calc(6px * var(--jk-ui-scale, 1));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
        color: #e6edf3;
        z-index: 30;
        display: flex;
        flex-direction: column;
        gap: calc(7px * var(--jk-ui-scale, 1));
        box-sizing: border-box;
        -webkit-user-select: none;
        user-select: none;
      }
      #jk-pip-lighting-panel[hidden] {
        display: none !important;
      }
      #jk-pip-card:fullscreen #jk-pip-lighting-panel,
      #jk-pip-card:-webkit-full-screen #jk-pip-lighting-panel,
      #jk-pip-card.jk-pip-pseudo-fullscreen #jk-pip-lighting-panel {
        right: calc(12px + env(safe-area-inset-right, 0px));
        bottom: calc(70px + env(safe-area-inset-bottom, 0px));
        max-height: calc(100% - 82px - env(safe-area-inset-bottom, 0px) - env(safe-area-inset-top, 0px));
      }
      .jk-pip-light-presets {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      .jk-pip-light-preset-btn,
      .jk-pip-ob-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: calc(3px * var(--jk-ui-scale, 1)) calc(4px * var(--jk-ui-scale, 1));
        min-block-size: calc(22px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
        line-height: 1.15;
        cursor: pointer;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jk-pip-light-preset-btn:hover,
      .jk-pip-ob-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-pip-light-preset-btn.active,
      .jk-pip-ob-btn.active {
        background: #1f6feb;
        border-color: #58a6ff;
        color: #ffffff;
        font-weight: 600;
      }
      .jk-pip-light-row {
        display: flex;
        flex-direction: column;
        gap: calc(3px * var(--jk-ui-scale, 1));
      }
      .jk-pip-light-row-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: calc(6px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
        color: #8b949e;
      }
      .jk-pip-light-row-hdr label,
      .jk-pip-light-row-hdr span {
        color: #c9d1d9;
        font-weight: 500;
      }
      .jk-pip-light-val {
        font-variant-numeric: tabular-nums;
        color: #58a6ff !important;
        font-weight: 600 !important;
      }
      .jk-pip-ob-group {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      input[type="range"].jk-pip-styled-range {
        --slider-track-size: calc(5px * var(--jk-ui-scale, 1));
        --slider-thumb-size: calc(14px * var(--jk-ui-scale, 1));
        --slider-track-radius: 999px;
        --slider-thumb-radius: 50%;
        --slider-track-color: #30363d;
        --slider-fill-color: #58a6ff;
        --slider-thumb-color: #58a6ff;
        --slider-direction: to right;
        --attr-min: attr(min type(<number>), 1);
        --attr-max: attr(max type(<number>), 2.5);
        --control-value: attr(value type(<number>), 1);
        --slider-progress: calc(
          progress(var(--control-value), var(--attr-min), var(--attr-max)) * 100%
        );
        appearance: none;
        -webkit-appearance: none;
        inline-size: 100%;
        block-size: calc(20px * var(--jk-ui-scale, 1));
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        cursor: pointer;
      }
      input[type="range"].jk-pip-styled-range:dir(rtl) {
        --slider-direction: to left;
      }
      @supports not (opacity: progress(1, 0, 100)) {
        input[type="range"].jk-pip-styled-range {
          --slider-progress: calc(
            (var(--control-value) - var(--attr-min)) /
            (var(--attr-max) - var(--attr-min)) * 100%
          );
        }
      }
      input[type="range"].jk-pip-styled-range::-webkit-slider-runnable-track {
        block-size: var(--slider-track-size);
        border: 0;
        border-radius: var(--slider-track-radius);
        background: linear-gradient(
          var(--slider-direction),
          var(--slider-fill-color) var(--slider-progress),
          var(--slider-track-color) var(--slider-progress)
        );
      }
      input[type="range"].jk-pip-styled-range::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        inline-size: var(--slider-thumb-size);
        block-size: var(--slider-thumb-size);
        margin-block-start: calc(
          (var(--slider-track-size) - var(--slider-thumb-size)) / 2
        );
        border: 0;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
      }
      input[type="range"].jk-pip-styled-range::-moz-range-track {
        block-size: var(--slider-track-size);
        border: 0;
        border-radius: var(--slider-track-radius);
        background: var(--slider-track-color);
      }
      input[type="range"].jk-pip-styled-range::-moz-range-progress {
        block-size: var(--slider-track-size);
        border-radius: var(--slider-track-radius);
        background: var(--slider-fill-color);
      }
      input[type="range"].jk-pip-styled-range::-moz-range-thumb {
        inline-size: var(--slider-thumb-size);
        block-size: var(--slider-thumb-size);
        border: 0;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
      }
      input[type="range"].jk-pip-styled-range:focus-visible {
        outline: 2px solid var(--slider-fill-color);
        outline-offset: 3px;
      }
      .jk-pip-select {
        position: relative;
        z-index: 12;
        box-sizing: border-box;
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        min-inline-size: calc(24px * var(--jk-ui-scale, 1));
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
        font-size: calc(11px * var(--jk-ui-scale, 1));
        cursor: pointer;
      }
      #jk-pip-volume {
        position: relative;
        z-index: 12;
        flex: 1 1 calc(46px * var(--jk-ui-scale, 1));
        min-inline-size: calc(44px * var(--jk-ui-scale, 1));
        max-inline-size: calc(88px * var(--jk-ui-scale, 1));
        min-block-size: calc(18px * var(--jk-ui-scale, 1));
        margin: 0;
        cursor: pointer;
        accent-color: #58a6ff;
      }
      .jk-pip-resize-zone {
        position: absolute;
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
        z-index: 10;
      }
      .jk-pip-resize-se {
        right: 0;
        bottom: 0;
        min-inline-size: calc(24px * var(--jk-ui-scale, 1));
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        cursor: nwse-resize;
      }
      .jk-pip-resize-sw {
        left: 0;
        bottom: 0;
        min-inline-size: calc(24px * var(--jk-ui-scale, 1));
        min-block-size: calc(24px * var(--jk-ui-scale, 1));
        cursor: nesw-resize;
      }
      .jk-pip-resize-se::after,
      .jk-pip-resize-sw::after {
        content: "";
        position: absolute;
        bottom: 0;
        inline-size: calc(13px * var(--jk-ui-scale, 1));
        block-size: calc(13px * var(--jk-ui-scale, 1));
        opacity: 0.72;
        pointer-events: none;
        transition: opacity 0.12s ease;
      }
      .jk-pip-resize-se::after {
        right: 0;
        background: linear-gradient(135deg, transparent 52%, #58a6ff 52%);
      }
      .jk-pip-resize-sw::after {
        left: 0;
        background: linear-gradient(225deg, transparent 52%, #58a6ff 52%);
      }
      .jk-pip-resize-se:hover::after,
      .jk-pip-resize-sw:hover::after {
        opacity: 1;
      }
      .jk-pip-resize-nw {
        left: 0;
        top: 0;
        min-inline-size: calc(20px * var(--jk-ui-scale, 1));
        min-block-size: calc(20px * var(--jk-ui-scale, 1));
        cursor: nwse-resize;
      }
      .jk-pip-resize-ne {
        right: 0;
        top: 0;
        min-inline-size: calc(14px * var(--jk-ui-scale, 1));
        min-block-size: calc(14px * var(--jk-ui-scale, 1));
        cursor: nesw-resize;
      }
      .jk-pip-resize-n {
        top: 0;
        left: calc(20px * var(--jk-ui-scale, 1));
        right: calc(14px * var(--jk-ui-scale, 1));
        min-block-size: calc(6px * var(--jk-ui-scale, 1));
        cursor: ns-resize;
      }
      .jk-pip-resize-s {
        bottom: 0;
        left: calc(24px * var(--jk-ui-scale, 1));
        right: calc(24px * var(--jk-ui-scale, 1));
        min-block-size: calc(8px * var(--jk-ui-scale, 1));
        cursor: ns-resize;
      }
      .jk-pip-resize-w {
        left: 0;
        top: calc(20px * var(--jk-ui-scale, 1));
        bottom: calc(24px * var(--jk-ui-scale, 1));
        min-inline-size: calc(8px * var(--jk-ui-scale, 1));
        cursor: ew-resize;
      }
      .jk-pip-resize-e {
        right: 0;
        top: calc(14px * var(--jk-ui-scale, 1));
        bottom: calc(24px * var(--jk-ui-scale, 1));
        min-inline-size: calc(8px * var(--jk-ui-scale, 1));
        cursor: ew-resize;
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-header-divider {
        margin-inline: calc(6px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-primary-group,
      #jk-pip-card.jk-pip-narrow .jk-pip-secondary-group {
        display: contents;
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-buttons-row {
        justify-content: flex-start;
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-buttons-row,
      #jk-pip-card.jk-pip-narrow .jk-pip-btn-group {
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-ctrl-btn {
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-narrow .jk-pip-select {
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(4px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-narrow #jk-pip-play-pause {
        min-inline-size: calc(46px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-narrow #jk-pip-camera {
        min-inline-size: calc(54px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs #jk-pip-controls {
        padding: calc(5px * var(--jk-ui-scale, 1)) calc(14px * var(--jk-ui-scale, 1)) calc(12px * var(--jk-ui-scale, 1));
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs #jk-pip-header {
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
        gap: calc(4px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs .jk-pip-hdr-btn {
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs #jk-pip-time {
        min-inline-size: calc(60px * var(--jk-ui-scale, 1));
        font-size: calc(10px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs .jk-pip-light-label,
      #jk-pip-card.jk-pip-xs .jk-pip-clip-label,
      #jk-pip-card.jk-pip-xs .jk-pip-music-label {
        display: none;
      }
      #jk-pip-card.jk-pip-xs #jk-pip-lighting-panel {
        right: calc(6px * var(--jk-ui-scale, 1));
        bottom: calc(36px * var(--jk-ui-scale, 1));
        width: calc(100% - 12px * var(--jk-ui-scale, 1));
        max-height: calc(100% - 42px * var(--jk-ui-scale, 1));
        padding: calc(6px * var(--jk-ui-scale, 1)) calc(8px * var(--jk-ui-scale, 1));
      }
      #jk-pip-card.jk-pip-xs .jk-pip-light-presets {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      @container jk-card (max-width: 380px) {
        .jk-pip-light-label,
        .jk-pip-clip-label,
        .jk-pip-music-label {
          display: none;
        }
      }
      @container jk-card (max-width: 280px) {
        .jk-pip-light-presets {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #jk-pip-lighting-panel {
          right: calc(6px * var(--jk-ui-scale, 1));
          bottom: calc(36px * var(--jk-ui-scale, 1));
          width: calc(100% - 12px * var(--jk-ui-scale, 1));
          max-height: calc(100% - 42px * var(--jk-ui-scale, 1));
        }
      }
      @container jk-card (max-width: 340px) {
        .jk-pip-header-divider {
          margin-inline: calc(6px * var(--jk-ui-scale, 1));
        }
        .jk-pip-hdr-btn {
          padding: calc(2px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
        }
      }
      @container jk-card (max-width: 450px) {
        .jk-pip-primary-group,
        .jk-pip-secondary-group {
          display: contents;
        }
        .jk-pip-buttons-row {
          justify-content: flex-start;
        }
        .jk-pip-buttons-row,
        .jk-pip-btn-group {
          gap: calc(4px * var(--jk-ui-scale, 1));
        }
        .jk-pip-ctrl-btn {
          padding: calc(2px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
          font-size: calc(10.5px * var(--jk-ui-scale, 1));
        }
        .jk-pip-select {
          padding: calc(2px * var(--jk-ui-scale, 1)) calc(4px * var(--jk-ui-scale, 1));
          font-size: calc(10.5px * var(--jk-ui-scale, 1));
        }
        #jk-pip-play-pause {
          min-inline-size: calc(46px * var(--jk-ui-scale, 1));
        }
        #jk-pip-camera {
          min-inline-size: calc(54px * var(--jk-ui-scale, 1));
        }
      }
      @container jk-card (max-width: 310px) {
        #jk-pip-controls {
          padding: calc(5px * var(--jk-ui-scale, 1)) calc(14px * var(--jk-ui-scale, 1)) calc(12px * var(--jk-ui-scale, 1));
          gap: calc(4px * var(--jk-ui-scale, 1));
        }
        #jk-pip-time {
          min-inline-size: calc(60px * var(--jk-ui-scale, 1));
          font-size: calc(10px * var(--jk-ui-scale, 1));
        }
        .jk-pip-ctrl-btn {
          padding: calc(2px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
          font-size: calc(10px * var(--jk-ui-scale, 1));
        }
      }
      @media (pointer: coarse) {
        #jk-pip-header {
          min-block-size: calc(36px * var(--jk-ui-scale, 1));
          padding: calc(3px * var(--jk-ui-scale, 1)) calc(8px * var(--jk-ui-scale, 1));
        }
        #jk-pip-controls,
        #jk-pip-card.jk-pip-xs #jk-pip-controls {
          padding: calc(5px * var(--jk-ui-scale, 1)) calc(16px * var(--jk-ui-scale, 1)) calc(14px * var(--jk-ui-scale, 1));
        }
        .jk-pip-header-divider {
          margin-inline: calc(10px * var(--jk-ui-scale, 1));
          height: calc(18px * var(--jk-ui-scale, 1));
        }
        .jk-pip-hdr-btn,
        .jk-pip-ctrl-btn,
        .jk-pip-select {
          min-block-size: calc(28px * var(--jk-ui-scale, 1));
          min-inline-size: calc(28px * var(--jk-ui-scale, 1));
          padding: calc(3px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
          font-size: calc(11px * var(--jk-ui-scale, 1));
          border-radius: calc(4px * var(--jk-ui-scale, 1));
        }
        #jk-pip-card.jk-pip-xs .jk-pip-hdr-btn,
        #jk-pip-card.jk-pip-xs .jk-pip-ctrl-btn,
        #jk-pip-card.jk-pip-xs .jk-pip-select {
          min-block-size: calc(26px * var(--jk-ui-scale, 1));
          min-inline-size: calc(26px * var(--jk-ui-scale, 1));
          padding: calc(2px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
          font-size: calc(10.5px * var(--jk-ui-scale, 1));
        }
        #jk-pip-play-pause {
          min-inline-size: calc(50px * var(--jk-ui-scale, 1));
        }
        .jk-pip-primary-group {
          margin-inline-end: calc(6px * var(--jk-ui-scale, 1));
        }
        #jk-pip-seek,
        #jk-pip-volume {
          min-block-size: calc(24px * var(--jk-ui-scale, 1));
        }
        .jk-pip-resize-se,
        .jk-pip-resize-sw {
          min-inline-size: calc(28px * var(--jk-ui-scale, 1));
          min-block-size: calc(28px * var(--jk-ui-scale, 1));
        }
        .jk-pip-resize-se::after,
        .jk-pip-resize-sw::after {
          inline-size: calc(15px * var(--jk-ui-scale, 1));
          block-size: calc(15px * var(--jk-ui-scale, 1));
        }
        .jk-pip-resize-nw {
          min-inline-size: calc(24px * var(--jk-ui-scale, 1));
          min-block-size: calc(24px * var(--jk-ui-scale, 1));
        }
        .jk-pip-resize-s {
          left: calc(28px * var(--jk-ui-scale, 1));
          right: calc(28px * var(--jk-ui-scale, 1));
          min-block-size: calc(12px * var(--jk-ui-scale, 1));
        }
        .jk-pip-resize-w,
        .jk-pip-resize-e {
          bottom: calc(28px * var(--jk-ui-scale, 1));
          min-inline-size: calc(12px * var(--jk-ui-scale, 1));
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getVisualUnit(vp) {
    const scale = vp && Number(vp.scale) > 0.05 ? Number(vp.scale) : 1;
    if (isCoarsePointer() || (vp && vp.width < 340)) {
      return 1 / scale;
    }
    return 1;
  }

  function getPresetSize(presetName, vpOverride) {
    const vp = vpOverride || getViewportRect();
    const unit = getVisualUnit(vp);
    const physVpW = vp.width / unit;
    const physVpH = vp.height / unit;
    if (physVpW < 580) {
      if (presetName === 'compact') {
        return {
          width: Math.max(HARD_MIN_WIDTH, Math.round(physVpW * 0.67)),
          height: Math.max(220, Math.min(240, Math.round(physVpH * 0.30))),
        };
      }
      if (presetName === 'large') {
        return {
          width: Math.max(HARD_MIN_WIDTH, Math.round(physVpW - 8)),
          height: Math.max(296, Math.min(340, Math.round(physVpH * 0.43))),
        };
      }
      return {
        width: Math.max(HARD_MIN_WIDTH, Math.round(physVpW * 0.83)),
        height: Math.max(256, Math.min(288, Math.round(physVpH * 0.36))),
      };
    }
    return SIZE_PRESETS[presetName] || SIZE_PRESETS.default;
  }

  function clampPosition(x, y, cssWidth, cssHeight, vpOverride) {
    const vp = vpOverride || getViewportRect();
    const unit = getVisualUnit(vp);
    const physVpW = vp.width / unit;
    const margin = (physVpW < 440 ? 4 : 8) * unit;
    const minX = vp.left + margin;
    const maxX = Math.max(minX, vp.left + vp.width - cssWidth - margin);
    const minY = vp.top + margin;
    const maxY = Math.max(minY, vp.top + vp.height - cssHeight - margin);
    const clampedX =
      cssWidth >= vp.width - margin * 2
        ? vp.left + Math.max(0, (vp.width - cssWidth) / 2)
        : Math.max(minX, Math.min(maxX, x));
    const clampedY =
      cssHeight >= vp.height - margin * 2
        ? vp.top + Math.max(0, (vp.height - cssHeight) / 2)
        : Math.max(minY, Math.min(maxY, y));
    return {
      x: Math.round(clampedX * 100) / 100,
      y: Math.round(clampedY * 100) / 100,
    };
  }

  function getTrimExtraPhysH(unit) {
    const card = document.getElementById('jk-pip-card');
    if (!card || card.hidden || isCardFullscreen()) return 0;
    const bar = document.getElementById('jk-trim-bar');
    if (!bar || bar.hidden || !card.contains(bar)) return 0;
    const u = Number(unit) > 0.05 ? Number(unit) : 1;
    const barCssH = bar.getBoundingClientRect().height;
    if (!(barCssH > 0)) return 0;
    const baseTimelinePhysH = isCoarsePointer() ? 24 : 18;
    return Math.max(0, Math.round(barCssH / u - baseTimelinePhysH));
  }

  function clampSize(physWidth, physHeight, vpOverride) {
    const vp = vpOverride || getViewportRect();
    const mobileDoc = isMobileDocMode();
    const unit = mobileDoc && pipState.resizing ? pipState.mobileDocUnit || getVisualUnit(vp) : getVisualUnit(vp);
    const physVpW = vp.width / unit;
    const physVpH = vp.height / unit;
    const margin = physVpW < 440 ? 8 : 16;
    let availW = Math.max(HARD_MIN_WIDTH, Math.floor(physVpW - margin));
    let availH = Math.max(HARD_MIN_HEIGHT, Math.floor(physVpH - margin));
    if (mobileDoc) {
      const layoutClientW = Math.max(
        (document.documentElement && document.documentElement.clientWidth) || 0,
        vp.width
      );
      const docMaxW = Math.floor(layoutClientW / unit) - margin;
      availW = Math.max(
        availW,
        docMaxW,
        pipState.resizing ? Math.ceil(pipState.resizeStartW) : 0
      );
      availH = Math.max(
        availH,
        pipState.resizing ? Math.ceil(pipState.resizeStartH) : 0
      );
    }
    let minH = MIN_HEIGHT;
    const cardEl = document.getElementById('jk-pip-card');
    if (cardEl && !cardEl.hidden) {
      const hdrEl = document.getElementById('jk-pip-header');
      const ctrlEl = document.getElementById('jk-pip-controls');
      if (hdrEl && ctrlEl) {
        const trimExtraPhys = getTrimExtraPhysH(unit);
        const chromeCssH =
          hdrEl.getBoundingClientRect().height + ctrlEl.getBoundingClientRect().height;
        if (chromeCssH > 0) {
          minH = Math.max(minH, Math.ceil(chromeCssH / unit) - trimExtraPhys + 68);
        }
      }
    }
    const effMinW = Math.min(MIN_WIDTH, availW);
    const effMinH = Math.min(minH, availH);
    const w = Math.max(effMinW, Math.min(availW, Math.round(physWidth)));
    const h = Math.max(effMinH, Math.min(availH, Math.round(physHeight)));
    return { width: w, height: h };
  }

  function centerMobileCardInViewport(vpOverride) {
    const vp = vpOverride || getViewportRect();
    const unit = getVisualUnit(vp);
    pipState.mobileDocUnit = unit;

    if (pipState.preset && SIZE_PRESETS[pipState.preset]) {
      const pDims = getPresetSize(pipState.preset, vp);
      pipState.width = pDims.width;
      pipState.height = pDims.height;
    } else if (!pipState.hasSavedLayout) {
      pipState.preset = 'default';
      const pDims = getPresetSize('default', vp);
      pipState.width = pDims.width;
      pipState.height = pDims.height;
    } else {
      const dims = clampSize(pipState.width, pipState.height, vp);
      pipState.width = dims.width;
      pipState.height = dims.height;
    }

    const cssW = Math.min(vp.width, pipState.width * unit);
    const cssH = Math.min(vp.height, pipState.height * unit);
    pipState.x = Math.round((vp.pageLeft + Math.max(0, (vp.width - cssW) / 2)) * 100) / 100;
    pipState.y = Math.round((vp.pageTop + Math.max(0, (vp.height - cssH) / 2)) * 100) / 100;
  }

  function ensureVisibleInViewport(wasAlreadyOpen) {
    const vp = getViewportRect();
    const mobileDoc = isMobileDocMode();
    if (mobileDoc) {
      if (!wasAlreadyOpen || typeof pipState.x !== 'number' || typeof pipState.y !== 'number') {
        centerMobileCardInViewport(vp);
        return;
      }
      const u = pipState.mobileDocUnit || getVisualUnit(vp);
      const cssW = pipState.width * u;
      const cssH = pipState.height * u;
      const visLeft = Math.max(vp.pageLeft, pipState.x);
      const visTop = Math.max(vp.pageTop, pipState.y);
      const visRight = Math.min(vp.pageLeft + vp.width, pipState.x + cssW);
      const visBottom = Math.min(vp.pageTop + vp.height, pipState.y + cssH);
      const overlapArea = Math.max(0, visRight - visLeft) * Math.max(0, visBottom - visTop);
      const visibleRatio = overlapArea / Math.max(1, cssW * cssH);
      if (visibleRatio < 0.05) {
        centerMobileCardInViewport(vp);
      }
      return;
    }

    const unit = getVisualUnit(vp);
    if (pipState.preset && SIZE_PRESETS[pipState.preset]) {
      const pDims = getPresetSize(pipState.preset, vp);
      pipState.width = pDims.width;
      pipState.height = pDims.height;
    }

    const dims = clampSize(pipState.width, pipState.height, vp);
    pipState.width = dims.width;
    pipState.height = dims.height;
    const cssW = Math.min(vp.width, dims.width * unit);
    const cssH = Math.min(vp.height, dims.height * unit);

    const placeDefaultInViewport = () => {
      pipState.x = Math.round(vp.left + vp.width - cssW - 16);
      pipState.y = Math.round(vp.top + vp.height - cssH - 16);
    };

    if (typeof pipState.x !== 'number' || typeof pipState.y !== 'number') {
      placeDefaultInViewport();
      return;
    }

    const visLeft = Math.max(vp.left, pipState.x);
    const visTop = Math.max(vp.top, pipState.y);
    const visRight = Math.min(vp.left + vp.width, pipState.x + cssW);
    const visBottom = Math.min(vp.top + vp.height, pipState.y + cssH);
    const overlapArea = Math.max(0, visRight - visLeft) * Math.max(0, visBottom - visTop);
    const cardArea = Math.max(1, cssW * cssH);
    const visibleRatio = overlapArea / cardArea;

    if (!wasAlreadyOpen && visibleRatio < 0.85) {
      if (visibleRatio < 0.25) {
        placeDefaultInViewport();
      } else {
        const clamped = clampPosition(pipState.x, pipState.y, cssW, cssH, vp);
        pipState.x = clamped.x;
        pipState.y = clamped.y;
      }
    } else if (visibleRatio < 0.99) {
      const clamped = clampPosition(pipState.x, pipState.y, cssW, cssH, vp);
      pipState.x = clamped.x;
      pipState.y = clamped.y;
    }
  }

  function isDemoCurrentlyPaused() {
    const player = getPlayer();
    if (!player) return false;
    const rawMod = window.Module || (typeof player.getModule === 'function' ? player.getModule() : null);
    const mod =
      rawMod && (!rawMod.Asyncify || (rawMod.Asyncify.state === 0 && !rawMod.Asyncify.currData))
        ? rawMod
        : null;
    if (mod && typeof mod._JK_DemoIsPaused === 'function') {
      return mod._JK_DemoIsPaused() === 1;
    }
    if (typeof player.isPaused === 'function') {
      return Boolean(player.isPaused());
    }
    const st = typeof player.getStatus === 'function' ? player.getStatus() : null;
    return Boolean(st && st.isPaused);
  }

  function clearFullscreenControlsTimer() {
    if (pipState.fsControlsTimer) {
      clearTimeout(pipState.fsControlsTimer);
      pipState.fsControlsTimer = null;
    }
  }

  function isExportTrimActive() {
    return Boolean(
      window.JKVideoExport &&
        typeof window.JKVideoExport.isTrimActive === 'function' &&
        window.JKVideoExport.isTrimActive()
    );
  }

  function showFullscreenControls(scheduleAutoHide) {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    card.classList.remove('jk-pip-fs-controls-hidden');
    clearFullscreenControlsTimer();
    if (!scheduleAutoHide || !isCardFullscreen()) return;
    if (
      isDemoCurrentlyPaused() ||
      pipState.scrubbing ||
      pipState.lightingOpen ||
      pipState.scrubbingGamma ||
      isExportTrimActive()
    ) {
      return;
    }
    pipState.fsControlsTimer = setTimeout(() => {
      pipState.fsControlsTimer = null;
      if (
        !isCardFullscreen() ||
        isDemoCurrentlyPaused() ||
        pipState.scrubbing ||
        pipState.lightingOpen ||
        pipState.scrubbingGamma ||
        isExportTrimActive()
      ) {
        return;
      }
      const speedSelect = document.getElementById('jk-pip-speed');
      if (speedSelect && document.activeElement === speedSelect) {
        showFullscreenControls(true);
        return;
      }
      card.classList.add('jk-pip-fs-controls-hidden');
    }, FS_CONTROLS_HIDE_DELAY_MS);
  }

  window.__jkOnCanvasTap = function () {
    const card = document.getElementById('jk-pip-card');
    if (!card || !isCardFullscreen()) return false;
    if (card.classList.contains('jk-pip-fs-controls-hidden')) {
      showFullscreenControls(true);
      return true;
    }
    showFullscreenControls(true);
    return false;
  };

  function syncFullscreenUI() {
    const card = document.getElementById('jk-pip-card');
    const fsBtn = document.getElementById('jk-pip-fullscreen');
    const active = isCardFullscreen();
    if (!active && card) {
      clearFullscreenControlsTimer();
      card.classList.remove('jk-pip-fs-controls-hidden', 'jk-pip-force-landscape');
    }
    if (fsBtn) {
      fsBtn.classList.toggle('active', active);
      fsBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
      fsBtn.title = active ? 'Exit Fullscreen' : 'Fullscreen';
      fsBtn.setAttribute('aria-label', active ? 'Exit Fullscreen' : 'Fullscreen');
      fsBtn.innerHTML = active ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN_ENTER;
    }
  }

  let lastAppliedPlayerW = 0;
  let lastAppliedPlayerH = 0;

  function applyCardGeometry(opts) {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const options = opts || {};
    const vp = getViewportRect();
    const unit = getVisualUnit(vp);
    const physVpW = vp.width / unit;
    const physVpH = vp.height / unit;
    const nativeFs = getFullscreenElement() === card;
    const pseudoFs = card.classList.contains('jk-pip-pseudo-fullscreen');
    const mobileDoc = isMobileDocMode();

    let targetW = pipState.width;
    let targetH = pipState.height;

    if (nativeFs) {
      const fsW = window.innerWidth || vp.width;
      const fsH = window.innerHeight || vp.height;
      const forceLandscape = mobileDoc && fsW < fsH;
      card.classList.toggle('jk-pip-force-landscape', forceLandscape);
      card.style.position = 'fixed';
      card.style.setProperty('--jk-ui-scale', '1');
      if (!forceLandscape) {
        card.style.transform = 'none';
      }
      const effW = forceLandscape ? fsH : fsW;
      const effH = forceLandscape ? fsW : fsH;
      card.classList.toggle('jk-pip-narrow', effW < 450);
      card.classList.toggle('jk-pip-xs', effW < 310);
      targetW = Math.round(effW);
      targetH = Math.round(effH);
    } else if (pseudoFs) {
      const forceLandscape = mobileDoc && vp.width < vp.height;
      card.classList.toggle('jk-pip-force-landscape', forceLandscape);
      card.style.position = 'fixed';
      const effW = forceLandscape ? physVpH : physVpW;
      const effH = forceLandscape ? physVpW : physVpH;
      card.classList.toggle('jk-pip-narrow', effW < 450);
      card.classList.toggle('jk-pip-xs', effW < 310);
      card.style.left = Math.round(vp.left * 100) / 100 + 'px';
      card.style.top = Math.round(vp.top * 100) / 100 + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
      if (forceLandscape) {
        card.style.setProperty('--jk-ui-scale', '1');
        card.style.width = Math.round(physVpH * 100) / 100 + 'px';
        card.style.height = Math.round(physVpW * 100) / 100 + 'px';
        card.style.transformOrigin = '0 0';
        card.style.transform =
          'translateX(' +
          Math.round(vp.width * 100) / 100 +
          'px) scale(' +
          Math.round(unit * 100000) / 100000 +
          ') rotate(90deg)';
      } else if (unit < 0.999) {
        card.style.setProperty('--jk-ui-scale', '1');
        card.style.width = Math.round((vp.width / unit) * 100) / 100 + 'px';
        card.style.height = Math.round((vp.height / unit) * 100) / 100 + 'px';
        card.style.transformOrigin = '0 0';
        card.style.transform = 'scale(' + Math.round(unit * 100000) / 100000 + ')';
      } else {
        card.style.setProperty('--jk-ui-scale', String(Math.round(unit * 10000) / 10000));
        card.style.transform = 'none';
        card.style.width = Math.round(vp.width * 100) / 100 + 'px';
        card.style.height = Math.round(vp.height * 100) / 100 + 'px';
      }
      targetW = Math.round(effW);
      targetH = Math.round(effH);
    } else if (mobileDoc) {
      card.classList.remove('jk-pip-force-landscape');
      card.style.position = 'absolute';
      if (typeof pipState.x !== 'number' || typeof pipState.y !== 'number') {
        centerMobileCardInViewport(vp);
      }
      const docUnit = pipState.mobileDocUnit || unit;
      pipState.mobileDocUnit = docUnit;
      const cssW = Math.round(pipState.width * docUnit * 100) / 100;
      card.classList.toggle('jk-pip-narrow', pipState.width < 450);
      card.classList.toggle('jk-pip-xs', pipState.width < 310);
      if (docUnit < 0.999) {
        card.style.setProperty('--jk-ui-scale', '1');
        card.style.width = Math.round(pipState.width * 100) / 100 + 'px';
        card.style.transformOrigin = '0 0';
        card.style.transform = 'scale(' + Math.round(docUnit * 100000) / 100000 + ')';
        const trimExtraPhys = getTrimExtraPhysH(docUnit);
        const renderPhysH = pipState.height + trimExtraPhys;
        card.style.height = Math.round(renderPhysH * 100) / 100 + 'px';
        targetW = Math.round(cssW);
        targetH = Math.round(renderPhysH * docUnit);
      } else {
        card.style.setProperty('--jk-ui-scale', String(Math.round(docUnit * 10000) / 10000));
        card.style.transform = 'none';
        card.style.width = cssW + 'px';
        const trimExtraPhys = getTrimExtraPhysH(docUnit);
        const renderCssH = Math.round((pipState.height + trimExtraPhys) * docUnit * 100) / 100;
        card.style.height = renderCssH + 'px';
        targetW = Math.round(cssW);
        targetH = Math.round(renderCssH);
      }
      card.style.left = Math.max(0, Math.round(pipState.x * 100) / 100) + 'px';
      card.style.top = Math.max(0, Math.round(pipState.y * 100) / 100) + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    } else {
      card.classList.remove('jk-pip-force-landscape');
      card.style.position = 'fixed';
      if (pipState.preset && SIZE_PRESETS[pipState.preset]) {
        const pDims = getPresetSize(pipState.preset, vp);
        pipState.width = pDims.width;
        pipState.height = pDims.height;
      }
      const dims = clampSize(pipState.width, pipState.height, vp);
      pipState.width = dims.width;
      pipState.height = dims.height;
      const cssW = Math.round(Math.min(vp.width, dims.width * unit) * 100) / 100;
      const baseCssH = Math.round(Math.min(vp.height, dims.height * unit) * 100) / 100;

      card.classList.toggle('jk-pip-narrow', dims.width < 450);
      card.classList.toggle('jk-pip-xs', dims.width < 310);
      card.style.setProperty('--jk-ui-scale', '1');
      card.style.transform = 'none';
      card.style.width = cssW + 'px';

      const trimExtraPhys = getTrimExtraPhysH(unit);
      const marginCss = (physVpW < 440 ? 4 : 8) * unit;
      const maxCardCssH = Math.max(HARD_MIN_HEIGHT * unit, vp.height - marginCss * 2);
      const renderCssH =
        trimExtraPhys > 0
          ? Math.round(Math.min(maxCardCssH, (dims.height + trimExtraPhys) * unit) * 100) / 100
          : baseCssH;
      card.style.height = renderCssH + 'px';

      if (typeof pipState.x !== 'number' || typeof pipState.y !== 'number') {
        pipState.x = Math.round(vp.left + vp.width - cssW - 16);
        pipState.y = Math.round(vp.top + vp.height - baseCssH - 16);
      }
      if (trimExtraPhys > 0 && !pipState.dragging && !pipState.resizing) {
        const basePos = clampPosition(pipState.x, pipState.y, cssW, baseCssH, vp);
        pipState.x = basePos.x;
        pipState.y = basePos.y;
        const renderPos = clampPosition(basePos.x, basePos.y, cssW, renderCssH, vp);
        card.style.left = renderPos.x + 'px';
        card.style.top = renderPos.y + 'px';
      } else {
        const pos = clampPosition(pipState.x, pipState.y, cssW, renderCssH, vp);
        pipState.x = pos.x;
        pipState.y = pos.y;
        card.style.left = pos.x + 'px';
        card.style.top = pos.y + 'px';
      }
      card.style.right = 'auto';
      card.style.bottom = 'auto';
      targetW = pipState.width;
      targetH = Math.round(renderCssH / unit);
    }

    ['compact', 'default', 'large'].forEach((p) => {
      const btn = document.getElementById('jk-pip-size-' + p);
      if (btn) {
        const isCurrent = pipState.preset === p;
        btn.classList.toggle('active', isCurrent);
        btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      }
    });

    syncFullscreenUI();

    const sizeChanged = targetW !== lastAppliedPlayerW || targetH !== lastAppliedPlayerH;
    if (!options.skipPlayerResize || sizeChanged) {
      lastAppliedPlayerW = targetW;
      lastAppliedPlayerH = targetH;
      const player = window.JKDemoPlayer || window.OpenJKPlayer;
      if (player && typeof player.resize === 'function') {
        player.resize();
      }
    }
  }

  function syncCoordsFromDOM() {
    const card = document.getElementById('jk-pip-card');
    if (!card || isCardFullscreen()) return;
    const vp = getViewportRect();
    const rect = card.getBoundingClientRect();
    if (isMobileDocMode()) {
      const u = pipState.mobileDocUnit || getVisualUnit(vp);
      const trimExtra = getTrimExtraPhysH(u);
      const scrollX = Number(window.scrollX ?? window.pageXOffset) || 0;
      const scrollY = Number(window.scrollY ?? window.pageYOffset) || 0;
      pipState.x = rect.left + scrollX;
      pipState.y = rect.top + scrollY;
      if (rect.width > 0) pipState.width = Math.round(rect.width / u);
      if (rect.height > 0) pipState.height = Math.max(HARD_MIN_HEIGHT, Math.round(rect.height / u) - trimExtra);
    } else {
      const unit = getVisualUnit(vp);
      const trimExtra = getTrimExtraPhysH(unit);
      pipState.x = rect.left;
      pipState.y = rect.top;
      if (rect.width > 0) pipState.width = Math.round(rect.width / unit);
      if (rect.height > 0) pipState.height = Math.max(HARD_MIN_HEIGHT, Math.round(rect.height / unit) - trimExtra);
    }
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
      <div id="jk-pip-header" class="jk-pip-header">
        <div id="jk-pip-drag-handle" class="jk-pip-drag-handle" tabindex="0" role="button" aria-label="Drag player window or move with arrow keys" title="Drag to move">
          <svg class="jk-icon-svg jk-pip-drag-grip" viewBox="0 0 10 14" width="10" height="14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>
          <span id="jk-pip-title" class="jk-pip-title">JKA Demo Player</span>
        </div>
        <div class="jk-pip-header-actions">
          <div class="jk-pip-size-group" role="group" aria-label="Player size">
            <button type="button" id="jk-pip-size-compact" class="jk-pip-hdr-btn jk-pip-preset-btn" data-size-preset="compact" title="Compact size" aria-label="S — Compact size" aria-pressed="false">S</button>
            <button type="button" id="jk-pip-size-default" class="jk-pip-hdr-btn jk-pip-preset-btn active" data-size-preset="default" title="Default size" aria-label="M — Default size" aria-pressed="true">M</button>
            <button type="button" id="jk-pip-size-large" class="jk-pip-hdr-btn jk-pip-preset-btn" data-size-preset="large" title="Large size" aria-label="L — Large size" aria-pressed="false">L</button>
          </div>
          <span class="jk-pip-header-divider" aria-hidden="true"></span>
          <button type="button" id="jk-pip-close" class="jk-pip-hdr-btn" title="Close player" aria-label="Close player"><svg class="jk-icon-svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>
        </div>
      </div>
      <div id="jk-pip-viewport">
        <canvas id="jk-canvas" width="640" height="360" tabindex="-1"></canvas>
        <div id="jk-pip-tap-indicator" aria-hidden="true"></div>
        <div id="jk-pip-status-overlay">
          <div class="jk-pip-status-row">
            <span id="jk-pip-status-text">Loading demo...</span>
            <span id="jk-pip-status-pct">0%</span>
          </div>
          <div class="jk-pip-progress-track">
            <div id="jk-pip-progress-bar"></div>
          </div>
        </div>
      </div>
      <div id="jk-pip-controls">
        <div class="jk-pip-timeline-row">
          <input type="range" id="jk-pip-seek" min="0" max="1000" step="1" value="0" aria-label="Seek timeline" />
          <span id="jk-pip-time">0:00 / 0:00</span>
        </div>
        <div class="jk-pip-buttons-row">
          <div class="jk-pip-btn-group jk-pip-primary-group">
            <button type="button" id="jk-pip-play-pause" class="jk-pip-ctrl-btn" title="Play / Pause">Pause</button>
          </div>
          <div class="jk-pip-btn-group jk-pip-secondary-group">
            <select id="jk-pip-speed" class="jk-pip-select" aria-label="Playback speed" title="Playback speed">
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
            <button type="button" id="jk-pip-loop" class="jk-pip-ctrl-btn active" title="Loop Demo" aria-pressed="true">Loop: On</button>
            <button type="button" id="jk-pip-camera" class="jk-pip-ctrl-btn${pipState.thirdPerson ? '' : ' active'}" title="Switch camera view (1st / 3rd person)" aria-label="${pipState.thirdPerson ? 'View: 3rd — Switch to first-person camera' : 'View: 1st — Switch to third-person camera'}">${pipState.thirdPerson ? 'View: 3rd' : 'View: 1st'}</button>
            <button type="button" id="jk-pip-start-over" class="jk-pip-ctrl-btn" title="Restart from 0:00" aria-label="0:00 — Restart from beginning">0:00</button>
            <button type="button" id="jk-pip-lighting-btn" class="jk-pip-ctrl-btn" title="Brightness &amp; Lighting (Gamma / Overbright)" aria-label="Lighting settings" aria-expanded="false" aria-controls="jk-pip-lighting-panel">${ICON_BRIGHTNESS}<span class="jk-pip-light-label">Light</span></button>
            <button type="button" id="jk-pip-export-btn" class="jk-pip-ctrl-btn" title="Export video clip (.mp4)" aria-label="Export video clip" aria-pressed="false">${ICON_CLIP}<span class="jk-pip-clip-label">Clip</span></button>
          </div>
          <div class="jk-pip-btn-group jk-pip-audio-group">
            <button type="button" id="jk-pip-music" class="jk-pip-ctrl-btn${pipState.musicEnabled ? ' active' : ''}" data-music-icon="${pipState.musicEnabled ? '1' : '0'}" title="${pipState.musicEnabled ? 'Background music on (click to mute music only)' : 'Background music off (sound effects still play)'}" aria-label="Music" aria-pressed="${pipState.musicEnabled ? 'true' : 'false'}"><span class="jk-pip-music-icon" aria-hidden="true">${pipState.musicEnabled ? ICON_MUSIC_ON : ICON_MUSIC_OFF}</span><span class="jk-pip-music-label">Music</span></button>
            <button type="button" id="jk-pip-mute" class="jk-pip-ctrl-btn" title="Mute / Unmute">Mute</button>
            <input type="range" id="jk-pip-volume" min="0" max="1" step="0.01" value="0.8" aria-label="Volume" />
            <button type="button" id="jk-pip-fullscreen" class="jk-pip-ctrl-btn" title="Fullscreen" aria-label="Fullscreen" aria-pressed="false">${ICON_FULLSCREEN_ENTER}</button>
          </div>
        </div>
      </div>
      <div id="jk-pip-lighting-panel" role="region" aria-label="Brightness and lighting" hidden>
        <div class="jk-pip-light-presets" role="group" aria-label="Lighting presets">
          <button type="button" class="jk-pip-light-preset-btn" data-light-preset="stock" title="Stock JKA lighting (r_gamma 1, r_mapOverBrightBits 0)">Stock</button>
          <button type="button" class="jk-pip-light-preset-btn" data-light-preset="overbright" title="Overbright lightmaps (r_gamma 1, r_mapOverBrightBits 2)">Overbright</button>
          <button type="button" class="jk-pip-light-preset-btn" data-light-preset="gamma2" title="Gamma 2.0 (r_gamma 2, r_mapOverBrightBits 0)">Gamma 2</button>
          <button type="button" class="jk-pip-light-preset-btn" data-light-preset="bright" title="Balanced bright combo (r_gamma 1.4, r_mapOverBrightBits 1)">Bright+</button>
        </div>
        <div class="jk-pip-light-row">
          <div class="jk-pip-light-row-hdr">
            <label for="jk-pip-gamma" title="Display gamma curve (r_gamma)">Gamma</label>
            <span id="jk-pip-gamma-val" class="jk-pip-light-val">1.00</span>
          </div>
          <input type="range" id="jk-pip-gamma" class="jk-pip-styled-range" min="1" max="2.5" step="0.05" value="1" aria-valuetext="1.00 (Stock)" />
        </div>
        <div class="jk-pip-light-row">
          <div class="jk-pip-light-row-hdr">
            <span id="jk-pip-ob-label" title="Map lightmap overbright bits (r_mapOverBrightBits)">Overbright</span>
          </div>
          <div class="jk-pip-ob-group" role="group" aria-labelledby="jk-pip-ob-label">
            <button type="button" class="jk-pip-ob-btn active" data-overbright="0" aria-pressed="true">0 (Off)</button>
            <button type="button" class="jk-pip-ob-btn" data-overbright="1" aria-pressed="false">+1</button>
            <button type="button" class="jk-pip-ob-btn" data-overbright="2" aria-pressed="false">+2</button>
          </div>
        </div>
      </div>
      <div class="jk-pip-resize-zone jk-pip-resize-nw" data-resize-dir="nw" aria-hidden="true" title="Resize player"></div>
      <div class="jk-pip-resize-zone jk-pip-resize-n" data-resize-dir="n" aria-hidden="true"></div>
      <div class="jk-pip-resize-zone jk-pip-resize-ne" data-resize-dir="ne" aria-hidden="true" title="Resize player"></div>
      <div class="jk-pip-resize-zone jk-pip-resize-w" data-resize-dir="w" aria-hidden="true"></div>
      <div class="jk-pip-resize-zone jk-pip-resize-e" data-resize-dir="e" aria-hidden="true"></div>
      <div class="jk-pip-resize-zone jk-pip-resize-s" data-resize-dir="s" aria-hidden="true"></div>
      <div id="jk-pip-resize-handle-sw" class="jk-pip-resize-zone jk-pip-resize-sw" data-resize-dir="sw" aria-hidden="true" title="Resize player"></div>
      <div id="jk-pip-resize-handle" class="jk-pip-resize-zone jk-pip-resize-se" data-resize-dir="se" aria-hidden="true" title="Resize player"></div>
    `;

    document.body.appendChild(card);
    bindPiPEvents(card);
    applyCanvasGammaFilterLocal(pipState.gamma);
    syncLightingUI();
    applyCardGeometry();
    return card;
  }

  function bindPiPEvents(card) {
    const header = card.querySelector('#jk-pip-header');
    const dragHandle = card.querySelector('#jk-pip-drag-handle') || header;
    const resizeHandles = Array.from(card.querySelectorAll('.jk-pip-resize-zone'));
    const closeBtn = card.querySelector('#jk-pip-close');
    const playPauseBtn = card.querySelector('#jk-pip-play-pause');
    const startOverBtn = card.querySelector('#jk-pip-start-over');
    const loopBtn = card.querySelector('#jk-pip-loop');
    const cameraBtn = card.querySelector('#jk-pip-camera');
    const seekInput = card.querySelector('#jk-pip-seek');
    const speedSelect = card.querySelector('#jk-pip-speed');
    const musicBtn = card.querySelector('#jk-pip-music');
    const muteBtn = card.querySelector('#jk-pip-mute');
    const volumeInput = card.querySelector('#jk-pip-volume');
    const fullscreenBtn = card.querySelector('#jk-pip-fullscreen');

    // Header dragging via Pointer Events (disabled while fullscreen)
    header.addEventListener('pointerdown', (e) => {
      if (isCardFullscreen()) {
        showFullscreenControls(true);
        return;
      }
      if (e.target && e.target.closest('button')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      syncCoordsFromDOM();
      pipState.dragging = true;
      pipState.dragPointerId = e.pointerId;
      const rect = card.getBoundingClientRect();
      pipState.dragOffsetX = e.clientX - rect.left;
      pipState.dragOffsetY = e.clientY - rect.top;
      pipState.dragStartClientX = e.clientX;
      pipState.dragStartClientY = e.clientY;
      pipState.dragStartX = pipState.x;
      pipState.dragStartY = pipState.y;
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
      const vp = getViewportRect();
      if (isMobileDocMode()) {
        const u = pipState.mobileDocUnit || getVisualUnit(vp);
        const boxW = pipState.width * u;
        const boxH = (pipState.height + getTrimExtraPhysH(u)) * u;
        const docW = Math.max(
          document.documentElement ? document.documentElement.scrollWidth || 0 : 0,
          document.body ? document.body.scrollWidth || 0 : 0,
          vp.pageLeft + vp.width
        );
        const docH = Math.max(
          document.documentElement ? document.documentElement.scrollHeight || 0 : 0,
          document.body ? document.body.scrollHeight || 0 : 0,
          vp.pageTop + vp.height
        );
        pipState.x = Math.max(
          0,
          Math.min(Math.max(0, docW - boxW), pipState.dragStartX + (e.clientX - pipState.dragStartClientX))
        );
        pipState.y = Math.max(
          0,
          Math.min(Math.max(0, docH - boxH), pipState.dragStartY + (e.clientY - pipState.dragStartClientY))
        );
        card.style.left = Math.round(pipState.x * 100) / 100 + 'px';
        card.style.top = Math.round(pipState.y * 100) / 100 + 'px';
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        return;
      }
      const unit = getVisualUnit(vp);
      const trimExtra = getTrimExtraPhysH(unit);
      const nextX = e.clientX - pipState.dragOffsetX;
      const nextY = e.clientY - pipState.dragOffsetY;
      const pos = clampPosition(nextX, nextY, pipState.width * unit, (pipState.height + trimExtra) * unit, vp);
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

    // Keyboard accessibility on dedicated drag handle (Arrow keys move card by 20px; Shift+Arrow resizes)
    dragHandle.addEventListener('keydown', (e) => {
      if (isCardFullscreen()) return;
      const step = 20;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        syncCoordsFromDOM();
        if (e.shiftKey) {
          pipState.preset = 'custom';
          let nextW = pipState.width;
          let nextH = pipState.height;
          if (e.key === 'ArrowLeft') nextW -= step;
          if (e.key === 'ArrowRight') nextW += step;
          if (e.key === 'ArrowUp') nextH -= step;
          if (e.key === 'ArrowDown') nextH += step;
          const dims = clampSize(nextW, nextH);
          pipState.width = dims.width;
          pipState.height = dims.height;
        } else {
          if (e.key === 'ArrowLeft') pipState.x -= step;
          if (e.key === 'ArrowRight') pipState.x += step;
          if (e.key === 'ArrowUp') pipState.y -= step;
          if (e.key === 'ArrowDown') pipState.y += step;
        }
        applyCardGeometry();
        saveLayout();
        e.preventDefault();
      }
    });

    // Multi-edge / multi-corner resize handles via Pointer Events
    const startResizeDrag = (handleEl, e) => {
      if (isCardFullscreen()) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const vp = getViewportRect();
      if (isMobileDocMode()) {
        const rect = card.getBoundingClientRect();
        const scrollX = Number(window.scrollX ?? window.pageXOffset) || 0;
        const scrollY = Number(window.scrollY ?? window.pageYOffset) || 0;
        const nextUnit = getVisualUnit(vp);
        const trimExtra = getTrimExtraPhysH(nextUnit);
        pipState.mobileDocUnit = nextUnit;
        pipState.x = rect.left + scrollX;
        pipState.y = rect.top + scrollY;
        if (rect.width > 0) pipState.width = rect.width / nextUnit;
        if (rect.height > 0) pipState.height = Math.max(HARD_MIN_HEIGHT, rect.height / nextUnit - trimExtra);
      } else {
        syncCoordsFromDOM();
      }
      pipState.resizing = true;
      pipState.resizeDir = (handleEl && handleEl.dataset && handleEl.dataset.resizeDir) || 'se';
      pipState.resizeHandleEl = handleEl;
      pipState.resizePointerId = e.pointerId;
      pipState.resizeStartX = e.clientX;
      pipState.resizeStartY = e.clientY;
      pipState.resizeStartW = pipState.width;
      pipState.resizeStartH = pipState.height;
      pipState.resizeStartCardX = pipState.x;
      pipState.resizeStartCardY = pipState.y;
      pipState.preset = 'custom';
      if (handleEl && typeof handleEl.setPointerCapture === 'function') {
        try {
          handleEl.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onResizePointerMove = (e) => {
      if (!pipState.resizing) return;
      if (pipState.resizePointerId !== null && e.pointerId !== pipState.resizePointerId) return;
      const vp = getViewportRect();
      const mobileDoc = isMobileDocMode();
      const unit = mobileDoc ? pipState.mobileDocUnit || getVisualUnit(vp) : getVisualUnit(vp);
      const physVpW = vp.width / unit;
      const marginCss = (physVpW < 440 ? 4 : 8) * unit;
      const dx = (e.clientX - pipState.resizeStartX) / unit;
      const dy = (e.clientY - pipState.resizeStartY) / unit;
      const dir = pipState.resizeDir || 'se';
      const hasW = dir.indexOf('w') !== -1;
      const hasE = dir.indexOf('e') !== -1;
      const hasN = dir.indexOf('n') !== -1;
      const hasS = dir.indexOf('s') !== -1;

      const trimExtra = getTrimExtraPhysH(unit);
      const anchorRight = pipState.resizeStartCardX + pipState.resizeStartW * unit;
      const anchorBottom = pipState.resizeStartCardY + (pipState.resizeStartH + trimExtra) * unit;
      const minLeft = mobileDoc ? 4 * unit : vp.left + marginCss;
      const minTop = mobileDoc ? 4 * unit : vp.top + marginCss;

      let rawW = pipState.resizeStartW;
      if (hasW) {
        const maxWestW = Math.max(HARD_MIN_WIDTH, (anchorRight - minLeft) / unit);
        rawW = Math.min(pipState.resizeStartW - dx, maxWestW);
      } else if (hasE) {
        rawW = pipState.resizeStartW + dx;
      }

      let rawH = pipState.resizeStartH;
      if (hasN) {
        const maxNorthH = Math.max(HARD_MIN_HEIGHT, (anchorBottom - minTop) / unit - trimExtra);
        rawH = Math.min(pipState.resizeStartH - dy, maxNorthH);
      } else if (hasS) {
        rawH = pipState.resizeStartH + dy;
      }

      const dims = clampSize(rawW, rawH, vp);
      pipState.width = dims.width;
      pipState.height = dims.height;

      if (hasW) {
        pipState.x = Math.round(Math.max(0, anchorRight - dims.width * unit) * 100) / 100;
      } else if (hasE) {
        if (mobileDoc) {
          const layoutW = Math.max(
            (document.documentElement && document.documentElement.clientWidth) || 0,
            vp.pageLeft + vp.width,
            pipState.resizeStartCardX + pipState.resizeStartW * unit + 4 * unit
          );
          const maxLeft = Math.max(0, layoutW - dims.width * unit - 4 * unit);
          pipState.x = Math.round(Math.max(0, Math.min(pipState.resizeStartCardX, maxLeft)) * 100) / 100;
        } else {
          pipState.x = pipState.resizeStartCardX;
        }
      }

      if (hasN) {
        pipState.y = Math.round(Math.max(0, anchorBottom - (dims.height + trimExtra) * unit) * 100) / 100;
      } else if (hasS) {
        pipState.y = pipState.resizeStartCardY;
      }

      applyCardGeometry();
    };

    const endResizeDrag = (e) => {
      if (!pipState.resizing) return;
      if (e && pipState.resizePointerId !== null && e.pointerId !== undefined && e.pointerId !== pipState.resizePointerId) {
        return;
      }
      pipState.resizing = false;
      const activeHandle = pipState.resizeHandleEl;
      if (e && activeHandle && typeof activeHandle.releasePointerCapture === 'function' && pipState.resizePointerId !== null) {
        try {
          activeHandle.releasePointerCapture(pipState.resizePointerId);
        } catch (_) {}
      }
      pipState.resizeHandleEl = null;
      pipState.resizePointerId = null;
      saveLayout();
    };

    resizeHandles.forEach((handleEl) => {
      handleEl.addEventListener('pointerdown', (e) => startResizeDrag(handleEl, e));
      handleEl.addEventListener('pointermove', onResizePointerMove);
      handleEl.addEventListener('pointerup', endResizeDrag);
      handleEl.addEventListener('pointercancel', endResizeDrag);
    });
    window.addEventListener('pointermove', onResizePointerMove);
    window.addEventListener('pointerup', endResizeDrag);
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

    // Play/Pause (or Retry when load failed)
    playPauseBtn.addEventListener('click', (e) => {
      if (e && e.isTrusted) primeSharedAudioOnUserGesture();
      togglePause();
    });

    const viewportEl = card.querySelector('#jk-pip-viewport');
    if (viewportEl) {
      viewportEl.addEventListener('click', (e) => {
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        if (pipState.loadFailed && pipState.currentDemoUrl) {
          e.preventDefault();
          e.stopPropagation();
          openAndPlay(pipState.currentDemoUrl, {
            label: pipState.currentDemoTitle,
            unmuteOnUserGesture: Boolean(e && e.isTrusted),
          });
        }
      });
    }

    // Start Over (0:00)
    startOverBtn.addEventListener('click', (e) => {
      if (e && e.isTrusted) primeSharedAudioOnUserGesture();
      startOver();
    });

    // Loop toggle
    loopBtn.addEventListener('click', () => {
      toggleLoop();
    });

    // Camera view toggle (3rd-person vs 1st-person)
    if (cameraBtn) {
      cameraBtn.addEventListener('click', (e) => {
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        toggleThirdPerson();
      });
    }

    // Lighting / Brightness panel & controls
    const lightingBtn = card.querySelector('#jk-pip-lighting-btn');
    const lightingPanel = card.querySelector('#jk-pip-lighting-panel');
    const gammaInput = card.querySelector('#jk-pip-gamma');
    const exportBtn = card.querySelector('#jk-pip-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        if (pipState.lightingOpen) {
          setLightingPanelOpen(false);
        }
        await ensureVideoExportScriptLoaded().catch(() => {});
        if (window.JKVideoExport && typeof window.JKVideoExport.openForPiP === 'function') {
          window.JKVideoExport.openForPiP();
          if (isCardFullscreen()) {
            showFullscreenControls(false);
          }
        }
      });
    }
    if (lightingBtn) {
      lightingBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        setLightingPanelOpen(!pipState.lightingOpen);
      });
    }
    if (lightingPanel) {
      lightingPanel.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (isCardFullscreen()) {
          showFullscreenControls(false);
        }
      });
      lightingPanel.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      const presetBtns = Array.from(lightingPanel.querySelectorAll('[data-light-preset]'));
      presetBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-light-preset');
          if (key) {
            applyLightingPreset(key);
          }
        });
      });
      const obBtns = Array.from(lightingPanel.querySelectorAll('[data-overbright]'));
      obBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          const ob = parseInt(btn.getAttribute('data-overbright') || '0', 10);
          if (Number.isFinite(ob)) {
            setOverbright(ob);
          }
        });
      });
    }
    if (gammaInput) {
      const syncGammaSliderVars = () => {
        gammaInput.style.setProperty('--attr-min', gammaInput.min || '1');
        gammaInput.style.setProperty('--attr-max', gammaInput.max || '2.5');
        gammaInput.style.setProperty('--control-value', gammaInput.value);
      };
      syncGammaSliderVars();
      gammaInput.addEventListener('pointerdown', () => {
        pipState.scrubbingGamma = true;
        if (isCardFullscreen()) {
          showFullscreenControls(false);
        }
      });
      const finishGammaScrub = () => {
        if (!pipState.scrubbingGamma) return;
        pipState.scrubbingGamma = false;
      };
      gammaInput.addEventListener('pointerup', finishGammaScrub);
      gammaInput.addEventListener('pointercancel', finishGammaScrub);
      const onGammaEvent = () => {
        syncGammaSliderVars();
        const val = parseFloat(gammaInput.value);
        if (Number.isFinite(val)) {
          setGamma(val);
        }
      };
      gammaInput.addEventListener('input', onGammaEvent);
      gammaInput.addEventListener('change', () => {
        pipState.scrubbingGamma = false;
        onGammaEvent();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (!pipState.lightingOpen) return;
      const t = e.target;
      if (
        (lightingPanel && lightingPanel.contains(t)) ||
        (lightingBtn && lightingBtn.contains(t))
      ) {
        return;
      }
      setLightingPanelOpen(false);
    });

    // Timeline seek slider (value in milliseconds [0, durationMs])
    seekInput.addEventListener('pointerdown', () => {
      pipState.scrubbing = true;
      if (isCardFullscreen()) {
        showFullscreenControls(false);
      }
    });
    const finishScrub = () => {
      if (!pipState.scrubbing) return;
      pipState.scrubbing = false;
      if (isCardFullscreen()) {
        showFullscreenControls(true);
      }
    };
    seekInput.addEventListener('pointerup', finishScrub);
    seekInput.addEventListener('pointercancel', finishScrub);
    let lastScrubMs = -1;
    let lastScrubAt = 0;
    seekInput.addEventListener('input', () => {
      if (isCardFullscreen()) {
        showFullscreenControls(false);
      }
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
      if (isCardFullscreen()) {
        showFullscreenControls(true);
      }
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

    // Keep floating fullscreen controls awake while interacting with header/controls or moving mouse
    const controlsEl = card.querySelector('#jk-pip-controls');
    const wakeOnControlActivity = () => {
      if (isCardFullscreen()) {
        showFullscreenControls(true);
      }
    };
    for (const barEl of [header, controlsEl]) {
      if (!barEl) continue;
      barEl.addEventListener('pointerdown', wakeOnControlActivity);
      barEl.addEventListener('pointerup', wakeOnControlActivity);
      barEl.addEventListener('click', wakeOnControlActivity);
      barEl.addEventListener('focusin', wakeOnControlActivity);
    }
    card.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && isCardFullscreen()) {
        showFullscreenControls(true);
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
    let wasAudioBlockedOnPress = false;
    const captureBlockedState = () => {
      if (wasAudioBlockedOnPress) return;
      const player = getPlayer();
      const st = player && typeof player.getStatus === 'function' ? player.getStatus() : null;
      wasAudioBlockedOnPress =
        muteBtn.dataset.audioBlocked === '1' ||
        Boolean(player && !isMuted() && st && st.audioContextState && st.audioContextState !== 'running');
    };
    muteBtn.addEventListener('pointerdown', captureBlockedState, true);
    muteBtn.addEventListener('touchstart', captureBlockedState, { capture: true, passive: true });
    muteBtn.addEventListener('mousedown', captureBlockedState, true);
    muteBtn.addEventListener('click', (e) => {
      const recentlyUnlocked =
        !isMuted() &&
        Boolean(
          window.__jkAudioJustUnlockedAt && Date.now() - window.__jkAudioJustUnlockedAt < 1500
        );
      const shouldJustUnlock = wasAudioBlockedOnPress || recentlyUnlocked;
      wasAudioBlockedOnPress = false;
      window.__jkAudioJustUnlockedAt = 0;
      if (shouldJustUnlock) {
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        const player = getPlayer();
        if (player && typeof player.unlockAudio === 'function') player.unlockAudio();
        setMuted(false);
        return;
      }
      if (isMuted()) {
        if (e && e.isTrusted) primeSharedAudioOnUserGesture();
        setMuted(false);
      } else {
        toggleMute();
      }
    });

    if (musicBtn) {
      musicBtn.addEventListener('click', (e) => {
        if (e && e.isTrusted && !isMuted()) {
          primeSharedAudioOnUserGesture();
        }
        toggleMusic();
      });
    }

    const handleVolumeEvent = (e) => {
      if (e && e.isTrusted) primeSharedAudioOnUserGesture();
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

    const onFullscreenChanged = () => {
      const activeFs = isCardFullscreen();
      if (activeFs) {
        lockLandscapeIfMobile();
        showFullscreenControls(true);
      } else {
        unlockOrientationIfSupported();
        clearFullscreenControlsTimer();
        card.classList.remove('jk-pip-fs-controls-hidden', 'jk-pip-force-landscape');
        if (pipState.open) {
          ensureVisibleInViewport(true);
        }
      }
      if (pipState.open) {
        applyCardGeometry();
      } else {
        syncFullscreenUI();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChanged);
    document.addEventListener('webkitfullscreenchange', onFullscreenChanged);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pipState.lightingOpen) {
        e.preventDefault();
        e.stopPropagation();
        setLightingPanelOpen(false);
        const lBtn = document.getElementById('jk-pip-lighting-btn');
        if (lBtn) lBtn.focus();
        return;
      }
      if (e.key === 'Escape' && card.classList.contains('jk-pip-pseudo-fullscreen')) {
        card.classList.remove('jk-pip-pseudo-fullscreen', 'jk-pip-fs-controls-hidden', 'jk-pip-force-landscape');
        clearFullscreenControlsTimer();
        unlockOrientationIfSupported();
        ensureVisibleInViewport(true);
        applyCardGeometry();
      }
    });

    // Keep desktop PiP and active fullscreen synced on resize; in mobile non-fullscreen PiP mode,
    // allow the user to scroll away and pinch-zoom freely without chasing the viewport.
    let vvRafId = 0;
    let vvPendingResize = false;
    const scheduleViewportClamp = (fromResize) => {
      if (fromResize) vvPendingResize = true;
      if (vvRafId) return;
      vvRafId = requestAnimationFrame(() => {
        vvRafId = 0;
        const didResize = vvPendingResize;
        vvPendingResize = false;
        if (!pipState.open || pipState.dragging || pipState.resizing || pipState.scrubbing) {
          return;
        }
        if (!isCardFullscreen() && isMobileDocMode()) {
          return;
        }
        applyCardGeometry({ skipPlayerResize: !didResize });
      });
    };

    window.addEventListener('resize', () => scheduleViewportClamp(true));
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', () => scheduleViewportClamp(true));
      window.visualViewport.addEventListener('scroll', () => scheduleViewportClamp(false));
    }

    window.addEventListener('jkdemo:paused', () => {
      updateControlState();
      if (isCardFullscreen()) {
        showFullscreenControls(false);
      }
    });
    window.addEventListener('jkdemo:resumed', () => {
      updateControlState();
      if (isCardFullscreen()) {
        showFullscreenControls(true);
      }
    });
    window.addEventListener('jkdemo:audiostate', () => {
      updateControlState();
    });
    window.addEventListener('jkdemo:musicstate', (e) => {
      if (e && e.detail && typeof e.detail.musicEnabled === 'boolean') {
        pipState.musicEnabled = e.detail.musicEnabled;
      }
      syncMusicButtonUI(pipState.musicEnabled);
    });
    window.addEventListener('jkdemo:cameramode', (e) => {
      if (e && e.detail && typeof e.detail.thirdPerson === 'boolean') {
        pipState.thirdPerson = e.detail.thirdPerson;
      }
      syncCameraButtonUI(pipState.thirdPerson);
      updateControlState();
    });
    window.addEventListener('jkdemo:lighting', (e) => {
      if (e && e.detail) {
        if (typeof e.detail.gamma === 'number' && Number.isFinite(e.detail.gamma)) {
          pipState.gamma = clampGammaPref(e.detail.gamma);
        }
        if (typeof e.detail.overbright === 'number' && Number.isFinite(e.detail.overbright)) {
          pipState.overbright = clampOverbrightPref(e.detail.overbright);
        }
      }
      syncLightingUI();
    });
    window.addEventListener('jkdemo:screen-toggle', (e) => {
      updateControlState();
      const paused = Boolean(e && e.detail && e.detail.isPaused);
      if (isCardFullscreen()) {
        showFullscreenControls(!paused);
      }
      flashTapIndicator(paused);
    });

    window.addEventListener('jkdemo:progress', (e) => {
      const detail = e && e.detail ? e.detail : null;
      if (!detail) return;
      renderOverlayProgress(detail.message || 'Loading demo...', detail.percent || 0, detail.stage);
    });
  }

  function flashTapIndicator(isPausedNow) {
    const ind = document.getElementById('jk-pip-tap-indicator');
    if (!ind) return;
    ind.innerHTML = isPausedNow ? ICON_PAUSE_OVERLAY : ICON_PLAY_OVERLAY;
    ind.classList.add('jk-pip-tap-visible');
    if (pipState.tapFlashTimer) {
      clearTimeout(pipState.tapFlashTimer);
    }
    pipState.tapFlashTimer = setTimeout(() => {
      ind.classList.remove('jk-pip-tap-visible');
      pipState.tapFlashTimer = null;
    }, 450);
  }

  function renderOverlayProgress(message, percent, stage) {
    const overlay = document.getElementById('jk-pip-status-overlay');
    if (!overlay) return;
    if (stage === 'ready') {
      overlay.style.display = 'none';
      return;
    }
    const textEl = document.getElementById('jk-pip-status-text');
    const pctEl = document.getElementById('jk-pip-status-pct');
    const barEl = document.getElementById('jk-pip-progress-bar');
    const clampedPct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    if (textEl) {
      textEl.textContent = message || 'Loading demo...';
    } else {
      overlay.textContent = message || 'Loading demo...';
    }
    if (pctEl) {
      pctEl.textContent = clampedPct > 0 ? clampedPct + '%' : '';
    }
    if (barEl) {
      barEl.style.width = Math.max(4, clampedPct) + '%';
    }
  }

  function getPlayer() {
    return window.JKDemoPlayer || window.OpenJKPlayer || null;
  }

  function syncCameraButtonUI(isThirdPerson) {
    const cameraBtn = document.getElementById('jk-pip-camera');
    if (!cameraBtn) return;
    const is3p = Boolean(isThirdPerson);
    cameraBtn.textContent = is3p ? 'View: 3rd' : 'View: 1st';
    cameraBtn.setAttribute(
      'aria-label',
      is3p
        ? 'View: 3rd — Switch to first-person camera'
        : 'View: 1st — Switch to third-person camera'
    );
    cameraBtn.classList.toggle('active', !is3p);
  }

  function syncMusicButtonUI(isEnabled) {
    const musicBtn = document.getElementById('jk-pip-music');
    if (!musicBtn) return;
    const on = Boolean(isEnabled);
    musicBtn.classList.toggle('active', on);
    musicBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    musicBtn.title = on
      ? 'Background music on (click to mute music only)'
      : 'Background music off (sound effects still play)';
    const iconState = on ? '1' : '0';
    if (musicBtn.dataset.musicIcon !== iconState) {
      musicBtn.dataset.musicIcon = iconState;
      const iconEl = musicBtn.querySelector('.jk-pip-music-icon');
      if (iconEl) {
        iconEl.innerHTML = on ? ICON_MUSIC_ON : ICON_MUSIC_OFF;
      }
    }
  }

  function applyCanvasGammaFilterLocal(gammaVal) {
    const canvas = document.getElementById('jk-canvas');
    if (!canvas) return;
    const g = clampGammaPref(gammaVal);
    if (Math.abs(g - 1.0) < 0.005) {
      if (canvas.style.filter) {
        canvas.style.filter = '';
      }
      return;
    }
    const host = canvas.parentNode || document.body;
    let svg = document.getElementById('jk-gamma-svg-defs');
    if (!svg && host) {
      const ns = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('id', 'jk-gamma-svg-defs');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.style.cssText =
        'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
      const defs = document.createElementNS(ns, 'defs');
      const filter = document.createElementNS(ns, 'filter');
      filter.setAttribute('id', 'jk-gamma-filter');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      filter.setAttribute('x', '0%');
      filter.setAttribute('y', '0%');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      const transfer = document.createElementNS(ns, 'feComponentTransfer');
      ['R', 'G', 'B'].forEach((ch) => {
        const fn = document.createElementNS(ns, 'feFunc' + ch);
        fn.setAttribute('id', 'jk-gamma-func-' + ch.toLowerCase());
        fn.setAttribute('type', 'gamma');
        fn.setAttribute('amplitude', '1');
        fn.setAttribute('exponent', '1');
        fn.setAttribute('offset', '0');
        transfer.appendChild(fn);
      });
      filter.appendChild(transfer);
      defs.appendChild(filter);
      svg.appendChild(defs);
      host.appendChild(svg);
    } else if (svg && host && svg.parentNode !== host) {
      host.appendChild(svg);
    }
    const expStr = String(Math.round((1.0 / g) * 100000) / 100000);
    ['r', 'g', 'b'].forEach((ch) => {
      const fn = document.getElementById('jk-gamma-func-' + ch);
      if (fn) {
        fn.setAttribute('exponent', expStr);
      }
    });
    const wantFilter = 'url(#jk-gamma-filter)';
    if (canvas.style.filter !== wantFilter) {
      canvas.style.filter = wantFilter;
    }
  }

  function syncLightingUI() {
    const g = clampGammaPref(pipState.gamma);
    const ob = clampOverbrightPref(pipState.overbright);
    const boosted = Math.abs(g - 1.0) >= 0.01 || ob !== 0;

    const lightingBtn = document.getElementById('jk-pip-lighting-btn');
    const lightingPanel = document.getElementById('jk-pip-lighting-panel');
    if (lightingPanel) {
      lightingPanel.hidden = !pipState.lightingOpen;
    }
    if (lightingBtn) {
      lightingBtn.classList.toggle('active', Boolean(pipState.lightingOpen));
      lightingBtn.classList.toggle('jk-pip-light-boosted', boosted);
      lightingBtn.setAttribute('aria-expanded', pipState.lightingOpen ? 'true' : 'false');
      const summary = boosted
        ? `Lighting: Gamma ${g.toFixed(2)}, Overbright +${ob}`
        : 'Lighting: Stock';
      lightingBtn.title = summary;
      lightingBtn.setAttribute('aria-label', summary);
    }

    const gammaInput = document.getElementById('jk-pip-gamma');
    if (gammaInput && !pipState.scrubbingGamma && document.activeElement !== gammaInput) {
      const minNum = parseFloat(gammaInput.min || '1');
      const maxNum = parseFloat(gammaInput.max || '2.5');
      const sliderVal = Math.min(maxNum, Math.max(minNum, g));
      gammaInput.value = String(sliderVal);
      gammaInput.style.setProperty('--attr-min', String(minNum));
      gammaInput.style.setProperty('--attr-max', String(maxNum));
      gammaInput.style.setProperty('--control-value', String(sliderVal));
    }
    if (gammaInput) {
      gammaInput.setAttribute(
        'aria-valuetext',
        Math.abs(g - 1.0) < 0.01 ? '1.00 (Stock)' : g.toFixed(2)
      );
    }
    const gammaValEl = document.getElementById('jk-pip-gamma-val');
    if (gammaValEl) {
      gammaValEl.textContent = g.toFixed(2);
    }

    if (lightingPanel) {
      const obBtns = lightingPanel.querySelectorAll('[data-overbright]');
      obBtns.forEach((btn) => {
        const btnOb = parseInt(btn.getAttribute('data-overbright') || '0', 10);
        const isCur = btnOb === ob;
        btn.classList.toggle('active', isCur);
        btn.setAttribute('aria-pressed', isCur ? 'true' : 'false');
      });
      const presetBtns = lightingPanel.querySelectorAll('[data-light-preset]');
      presetBtns.forEach((btn) => {
        const key = btn.getAttribute('data-light-preset') || '';
        const preset = LIGHTING_PRESETS[key];
        const matches =
          Boolean(preset) &&
          Math.abs(preset.gamma - g) < 0.02 &&
          preset.overbright === ob;
        btn.classList.toggle('active', matches);
        btn.setAttribute('aria-pressed', matches ? 'true' : 'false');
      });
    }
  }

  function setLightingPanelOpen(open) {
    pipState.lightingOpen = Boolean(open);
    syncLightingUI();
    if (isCardFullscreen()) {
      showFullscreenControls(!pipState.lightingOpen);
    }
    return pipState.lightingOpen;
  }

  function updateControlState() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const player = getPlayer();
    if (!player) {
      syncCameraButtonUI(pipState.thirdPerson);
      syncLightingUI();
      return;
    }

    const status = typeof player.getStatus === 'function' ? player.getStatus() : {};
    const rawMod = window.Module || (typeof player.getModule === 'function' ? player.getModule() : null);
    const mod =
      rawMod && (!rawMod.Asyncify || (rawMod.Asyncify.state === 0 && !rawMod.Asyncify.currData))
        ? rawMod
        : null;

    const isPaused =
      mod && typeof mod._JK_DemoIsPaused === 'function'
        ? mod._JK_DemoIsPaused() === 1
        : Boolean(status.isPaused);
    const playPauseBtn = document.getElementById('jk-pip-play-pause');
    if (playPauseBtn) {
      playPauseBtn.textContent = pipState.loadFailed ? 'Play' : isPaused ? 'Play' : 'Pause';
    }
    if (isCardFullscreen()) {
      if (isPaused) {
        showFullscreenControls(false);
      } else if (pipState.lastKnownPaused && !isPaused) {
        showFullscreenControls(true);
      }
    }
    pipState.lastKnownPaused = isPaused;

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

    const thirdPersonEnabled =
      typeof player.getThirdPerson === 'function'
        ? player.getThirdPerson()
        : typeof status.thirdPerson === 'boolean'
        ? status.thirdPerson
        : pipState.thirdPerson;
    pipState.thirdPerson = Boolean(thirdPersonEnabled);
    syncCameraButtonUI(pipState.thirdPerson);

    const curGamma =
      typeof player.getGamma === 'function'
        ? player.getGamma()
        : typeof status.gamma === 'number'
        ? status.gamma
        : pipState.gamma;
    if (!pipState.scrubbingGamma && typeof curGamma === 'number' && Number.isFinite(curGamma)) {
      pipState.gamma = clampGammaPref(curGamma);
    }
    const curOb =
      status.engineStarted && mod && typeof mod._JK_DemoGetMapOverbright === 'function'
        ? mod._JK_DemoGetMapOverbright()
        : typeof player.getOverbright === 'function'
        ? player.getOverbright()
        : typeof status.overbright === 'number'
        ? status.overbright
        : pipState.overbright;
    if (typeof curOb === 'number' && Number.isFinite(curOb)) {
      pipState.overbright = clampOverbrightPref(curOb);
    }
    applyCanvasGammaFilterLocal(pipState.gamma);
    syncLightingUI();

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

    const musicEnabled =
      mod && typeof mod._JK_DemoIsMusicEnabled === 'function'
        ? mod._JK_DemoIsMusicEnabled() === 1
        : typeof player.isMusicEnabled === 'function'
        ? player.isMusicEnabled()
        : typeof status.musicEnabled === 'boolean'
        ? status.musicEnabled
        : pipState.musicEnabled;
    pipState.musicEnabled = Boolean(musicEnabled);
    syncMusicButtonUI(pipState.musicEnabled);

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
    const audioBlocked =
      !isMuted &&
      Boolean(status.audioContextState && status.audioContextState !== 'running');
    const muteBtn = document.getElementById('jk-pip-mute');
    if (muteBtn) {
      muteBtn.dataset.audioBlocked = audioBlocked ? '1' : '0';
      muteBtn.textContent = isMuted || audioBlocked ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('active', Boolean(isMuted || audioBlocked));
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

  let videoExportScriptPromise = null;
  function ensureVideoExportScriptLoaded() {
    if (window.JKVideoExport && window.JKVideoExport.__initialized) {
      return Promise.resolve(window.JKVideoExport);
    }
    if (videoExportScriptPromise) return videoExportScriptPromise;
    const PLAYER_ASSET_VERSION = '20261112a';
    videoExportScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src*="/jkplayer/jk-video-export.js"]');
      if (existing) {
        let waited = 0;
        const poll = setInterval(() => {
          if (window.JKVideoExport && window.JKVideoExport.__initialized) {
            clearInterval(poll);
            resolve(window.JKVideoExport);
            return;
          }
          waited += 50;
          if (waited >= 10000) {
            clearInterval(poll);
            videoExportScriptPromise = null;
            reject(new Error('Timed out loading jk-video-export.js'));
          }
        }, 50);
        return;
      }
      const s = document.createElement('script');
      s.src = `/jkplayer/jk-video-export.js?v=${PLAYER_ASSET_VERSION}`;
      s.async = true;
      s.onload = () => resolve(window.JKVideoExport || null);
      s.onerror = (err) => {
        if (s.parentNode) s.parentNode.removeChild(s);
        videoExportScriptPromise = null;
        reject(err || new Error('Failed to load jk-video-export.js'));
      };
      document.head.appendChild(s);
    });
    return videoExportScriptPromise;
  }

  function ensurePlayerScriptLoaded() {
    if (window.JKDemoPlayer || window.OpenJKPlayer) {
      pipState.playerScriptLoaded = true;
      ensureVideoExportScriptLoaded().catch(() => {});
      return Promise.resolve(getPlayer());
    }
    if (pipState.playerScriptPromise) {
      return pipState.playerScriptPromise;
    }

    // Separate engine vs wrapper versions so UI/JS updates do not invalidate cached openjk.wasm
    const ENGINE_ASSET_VERSION = '20261112a';
    const PLAYER_ASSET_VERSION = '20261112a';
    ensureVideoExportScriptLoaded().catch(() => {});
    window.JKDemoConfig = Object.assign(
      {
        preload: true,
        preloadOnly: true,
        autoPlay: false,
        muted: true,
        gamma: pipState.gamma,
        overbright: pipState.overbright,
        preserveDocumentTitle: true,
        scriptUrl: `/jkplayer/openjk.js?v=${ENGINE_ASSET_VERSION}`,
        wasmUrl: `/jkplayer/openjk.wasm?v=${ENGINE_ASSET_VERSION}`,
        autoexecUrl: `/jkplayer/autoexec.cfg?v=${PLAYER_ASSET_VERSION}`,
      },
      window.JKDemoConfig || {}
    );

    const loadScriptOnce = () =>
      new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="/jkplayer/player.js"]');
        if (existing) {
          let waitedMs = 0;
          const check = setInterval(() => {
            if (getPlayer()) {
              clearInterval(check);
              pipState.playerScriptLoaded = true;
              resolve(getPlayer());
              return;
            }
            waitedMs += 50;
            if (waitedMs >= 20000) {
              clearInterval(check);
              if (existing.parentNode) existing.parentNode.removeChild(existing);
              reject(new Error('Timed out waiting for existing player.js'));
            }
          }, 50);
          return;
        }
        const script = document.createElement('script');
        script.src = `/jkplayer/player.js?v=${PLAYER_ASSET_VERSION}`;
        script.async = true;
        script.onload = () => {
          const p = getPlayer();
          if (p) {
            pipState.playerScriptLoaded = true;
            resolve(p);
          } else {
            if (script.parentNode) script.parentNode.removeChild(script);
            reject(new Error('player.js loaded incompletely'));
          }
        };
        script.onerror = (err) => {
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(err || new Error('Failed to load player.js'));
        };
        document.head.appendChild(script);
      });

    pipState.playerScriptPromise = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
        }
        try {
          const p = await loadScriptOnce();
          if (p) return p;
        } catch (err) {
          lastErr = err;
        }
      }
      pipState.playerScriptPromise = null;
      throw lastErr || new Error('Failed to load player.js');
    })();
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
      pipState.prewarmStarted = false;
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

  function cleanElementText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll('.jk-play-btn').forEach((btn) => btn.remove());
    }
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractDemoBasename(urlStr) {
    try {
      const u = new URL(String(urlStr || ''), window.location.origin);
      let demoParam = u.searchParams.get('demo');
      if (demoParam) {
        if (/%[0-9A-Fa-f]{2}/.test(demoParam)) {
          try {
            demoParam = decodeURIComponent(demoParam);
          } catch (_) {}
        }
        const parts = demoParam.split(/[/\\]/).filter(Boolean);
        const base = parts[parts.length - 1] || demoParam;
        return base.replace(/\.(?:dm_26|dm_25|mme)$/i, '').trim() || base;
      }
    } catch (_) {}
    return '';
  }

  function deriveDemoTitle(anchorOrUrl) {
    if (anchorOrUrl && typeof anchorOrUrl === 'object' && anchorOrUrl.nodeType === 1) {
      const href = anchorOrUrl.getAttribute('href') || '';
      const text = cleanElementText(anchorOrUrl);
      const isGenericLinkText =
        !text || text === 'Link' || text === 'Demo' || text === 'Match Demo';
      const cell = anchorOrUrl.closest('td');
      const row = anchorOrUrl.closest('tr');

      if (row && cell) {
        const table = row.closest('table');
        const tableRows = table ? table.rows : null;
        const hdr0 = tableRows && tableRows.length > 0 ? tableRows[0] : null;
        const hdr1 = tableRows && tableRows.length > 1 ? tableRows[1] : null;
        const hdr0First = hdr0 && hdr0.children[0] ? cleanElementText(hdr0.children[0]) : '';
        const rowCells = Array.from(row.children);
        const cellIdx = rowCells.indexOf(cell);
        const isMatchSummaryRow = Boolean(
          rowCells[0] && rowCells[0].hasAttribute('rowspan')
        );

        // 1. match.html (#recentdemos built by matchrpc.js): Link | Server | Date | Map | Duration | Red | Blue | Free | Spec
        if (hdr0First === 'Link') {
          if (isMatchSummaryRow) {
            const server = cleanElementText(rowCells[1]);
            const dateStr = cleanElementText(rowCells[2]);
            const mapName = cleanElementText(rowCells[3]);
            const redScore = cleanElementText(rowCells[5]);
            const blueScore = cleanElementText(rowCells[6]);
            const scoreBadge =
              redScore !== '' && blueScore !== '' ? `(${redScore}-${blueScore})` : '';
            const mapWithScore = [mapName, scoreBadge].filter(Boolean).join(' ');
            const meta = [mapWithScore, server, dateStr].filter(Boolean).join(' \u00B7 ');
            const prefix =
              href.includes('rpc=matchdemo') || text === 'Demo'
                ? 'Match Demo'
                : !isGenericLinkText
                  ? text
                  : 'Match Demo';
            return meta ? `${prefix} \u2014 ${meta}` : prefix;
          }

          // Player POV / Nice Shot / Bookmark / Merged POV cell inside multi-team row
          let nameIdx = cellIdx + 2;
          if (hdr1 && hdr1.children.length === rowCells.length) {
            for (
              let k = cellIdx + 1;
              k < Math.min(rowCells.length, cellIdx + 6);
              k++
            ) {
              const colHdr = cleanElementText(hdr1.children[k]);
              if (colHdr === 'Demo') break;
              if (colHdr === 'Name') {
                nameIdx = k;
                break;
              }
            }
          }
          let playerName = '';
          const nameCell = rowCells[nameIdx];
          if (nameCell) {
            const nameAnchor = nameCell.querySelector('a[href*="player"]');
            playerName = nameAnchor
              ? cleanElementText(nameAnchor)
              : cleanElementText(nameCell).replace(/\s*\(\d+\s*-\s*\d+\)\s*$/, '').trim();
            if (playerName === 'Disconnected Players:') {
              playerName = '';
            }
          }

          let lead = '';
          if (!isGenericLinkText) {
            lead = playerName ? `${playerName} \u00B7 ${text}` : text;
          } else if (href.includes('mergedemo.php')) {
            lead = `${playerName || 'Player'} (Merged POV)`;
          } else {
            lead = playerName || extractDemoBasename(href) || deriveDemoTitle(href);
          }

          let matchRow = row.previousElementSibling;
          while (
            matchRow &&
            !(matchRow.children[0] && matchRow.children[0].hasAttribute('rowspan'))
          ) {
            matchRow = matchRow.previousElementSibling;
          }
          if (matchRow) {
            const server = cleanElementText(matchRow.children[1]);
            const dateStr = cleanElementText(matchRow.children[2]);
            const mapName = cleanElementText(matchRow.children[3]);
            const meta = [mapName, server].filter(Boolean).join(' \u00B7 ') || dateStr;
            if (meta) {
              return `${lead} \u2014 ${meta}`;
            }
          }
          return lead;
        }

        // 2. index.html (#recentdemos built by rpc.js): Server | Player | Date | Duration | Download | Map
        if (hdr0First === 'Server' && isMatchSummaryRow) {
          const server = cleanElementText(rowCells[0]);
          const playerName = cleanElementText(rowCells[1]);
          const dateStr = cleanElementText(rowCells[2]);
          const mapName = rowCells[5] ? cleanElementText(rowCells[5]) : '';
          const lead =
            (!isGenericLinkText && text) ||
            playerName ||
            extractDemoBasename(href) ||
            'Demo';
          const meta = [mapName, server].filter(Boolean).join(' \u00B7 ') || dateStr;
          return meta && meta !== lead ? `${lead} \u2014 ${meta}` : lead;
        }

        // 3. Generic fallback for any other table layout
        const nonEmpty = rowCells
          .filter((td) => td !== cell)
          .map((td) => cleanElementText(td))
          .filter(
            (c) => c && c !== 'Link' && c !== 'Demo' && c !== 'LinkDemo' && c !== 'Match Demo'
          );
        if (nonEmpty.length >= 2) {
          return (!isGenericLinkText ? text + ' \u2014 ' : '') + nonEmpty.slice(0, 2).join(' \u00B7 ');
        }
      }

      // 4. AngularJS player pages (aplayer2.html, debugplayer2.html, aplayer.html, debugplayer.html)
      const li = anchorOrUrl.closest('li');
      if (li) {
        const gameLi =
          !isGenericLinkText && li.parentElement && li.parentElement.closest('li')
            ? li.parentElement.closest('li')
            : li;
        let playerName = '';
        const nameSpans = gameLi.querySelectorAll(
          ':scope > span[ng-repeat*="game.names"] span[ng-bind-html], :scope > span[ng-bind-html*="name"]'
        );
        if (nameSpans.length > 0) {
          playerName = cleanElementText(nameSpans[0]);
        }
        if (!playerName) {
          const pagePlayerHdr = document.querySelector('h2 span[ng-bind-html*="player"]');
          playerName = cleanElementText(pagePlayerHdr);
        }
        const base = extractDemoBasename(href);
        if (!isGenericLinkText) {
          return playerName ? `${playerName} \u00B7 ${text}` : text;
        }
        if (playerName && base) {
          return `${playerName} \u2014 ${base}`;
        }
        if (playerName) return playerName;
      }

      if (!isGenericLinkText) return text;
      return deriveDemoTitle(href);
    }

    const urlStr = String(anchorOrUrl || '');
    try {
      const u = new URL(urlStr, window.location.origin);
      const base = extractDemoBasename(urlStr);
      if (u.pathname.includes('trimdemo.php')) {
        const timeMs = parseInt(u.searchParams.get('time') || '', 10);
        if (Number.isFinite(timeMs) && timeMs >= 0) {
          const mins = Math.floor(timeMs / 60000);
          const secs = String(Math.floor((timeMs % 60000) / 1000)).padStart(2, '0');
          return base ? `${base} @ ${mins}:${secs}` : `Clip @ ${mins}:${secs}`;
        }
      }
      if (base) return base;
      if (u.searchParams.get('rpc') === 'matchdemo') {
        return 'Match Demo #' + (u.searchParams.get('id') || '');
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
        if (e && e.isTrusted) {
          primeSharedAudioOnUserGesture();
        }
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
      window.JKDemoConfig = Object.assign(window.JKDemoConfig || {}, { muted: false });
      primeSharedAudioOnUserGesture();
      const existingPlayer = getPlayer();
      if (existingPlayer) {
        if (typeof existingPlayer.unlockAudio === 'function') {
          existingPlayer.unlockAudio();
        }
        if (typeof existingPlayer.setMuted === 'function') {
          existingPlayer.setMuted(false);
        }
      }
    }

    const card = createPiPDOM();
    if (isExportTrimActive() && window.JKVideoExport) {
      window.JKVideoExport.exitTrimMode(false);
    }
    const wasAlreadyOpen = Boolean(pipState.open && !card.hidden);
    pipState.open = true;
    pipState.loadFailed = false;
    pipState.currentDemoUrl = demoUrl;
    pipState.currentDemoTitle = resolvedTitle || deriveDemoTitle(demoUrl);

    card.hidden = false;
    card.classList.add('jk-pip-open');
    if (!isCardFullscreen()) {
      ensureVisibleInViewport(wasAlreadyOpen);
    }
    applyCardGeometry();

    const titleEl = document.getElementById('jk-pip-title');
    if (titleEl) {
      titleEl.textContent = pipState.currentDemoTitle;
      titleEl.title = pipState.currentDemoTitle;
    }

    const overlay = document.getElementById('jk-pip-status-overlay');
    if (overlay) {
      overlay.style.display = 'block';
      const existingPlayer = getPlayer();
      const st =
        existingPlayer && typeof existingPlayer.getStatus === 'function'
          ? existingPlayer.getStatus()
          : null;
      if (!existingPlayer || !st || !st.engineStarted) {
        renderOverlayProgress('Loading 3D engine...', 5, 'engine');
      } else {
        renderOverlayProgress('Downloading demo...', 4, 'demo');
      }
    }

    try {
      const player = getPlayer() || (await ensurePlayerScriptLoaded());
      if (!player || typeof player.loadDemo !== 'function') {
        throw new Error('Network error loading player');
      }
      if (!pipState.uiSyncInterval) {
        pipState.uiSyncInterval = setInterval(updateControlState, 200);
      }
      if (unmuteOnUserGesture && typeof player.setMuted === 'function') {
        player.setMuted(false);
      }
      if (typeof player.resize === 'function') {
        player.resize();
      }
      const ok = await player.loadDemo({
        url: demoUrl,
        title: pipState.currentDemoTitle,
        label: pipState.currentDemoTitle,
      });
      if (unmuteOnUserGesture && typeof player.setMuted === 'function') {
        player.setMuted(false);
      }
      if (typeof player.setLoop === 'function') {
        player.setLoop(true);
      }
      if (typeof player.resume === 'function') {
        player.resume();
      }
      if (titleEl && (!titleEl.textContent || !titleEl.textContent.trim())) {
        const st = typeof player.getStatus === 'function' ? player.getStatus() : {};
        titleEl.textContent = st.demoName || pipState.currentDemoTitle || 'JKA Demo';
      }
      if (overlay) {
        if (ok) {
          pipState.loadFailed = false;
          overlay.style.display = 'none';
        } else {
          pipState.loadFailed = true;
          const prog =
            typeof player.getLoadProgress === 'function' ? player.getLoadProgress() : null;
          const rawErr =
            prog && prog.stage === 'error' && prog.message ? prog.message.trim() : '';
          const errLabel = rawErr
            ? /retry/i.test(rawErr)
              ? rawErr
              : `${rawErr} — tap Play to retry`
            : 'Load failed — tap Play to retry';
          renderOverlayProgress(errLabel, 0, 'error');
        }
      }
      updateControlState();
      return Boolean(ok);
    } catch (err) {
      pipState.loadFailed = true;
      console.error('[JKPiPPlayer] Failed to load demo:', err);
      if (overlay) {
        renderOverlayProgress('Network error loading player — tap Play to retry', 0, 'error');
      }
      updateControlState();
      return false;
    }
  }

  function closePiP() {
    const card = document.getElementById('jk-pip-card');
    if (isExportTrimActive() && window.JKVideoExport) {
      window.JKVideoExport.exitTrimMode(false);
    }
    pipState.open = false;
    pipState.lightingOpen = false;
    syncLightingUI();
    clearFullscreenControlsTimer();
    unlockOrientationIfSupported();
    if (card) {
      card.classList.remove(
        'jk-pip-pseudo-fullscreen',
        'jk-pip-fs-controls-hidden',
        'jk-pip-force-landscape'
      );
      if (getFullscreenElement() === card) {
        try {
          if (typeof document.exitFullscreen === 'function') {
            const p = document.exitFullscreen();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } else if (typeof document.webkitExitFullscreen === 'function') {
            document.webkitExitFullscreen();
          }
        } catch (_) {}
      }
      card.classList.remove('jk-pip-open');
      card.hidden = true;
    }
    syncFullscreenUI();
    const player = getPlayer();
    if (player) {
      if (typeof player.pause === 'function') player.pause();
      if (typeof player.setMuted === 'function') player.setMuted(true);
    }
  }

  function setSizePreset(presetName) {
    if (!SIZE_PRESETS[presetName]) return;
    const card = document.getElementById('jk-pip-card');
    if (card && card.classList.contains('jk-pip-pseudo-fullscreen')) {
      card.classList.remove(
        'jk-pip-pseudo-fullscreen',
        'jk-pip-fs-controls-hidden',
        'jk-pip-force-landscape'
      );
      clearFullscreenControlsTimer();
      unlockOrientationIfSupported();
    }
    const vp = getViewportRect();
    const oldUnit = pipState.mobileDocUnit || getVisualUnit(vp);
    const oldW = pipState.width;
    const oldH = pipState.height;
    pipState.preset = presetName;
    const pDims = getPresetSize(presetName, vp);
    pipState.width = pDims.width;
    pipState.height = pDims.height;
    if (isMobileDocMode()) {
      const nextUnit = getVisualUnit(vp);
      pipState.mobileDocUnit = nextUnit;
      const newCssW = pDims.width * nextUnit;
      const newCssH = pDims.height * nextUnit;
      if (typeof pipState.x === 'number' && typeof pipState.y === 'number') {
        const cx = pipState.x + (oldW * oldUnit) / 2;
        const cy = pipState.y + (oldH * oldUnit) / 2;
        const minVisX = vp.pageLeft + 4 * nextUnit;
        const maxVisX = Math.max(minVisX, vp.pageLeft + vp.width - newCssW - 4 * nextUnit);
        const minVisY = vp.pageTop + 4 * nextUnit;
        const maxVisY = Math.max(minVisY, vp.pageTop + vp.height - newCssH - 4 * nextUnit);
        pipState.x = Math.round(Math.max(minVisX, Math.min(maxVisX, cx - newCssW / 2)) * 100) / 100;
        pipState.y = Math.round(Math.max(minVisY, Math.min(maxVisY, cy - newCssH / 2)) * 100) / 100;
      } else {
        pipState.x = Math.round((vp.pageLeft + Math.max(0, (vp.width - newCssW) / 2)) * 100) / 100;
        pipState.y = Math.round((vp.pageTop + Math.max(0, (vp.height - newCssH) / 2)) * 100) / 100;
      }
    }
    applyCardGeometry();
    saveLayout();
  }

  function togglePause() {
    if (pipState.loadFailed && pipState.currentDemoUrl) {
      openAndPlay(pipState.currentDemoUrl, {
        label: pipState.currentDemoTitle,
        unmuteOnUserGesture: true,
      });
      return true;
    }
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
    if (pipState.loadFailed && pipState.currentDemoUrl) {
      openAndPlay(pipState.currentDemoUrl, {
        label: pipState.currentDemoTitle,
        unmuteOnUserGesture: true,
      });
      return 0;
    }
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

  function setThirdPerson(enabled) {
    const next = Boolean(enabled);
    pipState.thirdPerson = next;
    writePersistedThirdPersonPref(next);
    syncCameraButtonUI(next);
    const player = getPlayer();
    if (player && typeof player.setThirdPerson === 'function') {
      player.setThirdPerson(next);
    } else if (pipState.playerScriptPromise) {
      pipState.playerScriptPromise
        .then((p) => {
          if (p && typeof p.setThirdPerson === 'function') {
            p.setThirdPerson(pipState.thirdPerson);
          }
        })
        .catch(() => {});
    }
    updateControlState();
    return next;
  }

  function getThirdPerson() {
    const player = getPlayer();
    if (player && typeof player.getThirdPerson === 'function') {
      return Boolean(player.getThirdPerson());
    }
    return Boolean(pipState.thirdPerson);
  }

  function toggleThirdPerson() {
    return setThirdPerson(!getThirdPerson());
  }

  function setGamma(val) {
    const next = clampGammaPref(val);
    pipState.gamma = next;
    writePersistedLightingPrefs({ gamma: next });
    applyCanvasGammaFilterLocal(next);
    syncLightingUI();
    const player = getPlayer();
    if (player && typeof player.setGamma === 'function') {
      player.setGamma(next);
    } else if (pipState.playerScriptPromise) {
      pipState.playerScriptPromise
        .then((p) => {
          if (p && typeof p.setGamma === 'function') {
            p.setGamma(pipState.gamma);
          }
        })
        .catch(() => {});
    }
    return next;
  }

  function getGamma() {
    const player = getPlayer();
    if (player && typeof player.getGamma === 'function') {
      return clampGammaPref(player.getGamma());
    }
    return clampGammaPref(pipState.gamma);
  }

  function setOverbright(bits) {
    const next = clampOverbrightPref(bits);
    pipState.overbright = next;
    writePersistedLightingPrefs({ overbright: next });
    syncLightingUI();
    const player = getPlayer();
    if (player && typeof player.setOverbright === 'function') {
      player.setOverbright(next);
    } else if (pipState.playerScriptPromise) {
      pipState.playerScriptPromise
        .then((p) => {
          if (p && typeof p.setOverbright === 'function') {
            p.setOverbright(pipState.overbright);
          }
        })
        .catch(() => {});
    }
    return next;
  }

  function getOverbright() {
    const player = getPlayer();
    if (player && typeof player.getOverbright === 'function') {
      return clampOverbrightPref(player.getOverbright());
    }
    return clampOverbrightPref(pipState.overbright);
  }

  function setLighting(opts) {
    if (!opts || typeof opts !== 'object') {
      return getLighting();
    }
    const patch = {};
    if (typeof opts.gamma === 'number' && Number.isFinite(opts.gamma)) {
      pipState.gamma = clampGammaPref(opts.gamma);
      patch.gamma = pipState.gamma;
      applyCanvasGammaFilterLocal(pipState.gamma);
    }
    const rawOb =
      typeof opts.overbright === 'number'
        ? opts.overbright
        : typeof opts.mapOverBrightBits === 'number'
        ? opts.mapOverBrightBits
        : undefined;
    if (typeof rawOb === 'number' && Number.isFinite(rawOb)) {
      pipState.overbright = clampOverbrightPref(rawOb);
      patch.overbright = pipState.overbright;
    }
    if (Object.keys(patch).length > 0) {
      writePersistedLightingPrefs(patch);
    }
    syncLightingUI();
    const player = getPlayer();
    if (player && typeof player.setLighting === 'function') {
      player.setLighting(patch);
    } else if (pipState.playerScriptPromise) {
      pipState.playerScriptPromise
        .then((p) => {
          if (p && typeof p.setLighting === 'function') {
            p.setLighting({ gamma: pipState.gamma, overbright: pipState.overbright });
          }
        })
        .catch(() => {});
    }
    return getLighting();
  }

  function getLighting() {
    return {
      gamma: getGamma(),
      overbright: getOverbright(),
    };
  }

  function applyLightingPreset(presetKey) {
    const preset = LIGHTING_PRESETS[String(presetKey || '').toLowerCase()];
    if (!preset) return getLighting();
    return setLighting({ gamma: preset.gamma, overbright: preset.overbright });
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
    const player = getPlayer();
    if (player && !isMuted()) {
      const st = typeof player.getStatus === 'function' ? player.getStatus() : null;
      if (st && st.audioContextState && st.audioContextState !== 'running') {
        primeSharedAudioOnUserGesture();
        if (typeof player.unlockAudio === 'function') player.unlockAudio();
        return setMuted(false);
      }
    }
    return setMuted(!isMuted());
  }

  function setMusicEnabled(enabled) {
    const next = Boolean(enabled);
    pipState.musicEnabled = next;
    writePersistedMusicPref(next);
    const player = getPlayer();
    if (player && typeof player.setMusicEnabled === 'function') {
      player.setMusicEnabled(next);
    }
    syncMusicButtonUI(next);
    return next;
  }

  function isMusicEnabled() {
    const player = getPlayer();
    if (player && typeof player.isMusicEnabled === 'function') {
      return player.isMusicEnabled();
    }
    return Boolean(pipState.musicEnabled);
  }

  function toggleMusic() {
    return setMusicEnabled(!isMusicEnabled());
  }

  function toggleFullscreen() {
    const card = document.getElementById('jk-pip-card');
    if (!card) return;
    const enterPseudoFs = () => {
      card.classList.add('jk-pip-pseudo-fullscreen');
      lockLandscapeIfMobile();
      applyCardGeometry();
      showFullscreenControls(true);
    };
    const exitPseudoFs = () => {
      card.classList.remove(
        'jk-pip-pseudo-fullscreen',
        'jk-pip-fs-controls-hidden',
        'jk-pip-force-landscape'
      );
      clearFullscreenControlsTimer();
      unlockOrientationIfSupported();
      ensureVisibleInViewport(true);
      applyCardGeometry();
    };
    try {
      if (isCardFullscreen()) {
        if (card.classList.contains('jk-pip-pseudo-fullscreen')) {
          exitPseudoFs();
        } else if (typeof document.exitFullscreen === 'function') {
          const p = document.exitFullscreen();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } else if (typeof document.webkitExitFullscreen === 'function') {
          document.webkitExitFullscreen();
        }
      } else {
        const req = card.requestFullscreen || card.webkitRequestFullscreen;
        if (typeof req === 'function') {
          const p = req.call(card);
          if (p && typeof p.then === 'function') {
            p.then(() => {
              lockLandscapeIfMobile();
              showFullscreenControls(true);
            }).catch(() => {
              enterPseudoFs();
            });
          } else {
            lockLandscapeIfMobile();
            showFullscreenControls(true);
          }
        } else {
          enterPseudoFs();
        }
      }
    } catch (_) {
      if (card.classList.contains('jk-pip-pseudo-fullscreen')) {
        exitPseudoFs();
      } else {
        enterPseudoFs();
      }
    }
  }

  function ensureManifestV2Cached() {
    try {
      const existing = localStorage.getItem('openjk_pk3_manifest_v2');
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          if (!parsed || Number(parsed.version) < 3) {
            localStorage.removeItem('openjk_pk3_manifest_v2');
          }
        } catch (_) {
          localStorage.removeItem('openjk_pk3_manifest_v2');
        }
      }
      fetch('/base/manifest.json?v=3', { cache: 'no-cache' })
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
    setThirdPerson,
    getThirdPerson,
    isThirdPerson: getThirdPerson,
    toggleThirdPerson,
    setGamma,
    getGamma,
    setOverbright,
    getOverbright,
    setLighting,
    getLighting,
    applyLightingPreset,
    setSpeed,
    getSpeed,
    setVolume,
    getVolume,
    setMuted,
    isMuted,
    toggleMute,
    setMusicEnabled,
    getMusicEnabled: isMusicEnabled,
    isMusicEnabled,
    toggleMusic,
    setSizePreset,
    toggleFullscreen,
    refreshLayout: () => applyCardGeometry(),
    isOpen: () => pipState.open,
    getState: () => Object.assign({}, pipState, { ready: Boolean(getPlayer() && getPlayer().getStatus && getPlayer().getStatus().ready) }),
  };
})();
