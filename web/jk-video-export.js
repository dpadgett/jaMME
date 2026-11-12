(function () {
  'use strict';

  if (window.JKVideoExport && window.JKVideoExport.__initialized) {
    return;
  }

  const ASSET_VERSION = '20261111f';
  const MIN_CLIP_MS = 500;
  const MIN_VIEW_SPAN_MS = 5000;
  const DEFAULT_PRE_MS = 10000;
  const DEFAULT_POST_MS = 5000;
  const FINE_STEP_MS = 100;
  const COARSE_STEP_MS = 1000;
  const FINE_DRAG_FACTOR = 0.15;
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
    viewStartMs: 0,
    viewEndMs: 5000,
    previewing: false,
    previewRaf: 0,
    playheadRaf: 0,
    edgePanRaf: 0,
    draggingHandle: null, // 'start' | 'end' | null
    shiftDown: false,
    fineOriginRawMs: null,
    fineOriginValMs: null,
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

  function formatZoomSpanLabel(spanMs, durMs) {
    if (!durMs || spanMs >= durMs - 50) return 'Full';
    const sec = Math.max(1, spanMs / 1000);
    if (sec < 60) {
      const rounded = sec < 15 ? sec.toFixed(1).replace(/\.0$/, '') : String(Math.round(sec));
      return rounded + 's';
    }
    const mins = sec / 60;
    return (mins < 10 ? mins.toFixed(1).replace(/\.0$/, '') : String(Math.round(mins))) + 'm';
  }

  function parseFlexibleTimestamp(raw, currentMs, maxDurMs) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^[+-]/.test(s)) {
      const relSec = Number(s);
      if (!Number.isFinite(relSec)) return null;
      return Math.max(0, Math.min(maxDurMs, Math.round(currentMs + relSec * 1000)));
    }
    const parts = s.split(':');
    if (parts.length === 1) {
      const sec = Number(parts[0].replace(/s$/i, ''));
      if (!Number.isFinite(sec) || sec < 0) return null;
      return Math.max(0, Math.min(maxDurMs, Math.round(sec * 1000)));
    }
    if (parts.length === 2) {
      const mins = Number(parts[0]);
      const secs = Number(parts[1]);
      if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0) return null;
      return Math.max(0, Math.min(maxDurMs, Math.round((mins * 60 + secs) * 1000)));
    }
    if (parts.length === 3) {
      const hrs = Number(parts[0]);
      const mins = Number(parts[1]);
      const secs = Number(parts[2]);
      if (
        !Number.isFinite(hrs) ||
        !Number.isFinite(mins) ||
        !Number.isFinite(secs) ||
        hrs < 0 ||
        mins < 0 ||
        secs < 0
      ) {
        return null;
      }
      return Math.max(0, Math.min(maxDurMs, Math.round((hrs * 3600 + mins * 60 + secs) * 1000)));
    }
    return null;
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
        -webkit-user-select: none;
        user-select: none;
        background: rgba(13, 17, 23, 0.94);
        color: #e6edf3;
        accent-color: #58a6ff;
        border: 1px solid #1f6feb;
        border-radius: calc(6px * var(--jk-ui-scale, 1));
        padding: calc(5px * var(--jk-ui-scale, 1)) calc(6px * var(--jk-ui-scale, 1));
        display: flex;
        flex-direction: column;
        gap: calc(4px * var(--jk-ui-scale, 1));
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

      /* Row 1: Full-Demo Overview Minimap + Zoom Controls */
      .jk-trim-overview-row {
        display: flex;
        align-items: center;
        gap: calc(6px * var(--jk-ui-scale, 1));
        inline-size: 100%;
      }
      .jk-trim-overview {
        position: relative;
        flex: 1 1 auto;
        min-inline-size: 80px;
        block-size: calc(12px * var(--jk-ui-scale, 1));
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 4px;
        overflow: hidden;
        cursor: pointer;
        touch-action: none;
      }
      .jk-trim-overview-sel {
        position: absolute;
        top: calc(2px * var(--jk-ui-scale, 1));
        bottom: calc(2px * var(--jk-ui-scale, 1));
        inset-inline-start: var(--ov-sel-start-pct, 0%);
        inline-size: max(3px, calc(var(--ov-sel-end-pct, 10%) - var(--ov-sel-start-pct, 0%)));
        background: linear-gradient(90deg, #58a6ff, #3fb950);
        border-radius: 2px;
        pointer-events: none;
        z-index: 2;
      }
      .jk-trim-overview-cur {
        position: absolute;
        inset-block: 0;
        inset-inline-start: var(--ov-cur-pct, 0%);
        inline-size: 1.5px;
        background: rgba(240, 246, 252, 0.9);
        pointer-events: none;
        z-index: 3;
      }
      .jk-trim-overview-win {
        position: absolute;
        inset-block: 0;
        inset-inline-start: var(--ov-win-start-pct, 0%);
        inline-size: max(6px, calc(var(--ov-win-end-pct, 100%) - var(--ov-win-start-pct, 0%)));
        background: rgba(121, 192, 255, 0.16);
        border-inline: 1.5px solid #79c0ff;
        box-sizing: border-box;
        cursor: grab;
        z-index: 4;
      }
      .jk-trim-overview-win:active,
      .jk-trim-overview.jk-trim-panning .jk-trim-overview-win {
        cursor: grabbing;
        background: rgba(121, 192, 255, 0.26);
      }
      .jk-trim-zoom-bar {
        display: inline-flex;
        align-items: center;
        gap: calc(2px * var(--jk-ui-scale, 1));
        flex-shrink: 0;
      }
      .jk-trim-zoom-btn {
        background: #161b22;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 3px;
        min-inline-size: calc(18px * var(--jk-ui-scale, 1));
        block-size: calc(17px * var(--jk-ui-scale, 1));
        padding: 0 calc(4px * var(--jk-ui-scale, 1));
        font-size: calc(10px * var(--jk-ui-scale, 1));
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        cursor: pointer;
      }
      .jk-trim-zoom-btn:hover:not(:disabled) {
        background: #30363d;
        color: #ffffff;
        border-color: #484f58;
      }
      .jk-trim-zoom-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .jk-trim-zoom-span-btn {
        min-inline-size: calc(40px * var(--jk-ui-scale, 1));
        color: #79c0ff;
        background: rgba(31, 111, 235, 0.14);
        border-color: rgba(88, 166, 255, 0.35);
      }

      /* Row 2: Zoomed Precision Trim Track */
      .jk-trim-track-wrap {
        position: relative;
        inline-size: 100%;
        block-size: calc(26px * var(--jk-ui-scale, 1));
        display: flex;
        align-items: center;
        padding-inline: calc(5px * var(--jk-ui-scale, 1));
        box-sizing: border-box;
        cursor: pointer;
        touch-action: none;
      }
      .jk-trim-bounds-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: calc(9.5px * var(--jk-ui-scale, 1));
        color: #8b949e;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        margin-top: calc(-2px * var(--jk-ui-scale, 1));
        pointer-events: none;
      }
      .jk-trim-fine-hint {
        color: #6e7681;
      }
      #jk-trim-bar.jk-trim-fine-active .jk-trim-fine-hint {
        color: #79c0ff;
        font-weight: 600;
      }
      .jk-trim-rail {
        position: relative;
        inline-size: 100%;
        block-size: calc(8px * var(--jk-ui-scale, 1));
        background: #21262d;
        border: 1px solid #30363d;
        border-radius: 999px;
        overflow: hidden;
        pointer-events: none;
        z-index: 1;
      }
      .jk-trim-range-fill {
        position: absolute;
        top: calc(7px * var(--jk-ui-scale, 1));
        bottom: calc(7px * var(--jk-ui-scale, 1));
        inset-inline-start: calc(5px * var(--jk-ui-scale, 1) + (100% - 10px * var(--jk-ui-scale, 1)) * var(--trim-start-frac, 0));
        inline-size: max(0px, calc((100% - 10px * var(--jk-ui-scale, 1)) * (var(--trim-end-frac, 1) - var(--trim-start-frac, 0))));
        background: linear-gradient(90deg, rgba(47, 129, 247, 0.58), rgba(63, 185, 80, 0.62));
        border-top: 1px solid rgba(121, 192, 255, 0.65);
        border-bottom: 1px solid rgba(121, 192, 255, 0.65);
        box-sizing: border-box;
        cursor: grab;
        pointer-events: auto;
        z-index: 2;
      }
      .jk-trim-range-fill:active,
      .jk-trim-range-fill.jk-trim-sliding {
        cursor: grabbing;
        background: linear-gradient(90deg, rgba(88, 166, 255, 0.72), rgba(63, 185, 80, 0.76));
      }
      .jk-trim-playhead {
        position: absolute;
        top: calc(2px * var(--jk-ui-scale, 1));
        bottom: calc(2px * var(--jk-ui-scale, 1));
        inset-inline-start: calc(5px * var(--jk-ui-scale, 1) + (100% - 10px * var(--jk-ui-scale, 1)) * var(--trim-cur-frac, 0));
        inline-size: 2px;
        background: #f0f6fc;
        box-shadow: 0 0 4px rgba(240, 246, 252, 0.95);
        transform: translateX(-1px);
        pointer-events: none;
        z-index: 3;
      }
      .jk-trim-playhead.jk-trim-cur-offscreen {
        opacity: 0;
      }
      input[type="range"].jk-trim-range {
        --slider-track-size: calc(8px * var(--jk-ui-scale, 1));
        --slider-thumb-size: calc(20px * var(--jk-ui-scale, 1));
        --slider-track-radius: 999px;
        --slider-thumb-radius: 5px 2px 2px 5px;
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
        --slider-thumb-radius: 2px 5px 5px 2px;
      }
      input[type="range"].jk-trim-range.jk-trim-offscreen {
        opacity: 0;
      }
      input[type="range"].jk-trim-range.jk-trim-offscreen::-webkit-slider-thumb {
        pointer-events: none;
      }
      input[type="range"].jk-trim-range.jk-trim-offscreen::-moz-range-thumb {
        pointer-events: none;
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
        inline-size: calc(11px * var(--jk-ui-scale, 1));
        block-size: calc(20px * var(--jk-ui-scale, 1));
        margin-block-start: calc((var(--slider-track-size) - 20px * var(--jk-ui-scale, 1)) / 2);
        border: 1.5px solid #f0f6fc;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
      }
      input[type="range"].jk-trim-range#jk-trim-start::-webkit-slider-thumb {
        transform: translateX(calc(-3px * var(--jk-ui-scale, 1)));
      }
      input[type="range"].jk-trim-range#jk-trim-end::-webkit-slider-thumb {
        transform: translateX(calc(3px * var(--jk-ui-scale, 1)));
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
        inline-size: calc(11px * var(--jk-ui-scale, 1));
        block-size: calc(20px * var(--jk-ui-scale, 1));
        border: 1.5px solid #f0f6fc;
        border-radius: var(--slider-thumb-radius);
        background: var(--slider-thumb-color);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
      }
      input[type="range"].jk-trim-range#jk-trim-start::-moz-range-thumb {
        transform: translateX(calc(-3px * var(--jk-ui-scale, 1)));
      }
      input[type="range"].jk-trim-range#jk-trim-end::-moz-range-thumb {
        transform: translateX(calc(3px * var(--jk-ui-scale, 1)));
      }
      input[type="range"].jk-trim-range:focus,
      input[type="range"].jk-trim-range:focus-visible {
        outline: none;
      }
      input[type="range"].jk-trim-range:focus-visible::-webkit-slider-thumb {
        outline: 2px solid #f0f6fc;
        outline-offset: 2px;
        box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.55);
      }
      input[type="range"].jk-trim-range:focus-visible::-moz-range-thumb {
        outline: 2px solid #f0f6fc;
        outline-offset: 2px;
        box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.55);
      }

      /* Row 3: Start/End Fine-Step Boxes, Editable Timestamps & Actions */
      .jk-trim-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: calc(3px * var(--jk-ui-scale, 1));
      }
      .jk-trim-times {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: calc(3px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
        font-variant-numeric: tabular-nums;
      }
      .jk-trim-edge-box {
        display: inline-flex;
        align-items: center;
        gap: calc(1.5px * var(--jk-ui-scale, 1));
        background: #161b22;
        border: 1px solid #30363d;
        border-inline-start: 2.5px solid #58a6ff;
        border-radius: 4px;
        padding: calc(1px * var(--jk-ui-scale, 1)) calc(2.5px * var(--jk-ui-scale, 1));
      }
      .jk-trim-edge-box.jk-trim-edge-end {
        border-inline-start-color: #3fb950;
      }
      .jk-trim-edge-box:focus-within {
        border-color: #58a6ff;
      }
      .jk-trim-edge-box.jk-trim-edge-end:focus-within {
        border-color: #3fb950;
      }
      .jk-trim-val-input {
        -webkit-user-select: text;
        user-select: text;
        background: #0d1117;
        color: #f0f6fc;
        border: 1px solid transparent;
        border-radius: 3px;
        font: inherit;
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        inline-size: calc(41px * var(--jk-ui-scale, 1));
        min-block-size: calc(18px * var(--jk-ui-scale, 1));
        padding: 0 calc(1px * var(--jk-ui-scale, 1));
        text-align: center;
        box-sizing: border-box;
      }
      .jk-trim-val-input:hover {
        border-color: #30363d;
      }
      .jk-trim-val-input:focus-visible {
        outline: 2px solid #58a6ff;
        outline-offset: 0;
        background: #010409;
      }
      .jk-trim-val-input[aria-invalid="true"] {
        border-color: #f85149;
        outline-color: #f85149;
      }
      @media (pointer: coarse) {
        .jk-trim-val-input {
          font-size: 16px;
          inline-size: 62px;
        }
      }
      .jk-trim-step-btn,
      .jk-trim-mark-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 3px;
        min-inline-size: calc(16px * var(--jk-ui-scale, 1));
        min-block-size: calc(18px * var(--jk-ui-scale, 1));
        padding: 0 calc(2.5px * var(--jk-ui-scale, 1));
        font-size: calc(9.5px * var(--jk-ui-scale, 1));
        font-variant-numeric: tabular-nums;
        line-height: 1;
        cursor: pointer;
        touch-action: manipulation;
      }
      .jk-trim-mark-btn {
        color: #79c0ff;
        font-weight: 600;
      }
      .jk-trim-edge-end .jk-trim-mark-btn {
        color: #7ee787;
      }
      .jk-trim-step-btn:hover,
      .jk-trim-mark-btn:hover {
        background: #30363d;
        color: #ffffff;
      }
      .jk-trim-dur-pill {
        background: rgba(47, 129, 247, 0.16);
        color: #79c0ff;
        border: 1px solid rgba(88, 166, 255, 0.4);
        border-radius: 999px;
        padding: calc(1px * var(--jk-ui-scale, 1)) calc(5px * var(--jk-ui-scale, 1));
        font-size: calc(10px * var(--jk-ui-scale, 1));
        font-weight: 600;
      }
      .jk-trim-actions {
        display: inline-flex;
        align-items: center;
        gap: calc(3px * var(--jk-ui-scale, 1));
        margin-inline-start: auto;
      }
      .jk-trim-btn {
        background: #21262d;
        color: #c9d1d9;
        border: 1px solid #30363d;
        border-radius: 4px;
        min-block-size: calc(20px * var(--jk-ui-scale, 1));
        padding: calc(1.5px * var(--jk-ui-scale, 1)) calc(5.5px * var(--jk-ui-scale, 1));
        font-size: calc(10.5px * var(--jk-ui-scale, 1));
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
      #jk-pip-card.jk-pip-xs .jk-trim-step-coarse {
        display: none;
      }
      @container jk-card (max-width: 480px) {
        .jk-trim-step-coarse {
          display: none;
        }
      }
      @container jk-card (max-width: 340px) {
        .jk-trim-step-btn,
        .jk-trim-fine-hint {
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
      .jk-trim-mark-btn:focus-visible,
      .jk-trim-zoom-btn:focus-visible,
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

  function getMinViewSpanMs() {
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || MIN_VIEW_SPAN_MS);
    return Math.min(MIN_VIEW_SPAN_MS, dur);
  }

  function setTrimViewport(nextStartMs, nextEndMs) {
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const minSpan = getMinViewSpanMs();
    let span = Math.round(Number(nextEndMs) - Number(nextStartMs));
    if (!Number.isFinite(span) || span <= 0) span = dur;
    span = Math.max(minSpan, Math.min(dur, span));
    let vStart = Math.round(Number(nextStartMs) || 0);
    vStart = Math.max(0, Math.min(dur - span, vStart));
    trimState.viewStartMs = vStart;
    trimState.viewEndMs = vStart + span;
    syncTrimBarUI();
  }

  function zoomTrimBy(factor, anchorFrac = 0.5) {
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const curSpan = Math.max(getMinViewSpanMs(), trimState.viewEndMs - trimState.viewStartMs || dur);
    const frac = Math.max(0, Math.min(1, Number.isFinite(anchorFrac) ? anchorFrac : 0.5));
    const anchorMs = trimState.viewStartMs + curSpan * frac;
    const nextSpan = Math.max(getMinViewSpanMs(), Math.min(dur, Math.round(curSpan * factor)));
    const nextStart = Math.round(anchorMs - nextSpan * frac);
    setTrimViewport(nextStart, nextStart + nextSpan);
  }

  function fitTrimToSelection(toggleFull = false) {
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const clipSpan = Math.max(MIN_CLIP_MS, trimState.endMs - trimState.startMs);
    const targetSpan = Math.max(getMinViewSpanMs(), Math.min(dur, Math.max(10000, Math.round(clipSpan * 3))));
    const center = (trimState.startMs + trimState.endMs) * 0.5;
    const fittedStart = Math.max(0, Math.min(dur - targetSpan, Math.round(center - targetSpan * 0.5)));
    const curSpan = trimState.viewEndMs - trimState.viewStartMs;
    if (
      toggleFull &&
      dur > targetSpan + 250 &&
      Math.abs(curSpan - targetSpan) <= Math.max(500, targetSpan * 0.08) &&
      Math.abs(trimState.viewStartMs - fittedStart) <= Math.max(500, targetSpan * 0.08)
    ) {
      setTrimViewport(0, dur);
      return;
    }
    setTrimViewport(fittedStart, fittedStart + targetSpan);
  }

  function ensureMsVisibleInView(targetMs) {
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const span = Math.max(getMinViewSpanMs(), trimState.viewEndMs - trimState.viewStartMs || dur);
    if (span >= dur) return;
    const pad = Math.round(span * 0.08);
    if (targetMs < trimState.viewStartMs) {
      const nextStart = Math.max(0, Math.min(dur - span, Math.round(targetMs - pad)));
      trimState.viewStartMs = nextStart;
      trimState.viewEndMs = nextStart + span;
    } else if (targetMs > trimState.viewEndMs) {
      const nextEnd = Math.min(dur, Math.max(span, Math.round(targetMs + pad)));
      trimState.viewEndMs = nextEnd;
      trimState.viewStartMs = nextEnd - span;
    }
  }

  function nudgeTrimHandle(which, deltaMs, seekMode = 'normal') {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) return;
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const minGap = Math.min(MIN_CLIP_MS, dur);
    stopTrimPreview(true);
    let nextTargetMs = 0;
    if (which === 'start') {
      trimState.activeHandle = 'start';
      trimState.startMs = Math.max(0, Math.min(trimState.endMs - minGap, trimState.startMs + deltaMs));
      ensureMsVisibleInView(trimState.startMs);
      syncTrimBarUI();
      nextTargetMs = trimState.startMs;
    } else {
      trimState.activeHandle = 'end';
      trimState.endMs = Math.min(dur, Math.max(trimState.startMs + minGap, trimState.endMs + deltaMs));
      ensureMsVisibleInView(trimState.endMs);
      syncTrimBarUI();
      nextTargetMs = trimState.endMs;
    }
    if (seekMode === 'skip') return;
    if (seekMode === 'hold') {
      throttledLiveSeek(nextTargetMs, 320, true);
    } else {
      throttledLiveSeek(nextTargetMs, 65, false);
    }
  }

  function markTrimEdgeAtPlayhead(which) {
    const player = getPlayer();
    if (!player || typeof player.getCurrentTimeMs !== 'function') return;
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const minGap = Math.min(MIN_CLIP_MS, dur);
    const cur = Math.max(0, Math.min(dur, Math.round(player.getCurrentTimeMs())));
    stopTrimPreview(false);
    if (which === 'start') {
      trimState.activeHandle = 'start';
      if (cur > trimState.endMs - minGap) {
        trimState.endMs = Math.min(dur, cur + Math.max(minGap, 5000));
      }
      trimState.startMs = Math.max(0, Math.min(trimState.endMs - minGap, cur));
      ensureMsVisibleInView(trimState.startMs);
    } else {
      trimState.activeHandle = 'end';
      if (cur < trimState.startMs + minGap) {
        trimState.startMs = Math.max(0, cur - Math.max(minGap, 5000));
      }
      trimState.endMs = Math.min(dur, Math.max(trimState.startMs + minGap, cur));
      ensureMsVisibleInView(trimState.endMs);
    }
    syncTrimBarUI();
  }

  function stopEdgeAutoPan() {
    if (trimState.edgePanRaf) {
      cancelAnimationFrame(trimState.edgePanRaf);
      trimState.edgePanRaf = 0;
    }
  }

  function startTrimPlayheadTicker() {
    if (trimState.playheadRaf) return;
    const loop = () => {
      if (!trimState.active) {
        trimState.playheadRaf = 0;
        return;
      }
      syncTrimPlayheadOnly();
      trimState.playheadRaf = requestAnimationFrame(loop);
    };
    trimState.playheadRaf = requestAnimationFrame(loop);
  }

  function stopTrimPlayheadTicker() {
    if (trimState.playheadRaf) {
      cancelAnimationFrame(trimState.playheadRaf);
      trimState.playheadRaf = 0;
    }
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
        <div class="jk-trim-overview-row">
          <div id="jk-trim-overview" class="jk-trim-overview" title="Full demo overview — click or drag to pan zoomed region, double-click to toggle Fit / Full">
            <div class="jk-trim-overview-sel"></div>
            <div class="jk-trim-overview-cur"></div>
            <div id="jk-trim-overview-win" class="jk-trim-overview-win"></div>
          </div>
          <div class="jk-trim-zoom-bar" role="group" aria-label="Timeline zoom">
            <button type="button" id="jk-trim-zoom-out" class="jk-trim-zoom-btn" title="Zoom out timeline (-)" aria-label="Zoom out timeline">\u2212</button>
            <button type="button" id="jk-trim-zoom-fit" class="jk-trim-zoom-btn jk-trim-zoom-span-btn" title="Frame clip in scrubber / toggle Full view (F)" aria-label="Toggle fit clip or full timeline">45s</button>
            <button type="button" id="jk-trim-zoom-in" class="jk-trim-zoom-btn" title="Zoom in timeline (+)" aria-label="Zoom in timeline">+</button>
          </div>
        </div>
        <div id="jk-trim-track-wrap" class="jk-trim-track-wrap" title="Scroll wheel to zoom · Drag clip bar to slide window · Hold Shift for fine precision">
          <div class="jk-trim-rail"></div>
          <div id="jk-trim-range-fill" class="jk-trim-range-fill" title="Drag to slide clip window (keep duration) · Click to seek playhead"></div>
          <div id="jk-trim-playhead" class="jk-trim-playhead"></div>
          <input type="range" id="jk-trim-start" class="jk-trim-range" min="0" max="1000" step="10" value="0" aria-label="Clip start time" />
          <input type="range" id="jk-trim-end" class="jk-trim-range jk-trim-top" min="0" max="1000" step="10" value="1000" aria-label="Clip end time" />
        </div>
        <div class="jk-trim-bounds-row" aria-hidden="true">
          <span id="jk-trim-view-start">0:00.0</span>
          <span class="jk-trim-fine-hint">Wheel: zoom \u00B7 Shift+drag: fine \u00B7 [ / ]: mark playhead</span>
          <span id="jk-trim-view-end">0:00.0</span>
        </div>
        <div class="jk-trim-row">
          <div class="jk-trim-times">
            <span class="jk-trim-edge-box" title="Clip Start — click time to type mm:ss.t, scroll or Up/Down to step">
              <button type="button" class="jk-trim-mark-btn" data-trim-mark="start" title="Set Start to current playhead ( [ )" aria-label="Set clip start to current playhead">[\u21A6</button>
              <button type="button" class="jk-trim-step-btn jk-trim-step-coarse" data-trim-step="start:-1000" title="Nudge Start -1.0s (hold to repeat)" aria-label="Nudge start -1 second">-1</button>
              <button type="button" class="jk-trim-step-btn" data-trim-step="start:-100" title="Nudge Start -0.1s (hold to repeat)" aria-label="Nudge start -0.1 seconds">-.1</button>
              <input type="text" id="jk-trim-start-text" class="jk-trim-val-input" value="0:00.0" aria-label="Clip start timestamp" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" />
              <button type="button" class="jk-trim-step-btn" data-trim-step="start:100" title="Nudge Start +0.1s (hold to repeat)" aria-label="Nudge start +0.1 seconds">+.1</button>
              <button type="button" class="jk-trim-step-btn jk-trim-step-coarse" data-trim-step="start:1000" title="Nudge Start +1.0s (hold to repeat)" aria-label="Nudge start +1 second">+1</button>
            </span>
            <span id="jk-trim-duration" class="jk-trim-dur-pill" title="Selected clip duration — click to frame clip in scrubber" style="cursor:pointer;">5.0s</span>
            <span class="jk-trim-edge-box jk-trim-edge-end" title="Clip End — click time to type mm:ss.t, scroll or Up/Down to step">
              <button type="button" class="jk-trim-step-btn jk-trim-step-coarse" data-trim-step="end:-1000" title="Nudge End -1.0s (hold to repeat)" aria-label="Nudge end -1 second">-1</button>
              <button type="button" class="jk-trim-step-btn" data-trim-step="end:-100" title="Nudge End -0.1s (hold to repeat)" aria-label="Nudge end -0.1 seconds">-.1</button>
              <input type="text" id="jk-trim-end-text" class="jk-trim-val-input" value="0:05.0" aria-label="Clip end timestamp" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" />
              <button type="button" class="jk-trim-step-btn" data-trim-step="end:100" title="Nudge End +0.1s (hold to repeat)" aria-label="Nudge end +0.1 seconds">+.1</button>
              <button type="button" class="jk-trim-step-btn jk-trim-step-coarse" data-trim-step="end:1000" title="Nudge End +1.0s (hold to repeat)" aria-label="Nudge end +1 second">+1</button>
              <button type="button" class="jk-trim-mark-btn" data-trim-mark="end" title="Set End to current playhead ( ] )" aria-label="Set clip end to current playhead">\u21A4]</button>
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
      const overviewEl = bar.querySelector('#jk-trim-overview');
      const trackWrap = bar.querySelector('#jk-trim-track-wrap');
      const rangeFill = bar.querySelector('#jk-trim-range-fill');
      const startTextInput = bar.querySelector('#jk-trim-start-text');
      const endTextInput = bar.querySelector('#jk-trim-end-text');

      let handleDrag = null;
      let fillDrag = null;
      let trackScrub = null;
      let ovDrag = null;

      const clearAccidentalSelection = () => {
        const ae = document.activeElement;
        if (ae === startTextInput || ae === endTextInput) {
          try {
            ae.blur();
          } catch (_) {}
        }
        try {
          const sel = window.getSelection && window.getSelection();
          if (sel && sel.rangeCount > 0) {
            sel.removeAllRanges();
          }
        } catch (_) {}
      };

      bar.addEventListener('selectstart', (ev) => {
        const t = ev.target;
        if (t === startTextInput || t === endTextInput) return;
        ev.preventDefault();
      });
      bar.addEventListener('mousedown', (ev) => {
        const t = ev.target;
        if (t === startTextInput || t === endTextInput) return;
        if (ev.shiftKey) {
          ev.preventDefault();
          clearAccidentalSelection();
        }
      });

      const isAnyScrubActive = () =>
        Boolean(handleDrag || (fillDrag && fillDrag.slid) || trackScrub || ovDrag);

      const syncFineActiveUI = () => {
        bar.classList.toggle('jk-trim-fine-active', Boolean(trimState.shiftDown && isAnyScrubActive()));
      };

      const maybeStartEdgeAutoPan = () => {
        if (!handleDrag || !trimState.draggingHandle) {
          stopEdgeAutoPan();
          return;
        }
        if (trimState.edgePanRaf) return;
        let lastTs = performance.now();
        const stepEdge = (now) => {
          if (!trimState.active || !handleDrag || !trimState.draggingHandle) {
            trimState.edgePanRaf = 0;
            return;
          }
          const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
          const span = trimState.viewEndMs - trimState.viewStartMs;
          if (span <= 0 || span >= dur) {
            trimState.edgePanRaf = 0;
            return;
          }
          const rect = trackWrap.getBoundingClientRect();
          const dt = Math.min(0.08, Math.max(0.004, (now - lastTs) / 1000));
          lastTs = now;
          const curVal =
            trimState.draggingHandle === 'start' ? trimState.startMs : trimState.endMs;
          const edgeZone = span * 0.035;
          const gear = trimState.shiftDown ? FINE_DRAG_FACTOR : 1.0;
          let panDelta = 0;
          if (
            curVal <= trimState.viewStartMs + edgeZone &&
            trimState.viewStartMs > 0 &&
            handleDrag.lastX <= rect.left + 28
          ) {
            panDelta = -Math.max(2, Math.round(span * 0.35 * gear * dt));
          } else if (
            curVal >= trimState.viewEndMs - edgeZone &&
            trimState.viewEndMs < dur &&
            handleDrag.lastX >= rect.right - 28
          ) {
            panDelta = Math.max(2, Math.round(span * 0.35 * gear * dt));
          }
          if (panDelta === 0) {
            trimState.edgePanRaf = 0;
            return;
          }
          const nextVStart = Math.max(0, Math.min(dur - span, trimState.viewStartMs + panDelta));
          const actualDelta = nextVStart - trimState.viewStartMs;
          if (actualDelta !== 0) {
            trimState.viewStartMs = nextVStart;
            trimState.viewEndMs = nextVStart + span;
            const minGap = Math.min(MIN_CLIP_MS, dur);
            if (trimState.draggingHandle === 'start') {
              handleDrag.accumMs = Math.max(
                0,
                Math.min(trimState.endMs - minGap, handleDrag.accumMs + actualDelta)
              );
              trimState.startMs = Math.round(handleDrag.accumMs);
              throttledLiveSeek(trimState.startMs);
            } else {
              handleDrag.accumMs = Math.min(
                dur,
                Math.max(trimState.startMs + minGap, handleDrag.accumMs + actualDelta)
              );
              trimState.endMs = Math.round(handleDrag.accumMs);
              throttledLiveSeek(trimState.endMs);
            }
            syncTrimBarUI();
          }
          trimState.edgePanRaf = requestAnimationFrame(stepEdge);
        };
        trimState.edgePanRaf = requestAnimationFrame(stepEdge);
      };

      const onAssistiveRangeInput = (which, inputEl) => {
        if (handleDrag || trimState.draggingHandle) {
          syncTrimBarUI();
          return;
        }
        if (inputEl.classList.contains('jk-trim-offscreen')) return;
        const rawMs = parseFloat(inputEl.value) || 0;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const minGap = Math.min(MIN_CLIP_MS, dur);
        stopTrimPreview(true);
        if (which === 'start') {
          trimState.activeHandle = 'start';
          trimState.startMs = Math.max(0, Math.min(trimState.endMs - minGap, Math.round(rawMs)));
          syncTrimBarUI();
          throttledLiveSeek(trimState.startMs);
        } else {
          trimState.activeHandle = 'end';
          trimState.endMs = Math.min(dur, Math.max(trimState.startMs + minGap, Math.round(rawMs)));
          syncTrimBarUI();
          throttledLiveSeek(trimState.endMs);
        }
      };

      const startHandlePointerDrag = (which, ev) => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        ev.preventDefault();
        ev.stopPropagation();
        clearAccidentalSelection();
        trimState.activeHandle = which;
        trimState.draggingHandle = which;
        trimState.shiftDown = Boolean(ev.shiftKey);
        handleDrag = {
          which,
          pointerId: ev.pointerId,
          lastX: ev.clientX,
          accumMs: which === 'start' ? trimState.startMs : trimState.endMs,
        };
        syncFineActiveUI();
        syncTrimHandleStacking();
        try {
          trackWrap.setPointerCapture(ev.pointerId);
        } catch (_) {}
      };

      const onHandlePointerMove = (ev) => {
        if (!handleDrag || ev.pointerId !== handleDrag.pointerId) return;
        const stepDx = ev.clientX - handleDrag.lastX;
        handleDrag.lastX = ev.clientX;
        trimState.shiftDown = Boolean(ev.shiftKey);
        syncFineActiveUI();
        if (stepDx === 0) {
          maybeStartEdgeAutoPan();
          return;
        }
        const rect = trackWrap.getBoundingClientRect();
        const usable = Math.max(1, rect.width - 11);
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        const gear = trimState.shiftDown ? FINE_DRAG_FACTOR : 1.0;
        const deltaMs = (stepDx / usable) * span * gear;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const minGap = Math.min(MIN_CLIP_MS, dur);
        stopTrimPreview(true);
        if (handleDrag.which === 'start') {
          const maxStart = trimState.endMs - minGap;
          handleDrag.accumMs = Math.max(0, Math.min(maxStart, handleDrag.accumMs + deltaMs));
          trimState.startMs = Math.round(handleDrag.accumMs);
          syncTrimBarUI();
          throttledLiveSeek(trimState.startMs);
        } else {
          const minEnd = trimState.startMs + minGap;
          handleDrag.accumMs = Math.max(minEnd, Math.min(dur, handleDrag.accumMs + deltaMs));
          trimState.endMs = Math.round(handleDrag.accumMs);
          syncTrimBarUI();
          throttledLiveSeek(trimState.endMs);
        }
        maybeStartEdgeAutoPan();
      };

      const endHandlePointerDrag = (ev) => {
        if (!handleDrag || (ev && ev.pointerId !== undefined && ev.pointerId !== handleDrag.pointerId)) {
          return;
        }
        const pid = handleDrag.pointerId;
        handleDrag = null;
        trimState.draggingHandle = null;
        trimState.fineOriginRawMs = null;
        trimState.fineOriginValMs = null;
        stopEdgeAutoPan();
        syncFineActiveUI();
        try {
          trackWrap.releasePointerCapture(pid);
        } catch (_) {}
      };

      const bindRangeHandleEvents = (inputEl, which) => {
        inputEl.addEventListener('pointerdown', (ev) => startHandlePointerDrag(which, ev));
        inputEl.addEventListener('focus', () => {
          trimState.activeHandle = which;
          const curVal = which === 'start' ? trimState.startMs : trimState.endMs;
          ensureMsVisibleInView(curVal);
          syncTrimBarUI();
        });
        inputEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            nudgeTrimHandle(which, ev.shiftKey ? -COARSE_STEP_MS : -FINE_STEP_MS);
          } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            nudgeTrimHandle(which, ev.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS);
          } else if (ev.key === 'PageDown') {
            ev.preventDefault();
            nudgeTrimHandle(which, -5000);
          } else if (ev.key === 'PageUp') {
            ev.preventDefault();
            nudgeTrimHandle(which, 5000);
          }
        });
      };

      bindRangeHandleEvents(startInput, 'start');
      bindRangeHandleEvents(endInput, 'end');
      startInput.addEventListener('input', () => onAssistiveRangeInput('start', startInput));
      startInput.addEventListener('change', () => onAssistiveRangeInput('start', startInput));
      endInput.addEventListener('input', () => onAssistiveRangeInput('end', endInput));
      endInput.addEventListener('change', () => onAssistiveRangeInput('end', endInput));
      window.addEventListener('pointermove', onHandlePointerMove);
      window.addEventListener('pointerup', endHandlePointerDrag);
      window.addEventListener('pointercancel', endHandlePointerDrag);

      const syncShiftGearMidDrag = (isDown) => {
        if (!trimState.active || trimState.shiftDown === isDown) return;
        trimState.shiftDown = isDown;
        syncFineActiveUI();
      };
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Shift') syncShiftGearMidDrag(true);
      });
      window.addEventListener('keyup', (ev) => {
        if (ev.key === 'Shift') syncShiftGearMidDrag(false);
      });

      // Zoom buttons + Duration pill Fit shortcut
      bar.querySelector('#jk-trim-zoom-in').addEventListener('click', () => {
        const center = (trimState.startMs + trimState.endMs) * 0.5;
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        const anchorFrac =
          center >= trimState.viewStartMs && center <= trimState.viewEndMs
            ? (center - trimState.viewStartMs) / span
            : 0.5;
        zoomTrimBy(0.5, anchorFrac);
      });
      bar.querySelector('#jk-trim-zoom-out').addEventListener('click', () => {
        const center = (trimState.startMs + trimState.endMs) * 0.5;
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        const anchorFrac =
          center >= trimState.viewStartMs && center <= trimState.viewEndMs
            ? (center - trimState.viewStartMs) / span
            : 0.5;
        zoomTrimBy(2.0, anchorFrac);
      });
      bar.querySelector('#jk-trim-zoom-fit').addEventListener('click', () => {
        fitTrimToSelection(true);
      });
      bar.querySelector('#jk-trim-duration').addEventListener('click', () => {
        fitTrimToSelection(false);
      });

      // Wheel zoom & pan on both main track and overview minimap
      const onTimelineWheel = (ev, isOverview) => {
        if (!trimState.active) return;
        ev.preventDefault();
        const rect = (isOverview ? overviewEl : trackWrap).getBoundingClientRect();
        const relX = rect.width > 0 ? Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) : 0.5;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const span = Math.max(getMinViewSpanMs(), trimState.viewEndMs - trimState.viewStartMs || dur);

        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.altKey) {
          const rawDelta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
          const panMs = Math.round((rawDelta / Math.max(120, rect.width)) * span);
          setTrimViewport(trimState.viewStartMs + panMs, trimState.viewEndMs + panMs);
          return;
        }

        if (ev.deltaY === 0) return;
        const factor = ev.deltaY < 0 ? 0.78 : 1.28;
        if (isOverview) {
          const targetMs = relX * dur;
          const nextSpan = Math.max(getMinViewSpanMs(), Math.min(dur, Math.round(span * factor)));
          const nextStart = Math.round(targetMs - nextSpan * 0.5);
          setTrimViewport(nextStart, nextStart + nextSpan);
        } else {
          zoomTrimBy(factor, relX);
        }
      };
      trackWrap.addEventListener('wheel', (ev) => onTimelineWheel(ev, false), { passive: false });
      overviewEl.addEventListener('wheel', (ev) => onTimelineWheel(ev, true), { passive: false });

      // Overview minimap click & drag to pan zoomed viewport across full demo
      overviewEl.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        ev.preventDefault();
        clearAccidentalSelection();
        const rect = overviewEl.getBoundingClientRect();
        if (rect.width <= 0) return;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const span = Math.max(getMinViewSpanMs(), trimState.viewEndMs - trimState.viewStartMs || dur);
        const clickMs = Math.max(0, Math.min(dur, ((ev.clientX - rect.left) / rect.width) * dur));
        const inWin = clickMs >= trimState.viewStartMs && clickMs <= trimState.viewEndMs;
        if (!inWin) {
          const centeredStart = Math.round(clickMs - span * 0.5);
          setTrimViewport(centeredStart, centeredStart + span);
        }
        trimState.shiftDown = Boolean(ev.shiftKey);
        ovDrag = {
          pointerId: ev.pointerId,
          lastX: ev.clientX,
          accumViewStartMs: trimState.viewStartMs,
        };
        overviewEl.classList.add('jk-trim-panning');
        syncFineActiveUI();
        try {
          overviewEl.setPointerCapture(ev.pointerId);
        } catch (_) {}
      });
      overviewEl.addEventListener('pointermove', (ev) => {
        if (!ovDrag || ev.pointerId !== ovDrag.pointerId) return;
        const rect = overviewEl.getBoundingClientRect();
        if (rect.width <= 0) return;
        const stepDx = ev.clientX - ovDrag.lastX;
        ovDrag.lastX = ev.clientX;
        trimState.shiftDown = Boolean(ev.shiftKey);
        syncFineActiveUI();
        if (stepDx === 0) return;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const span = Math.max(getMinViewSpanMs(), trimState.viewEndMs - trimState.viewStartMs || dur);
        const gear = trimState.shiftDown ? FINE_DRAG_FACTOR : 1.0;
        ovDrag.accumViewStartMs = Math.max(
          0,
          Math.min(dur - span, ovDrag.accumViewStartMs + (stepDx / rect.width) * dur * gear)
        );
        const nextStart = Math.round(ovDrag.accumViewStartMs);
        setTrimViewport(nextStart, nextStart + span);
      });
      const endOvDrag = (ev) => {
        if (!ovDrag || (ev && ev.pointerId !== ovDrag.pointerId)) return;
        try {
          overviewEl.releasePointerCapture(ovDrag.pointerId);
        } catch (_) {}
        overviewEl.classList.remove('jk-trim-panning');
        ovDrag = null;
        syncFineActiveUI();
      };
      overviewEl.addEventListener('pointerup', endOvDrag);
      overviewEl.addEventListener('pointercancel', endOvDrag);
      overviewEl.addEventListener('dblclick', () => {
        fitTrimToSelection(true);
      });

      // Drag highlighted clip fill to slide [startMs, endMs] at fixed duration; click (<4px) scrubs playhead
      const clientXToViewMs = (clientX) => {
        const rect = trackWrap.getBoundingClientRect();
        const pad = 5;
        const usable = Math.max(1, rect.width - pad * 2);
        const frac = Math.max(0, Math.min(1, (clientX - (rect.left + pad)) / usable));
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        return Math.round(trimState.viewStartMs + frac * span);
      };

      rangeFill.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        ev.stopPropagation();
        ev.preventDefault();
        clearAccidentalSelection();
        trimState.shiftDown = Boolean(ev.shiftKey);
        fillDrag = {
          pointerId: ev.pointerId,
          startX: ev.clientX,
          lastX: ev.clientX,
          origStartMs: trimState.startMs,
          clipLen: Math.max(MIN_CLIP_MS, trimState.endMs - trimState.startMs),
          accumMs: 0,
          slid: false,
        };
        try {
          rangeFill.setPointerCapture(ev.pointerId);
        } catch (_) {}
      });
      rangeFill.addEventListener('pointermove', (ev) => {
        if (!fillDrag || ev.pointerId !== fillDrag.pointerId) return;
        const totalDx = ev.clientX - fillDrag.startX;
        if (!fillDrag.slid && Math.abs(totalDx) < 4) return;
        if (!fillDrag.slid) {
          fillDrag.slid = true;
          rangeFill.classList.add('jk-trim-sliding');
          stopTrimPreview(true);
        }
        const rect = trackWrap.getBoundingClientRect();
        const usable = Math.max(1, rect.width - 10);
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        const stepDx = ev.clientX - fillDrag.lastX;
        fillDrag.lastX = ev.clientX;
        trimState.shiftDown = Boolean(ev.shiftKey);
        syncFineActiveUI();
        const gear = trimState.shiftDown ? FINE_DRAG_FACTOR : 1.0;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        const minAccum = -fillDrag.origStartMs;
        const maxAccum = dur - fillDrag.clipLen - fillDrag.origStartMs;
        fillDrag.accumMs = Math.max(
          minAccum,
          Math.min(maxAccum, fillDrag.accumMs + (stepDx / usable) * span * gear)
        );
        const nextStart = Math.max(
          0,
          Math.min(dur - fillDrag.clipLen, Math.round(fillDrag.origStartMs + fillDrag.accumMs))
        );
        trimState.startMs = nextStart;
        trimState.endMs = nextStart + fillDrag.clipLen;
        syncTrimBarUI();
        throttledLiveSeek(trimState.startMs);
      });
      const endFillDrag = (ev) => {
        if (!fillDrag || (ev && ev.pointerId !== fillDrag.pointerId)) return;
        const wasSlide = fillDrag.slid;
        const upX = ev ? ev.clientX : fillDrag.startX;
        try {
          rangeFill.releasePointerCapture(fillDrag.pointerId);
        } catch (_) {}
        rangeFill.classList.remove('jk-trim-sliding');
        fillDrag = null;
        syncFineActiveUI();
        if (!wasSlide) {
          stopTrimPreview(false);
          throttledLiveSeek(clientXToViewMs(upX));
        }
      };
      rangeFill.addEventListener('pointerup', endFillDrag);
      rangeFill.addEventListener('pointercancel', endFillDrag);

      const findNearbyHandleAtClientX = (clientX, maxDistPx) => {
        const rect = trackWrap.getBoundingClientRect();
        const pad = 5;
        const usable = Math.max(1, rect.width - pad * 2);
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        let best = null;
        let bestDist = maxDistPx;
        if (!startInput.classList.contains('jk-trim-offscreen')) {
          const sx =
            rect.left + pad + ((trimState.startMs - trimState.viewStartMs) / span) * usable - 3;
          const ds = Math.abs(clientX - sx);
          if (ds <= bestDist) {
            bestDist = ds;
            best = 'start';
          }
        }
        if (!endInput.classList.contains('jk-trim-offscreen')) {
          const ex =
            rect.left + pad + ((trimState.endMs - trimState.viewStartMs) / span) * usable + 3;
          const de = Math.abs(clientX - ex);
          if (de <= bestDist) {
            bestDist = de;
            best = 'end';
          }
        }
        return best;
      };

      // Click/drag empty track area to scrub playhead directly within zoomed window (supports Shift fine gear)
      trackWrap.addEventListener('pointerdown', (ev) => {
        if (handleDrag || ev.target === startInput || ev.target === endInput || ev.target === rangeFill) {
          return;
        }
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        const nearHandle = findNearbyHandleAtClientX(ev.clientX, 10);
        if (nearHandle) {
          startHandlePointerDrag(nearHandle, ev);
          return;
        }
        ev.preventDefault();
        clearAccidentalSelection();
        const initMs = clientXToViewMs(ev.clientX);
        trimState.shiftDown = Boolean(ev.shiftKey);
        trackScrub = {
          pointerId: ev.pointerId,
          lastX: ev.clientX,
          accumMs: initMs,
        };
        syncFineActiveUI();
        stopTrimPreview(false);
        throttledLiveSeek(initMs);
        try {
          trackWrap.setPointerCapture(ev.pointerId);
        } catch (_) {}
      });
      trackWrap.addEventListener('pointermove', (ev) => {
        if (!trackScrub || ev.pointerId !== trackScrub.pointerId) return;
        const stepDx = ev.clientX - trackScrub.lastX;
        trackScrub.lastX = ev.clientX;
        trimState.shiftDown = Boolean(ev.shiftKey);
        syncFineActiveUI();
        if (stepDx === 0) return;
        const rect = trackWrap.getBoundingClientRect();
        const usable = Math.max(1, rect.width - 10);
        const span = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
        const gear = trimState.shiftDown ? FINE_DRAG_FACTOR : 1.0;
        const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
        trackScrub.accumMs = Math.max(
          0,
          Math.min(dur, trackScrub.accumMs + (stepDx / usable) * span * gear)
        );
        throttledLiveSeek(Math.round(trackScrub.accumMs));
      });
      const endTrackScrub = (ev) => {
        if (!trackScrub || (ev && ev.pointerId !== trackScrub.pointerId)) return;
        try {
          trackWrap.releasePointerCapture(trackScrub.pointerId);
        } catch (_) {}
        trackScrub = null;
        syncFineActiveUI();
      };
      trackWrap.addEventListener('pointerup', endTrackScrub);
      trackWrap.addEventListener('pointercancel', endTrackScrub);

      // Press-and-hold auto-repeat + Shift multiplier on step buttons
      bar.querySelectorAll('[data-trim-step]').forEach((btn) => {
        const spec = (btn.getAttribute('data-trim-step') || '').split(':');
        const which = spec[0];
        const baseDelta = parseInt(spec[1] || '0', 10);
        if (!Number.isFinite(baseDelta) || baseDelta === 0) return;

        let holdDelayTimer = 0;
        let holdInterval = 0;
        let holdStartedAt = 0;
        let lastRepeatTickAt = 0;
        let activeMult = 1;
        let activePointerId = null;
        let handledByPointer = false;

        const clearHold = (flushSeek = false) => {
          const wasActive = holdDelayTimer !== 0 || holdInterval !== 0 || activePointerId != null;
          if (flushSeek && holdInterval !== 0 && lastRepeatTickAt > 0) {
            const now = Date.now();
            const remDt = now - lastRepeatTickAt;
            if (remDt >= 50) {
              const elapsed = now - holdStartedAt;
              const accel = elapsed > 1800 ? 4 : elapsed > 900 ? 2 : 1;
              const ticks = Math.max(1, Math.min(12, Math.floor(remDt / 55)));
              nudgeTrimHandle(which, baseDelta * activeMult * accel * ticks, 'skip');
            }
          }
          if (holdDelayTimer) {
            clearTimeout(holdDelayTimer);
            holdDelayTimer = 0;
          }
          if (holdInterval) {
            clearInterval(holdInterval);
            holdInterval = 0;
          }
          lastRepeatTickAt = 0;
          if (activePointerId != null) {
            try {
              btn.releasePointerCapture(activePointerId);
            } catch (_) {}
            activePointerId = null;
          }
          if (flushSeek && wasActive) {
            throttledLiveSeek(which === 'start' ? trimState.startMs : trimState.endMs, 0);
          }
        };

        btn.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0 && ev.pointerType === 'mouse') return;
          ev.preventDefault();
          handledByPointer = true;
          clearHold(false);
          activePointerId = ev.pointerId;
          try {
            btn.setPointerCapture(ev.pointerId);
          } catch (_) {}
          activeMult = ev.shiftKey ? 5 : 1;
          holdStartedAt = Date.now();
          holdDelayTimer = setTimeout(() => {
            holdDelayTimer = 0;
            const now0 = Date.now();
            const initLateTicks = Math.max(1, Math.min(8, 1 + Math.floor(Math.max(0, now0 - holdStartedAt - 200) / 55)));
            lastRepeatTickAt = now0;
            nudgeTrimHandle(which, baseDelta * activeMult * initLateTicks, 'hold');
            holdInterval = setInterval(() => {
              const now = Date.now();
              const dt = Math.max(1, now - lastRepeatTickAt);
              lastRepeatTickAt = now;
              const elapsed = now - holdStartedAt;
              const accel = elapsed > 1800 ? 4 : elapsed > 900 ? 2 : 1;
              const ticks = Math.max(1, Math.min(12, Math.round(dt / 55)));
              nudgeTrimHandle(which, baseDelta * activeMult * accel * ticks, 'hold');
            }, 55);
          }, 200);
          nudgeTrimHandle(which, baseDelta * activeMult, 'skip');
        });
        btn.addEventListener('pointerup', () => clearHold(true));
        btn.addEventListener('pointercancel', () => clearHold(true));
        btn.addEventListener('lostpointercapture', () => clearHold(true));
        btn.addEventListener('blur', () => clearHold(true));
        btn.addEventListener('click', (ev) => {
          if (handledByPointer) {
            handledByPointer = false;
            return;
          }
          nudgeTrimHandle(which, baseDelta * (ev.shiftKey ? 5 : 1), 'normal');
        });
      });

      // Mark Start / Mark End at current playhead
      bar.querySelectorAll('[data-trim-mark]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const which = btn.getAttribute('data-trim-mark');
          if (which === 'start' || which === 'end') {
            markTrimEdgeAtPlayhead(which);
          }
        });
      });

      // Editable timestamp inputs (validate on blur / Enter per modern-web-guidance forms)
      const bindTimestampInput = (inputEl, which) => {
        if (!inputEl) return;
        const commitValue = () => {
          const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
          const minGap = Math.min(MIN_CLIP_MS, dur);
          const curVal = which === 'start' ? trimState.startMs : trimState.endMs;
          const parsed = parseFlexibleTimestamp(inputEl.value, curVal, dur);
          if (parsed == null) {
            inputEl.setAttribute('aria-invalid', 'true');
            return false;
          }
          inputEl.removeAttribute('aria-invalid');
          stopTrimPreview(true);
          if (which === 'start') {
            trimState.activeHandle = 'start';
            if (parsed > trimState.endMs - minGap) {
              trimState.endMs = Math.min(dur, parsed + Math.max(minGap, 5000));
            }
            trimState.startMs = Math.max(0, Math.min(trimState.endMs - minGap, parsed));
            ensureMsVisibleInView(trimState.startMs);
            syncTrimBarUI(true);
            throttledLiveSeek(trimState.startMs);
          } else {
            trimState.activeHandle = 'end';
            if (parsed < trimState.startMs + minGap) {
              trimState.startMs = Math.max(0, parsed - Math.max(minGap, 5000));
            }
            trimState.endMs = Math.min(dur, Math.max(trimState.startMs + minGap, parsed));
            ensureMsVisibleInView(trimState.endMs);
            syncTrimBarUI(true);
            throttledLiveSeek(trimState.endMs);
          }
          return true;
        };

        inputEl.addEventListener('focus', () => {
          trimState.activeHandle = which;
          try {
            inputEl.select();
          } catch (_) {}
        });
        inputEl.addEventListener('input', () => {
          inputEl.removeAttribute('aria-invalid');
        });
        inputEl.addEventListener('blur', () => {
          if (!commitValue()) {
            const fallbackMs = which === 'start' ? trimState.startMs : trimState.endMs;
            inputEl.value = formatTimePrecise(fallbackMs);
            inputEl.removeAttribute('aria-invalid');
          }
        });
        inputEl.addEventListener('keydown', (ev) => {
          if (ev.isComposing) return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            if (commitValue()) {
              inputEl.blur();
            }
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            const fallbackMs = which === 'start' ? trimState.startMs : trimState.endMs;
            inputEl.value = formatTimePrecise(fallbackMs);
            inputEl.removeAttribute('aria-invalid');
            inputEl.blur();
          } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            const step = (ev.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS) * (ev.key === 'ArrowUp' ? 1 : -1);
            nudgeTrimHandle(which, step);
            inputEl.value = formatTimePrecise(which === 'start' ? trimState.startMs : trimState.endMs);
          }
        });
        inputEl.addEventListener(
          'wheel',
          (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const step = (ev.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS) * (ev.deltaY < 0 ? 1 : -1);
            nudgeTrimHandle(which, step);
            if (document.activeElement === inputEl) {
              inputEl.value = formatTimePrecise(which === 'start' ? trimState.startMs : trimState.endMs);
            }
          },
          { passive: false }
        );
      };
      bindTimestampInput(startTextInput, 'start');
      bindTimestampInput(endTextInput, 'end');

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

  function throttledLiveSeek(targetMs, minIntervalMs = 65, preferTrailing = false) {
    const player = getPlayer();
    if (!player || typeof player.seekToMs !== 'function') return;
    trimState.pendingSeekTargetMs = Math.round(targetMs);
    const now = Date.now();
    const run = () => {
      const p = getPlayer();
      if (!p || typeof p.seekToMs !== 'function') return;
      trimState.lastSeekSentAt = Date.now();
      p.seekToMs(trimState.pendingSeekTargetMs);
      syncTrimPlayheadOnly();
    };
    if (!preferTrailing && (minIntervalMs <= 0 || now - trimState.lastSeekSentAt >= minIntervalMs)) {
      if (trimState.pendingSeekTimer) {
        clearTimeout(trimState.pendingSeekTimer);
        trimState.pendingSeekTimer = 0;
      }
      run();
    } else if (!trimState.pendingSeekTimer) {
      const waitMs = preferTrailing
        ? Math.max(40, minIntervalMs)
        : Math.max(16, minIntervalMs - (now - trimState.lastSeekSentAt));
      trimState.pendingSeekTimer = setTimeout(() => {
        trimState.pendingSeekTimer = 0;
        run();
      }, waitMs);
    }
  }

  function syncTrimHandleStacking() {
    const startInput = document.getElementById('jk-trim-start');
    const endInput = document.getElementById('jk-trim-end');
    if (!startInput || !endInput) return;
    const vSpan = Math.max(1, trimState.viewEndMs - trimState.viewStartMs);
    const nearRightEdge = trimState.startMs - trimState.viewStartMs > vSpan * 0.85;
    const startOnTop = trimState.activeHandle === 'start' || nearRightEdge;
    startInput.classList.toggle('jk-trim-top', startOnTop);
    endInput.classList.toggle('jk-trim-top', !startOnTop);
  }

  function syncTrimPlayheadOnly() {
    const bar = document.getElementById('jk-trim-bar');
    if (!bar || !trimState.active) return;
    const player = getPlayer();
    const dur = Math.max(1, trimState.durationMs);
    const cur =
      player && typeof player.getCurrentTimeMs === 'function'
        ? Math.max(0, Math.min(dur, player.getCurrentTimeMs()))
        : trimState.startMs;

    const vStart = trimState.viewStartMs;
    const vSpan = Math.max(1, trimState.viewEndMs - vStart);
    const playheadEl = bar.querySelector('#jk-trim-playhead');
    const curInView = cur >= vStart && cur <= trimState.viewEndMs;
    const curFrac = Math.max(0, Math.min(1, (cur - vStart) / vSpan));
    bar.style.setProperty('--trim-cur-frac', curFrac.toFixed(5));
    if (playheadEl) {
      playheadEl.classList.toggle('jk-trim-cur-offscreen', !curInView);
    }

    const ovCurPct = Math.max(0, Math.min(100, (cur / dur) * 100));
    bar.style.setProperty('--ov-cur-pct', ovCurPct.toFixed(3) + '%');
  }

  function syncTrimBarUI(forceTextSync = false) {
    const bar = document.getElementById('jk-trim-bar');
    if (!bar) return;
    const dur = Math.max(MIN_CLIP_MS, trimState.durationMs || 1000);
    const startMs = Math.max(0, Math.min(dur, trimState.startMs));
    const endMs = Math.max(startMs, Math.min(dur, trimState.endMs));

    const minSpan = getMinViewSpanMs();
    if (trimState.viewEndMs <= trimState.viewStartMs) {
      trimState.viewStartMs = 0;
      trimState.viewEndMs = dur;
    }
    let vSpan = Math.max(minSpan, Math.min(dur, trimState.viewEndMs - trimState.viewStartMs));
    let vStart = Math.max(0, Math.min(dur - vSpan, trimState.viewStartMs));
    let vEnd = vStart + vSpan;
    trimState.viewStartMs = vStart;
    trimState.viewEndMs = vEnd;

    const startInput = bar.querySelector('#jk-trim-start');
    const endInput = bar.querySelector('#jk-trim-end');
    const startOffscreen = startMs < vStart || startMs > vEnd;
    const endOffscreen = endMs < vStart || endMs > vEnd;

    if (startInput) {
      startInput.min = String(vStart);
      startInput.max = String(vEnd);
      startInput.value = String(Math.max(vStart, Math.min(vEnd, startMs)));
      startInput.setAttribute('aria-valuetext', formatTimePrecise(startMs));
      startInput.classList.toggle('jk-trim-offscreen', startOffscreen);
      syncRangeCssVars(startInput);
    }
    if (endInput) {
      endInput.min = String(vStart);
      endInput.max = String(vEnd);
      endInput.value = String(Math.max(vStart, Math.min(vEnd, endMs)));
      endInput.setAttribute('aria-valuetext', formatTimePrecise(endMs));
      endInput.classList.toggle('jk-trim-offscreen', endOffscreen);
      syncRangeCssVars(endInput);
    }

    const startFrac = Math.max(0, Math.min(1, (startMs - vStart) / vSpan));
    const endFrac = Math.max(0, Math.min(1, (endMs - vStart) / vSpan));
    bar.style.setProperty('--trim-start-frac', startFrac.toFixed(5));
    bar.style.setProperty('--trim-end-frac', endFrac.toFixed(5));

    // Overview minimap CSS vars
    bar.style.setProperty('--ov-sel-start-pct', ((startMs / dur) * 100).toFixed(3) + '%');
    bar.style.setProperty('--ov-sel-end-pct', ((endMs / dur) * 100).toFixed(3) + '%');
    bar.style.setProperty('--ov-win-start-pct', ((vStart / dur) * 100).toFixed(3) + '%');
    bar.style.setProperty('--ov-win-end-pct', ((vEnd / dur) * 100).toFixed(3) + '%');

    syncTrimPlayheadOnly();
    syncTrimHandleStacking();

    const viewStartEl = bar.querySelector('#jk-trim-view-start');
    const viewEndEl = bar.querySelector('#jk-trim-view-end');
    if (viewStartEl) viewStartEl.textContent = formatTimePrecise(vStart);
    if (viewEndEl) viewEndEl.textContent = formatTimePrecise(vEnd);

    const zoomInBtn = bar.querySelector('#jk-trim-zoom-in');
    const zoomOutBtn = bar.querySelector('#jk-trim-zoom-out');
    const zoomFitBtn = bar.querySelector('#jk-trim-zoom-fit');
    if (zoomInBtn) zoomInBtn.disabled = vSpan <= minSpan + 20;
    if (zoomOutBtn) zoomOutBtn.disabled = vSpan >= dur - 20;
    if (zoomFitBtn) {
      zoomFitBtn.textContent = formatZoomSpanLabel(vSpan, dur);
    }

    const startText = bar.querySelector('#jk-trim-start-text');
    const endText = bar.querySelector('#jk-trim-end-text');
    const durPill = bar.querySelector('#jk-trim-duration');
    const prevBtn = bar.querySelector('#jk-trim-preview');
    if (startText && (forceTextSync || document.activeElement !== startText)) {
      startText.value = formatTimePrecise(startMs);
    }
    if (endText && (forceTextSync || document.activeElement !== endText)) {
      endText.value = formatTimePrecise(endMs);
    }
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
    if (
      window.JKPiPPlayer &&
      typeof window.JKPiPPlayer.isOpen === 'function' &&
      window.JKPiPPlayer.isOpen() &&
      typeof window.JKPiPPlayer.refreshLayout === 'function'
    ) {
      window.JKPiPPlayer.refreshLayout();
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

    const musicOn =
      typeof player.isMusicEnabled === 'function'
        ? player.isMusicEnabled()
        : st.musicEnabled !== false;
    if (dialogOptions.audio !== 'off') {
      dialogOptions.audio = musicOn ? 'on' : 'sfx';
    }
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
    trimState.draggingHandle = null;
    trimState.fineOriginRawMs = null;
    trimState.fineOriginValMs = null;

    // Auto-zoom around initial clip so small clips on 20-30m demos are immediately easy to grab
    const initClipSpan = Math.max(MIN_CLIP_MS, endMs - startMs);
    const initViewSpan = Math.max(
      getMinViewSpanMs(),
      Math.min(dur, Math.max(10000, Math.round(initClipSpan * 3)))
    );
    const initCenter = (startMs + endMs) * 0.5;
    trimState.viewStartMs = Math.max(
      0,
      Math.min(dur - initViewSpan, Math.round(initCenter - initViewSpan * 0.5))
    );
    trimState.viewEndMs = trimState.viewStartMs + initViewSpan;

    snapshotLivePlayerDefaults();
    ensureTrimBarDOM(mode);
    syncTrimBarUI(true);
    syncHostTrimVisibility(true);
    startTrimPlayheadTicker();

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
    stopTrimPlayheadTicker();
    stopEdgeAutoPan();
    trimState.draggingHandle = null;
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
              <div class="jk-exp-seg" style="--seg-cols: 3;" role="group" aria-label="Audio export">
                <button type="button" class="jk-exp-seg-btn" data-opt-group="audio" data-opt-val="on" aria-pressed="true"><span>All Sound</span></button>
                <button type="button" class="jk-exp-seg-btn" data-opt-group="audio" data-opt-val="sfx" aria-pressed="false"><span>SFX Only</span></button>
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
        music: dialogOptions.audio === 'on',
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

  // Trim Mode keyboard shortcuts (Esc, [ / ] mark playhead, +/- zoom, F fit/full)
  window.addEventListener(
    'keydown',
    (ev) => {
      if (!trimState.active || ev.isComposing) return;
      const dlg = document.getElementById('jk-export-dialog');
      if (dlg && dlg.hasAttribute('open')) return;

      const activeEl = document.activeElement;
      const isTextInput =
        activeEl &&
        activeEl.tagName === 'INPUT' &&
        activeEl.type !== 'range' &&
        activeEl.type !== 'button' &&
        activeEl.type !== 'checkbox' &&
        activeEl.type !== 'radio';
      const isOtherField =
        activeEl &&
        (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable);

      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (isTextInput && activeEl.classList.contains('jk-trim-val-input')) {
          const isStart = activeEl.id === 'jk-trim-start-text';
          activeEl.value = formatTimePrecise(isStart ? trimState.startMs : trimState.endMs);
          activeEl.removeAttribute('aria-invalid');
          activeEl.blur();
          return;
        }
        exitTrimMode(false);
        return;
      }

      if (isTextInput || isOtherField || ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (ev.key === '[' || ev.key === 'i' || ev.key === 'I') {
        ev.preventDefault();
        markTrimEdgeAtPlayhead('start');
      } else if (ev.key === ']' || ev.key === 'o' || ev.key === 'O') {
        ev.preventDefault();
        markTrimEdgeAtPlayhead('end');
      } else if (ev.key === '=' || ev.key === '+') {
        ev.preventDefault();
        zoomTrimBy(0.5);
      } else if (ev.key === '-' || ev.key === '_') {
        ev.preventDefault();
        zoomTrimBy(2.0);
      } else if (ev.key === 'f' || ev.key === 'F' || ev.key === '0') {
        ev.preventDefault();
        fitTrimToSelection(true);
      }
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
      viewStartMs: trimState.viewStartMs,
      viewEndMs: trimState.viewEndMs,
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
      syncTrimBarUI(true);
      return true;
    },
    setTrimViewport: (viewStartMs, viewEndMs) => {
      if (!trimState.active) return false;
      setTrimViewport(viewStartMs, viewEndMs);
      return true;
    },
    zoomTrimBy: (factor, anchorFrac) => {
      if (!trimState.active) return false;
      zoomTrimBy(factor, anchorFrac);
      return true;
    },
    fitTrimToSelection: (toggleFull) => {
      if (!trimState.active) return false;
      fitTrimToSelection(Boolean(toggleFull));
      return true;
    },
    markTrimEdgeAtPlayhead,
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
