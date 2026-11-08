(function () {
  'use strict';

  if (window.JKVideoExport && window.JKVideoExport.__initialized) {
    return;
  }

  const ASSET_VERSION = '20261107m';
  const MIN_CLIP_MS = 500;
  const DEFAULT_PRE_MS = 10000;
  const DEFAULT_POST_MS = 5000;
  const FINE_STEP_MS = 100;
  const AUTO_DISMISS_MS = 6000;

  const RESOLUTIONS = {
    '16:9': {
      '480p': { width: 854, height: 480 },
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 },
      '1440p': { width: 2560, height: 1440 },
    },
    '9:16': {
      '480p': { width: 480, height: 854 },
      '720p': { width: 720, height: 1280 },
      '1080p': { width: 1080, height: 1920 },
      '1440p': { width: 1440, height: 2560 },
    },
    '4:3': {
      '480p': { width: 640, height: 480 },
      '720p': { width: 960, height: 720 },
      '1080p': { width: 1440, height: 1080 },
      '1440p': { width: 1920, height: 1440 },
    },
  };

  const LIGHTING_PRESETS = {
    stock: { gamma: 1.0, overbright: 0, label: 'Stock' },
    overbright: { gamma: 1.0, overbright: 2, label: 'Overbright' },
    gamma2: { gamma: 2.0, overbright: 0, label: 'Gamma 2' },
    bright: { gamma: 1.4, overbright: 1, label: 'Bright+' },
  };

  const ICON_CLIP_SM =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="3" width="9.4" height="10" rx="1.6"/><path d="M11.2 6.4L14.5 4.5v7l-3.3-1.9"/></svg>';

  const trimState = {
    active: false,
    hostMode: 'pip', // 'pip' | 'standalone'
    durationMs: 0,
    startMs: 0,
    endMs: 5000,
    previewing: false,
    previewRaf: 0,
    wasPaused: true,
    activeHandle: 'end',
    lastSeekSentAt: 0,
    pendingSeekTimer: 0,
  };

  const dialogOptions = {
    aspect: '16:9',
    resTier: '1080p',
    fps: 60,
    quality: 'discord10',
    hud: 'full',
    audio: 'on',
    blur: 0,
    camera: '3rd',
    speed: 1,
    lighting: 'current',
    capturedGamma: 1.0,
    capturedOverbright: 0,
  };

  const exportQueue = {
    worker: null,
    workerUrl: '',
    activeJob: null,
    pendingJobs: [],
    completedCount: 0,
    lastCompletedJob: null,
    lastError: null,
    autoDismissTimer: 0,
    idleWorkerTimer: 0,
    swReadyPromise: null,
    swStreamPrefix: '',
    nextJobSeq: 1,
  };

  function getPlayer() {
    return window.JKDemoPlayer || window.OpenJKPlayer || null;
  }

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
  }

  function getTopLayerHost() {
    return getFullscreenElement() || document.body;
  }

  function reparentTopLayerElement(el, targetParent) {
    if (!el || !targetParent || el.parentNode === targetParent) return;
    if ('moveBefore' in Element.prototype) {
      try {
        targetParent.moveBefore(el, null);
        return;
      } catch (_) {}
    }
    const isDialog = el.tagName === 'DIALOG';
    const wasDialogOpen = isDialog && el.hasAttribute('open');
    let wasPopoverOpen = false;
    if (!isDialog) {
      try {
        wasPopoverOpen =
          el.matches(':popover-open') || el.classList.contains(':popover-open');
      } catch (_) {
        wasPopoverOpen = el.classList.contains(':popover-open');
      }
    }
    targetParent.insertBefore(el, null);
    if (wasDialogOpen && typeof el.showModal === 'function') {
      try {
        el.showModal();
      } catch (_) {}
    } else if (wasPopoverOpen) {
      showPopoverCompat(el);
    }
  }

  function supportsNativePopover() {
    return typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
  }

  function showPopoverCompat(el) {
    if (!el) return;
    reparentTopLayerElement(el, getTopLayerHost());
    if (supportsNativePopover() && typeof el.showPopover === 'function') {
      try {
        if (!el.matches(':popover-open')) {
          el.showPopover();
        }
        return;
      } catch (_) {}
    }
    el.classList.add(':popover-open');
    el.hidden = false;
  }

  function hidePopoverCompat(el) {
    if (!el) return;
    if (supportsNativePopover() && typeof el.hidePopover === 'function') {
      try {
        if (el.matches(':popover-open')) {
          el.hidePopover();
        }
      } catch (_) {}
    }
    el.classList.remove(':popover-open');
  }

  function formatTimePrecise(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const tenthsTotal = Math.round(ms / 100);
    const tenths = tenthsTotal % 10;
    const totalSecs = Math.floor(tenthsTotal / 10);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins + ':' + (secs < 10 ? '0' + secs : String(secs)) + '.' + tenths;
  }

  function formatDurationShort(ms) {
    const sec = Math.max(0, ms) / 1000;
    if (sec < 60) {
      return sec.toFixed(1) + 's';
    }
    const mins = Math.floor(sec / 60);
    const rem = (sec - mins * 60).toFixed(1);
    return mins + 'm ' + (rem < 10 ? '0' + rem : rem) + 's';
  }

  function formatBytesMB(bytes) {
    const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
    return mb.toFixed(mb >= 10 ? 1 : 2) + ' MB';
  }

  function resolveAssetBaseDir() {
    const cfg = window.JKDemoConfig || {};
    if (typeof cfg.scriptUrl === 'string' && cfg.scriptUrl.includes('/jkplayer/')) {
      return '/jkplayer';
    }
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      const src = s.getAttribute('src') || '';
      if (src.includes('/jkplayer/')) {
        return '/jkplayer';
      }
    }
    return '';
  }

  function sanitizeClipFilename(title, startMs, endMs, aspect, resTier) {
    const cleanTitle = String(title || 'jka-demo')
      .replace(/\.(dm_26|mme)$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    const sSec = Math.floor(startMs / 1000);
    const eSec = Math.ceil(endMs / 1000);
    const tag = aspect === '9:16' ? 'portrait-' + resTier : resTier;
    return `${cleanTitle || 'jka-clip'}_${sSec}s-${eSec}s_${tag}.mp4`;
  }

  function syncRangeCssVars(slider) {
    if (!slider) return;
    slider.style.setProperty('--attr-min', slider.min || '0');
    slider.style.setProperty('--attr-max', slider.max || '1000');
    slider.style.setProperty('--control-value', slider.value || '0');
  }

  function injectStyles() {
    if (document.getElementById('jk-video-export-styles')) return;
    const style = document.createElement('style');
    style.id = 'jk-video-export-styles';
    style.textContent = `
      /* Inline Scrubber Trim Bar */
      #jk-trim-bar {
        color-scheme: only dark;
        background: rgba(13, 17, 23, 0.92);
        color: #e6edf3;
        accent-color: #58a6ff;
        border: 1px solid #1f6feb;
        border-radius: calc(6px * var(--jk-ui-scale, 1));
        padding: calc(6px * var(--jk-ui-scale, 1)) calc(8px * var(--jk-ui-scale, 1));
        display: flex;
        flex-direction: column;
        gap: calc(5px * var(--jk-ui-scale, 1));
        inline-size: 100%;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        z-index: 16;
      }
      #jk-trim-bar[hidden] {
        display: none !important;
      }
      #jk-controls-bar #jk-trim-bar {
        flex: 1 1 360px;
        min-inline-size: 260px;
      }
      .jk-trim-track-wrap {
        position: relative;
        inline-size: 100%;
        block-size: calc(24px * var(--jk-ui-scale, 1));
        display: flex;
        align-items: center;
      }
      .jk-trim-rail {
        position: absolute;
        inset-inline: 0;
        block-size: calc(6px * var(--jk-ui-scale, 1));
        background: #21262d;
        border: 1px solid #30363d;
        border-radius: 999px;
        overflow: hidden;
        pointer-events: none;
      }
      .jk-trim-range-fill {
        position: absolute;
        inset-block: 0;
        inset-inline-start: var(--trim-start-pct, 0%);
        inline-size: calc(var(--trim-end-pct, 100%) - var(--trim-start-pct, 0%));
        background: linear-gradient(90deg, rgba(47, 129, 247, 0.55), rgba(88, 166, 255, 0.75));
        border-inline: 1px solid #79c0ff;
        box-sizing: border-box;
      }
      .jk-trim-playhead {
        position: absolute;
        top: calc(3px * var(--jk-ui-scale, 1));
        bottom: calc(3px * var(--jk-ui-scale, 1));
        inset-inline-start: var(--trim-cur-pct, 0%);
        inline-size: 2px;
        background: #f0f6fc;
        box-shadow: 0 0 4px rgba(240, 246, 252, 0.9);
        transform: translateX(-1px);
        pointer-events: none;
        z-index: 3;
      }
      input[type="range"].jk-trim-range {
        --slider-track-size: calc(6px * var(--jk-ui-scale, 1));
        --slider-thumb-size: calc(16px * var(--jk-ui-scale, 1));
        --slider-track-radius: 999px;
        --slider-thumb-radius: 4px;
        --slider-track-color: transparent;
        --slider-fill-color: #58a6ff;
        --slider-thumb-color: #58a6ff;
        --attr-min: attr(min type(<number>), 0);
        --attr-max: attr(max type(<number>), 1000);
        --control-value: attr(value type(<number>), 0);
        --slider-progress: calc(
          progress(var(--control-value), var(--attr-min), var(--attr-max)) * 100%
        );
        position: absolute;
        inset: 0;
        inline-size: 100%;
        block-size: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        appearance: none;
        -webkit-appearance: none;
        pointer-events: none;
        z-index: 4;
      }
      @supports not (opacity: progress(1, 0, 100)) {
        input[type="range"].jk-trim-range {
          --slider-progress: calc(
            (var(--control-value) - var(--attr-min)) /
            (var(--attr-max) - var(--attr-min)) * 100%
          );
        }
      }
      input[type="range"].jk-trim-range.jk-trim-top {
        z-index: 6;
      }
      input[type="range"].jk-trim-range#jk-trim-end {
        --slider-thumb-color: #3fb950;
        --slider-fill-color: #3fb950;
      }
      input[type="range"].jk-trim-range::-webkit-slider-runnable-track {
        block-size: var(--slider-track-size);
        border: 0;
        background: transparent;
      }
      input[type="range"].jk-trim-range::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        pointer-events: auto;
        cursor: ew-resize;
        inline-size: calc(12px * var(--jk-ui-scale, 1));
        block-size: calc(18px * var(--jk-ui-scale, 1));
        margin-block-start: calc((var(--slider-track-size) - 18px * var(--jk-ui-scale, 1)) / 2);
        border: 1.5px solid #f0f6fc;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
      }
      input[type="range"].jk-trim-range::-moz-range-track {
        block-size: var(--slider-track-size);
        border: 0;
        background: transparent;
      }
      input[type="range"].jk-trim-range::-moz-range-progress {
        background: transparent;
      }
      input[type="range"].jk-trim-range::-moz-range-thumb {
        pointer-events: auto;
        cursor: ew-resize;
        inline-size: calc(12px * var(--jk-ui-scale, 1));
        block-size: calc(18px * var(--jk-ui-scale, 1));
        border: 1.5px solid #f0f6fc;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
      }
      input[type="range"].jk-trim-range:focus-visible {
        outline: 2px solid var(--slider-fill-color);
        outline-offset: 2px;
        border-radius: 4px;
      }
      .jk-trim-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: calc(5px * var(--jk-ui-scale, 1));
      }
      .jk-trim-times {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: calc(4px * var(--jk-ui-scale, 1));
        font-size: calc(11px * var(--jk-ui-scale, 1));
        font-variant-numeric: tabular-nums;
      }
      .jk-trim-edge-box {
        display: inline-flex;
        align-items: center;
        gap: calc(2px * var(--jk-ui-scale, 1));
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 4px;
        padding: calc(1px * var(--jk-ui-scale, 1)) calc(4px * var(--jk-ui-scale, 1));
      }
      .jk-trim-dot {
        inline-size: 6px;
        block-size: 6px;
        border-radius: 50%;
        background: #58a6ff;
        flex-shrink: 0;
      }
      .jk-trim-dot-end {
        background: #3fb950;
      }
      .jk-trim-val {
        color: #f0f6fc;
        font-weight: 600;
        min-inline-size: calc(38px * var(--jk-ui-scale, 1));
        text-align: center;
      }
      .jk-trim-step-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 3px;
        min-inline-size: calc(18px * var(--jk-ui-scale, 1));
        min-block-size: calc(18px * var(--jk-ui-scale, 1));
        padding: 0 calc(3px * var(--jk-ui-scale, 1));
        font-size: calc(10px * var(--jk-ui-scale, 1));
        line-height: 1;
        cursor: pointer;
      }
      .jk-trim-step-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-trim-dur-pill {
        background: rgba(47, 129, 247, 0.16);
        color: #79c0ff;
        border: 1px solid rgba(88, 166, 255, 0.4);
        border-radius: 999px;
        padding: calc(1px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
        font-weight: 600;
      }
      .jk-trim-actions {
        display: inline-flex;
        align-items: center;
        gap: calc(4px * var(--jk-ui-scale, 1));
        margin-inline-start: auto;
      }
      .jk-trim-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        min-block-size: calc(22px * var(--jk-ui-scale, 1));
        padding: calc(2px * var(--jk-ui-scale, 1)) calc(7px * var(--jk-ui-scale, 1));
        font-size: calc(11px * var(--jk-ui-scale, 1));
        font-weight: 500;
        cursor: pointer;
      }
      .jk-trim-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-trim-btn[aria-pressed="true"] {
        background: rgba(63, 185, 80, 0.2);
        border-color: #3fb950;
        color: #7ee787;
      }
      .jk-trim-btn-primary {
        background: #238636;
        border-color: #2ea043;
        color: #ffffff;
        font-weight: 600;
      }
      .jk-trim-btn-primary:hover {
        background: #2ea043;
      }
      #jk-pip-card.jk-pip-xs .jk-trim-step-btn {
        display: none;
      }
      @container jk-card (max-width: 340px) {
        .jk-trim-step-btn {
          display: none;
        }
      }

      /* Export Settings Modal Dialog (modern-web-guidance compliant) */
      #jk-export-dialog {
        color-scheme: only dark;
        background: #161b22;
        color: #e6edf3;
        accent-color: #58a6ff;
        border: 1px solid #30363d;
        border-radius: 10px;
        padding: 0;
        max-inline-size: min(520px, calc(100vw - 24px));
        inline-size: 100%;
        max-block-size: min(88dvh, 720px);
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.72);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        box-sizing: border-box;
      }
      #jk-export-dialog[open] {
        display: flex;
        flex-direction: column;
      }
      #jk-export-dialog:modal {
        overscroll-behavior: contain;
      }
      #jk-export-dialog::backdrop {
        overflow: hidden;
        overscroll-behavior: contain;
        background-color: rgba(4, 7, 12, 0.72);
        backdrop-filter: blur(3px);
      }
      #jk-export-form {
        display: flex;
        flex-direction: column;
        min-block-size: 0;
        max-block-size: inherit;
        margin: 0;
      }
      .jk-exp-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid #30363d;
        flex-shrink: 0;
      }
      .jk-exp-title-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-inline-size: 0;
      }
      .jk-exp-title-wrap h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: #f0f6fc;
      }
      .jk-exp-range-badge {
        background: rgba(47, 129, 247, 0.16);
        color: #79c0ff;
        border: 1px solid rgba(88, 166, 255, 0.35);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .jk-exp-icon-close {
        background: transparent;
        color: #8b949e;
        border: 1px solid transparent;
        border-radius: 6px;
        inline-size: 28px;
        block-size: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
      }
      .jk-exp-icon-close:hover {
        background: #21262d;
        color: #f0f6fc;
        border-color: #30363d;
      }
      .jk-exp-body {
        padding: 14px 16px;
        overflow-y: auto;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .jk-exp-section {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .jk-exp-row-2col {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
        gap: 10px;
      }
      @media (max-width: 460px) {
        .jk-exp-row-2col {
          grid-template-columns: 1fr;
        }
      }
      .jk-exp-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .jk-exp-label {
        font-size: 11.5px;
        font-weight: 600;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .jk-exp-est-pill {
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        color: #7ee787;
        font-weight: 600;
      }
      .jk-exp-est-pill.jk-exp-est-warn {
        color: #e3b341;
      }
      .jk-exp-seg {
        display: grid;
        grid-template-columns: repeat(var(--seg-cols, 3), minmax(0, 1fr));
        gap: 5px;
      }
      .jk-exp-seg-btn {
        background: #0d1117;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 6px;
        padding: 6px 8px;
        min-block-size: 32px;
        font-size: 12px;
        line-height: 1.2;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        text-align: center;
      }
      .jk-exp-seg-btn:hover {
        background: #21262d;
        border-color: #484f58;
        color: #ffffff;
      }
      .jk-exp-seg-btn[aria-pressed="true"] {
        background: rgba(31, 111, 235, 0.22);
        border-color: #58a6ff;
        color: #f0f6fc;
        font-weight: 600;
      }
      .jk-exp-seg-btn:focus-visible,
      .jk-exp-btn:focus-visible,
      .jk-trim-btn:focus-visible,
      .jk-trim-step-btn:focus-visible,
      .jk-exp-icon-close:focus-visible {
        outline: 2px solid #58a6ff;
        outline-offset: 2px;
      }
      .jk-exp-sub {
        font-size: 10px;
        color: #8b949e;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }
      .jk-exp-seg-btn[aria-pressed="true"] .jk-exp-sub {
        color: #79c0ff;
      }
      .jk-exp-divider {
        border: 0;
        border-top: 1px solid #21262d;
        margin: 2px 0;
      }
      .jk-exp-ftr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid #30363d;
        background: #0d1117;
        border-radius: 0 0 10px 10px;
        flex-shrink: 0;
      }
      .jk-exp-ftr-right {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-inline-start: auto;
      }
      .jk-exp-btn {
        border-radius: 6px;
        padding: 7px 13px;
        min-block-size: 34px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid #30363d;
        background: #21262d;
        color: #c9d1d9;
      }
      .jk-exp-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-exp-btn-ghost {
        background: transparent;
      }
      .jk-exp-btn-primary {
        background: #238636;
        border-color: #2ea043;
        color: #ffffff;
      }
      .jk-exp-btn-primary:hover {
        background: #2ea043;
      }

      /* Upper-Right Persistent Export Progress Toast (popover="manual") */
      #jk-export-toast {
        color-scheme: only dark;
        background: rgba(22, 27, 34, 0.97);
        color: #e6edf3;
        accent-color: #58a6ff;
        position: fixed;
        inset: calc(12px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) auto auto;
        margin: 0;
        inline-size: min(336px, calc(100vw - 24px));
        padding: 11px 13px;
        border: 1px solid #30363d;
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        z-index: 2147483000;
        box-sizing: border-box;
        flex-direction: column;
        gap: 7px;
      }
      #jk-export-toast:not(:is(:popover-open, .\\:popover-open)) {
        display: none;
      }
      #jk-export-toast[popover]:is(:popover-open, .\\:popover-open) {
        display: flex;
      }
      .jk-toast-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .jk-toast-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-inline-size: 0;
        font-weight: 600;
        color: #f0f6fc;
      }
      .jk-toast-title-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jk-toast-queue-pill {
        background: rgba(88, 166, 255, 0.18);
        color: #79c0ff;
        border: 1px solid rgba(88, 166, 255, 0.4);
        border-radius: 999px;
        padding: 1px 6px;
        font-size: 10.5px;
        font-weight: 600;
        white-space: nowrap;
      }
      .jk-toast-queue-pill[hidden] {
        display: none !important;
      }
      .jk-toast-close {
        background: transparent;
        color: #8b949e;
        border: 1px solid transparent;
        border-radius: 4px;
        inline-size: 22px;
        block-size: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        font-size: 14px;
        line-height: 1;
      }
      .jk-toast-close:hover {
        background: #21262d;
        color: #f0f6fc;
      }
      .jk-toast-sub {
        color: #8b949e;
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jk-toast-stage {
        color: #c9d1d9;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
      }
      #jk-export-progress {
        inline-size: 100%;
        block-size: 7px;
        accent-color: #58a6ff;
        margin: 0;
      }
      @supports not (accent-color: #58a6ff) {
        #jk-export-progress {
          -webkit-appearance: none;
          -moz-appearance: none;
          appearance: none;
          border: none;
          background: #21262d;
          height: 7px;
          border-radius: 999px;
          overflow: hidden;
        }
        #jk-export-progress::-webkit-progress-bar {
          background-color: #21262d;
          border-radius: 999px;
        }
        #jk-export-progress::-webkit-progress-value {
          background-color: #58a6ff;
          border-radius: 999px;
        }
        #jk-export-progress::-moz-progress-bar {
          background-color: #58a6ff;
          border-radius: 999px;
        }
      }
      .jk-toast-meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: #8b949e;
        font-variant-numeric: tabular-nums;
      }
      .jk-toast-cancel-btn {
        background: #21262d;
        color: #f85149;
        border: 1px solid rgba(248, 81, 73, 0.4);
        border-radius: 4px;
        padding: 2px 8px;
        min-block-size: 22px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .jk-toast-cancel-btn:hover {
        background: rgba(248, 81, 73, 0.16);
        border-color: #f85149;
      }
      .jk-toast-cancel-btn[hidden] {
        display: none !important;
      }
      .jk-toast-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-inline-start: auto;
      }
      .jk-toast-share-btn,
      .jk-toast-save-btn {
        background: #238636;
        color: #ffffff;
        border: 1px solid #2ea043;
        border-radius: 4px;
        padding: 3px 9px;
        min-block-size: 24px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .jk-toast-share-btn:hover {
        background: #2ea043;
      }
      .jk-toast-save-btn {
        background: #21262d;
        color: #c9d1d9;
        border-color: #30363d;
      }
      .jk-toast-save-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-toast-share-btn[hidden],
      .jk-toast-save-btn[hidden] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureTrimBarDOM(hostMode) {
    injectStyles();
    let bar = document.getElementById('jk-trim-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'jk-trim-bar';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Clip start and end trim handles');
      bar.hidden = true;
      bar.innerHTML = `
        <div class="jk-trim-track-wrap">
          <div class="jk-trim-rail">
            <div class="jk-trim-range-fill"></div>
          </div>
          <div class="jk-trim-playhead"></div>
          <input type="range" id="jk-trim-start" class="jk-trim-range" min="0" max="1000" step="50" value="0" aria-label="Clip start time" />
          <input type="range" id="jk-trim-end" class="jk-trim-range jk-trim-top" min="0" max="1000" step="50" value="1000" aria-label="Clip end time" />
        </div>
        <div class="jk-trim-row">
          <div class="jk-trim-times">
            <span class="jk-trim-edge-box" title="Clip Start">
              <span class="jk-trim-dot" aria-hidden="true"></span>
              <button type="button" class="jk-trim-step-btn" data-trim-step="start:-100" aria-label="Nudge start -0.1 seconds">-0.1</button>
              <span id="jk-trim-start-text" class="jk-trim-val">0:00.0</span>
              <button type="button" class="jk-trim-step-btn" data-trim-step="start:100" aria-label="Nudge start +0.1 seconds">+0.1</button>
            </span>
            <span id="jk-trim-duration" class="jk-trim-dur-pill">5.0s</span>
            <span class="jk-trim-edge-box" title="Clip End">
              <span class="jk-trim-dot jk-trim-dot-end" aria-hidden="true"></span>
              <button type="button" class="jk-trim-step-btn" data-trim-step="end:-100" aria-label="Nudge end -0.1 seconds">-0.1</button>
              <span id="jk-trim-end-text" class="jk-trim-val">0:05.0</span>
              <button type="button" class="jk-trim-step-btn" data-trim-step="end:100" aria-label="Nudge end +0.1 seconds">+0.1</button>
            </span>
          </div>
          <div class="jk-trim-actions">
            <button type="button" id="jk-trim-preview" class="jk-trim-btn" aria-pressed="false" title="Loop preview between Start and End">Preview</button>
            <button type="button" id="jk-trim-cancel" class="jk-trim-btn" title="Exit clip trim mode (Esc)">Cancel</button>
            <button type="button" id="jk-trim-next" class="jk-trim-btn jk-trim-btn-primary" title="Choose video export settings">Next\u2026</button>
          </div>
        </div>
      `;

      const startInput = bar.querySelector('#jk-trim-start');
      const endInput = bar.querySelector('#jk-trim-end');

      const onStartInput = () => {
        trimState.activeHandle = 'start';
        let nextStart = Math.round(parseFloat(startInput.value) || 0);
        const minGap = Math.min(MIN_CLIP_MS, trimState.durationMs);
        if (nextStart > trimState.endMs - minGap) {
          nextStart = Math.max(0, trimState.endMs - minGap);
        }
        trimState.startMs = nextStart;
        stopTrimPreview(true);
        syncTrimBarUI();
        throttledLiveSeek(trimState.startMs);
      };

      const onEndInput = () => {
        trimState.activeHandle = 'end';
        let nextEnd = Math.round(parseFloat(endInput.value) || 0);
        const minGap = Math.min(MIN_CLIP_MS, trimState.durationMs);
        if (nextEnd < trimState.startMs + minGap) {
          nextEnd = Math.min(trimState.durationMs, trimState.startMs + minGap);
        }
        trimState.endMs = nextEnd;
        stopTrimPreview(true);
        syncTrimBarUI();
        throttledLiveSeek(trimState.endMs);
      };

      startInput.addEventListener('pointerdown', () => {
        trimState.activeHandle = 'start';
        syncTrimHandleStacking();
      });
      endInput.addEventListener('pointerdown', () => {
        trimState.activeHandle = 'end';
        syncTrimHandleStacking();
      });
      startInput.addEventListener('focus', () => {
        trimState.activeHandle = 'start';
        syncTrimHandleStacking();
      });
      endInput.addEventListener('focus', () => {
        trimState.activeHandle = 'end';
        syncTrimHandleStacking();
      });
      startInput.addEventListener('input', onStartInput);
      startInput.addEventListener('change', onStartInput);
      endInput.addEventListener('input', onEndInput);
      endInput.addEventListener('change', onEndInput);

      bar.querySelectorAll('[data-trim-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const spec = (btn.getAttribute('data-trim-step') || '').split(':');
          const which = spec[0];
          const delta = parseInt(spec[1] || '0', 10);
          if (!Number.isFinite(delta)) return;
          const minGap = Math.min(MIN_CLIP_MS, trimState.durationMs);
          stopTrimPreview(true);
          if (which === 'start') {
            trimState.activeHandle = 'start';
            trimState.startMs = Math.max(
              0,
              Math.min(trimState.endMs - minGap, trimState.startMs + delta)
            );
            syncTrimBarUI();
            throttledLiveSeek(trimState.startMs);
          } else {
            trimState.activeHandle = 'end';
            trimState.endMs = Math.min(
              trimState.durationMs,
              Math.max(trimState.startMs + minGap, trimState.endMs + delta)
            );
            syncTrimBarUI();
            throttledLiveSeek(trimState.endMs);
          }
        });
      });

      bar.querySelector('#jk-trim-preview').addEventListener('click', () => {
        toggleTrimPreview();
      });
      bar.querySelector('#jk-trim-cancel').addEventListener('click', () => {
        exitTrimMode(false);
      });
      bar.querySelector('#jk-trim-next').addEventListener('click', () => {
        stopTrimPreview(true);
        openSettingsDialog();
      });
    }

    if (hostMode === 'standalone') {
      const seekSlider = document.getElementById('slider-seek');
      const seekGroup = seekSlider ? seekSlider.closest('.control-group') : null;
      const controlsBar = document.getElementById('jk-controls-bar');
      if (seekGroup && seekGroup.parentNode) {
        if (bar.parentNode !== seekGroup.parentNode || bar.previousElementSibling !== seekGroup) {
          seekGroup.parentNode.insertBefore(bar, seekGroup.nextSibling);
        }
      } else if (controlsBar && bar.parentNode !== controlsBar) {
        controlsBar.insertBefore(bar, controlsBar.firstChild);
      }
    } else {
      const timelineRow = document.querySelector('#jk-pip-controls .jk-pip-timeline-row');
      const pipControls = document.getElementById('jk-pip-controls');
      if (timelineRow && timelineRow.parentNode) {
        if (bar.parentNode !== timelineRow.parentNode || bar.previousElementSibling !== timelineRow) {
          timelineRow.parentNode.insertBefore(bar, timelineRow.nextSibling);
        }
      } else if (pipControls && bar.parentNode !== pipControls) {
        pipControls.insertBefore(bar, pipControls.firstChild);
      }
    }

    return bar;
  }

  function throttledLiveSeek(targetMs) {
    const player = getPlayer();
    if (!player || typeof player.seekToMs !== 'function') return;
    const now = Date.now();
    const run = () => {
      trimState.lastSeekSentAt = Date.now();
      player.seekToMs(Math.round(targetMs));
      syncTrimPlayheadOnly();
    };
    if (now - trimState.lastSeekSentAt >= 65) {
      if (trimState.pendingSeekTimer) {
        clearTimeout(trimState.pendingSeekTimer);
        trimState.pendingSeekTimer = 0;
      }
      run();
    } else if (!trimState.pendingSeekTimer) {
      trimState.pendingSeekTimer = setTimeout(() => {
        trimState.pendingSeekTimer = 0;
        run();
      }, 65);
    }
  }

  function syncTrimHandleStacking() {
    const startInput = document.getElementById('jk-trim-start');
    const endInput = document.getElementById('jk-trim-end');
    if (!startInput || !endInput) return;
    const nearRightEdge =
      trimState.durationMs > 0 && trimState.startMs > trimState.durationMs * 0.85;
    const startOnTop = trimState.activeHandle === 'start' || nearRightEdge;
    startInput.classList.toggle('jk-trim-top', startOnTop);
    endInput.classList.toggle('jk-trim-top', !startOnTop);
  }

  function syncTrimPlayheadOnly() {
    const bar = document.getElementById('jk-trim-bar');
    if (!bar || !trimState.active) return;
    const player = getPlayer();
    const cur =
      player && typeof player.getCurrentTimeMs === 'function'
        ? Math.max(0, Math.min(trimState.durationMs, player.getCurrentTimeMs()))
        : trimState.startMs;
    const dur = Math.max(1, trimState.durationMs);
    const curPct = Math.max(0, Math.min(100, (cur / dur) * 100));
    bar.style.setProperty('--trim-cur-pct', curPct.toFixed(3) + '%');
  }

  function syncTrimBarUI() {
    const bar = document.getElementById('jk-trim-bar');
    if (!bar) return;
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const startMs = Math.max(0, Math.min(dur, trimState.startMs));
    const endMs = Math.max(startMs, Math.min(dur, trimState.endMs));

    const startInput = bar.querySelector('#jk-trim-start');
    const endInput = bar.querySelector('#jk-trim-end');
    if (startInput) {
      startInput.max = String(dur);
      startInput.value = String(startMs);
      startInput.setAttribute('aria-valuetext', formatTimePrecise(startMs));
      syncRangeCssVars(startInput);
    }
    if (endInput) {
      endInput.max = String(dur);
      endInput.value = String(endMs);
      endInput.setAttribute('aria-valuetext', formatTimePrecise(endMs));
      syncRangeCssVars(endInput);
    }

    const startPct = (startMs / dur) * 100;
    const endPct = (endMs / dur) * 100;
    bar.style.setProperty('--trim-start-pct', startPct.toFixed(3) + '%');
    bar.style.setProperty('--trim-end-pct', endPct.toFixed(3) + '%');
    syncTrimPlayheadOnly();
    syncTrimHandleStacking();

    const startText = bar.querySelector('#jk-trim-start-text');
    const endText = bar.querySelector('#jk-trim-end-text');
    const durPill = bar.querySelector('#jk-trim-duration');
    const prevBtn = bar.querySelector('#jk-trim-preview');
    if (startText) startText.textContent = formatTimePrecise(startMs);
    if (endText) endText.textContent = formatTimePrecise(endMs);
    if (durPill) durPill.textContent = formatDurationShort(endMs - startMs);
    if (prevBtn) {
      prevBtn.setAttribute('aria-pressed', trimState.previewing ? 'true' : 'false');
      prevBtn.textContent = trimState.previewing ? 'Stop' : 'Preview';
    }
  }

  function stopTrimPreview(pausePlayer) {
    if (trimState.previewRaf) {
      cancelAnimationFrame(trimState.previewRaf);
      trimState.previewRaf = 0;
    }
    if (trimState.previewing) {
      trimState.previewing = false;
      if (pausePlayer) {
        const player = getPlayer();
        if (player && typeof player.pause === 'function') {
          player.pause();
        }
      }
      syncTrimBarUI();
    }
  }

  function toggleTrimPreview() {
    const player = getPlayer();
    if (!player) return;
    if (trimState.previewing) {
      stopTrimPreview(true);
      return;
    }
    trimState.previewing = true;
    if (typeof player.seekToMs === 'function') {
      player.seekToMs(trimState.startMs);
    }
    if (typeof player.resume === 'function') {
      player.resume();
    }
    syncTrimBarUI();

    const tick = () => {
      if (!trimState.active || !trimState.previewing) return;
      const p = getPlayer();
      if (p && typeof p.getCurrentTimeMs === 'function') {
        const cur = p.getCurrentTimeMs();
        if (cur >= trimState.endMs || cur < Math.max(0, trimState.startMs - 500)) {
          p.seekToMs(trimState.startMs);
          if (typeof p.isPaused === 'function' && p.isPaused() && typeof p.resume === 'function') {
            p.resume();
          }
        }
      }
      syncTrimPlayheadOnly();
      trimState.previewRaf = requestAnimationFrame(tick);
    };
    trimState.previewRaf = requestAnimationFrame(tick);
  }

  function syncHostTrimVisibility(showTrim) {
    const pipTimeline = document.querySelector('#jk-pip-controls .jk-pip-timeline-row');
    if (pipTimeline) {
      pipTimeline.hidden = Boolean(showTrim && trimState.hostMode === 'pip');
    }
    const seekSlider = document.getElementById('slider-seek');
    const standaloneGroup = seekSlider ? seekSlider.closest('.control-group') : null;
    if (standaloneGroup) {
      standaloneGroup.hidden = Boolean(showTrim && trimState.hostMode === 'standalone');
    }
    const bar = document.getElementById('jk-trim-bar');
    if (bar) {
      bar.hidden = !showTrim;
    }
    const pipExportBtn = document.getElementById('jk-pip-export-btn');
    if (pipExportBtn) {
      pipExportBtn.classList.toggle('active', Boolean(showTrim && trimState.hostMode === 'pip'));
      pipExportBtn.setAttribute(
        'aria-pressed',
        showTrim && trimState.hostMode === 'pip' ? 'true' : 'false'
      );
    }
    const standaloneBtn = document.getElementById('btn-export');
    if (standaloneBtn) {
      standaloneBtn.setAttribute(
        'aria-pressed',
        showTrim && trimState.hostMode === 'standalone' ? 'true' : 'false'
      );
      standaloneBtn.style.borderColor =
        showTrim && trimState.hostMode === 'standalone' ? '#58a6ff' : '';
      standaloneBtn.style.color =
        showTrim && trimState.hostMode === 'standalone' ? '#58a6ff' : '';
    }
  }

  function snapshotLivePlayerDefaults() {
    const player = getPlayer();
    if (!player) return;
    const st = typeof player.getStatus === 'function' ? player.getStatus() : {};
    const is3p =
      typeof player.getThirdPerson === 'function'
        ? player.getThirdPerson()
        : st.thirdPerson !== false;
    dialogOptions.camera = is3p ? '3rd' : '1st';

    const rawSpeed =
      typeof player.getSpeed === 'function' ? Number(player.getSpeed()) : Number(st.speed || 1);
    const speedChoices = [0.25, 0.5, 1, 2, 4];
    let bestSpeed = 1;
    let bestDiff = Infinity;
    for (const s of speedChoices) {
      const d = Math.abs(s - rawSpeed);
      if (d < bestDiff) {
        bestDiff = d;
        bestSpeed = s;
      }
    }
    dialogOptions.speed = bestSpeed;

    dialogOptions.capturedGamma =
      typeof player.getGamma === 'function' ? Number(player.getGamma()) : Number(st.gamma || 1.0);
    dialogOptions.capturedOverbright =
      typeof player.getOverbright === 'function'
        ? Number(player.getOverbright())
        : Number(st.overbright || 0);
    dialogOptions.lighting = 'current';
  }

  function enterTrimMode(hostMode) {
    const mode = hostMode === 'standalone' ? 'standalone' : 'pip';
    const player = getPlayer();
    const st = player && typeof player.getStatus === 'function' ? player.getStatus() : null;
    const dur =
      player && typeof player.getDurationMs === 'function'
        ? Math.round(player.getDurationMs())
        : st
        ? Math.round(st.durationMs || 0)
        : 0;

    if (!player || dur <= 0) {
      showTransientNotice('Load a demo first to export a video clip.');
      return false;
    }

    if (trimState.active && trimState.hostMode === mode) {
      openSettingsDialog();
      return true;
    }

    const cur =
      typeof player.getCurrentTimeMs === 'function'
        ? Math.max(0, Math.min(dur, Math.round(player.getCurrentTimeMs())))
        : 0;

    trimState.wasPaused =
      typeof player.isPaused === 'function' ? Boolean(player.isPaused()) : Boolean(st && st.isPaused);
    if (typeof player.pause === 'function') {
      player.pause();
    }

    let startMs = Math.max(0, cur - DEFAULT_PRE_MS);
    let endMs = Math.min(dur, cur + DEFAULT_POST_MS);
    const minSpan = Math.min(MIN_CLIP_MS, dur);
    if (endMs - startMs < minSpan) {
      if (endMs + minSpan <= dur) {
        endMs = Math.min(dur, startMs + minSpan);
      } else {
        startMs = Math.max(0, endMs - minSpan);
      }
    }

    trimState.active = true;
    trimState.hostMode = mode;
    trimState.durationMs = dur;
    trimState.startMs = startMs;
    trimState.endMs = endMs;
    trimState.previewing = false;
    trimState.activeHandle = 'end';

    snapshotLivePlayerDefaults();
    ensureTrimBarDOM(mode);
    syncHostTrimVisibility(true);
    syncTrimBarUI();

    const nextBtn = document.getElementById('jk-trim-next');
    if (nextBtn) {
      try {
        nextBtn.focus({ preventScroll: true });
      } catch (_) {}
    }
    return true;
  }

  function exitTrimMode(restorePlayState) {
    if (!trimState.active) return;
    stopTrimPreview(false);
    if (trimState.pendingSeekTimer) {
      clearTimeout(trimState.pendingSeekTimer);
      trimState.pendingSeekTimer = 0;
    }
    trimState.active = false;
    syncHostTrimVisibility(false);

    const dlg = document.getElementById('jk-export-dialog');
    if (dlg && dlg.hasAttribute('open')) {
      try {
        dlg.close('');
      } catch (_) {}
    }

    const player = getPlayer();
    if (player) {
      if (restorePlayState && !trimState.wasPaused && typeof player.resume === 'function') {
        player.resume();
      } else if (typeof player.pause === 'function') {
        player.pause();
      }
    }
  }

  function ensureSettingsDialogDOM() {
    injectStyles();
    let dlg = document.getElementById('jk-export-dialog');
    if (dlg) return dlg;

    dlg = document.createElement('dialog');
    dlg.id = 'jk-export-dialog';
    dlg.setAttribute('closedby', 'any');
    dlg.setAttribute('aria-labelledby', 'jk-export-dialog-title');

    dlg.innerHTML = `
      <form id="jk-export-form" method="dialog">
        <div class="jk-exp-hdr">
          <div class="jk-exp-title-wrap">
            ${ICON_CLIP_SM}
            <h2 id="jk-export-dialog-title">Export Video Clip</h2>
            <span id="jk-export-range-summary" class="jk-exp-range-badge">0:00.0 \u2013 0:15.0 \u00B7 15.0s</span>
          </div>
          <button type="submit" value="back" class="jk-exp-icon-close" aria-label="Back to trim">\u00D7</button>
        </div>

        <div class="jk-exp-body">
          <div class="jk-exp-section">
            <div class="jk-exp-label-row">
              <span class="jk-exp-label">Aspect Ratio</span>
            </div>
            <div class="jk-exp-seg" style="--seg-cols: 3;" role="group" aria-label="Aspect ratio">
              <button type="button" class="jk-exp-seg-btn" data-opt-group="aspect" data-opt-val="16:9" aria-pressed="true">
                <span>16:9 Widescreen</span>
                <span class="jk-exp-sub">Discord / YouTube</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="aspect" data-opt-val="9:16" aria-pressed="false">
                <span>9:16 Portrait</span>
                <span class="jk-exp-sub">Mobile / Shorts</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="aspect" data-opt-val="4:3" aria-pressed="false">
                <span>4:3 Classic</span>
                <span class="jk-exp-sub">Original Arena</span>
              </button>
            </div>
          </div>

          <div class="jk-exp-row-2col">
            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">Resolution</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 4;" role="group" aria-label="Resolution">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="resTier" data-opt-val="480p" aria-pressed="false">
                  <span>480p</span>
                  <span class="jk-exp-sub" data-res-sub="480p">854\u00D7480</span>
                </button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="resTier" data-opt-val="720p" aria-pressed="false">
                  <span>720p</span>
                  <span class="jk-exp-sub" data-res-sub="720p">1280\u00D7720</span>
                </button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="resTier" data-opt-val="1080p" aria-pressed="true">
                  <span>1080p</span>
                  <span class="jk-exp-sub" data-res-sub="1080p">1920\u00D71080</span>
                </button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="resTier" data-opt-val="1440p" aria-pressed="false">
                  <span>1440p</span>
                  <span class="jk-exp-sub" data-res-sub="1440p">2560\u00D71440</span>
                </button>
              </div>
            </div>

            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">Frame Rate</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 2;" role="group" aria-label="Frame rate">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="fps" data-opt-val="60" aria-pressed="true">
                  <span>60 fps</span>
                  <span class="jk-exp-sub">Smooth</span>
                </button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="fps" data-opt-val="30" aria-pressed="false">
                  <span>30 fps</span>
                  <span class="jk-exp-sub">Compact</span>
                </button>
              </div>
            </div>
          </div>

          <div class="jk-exp-section">
            <div class="jk-exp-label-row">
              <span class="jk-exp-label">Quality / File Size</span>
              <span id="jk-export-est-size" class="jk-exp-est-pill">Est. ~6.4 MB</span>
            </div>
            <div class="jk-exp-seg" style="--seg-cols: 4;" role="group" aria-label="Quality and file size target">
              <button type="button" class="jk-exp-seg-btn" data-opt-group="quality" data-opt-val="discord10" aria-pressed="true">
                <span>Discord</span>
                <span class="jk-exp-sub">&lt; 10 MB</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="quality" data-opt-val="discord50" aria-pressed="false">
                <span>Nitro</span>
                <span class="jk-exp-sub">&lt; 50 MB</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="quality" data-opt-val="crf18" aria-pressed="false">
                <span>CRF 18</span>
                <span class="jk-exp-sub">High Quality</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="quality" data-opt-val="crf23" aria-pressed="false">
                <span>CRF 23</span>
                <span class="jk-exp-sub">Balanced</span>
              </button>
            </div>
          </div>

          <div class="jk-exp-row-2col">
            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">HUD</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 3;" role="group" aria-label="HUD visibility">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="hud" data-opt-val="full" aria-pressed="true"><span>Full HUD</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="hud" data-opt-val="frags" aria-pressed="false"><span>Frags Only</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="hud" data-opt-val="none" aria-pressed="false"><span>No HUD</span></button>
              </div>
            </div>

            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">Audio</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 2;" role="group" aria-label="Audio export">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="audio" data-opt-val="on" aria-pressed="true"><span>Sound On</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="audio" data-opt-val="off" aria-pressed="false"><span>No Sound</span></button>
              </div>
            </div>
          </div>

          <div class="jk-exp-section">
            <div class="jk-exp-label-row">
              <span class="jk-exp-label">Motion Blur</span>
            </div>
            <div class="jk-exp-seg" style="--seg-cols: 4;" role="group" aria-label="GPU motion blur">
              <button type="button" class="jk-exp-seg-btn" data-opt-group="blur" data-opt-val="0" aria-pressed="true"><span>Off</span></button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="blur" data-opt-val="4" aria-pressed="false"><span>Light (4\u00D7)</span></button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="blur" data-opt-val="8" aria-pressed="false"><span>Medium (8\u00D7)</span></button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="blur" data-opt-val="16" aria-pressed="false"><span>Smooth (16\u00D7)</span></button>
            </div>
          </div>

          <hr class="jk-exp-divider" />

          <div class="jk-exp-row-2col">
            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">Playback Speed</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 5;" role="group" aria-label="Export speed">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="speed" data-opt-val="0.25" aria-pressed="false"><span>0.25\u00D7</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="speed" data-opt-val="0.5" aria-pressed="false"><span>0.5\u00D7</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="speed" data-opt-val="1" aria-pressed="true"><span>1\u00D7</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="speed" data-opt-val="2" aria-pressed="false"><span>2\u00D7</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="speed" data-opt-val="4" aria-pressed="false"><span>4\u00D7</span></button>
              </div>
            </div>

            <div class="jk-exp-section">
              <div class="jk-exp-label-row">
                <span class="jk-exp-label">Camera</span>
              </div>
              <div class="jk-exp-seg" style="--seg-cols: 2;" role="group" aria-label="Camera perspective">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="camera" data-opt-val="3rd" aria-pressed="true"><span>3rd Person</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="camera" data-opt-val="1st" aria-pressed="false"><span>1st Person</span></button>
              </div>
            </div>
          </div>

          <div class="jk-exp-section">
            <div class="jk-exp-label-row">
              <span class="jk-exp-label">Lighting</span>
            </div>
            <div class="jk-exp-seg" style="--seg-cols: 5;" role="group" aria-label="Map lighting">
              <button type="button" class="jk-exp-seg-btn" data-opt-group="lighting" data-opt-val="current" aria-pressed="true">
                <span>Current</span>
                <span id="jk-exp-cur-light-sub" class="jk-exp-sub">G1.0 / +0</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="lighting" data-opt-val="stock" aria-pressed="false">
                <span>Stock</span>
                <span class="jk-exp-sub">G1.0 / +0</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="lighting" data-opt-val="overbright" aria-pressed="false">
                <span>Overbright</span>
                <span class="jk-exp-sub">G1.0 / +2</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="lighting" data-opt-val="gamma2" aria-pressed="false">
                <span>Gamma 2</span>
                <span class="jk-exp-sub">G2.0 / +0</span>
              </button>
              <button type="button" class="jk-exp-seg-btn" data-opt-group="lighting" data-opt-val="bright" aria-pressed="false">
                <span>Bright+</span>
                <span class="jk-exp-sub">G1.4 / +1</span>
              </button>
            </div>
          </div>
        </div>

        <div class="jk-exp-ftr">
          <button type="submit" value="back" class="jk-exp-btn jk-exp-btn-ghost">Back to Trim</button>
          <div class="jk-exp-ftr-right">
            <button type="submit" value="cancel" class="jk-exp-btn jk-exp-btn-ghost">Cancel</button>
            <button type="submit" value="confirm" id="jk-export-confirm-btn" class="jk-exp-btn jk-exp-btn-primary" autofocus>Start Export</button>
          </div>
        </div>
      </form>
    `;

    dlg.querySelectorAll('[data-opt-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.getAttribute('data-opt-group');
        const val = btn.getAttribute('data-opt-val');
        if (!group || val == null) return;
        if (group === 'fps' || group === 'blur') {
          dialogOptions[group] = parseInt(val, 10);
        } else if (group === 'speed') {
          dialogOptions[group] = parseFloat(val);
        } else {
          dialogOptions[group] = val;
        }
        syncDialogUI();
      });
    });

    // Fallback for browsers without native dialog closedby="any" support
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      const isOutside = (ev) => {
        const r = dlg.getBoundingClientRect();
        return (
          ev.clientX < r.left ||
          ev.clientX > r.right ||
          ev.clientY < r.top ||
          ev.clientY > r.bottom
        );
      };
      let pressedOutside = false;
      dlg.addEventListener('pointerdown', (ev) => {
        pressedOutside = ev.target === dlg && isOutside(ev);
      });
      dlg.addEventListener('pointerup', (ev) => {
        if (pressedOutside && ev.target === dlg && isOutside(ev)) {
          dlg.close('');
        }
        pressedOutside = false;
      });
    }

    const handleDialogAction = (action) => {
      if (action === 'confirm') {
        const built = buildJobFromCurrentSelection();
        exitTrimMode(false);
        if (built) {
          enqueueExportJob(built);
        }
      } else if (action === 'cancel') {
        exitTrimMode(false);
      } else {
        // 'back' or '' (Esc / backdrop light-dismiss): stay in Trim Mode so handles aren't lost
        const nextBtn = document.getElementById('jk-trim-next');
        if (trimState.active && nextBtn) {
          try {
            nextBtn.focus({ preventScroll: true });
          } catch (_) {}
        }
      }
    };

    const form = dlg.querySelector('#jk-export-form');
    let handledInSubmit = false;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const action = (ev.submitter && ev.submitter.value) || '';
      handledInSubmit = true;
      try {
        dlg.close(action);
      } catch (_) {}
      dlg.returnValue = '';
      handleDialogAction(action);
    });

    dlg.addEventListener('close', () => {
      if (handledInSubmit) {
        handledInSubmit = false;
        dlg.returnValue = '';
        return;
      }
      const action = dlg.returnValue;
      dlg.returnValue = '';
      handleDialogAction(action);
    });

    getTopLayerHost().appendChild(dlg);
    return dlg;
  }

  function resolveSelectedDimensions() {
    const aspectMap = RESOLUTIONS[dialogOptions.aspect] || RESOLUTIONS['16:9'];
    return aspectMap[dialogOptions.resTier] || aspectMap['1080p'];
  }

  function resolveSelectedLighting() {
    if (dialogOptions.lighting === 'current') {
      return {
        gamma: Math.max(0.5, Math.min(3.0, Number(dialogOptions.capturedGamma) || 1.0)),
        overbright: Math.max(0, Math.min(3, Math.round(Number(dialogOptions.capturedOverbright) || 0))),
      };
    }
    const preset = LIGHTING_PRESETS[dialogOptions.lighting] || LIGHTING_PRESETS.stock;
    return { gamma: preset.gamma, overbright: preset.overbright };
  }

  function computeEstimatedBytes() {
    const dims = resolveSelectedDimensions();
    const fps = Number(dialogOptions.fps) || 60;
    const speed = Math.max(0.1, Number(dialogOptions.speed) || 1.0);
    const clipDemoMs = Math.max(MIN_CLIP_MS, trimState.endMs - trimState.startMs);
    const outSec = clipDemoMs / 1000.0 / speed;
    const audioOn = dialogOptions.audio !== 'off';
    let audioBitrate = audioOn ? 128000 : 0;
    const q = dialogOptions.quality;
    let videoBitrate = 0;

    if (q === 'discord10' || q === 'discord50') {
      const maxMegs = q === 'discord10' ? 8.5 : 44.0;
      if (q === 'discord10' && outSec > 35 && audioOn) {
        audioBitrate = 96000;
      }
      const totalBudgetBits = maxMegs * 1024 * 1024 * 8 * 0.94;
      const availVideoBits = Math.max(220000 * outSec, totalBudgetBits - audioBitrate * outSec);
      const maxSensible = Math.round(dims.width * dims.height * fps * 0.16);
      videoBitrate = Math.max(
        220000,
        Math.min(maxSensible, Math.floor(availVideoBits / Math.max(0.5, outSec)))
      );
    } else if (q === 'crf18') {
      videoBitrate = Math.round(dims.width * dims.height * fps * 0.14);
    } else {
      videoBitrate = Math.round(dims.width * dims.height * fps * 0.075);
    }

    const totalBytes = ((videoBitrate + audioBitrate) * outSec) / 8 * 1.03;
    const totalFrames = Math.max(1, Math.ceil(outSec * fps));
    return { totalBytes, outSec, totalFrames, videoBitrate };
  }

  function syncDialogUI() {
    const dlg = document.getElementById('jk-export-dialog');
    if (!dlg) return;

    const aspectMap = RESOLUTIONS[dialogOptions.aspect] || RESOLUTIONS['16:9'];
    ['480p', '720p', '1080p', '1440p'].forEach((tier) => {
      const sub = dlg.querySelector(`[data-res-sub="${tier}"]`);
      const d = aspectMap[tier];
      if (sub && d) {
        sub.textContent = `${d.width}\u00D7${d.height}`;
      }
    });

    const curLightSub = dlg.querySelector('#jk-exp-cur-light-sub');
    if (curLightSub) {
      curLightSub.textContent = `G${Number(dialogOptions.capturedGamma || 1).toFixed(1)} / +${Math.round(
        Number(dialogOptions.capturedOverbright || 0)
      )}`;
    }

    dlg.querySelectorAll('[data-opt-group]').forEach((btn) => {
      const group = btn.getAttribute('data-opt-group');
      const val = btn.getAttribute('data-opt-val');
      const cur = String(dialogOptions[group]);
      btn.setAttribute('aria-pressed', cur === val ? 'true' : 'false');
    });

    const est = computeEstimatedBytes();
    const rangeSummary = dlg.querySelector('#jk-export-range-summary');
    if (rangeSummary) {
      rangeSummary.textContent = `${formatTimePrecise(trimState.startMs)} \u2013 ${formatTimePrecise(
        trimState.endMs
      )} \u00B7 ${est.outSec.toFixed(1)}s out`;
    }

    const estEl = dlg.querySelector('#jk-export-est-size');
    if (estEl) {
      const lowBppWarn =
        dialogOptions.quality === 'discord10' &&
        est.videoBitrate < 1200000 &&
        dialogOptions.resTier === '1080p';
      estEl.classList.toggle('jk-exp-est-warn', lowBppWarn);
      estEl.textContent = `Est. ~${formatBytesMB(est.totalBytes)} \u00B7 ${est.totalFrames} frames`;
    }
  }

  function openSettingsDialog() {
    if (!trimState.active) return;
    const dlg = ensureSettingsDialogDOM();
    reparentTopLayerElement(dlg, getTopLayerHost());
    dlg.returnValue = '';
    syncDialogUI();
    if (!dlg.hasAttribute('open')) {
      dlg.showModal();
    }
  }

  function buildJobFromCurrentSelection() {
    const player = getPlayer();
    if (!player) return null;
    const desc =
      typeof player.getExportSourceDescriptor === 'function'
        ? player.getExportSourceDescriptor()
        : null;
    if (!desc) return null;

    const dims = resolveSelectedDimensions();
    const light = resolveSelectedLighting();
    const pipTitleEl = document.getElementById('jk-pip-title');
    const displayTitle =
      (trimState.hostMode === 'pip' && pipTitleEl && pipTitleEl.textContent.trim()) ||
      desc.label ||
      desc.shortName ||
      desc.fileName ||
      'jka-clip';

    const filename = sanitizeClipFilename(
      displayTitle,
      trimState.startMs,
      trimState.endMs,
      dialogOptions.aspect,
      dialogOptions.resTier
    );

    const jobId = 'jkexp-' + Date.now() + '-' + exportQueue.nextJobSeq++;

    return {
      id: jobId,
      title: displayTitle,
      filename,
      settings: {
        filename,
        aspect: dialogOptions.aspect,
        resTier: dialogOptions.resTier,
        width: dims.width,
        height: dims.height,
        fps: Number(dialogOptions.fps) || 60,
        quality: dialogOptions.quality,
        hud: dialogOptions.hud,
        audio: dialogOptions.audio !== 'off',
        blurFrames: Number(dialogOptions.blur) || 0,
        thirdPerson: dialogOptions.camera === '3rd',
        speed: Number(dialogOptions.speed) || 1.0,
        gamma: light.gamma,
        overbright: light.overbright,
        startMs: trimState.startMs,
        endMs: trimState.endMs,
      },
      source: {
        isMmeStream: Boolean(desc.isMmeStream),
        streamUrl: desc.streamUrl || '',
        mmeInitBytes: desc.mmeInitBytes || null,
        mmeMeta: desc.mmeMeta || null,
        sourceUrl: desc.sourceUrl || '',
        fileName: desc.fileName || '',
        shortName: desc.shortName || '',
        demoBytes: desc.demoBytes || null,
      },
      engineConfig: Object.assign({}, desc.engineConfig || {}, {
        pk3Manifest: desc.pk3Manifest || window.__jkPk3Manifest || null,
      }),
    };
  }

  let activeShareFile = null;
  let activeShareFilename = '';

  function canShareVideoFile(file) {
    if (!file || typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return false;
    }
    try {
      if (typeof navigator.canShare === 'function') {
        return Boolean(navigator.canShare({ files: [file] }));
      }
    } catch (_) {}
    return false;
  }

  function ensureToastDOM() {
    injectStyles();
    let toast = document.getElementById('jk-export-toast');
    if (toast) return toast;

    toast = document.createElement('aside');
    toast.id = 'jk-export-toast';
    toast.setAttribute('popover', 'manual');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <div class="jk-toast-hdr">
        <div class="jk-toast-title-row">
          ${ICON_CLIP_SM}
          <span id="jk-toast-title" class="jk-toast-title-text">Exporting clip\u2026</span>
          <span id="jk-toast-queue" class="jk-toast-queue-pill" hidden>+1 queued</span>
        </div>
        <button type="button" id="jk-toast-dismiss" class="jk-toast-close" popovertarget="jk-export-toast" popovertargetaction="hide" aria-label="Dismiss notification">\u00D7</button>
      </div>
      <div id="jk-toast-sub" class="jk-toast-sub">1920\u00D71080 \u00B7 60fps</div>
      <div id="jk-toast-stage" class="jk-toast-stage">Starting export worker\u2026</div>
      <progress id="jk-export-progress" max="100" value="0">0%</progress>
      <div class="jk-toast-meta-row">
        <span id="jk-toast-metrics">0%</span>
        <div class="jk-toast-actions">
          <button type="button" id="jk-toast-save" class="jk-toast-save-btn" hidden>Save</button>
          <button type="button" id="jk-toast-share" class="jk-toast-share-btn" hidden>Share</button>
          <button type="button" id="jk-toast-cancel" class="jk-toast-cancel-btn">Cancel</button>
        </div>
      </div>
    `;

    toast.querySelector('#jk-toast-dismiss').addEventListener('click', () => {
      activeShareFile = null;
      hidePopoverCompat(toast);
    });
    toast.querySelector('#jk-toast-cancel').addEventListener('click', () => {
      if (exportQueue.activeJob) {
        cancelJob(exportQueue.activeJob.id);
      }
    });
    toast.querySelector('#jk-toast-save').addEventListener('click', () => {
      if (activeShareFile) {
        triggerBlobFallbackDownload(activeShareFile, activeShareFilename || activeShareFile.name);
      }
    });
    toast.querySelector('#jk-toast-share').addEventListener('click', async () => {
      if (!activeShareFile || typeof navigator.share !== 'function') return;
      try {
        await navigator.share({
          files: [activeShareFile],
          title: activeShareFilename || activeShareFile.name || 'jka-clip.mp4',
        });
      } catch (_) {}
    });

    getTopLayerHost().appendChild(toast);
    return toast;
  }

  function showTransientNotice(message) {
    const toast = ensureToastDOM();
    if (exportQueue.autoDismissTimer) {
      clearTimeout(exportQueue.autoDismissTimer);
      exportQueue.autoDismissTimer = 0;
    }
    activeShareFile = null;
    toast.querySelector('#jk-toast-title').textContent = 'Video Clip Export';
    toast.querySelector('#jk-toast-queue').hidden = true;
    toast.querySelector('#jk-toast-sub').textContent = '';
    toast.querySelector('#jk-toast-stage').textContent = message;
    const prog = toast.querySelector('#jk-export-progress');
    prog.value = 0;
    toast.querySelector('#jk-toast-metrics').textContent = '';
    toast.querySelector('#jk-toast-cancel').hidden = true;
    toast.querySelector('#jk-toast-share').hidden = true;
    toast.querySelector('#jk-toast-save').hidden = true;
    showPopoverCompat(toast);
    exportQueue.autoDismissTimer = setTimeout(() => {
      if (!exportQueue.activeJob) {
        hidePopoverCompat(toast);
      }
    }, 3500);
  }

  function updateToastForJob(stateObj) {
    const toast = ensureToastDOM();
    const qPill = toast.querySelector('#jk-toast-queue');
    const qCount = exportQueue.pendingJobs.length;
    qPill.hidden = qCount === 0;
    if (qCount > 0) {
      qPill.textContent = `+${qCount} queued`;
    }

    toast.querySelector('#jk-toast-title').textContent = stateObj.heading || 'Exporting clip\u2026';
    toast.querySelector('#jk-toast-sub').textContent = stateObj.sub || '';
    toast.querySelector('#jk-toast-stage').textContent = stateObj.stage || '';

    const prog = toast.querySelector('#jk-export-progress');
    const pct = Math.max(0, Math.min(100, Math.round(Number(stateObj.percent) || 0)));
    prog.value = pct;
    prog.textContent = pct + '%';

    toast.querySelector('#jk-toast-metrics').textContent = stateObj.metrics || pct + '%';
    toast.querySelector('#jk-toast-cancel').hidden = !stateObj.cancellable;
    toast.querySelector('#jk-toast-share').hidden = !stateObj.showShare;
    toast.querySelector('#jk-toast-save').hidden = !stateObj.showSave;
    showPopoverCompat(toast);
  }

  async function ensureServiceWorkerReady() {
    if (!('serviceWorker' in navigator)) return null;
    if (exportQueue.swReadyPromise) return exportQueue.swReadyPromise;

    exportQueue.swReadyPromise = (async () => {
      const baseDir = resolveAssetBaseDir();
      const candidates = baseDir
        ? [
            { url: `${baseDir}/export-sw.js?v=${ASSET_VERSION}`, scope: `${baseDir}/`, prefix: baseDir },
            { url: `/export-sw.js?v=${ASSET_VERSION}`, scope: '/', prefix: '' },
          ]
        : [
            { url: `/export-sw.js?v=${ASSET_VERSION}`, scope: '/', prefix: '' },
            { url: `/jkplayer/export-sw.js?v=${ASSET_VERSION}`, scope: '/jkplayer/', prefix: '/jkplayer' },
          ];

      for (const cand of candidates) {
        try {
          const reg = await navigator.serviceWorker.register(cand.url, { scope: cand.scope });
          let sw = reg.active || reg.waiting || reg.installing;
          if (!sw) continue;
          if (sw.state !== 'activated') {
            await new Promise((resolve) => {
              const timeout = setTimeout(resolve, 2500);
              const onState = () => {
                if (sw.state === 'activated' || sw.state === 'redundant') {
                  clearTimeout(timeout);
                  sw.removeEventListener('statechange', onState);
                  resolve();
                }
              };
              sw.addEventListener('statechange', onState);
            });
          }
          if (reg.active && reg.active.state === 'activated') {
            if (typeof navigator.serviceWorker.startMessages === 'function') {
              try {
                navigator.serviceWorker.startMessages();
              } catch (_) {}
            }
            exportQueue.swStreamPrefix = cand.prefix;
            return reg.active;
          }
        } catch (_) {}
      }
      return null;
    })();

    const active = await exportQueue.swReadyPromise;
    if (!active) {
      exportQueue.swReadyPromise = null;
    }
    return active;
  }

  async function registerStreamPortWithServiceWorker(jobId, filename, dataPort) {
    const sw = await ensureServiceWorkerReady();
    if (!sw || !dataPort || typeof MessageChannel === 'undefined') {
      return false;
    }
    const ackChannel = new MessageChannel();
    const requestId = jobId + ':' + Math.random().toString(36).slice(2, 8);

    const registered = await new Promise((resolve) => {
      let done = false;
      function finishReg(val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', onMsg);
        ackChannel.port1.onmessage = null;
        try {
          ackChannel.port1.close();
        } catch (_) {}
        resolve(val);
      }

      const timer = setTimeout(() => finishReg(false), 2500);

      function onMsg(ev) {
        const d = ev.data;
        if (d && d.type === 'STREAM_REGISTERED' && d.requestId === requestId) {
          finishReg(true);
        }
      }

      ackChannel.port1.onmessage = onMsg;
      navigator.serviceWorker.addEventListener('message', onMsg);
      try {
        sw.postMessage(
          {
            type: 'REGISTER_STREAM',
            jobId,
            filename,
            requestId,
          },
          [dataPort, ackChannel.port2]
        );
      } catch (_) {
        finishReg(false);
      }
    });

    return registered;
  }

  function triggerStreamingIframeDownload(jobId, filename) {
    const frame = document.createElement('iframe');
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText =
      'width:0;height:0;border:0;position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;';
    frame.src =
      `${exportQueue.swStreamPrefix}/export-stream/` +
      encodeURIComponent(jobId) +
      '/' +
      encodeURIComponent(filename);
    document.body.appendChild(frame);
    setTimeout(() => {
      if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    }, 10 * 60 * 1000);
    return frame;
  }

  function triggerBlobFallbackDownload(blob, filename) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'jka-clip.mp4';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 120000);
  }

  function cancelIdleWorkerTeardown() {
    if (exportQueue.idleWorkerTimer) {
      clearTimeout(exportQueue.idleWorkerTimer);
      exportQueue.idleWorkerTimer = 0;
    }
  }

  function teardownExportWorkerNow() {
    cancelIdleWorkerTeardown();
    const w = exportQueue.worker;
    if (!w) return;
    exportQueue.worker = null;
    try {
      w.postMessage({ type: 'SHUTDOWN_WORKER' });
    } catch (_) {}
    setTimeout(() => {
      try {
        w.terminate();
      } catch (_) {}
    }, 120);
  }

  function scheduleIdleWorkerTeardown(delayMs = 3000) {
    cancelIdleWorkerTeardown();
    exportQueue.idleWorkerTimer = setTimeout(() => {
      exportQueue.idleWorkerTimer = 0;
      if (!exportQueue.activeJob && exportQueue.pendingJobs.length === 0 && exportQueue.worker) {
        teardownExportWorkerNow();
      }
    }, delayMs);
  }

  function ensureExportWorker() {
    cancelIdleWorkerTeardown();
    if (exportQueue.worker) return exportQueue.worker;
    const baseDir = resolveAssetBaseDir();
    const workerUrl = `${baseDir}/export-worker.js?v=${ASSET_VERSION}`;
    exportQueue.workerUrl = workerUrl;
    const worker = new Worker(workerUrl);

    worker.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      const cur = exportQueue.activeJob;
      if (!cur || (msg.jobId && msg.jobId !== cur.id)) return;

      if (msg.type === 'PIPE_OPEN') {
        cur.pipeOpened = true;
        const dataPort = ev.ports && ev.ports[0] ? ev.ports[0] : null;
        if (cur.useSwStream && dataPort) {
          registerStreamPortWithServiceWorker(cur.id, cur.filename, dataPort).then((ok) => {
            if (ok && cur.status !== 'cancelled') {
              cur.iframeEl = triggerStreamingIframeDownload(cur.id, cur.filename);
            }
          });
        }
        return;
      }

      if (msg.type === 'PROGRESS') {
        cur.lastProgress = msg;
        const s = cur.settings;
        const subText = `${cur.title} \u00B7 ${s.width}\u00D7${s.height} ${s.fps}fps`;
        let heading = 'Loading Export\u2026';
        let metrics = `${msg.percent || 0}%`;

        if (msg.phase === 'preroll') {
          heading = 'Preparing Scene\u2026';
          metrics = `Warmup ${msg.percent || 0}%`;
        } else if (msg.phase === 'rendering' || msg.phase === 'flushing') {
          heading = 'Rendering Video\u2026';
          const parts = [`${msg.percent || 0}%`];
          if (msg.bytesWritten > 0) {
            parts.push(formatBytesMB(msg.bytesWritten));
          }
          if (typeof msg.etaSeconds === 'number' && msg.etaSeconds >= 0) {
            parts.push(`ETA ~${msg.etaSeconds}s`);
          }
          metrics = parts.join(' \u00B7 ');
        }

        updateToastForJob({
          heading,
          sub: subText,
          stage: msg.label || 'Processing\u2026',
          percent: msg.percent || 0,
          metrics,
          cancellable: true,
        });
        return;
      }

      if (msg.type === 'JOB_COMPLETE') {
        const finalName = msg.filename || cur.filename || 'jka-clip.mp4';
        let shareCandidate = null;
        if (msg.fallbackBlob) {
          shareCandidate =
            msg.fallbackBlob instanceof File
              ? msg.fallbackBlob
              : new File([msg.fallbackBlob], finalName, {
                  type: 'video/mp4',
                  lastModified: Date.now(),
                });
          triggerBlobFallbackDownload(shareCandidate, finalName);
        }
        activeShareFile = shareCandidate;
        activeShareFilename = finalName;
        const canNativeShare = canShareVideoFile(shareCandidate);

        cur.status = 'complete';
        cur.bytesWritten = msg.bytesWritten || (shareCandidate ? shareCandidate.size : 0) || 0;
        cur.encodedFrames = msg.encodedFrames || 0;
        exportQueue.completedCount++;
        exportQueue.lastCompletedJob = {
          id: cur.id,
          filename: finalName,
          bytesWritten: cur.bytesWritten,
          encodedFrames: cur.encodedFrames,
          usedDiskSpool: Boolean(msg.usedDiskSpool),
          usedServiceWorkerStream: Boolean(msg.usedDiskSpool || cur.useSwStream),
        };
        exportQueue.activeJob = null;

        if (cur.iframeEl) {
          const doneFrame = cur.iframeEl;
          setTimeout(() => {
            if (doneFrame.parentNode) doneFrame.parentNode.removeChild(doneFrame);
          }, 15000);
        }

        if (exportQueue.pendingJobs.length > 0) {
          startNextQueuedJob();
        } else {
          updateToastForJob({
            heading: 'Clip Export Complete',
            sub: finalName,
            stage: `Exported ${cur.encodedFrames} frames (${formatBytesMB(cur.bytesWritten)})`,
            percent: 100,
            metrics: '100% \u00B7 Saved',
            cancellable: false,
            showShare: canNativeShare,
            showSave: Boolean(shareCandidate),
          });
          scheduleAutoDismissToast(canNativeShare ? 16000 : AUTO_DISMISS_MS);
          scheduleIdleWorkerTeardown(3000);
        }
        return;
      }

      if (msg.type === 'JOB_CANCELLED') {
        cur.status = 'cancelled';
        if (cur.iframeEl && cur.iframeEl.parentNode) {
          cur.iframeEl.parentNode.removeChild(cur.iframeEl);
        }
        exportQueue.activeJob = null;
        if (exportQueue.pendingJobs.length > 0) {
          startNextQueuedJob();
        } else {
          updateToastForJob({
            heading: 'Export Cancelled',
            sub: cur.filename,
            stage: 'Video export stopped.',
            percent: 0,
            metrics: 'Cancelled',
            cancellable: false,
          });
          scheduleAutoDismissToast(2500);
          scheduleIdleWorkerTeardown(1500);
        }
        return;
      }

      if (msg.type === 'JOB_ERROR') {
        cur.status = 'error';
        cur.error = msg.error || 'Export failed';
        exportQueue.lastError = cur.error;
        console.error('[JKVideoExport] Job failed:', cur.error);
        exportQueue.activeJob = null;
        if (exportQueue.pendingJobs.length > 0) {
          startNextQueuedJob();
        } else {
          updateToastForJob({
            heading: 'Export Error',
            sub: cur.filename,
            stage: cur.error,
            percent: 0,
            metrics: 'Failed',
            cancellable: false,
          });
          scheduleIdleWorkerTeardown(2000);
        }
      }
    });

    worker.addEventListener('error', (err) => {
      console.error('[JKVideoExport] Worker error:', err);
      const cur = exportQueue.activeJob;
      exportQueue.worker = null;
      exportQueue.activeJob = null;
      if (cur) {
        updateToastForJob({
          heading: 'Export Worker Error',
          sub: cur.filename,
          stage: (err && err.message) || 'Off-screen export worker crashed',
          percent: 0,
          metrics: 'Error',
          cancellable: false,
        });
      }
    });

    exportQueue.worker = worker;
    return worker;
  }

  function scheduleAutoDismissToast(customMs) {
    if (exportQueue.autoDismissTimer) {
      clearTimeout(exportQueue.autoDismissTimer);
    }
    exportQueue.autoDismissTimer = setTimeout(() => {
      exportQueue.autoDismissTimer = 0;
      if (!exportQueue.activeJob && exportQueue.pendingJobs.length === 0) {
        const toast = document.getElementById('jk-export-toast');
        if (toast) hidePopoverCompat(toast);
      }
    }, customMs || AUTO_DISMISS_MS);
  }

  async function startNextQueuedJob() {
    if (exportQueue.activeJob || exportQueue.pendingJobs.length === 0) return;
    if (exportQueue.autoDismissTimer) {
      clearTimeout(exportQueue.autoDismissTimer);
      exportQueue.autoDismissTimer = 0;
    }

    const job = exportQueue.pendingJobs.shift();
    job.status = 'starting';
    exportQueue.activeJob = job;

    const s = job.settings;
    updateToastForJob({
      heading: 'Loading Export\u2026',
      sub: `${job.title} \u00B7 ${s.width}\u00D7${s.height} ${s.fps}fps`,
      stage: 'Preparing download stream\u2026',
      percent: 2,
      metrics: '2%',
      cancellable: true,
    });

    const sw = await ensureServiceWorkerReady();
    if (job.cancelledBeforeStart) {
      exportQueue.activeJob = null;
      if (exportQueue.pendingJobs.length > 0) {
        startNextQueuedJob();
      }
      return;
    }

    job.useSwStream = Boolean(sw && typeof MessageChannel !== 'undefined');
    const worker = ensureExportWorker();
    const payload = {
      type: 'START_JOB',
      jobId: job.id,
      settings: job.settings,
      source: job.source,
      engineConfig: job.engineConfig,
      useServiceWorkerStream: job.useSwStream,
    };

    worker.postMessage(payload);
  }

  function enqueueExportJob(job) {
    if (!job) return null;
    exportQueue.pendingJobs.push(job);
    if (exportQueue.activeJob) {
      // Refresh queue badge immediately on toast
      const cur = exportQueue.activeJob;
      const last = cur.lastProgress || {};
      updateToastForJob({
        heading: last.phase === 'rendering' ? 'Rendering Video\u2026' : 'Loading Export\u2026',
        sub: `${cur.title} \u00B7 ${cur.settings.width}\u00D7${cur.settings.height} ${cur.settings.fps}fps`,
        stage: last.label || 'Processing\u2026',
        percent: last.percent || 5,
        metrics: `${last.percent || 5}%`,
        cancellable: true,
      });
    } else {
      startNextQueuedJob();
    }
    return job.id;
  }

  function cancelJob(jobId) {
    if (exportQueue.activeJob && (!jobId || exportQueue.activeJob.id === jobId)) {
      exportQueue.activeJob.cancelledBeforeStart = true;
      if (exportQueue.worker) {
        exportQueue.worker.postMessage({
          type: 'CANCEL_JOB',
          jobId: exportQueue.activeJob.id,
        });
      }
      return true;
    }
    const idx = exportQueue.pendingJobs.findIndex((j) => j.id === jobId);
    if (idx !== -1) {
      exportQueue.pendingJobs.splice(idx, 1);
      return true;
    }
    return false;
  }

  // Keep top-layer dialog & toast reparented across fullscreen transitions
  function onGlobalFullscreenChange() {
    const host = getTopLayerHost();
    const dlg = document.getElementById('jk-export-dialog');
    if (dlg && (dlg.hasAttribute('open') || host === document.body)) {
      reparentTopLayerElement(dlg, host);
    }
    const toast = document.getElementById('jk-export-toast');
    if (toast) {
      reparentTopLayerElement(toast, host);
    }
  }

  document.addEventListener('fullscreenchange', onGlobalFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onGlobalFullscreenChange);
  window.addEventListener('pagehide', () => {
    cancelIdleWorkerTeardown();
    if (exportQueue.worker) {
      const w = exportQueue.worker;
      exportQueue.worker = null;
      try {
        w.postMessage({ type: 'SHUTDOWN_WORKER' });
        w.terminate();
      } catch (_) {}
    }
  });

  // Esc exits Trim Mode when the modal dialog is not open
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape' || !trimState.active) return;
      const dlg = document.getElementById('jk-export-dialog');
      if (dlg && dlg.hasAttribute('open')) return;
      ev.preventDefault();
      ev.stopPropagation();
      exitTrimMode(false);
    },
    true
  );

  // Pre-register Service Worker quietly on idle so first export streams without SW install delay
  if ('serviceWorker' in navigator) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => ensureServiceWorkerReady().catch(() => {}), {
        timeout: 3000,
      });
    } else {
      setTimeout(() => ensureServiceWorkerReady().catch(() => {}), 1200);
    }
  }

  window.JKVideoExport = {
    __initialized: true,
    openForPiP: () => enterTrimMode('pip'),
    openForStandalone: () => enterTrimMode('standalone'),
    enterTrimMode,
    exitTrimMode,
    isTrimActive: () => Boolean(trimState.active),
    getTrimState: () => ({
      active: trimState.active,
      hostMode: trimState.hostMode,
      durationMs: trimState.durationMs,
      startMs: trimState.startMs,
      endMs: trimState.endMs,
      previewing: trimState.previewing,
    }),
    setTrimRange: (startMs, endMs) => {
      if (!trimState.active) return false;
      const dur = Math.max(MIN_CLIP_MS, trimState.durationMs);
      const minGap = Math.min(MIN_CLIP_MS, dur);
      trimState.startMs = Math.max(0, Math.min(dur - minGap, Math.round(Number(startMs) || 0)));
      trimState.endMs = Math.max(
        trimState.startMs + minGap,
        Math.min(dur, Math.round(Number(endMs) || trimState.startMs + minGap))
      );
      syncTrimBarUI();
      return true;
    },
    openSettingsDialog,
    setDialogOption: (group, val) => {
      if (Object.prototype.hasOwnProperty.call(dialogOptions, group)) {
        dialogOptions[group] = val;
        syncDialogUI();
        return true;
      }
      return false;
    },
    enqueueJob: enqueueExportJob,
    cancelJob,
    getQueueState: () => ({
      activeJob: exportQueue.activeJob
        ? {
            id: exportQueue.activeJob.id,
            filename: exportQueue.activeJob.filename,
            status: exportQueue.activeJob.status,
            useSwStream: exportQueue.activeJob.useSwStream,
            lastProgress: exportQueue.activeJob.lastProgress || null,
          }
        : null,
      queuedCount: exportQueue.pendingJobs.length,
      completedCount: exportQueue.completedCount,
      lastCompletedJob: exportQueue.lastCompletedJob,
      lastError: exportQueue.lastError,
    }),
  };
})();
