(function () {
  'use strict';

  if (typeof window.warnOnce !== 'function') {
    const warned = new Set();
    window.warnOnce = function (txt) {
      if (!warned.has(txt)) {
        warned.add(txt);
      }
    };
  }

  const MIN_SPEED = 0.05;
  const MAX_SPEED = 20.0;
  const MIN_GAMMA = 0.5;
  const MAX_GAMMA = 3.0;
  const MIN_OVERBRIGHT = 0;
  const MAX_OVERBRIGHT = 3;

  const BOOT_START_MS = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const DEFAULT_ENGINE_VERSION = '20261111a';
  const DEFAULT_PLAYER_VERSION = '20261111a';

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
  const EXPECTED_OPENJK_JS_BYTES = 327283;
  const EXPECTED_OPENJK_WASM_BYTES = 5305470;
  const WASM_PK3_CHUNK_SIZE = 256 * 1024;
  const IDB_NAME = 'openjk-cache-v1';
  const IDB_VERSION = 1;
  const LS_MANIFEST_KEY = 'openjk_pk3_manifest_v2';
  const LS_HOT_CHUNKS_KEY = 'openjk_hot_chunks_v1';
  const LS_SYNC_FALLBACK_KEY = 'openjk_sync_fallback_chunks_v1';
  const LS_PREFS_KEY = 'openjk_player_prefs_v1';

  const state = {
    ready: false,
    interactiveMode: false,
    paused: false,
    loop: true,
    thirdPerson: true,
    gamma: 1.0,
    overbright: 0,
    speed: 1.0,
    muted: false,
    musicEnabled: true,
    volume: 0.8,
    savedVolume: 0.8,
    demoName: '1.51ef9.dm_26',
    lastDemoSource: '1.51ef9.dm_26',
    demoEnded: false,
    demoCompletedCount: 0,
    pk3BytesTransferred: 0,
    pk3RangeRequests: 0,
    pk3CacheHits: 0,
    pk3CacheBytes: 0,
    completionListeners: [],
    audioContexts: [],
    masterGains: [],
    engineStarted: false,
    engineBootStage: 'idle',
    engineBootError: '',
    engineDownloadLoaded: 0,
    engineDownloadTotal: 0,
    engineLastProgressAt: 0,
    prewarmed: false,
    preloadOnly: false,
    demoLoadedOnce: false,
    bypassCache: false,
    forceSoftwareRenderer: false,
    pendingCommands: [],
    activeDemoLoadCount: 0,
    loadProgress: {
      stage: 'idle',
      message: '',
      loadedBytes: 0,
      totalBytes: 0,
      percent: 0,
      updatedAt: 0,
    },
    loadChain: Promise.resolve(true),
    metrics: {
      bootStartMs: BOOT_START_MS,
      idbHydrateDurationMs: 0,
      idbHydratedChunks: 0,
      idbHydratedBytes: 0,
      runtimeInitMs: 0,
      prewarmCompleteMs: 0,
      demoLoadStartMs: 0,
      firstActiveFrameMs: 0,
      startupDurationMs: 0,
      demoLoadDurationMs: 0,
    },
  };

  function clampGammaValue(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 1.0;
    return Math.round(Math.min(MAX_GAMMA, Math.max(MIN_GAMMA, num)) * 100) / 100;
  }

  function clampOverbrightValue(val) {
    const num = Math.round(Number(val));
    if (!Number.isFinite(num)) return 0;
    return Math.min(MAX_OVERBRIGHT, Math.max(MIN_OVERBRIGHT, num));
  }

  function loadSavedPrefs() {
    try {
      const raw = localStorage.getItem(LS_PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs && typeof prefs === 'object') {
        if (typeof prefs.speed === 'number' && Number.isFinite(prefs.speed)) {
          state.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, prefs.speed));
        }
        if (typeof prefs.muted === 'boolean') {
          state.muted = prefs.muted;
        }
        if (typeof prefs.musicEnabled === 'boolean') {
          state.musicEnabled = prefs.musicEnabled;
        } else if (typeof prefs.music === 'boolean') {
          state.musicEnabled = prefs.music;
        }
        if (typeof prefs.volume === 'number' && Number.isFinite(prefs.volume)) {
          state.volume = Math.min(1.0, Math.max(0.0, prefs.volume));
        }
        if (typeof prefs.loop === 'boolean') {
          state.loop = prefs.loop;
        }
        if (typeof prefs.thirdPerson === 'boolean') {
          state.thirdPerson = prefs.thirdPerson;
        }
        if (typeof prefs.gamma === 'number' && Number.isFinite(prefs.gamma)) {
          state.gamma = clampGammaValue(prefs.gamma);
        }
        if (typeof prefs.overbright === 'number' && Number.isFinite(prefs.overbright)) {
          state.overbright = clampOverbrightValue(prefs.overbright);
        }
      }
    } catch (_) {}
  }

  function savePlayerPrefs() {
    if (state.preloadOnly && !state.demoLoadedOnce) return;
    try {
      localStorage.setItem(
        LS_PREFS_KEY,
        JSON.stringify({
          speed: state.speed,
          muted: state.muted,
          musicEnabled: state.musicEnabled,
          volume: state.volume,
          loop: state.loop,
          thirdPerson: state.thirdPerson,
          gamma: state.gamma,
          overbright: state.overbright,
        })
      );
    } catch (_) {}
  }

  function persistPrefField(key, value) {
    try {
      let existing = {};
      const raw = localStorage.getItem(LS_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      } else {
        existing = {
          speed: state.speed,
          volume: state.volume,
          loop: state.loop,
          thirdPerson: state.thirdPerson,
          gamma: state.gamma,
          overbright: state.overbright,
        };
      }
      existing[key] = value;
      localStorage.setItem(LS_PREFS_KEY, JSON.stringify(existing));
    } catch (_) {}
  }

  loadSavedPrefs();

  // Parse initial configuration from window.JKDemoConfig or URL query string
  function parseQueryConfig(searchStr) {
    const rawSearch = typeof searchStr === 'string' ? searchStr : (window.location.search || '');
    const params = new URLSearchParams(rawSearch);
    const cfg = window.JKDemoConfig || {};
    const rawDemoParam = params.get('demo');
    const preloadParam = String(params.get('preload') || '').toLowerCase();
    const autoPlayParam = String(params.get('autoplay') || '').toLowerCase();
    const noCacheParam = String(params.get('nocache') || '').toLowerCase();
    const bypassCache =
      noCacheParam === '1' || noCacheParam === 'true' || Boolean(cfg.bypassCache);
    const preloadOnly =
      preloadParam === '1' ||
      preloadParam === 'true' ||
      autoPlayParam === '0' ||
      autoPlayParam === 'false' ||
      rawDemoParam === 'none' ||
      Boolean(cfg.preload) ||
      cfg.autoPlay === false;
    const demo =
      rawDemoParam && rawDemoParam !== 'none'
        ? rawDemoParam
        : cfg.demo || state.demoName || '1.51ef9.dm_26';
    let speed = state.speed;
    if (params.has('speed')) {
      const sp = parseFloat(params.get('speed'));
      if (Number.isFinite(sp)) speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, sp));
    } else if (typeof cfg.speed === 'number' && Number.isFinite(cfg.speed)) {
      speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, cfg.speed));
    }
    let muted = state.muted;
    if (params.has('muted')) {
      const m = params.get('muted');
      muted = m === '1' || m === 'true';
    } else if (typeof cfg.muted === 'boolean') {
      muted = cfg.muted;
    }
    let musicEnabled = state.musicEnabled;
    let hasExplicitMusic = false;
    if (params.has('music')) {
      const mu = String(params.get('music') || '').toLowerCase();
      musicEnabled = !(mu === '0' || mu === 'false' || mu === 'off' || mu === 'no');
      hasExplicitMusic = true;
    } else if (typeof cfg.musicEnabled === 'boolean') {
      musicEnabled = cfg.musicEnabled;
      hasExplicitMusic = true;
    } else if (typeof cfg.music === 'boolean') {
      musicEnabled = cfg.music;
      hasExplicitMusic = true;
    }
    let volume = state.volume;
    if (params.has('volume')) {
      const v = parseFloat(params.get('volume'));
      if (Number.isFinite(v)) volume = Math.min(1.0, Math.max(0.0, v));
    } else if (typeof cfg.volume === 'number' && Number.isFinite(cfg.volume)) {
      volume = Math.min(1.0, Math.max(0.0, cfg.volume));
    }
    let forceSoftwareRenderer = state.forceSoftwareRenderer;
    if (params.has('software')) {
      const sw = String(params.get('software') || '').toLowerCase();
      forceSoftwareRenderer = sw === '1' || sw === 'true' || sw === 'yes';
    } else if (params.has('renderer')) {
      const r = String(params.get('renderer') || '').toLowerCase();
      forceSoftwareRenderer = r === 'software' || r === 'sw' || r === 'cpu';
    } else if (typeof cfg.forceSoftwareRenderer === 'boolean') {
      forceSoftwareRenderer = cfg.forceSoftwareRenderer;
    } else if (typeof cfg.renderer === 'string') {
      const r = cfg.renderer.toLowerCase();
      forceSoftwareRenderer = r === 'software' || r === 'sw' || r === 'cpu';
    }
    let thirdPerson = state.thirdPerson;
    let hasExplicitThirdPerson = false;
    if (params.has('thirdPerson')) {
      const tp = String(params.get('thirdPerson') || '').toLowerCase();
      thirdPerson = !(tp === '0' || tp === 'false' || tp === 'no');
      hasExplicitThirdPerson = true;
    } else if (typeof cfg.thirdPerson === 'boolean') {
      thirdPerson = cfg.thirdPerson;
      hasExplicitThirdPerson = true;
    }
    let gamma = state.gamma;
    let hasExplicitGamma = false;
    if (params.has('gamma')) {
      const g = parseFloat(params.get('gamma'));
      if (Number.isFinite(g)) {
        gamma = clampGammaValue(g);
        hasExplicitGamma = true;
      }
    } else if (typeof cfg.gamma === 'number' && Number.isFinite(cfg.gamma)) {
      gamma = clampGammaValue(cfg.gamma);
      hasExplicitGamma = true;
    }
    let overbright = state.overbright;
    let hasExplicitOverbright = false;
    const obParam = params.has('overbright')
      ? params.get('overbright')
      : params.has('mapOverbright')
      ? params.get('mapOverbright')
      : null;
    if (obParam !== null) {
      const ob = parseInt(obParam, 10);
      if (Number.isFinite(ob)) {
        overbright = clampOverbrightValue(ob);
        hasExplicitOverbright = true;
      }
    } else if (typeof cfg.overbright === 'number' && Number.isFinite(cfg.overbright)) {
      overbright = clampOverbrightValue(cfg.overbright);
      hasExplicitOverbright = true;
    } else if (typeof cfg.mapOverBrightBits === 'number' && Number.isFinite(cfg.mapOverBrightBits)) {
      overbright = clampOverbrightValue(cfg.mapOverBrightBits);
      hasExplicitOverbright = true;
    }
    return {
      demo,
      speed,
      muted,
      musicEnabled,
      hasExplicitMusic,
      volume,
      thirdPerson,
      hasExplicitThirdPerson,
      gamma,
      hasExplicitGamma,
      overbright,
      hasExplicitOverbright,
      forceSoftwareRenderer,
      preloadOnly,
      bypassCache,
    };
  }

  function isQueryDemoUrl(input) {
    if (typeof input !== 'string') return false;
    const s = input.trim();
    return (
      s.includes('?') ||
      /(?:getdemo|mergedemo|trimdemo)\.php/i.test(s) ||
      /minrpc\.(?:py|php)/i.test(s)
    );
  }

  function hashDemoSource(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
  }

  const initialCfg = parseQueryConfig(window.location.search);
  state.lastDemoSource = initialCfg.demo || '1.51ef9.dm_26';
  state.demoName = normalizeDemoFileName(initialCfg.demo) || '1.51ef9.dm_26';
  state.speed = initialCfg.speed;
  state.muted = initialCfg.muted;
  state.musicEnabled = Boolean(initialCfg.musicEnabled);
  state.volume = initialCfg.volume;
  state.thirdPerson = Boolean(initialCfg.thirdPerson);
  state.gamma = clampGammaValue(initialCfg.gamma);
  state.overbright = clampOverbrightValue(initialCfg.overbright);
  state.forceSoftwareRenderer = Boolean(initialCfg.forceSoftwareRenderer);
  state.preloadOnly = Boolean(initialCfg.preloadOnly);
  state.bypassCache = Boolean(initialCfg.bypassCache);
  state.savedVolume = state.volume > 0 ? state.volume : 0.8;

  function normalizeDemoFileName(input) {
    if (typeof input !== 'string') return '';
    const trimmed = input.trim();
    if (!trimmed || trimmed.includes('\0')) return '';
    if (isQueryDemoUrl(trimmed)) {
      return 'active_demo_' + hashDemoSource(trimmed) + '.dm_26';
    }
    if (trimmed.includes('..')) return '';
    const base = trimmed.replace(/^.*\/+/, '');
    if (!base || base.startsWith('.')) return '';
    return base.toLowerCase().endsWith('.dm_26') ? base : base + '.dm_26';
  }

  function stripDemoExt(fileName) {
    return String(fileName || '').replace(/\.dm_26$/i, '');
  }

  // 0. Ensure Emscripten SDL2's internal "#canvas" selector resolves to #jk-canvas
  const origQuerySelector = document.querySelector;
  if (origQuerySelector) {
    document.querySelector = function (selector) {
      const res = origQuerySelector.call(this, selector);
      if (!res && selector === '#canvas') {
        return document.getElementById('jk-canvas');
      }
      return res;
    };
  }

  // Software WebGL1 rasterizer fallback (used automatically if hardware/ANGLE WebGL is blocked by the browser)
  function createSoftwareWebGLContext(canvasEl, getCtxFn) {
    const ctx2d = getCtxFn.call(canvasEl, '2d');
    if (!ctx2d) return null;

    let fbWidth = canvasEl.width || 640;
    let fbHeight = canvasEl.height || 360;
    let imageData = ctx2d.createImageData(fbWidth, fbHeight);
    let colorBuf8 = imageData.data;
    let colorBuf32 = new Uint32Array(colorBuf8.buffer);
    let depthBuf = new Float32Array(fbWidth * fbHeight);
    depthBuf.fill(1.0);

    function ensureFramebufferSize() {
      const w = canvasEl.width || 640;
      const h = canvasEl.height || 360;
      if (w !== fbWidth || h !== fbHeight) {
        fbWidth = w;
        fbHeight = h;
        imageData = ctx2d.createImageData(fbWidth, fbHeight);
        colorBuf8 = imageData.data;
        colorBuf32 = new Uint32Array(colorBuf8.buffer);
        colorBuf32.fill(0xFF000000);
        depthBuf = new Float32Array(fbWidth * fbHeight);
        depthBuf.fill(1.0);
        if (gl) {
          gl.drawingBufferWidth = fbWidth;
          gl.drawingBufferHeight = fbHeight;
        }
      }
    }

    let flushScheduled = false;
    let hasDrawnSinceClear = false;
    function presentCompletedFrame() {
      if (!hasDrawnSinceClear) return;
      hasDrawnSinceClear = false;
      ctx2d.putImageData(imageData, 0, 0);
    }
    function scheduleEndOfFramePresent() {
      hasDrawnSinceClear = true;
      if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(() => {
          flushScheduled = false;
          presentCompletedFrame();
        });
      }
    }

    let nextObjId = 1;
    let vpX = 0, vpY = 0, vpW = fbWidth, vpH = fbHeight;
    let scX = 0, scY = 0, scW = fbWidth, scH = fbHeight;
    let clearR = 0, clearG = 0, clearB = 0, clearA = 255;
    let clearDepthVal = 1.0;
    let clearStencilVal = 0;
    let depthNear = 0.0;
    let depthFar = 1.0;
    let depthTest = false;
    let depthMaskVal = true;
    let depthFuncVal = 0x0203; // LEQUAL
    let blendEnabled = false;
    let blendSrc = 1; // ONE
    let blendDst = 0; // ZERO
    let cullEnabled = false;
    let cullFaceMode = 0x0405; // BACK
    let frontFaceMode = 0x0901; // CCW
    let scissorEnabled = false;
    let activeTexUnit = 0;
    const boundTextures = new Array(16).fill(null);

    const attribs = [];
    const attribEnabled = [];
    const attribDefault = [];
    for (let i = 0; i < 16; i++) {
      attribs.push({ size: 4, type: 0x1406, normalized: false, stride: 0, offset: 0, buffer: null });
      attribEnabled.push(false);
      attribDefault.push(new Float32Array([0, 0, 0, 1]));
    }
    attribDefault[2] = new Float32Array([1, 1, 1, 1]);

    function multiplyMat4(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }

    const identityMat4 = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);

    function readVertexAttribute(attrIdx, vertexIndex, out4) {
      if (!attribEnabled[attrIdx]) {
        const def = attribDefault[attrIdx];
        out4[0] = def[0]; out4[1] = def[1]; out4[2] = def[2]; out4[3] = def[3];
        return;
      }
      const attr = attribs[attrIdx];
      const buf = attr.buffer || gl._boundArrayBuffer;
      if (!buf || !buf.bytes) {
        const def = attribDefault[attrIdx];
        out4[0] = def[0]; out4[1] = def[1]; out4[2] = def[2]; out4[3] = def[3];
        return;
      }
      const size = attr.size;
      const type = attr.type;
      const stride = attr.stride || (size * (type === 0x1406 ? 4 : type === 0x1401 || type === 0x1400 ? 1 : 2));
      const bytePos = attr.offset + vertexIndex * stride;
      out4[0] = 0; out4[1] = 0; out4[2] = 0; out4[3] = 1;
      if (type === 0x1406) { // FLOAT
        const dv = buf.dv;
        const maxByte = buf.bytes.byteLength;
        if (bytePos + size * 4 <= maxByte) {
          for (let c = 0; c < size; c++) {
            out4[c] = dv.getFloat32(bytePos + c * 4, true);
          }
        }
      } else if (type === 0x1401) { // UNSIGNED_BYTE
        const u8 = buf.bytes;
        const scale = attr.normalized ? (1.0 / 255.0) : 1.0;
        if (bytePos + size <= u8.byteLength) {
          for (let c = 0; c < size; c++) {
            out4[c] = u8[bytePos + c] * scale;
          }
        }
      } else if (type === 0x1403) { // UNSIGNED_SHORT
        const dv = buf.dv;
        const scale = attr.normalized ? (1.0 / 65535.0) : 1.0;
        if (bytePos + size * 2 <= buf.bytes.byteLength) {
          for (let c = 0; c < size; c++) {
            out4[c] = dv.getUint16(bytePos + c * 2, true) * scale;
          }
        }
      }
    }

    function interpClipVertex(a, b, t) {
      return {
        cx: a.cx + (b.cx - a.cx) * t,
        cy: a.cy + (b.cy - a.cy) * t,
        cz: a.cz + (b.cz - a.cz) * t,
        cw: a.cw + (b.cw - a.cw) * t,
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
        u0: a.u0 + (b.u0 - a.u0) * t,
        v0: a.v0 + (b.v0 - a.v0) * t,
        u1: a.u1 + (b.u1 - a.u1) * t,
        v1: a.v1 + (b.v1 - a.v1) * t,
      };
    }

    function clipPolygonPlane(poly, planeIdx) {
      const n = poly.length;
      if (n === 0) return poly;
      const out = [];
      for (let i = 0; i < n; i++) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % n];
        let dc, dn;
        if (planeIdx === 0) {
          dc = cur.cw - 0.005;
          dn = nxt.cw - 0.005;
        } else if (planeIdx === 1) {
          dc = cur.cz + cur.cw * 1.0001;
          dn = nxt.cz + nxt.cw * 1.0001;
        } else if (planeIdx === 2) {
          dc = cur.cx + cur.cw * 2.0;
          dn = nxt.cx + nxt.cw * 2.0;
        } else if (planeIdx === 3) {
          dc = cur.cw * 2.0 - cur.cx;
          dn = nxt.cw * 2.0 - nxt.cx;
        } else if (planeIdx === 4) {
          dc = cur.cy + cur.cw * 2.0;
          dn = nxt.cy + nxt.cw * 2.0;
        } else {
          dc = cur.cw * 2.0 - cur.cy;
          dn = nxt.cw * 2.0 - nxt.cy;
        }
        const curIn = dc >= 0;
        const nxtIn = dn >= 0;
        if (curIn) out.push(cur);
        if (curIn !== nxtIn) {
          out.push(interpClipVertex(cur, nxt, dc / (dc - dn)));
        }
      }
      return out;
    }

    function clipNearPlane(v0, v1, v2, outTris) {
      const NEAR_W = 0.005;
      if (v0.cw < NEAR_W && v1.cw < NEAR_W && v2.cw < NEAR_W) return;
      if (
        v0.cz + v0.cw * 1.0001 < 0 &&
        v1.cz + v1.cw * 1.0001 < 0 &&
        v2.cz + v2.cw * 1.0001 < 0
      ) {
        return;
      }
      if (
        v0.cw >= NEAR_W && v1.cw >= NEAR_W && v2.cw >= NEAR_W &&
        v0.cz + v0.cw * 1.0001 >= 0 && v1.cz + v1.cw * 1.0001 >= 0 && v2.cz + v2.cw * 1.0001 >= 0 &&
        v0.cx >= -v0.cw * 2.0 && v0.cx <= v0.cw * 2.0 &&
        v1.cx >= -v1.cw * 2.0 && v1.cx <= v1.cw * 2.0 &&
        v2.cx >= -v2.cw * 2.0 && v2.cx <= v2.cw * 2.0 &&
        v0.cy >= -v0.cw * 2.0 && v0.cy <= v0.cw * 2.0 &&
        v1.cy >= -v1.cw * 2.0 && v1.cy <= v1.cw * 2.0 &&
        v2.cy >= -v2.cw * 2.0 && v2.cy <= v2.cw * 2.0
      ) {
        outTris.push(v0, v1, v2);
        return;
      }
      let poly = [v0, v1, v2];
      for (let p = 0; p < 6; p++) {
        poly = clipPolygonPlane(poly, p);
        if (poly.length < 3) return;
      }
      for (let i = 1; i < poly.length - 1; i++) {
        outTris.push(poly[0], poly[i], poly[i + 1]);
      }
    }

    function executeDraw(numTris, getTriIndices) {
      const prog = gl.currentProgram;
      if (!prog) return;
      if (prog.mvpDirty) {
        const mv = prog.uniforms.u_modelView || identityMat4;
        const pr = prog.uniforms.u_projection || identityMat4;
        multiplyMat4(prog.mvp, pr, mv);
        prog.mvpDirty = false;
      }
      const mvp = prog.mvp;
      const m0 = mvp[0], m1 = mvp[1], m2 = mvp[2], m3 = mvp[3];
      const m4 = mvp[4], m5 = mvp[5], m6 = mvp[6], m7 = mvp[7];
      const m8 = mvp[8], m9 = mvp[9], m10 = mvp[10], m11 = mvp[11];
      const m12 = mvp[12], m13 = mvp[13], m14 = mvp[14], m15 = mvp[15];

      const tex0 = prog.useTex0 ? boundTextures[0] : null;
      const hasTex0 = !!(tex0 && tex0.data && tex0.width > 0 && tex0.height > 0);
      const tex0Data = hasTex0 ? tex0.data : null;
      const tex0W = hasTex0 ? tex0.width : 0;
      const tex0H = hasTex0 ? tex0.height : 0;
      const tex0ClampS = hasTex0 && (tex0.wrapS === 0x812F || tex0.wrapS === 0x8370 || tex0.wrapS === 0x2900);
      const tex0ClampT = hasTex0 && (tex0.wrapT === 0x812F || tex0.wrapT === 0x8370 || tex0.wrapT === 0x2900);

      const tex1 = prog.useTex1 ? boundTextures[1] : null;
      const hasTex1 = !!(tex1 && tex1.data && tex1.width > 0 && tex1.height > 0);
      const tex1Data = hasTex1 ? tex1.data : null;
      const tex1W = hasTex1 ? tex1.width : 0;
      const tex1H = hasTex1 ? tex1.height : 0;

      const hasAlphaTest = prog.hasAlphaTest;
      const alphaRef255 = ((prog.uniforms.u_alphaTestRef || 0) * 255) | 0;
      const alphaMode = prog.alphaMode || 0;

      const minClipX = scissorEnabled ? Math.max(0, scX) : 0;
      const maxClipX = scissorEnabled ? Math.min(fbWidth - 1, scX + scW - 1) : fbWidth - 1;
      const minClipY = scissorEnabled ? Math.max(0, fbHeight - (scY + scH)) : 0;
      const maxClipY = scissorEnabled ? Math.min(fbHeight - 1, fbHeight - scY - 1) : fbHeight - 1;

      const tmpPos = new Float32Array(4);
      const tmpCol = new Float32Array(4);
      const tmpUV0 = new Float32Array(4);
      const tmpUV1 = new Float32Array(4);
      const vertexCache = new Map();

      const tm0 = prog.uniforms.u_textureMatrix0;

      function fetchVertex(vi) {
        let v = vertexCache.get(vi);
        if (v) return v;
        readVertexAttribute(0, vi, tmpPos);
        const px = tmpPos[0], py = tmpPos[1], pz = tmpPos[2], pw = tmpPos[3];
        const cx = m0 * px + m4 * py + m8 * pz + m12 * pw;
        const cy = m1 * px + m5 * py + m9 * pz + m13 * pw;
        const cz = m2 * px + m6 * py + m10 * pz + m14 * pw;
        const cw = m3 * px + m7 * py + m11 * pz + m15 * pw;

        readVertexAttribute(2, vi, tmpCol);
        let u0 = 0, v0 = 0, u1 = 0, v1 = 0;
        if (hasTex0) {
          readVertexAttribute(3, vi, tmpUV0);
          if (tm0) {
            u0 = tm0[0] * tmpUV0[0] + tm0[4] * tmpUV0[1] + tm0[12];
            v0 = tm0[1] * tmpUV0[0] + tm0[5] * tmpUV0[1] + tm0[13];
          } else {
            u0 = tmpUV0[0];
            v0 = tmpUV0[1];
          }
        }
        if (hasTex1) {
          readVertexAttribute(4, vi, tmpUV1);
          u1 = tmpUV1[0];
          v1 = tmpUV1[1];
        }
        v = {
          cx, cy, cz, cw,
          r: Math.min(255, Math.max(0, (tmpCol[0] * 255) | 0)),
          g: Math.min(255, Math.max(0, (tmpCol[1] * 255) | 0)),
          b: Math.min(255, Math.max(0, (tmpCol[2] * 255) | 0)),
          a: Math.min(255, Math.max(0, (tmpCol[3] * 255) | 0)),
          u0, v0, u1, v1,
        };
        vertexCache.set(vi, v);
        return v;
      }

      const clippedTris = [];
      const idxTriple = [0, 0, 0];
      for (let t = 0; t < numTris; t++) {
        getTriIndices(t, idxTriple);
        const raw0 = fetchVertex(idxTriple[0]);
        const raw1 = fetchVertex(idxTriple[1]);
        const raw2 = fetchVertex(idxTriple[2]);
        clippedTris.length = 0;
        clipNearPlane(raw0, raw1, raw2, clippedTris);

        for (let k = 0; k < clippedTris.length; k += 3) {
          const c0 = clippedTris[k];
          const c1 = clippedTris[k + 1];
          const c2 = clippedTris[k + 2];

          const invW0 = 1.0 / c0.cw;
          const invW1 = 1.0 / c1.cw;
          const invW2 = 1.0 / c2.cw;

          const halfRange = (depthFar - depthNear) * 0.5;
          const midRange = (depthFar + depthNear) * 0.5;

          const sx0 = vpX + (c0.cx * invW0 * 0.5 + 0.5) * vpW;
          const sy0 = (fbHeight - vpY) - (c0.cy * invW0 * 0.5 + 0.5) * vpH;
          const sz0 = c0.cz * invW0 * halfRange + midRange;

          const sx1 = vpX + (c1.cx * invW1 * 0.5 + 0.5) * vpW;
          const sy1 = (fbHeight - vpY) - (c1.cy * invW1 * 0.5 + 0.5) * vpH;
          const sz1 = c1.cz * invW1 * halfRange + midRange;

          const sx2 = vpX + (c2.cx * invW2 * 0.5 + 0.5) * vpW;
          const sy2 = (fbHeight - vpY) - (c2.cy * invW2 * 0.5 + 0.5) * vpH;
          const sz2 = c2.cz * invW2 * halfRange + midRange;

          const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0);
          if (Math.abs(area) < 1e-4) continue;

          if (cullEnabled && cullFaceMode !== 0x0408) {
            // Because sy is flipped top-down, CCW in WebGL NDC has area < 0 in top-down screen coords
            const isCCW = area < 0;
            const isFront = (frontFaceMode === 0x0901) ? isCCW : !isCCW;
            if (cullFaceMode === 0x0405 && !isFront) continue; // cull BACK
            if (cullFaceMode === 0x0404 && isFront) continue; // cull FRONT
          }

          const minX = Math.max(minClipX, Math.floor(Math.min(sx0, sx1, sx2)));
          const maxX = Math.min(maxClipX, Math.ceil(Math.max(sx0, sx1, sx2)));
          const minY = Math.max(minClipY, Math.floor(Math.min(sy0, sy1, sy2)));
          const maxY = Math.min(maxClipY, Math.ceil(Math.max(sy0, sy1, sy2)));
          if (minX > maxX || minY > maxY) continue;

          const invArea = 1.0 / area;
          const uw0 = c0.u0 * invW0, vw0 = c0.v0 * invW0;
          const uw1 = c1.u0 * invW1, vw1 = c1.v0 * invW1;
          const uw2 = c2.u0 * invW2, vw2 = c2.v0 * invW2;

          const uw1_0 = c0.u1 * invW0, vw1_0 = c0.v1 * invW0;
          const uw1_1 = c1.u1 * invW1, vw1_1 = c1.v1 * invW1;
          const uw1_2 = c2.u1 * invW2, vw1_2 = c2.v1 * invW2;

          const dw0dx = (sy1 - sy2) * invArea;
          const dw1dx = (sy2 - sy0) * invArea;
          const useVCol = prog.useVertexColor !== false;

          for (let py = minY; py <= maxY; py++) {
            const sampleY = py + 0.5;
            const sampleX0 = minX + 0.5;
            let w0 = ((sx2 - sx1) * (sampleY - sy1) - (sy2 - sy1) * (sampleX0 - sx1)) * invArea;
            let w1 = ((sx0 - sx2) * (sampleY - sy2) - (sy0 - sy2) * (sampleX0 - sx2)) * invArea;
            const rowOffset = py * fbWidth;

            for (let px = minX; px <= maxX; px++) {
              const w2 = 1.0 - w0 - w1;
              if (w0 >= -1e-7 && w1 >= -1e-7 && w2 >= -1e-7) {
                const z = Math.fround(w0 * sz0 + w1 * sz1 + w2 * sz2);
                const pIdx = rowOffset + px;
                let depthPass = true;
                if (depthTest) {
                  const curZ = depthBuf[pIdx];
                  if (depthFuncVal === 0x0203) depthPass = z <= curZ + 1e-5; // LEQUAL
                  else if (depthFuncVal === 0x0201) depthPass = z < curZ; // LESS
                  else if (depthFuncVal === 0x0202) depthPass = Math.abs(z - curZ) <= 2e-5; // EQUAL
                  else if (depthFuncVal === 0x0204) depthPass = z > curZ; // GREATER
                  else if (depthFuncVal === 0x0206) depthPass = z >= curZ - 1e-5; // GEQUAL
                  else if (depthFuncVal === 0x0200) depthPass = false; // NEVER
                }

                if (depthPass) {
                  let r = useVCol ? ((w0 * c0.r + w1 * c1.r + w2 * c2.r) | 0) : 255;
                  let g = useVCol ? ((w0 * c0.g + w1 * c1.g + w2 * c2.g) | 0) : 255;
                  let b = useVCol ? ((w0 * c0.b + w1 * c1.b + w2 * c2.b) | 0) : 255;
                  let a = useVCol ? ((w0 * c0.a + w1 * c1.a + w2 * c2.a) | 0) : 255;

                  const wInv = w0 * invW0 + w1 * invW1 + w2 * invW2;
                  const perspW = wInv > 1e-8 ? (1.0 / wInv) : 1.0;

                  if (hasTex0) {
                    let u = (w0 * uw0 + w1 * uw1 + w2 * uw2) * perspW;
                    let v = (w0 * vw0 + w1 * vw1 + w2 * vw2) * perspW;
                    if (tex0ClampS) u = u < 0 ? 0 : (u > 0.9999 ? 0.9999 : u);
                    else u = u - Math.floor(u);
                    if (tex0ClampT) v = v < 0 ? 0 : (v > 0.9999 ? 0.9999 : v);
                    else v = v - Math.floor(v);
                    const tx = (u * tex0W) | 0;
                    const ty = (v * tex0H) | 0;
                    const tOff = ((ty * tex0W + tx) << 2);
                    r = (r * tex0Data[tOff]) >> 8;
                    g = (g * tex0Data[tOff + 1]) >> 8;
                    b = (b * tex0Data[tOff + 2]) >> 8;
                    a = (a * tex0Data[tOff + 3]) >> 8;
                  }

                  if (hasTex1) {
                    let u1p = (w0 * uw1_0 + w1 * uw1_1 + w2 * uw1_2) * perspW;
                    let v1p = (w0 * vw1_0 + w1 * vw1_1 + w2 * vw1_2) * perspW;
                    u1p = u1p < 0 ? 0 : (u1p > 0.9999 ? 0.9999 : u1p);
                    v1p = v1p < 0 ? 0 : (v1p > 0.9999 ? 0.9999 : v1p);
                    const tx1 = (u1p * tex1W) | 0;
                    const ty1 = (v1p * tex1H) | 0;
                    const tOff1 = ((ty1 * tex1W + tx1) << 2);
                    r = (r * tex1Data[tOff1]) >> 8;
                    g = (g * tex1Data[tOff1 + 1]) >> 8;
                    b = (b * tex1Data[tOff1 + 2]) >> 8;
                  }

                  let alphaPass = true;
                  if (hasAlphaTest) {
                    if (alphaMode === 1) alphaPass = a >= alphaRef255; // GEQUAL
                    else if (alphaMode === 2) alphaPass = a > alphaRef255; // GREATER
                    else if (alphaMode === 3) alphaPass = a < alphaRef255; // LESS
                    else alphaPass = a !== alphaRef255;
                  }

                  if (alphaPass) {
                    if (depthTest && depthMaskVal) {
                      depthBuf[pIdx] = z;
                    }
                    if (blendEnabled) {
                      const cOff = pIdx << 2;
                      const dr = colorBuf8[cOff];
                      const dg = colorBuf8[cOff + 1];
                      const db = colorBuf8[cOff + 2];
                      if (blendSrc === 0x0302 && blendDst === 0x0303) {
                        // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
                        const invA = 255 - a;
                        r = (r * a + dr * invA) >> 8;
                        g = (g * a + dg * invA) >> 8;
                        b = (b * a + db * invA) >> 8;
                      } else if (blendSrc === 1 && blendDst === 1) {
                        // ONE, ONE (additive)
                        r = Math.min(255, r + dr);
                        g = Math.min(255, g + dg);
                        b = Math.min(255, b + db);
                      } else if (blendSrc === 0x0302 && blendDst === 1) {
                        // SRC_ALPHA, ONE
                        r = Math.min(255, dr + ((r * a) >> 8));
                        g = Math.min(255, dg + ((g * a) >> 8));
                        b = Math.min(255, db + ((b * a) >> 8));
                      } else if (
                        (blendSrc === 0x0306 && blendDst === 0) ||
                        (blendSrc === 0 && blendDst === 0x0300)
                      ) {
                        // DST_COLOR, ZERO or ZERO, SRC_COLOR (modulate)
                        r = (r * dr) >> 8;
                        g = (g * dg) >> 8;
                        b = (b * db) >> 8;
                      } else if (blendSrc === 0x0306 && blendDst === 0x0300) {
                        // DST_COLOR, SRC_COLOR (2x modulate, used by detail textures)
                        r = Math.min(255, (r * dr) >> 7);
                        g = Math.min(255, (g * dg) >> 7);
                        b = Math.min(255, (b * db) >> 7);
                      } else if (blendSrc === 0x0306 && blendDst === 1) {
                        // DST_COLOR, ONE
                        r = Math.min(255, dr + ((r * dr) >> 8));
                        g = Math.min(255, dg + ((g * dg) >> 8));
                        b = Math.min(255, db + ((b * db) >> 8));
                      } else if (blendSrc === 0x0306 && blendDst === 0x0302) {
                        // DST_COLOR, SRC_ALPHA
                        r = Math.min(255, ((r * dr) + (dr * a)) >> 8);
                        g = Math.min(255, ((g * dg) + (dg * a)) >> 8);
                        b = Math.min(255, ((b * db) + (db * a)) >> 8);
                      } else {
                        let sr = 255, sg = 255, sb = 255;
                        if (blendSrc === 0) { sr = sg = sb = 0; }
                        else if (blendSrc === 0x0300) { sr = r; sg = g; sb = b; }
                        else if (blendSrc === 0x0301) { sr = 255 - r; sg = 255 - g; sb = 255 - b; }
                        else if (blendSrc === 0x0302) { sr = sg = sb = a; }
                        else if (blendSrc === 0x0303) { sr = sg = sb = 255 - a; }
                        else if (blendSrc === 0x0306) { sr = dr; sg = dg; sb = db; }
                        else if (blendSrc === 0x0307) { sr = 255 - dr; sg = 255 - dg; sb = 255 - db; }

                        let dfr = 0, dfg = 0, dfb = 0;
                        if (blendDst === 1) { dfr = dfg = dfb = 255; }
                        else if (blendDst === 0x0300) { dfr = r; dfg = g; dfb = b; }
                        else if (blendDst === 0x0301) { dfr = 255 - r; dfg = 255 - g; dfb = 255 - b; }
                        else if (blendDst === 0x0302) { dfr = dfg = dfb = a; }
                        else if (blendDst === 0x0303) { dfr = dfg = dfb = 255 - a; }
                        else if (blendDst === 0x0306) { dfr = dr; dfg = dg; dfb = db; }
                        else if (blendDst === 0x0307) { dfr = 255 - dr; dfg = 255 - dg; dfb = 255 - db; }

                        r = Math.min(255, (r * sr + dr * dfr) >> 8);
                        g = Math.min(255, (g * sg + dg * dfg) >> 8);
                        b = Math.min(255, (b * sb + db * dfb) >> 8);
                      }
                    }
                    colorBuf32[pIdx] = (255 << 24) | (b << 16) | (g << 8) | r;
                  }
                }
              }
              w0 += dw0dx;
              w1 += dw1dx;
            }
          }
        }
      }
      scheduleEndOfFramePresent();
    }

    const gl = {
      canvas: canvasEl,
      drawingBufferWidth: fbWidth,
      drawingBufferHeight: fbHeight,
      _boundArrayBuffer: null,
      _boundElementArrayBuffer: null,
      currentProgram: null,

      // Core WebGL1 Constants
      DEPTH_BUFFER_BIT: 0x00000100,
      STENCIL_BUFFER_BIT: 0x00000400,
      COLOR_BUFFER_BIT: 0x00004000,
      POINTS: 0x0000,
      LINES: 0x0001,
      LINE_LOOP: 0x0002,
      LINE_STRIP: 0x0003,
      TRIANGLES: 0x0004,
      TRIANGLE_STRIP: 0x0005,
      TRIANGLE_FAN: 0x0006,
      ZERO: 0,
      ONE: 1,
      SRC_COLOR: 0x0300,
      ONE_MINUS_SRC_COLOR: 0x0301,
      SRC_ALPHA: 0x0302,
      ONE_MINUS_SRC_ALPHA: 0x0303,
      DST_ALPHA: 0x0304,
      ONE_MINUS_DST_ALPHA: 0x0305,
      DST_COLOR: 0x0306,
      ONE_MINUS_DST_COLOR: 0x0307,
      FUNC_ADD: 0x8006,
      FRONT: 0x0404,
      BACK: 0x0405,
      FRONT_AND_BACK: 0x0408,
      TEXTURE_2D: 0x0DE1,
      CULL_FACE: 0x0B44,
      BLEND: 0x0BE2,
      DITHER: 0x0BD0,
      STENCIL_TEST: 0x0B90,
      DEPTH_TEST: 0x0B71,
      SCISSOR_TEST: 0x0C11,
      POLYGON_OFFSET_FILL: 0x8037,
      CW: 0x0900,
      CCW: 0x0901,
      NEVER: 0x0200,
      LESS: 0x0201,
      EQUAL: 0x0202,
      LEQUAL: 0x0203,
      GREATER: 0x0204,
      NOTEQUAL: 0x0205,
      GEQUAL: 0x0206,
      ALWAYS: 0x0207,
      BYTE: 0x1400,
      UNSIGNED_BYTE: 0x1401,
      SHORT: 0x1402,
      UNSIGNED_SHORT: 0x1403,
      INT: 0x1404,
      UNSIGNED_INT: 0x1405,
      FLOAT: 0x1406,
      ALPHA: 0x1906,
      RGB: 0x1907,
      RGBA: 0x1908,
      LUMINANCE: 0x1909,
      LUMINANCE_ALPHA: 0x190A,
      FRAGMENT_SHADER: 0x8B30,
      VERTEX_SHADER: 0x8B31,
      MAX_VERTEX_ATTRIBS: 0x8869,
      MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
      MAX_VARYING_VECTORS: 0x8DFC,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
      MAX_TEXTURE_IMAGE_UNITS: 0x8872,
      MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
      LINK_STATUS: 0x8B82,
      COMPILE_STATUS: 0x8B81,
      CURRENT_PROGRAM: 0x8B8D,
      ARRAY_BUFFER: 0x8892,
      ELEMENT_ARRAY_BUFFER: 0x8893,
      ARRAY_BUFFER_BINDING: 0x8894,
      ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
      TEXTURE0: 0x84C0,
      FRAMEBUFFER_COMPLETE: 0x8CD5,

      getContextAttributes() {
        return { alpha: false, depth: true, stencil: true, antialias: false, preserveDrawingBuffer: true };
      },
      isContextLost() { return false; },
      getSupportedExtensions() { return []; },
      getExtension() { return null; },
      getError() { return 0; },
      hint() {},
      pixelStorei() {},
      lineWidth() {},
      polygonOffset() {},
      sampleCoverage() {},
      stencilFunc() {},
      stencilFuncSeparate() {},
      stencilMask() {},
      stencilMaskSeparate() {},
      stencilOp() {},
      stencilOpSeparate() {},
      colorMask() {},
      depthRange(zNear, zFar) {
        depthNear = typeof zNear === 'number' ? zNear : 0.0;
        depthFar = typeof zFar === 'number' ? zFar : 1.0;
      },

      getParameter(pname) {
        switch (pname) {
          case 0x8894: return this._boundArrayBuffer; // ARRAY_BUFFER_BINDING
          case 0x8895: return this._boundElementArrayBuffer; // ELEMENT_ARRAY_BUFFER_BINDING
          case 0x8B8D: return this.currentProgram; // CURRENT_PROGRAM
          case 0x1F00: return 'OpenJK'; // VENDOR
          case 0x1F01: return 'OpenJK Software WebGL'; // RENDERER
          case 0x9245: return 'OpenJK'; // UNMASKED_VENDOR_WEBGL
          case 0x9246: return 'OpenJK Software WebGL'; // UNMASKED_RENDERER_WEBGL
          case 0x1F02: return 'WebGL 1.0 (OpenGL ES 2.0 OpenJK)'; // VERSION
          case 0x8B8C: return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0)'; // SHADING_LANGUAGE_VERSION
          case 0x8872: return 1; // MAX_TEXTURE_IMAGE_UNITS (keep SW renderer on 1-TMU path)
          case 0x8B4D: return 8; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
          case 0x8B4C: return 8; // MAX_VERTEX_TEXTURE_IMAGE_UNITS
          case 0x8869: return 16; // MAX_VERTEX_ATTRIBS
          case 0x8DFB: return 256; // MAX_VERTEX_UNIFORM_VECTORS
          case 0x8DFD: return 256; // MAX_FRAGMENT_UNIFORM_VECTORS
          case 0x8DFC: return 16; // MAX_VARYING_VECTORS
          case 0x0D33: return 2048; // MAX_TEXTURE_SIZE
          case 0x851C: return 2048; // MAX_CUBE_MAP_TEXTURE_SIZE
          case 0x84E8: return 2048; // MAX_RENDERBUFFER_SIZE
          case 0x0D3A: return new Int32Array([4096, 4096]); // MAX_VIEWPORT_DIMS
          case 0x86A2: return 0; // NUM_COMPRESSED_TEXTURE_FORMATS
          case 0x86A3: return new Uint32Array(0); // COMPRESSED_TEXTURE_FORMATS
          case 0x0D52: return 8; // RED_BITS
          case 0x0D53: return 8; // GREEN_BITS
          case 0x0D54: return 8; // BLUE_BITS
          case 0x0D55: return 8; // ALPHA_BITS
          case 0x0D56: return 24; // DEPTH_BITS
          case 0x0D57: return 8; // STENCIL_BITS
          case 0x0BA2: return new Int32Array([vpX, vpY, vpW, vpH]); // VIEWPORT
          case 0x0C10: return new Int32Array([scX, scY, scW, scH]); // SCISSOR_BOX
          default: return 0;
        }
      },

      getShaderPrecisionFormat() {
        return { rangeMin: 127, rangeMax: 127, precision: 23 };
      },

      viewport(x, y, w, h) {
        vpX = x | 0; vpY = y | 0; vpW = w | 0; vpH = h | 0;
        this.drawingBufferWidth = fbWidth;
        this.drawingBufferHeight = fbHeight;
      },

      scissor(x, y, w, h) {
        scX = x | 0; scY = y | 0; scW = w | 0; scH = h | 0;
      },

      enable(cap) {
        if (cap === 0x0B71) depthTest = true;
        else if (cap === 0x0BE2) blendEnabled = true;
        else if (cap === 0x0B44) cullEnabled = true;
        else if (cap === 0x0C11) scissorEnabled = true;
      },

      disable(cap) {
        if (cap === 0x0B71) depthTest = false;
        else if (cap === 0x0BE2) blendEnabled = false;
        else if (cap === 0x0B44) cullEnabled = false;
        else if (cap === 0x0C11) scissorEnabled = false;
      },

      isEnabled(cap) {
        if (cap === 0x0B71) return depthTest;
        if (cap === 0x0BE2) return blendEnabled;
        if (cap === 0x0B44) return cullEnabled;
        if (cap === 0x0C11) return scissorEnabled;
        return false;
      },

      depthFunc(fn) { depthFuncVal = fn; },
      depthMask(flag) { depthMaskVal = !!flag; },
      blendFunc(s, d) { blendSrc = s; blendDst = d; },
      blendFuncSeparate(sRGB, dRGB) { blendSrc = sRGB; blendDst = dRGB; },
      blendEquation() {},
      blendEquationSeparate() {},
      blendColor() {},
      cullFace(mode) { cullFaceMode = mode; },
      frontFace(mode) { frontFaceMode = mode; },

      clearColor(r, g, b, a) {
        clearR = Math.min(255, Math.max(0, (r * 255) | 0));
        clearG = Math.min(255, Math.max(0, (g * 255) | 0));
        clearB = Math.min(255, Math.max(0, (b * 255) | 0));
        clearA = Math.min(255, Math.max(0, (a * 255) | 0));
      },
      clearDepth(d) { clearDepthVal = d; },
      clearStencil(s) { clearStencilVal = s; },

      clear(mask) {
        if (mask & 0x00004000) {
          presentCompletedFrame();
          ensureFramebufferSize();
          const packed = (255 << 24) | (clearB << 16) | (clearG << 8) | clearR;
          colorBuf32.fill(packed);
        } else {
          ensureFramebufferSize();
        }
        if (mask & 0x00000100) {
          depthBuf.fill(clearDepthVal);
        }
      },

      createBuffer() {
        const bytes = new Uint8Array(0);
        return { id: nextObjId++, bytes, dv: new DataView(bytes.buffer) };
      },
      deleteBuffer(buf) {
        if (!buf) return;
        if (this._boundArrayBuffer === buf) this._boundArrayBuffer = null;
        if (this._boundElementArrayBuffer === buf) this._boundElementArrayBuffer = null;
        buf.bytes = new Uint8Array(0);
        buf.dv = new DataView(buf.bytes.buffer);
      },
      isBuffer(b) { return !!b; },
      bindBuffer(target, buf) {
        if (target === 0x8892) this._boundArrayBuffer = buf || null;
        else if (target === 0x8893) this._boundElementArrayBuffer = buf || null;
      },
      bufferData(target, sizeOrData) {
        const buf = target === 0x8892 ? this._boundArrayBuffer : this._boundElementArrayBuffer;
        if (!buf) return;
        if (typeof sizeOrData === 'number') {
          if (buf.bytes.byteLength < sizeOrData) {
            buf.bytes = new Uint8Array(sizeOrData);
            buf.dv = new DataView(buf.bytes.buffer);
          }
        } else if (sizeOrData && sizeOrData.buffer) {
          const src = new Uint8Array(sizeOrData.buffer, sizeOrData.byteOffset || 0, sizeOrData.byteLength);
          if (buf.bytes.byteLength < src.byteLength) {
            buf.bytes = new Uint8Array(src.byteLength);
            buf.dv = new DataView(buf.bytes.buffer);
          }
          buf.bytes.set(src, 0);
        }
      },
      bufferSubData(target, offset, data) {
        const buf = target === 0x8892 ? this._boundArrayBuffer : this._boundElementArrayBuffer;
        if (!buf || !data) return;
        const src = data.buffer
          ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
          : new Uint8Array(data);
        const needed = offset + src.byteLength;
        if (buf.bytes.byteLength < needed) {
          const grown = new Uint8Array(Math.max(needed, buf.bytes.byteLength * 2));
          grown.set(buf.bytes, 0);
          buf.bytes = grown;
          buf.dv = new DataView(buf.bytes.buffer);
        }
        buf.bytes.set(src, offset);
      },

      createTexture() {
        return { id: nextObjId++, width: 0, height: 0, data: null, wrapS: 0x2901, wrapT: 0x2901 };
      },
      deleteTexture(tex) {
        if (!tex) return;
        for (let i = 0; i < boundTextures.length; i++) {
          if (boundTextures[i] === tex) boundTextures[i] = null;
        }
        tex.data = null;
        tex.width = 0;
        tex.height = 0;
      },
      isTexture(t) { return !!t; },
      activeTexture(texEnum) {
        activeTexUnit = Math.max(0, Math.min(15, (texEnum - 0x84C0) | 0));
      },
      bindTexture(target, tex) {
        if (target === 0x0DE1) {
          boundTextures[activeTexUnit] = tex || null;
        }
      },
      texParameteri(target, pname, param) {
        const tex = boundTextures[activeTexUnit];
        if (!tex) return;
        if (pname === 0x2802) tex.wrapS = param | 0; // TEXTURE_WRAP_S
        else if (pname === 0x2803) tex.wrapT = param | 0; // TEXTURE_WRAP_T
      },
      texParameterf(target, pname, param) {
        const tex = boundTextures[activeTexUnit];
        if (!tex) return;
        if (pname === 0x2802) tex.wrapS = param | 0; // TEXTURE_WRAP_S
        else if (pname === 0x2803) tex.wrapT = param | 0; // TEXTURE_WRAP_T
      },
      generateMipmap() {},
      compressedTexImage2D() {},
      compressedTexSubImage2D() {},
      copyTexImage2D() {},
      copyTexSubImage2D() {},

      texImage2D(target, level, internalFormat, width, height, border, format, type, pixels) {
        if (target !== 0x0DE1 || level !== 0) return;
        const tex = boundTextures[activeTexUnit];
        if (!tex) return;
        const w = width | 0;
        const h = height | 0;
        if (w <= 0 || h <= 0) return;
        tex.width = w;
        tex.height = h;
        if (!tex.data || tex.data.length !== w * h * 4) {
          tex.data = new Uint8Array(w * h * 4);
        }
        if (!pixels) {
          tex.data.fill(255);
          return;
        }
        const src = pixels.buffer
          ? new Uint8Array(pixels.buffer, pixels.byteOffset || 0, pixels.byteLength)
          : pixels;
        const dst = tex.data;
        const n = w * h;
        if (format === 0x1908) { // RGBA
          dst.set(src.subarray(0, Math.min(src.length, n * 4)));
        } else if (format === 0x1907) { // RGB
          for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
            dst[k] = src[j]; dst[k + 1] = src[j + 1]; dst[k + 2] = src[j + 2]; dst[k + 3] = 255;
          }
        } else if (format === 0x1909) { // LUMINANCE
          for (let i = 0, k = 0; i < n; i++, k += 4) {
            const v = src[i];
            dst[k] = v; dst[k + 1] = v; dst[k + 2] = v; dst[k + 3] = 255;
          }
        } else if (format === 0x1906) { // ALPHA
          for (let i = 0, k = 0; i < n; i++, k += 4) {
            dst[k] = 255; dst[k + 1] = 255; dst[k + 2] = 255; dst[k + 3] = src[i];
          }
        } else if (format === 0x190A) { // LUMINANCE_ALPHA
          for (let i = 0, j = 0, k = 0; i < n; i++, j += 2, k += 4) {
            const v = src[j];
            dst[k] = v; dst[k + 1] = v; dst[k + 2] = v; dst[k + 3] = src[j + 1];
          }
        }
      },

      texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels) {
        if (target !== 0x0DE1 || level !== 0 || !pixels) return;
        const tex = boundTextures[activeTexUnit];
        if (!tex || !tex.data) return;
        const src = pixels.buffer
          ? new Uint8Array(pixels.buffer, pixels.byteOffset || 0, pixels.byteLength)
          : pixels;
        const dst = tex.data;
        const tw = tex.width;
        const w = width | 0;
        const h = height | 0;
        const xo = xoffset | 0;
        const yo = yoffset | 0;
        if (format === 0x1908) {
          for (let row = 0; row < h; row++) {
            const dy = yo + row;
            if (dy < 0 || dy >= tex.height) continue;
            const srcRowOff = row * w * 4;
            const dstRowOff = (dy * tw + xo) * 4;
            const copyBytes = Math.min(w * 4, (tw - xo) * 4);
            if (copyBytes > 0 && srcRowOff + copyBytes <= src.length) {
              dst.set(src.subarray(srcRowOff, srcRowOff + copyBytes), dstRowOff);
            }
          }
        }
      },

      createShader(type) {
        return { id: nextObjId++, type, source: '' };
      },
      deleteShader() {},
      isShader(s) { return !!s; },
      shaderSource(shader, src) {
        if (shader) shader.source = String(src || '');
      },
      compileShader() {},
      getShaderParameter() { return true; },
      getShaderInfoLog() { return ''; },
      getShaderSource(shader) { return shader ? shader.source : ''; },

      createProgram() {
        return {
          id: nextObjId++,
          shaders: [],
          vsSrc: '',
          fsSrc: '',
          attribLocations: { a_position: 0, a_normal: 1, a_color: 2, a_texCoord0: 3, a_texCoord1: 4 },
          uniforms: {},
          mvp: new Float32Array(identityMat4),
          mvpDirty: true,
          useTex0: false,
          useTex1: false,
          hasAlphaTest: false,
          alphaMode: 0,
        };
      },
      deleteProgram() {},
      isProgram(p) { return !!p; },
      attachShader(prog, sh) {
        if (!prog || !sh) return;
        prog.shaders.push(sh);
      },
      detachShader() {},
      bindAttribLocation(prog, idx, name) {
        if (prog) prog.attribLocations[name] = idx;
      },
      linkProgram(prog) {
        if (!prog) return;
        for (const sh of prog.shaders) {
          if (sh.type === 0x8B31) prog.vsSrc = sh.source || '';
          else if (sh.type === 0x8B30) prog.fsSrc = sh.source || '';
        }
        prog.useTex0 = prog.fsSrc.includes('u_texUnit0');
        prog.useTex1 = prog.fsSrc.includes('u_texUnit1');
        prog.useVertexColor = prog.fsSrc.includes('v_color');
        prog.hasAlphaTest = prog.fsSrc.includes('u_alphaTestRef');
        if (prog.hasAlphaTest) {
          if (prog.fsSrc.includes('>= u_alphaTestRef')) prog.alphaMode = 1;
          else if (prog.fsSrc.includes('> u_alphaTestRef')) prog.alphaMode = 2;
          else if (prog.fsSrc.includes('< u_alphaTestRef')) prog.alphaMode = 3;
          else prog.alphaMode = 4;
        }
      },
      validateProgram() {},
      getProgramParameter() { return true; },
      getProgramInfoLog() { return ''; },
      useProgram(prog) {
        this.currentProgram = prog || null;
      },
      getAttribLocation(prog, name) {
        if (!prog) return -1;
        return name in prog.attribLocations ? prog.attribLocations[name] : -1;
      },
      getUniformLocation(prog, name) {
        if (!prog) return null;
        if (!prog.vsSrc.includes(name) && !prog.fsSrc.includes(name)) return null;
        return { prog, name };
      },
      getUniform(prog, loc) {
        return loc && loc.prog ? loc.prog.uniforms[loc.name] : null;
      },

      uniform1f(loc, v0) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = v0; },
      uniform2f(loc, v0, v1) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1]; },
      uniform3f(loc, v0, v1, v2) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1, v2]; },
      uniform4f(loc, v0, v1, v2, v3) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1, v2, v3]; },
      uniform1i(loc, v0) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = v0; },
      uniform2i(loc, v0, v1) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1]; },
      uniform3i(loc, v0, v1, v2) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1, v2]; },
      uniform4i(loc, v0, v1, v2, v3) { if (loc && loc.prog) loc.prog.uniforms[loc.name] = [v0, v1, v2, v3]; },
      uniform1fv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = val[0]; },
      uniform2fv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Float32Array(val); },
      uniform3fv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Float32Array(val); },
      uniform4fv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Float32Array(val); },
      uniform1iv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = val[0]; },
      uniform2iv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Int32Array(val); },
      uniform3iv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Int32Array(val); },
      uniform4iv(loc, val) { if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Int32Array(val); },
      uniformMatrix2fv() {},
      uniformMatrix3fv(loc, transpose, val) {
        if (loc && loc.prog && val) loc.prog.uniforms[loc.name] = new Float32Array(val);
      },
      uniformMatrix4fv(loc, transpose, val) {
        if (!loc || !loc.prog || !val) return;
        let dst = loc.prog.uniforms[loc.name];
        if (!dst) {
          dst = new Float32Array(16);
          loc.prog.uniforms[loc.name] = dst;
        }
        dst.set(val.length === 16 ? val : val.subarray(0, 16));
        if (loc.name === 'u_modelView' || loc.name === 'u_projection') {
          loc.prog.mvpDirty = true;
        }
      },

      enableVertexAttribArray(idx) {
        if (idx >= 0 && idx < 16) attribEnabled[idx] = true;
      },
      disableVertexAttribArray(idx) {
        if (idx >= 0 && idx < 16) attribEnabled[idx] = false;
      },
      vertexAttribPointer(idx, size, type, normalized, stride, offset) {
        if (idx < 0 || idx >= 16) return;
        const a = attribs[idx];
        a.size = size;
        a.type = type;
        a.normalized = !!normalized;
        a.stride = stride | 0;
        a.offset = offset | 0;
        a.buffer = this._boundArrayBuffer;
      },
      vertexAttrib1f(idx, x) { if (idx >= 0 && idx < 16) { const d = attribDefault[idx]; d[0] = x; d[1] = 0; d[2] = 0; d[3] = 1; } },
      vertexAttrib2f(idx, x, y) { if (idx >= 0 && idx < 16) { const d = attribDefault[idx]; d[0] = x; d[1] = y; d[2] = 0; d[3] = 1; } },
      vertexAttrib3f(idx, x, y, z) { if (idx >= 0 && idx < 16) { const d = attribDefault[idx]; d[0] = x; d[1] = y; d[2] = z; d[3] = 1; } },
      vertexAttrib4f(idx, x, y, z, w) { if (idx >= 0 && idx < 16) { const d = attribDefault[idx]; d[0] = x; d[1] = y; d[2] = z; d[3] = w; } },
      vertexAttrib4fv(idx, v) { if (idx >= 0 && idx < 16 && v) { const d = attribDefault[idx]; d[0] = v[0]; d[1] = v[1]; d[2] = v[2]; d[3] = v[3]; } },

      drawElements(mode, count, type, byteOffset) {
        const ibo = this._boundElementArrayBuffer;
        if (!ibo || !ibo.bytes || count <= 0) return;
        const dv = ibo.dv;
        const maxLen = ibo.bytes.byteLength;
        const elemSize = type === 0x1405 ? 4 : type === 0x1403 ? 2 : 1;
        function readIdx(i) {
          const pos = byteOffset + i * elemSize;
          if (pos + elemSize > maxLen) return 0;
          if (elemSize === 2) return dv.getUint16(pos, true);
          if (elemSize === 4) return dv.getUint32(pos, true);
          return ibo.bytes[pos];
        }
        if (mode === 0x0004) { // TRIANGLES
          const numTris = (count / 3) | 0;
          executeDraw(numTris, (t, out) => {
            const base = t * 3;
            out[0] = readIdx(base);
            out[1] = readIdx(base + 1);
            out[2] = readIdx(base + 2);
          });
        } else if (mode === 0x0005) { // TRIANGLE_STRIP
          const numTris = Math.max(0, count - 2);
          executeDraw(numTris, (t, out) => {
            if (t & 1) {
              out[0] = readIdx(t + 1);
              out[1] = readIdx(t);
              out[2] = readIdx(t + 2);
            } else {
              out[0] = readIdx(t);
              out[1] = readIdx(t + 1);
              out[2] = readIdx(t + 2);
            }
          });
        } else if (mode === 0x0006) { // TRIANGLE_FAN
          const numTris = Math.max(0, count - 2);
          const i0 = readIdx(0);
          executeDraw(numTris, (t, out) => {
            out[0] = i0;
            out[1] = readIdx(t + 1);
            out[2] = readIdx(t + 2);
          });
        }
      },

      drawArrays(mode, first, count) {
        if (count <= 0) return;
        if (mode === 0x0004) { // TRIANGLES
          const numTris = (count / 3) | 0;
          executeDraw(numTris, (t, out) => {
            const base = first + t * 3;
            out[0] = base;
            out[1] = base + 1;
            out[2] = base + 2;
          });
        } else if (mode === 0x0005) { // TRIANGLE_STRIP
          const numTris = Math.max(0, count - 2);
          executeDraw(numTris, (t, out) => {
            const base = first + t;
            if (t & 1) {
              out[0] = base + 1;
              out[1] = base;
              out[2] = base + 2;
            } else {
              out[0] = base;
              out[1] = base + 1;
              out[2] = base + 2;
            }
          });
        } else if (mode === 0x0006) { // TRIANGLE_FAN
          const numTris = Math.max(0, count - 2);
          executeDraw(numTris, (t, out) => {
            out[0] = first;
            out[1] = first + t + 1;
            out[2] = first + t + 2;
          });
        }
      },

      flush() { presentCompletedFrame(); },
      finish() { presentCompletedFrame(); },

      readPixels(x, y, width, height, format, type, pixels) {
        if (!pixels) return;
        presentCompletedFrame();
        const w = width | 0;
        const h = height | 0;
        const xo = x | 0;
        const yo = y | 0;
        for (let row = 0; row < h; row++) {
          const srcY = fbHeight - 1 - (yo + row);
          if (srcY < 0 || srcY >= fbHeight) continue;
          for (let col = 0; col < w; col++) {
            const srcX = xo + col;
            if (srcX < 0 || srcX >= fbWidth) continue;
            const sOff = (srcY * fbWidth + srcX) * 4;
            const dOff = (row * w + col) * 4;
            pixels[dOff] = colorBuf8[sOff];
            pixels[dOff + 1] = colorBuf8[sOff + 1];
            pixels[dOff + 2] = colorBuf8[sOff + 2];
            pixels[dOff + 3] = 255;
          }
        }
      },

      createFramebuffer() { return { id: nextObjId++ }; },
      deleteFramebuffer() {},
      bindFramebuffer() {},
      checkFramebufferStatus() { return 0x8CD5; },
      framebufferRenderbuffer() {},
      framebufferTexture2D() {},
      createRenderbuffer() { return { id: nextObjId++ }; },
      deleteRenderbuffer() {},
      bindRenderbuffer() {},
      renderbufferStorage() {},
    };

    if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype) {
      Object.setPrototypeOf(gl, WebGLRenderingContext.prototype);
    }
    return gl;
  }

  // 1. Ensure #jk-canvas always initializes WebGL with preserveDrawingBuffer: true, depth: true, stencil: true, alpha: false
  // and falls back gracefully if strict attributes or hardware WebGL are blocked by the browser.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const isJKWebGL =
      this &&
      this.id === 'jk-canvas' &&
      (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl');
    if (isJKWebGL) {
      if (this.__jkActiveWebGLContext) {
        return this.__jkActiveWebGLContext;
      }
      if (state.forceSoftwareRenderer) {
        const softCtx = createSoftwareWebGLContext(this, origGetContext);
        if (softCtx) {
          console.info('[OpenJK] Software WebGL1 rasterizer forced via toggle/URL parameter.');
          this.__jkActiveWebGLContext = softCtx;
          this.__jkUsingSoftwareWebGL = true;
          this.__jkForcedSoftwareWebGL = true;
          return softCtx;
        }
      }
      const preferredAttrs = Object.assign({}, attrs || {}, {
        alpha: false,
        depth: true,
        stencil: true,
        preserveDrawingBuffer: true,
        antialias: false,
      });
      const relaxedAttrs = { preserveDrawingBuffer: true };
      const candidates = [
        ['webgl', preferredAttrs],
        ['webgl', preferredAttrs],
        ['webgl', relaxedAttrs],
        ['webgl', undefined],
        ['experimental-webgl', preferredAttrs],
        ['experimental-webgl', relaxedAttrs],
        ['webgl2', preferredAttrs],
        ['webgl2', relaxedAttrs],
      ];
      for (const [candType, candAttrs] of candidates) {
        try {
          const probeCanvas = document.createElement('canvas');
          probeCanvas.width = 4;
          probeCanvas.height = 4;
          const probeCtx = candAttrs
            ? origGetContext.call(probeCanvas, candType, candAttrs)
            : origGetContext.call(probeCanvas, candType);
          if (!probeCtx || typeof probeCtx.createShader !== 'function') {
            continue;
          }
          const dbgExt = probeCtx.getExtension('WEBGL_debug_renderer_info');
          const unmaskedRenderer = dbgExt
            ? String(probeCtx.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '')
            : '';
          if (/swiftshader|basic render driver/i.test(unmaskedRenderer)) {
            try {
              const loseExt = probeCtx.getExtension('WEBGL_lose_context');
              if (loseExt) loseExt.loseContext();
            } catch (_) {}
            break;
          }
          const testShader = probeCtx.createShader(probeCtx.VERTEX_SHADER);
          if (!testShader) continue;
          probeCtx.shaderSource(testShader, 'void main(){gl_Position=vec4(0.0);}');
          probeCtx.compileShader(testShader);
          const compiled = probeCtx.getShaderParameter(testShader, probeCtx.COMPILE_STATUS);
          probeCtx.deleteShader(testShader);
          probeCtx.clearColor(0.0, 1.0, 0.0, 1.0);
          probeCtx.clear(probeCtx.COLOR_BUFFER_BIT);
          const px = new Uint8Array(4);
          probeCtx.readPixels(0, 0, 1, 1, probeCtx.RGBA, probeCtx.UNSIGNED_BYTE, px);
          const probeOk =
            Boolean(compiled) &&
            !probeCtx.isContextLost() &&
            probeCtx.getError() === 0 &&
            px[1] >= 250;
          try {
            const loseExt = probeCtx.getExtension('WEBGL_lose_context');
            if (loseExt) loseExt.loseContext();
          } catch (_) {}
          if (!probeOk) {
            continue;
          }

          const realAttrs = candAttrs
            ? Object.assign({}, candAttrs, {
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance',
              })
            : {
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance',
              };
          const ctx =
            origGetContext.call(this, candType, realAttrs) ||
            (candAttrs ? origGetContext.call(this, candType, candAttrs) : origGetContext.call(this, candType));
          if (ctx && !ctx.isContextLost()) {
            this.__jkActiveWebGLContext = ctx;
            this.__jkUsingSoftwareWebGL = false;
            requestAnimationFrame(() => {
              try {
                resize();
              } catch (_) {}
            });
            return ctx;
          }
        } catch (_) {}
      }
      const softCtx = createSoftwareWebGLContext(this, origGetContext);
      if (softCtx) {
        console.info('[OpenJK] Hardware WebGL unavailable; using Canvas2D Software WebGL1 rasterizer.');
        this.__jkActiveWebGLContext = softCtx;
        this.__jkUsingSoftwareWebGL = true;
        requestAnimationFrame(() => {
          try {
            resize();
          } catch (_) {}
        });
        return softCtx;
      }
    }
    return origGetContext.call(this, type, attrs);
  };

  // 2. Prevent Pointer Lock on #jk-canvas unless interactive mode is explicitly enabled
  const origRequestPointerLock = Element.prototype.requestPointerLock;
  if (origRequestPointerLock) {
    Element.prototype.requestPointerLock = function () {
      if (!state.interactiveMode) {
        return;
      }
      return origRequestPointerLock.apply(this, arguments);
    };
  }

  // 3. Intercept AudioContext creation so SDL2's ScriptProcessorNode connects through a master GainNode to destination
  const OrigAudioContext =
    window.__jkOrigAudioContext || window.AudioContext || window.webkitAudioContext;
  if (OrigAudioContext) {
    window.__jkOrigAudioContext = OrigAudioContext;
    if (
      typeof window.AudioNode !== 'undefined' &&
      AudioNode.prototype &&
      !AudioNode.prototype.__jkConnectWrapped
    ) {
      AudioNode.prototype.__jkConnectWrapped = true;
      const origNodeConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (dest) {
        if (
          dest &&
          this.context &&
          this.context.__jkMasterGain &&
          this !== this.context.__jkMasterGain &&
          dest === this.context.destination
        ) {
          return origNodeConnect.call(this, this.context.__jkMasterGain);
        }
        return origNodeConnect.apply(this, arguments);
      };
    }

    const instrumentAudioContext = function (ctx) {
      if (!ctx) return ctx;
      if (!ctx.__jkInstrumented) {
        ctx.__jkInstrumented = true;
        if (!state.audioContexts.includes(ctx)) {
          state.audioContexts.push(ctx);
        }
        try {
          if (typeof ctx.createGain === 'function' && !ctx.__jkMasterGain) {
            const masterGain = ctx.createGain();
            masterGain.gain.value = state.muted ? 0.0 : state.volume;
            ctx.__jkMasterGain = masterGain;
            masterGain.connect(ctx.destination);
            state.masterGains.push(masterGain);
          }
        } catch (_) {}
        if (typeof ctx.createScriptProcessor === 'function' && !ctx.__jkScriptProcWrapped) {
          ctx.__jkScriptProcWrapped = true;
          const origCreateScriptProc = ctx.createScriptProcessor.bind(ctx);
          const spProtoDesc =
            typeof window.ScriptProcessorNode !== 'undefined' && ScriptProcessorNode.prototype
              ? Object.getOwnPropertyDescriptor(ScriptProcessorNode.prototype, 'onaudioprocess')
              : null;
          ctx.createScriptProcessor = function () {
            const node = origCreateScriptProc(...arguments);
            let rawCb = null;
            let wrappedCb = null;
            let fallbackListenerAttached = false;
            Object.defineProperty(node, 'onaudioprocess', {
              configurable: true,
              enumerable: true,
              get() {
                return rawCb;
              },
              set(fn) {
                if (typeof fn !== 'function') {
                  rawCb = null;
                  wrappedCb = null;
                  if (spProtoDesc && typeof spProtoDesc.set === 'function') {
                    spProtoDesc.set.call(node, null);
                  }
                  return;
                }
                rawCb = fn;
                wrappedCb = function (audioProcessingEvent) {
                  try {
                    const outBuf = audioProcessingEvent && audioProcessingEvent.outputBuffer;
                    if (outBuf) {
                      const numCh = outBuf.numberOfChannels || 0;
                      for (let ch = 0; ch < numCh; ch++) {
                        outBuf.getChannelData(ch).fill(0);
                      }
                    }
                    if (
                      state.paused ||
                      state.seeking ||
                      isPageHidden() ||
                      window.__jkWasmBusy > 0 ||
                      window.__jkSyncXhrDepth > 0 ||
                      (window.Module &&
                        window.Module.Asyncify &&
                        (window.Module.Asyncify.state !== 0 || window.Module.Asyncify.currData))
                    ) {
                      return;
                    }
                    fn.call(this, audioProcessingEvent);
                  } catch (_) {}
                };
                if (spProtoDesc && typeof spProtoDesc.set === 'function') {
                  spProtoDesc.set.call(node, wrappedCb);
                } else if (!fallbackListenerAttached && typeof node.addEventListener === 'function') {
                  fallbackListenerAttached = true;
                  node.addEventListener('audioprocess', function (ev) {
                    if (wrappedCb) wrappedCb.call(node, ev);
                  });
                }
              },
            });
            return node;
          };
        }
        if (typeof ctx.addEventListener === 'function' && !ctx.__jkStateListenerAttached) {
          ctx.__jkStateListenerAttached = true;
          let lastCtxState = ctx.state;
          ctx.addEventListener('statechange', () => {
            if (lastCtxState !== 'running' && ctx.state === 'running' && !state.muted) {
              window.__jkAudioJustUnlockedAt = Date.now();
            }
            lastCtxState = ctx.state;
            try {
              window.dispatchEvent(
                new CustomEvent('jkdemo:audiostate', { detail: { state: ctx.state } })
              );
            } catch (_) {}
          });
        }
      }
      if (ctx.__jkMasterGain) {
        try {
          ctx.__jkMasterGain.gain.value = state.muted ? 0.0 : state.volume;
        } catch (_) {}
      }
      if (!state.muted && typeof ctx.resume === 'function' && ctx.state !== 'running') {
        ctx.resume().catch(() => {});
      }
      return ctx;
    };

    if (window.__jkSharedAudioCtx && window.__jkSharedAudioCtx.state !== 'closed') {
      instrumentAudioContext(window.__jkSharedAudioCtx);
    }

    const WrappedAudioContext = function () {
      let ctx;
      if (
        arguments.length === 0 &&
        window.__jkSharedAudioCtx &&
        !window.__jkSharedAudioCtx.__jkClaimedBySdl &&
        window.__jkSharedAudioCtx.state !== 'closed'
      ) {
        ctx = window.__jkSharedAudioCtx;
        ctx.__jkClaimedBySdl = true;
      } else if (arguments.length === 0) {
        try {
          ctx = new OrigAudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
        } catch (_) {
          try {
            ctx = new OrigAudioContext({ latencyHint: 'interactive' });
          } catch (_2) {
            ctx = new OrigAudioContext();
          }
        }
      } else {
        ctx = new OrigAudioContext(...arguments);
      }
      return instrumentAudioContext(ctx);
    };
    WrappedAudioContext.prototype = OrigAudioContext.prototype;
    Object.setPrototypeOf(WrappedAudioContext, OrigAudioContext);
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) {
      window.webkitAudioContext = WrappedAudioContext;
    }

    const unlockAudioOnGesture = function (ev) {
      if (state.muted && !(ev && ev.isTrusted)) return;
      for (const ctx of state.audioContexts) {
        if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') {
          if (!state.muted) {
            window.__jkAudioJustUnlockedAt = Date.now();
          }
          ctx.resume().catch(() => {});
        }
      }
    };
    const gestureEvents = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'];
    for (const evt of gestureEvents) {
      window.addEventListener(evt, unlockAudioOnGesture, { passive: true, capture: true });
    }
  }

  // 4. Prevent Emscripten SDL2 from hijacking keyboard/mouse input on the host page when non-interactive
  function isEditableElement(el) {
    if (!el || typeof el !== 'object') return false;
    const tag = (el.tagName || '').toUpperCase();
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      tag === 'BUTTON' ||
      !!el.isContentEditable
    );
  }

  function shouldBlockSDLInput(ev) {
    if (!ev) return false;
    const type = ev.type || '';
    if (type === 'keydown' || type === 'keyup' || type === 'keypress') {
      if (!state.interactiveMode) return true;
      if (isEditableElement(ev.target) || isEditableElement(document.activeElement)) {
        return true;
      }
    }
    if (
      type === 'mousedown' ||
      type === 'mouseup' ||
      type === 'mousemove' ||
      type === 'wheel' ||
      type === 'mousewheel' ||
      type === 'touchstart' ||
      type === 'touchmove' ||
      type === 'touchend' ||
      type === 'touchcancel'
    ) {
      if (!state.interactiveMode) return true;
    }
    return false;
  }

  let interceptingEmscriptenListeners = false;
  const origWinAddEventListener = window.addEventListener;
  const origDocAddEventListener = document.addEventListener;
  const origElAddEventListener =
    typeof Element !== 'undefined' && Element.prototype ? Element.prototype.addEventListener : null;

  function isPageHidden() {
    return Boolean(
      typeof document !== 'undefined' &&
        (document.hidden || document.visibilityState === 'hidden')
    );
  }

  function waitForPageVisible(extraDelayMs) {
    const delay = typeof extraDelayMs === 'number' && extraDelayMs > 0 ? extraDelayMs : 0;
    if (!isPageHidden()) {
      return delay > 0 ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (isPageHidden()) return;
        settled = true;
        document.removeEventListener('visibilitychange', finish);
        window.removeEventListener('pageshow', finish);
        window.removeEventListener('focus', finish);
        if (delay > 0) {
          setTimeout(resolve, delay);
        } else {
          resolve();
        }
      };
      origDocAddEventListener.call(document, 'visibilitychange', finish);
      origWinAddEventListener.call(window, 'pageshow', finish);
      origWinAddEventListener.call(window, 'focus', finish);
    });
  }

  async function waitWithVisibleTimeout(checkFn, intervalMs, maxVisibleMs, onTick) {
    let visibleElapsed = 0;
    while (visibleElapsed < maxVisibleMs) {
      if (checkFn()) return true;
      if (typeof onTick === 'function') {
        try {
          onTick(visibleElapsed, isPageHidden());
        } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      if (!isPageHidden()) {
        visibleElapsed += intervalMs;
      }
    }
    return Boolean(checkFn());
  }

  function wrapEventTargetAdd(origFn) {
    return function (type, listener, options) {
      if (
        interceptingEmscriptenListeners &&
        typeof listener === 'function' &&
        (type === 'keydown' ||
          type === 'keyup' ||
          type === 'keypress' ||
          type === 'mousedown' ||
          type === 'mouseup' ||
          type === 'mousemove' ||
          type === 'wheel' ||
          type === 'mousewheel' ||
          type === 'touchstart' ||
          type === 'touchmove' ||
          type === 'touchend' ||
          type === 'touchcancel' ||
          type === 'blur' ||
          type === 'focusout' ||
          type === 'focus' ||
          type === 'focusin' ||
          type === 'visibilitychange' ||
          type === 'pagehide' ||
          type === 'pageshow' ||
          type === 'resize' ||
          type === 'fullscreenchange' ||
          type === 'webkitfullscreenchange')
      ) {
        const isResizeOrFullscreen =
          type === 'resize' || type === 'fullscreenchange' || type === 'webkitfullscreenchange';
        if (isResizeOrFullscreen) {
          let fnSrc = '';
          try {
            fnSrc = Function.prototype.toString.call(listener);
          } catch (_) {}
          if (!/JSEvents\.|dynCall_/.test(fnSrc)) {
            return origFn.call(this, type, listener, options);
          }
        }
        const wrapped = function (ev) {
          if (
            type === 'blur' ||
            type === 'focusout' ||
            type === 'focus' ||
            type === 'focusin' ||
            type === 'visibilitychange' ||
            type === 'pagehide' ||
            type === 'pageshow' ||
            isResizeOrFullscreen
          ) {
            // Never let Emscripten/SDL2 visibility, resize, or fullscreen callbacks invoke dynCall
            // into Wasm during Asyncify or overwrite HiDPI canvas.width/height back to 1x CSS px.
            return;
          }
          if (shouldBlockSDLInput(ev)) {
            return;
          }
          return listener.apply(this, arguments);
        };
        return origFn.call(this, type, wrapped, options);
      }
      return origFn.call(this, type, listener, options);
    };
  }

  window.addEventListener = wrapEventTargetAdd(origWinAddEventListener);
  document.addEventListener = wrapEventTargetAdd(origDocAddEventListener);
  if (origElAddEventListener && typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
    HTMLCanvasElement.prototype.addEventListener = function (type, listener, options) {
      if (this && this.id === 'jk-canvas') {
        let fnSrc = '';
        try {
          fnSrc = Function.prototype.toString.call(listener);
        } catch (_) {}
        if (/JSEvents\.|dynCall_/.test(fnSrc)) {
          return wrapEventTargetAdd(origElAddEventListener).call(this, type, listener, options);
        }
      }
      return origElAddEventListener.call(this, type, listener, options);
    };
  }

  if (
    typeof XMLHttpRequest !== 'undefined' &&
    XMLHttpRequest.prototype &&
    !XMLHttpRequest.prototype.__jkSyncWrapped
  ) {
    XMLHttpRequest.prototype.__jkSyncWrapped = true;
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, async) {
      this.__jkIsSync = async === false;
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__jkIsSync) {
        window.__jkSyncXhrDepth = (window.__jkSyncXhrDepth || 0) + 1;
        try {
          return origXhrSend.apply(this, arguments);
        } finally {
          window.__jkSyncXhrDepth = Math.max(0, (window.__jkSyncXhrDepth || 1) - 1);
        }
      }
      return origXhrSend.apply(this, arguments);
    };
  }

  // Helper to call exported Wasm C functions safely
  function callWasm(fnName, returnType, argTypes, args) {
    const mod = window.Module;
    if (!mod || !state.engineStarted) return null;
    if (mod.Asyncify && (mod.Asyncify.state !== 0 || mod.Asyncify.currData)) return null;
    window.__jkWasmBusy = (window.__jkWasmBusy || 0) + 1;
    try {
      const cName = '_' + fnName;
      if (typeof mod[cName] === 'function') {
        if (!argTypes || argTypes.length === 0) {
          const res = mod[cName]();
          if (returnType === 'string') {
            return res && typeof mod.UTF8ToString === 'function' ? mod.UTF8ToString(res) : '';
          }
          return res;
        }
        if (typeof mod.ccall === 'function') {
          return mod.ccall(fnName, returnType, argTypes, args);
        }
      }
    } catch (e) {
      console.warn('callWasm error for', fnName, e);
    } finally {
      window.__jkWasmBusy = Math.max(0, (window.__jkWasmBusy || 1) - 1);
    }
    return null;
  }

  // Write demo bytes into Emscripten MEMFS so FS_FOpenFileRead finds it under demos/<name>.dm_26
  function writeDemoToFS(fileName, uint8Bytes) {
    const mod = window.Module;
    if (!mod || !mod.FS) return false;
    const FS = mod.FS;
    const dirs = ['/base', '/base/demos', 'base', 'base/demos'];
    for (const d of dirs) {
      try {
        FS.mkdir(d);
      } catch (_) {}
    }
    const paths = ['/base/demos/' + fileName, 'base/demos/' + fileName];
    for (const p of paths) {
      try {
        FS.writeFile(p, uint8Bytes);
      } catch (e) {
        console.warn('FS.writeFile warning for', p, e);
      }
    }
    return true;
  }

  const DEFAULT_AUTOEXEC_CFG = [
    '// Fallback autoexec.cfg',
    'set cg_draw2D "1"',
    'set cg_drawTimer "1"',
    'set cg_drawRadar "0"',
    'set cg_drawTeamOverlay "1"',
    'set cg_simpleItems "1"',
    'set cg_fov "80"',
    'set cg_fovAspectAdjust "1"',
    'set cg_thirdPerson "1"',
    'set cg_shadows "1"',
    'set r_dynamiclight "1"',
    'set r_drawfog "0"',
    'set r_noportals "1"',
    'set r_picmip "0"',
    'set r_lodbias "0"',
    'set r_subdivisions "4"',
    'set r_detailtextures "1"',
    'set r_textureMode "GL_LINEAR_MIPMAP_NEAREST"',
    '',
  ].join('\n');

  function writeConfigToFS(fileName, content) {
    const mod = window.Module;
    if (!mod || !mod.FS) return false;
    const FS = mod.FS;
    const dirs = ['/base', 'base'];
    for (const d of dirs) {
      try {
        FS.mkdir(d);
      } catch (_) {}
    }
    const bytes =
      content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(String(content || ''));
    const paths = ['/base/' + fileName, 'base/' + fileName, '/' + fileName, fileName];
    for (const p of paths) {
      try {
        FS.writeFile(p, bytes);
      } catch (_) {}
    }
    return true;
  }

  async function fetchAutoexecConfig(wasmDir, querySuffix) {
    const cfg = window.JKDemoConfig || {};
    const q =
      typeof querySuffix === 'string' && querySuffix
        ? querySuffix
        : `?v=${DEFAULT_PLAYER_VERSION}`;
    const withQuery = (u) => (q && !u.includes('?') ? u + q : u);
    const candidates = [];
    if (typeof cfg.autoexecUrl === 'string' && cfg.autoexecUrl) {
      candidates.push(withQuery(cfg.autoexecUrl));
    }
    if (wasmDir) {
      const dirCandidate = withQuery(wasmDir + 'autoexec.cfg');
      if (!candidates.includes(dirCandidate)) candidates.push(dirCandidate);
    }
    const jkCandidate = withQuery('/jkplayer/autoexec.cfg');
    if (!candidates.includes(jkCandidate)) {
      candidates.push(jkCandidate);
    }
    const rootCandidate = withQuery('/autoexec.cfg');
    if (!candidates.includes(rootCandidate)) {
      candidates.push(rootCandidate);
    }
    for (const url of candidates) {
      try {
        const fetchOpts = url.includes('?') ? {} : { cache: 'no-cache' };
        if (state.preloadOnly && !state.demoLoadedOnce) {
          fetchOpts.priority = 'low';
        }
        const resp = await fetch(url, fetchOpts);
        if (resp && resp.ok) {
          const text = await resp.text();
          if (text && !/^\s*<!doctype html/i.test(text) && !/^\s*<html/i.test(text)) {
            return text;
          }
        }
      } catch (_) {}
    }
    return DEFAULT_AUTOEXEC_CFG;
  }

  async function reloadAutoexec() {
    const text = await fetchAutoexecConfig();
    writeConfigToFS(
      'autoexec.cfg',
      text +
        `\nset cg_thirdPerson "${state.thirdPerson ? '1' : '0'}"\n` +
        `set r_mapOverBrightBits "${state.overbright}"\n`
    );
    execCommand('exec autoexec.cfg');
    syncCameraModeToEngine();
    syncLightingToEngine();
    return text;
  }

  // =========================================================================
  // IndexedDB + localStorage + In-Memory Asset & Demo Cache
  // =========================================================================
  const pk3ChunkCache = new Map(); // "<pk3Name>:<chunkIdx>" -> Uint8Array
  const pk3CdCache = new Map(); // "<pk3Name>:<start>-<end>" -> Uint8Array
  const demoByteCache = new Map(); // "<fileName>" -> Uint8Array
  const idbKnownKeys = new Set(); // "chunk:<pk3Name>:<chunkIdx>" | "cd:<pk3Name>:<start>-<end>"
  const hotChunkSet = new Set(); // "<pk3Name>:<chunkIdx>"
  let idbInstance = null;
  let idbOpenPromise = null;
  let idbWriteQueue = [];
  let idbFlushTimer = 0;
  let hotChunksSaveTimer = 0;

  const STARTUP_CORE_CHUNK_KEYS = new Set([
    'chunk:assets0.pk3:2',
    'chunk:assets1.pk3:1180',
    'chunk:assets1.pk3:1188',
    'chunk:assets1.pk3:1189',
    'chunk:assets1.pk3:1205',
    'chunk:assets1.pk3:1208',
    'chunk:assets1.pk3:1209',
    'chunk:assets1.pk3:1347',
    'chunk:assets1.pk3:2487',
    'chunk:assets2.pk3:4',
    'chunk:assets3.pk3:35',
  ]);

  window.__jkPk3ChunkCache = pk3ChunkCache;
  window.__jkPk3CdCache = pk3CdCache;
  window.__jkDemoCache = demoByteCache;
  window.__jkIdbKnownKeys = idbKnownKeys;

  function loadHotChunkList() {
    try {
      const raw = localStorage.getItem(LS_HOT_CHUNKS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string' && item.includes(':')) {
            hotChunkSet.add(item);
          }
        }
      }
    } catch (_) {}
  }

  function recordHotChunk(pk3Name, chunkIdx) {
    const key = pk3Name + ':' + chunkIdx;
    if (hotChunkSet.has(key)) return;
    if (hotChunkSet.size >= 512) return;
    hotChunkSet.add(key);
    if (!hotChunksSaveTimer) {
      hotChunksSaveTimer = setTimeout(() => {
        hotChunksSaveTimer = 0;
        try {
          localStorage.setItem(LS_HOT_CHUNKS_KEY, JSON.stringify(Array.from(hotChunkSet)));
        } catch (_) {}
      }, 500);
    }
  }

  const syncFallbackChunkSet = new Set();
  let syncFallbackSaveTimer = 0;

  function loadSyncFallbackList() {
    try {
      const raw = localStorage.getItem(LS_SYNC_FALLBACK_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string' && item.includes(':')) {
            syncFallbackChunkSet.add(item);
          }
        }
      }
    } catch (_) {}
  }

  function recordSyncFallbackChunk(pk3Name, chunkIdx) {
    const key = pk3Name + ':' + chunkIdx;
    if (syncFallbackChunkSet.has(key)) return;
    if (syncFallbackChunkSet.size >= 128) return;
    syncFallbackChunkSet.add(key);
    if (!syncFallbackSaveTimer) {
      syncFallbackSaveTimer = setTimeout(() => {
        syncFallbackSaveTimer = 0;
        try {
          localStorage.setItem(
            LS_SYNC_FALLBACK_KEY,
            JSON.stringify(Array.from(syncFallbackChunkSet))
          );
        } catch (_) {}
      }, 400);
    }
  }

  loadHotChunkList();
  loadSyncFallbackList();

  function openCacheDB() {
    if (state.bypassCache || typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    if (idbInstance) return Promise.resolve(idbInstance);
    if (idbOpenPromise) return idbOpenPromise;

    idbOpenPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function (ev) {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains('chunks')) {
            db.createObjectStore('chunks', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('demos')) {
            db.createObjectStore('demos', { keyPath: 'name' });
          }
        };
        req.onsuccess = function (ev) {
          idbInstance = ev.target.result;
          resolve(idbInstance);
        };
        req.onerror = function () {
          resolve(null);
        };
        req.onblocked = function () {
          resolve(null);
        };
      } catch (_) {
        resolve(null);
      }
    });
    return idbOpenPromise;
  }

  function flushIdbWriteQueue() {
    if (idbFlushTimer) {
      clearTimeout(idbFlushTimer);
      idbFlushTimer = 0;
    }
    if (state.bypassCache || idbWriteQueue.length === 0) return Promise.resolve();
    const batch = idbWriteQueue;
    idbWriteQueue = [];
    return openCacheDB().then((db) => {
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(['chunks'], 'readwrite');
          const store = tx.objectStore('chunks');
          const now = Date.now();
          for (const item of batch) {
            store.put({ key: item.key, data: item.data, ts: now });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    });
  }

  function queueIdbChunkWrite(key, uint8Data) {
    if (state.bypassCache) return;
    idbKnownKeys.add(key);
    idbWriteQueue.push({ key, data: uint8Data });
    if (!idbFlushTimer) {
      idbFlushTimer = setTimeout(flushIdbWriteQueue, 120);
    }
  }

  async function fetchManifestWithRetry() {
    if (!state.bypassCache) {
      try {
        const cachedRaw = localStorage.getItem(LS_MANIFEST_KEY);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw);
          if (parsed && Array.isArray(parsed.pk3s) && parsed.pk3s.length > 0) {
            window.__jkPk3Manifest = parsed;
            return parsed;
          }
        }
      } catch (_) {}
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0 || isPageHidden()) {
        await waitForPageVisible(attempt * 250);
      }
      try {
        const resp = await fetch('/base/manifest.json');
        if (resp.ok) {
          const data = await resp.json();
          window.__jkPk3Manifest = data;
          if (!state.bypassCache) {
            try {
              localStorage.setItem(LS_MANIFEST_KEY, JSON.stringify(data));
            } catch (_) {}
          }
          return data;
        }
      } catch (_) {}
    }
    return window.__jkPk3Manifest || null;
  }

  async function hydrateCacheFromIndexedDB() {
    if (state.bypassCache) {
      try {
        delete window.__jkPk3Manifest;
        localStorage.removeItem(LS_MANIFEST_KEY);
      } catch (_) {}
      await fetchManifestWithRetry();
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const manifestPromise = fetchManifestWithRetry();

    const db = await openCacheDB();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(['chunks'], 'readonly');
          const chunkStore = tx.objectStore('chunks');
          const keysReq = chunkStore.getAllKeys();
          let hydratedChunks = 0;
          let hydratedBytes = 0;

          keysReq.onsuccess = function () {
            const keys = keysReq.result || [];
            for (const k of keys) {
              if (typeof k !== 'string') continue;
              idbKnownKeys.add(k);
              if (k.startsWith('cd:') || STARTUP_CORE_CHUNK_KEYS.has(k)) {
                const getReq = chunkStore.get(k);
                getReq.onsuccess = function () {
                  const row = getReq.result;
                  if (!row || !row.data) return;
                  const bytes =
                    row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
                  if (k.startsWith('chunk:')) {
                    pk3ChunkCache.set(k.slice(6), bytes);
                    hydratedChunks++;
                    hydratedBytes += bytes.byteLength;
                  } else if (k.startsWith('cd:')) {
                    pk3CdCache.set(k.slice(3), bytes);
                    hydratedBytes += bytes.byteLength;
                  }
                };
              }
            }
          };
          tx.oncomplete = function () {
            state.metrics.idbHydratedChunks += hydratedChunks;
            state.metrics.idbHydratedBytes += hydratedBytes;
            resolve();
          };
          tx.onerror = function () {
            resolve();
          };
          tx.onabort = function () {
            resolve();
          };
        } catch (_) {
          resolve();
        }
      });
    }
    await manifestPromise;
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    state.metrics.idbHydrateDurationMs = Math.round((t1 - t0) * 100) / 100;
  }

  async function loadChunksFromIdb(subKeys) {
    if (state.bypassCache || !subKeys || subKeys.length === 0) return 0;
    const needed = [];
    for (const sk of subKeys) {
      if (!pk3ChunkCache.has(sk) && idbKnownKeys.has('chunk:' + sk)) {
        needed.push(sk);
      }
    }
    if (needed.length === 0) return 0;
    const db = await openCacheDB();
    if (!db) return 0;
    return new Promise((resolve) => {
      let loadedCount = 0;
      let loadedBytes = 0;
      try {
        const tx = db.transaction(['chunks'], 'readonly');
        const store = tx.objectStore('chunks');
        for (const sk of needed) {
          const req = store.get('chunk:' + sk);
          req.onsuccess = function () {
            const row = req.result;
            if (row && row.data) {
              const bytes =
                row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
              pk3ChunkCache.set(sk, bytes);
              loadedCount++;
              loadedBytes += bytes.byteLength;
            }
          };
        }
        tx.oncomplete = function () {
          state.metrics.idbHydratedChunks += loadedCount;
          state.metrics.idbHydratedBytes += loadedBytes;
          resolve(loadedCount);
        };
        tx.onerror = function () {
          resolve(loadedCount);
        };
        tx.onabort = function () {
          resolve(loadedCount);
        };
      } catch (_) {
        resolve(0);
      }
    });
  }

  async function loadDemoFromIdb(cacheKey) {
    if (state.bypassCache || !cacheKey) return null;
    const db = await openCacheDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['demos'], 'readonly');
        const req = tx.objectStore('demos').get(cacheKey);
        req.onsuccess = function () {
          const row = req.result;
          if (row && row.data) {
            const bytes =
              row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
            demoByteCache.set(cacheKey, bytes);
            resolve(bytes);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
        tx.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Hooks called by C++ EM_JS in codemp/qcommon/files.cpp
  window.__jkPk3GetCachedCD = function (name, start, end, dst) {
    if (!window.Module || !window.Module.HEAPU8) return 0;
    const key = name + ':' + start + '-' + end;
    const expected = end - start + 1;
    const bytes = pk3CdCache.get(key);
    if (bytes) {
      const copyLen = Math.min(bytes.byteLength, expected);
      window.Module.HEAPU8.set(bytes.subarray(0, copyLen), dst);
      state.pk3CacheHits++;
      state.pk3CacheBytes += copyLen;
      return copyLen;
    }
    const cStart = (start / WASM_PK3_CHUNK_SIZE) | 0;
    const cEnd = (end / WASM_PK3_CHUNK_SIZE) | 0;
    for (let c = cStart; c <= cEnd; c++) {
      if (!pk3ChunkCache.has(name + ':' + c)) return 0;
    }
    const assembled = new Uint8Array(expected);
    let written = 0;
    for (let c = cStart; c <= cEnd && written < expected; c++) {
      const chunk = pk3ChunkCache.get(name + ':' + c);
      if (!chunk) return 0;
      const chunkByteStart = c * WASM_PK3_CHUNK_SIZE;
      const sliceStart = c === cStart ? start - chunkByteStart : 0;
      const avail = chunk.byteLength - sliceStart;
      if (avail <= 0) return 0;
      const toCopy = Math.min(avail, expected - written);
      assembled.set(chunk.subarray(sliceStart, sliceStart + toCopy), written);
      written += toCopy;
    }
    if (written < expected) return 0;
    pk3CdCache.set(key, assembled);
    queueIdbChunkWrite('cd:' + key, assembled);
    window.Module.HEAPU8.set(assembled, dst);
    state.pk3CacheHits++;
    state.pk3CacheBytes += expected;
    return expected;
  };

  window.__jkPk3HasCachedChunk = function (name, chunkIdx) {
    return pk3ChunkCache.has(name + ':' + chunkIdx);
  };

  window.__jkPk3GetCachedChunk = function (name, chunkIdx, dst, maxLen) {
    const key = name + ':' + chunkIdx;
    const bytes = pk3ChunkCache.get(key);
    if (!bytes || !window.Module || !window.Module.HEAPU8) return 0;
    const copyLen = Math.min(bytes.byteLength, maxLen);
    window.Module.HEAPU8.set(bytes.subarray(0, copyLen), dst);
    state.pk3CacheHits++;
    state.pk3CacheBytes += copyLen;
    recordHotChunk(name, chunkIdx);
    return copyLen;
  };

  window.__jkPk3OnRangeFetched = function (name, start, end, subarray, isAsyncFetch) {
    if (!subarray || subarray.byteLength === 0) return;
    if (start % WASM_PK3_CHUNK_SIZE === 0) {
      let c = (start / WASM_PK3_CHUNK_SIZE) | 0;
      for (let off = 0; off < subarray.byteLength; off += WASM_PK3_CHUNK_SIZE, c++) {
        const len = Math.min(WASM_PK3_CHUNK_SIZE, subarray.byteLength - off);
        const copy = new Uint8Array(len);
        copy.set(subarray.subarray(off, off + len));
        const mapKey = name + ':' + c;
        pk3ChunkCache.set(mapKey, copy);
        queueIdbChunkWrite('chunk:' + mapKey, copy);
        recordHotChunk(name, c);
        if (!isAsyncFetch) {
          recordSyncFallbackChunk(name, c);
        }
      }
    } else {
      const copy = new Uint8Array(subarray.byteLength);
      copy.set(subarray);
      const cdKey = name + ':' + start + '-' + end;
      pk3CdCache.set(cdKey, copy);
      queueIdbChunkWrite('cd:' + cdKey, copy);
    }
  };

  const asyncChunkPrefetchInFlight = new Set();
  const MAX_BG_PREFETCH_CONCURRENCY = 2;
  let bgPrefetchActiveCount = 0;
  const bgPrefetchPendingQueue = [];

  function pumpBgPrefetchQueue() {
    while (
      bgPrefetchActiveCount < MAX_BG_PREFETCH_CONCURRENCY &&
      bgPrefetchPendingQueue.length > 0 &&
      state.activeDemoLoadCount === 0
    ) {
      const job = bgPrefetchPendingQueue.shift();
      if (!job) continue;
      if (job.ctrl && job.ctrl.signal.aborted) {
        if (job.ctrl) bgPrefetchControllers.delete(job.ctrl);
        for (const k of job.spanKeys) asyncChunkPrefetchInFlight.delete(k);
        continue;
      }
      bgPrefetchActiveCount++;
      fetchPk3SpanIntoCache(
        job.name,
        job.cStart,
        job.cEnd,
        job.archSize,
        job.ctrl ? job.ctrl.signal : undefined
      )
        .catch(() => {})
        .finally(() => {
          bgPrefetchActiveCount = Math.max(0, bgPrefetchActiveCount - 1);
          if (job.ctrl) bgPrefetchControllers.delete(job.ctrl);
          for (const k of job.spanKeys) asyncChunkPrefetchInFlight.delete(k);
          pumpBgPrefetchQueue();
        });
    }
  }

  window.__jkPk3PrefetchSpanAsync = function (name, cStart, cEnd, archSize) {
    if (!name || typeof cStart !== 'number' || typeof cEnd !== 'number' || cStart < 0 || cEnd < cStart) return;
    const missingIdbKeys = [];
    let needsNetwork = false;
    for (let c = cStart; c <= cEnd; c++) {
      const key = name + ':' + c;
      if (pk3ChunkCache.has(key) || asyncChunkPrefetchInFlight.has(key)) continue;
      if (idbKnownKeys.has('chunk:' + key)) {
        missingIdbKeys.push(key);
      } else {
        needsNetwork = true;
      }
    }
    if (!needsNetwork && missingIdbKeys.length === 0) return;
    // Defer low-priority background network prefetches until active demo load completes
    if (needsNetwork && state.activeDemoLoadCount > 0) return;

    const spanKeys = [];
    for (let c = cStart; c <= cEnd; c++) {
      const key = name + ':' + c;
      if (!pk3ChunkCache.has(key) && !asyncChunkPrefetchInFlight.has(key)) {
        asyncChunkPrefetchInFlight.add(key);
        spanKeys.push(key);
      }
    }
    if (spanKeys.length === 0) return;

    if (!needsNetwork) {
      loadChunksFromIdb(missingIdbKeys)
        .catch(() => {})
        .finally(() => {
          for (const k of spanKeys) asyncChunkPrefetchInFlight.delete(k);
        });
      return;
    }

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) bgPrefetchControllers.add(ctrl);
    bgPrefetchPendingQueue.push({
      name,
      cStart,
      cEnd,
      archSize: archSize || 0,
      ctrl,
      spanKeys,
    });
    pumpBgPrefetchQueue();
  };

  window.__jkPk3PrefetchChunkAsync = function (name, chunkIdx, archSize) {
    window.__jkPk3PrefetchSpanAsync(name, chunkIdx, chunkIdx, archSize);
  };

  // =========================================================================
  // Server-Side Converted .mme Progressive Streaming & HTTP Range Seeking
  // =========================================================================
  const MME_CHUNK_SIZE = 524288; // 512 KB chunks
  const mmeInitCache = new Map();
  const mmeStreamState = {
    active: false,
    streamId: 0,
    baseUrl: '',
    cacheKey: '',
    fileSize: 0,
    startTime: 0,
    endTime: 0,
    totalFrames: 0,
    index: [],
    chunks: new Map(),
    inFlight: new Map(),
    bgAbort: null,
    rangeRequests: 0,
    bytesTransferred: 0,
  };
  window.__jkMmeStreamState = mmeStreamState;

  function stopMmeBackgroundStream() {
    if (mmeStreamState.bgAbort) {
      try {
        mmeStreamState.bgAbort.abort();
      } catch (_) {}
      mmeStreamState.bgAbort = null;
    }
  }

  function resetMmeStreamState() {
    stopMmeBackgroundStream();
    mmeStreamState.active = false;
    mmeStreamState.streamId++;
    mmeStreamState.baseUrl = '';
    mmeStreamState.cacheKey = '';
    mmeStreamState.fileSize = 0;
    mmeStreamState.startTime = 0;
    mmeStreamState.endTime = 0;
    mmeStreamState.totalFrames = 0;
    mmeStreamState.index = [];
    mmeStreamState.chunks.clear();
    mmeStreamState.inFlight.clear();
    const mod = window.Module;
    if (mod && state.engineStarted && typeof mod._JK_DemoSetMmeStream === 'function') {
      try {
        mod._JK_DemoSetMmeStream(0, 0, 0, 0, 0, 0, 0);
      } catch (_) {}
    }
  }

  function storeMmeRangeBytes(byteStart, bytes) {
    if (!bytes || bytes.byteLength === 0) return;
    let cIdx = Math.floor(byteStart / MME_CHUNK_SIZE);
    let off = 0;
    while (off < bytes.byteLength) {
      const len = Math.min(MME_CHUNK_SIZE, bytes.byteLength - off);
      const slice = new Uint8Array(len);
      slice.set(bytes.subarray(off, off + len));
      mmeStreamState.chunks.set(cIdx, slice);
      off += len;
      cIdx++;
    }
  }

  async function fetchMmeChunkSpanAsync(cStart, cEnd, streamId, signal) {
    if (!mmeStreamState.active || mmeStreamState.streamId !== streamId) return 0;
    if (cStart === cEnd && !signal) {
      if (mmeStreamState.chunks.has(cStart)) return 0;
      if (mmeStreamState.inFlight.has(cStart)) {
        return mmeStreamState.inFlight.get(cStart);
      }
    }
    const byteStart = cStart * MME_CHUNK_SIZE;
    let byteEnd = (cEnd + 1) * MME_CHUNK_SIZE - 1;
    if (mmeStreamState.fileSize > 0 && byteEnd >= mmeStreamState.fileSize) {
      byteEnd = mmeStreamState.fileSize - 1;
    }
    if (byteEnd < byteStart) return 0;
    const doFetch = (async () => {
      try {
        const fetchOpts = {
          headers: { Range: 'bytes=' + byteStart + '-' + byteEnd },
        };
        if (signal) {
          fetchOpts.signal = signal;
          fetchOpts.priority = 'low';
        }
        const resp = await fetch(mmeStreamState.baseUrl + '&format=mme', fetchOpts);
        if (resp.status !== 200 && resp.status !== 206) return 0;
        const ab = await resp.arrayBuffer();
        if (!mmeStreamState.active || mmeStreamState.streamId !== streamId) return 0;
        const bytes = new Uint8Array(ab);
        if (bytes.byteLength > 0) {
          storeMmeRangeBytes(byteStart, bytes);
          mmeStreamState.rangeRequests++;
          mmeStreamState.bytesTransferred += bytes.byteLength;
        }
        return bytes.byteLength;
      } catch (_) {
        return 0;
      } finally {
        if (cStart === cEnd) {
          mmeStreamState.inFlight.delete(cStart);
        }
      }
    })();
    if (cStart === cEnd && !signal) {
      mmeStreamState.inFlight.set(cStart, doFetch);
    }
    return doFetch;
  }

  function startMmeBackgroundStream(streamId) {
    stopMmeBackgroundStream();
    if (!mmeStreamState.active || mmeStreamState.fileSize <= MME_CHUNK_SIZE) return;
    const totalChunks = Math.ceil(mmeStreamState.fileSize / MME_CHUNK_SIZE);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    mmeStreamState.bgAbort = ctrl;
    let nextChunk = 1;
    const CONCURRENCY = 2;
    for (let w = 0; w < CONCURRENCY; w++) {
      (async () => {
        while (
          mmeStreamState.active &&
          mmeStreamState.streamId === streamId &&
          nextChunk < totalChunks
        ) {
          while (
            (isPageHidden() || state.activeDemoLoadCount > 0) &&
            mmeStreamState.active &&
            mmeStreamState.streamId === streamId
          ) {
            await new Promise((r) => setTimeout(r, 200));
          }
          const cIdx = nextChunk++;
          if (cIdx >= totalChunks || mmeStreamState.chunks.has(cIdx)) continue;
          await fetchMmeChunkSpanAsync(
            cIdx,
            cIdx,
            streamId,
            ctrl ? ctrl.signal : undefined
          );
        }
      })();
    }
  }

  function applyMmeStreamToWasm(meta) {
    const mod = window.Module;
    if (!mod || !state.engineStarted || typeof mod._JK_DemoSetMmeStream !== 'function') {
      return false;
    }
    const idxArr = Array.isArray(meta.index) ? meta.index : [];
    const count = idxArr.length;
    let ptr = 0;
    try {
      if (count > 0 && typeof mod._malloc === 'function') {
        ptr = mod._malloc(count * 3 * 4);
        if (ptr) {
          const heap32 = mod.HEAP32 || new Int32Array(mod.HEAPU8.buffer);
          const base = ptr >> 2;
          for (let i = 0; i < count; i++) {
            const row = idxArr[i];
            heap32[base + i * 3 + 0] = row[0] | 0;
            heap32[base + i * 3 + 1] = row[1] | 0;
            heap32[base + i * 3 + 2] = row[2] | 0;
          }
        }
      }
      mod._JK_DemoSetMmeStream(
        1,
        meta.fileSize | 0,
        meta.startTime | 0,
        meta.endTime | 0,
        meta.totalFrames | 0,
        count | 0,
        ptr | 0
      );
      return true;
    } finally {
      if (ptr && typeof mod._free === 'function') {
        mod._free(ptr);
      }
    }
  }

  window.__jkMmeRead = function (pos, dst, len) {
    if (!mmeStreamState.active || len <= 0 || !window.Module || !window.Module.HEAPU8) {
      return 0;
    }
    let copied = 0;
    let curPos = pos | 0;
    while (copied < len) {
      if (mmeStreamState.fileSize > 0 && curPos >= mmeStreamState.fileSize) {
        break;
      }
      const cIdx = (curPos / MME_CHUNK_SIZE) | 0;
      const cOff = curPos - cIdx * MME_CHUNK_SIZE;
      let chunk = mmeStreamState.chunks.get(cIdx);
      if (!chunk) {
        // On-demand synchronous HTTP Range fetch for [cIdx .. cIdx+1] so streamed seeks
        // to uncached timeline positions resolve in a single Range request.
        const byteStart = cIdx * MME_CHUNK_SIZE;
        let byteEnd = (cIdx + 2) * MME_CHUNK_SIZE - 1;
        if (mmeStreamState.fileSize > 0 && byteEnd >= mmeStreamState.fileSize) {
          byteEnd = mmeStreamState.fileSize - 1;
        }
        try {
          const xhr = new XMLHttpRequest();
          xhr.open(
            'GET',
            mmeStreamState.baseUrl + '&format=mme&start=' + byteStart + '&end=' + byteEnd,
            false
          );
          xhr.overrideMimeType('text/plain; charset=x-user-defined');
          try {
            xhr.setRequestHeader('Range', 'bytes=' + byteStart + '-' + byteEnd);
          } catch (_) {}
          xhr.send(null);
          if ((xhr.status === 200 || xhr.status === 206) && xhr.responseText) {
            const txt = xhr.responseText;
            const bytes = new Uint8Array(txt.length);
            for (let i = 0; i < txt.length; i++) {
              bytes[i] = txt.charCodeAt(i) & 0xff;
            }
            if (bytes.byteLength > 0) {
              storeMmeRangeBytes(byteStart, bytes);
              mmeStreamState.rangeRequests++;
              mmeStreamState.bytesTransferred += bytes.byteLength;
              chunk = mmeStreamState.chunks.get(cIdx);
            }
          }
        } catch (_) {}
      }
      if (!chunk || cOff >= chunk.byteLength) {
        break;
      }
      const take = Math.min(len - copied, chunk.byteLength - cOff);
      window.Module.HEAPU8.set(chunk.subarray(cOff, cOff + take), dst + copied);
      copied += take;
      curPos += take;
      // Trigger async lookahead for next chunk once playing, or during load only near chunk end
      if (
        !mmeStreamState.chunks.has(cIdx + 1) &&
        (!state.activeDemoLoadCount || cOff + take >= chunk.byteLength - 65536)
      ) {
        fetchMmeChunkSpanAsync(cIdx + 1, cIdx + 1, mmeStreamState.streamId);
      }
    }
    return copied;
  };

  function emitLoadProgress(stage, message, loadedBytes, totalBytes, percent) {
    const detail = {
      stage: String(stage || 'loading'),
      message: String(message || ''),
      loadedBytes: Number(loadedBytes || 0),
      totalBytes: Number(totalBytes || 0),
      percent:
        typeof percent === 'number' && Number.isFinite(percent)
          ? Math.max(0, Math.min(100, Math.round(percent)))
          : 0,
      updatedAt: Date.now(),
    };
    state.loadProgress = detail;
    try {
      window.dispatchEvent(new CustomEvent('jkdemo:progress', { detail }));
    } catch (_) {}
  }

  function getLoadProgress() {
    return Object.assign({}, state.loadProgress);
  }

  async function fetchBytesWithProgressAndRetry(url, opts) {
    const options = opts || {};
    const maxAttempts = options.maxAttempts || 4;
    const minBytes = options.minBytes || 16;
    const fallbackTotalBytes = options.fallbackTotalBytes || 0;
    const lowPriority = Boolean(options.lowPriority);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const validateBytes = typeof options.validateBytes === 'function' ? options.validateBytes : null;
    const signal = options.signal || null;

    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal && signal.aborted) {
        return { ok: false, status: 0, bytes: null, extra: null, aborted: true };
      }
      if (attempt > 0 || isPageHidden()) {
        const backoffMs = attempt === 0 ? 0 : Math.min(2500, 400 * Math.pow(2, attempt - 1));
        await waitForPageVisible(backoffMs);
        if (signal && signal.aborted) {
          return { ok: false, status: 0, bytes: null, extra: null, aborted: true };
        }
      }
      try {
        const fetchOpts = {};
        if (signal) fetchOpts.signal = signal;
        if (lowPriority && attempt === 0 && !state.demoLoadedOnce) {
          fetchOpts.priority = 'low';
        }
        const resp = await fetch(url, fetchOpts);
        if (!resp.ok) {
          if (
            resp.status >= 400 &&
            resp.status < 500 &&
            resp.status !== 408 &&
            resp.status !== 429
          ) {
            return { ok: false, status: resp.status, bytes: null, extra: null };
          }
          throw new Error('HTTP ' + resp.status);
        }

        const contentEncoding =
          resp.headers && typeof resp.headers.get === 'function'
            ? String(resp.headers.get('content-encoding') || '').toLowerCase()
            : '';
        const isEncoded = Boolean(contentEncoding && contentEncoding !== 'identity');
        const rawHeaderLen =
          resp.headers && typeof resp.headers.get === 'function'
            ? parseInt(resp.headers.get('x-raw-length') || '0', 10) || 0
            : 0;
        const exactExpectedLen = !isEncoded
          ? resp.headers && typeof resp.headers.get === 'function'
            ? parseInt(resp.headers.get('content-length') || '0', 10) || 0
            : 0
          : rawHeaderLen;
        const displayTotal = exactExpectedLen > 0 ? exactExpectedLen : fallbackTotalBytes;

        let bytes = null;
        if (resp.body && typeof resp.body.getReader === 'function') {
          const reader = resp.body.getReader();
          const chunks = [];
          let received = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            chunks.push(value);
            received += value.byteLength;
            if (onProgress) {
              try {
                onProgress(received, Math.max(displayTotal, received), attempt);
              } catch (_) {}
            }
          }
          if (exactExpectedLen > 0 && received < exactExpectedLen) {
            throw new Error(`Truncated stream (${received} / ${exactExpectedLen})`);
          }
          bytes = new Uint8Array(received);
          let offset = 0;
          for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
          }
        } else {
          const ab = await resp.arrayBuffer();
          if (!ab) throw new Error('Empty response buffer');
          bytes = new Uint8Array(ab);
          if (exactExpectedLen > 0 && bytes.byteLength < exactExpectedLen) {
            throw new Error(`Truncated response (${bytes.byteLength} / ${exactExpectedLen})`);
          }
          if (onProgress) {
            try {
              onProgress(
                bytes.byteLength,
                Math.max(displayTotal, bytes.byteLength),
                attempt
              );
            } catch (_) {}
          }
        }

        if (!bytes || bytes.byteLength < minBytes) {
          throw new Error(`Payload too short (${bytes ? bytes.byteLength : 0} bytes)`);
        }

        let extra = null;
        if (validateBytes) {
          extra = await validateBytes(bytes, resp);
        }
        return { ok: true, status: resp.status, bytes, extra };
      } catch (err) {
        if (signal && signal.aborted) {
          return { ok: false, status: 0, bytes: null, extra: null, aborted: true };
        }
        lastErr = err;
      }
    }
    throw lastErr || new Error('Network request failed');
  }

  async function fetchJsonWithRetry(url, maxAttempts, signal) {
    const attempts = maxAttempts || 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal && signal.aborted) return null;
      if (attempt > 0 || isPageHidden()) {
        const backoffMs = attempt === 0 ? 0 : Math.min(2000, 350 * Math.pow(2, attempt - 1));
        await waitForPageVisible(backoffMs);
        if (signal && signal.aborted) return null;
      }
      try {
        const resp = await fetch(url, signal ? { signal } : undefined);
        if (!resp.ok) {
          if (
            resp.status >= 400 &&
            resp.status < 500 &&
            resp.status !== 408 &&
            resp.status !== 429
          ) {
            return null;
          }
          continue;
        }
        return await resp.json();
      } catch (_) {
        if (signal && signal.aborted) return null;
      }
    }
    return null;
  }

  async function fetchAndValidateDemoBytes(nameOrUrl, onFirstMessageReady, signal) {
    let customLabel = '';
    if (nameOrUrl && typeof nameOrUrl === 'object') {
      customLabel = String(nameOrUrl.label || nameOrUrl.title || '').trim();
      nameOrUrl = nameOrUrl.url || nameOrUrl.demo || nameOrUrl.href || '';
    }
    if (typeof nameOrUrl !== 'string') return null;
    const raw = nameOrUrl.trim();
    if (!raw || raw.includes('\0')) return null;
    const isQueryUrl = isQueryDemoUrl(raw);
    if (!isQueryUrl && raw.includes('..')) return null;

    const fileName = normalizeDemoFileName(raw);
    if (!fileName) return null;

    const cacheKey = isQueryUrl ? raw : fileName;
    if (!demoByteCache.has(cacheKey) && !state.bypassCache) {
      await loadDemoFromIdb(cacheKey);
      if (!demoByteCache.has(cacheKey) && cacheKey !== fileName) {
        const byFile = await loadDemoFromIdb(fileName);
        if (byFile) demoByteCache.set(cacheKey, byFile);
      }
    }
    if (demoByteCache.has(cacheKey)) {
      const cachedBytes = demoByteCache.get(cacheKey);
      if (cachedBytes && cachedBytes.byteLength >= 16) {
        emitLoadProgress(
          'demo',
          'Demo ready from cache',
          cachedBytes.byteLength,
          cachedBytes.byteLength,
          35
        );
        if (typeof onFirstMessageReady === 'function') {
          try {
            onFirstMessageReady(cachedBytes);
          } catch (_) {}
        }
        return {
          fileName,
          shortName: stripDemoExt(fileName),
          sourceUrl: raw,
          label: customLabel,
          bytes: cachedBytes,
        };
      }
    }

    let url = '/demos/' + encodeURIComponent(fileName);
    if (isQueryUrl) {
      if (
        raw.startsWith('http://') ||
        raw.startsWith('https://') ||
        raw.startsWith('/')
      ) {
        url = raw;
      } else {
        url = '/' + raw.replace(/^\.\//, '');
      }
    } else if (
      raw.startsWith('http://') ||
      raw.startsWith('https://') ||
      raw.startsWith('/demos/') ||
      raw.startsWith('/base/demos/')
    ) {
      url = raw;
    }

    let firedFirstMsg = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) return null;
      if (attempt > 0 || isPageHidden()) {
        if (isPageHidden()) {
          emitLoadProgress(
            'demo',
            'Paused in background — switch back to resume...',
            0,
            0,
            Math.max(4, state.loadProgress.percent || 4)
          );
        } else if (attempt > 0) {
          emitLoadProgress(
            'demo',
            `Resuming demo download (attempt ${attempt + 1})...`,
            0,
            0,
            Math.max(4, state.loadProgress.percent || 4)
          );
        }
        await waitForPageVisible(attempt * 300);
        if (signal && signal.aborted) return null;
      }
      try {
        if (attempt === 0) {
          emitLoadProgress('demo', 'Downloading demo...', 0, 0, 4);
        }
        const resp = await fetch(url, signal ? { signal } : undefined);
        if (!resp.ok) {
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
            return null;
          }
          continue;
        }
        let headerLabel = customLabel;
        if (!headerLabel && resp.headers && typeof resp.headers.get === 'function') {
          const cd = resp.headers.get('content-disposition') || '';
          const m = cd.match(/filename="?([^";]+)"?/i);
          if (m && m[1]) headerLabel = m[1].trim();
        }
        const contentEncoding =
          resp.headers && typeof resp.headers.get === 'function'
            ? String(resp.headers.get('content-encoding') || '').toLowerCase()
            : '';
        const isEncoded = Boolean(contentEncoding && contentEncoding !== 'identity');
        const rawHeaderLen =
          resp.headers && typeof resp.headers.get === 'function'
            ? parseInt(resp.headers.get('x-raw-length') || '0', 10) || 0
            : 0;
        const contentLen = !isEncoded
          ? resp.headers && typeof resp.headers.get === 'function'
            ? parseInt(resp.headers.get('content-length') || '0', 10) || 0
            : 0
          : rawHeaderLen;

        let bytes = null;
        if (resp.body && typeof resp.body.getReader === 'function') {
          const reader = resp.body.getReader();
          const chunks = [];
          let received = 0;
          let firstMsgLen = -1;
          let lastProgressAt = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            chunks.push(value);
            received += value.byteLength;

            if (firstMsgLen === -1 && received >= 8) {
              const hdr = new Uint8Array(8);
              let hOff = 0;
              for (const c of chunks) {
                const take = Math.min(c.byteLength, 8 - hOff);
                hdr.set(c.subarray(0, take), hOff);
                hOff += take;
                if (hOff >= 8) break;
              }
              firstMsgLen = new DataView(hdr.buffer).getInt32(4, true);
            }

            if (
              !firedFirstMsg &&
              firstMsgLen > 0 &&
              firstMsgLen <= 131072 &&
              received >= 8 + firstMsgLen
            ) {
              firedFirstMsg = true;
              if (typeof onFirstMessageReady === 'function') {
                const headLen = 8 + firstMsgLen;
                const headBytes = new Uint8Array(headLen);
                let off = 0;
                for (const c of chunks) {
                  const take = Math.min(c.byteLength, headLen - off);
                  headBytes.set(c.subarray(0, take), off);
                  off += take;
                  if (off >= headLen) break;
                }
                try {
                  onFirstMessageReady(headBytes);
                } catch (_) {}
              }
            }

            const now = Date.now();
            if (now - lastProgressAt >= 80) {
              lastProgressAt = now;
              const mbLoaded = (received / (1024 * 1024)).toFixed(1);
              if (contentLen > 0) {
                const mbTotal = (contentLen / (1024 * 1024)).toFixed(1);
                const ratio = Math.min(1, received / contentLen);
                const pct = 4 + Math.round(ratio * 31);
                emitLoadProgress(
                  'demo',
                  `Downloading demo (${mbLoaded} / ${mbTotal} MB)`,
                  received,
                  contentLen,
                  pct
                );
              } else {
                emitLoadProgress(
                  'demo',
                  `Downloading demo (${mbLoaded} MB)`,
                  received,
                  0,
                  18
                );
              }
            }
          }

          if (contentLen > 0 && received < contentLen) {
            throw new Error(`Truncated demo stream (${received} / ${contentLen})`);
          }

          bytes = new Uint8Array(received);
          let offset = 0;
          for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
          }
        } else {
          const ab = await resp.arrayBuffer();
          if (!ab) continue;
          bytes = new Uint8Array(ab);
        }

        if (!bytes || bytes.byteLength < 16) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const firstMsgLen = view.getInt32(4, true);
        if (firstMsgLen <= 0 || firstMsgLen > 131072) {
          return null;
        }
        const mbFinal = (bytes.byteLength / (1024 * 1024)).toFixed(1);
        emitLoadProgress(
          'demo',
          `Downloaded demo (${mbFinal} MB)`,
          bytes.byteLength,
          bytes.byteLength,
          35
        );
        demoByteCache.set(cacheKey, bytes);
        demoByteCache.set(fileName, bytes);
        if (!state.bypassCache) {
          openCacheDB().then((db) => {
            if (!db) return;
            try {
              const tx = db.transaction(['demos'], 'readwrite');
              tx.objectStore('demos').put({ name: cacheKey, data: bytes, ts: Date.now() });
            } catch (_) {}
          });
        }
        return {
          fileName,
          shortName: stripDemoExt(fileName),
          sourceUrl: raw,
          label: headerLabel || fileName,
          bytes,
        };
      } catch (e) {
        if (signal && signal.aborted) {
          return null;
        }
        if (attempt === 3) {
          return null;
        }
      }
    }
    return null;
  }

  // Internal hook invoked by C++ CL_DemoCompleted via EM_JS
  function handleInternalDemoCompleted(demoNameFromC, serverTime, frameCount, completedCountFromC) {
    const completedDemo = normalizeDemoFileName(demoNameFromC || state.demoName) || state.demoName;
    const cLoop = callWasm('JK_DemoGetLoop', 'number', [], []);
    const looping = typeof cLoop === 'number' ? cLoop === 1 : Boolean(state.loop);
    state.demoEnded = !looping;
    const nextCount = (state.demoCompletedCount || 0) + 1;
    state.demoCompletedCount =
      typeof completedCountFromC === 'number' && completedCountFromC > nextCount
        ? completedCountFromC
        : nextCount;
    const detail = {
      demoName: completedDemo,
      serverTime: typeof serverTime === 'number' ? serverTime : getStatus().serverTime,
      frameCount: typeof frameCount === 'number' ? frameCount : getStatus().frameCount,
      completedCount: state.demoCompletedCount,
      looped: Boolean(looping),
    };

    const listeners = state.completionListeners.slice();
    for (const fn of listeners) {
      try {
        fn(detail);
      } catch (err) {
        console.error('onDemoComplete listener error:', err);
      }
    }

    try {
      window.dispatchEvent(new CustomEvent('jkdemo:ended', { detail }));
      window.dispatchEvent(new CustomEvent('jkdemo:complete', { detail }));
    } catch (_) {}
  }
  window.__jkNotifyDemoCompleted = handleInternalDemoCompleted;

  function getAudioContextState() {
    for (let i = state.audioContexts.length - 1; i >= 0; i--) {
      const ctx = state.audioContexts[i];
      if (ctx && typeof ctx.state === 'string') {
        return ctx.state;
      }
    }
    if (window.__jkSharedAudioCtx && typeof window.__jkSharedAudioCtx.state === 'string') {
      return window.__jkSharedAudioCtx.state;
    }
    return state.muted ? 'suspended' : 'running';
  }

  function getStatus() {
    const cPlaying = callWasm('JK_DemoIsPlaying', 'number', [], []);
    const cPaused = callWasm('JK_DemoIsPaused', 'number', [], []);
    const cEnded = callWasm('JK_DemoHasEnded', 'number', [], []);
    const cCompletedCount = callWasm('JK_DemoGetCompletedCount', 'number', [], []);
    const cServerTime = callWasm('JK_DemoGetServerTime', 'number', [], []);
    const cStartTimeMs = callWasm('JK_DemoGetStartTimeMs', 'number', [], []);
    const cEndTimeMs = callWasm('JK_DemoGetEndTimeMs', 'number', [], []);
    const cDurationMs = callWasm('JK_DemoGetDurationMs', 'number', [], []);
    const cCurrentTimeMs = callWasm('JK_DemoGetCurrentTimeMs', 'number', [], []);
    const cLoop = callWasm('JK_DemoGetLoop', 'number', [], []);
    const cMapName = callWasm('JK_DemoGetMapName', 'string', [], []);
    const cLoadedPackCount = callWasm('JK_DemoGetLoadedPackCount', 'number', [], []);
    const cFrameCount = callWasm('JK_DemoGetFrameCount', 'number', [], []);
    const cSpeed = callWasm('JK_DemoGetSpeed', 'number', [], []);
    const cMuted = callWasm('JK_DemoIsMuted', 'number', [], []);
    const cMusicEnabled = callWasm('JK_DemoIsMusicEnabled', 'number', [], []);
    const cVolume = callWasm('JK_DemoGetVolume', 'number', [], []);
    const cDemoName = callWasm('JK_DemoGetCurrentName', 'string', [], []);
    const cAudioActive = callWasm('JK_DemoIsAudioActive', 'number', [], []);
    const cAudioSamples = callWasm('JK_DemoGetAudioSamplesMixed', 'number', [], []);
    const cPk3Bytes = callWasm('JK_DemoGetPk3BytesTransferred', 'number', [], []);
    const cPk3Reqs = callWasm('JK_DemoGetPk3RangeRequests', 'number', [], []);

    const mod = window.Module || {};
    const pk3BytesTransferred = Math.max(
      state.pk3BytesTransferred,
      mod._pk3BytesTransferred || 0,
      typeof cPk3Bytes === 'number' && cPk3Bytes > 0 ? cPk3Bytes : 0
    );
    const pk3RangeRequests = Math.max(
      state.pk3RangeRequests,
      mod._pk3RangeRequests || 0,
      typeof cPk3Reqs === 'number' && cPk3Reqs > 0 ? cPk3Reqs : 0
    );

    const isPaused = typeof cPaused === 'number' ? cPaused === 1 : state.paused;
    const loop = typeof cLoop === 'number' ? cLoop === 1 : Boolean(state.loop);
    const demoEnded = (state.demoEnded || cEnded === 1) && !loop;
    const demoCompletedCount = Math.max(
      state.demoCompletedCount,
      typeof cCompletedCount === 'number' ? cCompletedCount : 0
    );
    const serverTime = typeof cServerTime === 'number' ? cServerTime : 0;
    const startTimeMs = typeof cStartTimeMs === 'number' ? cStartTimeMs : 0;
    const endTimeMs = typeof cEndTimeMs === 'number' ? cEndTimeMs : 0;
    const durationMs = typeof cDurationMs === 'number' ? cDurationMs : 0;
    const currentTimeMs = typeof cCurrentTimeMs === 'number' ? cCurrentTimeMs : 0;
    const loadedPackCount = typeof cLoadedPackCount === 'number' ? cLoadedPackCount : 0;
    const frameCount = typeof cFrameCount === 'number' ? cFrameCount : 0;
    if (state.engineStarted && ((cPlaying === 1 && frameCount >= 1) || demoEnded || demoCompletedCount > 0)) {
      if (!state.metrics.firstActiveFrameMs && cPlaying === 1) {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.firstActiveFrameMs = Math.round(nowMs * 100) / 100;
        state.metrics.startupDurationMs =
          Math.round((nowMs - state.metrics.bootStartMs) * 100) / 100;
        if (state.metrics.demoLoadStartMs > 0) {
          state.metrics.demoLoadDurationMs =
            Math.round((nowMs - state.metrics.demoLoadStartMs) * 100) / 100;
        }
        flushIdbWriteQueue();
      }
    }
    if (state.engineStarted && ((cPlaying === 1 && frameCount >= 10) || demoEnded || demoCompletedCount > 0)) {
      state.ready = true;
    }
    const isPlaying = cPlaying === 1 && (state.ready || frameCount >= 10);
    const speed =
      typeof cSpeed === 'number' && Number.isFinite(cSpeed) && cSpeed > 0
        ? Math.round(cSpeed * 1000) / 1000
        : state.speed;
    const muted = typeof cMuted === 'number' ? cMuted === 1 : state.muted;
    const musicEnabled =
      typeof cMusicEnabled === 'number' ? cMusicEnabled === 1 : Boolean(state.musicEnabled);
    const volume =
      typeof cVolume === 'number' && Number.isFinite(cVolume)
        ? Math.round(Math.min(1.0, Math.max(0.0, cVolume)) * 1000) / 1000
        : state.volume;

    let activeDemoName = state.demoName;
    if (typeof cDemoName === 'string' && cDemoName.trim().length > 0) {
      activeDemoName = normalizeDemoFileName(cDemoName) || state.demoName;
    }

    if (state.engineStarted && (isPlaying || demoEnded || demoCompletedCount > 0)) {
      state.ready = true;
    }

    const audioContextState = getAudioContextState();
    const audioActive =
      !muted && (cAudioActive === 1 || state.audioContexts.length > 0 || state.ready);

    const canvas = document.getElementById('jk-canvas');
    let cVpW = callWasm('JK_DemoGetViewportWidth', 'number', [], []);
    let cVpH = callWasm('JK_DemoGetViewportHeight', 'number', [], []);
    const canvasWidth = canvas ? canvas.width : 640;
    const canvasHeight = canvas ? canvas.height : 360;
    if (typeof cVpW === 'number' && cVpW > 0 && (cVpW !== canvasWidth || cVpH !== canvasHeight)) {
      callWasm('JK_DemoResizeViewport', 'number', ['number', 'number'], [canvasWidth, canvasHeight]);
      cVpW = callWasm('JK_DemoGetViewportWidth', 'number', [], []);
      cVpH = callWasm('JK_DemoGetViewportHeight', 'number', [], []);
    }
    const viewportWidth = typeof cVpW === 'number' && cVpW > 0 ? cVpW : canvasWidth;
    const viewportHeight = typeof cVpH === 'number' && cVpH > 0 ? cVpH : canvasHeight;

    return {
      ready: Boolean(state.ready),
      engineStarted: Boolean(state.engineStarted),
      prewarmed: Boolean(state.prewarmed),
      isPlaying: Boolean(isPlaying),
      isPaused: Boolean(isPaused),
      loop: Boolean(loop),
      thirdPerson: Boolean(state.thirdPerson),
      gamma: Number(state.gamma),
      overbright: Number(
        typeof callWasm('JK_DemoGetMapOverbright', 'number', [], []) === 'number' && state.engineStarted
          ? callWasm('JK_DemoGetMapOverbright', 'number', [], [])
          : state.overbright
      ),
      demoEnded: Boolean(demoEnded),
      demoCompletedCount: Number(demoCompletedCount),
      demoName: String(activeDemoName || ''),
      mapName: String(cMapName || ''),
      serverTime: Number(serverTime),
      startTimeMs: Number(startTimeMs),
      endTimeMs: Number(endTimeMs),
      durationMs: Number(durationMs),
      currentTimeMs: Number(currentTimeMs),
      loadedPackCount: Number(loadedPackCount),
      frameCount: Number(frameCount),
      timescale: Number(speed),
      speed: Number(speed),
      muted: Boolean(muted),
      musicEnabled: Boolean(musicEnabled),
      volume: Number(volume),
      audioContextState: String(audioContextState),
      audioActive: Boolean(audioActive),
      audioSamplesMixed: Number(typeof cAudioSamples === 'number' ? cAudioSamples : 0),
      pk3BytesTransferred: Number(pk3BytesTransferred),
      pk3RangeRequests: Number(pk3RangeRequests),
      pk3CacheHits: Number(state.pk3CacheHits),
      pk3CacheBytes: Number(state.pk3CacheBytes),
      canvasWidth: Number(canvasWidth),
      canvasHeight: Number(canvasHeight),
      viewportWidth: Number(viewportWidth),
      viewportHeight: Number(viewportHeight),
      devicePixelRatio: Number(window.devicePixelRatio || 1),
      renderer: canvas && canvas.__jkUsingSoftwareWebGL ? 'software' : 'webgl',
      usingSoftwareRenderer: Boolean(canvas && canvas.__jkUsingSoftwareWebGL),
      forceSoftwareRenderer: Boolean(state.forceSoftwareRenderer),
      loadProgress: Object.assign({}, state.loadProgress),
      metrics: Object.assign({}, state.metrics),
    };
  }

  function pause() {
    state.autoPausedByVisibility = false;
    state.paused = true;
    callWasm('JK_DemoPause', 'number', [], []);
    try {
      window.dispatchEvent(new CustomEvent('jkdemo:paused', { detail: { isPaused: true } }));
    } catch (_) {}
    updateUIControls();
    return true;
  }

  function resume() {
    state.autoPausedByVisibility = false;
    state.paused = false;
    callWasm('JK_DemoResume', 'number', [], []);
    if (!state.muted && !isPageHidden()) {
      unlockAudio();
    }
    try {
      window.dispatchEvent(new CustomEvent('jkdemo:resumed', { detail: { isPaused: false } }));
    } catch (_) {}
    updateUIControls();
    return false;
  }

  function play() {
    return resume();
  }

  function togglePause() {
    if (isPaused()) {
      return resume();
    } else {
      return pause();
    }
  }

  function setPaused(flag) {
    if (flag) {
      return pause();
    } else {
      return resume();
    }
  }

  function isPaused() {
    const cPaused = callWasm('JK_DemoIsPaused', 'number', [], []);
    if (typeof cPaused === 'number') {
      state.paused = cPaused === 1;
    }
    return Boolean(state.paused);
  }

  function setSpeed(multiplier) {
    const num = typeof multiplier === 'number' ? multiplier : parseFloat(multiplier);
    if (!Number.isFinite(num)) {
      return state.speed;
    }
    const clamped = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, num)) * 1000) / 1000;
    state.speed = clamped;
    callWasm('JK_DemoSetSpeed', 'number', ['number'], [clamped]);
    savePlayerPrefs();
    updateUIControls();
    return clamped;
  }

  function getSpeed() {
    const cSpeed = callWasm('JK_DemoGetSpeed', 'number', [], []);
    if (typeof cSpeed === 'number' && Number.isFinite(cSpeed) && cSpeed > 0) {
      state.speed = Math.round(cSpeed * 1000) / 1000;
    }
    return state.speed;
  }

  function setTimescale(multiplier) {
    return setSpeed(multiplier);
  }

  function getTimescale() {
    return getSpeed();
  }

  function unlockAudio() {
    const targets = state.audioContexts.slice();
    if (window.__jkSharedAudioCtx && !targets.includes(window.__jkSharedAudioCtx)) {
      targets.push(window.__jkSharedAudioCtx);
    }
    for (const ctx of targets) {
      if (!ctx || ctx.state === 'closed') continue;
      try {
        if (typeof ctx.resume === 'function' && ctx.state !== 'running') {
          ctx.resume().catch(() => {});
        }
        if (!ctx.__jkUnlockedOnce && typeof ctx.createBuffer === 'function') {
          ctx.__jkUnlockedOnce = true;
          const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          if (typeof src.start === 'function') src.start(0);
        }
      } catch (_) {}
    }
  }

  function syncAudioContextGain() {
    const effectiveGain = state.muted ? 0.0 : state.volume;
    for (const g of state.masterGains) {
      try {
        g.gain.value = effectiveGain;
      } catch (_) {}
    }
    for (const ctx of state.audioContexts) {
      if (!ctx) continue;
      try {
        if (!state.muted && typeof ctx.resume === 'function') {
          ctx.resume().catch(() => {});
        }
      } catch (_) {}
    }
  }

  function mute() {
    state.muted = true;
    callWasm('JK_DemoMute', 'number', [], []);
    syncAudioContextGain();
    savePlayerPrefs();
    updateUIControls();
    return true;
  }

  function unmute() {
    state.muted = false;
    callWasm('JK_DemoUnmute', 'number', [], []);
    if (state.volume > 0) {
      callWasm('JK_DemoSetVolume', 'number', ['number'], [state.volume]);
    }
    syncAudioContextGain();
    savePlayerPrefs();
    updateUIControls();
    return false;
  }

  function toggleMute() {
    if (isMuted()) {
      return unmute();
    } else {
      return mute();
    }
  }

  function setMuted(flag) {
    if (flag) {
      return mute();
    } else {
      return unmute();
    }
  }

  function isMuted() {
    const cMuted = callWasm('JK_DemoIsMuted', 'number', [], []);
    if (typeof cMuted === 'number') {
      state.muted = cMuted === 1;
    }
    return Boolean(state.muted);
  }

  function syncMusicToEngine() {
    callWasm('JK_DemoSetMusicEnabled', 'number', ['number'], [state.musicEnabled ? 1 : 0]);
  }

  function setMusicEnabled(enabled) {
    state.musicEnabled = Boolean(enabled);
    syncMusicToEngine();
    persistPrefField('musicEnabled', state.musicEnabled);
    savePlayerPrefs();
    updateUIControls();
    try {
      window.dispatchEvent(
        new CustomEvent('jkdemo:musicstate', {
          detail: { musicEnabled: Boolean(state.musicEnabled) },
        })
      );
      window.dispatchEvent(new CustomEvent('jkdemo:audiostate'));
    } catch (_) {}
    return state.musicEnabled;
  }

  function isMusicEnabled() {
    const cMusic = callWasm('JK_DemoIsMusicEnabled', 'number', [], []);
    if (typeof cMusic === 'number') {
      state.musicEnabled = cMusic === 1;
    }
    return Boolean(state.musicEnabled);
  }

  function toggleMusic() {
    return setMusicEnabled(!isMusicEnabled());
  }

  function setVolume(level) {
    const num = typeof level === 'number' ? level : parseFloat(level);
    if (!Number.isFinite(num)) {
      return state.volume;
    }
    const clamped = Math.round(Math.min(1.0, Math.max(0.0, num)) * 1000) / 1000;
    state.volume = clamped;
    if (clamped > 0) {
      state.savedVolume = clamped;
    }
    callWasm('JK_DemoSetVolume', 'number', ['number'], [clamped]);
    syncAudioContextGain();
    savePlayerPrefs();
    updateUIControls();
    return clamped;
  }

  function getVolume() {
    const cVol = callWasm('JK_DemoGetVolume', 'number', [], []);
    if (typeof cVol === 'number' && Number.isFinite(cVol)) {
      state.volume = Math.round(Math.min(1.0, Math.max(0.0, cVol)) * 1000) / 1000;
    }
    return state.volume;
  }

  // Inject console command(s) into the OpenJK command buffer
  function execCommand(command) {
    if (Array.isArray(command)) {
      let ok = true;
      for (const item of command) {
        if (!execCommand(item)) ok = false;
      }
      return ok;
    }
    if (typeof command !== 'string') return false;
    const trimmed = command.trim();
    if (!trimmed) return false;

    if (!state.engineStarted) {
      state.pendingCommands.push(trimmed);
      return true;
    }
    const res = callWasm('JK_DemoExecCommand', 'number', ['string'], [trimmed]);
    return res === 1;
  }

  function flushPendingCommands() {
    if (!state.engineStarted || state.pendingCommands.length === 0) return;
    const queued = state.pendingCommands.splice(0, state.pendingCommands.length);
    for (const cmd of queued) {
      callWasm('JK_DemoExecCommand', 'number', ['string'], [cmd]);
    }
  }

  const bgPrefetchControllers = new Set();
  function abortBackgroundPrefetch() {
    while (bgPrefetchPendingQueue.length > 0) {
      const job = bgPrefetchPendingQueue.shift();
      if (job) {
        for (const k of job.spanKeys) asyncChunkPrefetchInFlight.delete(k);
      }
    }
    for (const ctrl of bgPrefetchControllers) {
      try {
        ctrl.abort();
      } catch (_) {}
    }
    bgPrefetchControllers.clear();
  }

  // Async parallel range prefetching for PK3 chunks with retry & visibility awareness
  async function fetchPk3SpanIntoCache(pk3Name, cStart, cEnd, archSize, signal) {
    const byteStart = cStart * WASM_PK3_CHUNK_SIZE;
    let byteEnd = (cEnd + 1) * WASM_PK3_CHUNK_SIZE;
    if (archSize && byteEnd > archSize) byteEnd = archSize;
    if (byteEnd <= byteStart) return 0;
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal && signal.aborted) return 0;
      if (attempt > 0 || isPageHidden()) {
        const backoffMs = attempt > 0 ? 150 * Math.pow(2, attempt - 1) : 0;
        await waitForPageVisible(backoffMs);
        if (signal && signal.aborted) return 0;
      }
      try {
        const fetchOpts = {
          headers: { Range: 'bytes=' + byteStart + '-' + (byteEnd - 1) },
        };
        if (signal) {
          fetchOpts.signal = signal;
          fetchOpts.priority = 'low';
        }
        const url =
          '/base/' + pk3Name + (attempt >= 2 ? '?_r=' + attempt + '_' + byteStart : '');
        const resp = await fetch(url, fetchOpts);
        if (resp.status !== 200 && resp.status !== 206) {
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
            return 0;
          }
          continue;
        }
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        const expectedLen = byteEnd - byteStart;
        if (resp.status === 206 && archSize > 0 && bytes.byteLength < expectedLen) {
          continue;
        }
        if (bytes.byteLength > 0) {
          window.__jkPk3OnRangeFetched(pk3Name, byteStart, byteEnd - 1, bytes, true);
        }
        return bytes.byteLength;
      } catch (_) {
        if (signal && signal.aborted) return 0;
      }
    }
    return 0;
  }

  async function fetchPk3CdIntoCache(p) {
    if (!p || !p.name || !p.size || typeof p.cd_offset !== 'number' || !p.cd_size) return 0;
    const start = p.cd_offset;
    const end = p.size - 1;
    if (end < start) return 0;
    const cdKey = p.name + ':' + start + '-' + end;
    if (pk3CdCache.has(cdKey)) return 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0 || isPageHidden()) {
        await waitForPageVisible(attempt * 250);
      }
      try {
        const resp = await fetch('/base/' + p.name, {
          headers: { Range: 'bytes=' + start + '-' + end },
        });
        if (resp.status !== 200 && resp.status !== 206) continue;
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes.byteLength > 0) {
          pk3CdCache.set(cdKey, bytes);
          queueIdbChunkWrite('cd:' + cdKey, bytes);
          return bytes.byteLength;
        }
      } catch (_) {}
    }
    return 0;
  }

  let startupCorePrefetchPromise = null;
  function prefetchStartupCoreAssetsAsync() {
    if (startupCorePrefetchPromise) return startupCorePrefetchPromise;
    startupCorePrefetchPromise = (async () => {
      const manifest = window.__jkPk3Manifest || (await fetchManifestWithRetry());
      const sizeMap = new Map();
      const cdTasks = [];
      if (manifest && Array.isArray(manifest.pk3s)) {
        for (const p of manifest.pk3s) {
          if (!p || !p.name) continue;
          if (p.size) sizeMap.set(p.name, p.size);
          const isBase =
            typeof p.base_init === 'boolean'
              ? p.base_init
              : /^assets[0-3]\.pk3$/i.test(p.name);
          if (isBase && p.size > 0 && typeof p.cd_offset === 'number') {
            const cdKey = p.name + ':' + p.cd_offset + '-' + (p.size - 1);
            if (!pk3CdCache.has(cdKey)) {
              cdTasks.push(() => fetchPk3CdIntoCache(p));
            }
          }
        }
      }

      // The 11 startup chunks accessed during Com_Init() + JK_DemoPrewarmAssets():
      // assets0: [2], assets1: [1180, [1188,1189], 1205, [1208,1209], 1347, 2487], assets2: [4], assets3: [35]
      const startupSpans = [
        { pk3Name: 'assets0.pk3', cStart: 2, cEnd: 2 },
        { pk3Name: 'assets1.pk3', cStart: 1180, cEnd: 1180 },
        { pk3Name: 'assets1.pk3', cStart: 1188, cEnd: 1189 },
        { pk3Name: 'assets1.pk3', cStart: 1205, cEnd: 1205 },
        { pk3Name: 'assets1.pk3', cStart: 1208, cEnd: 1209 },
        { pk3Name: 'assets1.pk3', cStart: 1347, cEnd: 1347 },
        { pk3Name: 'assets1.pk3', cStart: 2487, cEnd: 2487 },
        { pk3Name: 'assets2.pk3', cStart: 4, cEnd: 4 },
        { pk3Name: 'assets3.pk3', cStart: 35, cEnd: 35 },
      ];
      const spanTasks = [];
      for (const s of startupSpans) {
        let missing = false;
        for (let c = s.cStart; c <= s.cEnd; c++) {
          if (!pk3ChunkCache.has(s.pk3Name + ':' + c)) {
            missing = true;
            break;
          }
        }
        if (missing) {
          const archSize = sizeMap.get(s.pk3Name) || 0;
          spanTasks.push(() =>
            fetchPk3SpanIntoCache(s.pk3Name, s.cStart, s.cEnd, archSize)
          );
        }
      }

      const allTasks = cdTasks.concat(spanTasks);
      if (allTasks.length === 0) return;

      const CONCURRENCY = 4;
      let cursor = 0;
      const workers = [];
      for (let w = 0; w < Math.min(CONCURRENCY, allTasks.length); w++) {
        workers.push(
          (async () => {
            while (cursor < allTasks.length) {
              const fn = allTasks[cursor++];
              await fn();
            }
          })()
        );
      }
      await Promise.all(workers);
      flushIdbWriteQueue();
    })().finally(() => {
      startupCorePrefetchPromise = null;
    });
    return startupCorePrefetchPromise;
  }

  function populateCommonChunkTargets(byArchive, sizeMap) {
    const manifest = window.__jkPk3Manifest;
    if (manifest && Array.isArray(manifest.pk3s)) {
      for (const p of manifest.pk3s) {
        if (p && p.name && p.size) sizeMap.set(p.name, p.size);
      }
    }
    const addTarget = (pk3Name, cIdx) => {
      const subKey = pk3Name + ':' + cIdx;
      if (pk3ChunkCache.has(subKey) || idbKnownKeys.has('chunk:' + subKey)) return;
      if (!byArchive.has(pk3Name)) byArchive.set(pk3Name, new Set());
      byArchive.get(pk3Name).add(cIdx);
    };
    const addTargetRanges = (pk3Name, ranges) => {
      for (const r of ranges) {
        if (Array.isArray(r)) {
          for (let c = r[0]; c <= r[1]; c++) addTarget(pk3Name, c);
        } else {
          addTarget(pk3Name, r);
        }
      }
    };

    // Pure MP-common sound, HUD, font, effect, and weapon chunks (no SP campaign, music, or map-specific planet folders)
    addTargetRanges('assets0.pk3', [
      2, 429, 451, 925, [1038, 1041], [1064, 1066], 1662,
      [1664, 1665], [1669, 1670], 1677, [1682, 1683], [1689, 1694], [1707, 1728],
    ]);
    addTargetRanges('assets1.pk3', [
      [1179, 1209], [1342, 1343], [1345, 1351], [1359, 1366], [1374, 1378],
      [1623, 1629], [2085, 2088], [2318, 2351], [2459, 2487],
    ]);
    addTargetRanges('assets2.pk3', [4]);
    addTargetRanges('assets3.pk3', [35]);
  }

  async function prefetchCommonChunksAsync() {
    if (state.bypassCache) return;
    const sizeMap = new Map();
    const byArchive = new Map();
    populateCommonChunkTargets(byArchive, sizeMap);

    const spans = [];
    for (const [pk3Name, idxSet] of byArchive.entries()) {
      const sorted = Array.from(idxSet).sort((a, b) => a - b);
      let i = 0;
      while (i < sorted.length) {
        const cStart = sorted[i];
        let cEnd = cStart;
        while (
          i + 1 < sorted.length &&
          sorted[i + 1] === cEnd + 1 &&
          cEnd - cStart < 3
        ) {
          i++;
          cEnd = sorted[i];
        }
        spans.push({ pk3Name, cStart, cEnd, archSize: sizeMap.get(pk3Name) || 0 });
        i++;
      }
    }

    // Run with low background concurrency (2 parallel range fetches, <=1 MB each),
    // pausing/aborting immediately while a demo load is active or page is hidden.
    const CONCURRENCY = 2;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, spans.length); w++) {
      workers.push(
        (async () => {
          while (cursor < spans.length) {
            while (state.activeDemoLoadCount > 0 || isPageHidden()) {
              await new Promise((r) => setTimeout(r, 200));
            }
            if (cursor >= spans.length) break;
            const item = spans[cursor++];
            let allCached = true;
            for (let c = item.cStart; c <= item.cEnd; c++) {
              const subKey = item.pk3Name + ':' + c;
              if (!pk3ChunkCache.has(subKey) && !idbKnownKeys.has('chunk:' + subKey)) {
                allCached = false;
                break;
              }
            }
            if (allCached) continue;
            const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
            if (ctrl) bgPrefetchControllers.add(ctrl);
            try {
              const got = await fetchPk3SpanIntoCache(
                item.pk3Name,
                item.cStart,
                item.cEnd,
                item.archSize,
                ctrl ? ctrl.signal : undefined
              );
              if (got === 0 && ctrl && ctrl.signal.aborted) {
                cursor = Math.max(0, cursor - 1);
              }
            } finally {
              if (ctrl) bgPrefetchControllers.delete(ctrl);
            }
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  let prewarmPromise = null;
  function prewarmEngineInBackground() {
    if (state.prewarmed) return Promise.resolve(true);
    if (prewarmPromise) return prewarmPromise;

    prewarmPromise = (async () => {
      const booted = await ensureEngineBooted({ background: !state.demoLoadedOnce });
      if (!booted) {
        prewarmPromise = null;
        return false;
      }
      await waitWithVisibleTimeout(
        () => state.engineStarted && callWasm('JK_DemoIsReady', 'number', [], []) === 1,
        40,
        30000
      );
      if (!state.engineStarted) {
        prewarmPromise = null;
        return false;
      }

      let res = 0;
      for (let attempt = 0; attempt < 25; attempt++) {
        res = callWasm('JK_DemoPrewarmAssets', 'number', [], []);
        if (res === 1) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      if (res === 1) {
        state.prewarmed = true;
        state.ready = true;
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.prewarmCompleteMs = Math.round(nowMs * 100) / 100;
        const conn = typeof navigator !== 'undefined' && navigator.connection;
        const isConstrainedLink = Boolean(
          (conn && (conn.saveData || /^(?:slow-2g|2g|3g)$/i.test(String(conn.effectiveType || '')))) ||
            (typeof window.matchMedia === 'function' &&
              window.matchMedia('(pointer: coarse)').matches)
        );
        if (!isConstrainedLink && state.activeDemoLoadCount === 0 && !state.demoLoadedOnce) {
          prefetchCommonChunksAsync()
            .then(() => {
              flushIdbWriteQueue();
            })
            .catch(() => {});
        }
        flushIdbWriteQueue();
        try {
          window.dispatchEvent(
            new CustomEvent('jkdemo:prewarmed', { detail: getStartupMetrics() })
          );
        } catch (_) {}
      } else {
        prewarmPromise = null;
      }
      return state.prewarmed;
    })();
    return prewarmPromise;
  }

  async function executePlanPass(shortName, labelPrefix, basePct, spanPct, silentProgress, includeCommonChunks) {
    const rawPlan = callWasm('JK_DemoPlanLoadChunks', 'string', ['string'], [shortName]);
    if (!rawPlan && !includeCommonChunks) {
      return { bspReady: 1, fetchedSpans: 0, fetchedBytes: 0, hydratedFromIdb: 0, mapName: '' };
    }
    let plan = null;
    if (rawPlan) {
      try {
        plan = JSON.parse(rawPlan);
      } catch (_) {}
    }
    const rawSpans = plan && Array.isArray(plan.spans) ? plan.spans : [];
    const mapName = String((plan && plan.mapName) || '');
    const candidateByArchive = new Map();
    const sizeMap = new Map();

    if (includeCommonChunks) {
      populateCommonChunkTargets(candidateByArchive, sizeMap);
    }

    for (const row of rawSpans) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const pk3Name = String(row[0] || '');
      const cStart = Number(row[1]);
      const cEnd = Number(row[2]);
      const archSize = Number(row[3] || 0);
      if (!pk3Name || !Number.isFinite(cStart) || !Number.isFinite(cEnd) || cEnd < cStart) continue;
      if (archSize > 0) sizeMap.set(pk3Name, archSize);
      for (let c = cStart; c <= cEnd; c++) {
        if (!pk3ChunkCache.has(pk3Name + ':' + c)) {
          if (!candidateByArchive.has(pk3Name)) candidateByArchive.set(pk3Name, new Set());
          candidateByArchive.get(pk3Name).add(c);
        }
      }
    }

    // Hydrate any already-persisted chunks for this demo (plus any prior sync-fallback chunks) from IndexedDB on demand
    const toHydrateSet = new Set();
    for (const [pk3Name, idxSet] of candidateByArchive.entries()) {
      for (const c of idxSet) {
        const subKey = pk3Name + ':' + c;
        if (!pk3ChunkCache.has(subKey) && idbKnownKeys.has('chunk:' + subKey)) {
          toHydrateSet.add(subKey);
        }
      }
    }
    for (const subKey of syncFallbackChunkSet) {
      if (!pk3ChunkCache.has(subKey) && idbKnownKeys.has('chunk:' + subKey)) {
        toHydrateSet.add(subKey);
      }
    }
    const toHydrateFromIdb = Array.from(toHydrateSet);
    const hydratedFromIdb =
      toHydrateFromIdb.length > 0 ? await loadChunksFromIdb(toHydrateFromIdb) : 0;

    // Only issue HTTP Range requests for chunks still absent from pk3ChunkCache
    const byArchive = new Map();
    for (const [pk3Name, idxSet] of candidateByArchive.entries()) {
      for (const c of idxSet) {
        if (!pk3ChunkCache.has(pk3Name + ':' + c)) {
          if (!byArchive.has(pk3Name)) byArchive.set(pk3Name, new Set());
          byArchive.get(pk3Name).add(c);
        }
      }
    }

    const spans = [];
    let totalEstimatedBytes = 0;
    for (const [pk3Name, idxSet] of byArchive.entries()) {
      const archSize = sizeMap.get(pk3Name) || 0;
      const sorted = Array.from(idxSet).sort((a, b) => a - b);
      let i = 0;
      while (i < sorted.length) {
        const subStart = sorted[i];
        let subEnd = subStart;
        while (
          i + 1 < sorted.length &&
          sorted[i + 1] === subEnd + 1 &&
          subEnd - subStart < 15
        ) {
          i++;
          subEnd = sorted[i];
        }
        const bStart = subStart * WASM_PK3_CHUNK_SIZE;
        let bEnd = (subEnd + 1) * WASM_PK3_CHUNK_SIZE;
        if (archSize > 0 && bEnd > archSize) bEnd = archSize;
        const estBytes = Math.max(0, bEnd - bStart);
        if (estBytes > 0) {
          spans.push({ pk3Name, cStart: subStart, cEnd: subEnd, archSize, estBytes });
          totalEstimatedBytes += estBytes;
        }
        i++;
      }
    }

    if (spans.length === 0) {
      return {
        bspReady: Number((plan && plan.bspReady) || 0),
        fetchedSpans: 0,
        fetchedBytes: 0,
        hydratedFromIdb,
        mapName,
      };
    }

    let loadedBytes = 0;
    const stageLabel = mapName ? `${labelPrefix} (${mapName})` : labelPrefix;
    if (!silentProgress) {
      const mbTotal = (totalEstimatedBytes / (1024 * 1024)).toFixed(1);
      emitLoadProgress(
        'assets',
        `${stageLabel} (0.0 / ${mbTotal} MB)`,
        0,
        totalEstimatedBytes,
        basePct
      );
    }

    const CONCURRENCY = 4;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, spans.length); w++) {
      workers.push(
        (async () => {
          while (cursor < spans.length) {
            const item = spans[cursor++];
            const got = await fetchPk3SpanIntoCache(
              item.pk3Name,
              item.cStart,
              item.cEnd,
              item.archSize
            );
            loadedBytes += got > 0 ? got : item.estBytes;
            if (!silentProgress && totalEstimatedBytes > 0) {
              const clampedLoaded = Math.min(loadedBytes, totalEstimatedBytes);
              const mbLoaded = (clampedLoaded / (1024 * 1024)).toFixed(1);
              const mbTotal = (totalEstimatedBytes / (1024 * 1024)).toFixed(1);
              const ratio = Math.min(1, clampedLoaded / totalEstimatedBytes);
              const pct = basePct + Math.round(ratio * spanPct);
              emitLoadProgress(
                'assets',
                `${stageLabel} (${mbLoaded} / ${mbTotal} MB)`,
                clampedLoaded,
                totalEstimatedBytes,
                pct
              );
            }
          }
        })()
      );
    }
    await Promise.all(workers);
    await flushIdbWriteQueue();
    return {
      bspReady: Number((plan && plan.bspReady) || 0),
      fetchedSpans: spans.length,
      fetchedBytes: loadedBytes,
      hydratedFromIdb,
      mapName,
    };
  }

  async function planAndPrefetchDemoChunks(shortName) {
    if (!state.engineStarted) return;
    // Up to 4 passes:
    // Pass 1: Exact MP-common assets + custom PK3s + BSP header & lumps + configstring models/sounds/player skins
    // Pass 2: BSP textures/shaders & static models (once BSP chunks & player .skin/.cfg files are in cache)
    // Pass 3+: Any textures referenced by static .md3 models or custom PK3s mounted in earlier passes
    for (let pass = 0; pass < 4; pass++) {
      const label = pass === 0 ? 'Loading map & models' : 'Loading map textures & sounds';
      const basePct = pass === 0 ? 35 : 58;
      const spanPct = pass === 0 ? 23 : 20;
      const res = await executePlanPass(shortName, label, basePct, spanPct, false, false);
      if (res.bspReady === 1 && res.fetchedSpans === 0 && res.hydratedFromIdb === 0) {
        break;
      }
    }
  }

  function getCacheStats() {
    let chunkBytes = 0;
    for (const b of pk3ChunkCache.values()) {
      chunkBytes += b.byteLength;
    }
    let cdBytes = 0;
    for (const b of pk3CdCache.values()) {
      cdBytes += b.byteLength;
    }
    let demoBytes = 0;
    for (const b of demoByteCache.values()) {
      demoBytes += b.byteLength;
    }
    return {
      cachedChunks: pk3ChunkCache.size,
      cachedChunkBytes: chunkBytes,
      idbKnownChunks: idbKnownKeys.size,
      cachedCentralDirs: pk3CdCache.size,
      cachedCentralDirBytes: cdBytes,
      cachedDemos: demoByteCache.size,
      cachedDemoBytes: demoBytes,
      hotChunksRecorded: hotChunkSet.size,
      pk3CacheHits: state.pk3CacheHits,
      pk3CacheBytes: state.pk3CacheBytes,
      pk3NetworkRequests: getStatus().pk3RangeRequests,
      pk3NetworkBytes: getStatus().pk3BytesTransferred,
    };
  }

  async function clearCache() {
    pk3ChunkCache.clear();
    pk3CdCache.clear();
    demoByteCache.clear();
    mmeInitCache.clear();
    idbKnownKeys.clear();
    hotChunkSet.clear();
    try {
      localStorage.removeItem(LS_MANIFEST_KEY);
      localStorage.removeItem(LS_HOT_CHUNKS_KEY);
      delete window.__jkPk3Manifest;
    } catch (_) {}
    const db = await openCacheDB();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(['chunks', 'demos'], 'readwrite');
          tx.objectStore('chunks').clear();
          tx.objectStore('demos').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }
    return true;
  }

  function getStartupMetrics() {
    const st = getStatus();
    return Object.assign({}, state.metrics, {
      engineStarted: state.engineStarted,
      prewarmed: state.prewarmed,
      preloadOnly: state.preloadOnly,
      pk3NetworkRequests: st.pk3RangeRequests,
      pk3NetworkBytes: st.pk3BytesTransferred,
      pk3CacheHits: state.pk3CacheHits,
      pk3CacheBytes: state.pk3CacheBytes,
    });
  }

  function loadDemo(nameOrUrl) {
    state.demoLoadedOnce = true;
    const myLoadSeq = (state.currentLoadSeq = (state.currentLoadSeq || 0) + 1);
    if (state.activeLoadAbortCtrl) {
      try {
        state.activeLoadAbortCtrl.abort();
      } catch (_) {}
      state.activeLoadAbortCtrl = null;
    }
    state.pendingDemoLoads = (state.pendingDemoLoads || 0) + 1;
    emitLoadProgress('demo', 'Loading demo...', 0, 0, 1);
    let decrementedPending = false;
    const decPending = () => {
      if (!decrementedPending) {
        decrementedPending = true;
        state.pendingDemoLoads = Math.max(0, (state.pendingDemoLoads || 1) - 1);
      }
    };

    const runLoad = async () => {
      if (myLoadSeq !== state.currentLoadSeq) {
        decPending();
        return false;
      }
      const loadAbortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      state.activeLoadAbortCtrl = loadAbortCtrl;
      const loadSignal = loadAbortCtrl ? loadAbortCtrl.signal : null;
      const isSuperseded = () =>
        myLoadSeq !== state.currentLoadSeq || Boolean(loadSignal && loadSignal.aborted);

      state.activeDemoLoadCount = (state.activeDemoLoadCount || 0) + 1;
      abortBackgroundPrefetch();
      let earlyPeekPromise = null;
      try {
        const loadStartNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.demoLoadStartMs = Math.round(loadStartNow * 100) / 100;
        state.metrics.firstActiveFrameMs = 0;
        state.metrics.demoLoadDurationMs = 0;
        emitLoadProgress('demo', 'Downloading demo...', 0, 0, 2);

        if (!state.engineStarted) {
          ensureEngineBooted({ background: false }).catch(() => {});
        }

        const onFirstMessageReady = (headBytes) => {
          if (
            !state.engineStarted ||
            callWasm('JK_DemoIsReady', 'number', [], []) !== 1
          ) {
            return;
          }
          try {
            writeDemoToFS('__peek.dm_26', headBytes);
            earlyPeekPromise = executePlanPass(
              '__peek',
              'Prefetching map',
              20,
              15,
              true
            ).catch(() => {});
          } catch (_) {}
        };

        let rawInput = nameOrUrl;
        let customLabel = '';
        if (rawInput && typeof rawInput === 'object') {
          customLabel = String(rawInput.label || rawInput.title || '').trim();
          rawInput = rawInput.url || rawInput.demo || rawInput.href || '';
        }
        const rawStr = typeof rawInput === 'string' ? rawInput.trim() : '';
        const canUseMmeStream = isQueryDemoUrl(rawStr);
        let usedMmeStream = false;
        let mmeStreamInitBytes = null;
        let mmeStreamUrl = '';
        let mmeStreamCached = false;
        let mmeFetchFailed = false;
        let mmeMetaPromise = null;
        let activeStreamId = 0;
        let demoData = null;
        let latestAutoexec = null;

        if (canUseMmeStream) {
          const fileName = normalizeDemoFileName(rawStr);
          const shortName = fileName ? stripDemoExt(fileName) : 'current';
          const streamUrl =
            rawStr.startsWith('http://') ||
            rawStr.startsWith('https://') ||
            rawStr.startsWith('/')
              ? rawStr
              : '/' + rawStr.replace(/^\.\//, '');
          const autoexecPromise = fetchAutoexecConfig();
          const cachedMme = !state.bypassCache ? mmeInitCache.get(rawStr) : null;

          let initBytes = cachedMme && cachedMme.initBytes ? cachedMme.initBytes : null;
          if (cachedMme && cachedMme.meta) {
            mmeMetaPromise = Promise.resolve(cachedMme.meta);
          } else {
            mmeMetaPromise = fetchJsonWithRetry(
              streamUrl + '&format=mme_meta',
              3,
              loadSignal
            ).then(
              (metaObj) => {
                if (metaObj && metaObj.fileSize && Array.isArray(metaObj.index)) {
                  const existing = mmeInitCache.get(rawStr);
                  if (existing) {
                    existing.meta = metaObj;
                  }
                }
                return metaObj;
              }
            );
          }

          if (!initBytes) {
            let lastInitProgressAt = 0;
            try {
              const initRes = await fetchBytesWithProgressAndRetry(
                streamUrl + '&format=mme_init',
                {
                  maxAttempts: 3,
                  minBytes: 16,
                  fallbackTotalBytes: MME_CHUNK_SIZE,
                  lowPriority: false,
                  signal: loadSignal,
                  onProgress: (loaded, total, attempt) => {
                    if (isSuperseded()) return;
                    const now = Date.now();
                    if (now - lastInitProgressAt < 80 && loaded < total) return;
                    lastInitProgressAt = now;
                    const kbLoaded = Math.round(loaded / 1024);
                    const kbTotal = total > 0 ? Math.round(total / 1024) : 0;
                    const ratio = total > 0 ? Math.min(1, loaded / total) : 0.5;
                    const pct = 2 + Math.round(ratio * 16);
                    const retryPrefix = attempt > 0 ? `Retrying demo (${attempt + 1}/3): ` : 'Downloading demo ';
                    const sizeLabel =
                      kbTotal > 0 ? `(${kbLoaded} / ${kbTotal} KB)...` : `(${kbLoaded} KB)...`;
                    emitLoadProgress('demo', retryPrefix + sizeLabel, loaded, total, pct);
                  },
                }
              );
              if (isSuperseded() || (initRes && initRes.aborted)) {
                return false;
              }
              if (initRes && initRes.ok && initRes.bytes) {
                initBytes = initRes.bytes;
              }
            } catch (_) {
              if (isSuperseded()) return false;
              mmeFetchFailed = true;
            }
          }
          if (isSuperseded()) return false;

          if (initBytes && initBytes.byteLength >= 15) {
            const hdrStr = String.fromCharCode.apply(null, initBytes.subarray(0, 15));
            if (hdrStr === 'jaMME 1.11 Demo') {
              if (!mmeInitCache.has(rawStr)) {
                if (mmeInitCache.size >= 3) {
                  const oldestKey = mmeInitCache.keys().next().value;
                  if (oldestKey !== undefined) mmeInitCache.delete(oldestKey);
                }
                mmeInitCache.set(rawStr, { initBytes, meta: null });
                mmeMetaPromise.then((metaObj) => {
                  if (metaObj && metaObj.fileSize && Array.isArray(metaObj.index)) {
                    const entry = mmeInitCache.get(rawStr);
                    if (entry) entry.meta = metaObj;
                  }
                });
              }
              usedMmeStream = true;
              mmeStreamInitBytes = initBytes;
              mmeStreamUrl = streamUrl;
              mmeStreamCached = Boolean(cachedMme);
              const kbInit = Math.round(initBytes.byteLength / 1024);
              emitLoadProgress(
                'demo',
                `Streaming demo (${kbInit} KB initial buffer ready)...`,
                initBytes.byteLength,
                initBytes.byteLength,
                18
              );
              latestAutoexec = await autoexecPromise;
              demoData = {
                fileName: fileName || 'current.dm_26',
                shortName: shortName || 'current',
                sourceUrl: rawStr,
                label: customLabel,
                bytes: null,
              };
            }
          }
        }

        if (!usedMmeStream) {
          if (isSuperseded()) return false;
          if (mmeFetchFailed) {
            emitLoadProgress('error', 'Network error downloading demo', 0, 0, 0);
            return false;
          }
          [demoData, latestAutoexec] = await Promise.all([
            fetchAndValidateDemoBytes(nameOrUrl, onFirstMessageReady, loadSignal),
            fetchAutoexecConfig(),
          ]);
        }
        if (isSuperseded()) return false;
        if (!demoData) {
          emitLoadProgress('error', 'Failed to download demo', 0, 0, 0);
          return false;
        }

        // Wait until engine is downloaded, compiled, and initialized (progress-aware stall timeout)
        if (!state.engineStarted || callWasm('JK_DemoIsReady', 'number', [], []) !== 1) {
          if (!state.engineStarted) {
            ensureEngineBooted({ background: false }).catch(() => {});
          }
          let stallVisibleMs = 0;
          let lastSeenProgressAt = state.engineLastProgressAt || Date.now();
          const MAX_STALL_VISIBLE_MS = 45000;
          while (
            !(state.engineStarted && callWasm('JK_DemoIsReady', 'number', [], []) === 1) &&
            stallVisibleMs < MAX_STALL_VISIBLE_MS
          ) {
            if (!state.engineStarted && !engineBootPromise) {
              break;
            }
            const hidden = isPageHidden();
            if (hidden) {
              emitLoadProgress(
                'engine',
                'Paused in background — switch back to resume...',
                state.engineDownloadLoaded || 0,
                state.engineDownloadTotal || 0,
                Math.max(20, state.loadProgress.percent || 20)
              );
            } else if (!state.engineStarted && state.engineBootStage === 'downloading') {
              const loaded = state.engineDownloadLoaded || 0;
              const total = Math.max(state.engineDownloadTotal || 0, loaded);
              if (total > 0 && loaded > 0) {
                const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
                const mbTotal = (total / (1024 * 1024)).toFixed(1);
                const ratio = Math.min(1, loaded / total);
                const pct = 18 + Math.round(ratio * 17);
                emitLoadProgress(
                  'engine',
                  `Loading 3D engine (${mbLoaded} / ${mbTotal} MB)...`,
                  loaded,
                  total,
                  pct
                );
              } else {
                emitLoadProgress('engine', 'Loading 3D engine...', 0, 0, 19);
              }
            } else {
              emitLoadProgress('engine', 'Initializing 3D engine...', 0, 0, 36);
            }
            await new Promise((r) => setTimeout(r, 80));
            const curProgressAt = state.engineLastProgressAt || 0;
            if (curProgressAt > lastSeenProgressAt || state.engineBootStage === 'compiling') {
              lastSeenProgressAt = Math.max(lastSeenProgressAt, curProgressAt);
              stallVisibleMs = 0;
            } else if (!isPageHidden()) {
              stallVisibleMs += 80;
            }
          }
        }
        if (!state.engineStarted || callWasm('JK_DemoIsReady', 'number', [], []) !== 1) {
          emitLoadProgress(
            'error',
            state.engineBootError || 'Network error loading 3D engine',
            0,
            0,
            0
          );
          return false;
        }

        // If prewarming is currently in flight, wait for it so assets are ready
        if (prewarmPromise && !state.prewarmed) {
          try {
            await prewarmPromise;
          } catch (_) {}
        }

        await waitWithVisibleTimeout(
          () =>
            !(
              window.Module &&
              window.Module.Asyncify &&
              (window.Module.Asyncify.state !== 0 || window.Module.Asyncify.currData)
            ),
          25,
          15000
        );

        if (isSuperseded()) return false;
        stopMmeBackgroundStream();
        if (state.engineStarted) {
          callWasm('JK_DemoAbortPrepare', null, [], []);
        }

        if (latestAutoexec) {
          writeConfigToFS('autoexec.cfg', latestAutoexec);
          execCommand('execq autoexec.cfg');
        }
        if (usedMmeStream) {
          activeStreamId = ++mmeStreamState.streamId;
          mmeStreamState.active = true;
          mmeStreamState.baseUrl = mmeStreamUrl;
          mmeStreamState.cacheKey = rawStr;
          mmeStreamState.fileSize = Math.max(mmeStreamInitBytes.byteLength, 0x3fffffff);
          mmeStreamState.startTime = 0;
          mmeStreamState.endTime = 0;
          mmeStreamState.totalFrames = 1;
          mmeStreamState.index = [[15, 0, 0]];
          mmeStreamState.chunks.clear();
          mmeStreamState.inFlight.clear();
          storeMmeRangeBytes(0, mmeStreamInitBytes);
          mmeStreamState.rangeRequests = mmeStreamCached ? 0 : 1;
          mmeStreamState.bytesTransferred = mmeStreamCached ? 0 : mmeStreamInitBytes.byteLength;
          applyMmeStreamToWasm({
            fileSize: mmeStreamState.fileSize,
            startTime: 0,
            endTime: 0,
            totalFrames: 1,
            index: [[15, 0, 0]],
          });
          // Plan & download map/model PK3 chunks immediately while mme_meta finishes on the server!
          await planAndPrefetchDemoChunks(demoData.shortName);
          if (isSuperseded()) return false;
          emitLoadProgress('demo', 'Finalizing demo keyframe index...', 0, 0, 76);
          const meta = mmeMetaPromise ? await mmeMetaPromise.catch(() => null) : null;
          if (isSuperseded()) return false;
          if (!meta || !meta.fileSize || !Array.isArray(meta.index)) {
            emitLoadProgress('error', 'Failed to load demo keyframe index', 0, 0, 0);
            return false;
          }
          mmeStreamState.fileSize = Number(meta.fileSize);
          mmeStreamState.startTime = Number(meta.startTime || 0);
          mmeStreamState.endTime = Number(meta.endTime || 0);
          mmeStreamState.totalFrames = Number(meta.totalFrames || 1);
          mmeStreamState.index = meta.index;
          applyMmeStreamToWasm(meta);
        } else {
          resetMmeStreamState();
          writeDemoToFS(demoData.fileName, demoData.bytes);
          if (earlyPeekPromise) {
            try {
              await earlyPeekPromise;
            } catch (_) {}
          }
          await planAndPrefetchDemoChunks(demoData.shortName);
          if (isSuperseded()) return false;
        }

        if (isPageHidden()) {
          emitLoadProgress(
            'init',
            'Ready — switch back to start playback...',
            0,
            0,
            78
          );
          await waitForPageVisible(50);
        }
        if (isSuperseded()) return false;

        emitLoadProgress('init', 'Preparing demo playback (0%)...', 0, 0, 78);
        await new Promise((r) => setTimeout(r, 0));
        if (isSuperseded()) return false;

        decPending();
        const prevStatus = getStatus();
        const prevCompleted = prevStatus.demoCompletedCount;
        const startFrameCount = prevStatus.frameCount;
        state.lastDemoSource = demoData.sourceUrl || nameOrUrl;
        state.demoName = demoData.fileName;
        state.demoEnded = false;
        state.paused = false;
        state.autoPausedByVisibility = false;

        callWasm('JK_DemoSetLoop', 'number', ['number'], [state.loop ? 1 : 0]);
        syncMusicToEngine();
        syncCameraModeToEngine();
        syncLightingToEngine();
        applyCanvasGammaFilter();
        const prepStarted = callWasm('JK_DemoPrepareBegin', 'number', ['string'], [demoData.shortName]);
        if (prepStarted === 1) {
          let prepStepSafety = 0;
          while (prepStepSafety < 4000) {
            if (isSuperseded()) {
              callWasm('JK_DemoAbortPrepare', null, [], []);
              return false;
            }
            prepStepSafety++;
            if (isPageHidden()) {
              await waitForPageVisible(20);
              if (isSuperseded()) {
                callWasm('JK_DemoAbortPrepare', null, [], []);
                return false;
              }
            }
            const more = callWasm('JK_DemoPrepareStep', 'number', [], []);
            const rawStatus = callWasm('JK_DemoGetPrepareStatus', 'string', [], []);
            if (rawStatus && !isSuperseded()) {
              try {
                const stObj = JSON.parse(rawStatus);
                const subPct = Math.max(0, Math.min(1, Number(stObj.pct || 0)));
                const overallPct = 78 + Math.round(subPct * 21);
                const label = stObj.label || 'Preparing demo playback...';
                emitLoadProgress('init', label, 0, 0, overallPct);
              } catch (_) {}
            }
            if (!more) break;
            await new Promise((r) => setTimeout(r, 0));
          }
        } else {
          callWasm('JK_DemoLoad', 'number', ['string'], [demoData.shortName]);
        }
        if (isSuperseded()) {
          callWasm('JK_DemoAbortPrepare', null, [], []);
          return false;
        }
        syncCameraModeToEngine();
        syncLightingToEngine();
        applyCanvasGammaFilter();

        try {
          window.dispatchEvent(
            new CustomEvent('jkdemo:loaded', {
              detail: { demoName: demoData.fileName, sourceUrl: state.lastDemoSource },
            })
          );
        } catch (_) {}

        let pollTicks = 0;
        const targetShort = demoData.shortName.toLowerCase();
        await waitWithVisibleTimeout(
          () => {
            if (isSuperseded()) return true;
            const st = getStatus();
            if (st.demoCompletedCount > prevCompleted || st.demoEnded) return true;
            if (
              st.isPlaying &&
              st.serverTime > 0 &&
              st.frameCount >= startFrameCount + 1 &&
              String(st.demoName || '').toLowerCase().includes(targetShort)
            ) {
              return true;
            }
            pollTicks++;
            return false;
          },
          25,
          40000
        );
        if (isSuperseded()) {
          callWasm('JK_DemoAbortPrepare', null, [], []);
          return false;
        }
        const finalSt = getStatus();
        if (mmeStreamState.active && mmeStreamState.streamId === activeStreamId) {
          startMmeBackgroundStream(activeStreamId);
        }
        emitLoadProgress('ready', 'Playing', 0, 0, 100);
        updateUIControls();
        return Boolean(finalSt.isPlaying || finalSt.demoCompletedCount > prevCompleted);
      } finally {
        if (state.activeLoadAbortCtrl === loadAbortCtrl) {
          state.activeLoadAbortCtrl = null;
        }
        state.activeDemoLoadCount = Math.max(0, (state.activeDemoLoadCount || 1) - 1);
        decPending();
        if (state.activeDemoLoadCount === 0) {
          pumpBgPrefetchQueue();
        }
      }
    };

    const nextPromise = state.loadChain.then(runLoad, runLoad);
    state.loadChain = nextPromise.catch(() => false);
    return nextPromise;
  }

  function playDemo(nameOrUrl) {
    return loadDemo(nameOrUrl);
  }

  function restartDemo() {
    return loadDemo(state.lastDemoSource || state.demoName);
  }

  function getStartTimeMs() {
    const v = callWasm('JK_DemoGetStartTimeMs', 'number', [], []);
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  function getEndTimeMs() {
    const v = callWasm('JK_DemoGetEndTimeMs', 'number', [], []);
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  function getDurationMs() {
    const v = callWasm('JK_DemoGetDurationMs', 'number', [], []);
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  function getCurrentTimeMs() {
    const v = callWasm('JK_DemoGetCurrentTimeMs', 'number', [], []);
    return typeof v === 'number' && v >= 0 ? v : 0;
  }

  function seekToMs(targetOffsetMs) {
    const num = typeof targetOffsetMs === 'number' ? targetOffsetMs : parseFloat(targetOffsetMs);
    if (!Number.isFinite(num)) {
      return getCurrentTimeMs();
    }
    const clamped = Math.max(0, Math.round(num));
    state.seeking = true;
    try {
      const res = callWasm('JK_DemoSeekToMs', 'number', ['number'], [clamped]);
      updateUIControls();
      return typeof res === 'number' ? res : getCurrentTimeMs();
    } finally {
      state.seeking = false;
    }
  }

  function seekToRatio(ratio) {
    const num = typeof ratio === 'number' ? ratio : parseFloat(ratio);
    if (!Number.isFinite(num)) {
      return getCurrentTimeMs();
    }
    const clampedRatio = Math.min(1, Math.max(0, num));
    const dur = getDurationMs();
    return seekToMs(Math.round(clampedRatio * dur));
  }

  function startOver() {
    const res = seekToMs(0);
    if (res < 0 && (state.lastDemoSource || state.demoName)) {
      loadDemo(state.lastDemoSource || state.demoName);
      return 0;
    }
    return res;
  }

  function setLoop(enabled) {
    state.loop = Boolean(enabled);
    callWasm('JK_DemoSetLoop', 'number', ['number'], [state.loop ? 1 : 0]);
    savePlayerPrefs();
    updateUIControls();
    return state.loop;
  }

  function getLoop() {
    const cLoop = callWasm('JK_DemoGetLoop', 'number', [], []);
    if (typeof cLoop === 'number') {
      state.loop = cLoop === 1;
    }
    return Boolean(state.loop);
  }

  function toggleLoop() {
    return setLoop(!getLoop());
  }

  function syncCameraModeToEngine() {
    execCommand(`set cg_thirdPerson "${state.thirdPerson ? '1' : '0'}"`);
  }

  function setThirdPerson(enabled) {
    state.thirdPerson = Boolean(enabled);
    syncCameraModeToEngine();
    persistPrefField('thirdPerson', state.thirdPerson);
    savePlayerPrefs();
    updateUIControls();
    try {
      window.dispatchEvent(
        new CustomEvent('jkdemo:cameramode', {
          detail: { thirdPerson: Boolean(state.thirdPerson) },
        })
      );
    } catch (_) {}
    return state.thirdPerson;
  }

  function getThirdPerson() {
    return Boolean(state.thirdPerson);
  }

  function toggleThirdPerson() {
    return setThirdPerson(!state.thirdPerson);
  }

  function ensureGammaSvgFilter(containerEl) {
    if (typeof document === 'undefined') return null;
    const host = containerEl || document.body;
    if (!host) return null;
    let svg = document.getElementById('jk-gamma-svg-defs');
    if (!svg) {
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
    }
    if (svg.parentNode !== host) {
      host.appendChild(svg);
    }
    return svg;
  }

  function applyCanvasGammaFilter() {
    if (typeof document === 'undefined') return;
    const canvas = document.getElementById('jk-canvas');
    if (!canvas) return;
    const g = clampGammaValue(state.gamma);
    if (Math.abs(g - 1.0) < 0.005) {
      if (canvas.style.filter) {
        canvas.style.filter = '';
      }
      return;
    }
    ensureGammaSvgFilter(canvas.parentNode || document.body);
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

  function syncLightingToEngine() {
    const ob = clampOverbrightValue(state.overbright);
    if (state.engineStarted) {
      const res = callWasm('JK_DemoSetMapOverbright', 'number', ['number'], [ob]);
      if (typeof res === 'number') {
        return;
      }
    }
    execCommand(`set r_mapOverBrightBits "${ob}"`);
  }

  function emitLightingEvent() {
    try {
      window.dispatchEvent(
        new CustomEvent('jkdemo:lighting', {
          detail: {
            gamma: Number(state.gamma),
            overbright: Number(state.overbright),
          },
        })
      );
    } catch (_) {}
  }

  function setGamma(gammaVal) {
    state.gamma = clampGammaValue(gammaVal);
    applyCanvasGammaFilter();
    persistPrefField('gamma', state.gamma);
    savePlayerPrefs();
    updateUIControls();
    emitLightingEvent();
    return state.gamma;
  }

  function getGamma() {
    return Number(state.gamma);
  }

  function setOverbright(bitsVal) {
    state.overbright = clampOverbrightValue(bitsVal);
    syncLightingToEngine();
    persistPrefField('overbright', state.overbright);
    savePlayerPrefs();
    updateUIControls();
    emitLightingEvent();
    return state.overbright;
  }

  function getOverbright() {
    if (state.engineStarted) {
      const cOb = callWasm('JK_DemoGetMapOverbright', 'number', [], []);
      if (typeof cOb === 'number' && Number.isFinite(cOb)) {
        state.overbright = clampOverbrightValue(cOb);
      }
    }
    return Number(state.overbright);
  }

  function setLighting(opts) {
    if (!opts || typeof opts !== 'object') {
      return getLighting();
    }
    if (typeof opts.gamma === 'number' && Number.isFinite(opts.gamma)) {
      state.gamma = clampGammaValue(opts.gamma);
      applyCanvasGammaFilter();
      persistPrefField('gamma', state.gamma);
    }
    const rawOb =
      typeof opts.overbright === 'number'
        ? opts.overbright
        : typeof opts.mapOverBrightBits === 'number'
        ? opts.mapOverBrightBits
        : undefined;
    if (typeof rawOb === 'number' && Number.isFinite(rawOb)) {
      state.overbright = clampOverbrightValue(rawOb);
      syncLightingToEngine();
      persistPrefField('overbright', state.overbright);
    }
    savePlayerPrefs();
    updateUIControls();
    emitLightingEvent();
    return getLighting();
  }

  function getLighting() {
    return {
      gamma: getGamma(),
      overbright: getOverbright(),
    };
  }

  function formatTimeMMSS(ms) {
    const safeMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
    const totalSec = Math.floor(safeMs / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  function onDemoComplete(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    state.completionListeners.push(callback);
    return function unsubscribe() {
      const idx = state.completionListeners.indexOf(callback);
      if (idx !== -1) state.completionListeners.splice(idx, 1);
    };
  }

  function onDemoEnded(callback) {
    return onDemoComplete(callback);
  }

  function setInteractiveMode(enabled) {
    state.interactiveMode = Boolean(enabled);
    callWasm('JK_DemoSetInteractive', 'number', ['number'], [state.interactiveMode ? 1 : 0]);
    return state.interactiveMode;
  }

  function getEffectiveDevicePixelRatio() {
    const raw = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    return Math.min(Math.max(raw, 1), 3);
  }

  function computeTargetRenderDimensions(customW, customH) {
    if (
      typeof customW === 'number' &&
      typeof customH === 'number' &&
      Number.isFinite(customW) &&
      Number.isFinite(customH) &&
      customW >= 64 &&
      customH >= 64
    ) {
      return {
        width: Math.min(4096, Math.max(64, Math.round(customW))) & ~1,
        height: Math.min(4096, Math.max(64, Math.round(customH))) & ~1,
        dpr: 1,
      };
    }

    const canvas = document.getElementById('jk-canvas');
    const pane = document.getElementById('jk-player-pane') || (canvas && canvas.parentElement) || canvas;
    let rawCssW = 640;
    let rawCssH = 360;
    if (pane && typeof pane.getBoundingClientRect === 'function') {
      const rect = pane.getBoundingClientRect();
      if (rect.width >= 32 && rect.height >= 32) {
        const vv = window.visualViewport;
        const vvScale = vv && Number(vv.scale) > 0.05 ? Number(vv.scale) : 1;
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const forceLandscape = Boolean(
          typeof pane.closest === 'function' && pane.closest('.jk-pip-force-landscape')
        );
        const logicalRectW = forceLandscape ? rect.height : rect.width;
        const logicalRectH = forceLandscape ? rect.width : rect.height;

        if (
          vv &&
          canvas &&
          canvas.width >= 64 &&
          canvas.height >= 64 &&
          !fsEl &&
          !forceLandscape &&
          (rect.right < vv.offsetLeft ||
            rect.left > vv.offsetLeft + vv.width ||
            rect.bottom < vv.offsetTop ||
            rect.top > vv.offsetTop + vv.height)
        ) {
          return {
            width: canvas.width,
            height: canvas.height,
            cssW: Math.max(32, Math.round(logicalRectW * vvScale)),
            cssH: Math.max(32, Math.round(logicalRectH * vvScale)),
            dpr: getEffectiveDevicePixelRatio(),
          };
        }

        if (fsEl && typeof fsEl.getBoundingClientRect === 'function' && vv && vv.width > 0) {
          const fsRect = fsEl.getBoundingClientRect();
          const fsLogicalW = forceLandscape ? fsRect.height : fsRect.width;
          const screenSpanW = forceLandscape
            ? Math.max(vv.width * vvScale, (vv.height || 0) * vvScale)
            : vv.width * vvScale;
          const fsScale = fsLogicalW >= 32 ? screenSpanW / fsLogicalW : vvScale;
          rawCssW = logicalRectW * fsScale;
          rawCssH = logicalRectH * fsScale;
        } else {
          rawCssW = logicalRectW * vvScale;
          rawCssH = logicalRectH * vvScale;
        }
      }
    }
    const cssW = Math.max(32, Math.round(rawCssW));
    const cssH = Math.max(32, Math.round(rawCssH));

    // In hardware/WebGL mode, scale by devicePixelRatio (up to 3x) with an aspect-preserving
    // pixel budget so HiDPI / Retina mobile and desktop displays render crisply.
    // In CPU Software WebGL fallback mode, use a 640x360 base matching the container aspect ratio.
    const isSoftwareWebGL = Boolean(
      (canvas && canvas.__jkUsingSoftwareWebGL) || state.forceSoftwareRenderer
    );
    if (isSoftwareWebGL) {
      const swScale = Math.min(
        1.0,
        Math.max(640 / Math.max(rawCssW, 1), 360 / Math.max(rawCssH, 1))
      );
      let width = Math.max(64, Math.round(rawCssW * swScale)) & ~1;
      let height = Math.max(64, Math.round(rawCssH * swScale)) & ~1;
      if (cssW >= 640 && width < 640) width = 640;
      if (cssH >= 360 && height < 360) height = 360;
      return { width, height, cssW, cssH, dpr: 1 };
    }

    const dpr = getEffectiveDevicePixelRatio();
    const isCoarsePointer = Boolean(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches
    );
    const maxDim = isCoarsePointer ? 2880 : 3840;
    const maxPixels = isCoarsePointer ? 2560 * 1440 : 3840 * 2160;

    let scaledW = rawCssW * dpr;
    let scaledH = rawCssH * dpr;

    const maxEdge = Math.max(scaledW, scaledH);
    if (maxEdge > maxDim) {
      const dimScale = maxDim / maxEdge;
      scaledW *= dimScale;
      scaledH *= dimScale;
    }
    const totalPixels = scaledW * scaledH;
    if (totalPixels > maxPixels) {
      const pxScale = Math.sqrt(maxPixels / totalPixels);
      scaledW *= pxScale;
      scaledH *= pxScale;
    }

    const width = Math.max(64, Math.round(scaledW)) & ~1;
    const height = Math.max(64, Math.round(scaledH)) & ~1;
    return { width, height, cssW, cssH, dpr };
  }

  function resize(customW, customH) {
    const canvas = document.getElementById('jk-canvas');
    if (!canvas) return { width: 640, height: 360 };

    // Ensure #jk-canvas always fills 100% of its parent container
    if (canvas.style.width !== '100%') canvas.style.width = '100%';
    if (canvas.style.height !== '100%') canvas.style.height = '100%';

    const dims = computeTargetRenderDimensions(customW, customH);
    const changed = canvas.width !== dims.width || canvas.height !== dims.height;
    if (changed) {
      canvas.width = dims.width;
      canvas.height = dims.height;
    }
    if (state.engineStarted) {
      callWasm('JK_DemoResizeViewport', 'number', ['number', 'number'], [dims.width, dims.height]);
    }
    if (changed) {
      try {
        window.dispatchEvent(
          new CustomEvent('jkdemo:resize', {
            detail: {
              width: dims.width,
              height: dims.height,
              cssWidth: dims.cssW,
              cssHeight: dims.cssH,
              dpr: dims.dpr,
            },
          })
        );
      } catch (_) {}
    }
    return { width: dims.width, height: dims.height };
  }

  function setResolution(width, height) {
    return resize(width, height);
  }

  function setupDynamicResizeObservers() {
    const canvas = document.getElementById('jk-canvas');
    const pane = document.getElementById('jk-player-pane') || (canvas && canvas.parentElement);

    let rafId = 0;
    const scheduleSync = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        resize();
      });
    };

    origWinAddEventListener.call(window, 'resize', scheduleSync);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', scheduleSync);
    }
    const onFullscreenSync = () => {
      scheduleSync();
      setTimeout(scheduleSync, 80);
    };
    origDocAddEventListener.call(document, 'fullscreenchange', onFullscreenSync);
    origDocAddEventListener.call(document, 'webkitfullscreenchange', onFullscreenSync);

    let dprMediaQuery = null;
    const onDprChange = () => {
      watchDprChange();
      scheduleSync();
    };
    const watchDprChange = () => {
      if (typeof window.matchMedia !== 'function') return;
      try {
        if (dprMediaQuery && typeof dprMediaQuery.removeEventListener === 'function') {
          dprMediaQuery.removeEventListener('change', onDprChange);
        }
        dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        if (typeof dprMediaQuery.addEventListener === 'function') {
          dprMediaQuery.addEventListener('change', onDprChange);
        }
      } catch (_) {}
    };
    watchDprChange();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(scheduleSync);
      if (pane) ro.observe(pane);
      if (canvas && canvas !== pane) ro.observe(canvas);
    }

    // Prevent SDL2 _emscripten_set_element_css_size from locking #jk-canvas inline style to fixed px
    if (canvas && typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => {
        if (canvas.style.width !== '100%' || canvas.style.height !== '100%') {
          canvas.style.width = '100%';
          canvas.style.height = '100%';
        }
      });
      mo.observe(canvas, { attributes: true, attributeFilter: ['style'] });
    }

    if (canvas) {
      canvas.addEventListener(
        'webglcontextlost',
        (ev) => {
          ev.preventDefault();
        },
        false
      );
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          scheduleSync();
        },
        false
      );

      // Tap / click game screen to toggle Play / Pause when not in interactive capture mode
      const activeCanvasPointers = new Map();
      let multiTouchCanvasGesture = false;
      let lastCanvasPointerToggleAt = 0;

      const canToggleFromCanvas = () =>
        !state.interactiveMode &&
        state.engineStarted &&
        state.demoLoadedOnce &&
        state.activeDemoLoadCount === 0 &&
        !(state.pendingDemoLoads > 0);

      const triggerCanvasPlayPause = () => {
        const nowPaused = togglePause();
        try {
          window.dispatchEvent(
            new CustomEvent('jkdemo:screen-toggle', {
              detail: { isPaused: Boolean(nowPaused) },
            })
          );
        } catch (_) {}
      };

      canvas.addEventListener('pointerdown', (ev) => {
        if (state.interactiveMode) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        activeCanvasPointers.set(ev.pointerId, {
          x: ev.clientX,
          y: ev.clientY,
          t: Date.now(),
        });
        if (activeCanvasPointers.size > 1) {
          multiTouchCanvasGesture = true;
        }
      });

      const clearCanvasPointer = (ev) => {
        activeCanvasPointers.delete(ev.pointerId);
        if (activeCanvasPointers.size === 0) {
          multiTouchCanvasGesture = false;
        }
      };
      canvas.addEventListener('pointercancel', clearCanvasPointer);
      canvas.addEventListener('lostpointercapture', clearCanvasPointer);

      canvas.addEventListener('pointerup', (ev) => {
        const down = activeCanvasPointers.get(ev.pointerId);
        activeCanvasPointers.delete(ev.pointerId);
        const wasMultiTouch = multiTouchCanvasGesture;
        if (activeCanvasPointers.size === 0) {
          multiTouchCanvasGesture = false;
        }
        if (!down || wasMultiTouch) return;
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        if (!canToggleFromCanvas()) return;
        const dist = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
        const elapsed = Date.now() - down.t;
        if (dist <= 12 && elapsed <= 700) {
          lastCanvasPointerToggleAt = Date.now();
          if (typeof window.__jkOnCanvasTap === 'function' && window.__jkOnCanvasTap(ev) === true) {
            return;
          }
          triggerCanvasPlayPause();
        }
      });

      canvas.addEventListener('click', (ev) => {
        if (Date.now() - lastCanvasPointerToggleAt <= 350) return;
        if (ev.button && ev.button !== 0) return;
        if (!canToggleFromCanvas()) return;
        lastCanvasPointerToggleAt = Date.now();
        if (typeof window.__jkOnCanvasTap === 'function' && window.__jkOnCanvasTap(ev) === true) {
          return;
        }
        triggerCanvasPlayPause();
      });
    }

    const handleVisibilityOrFocusChange = () => {
      if (isPageHidden()) {
        abortBackgroundPrefetch();
        if (state.activeDemoLoadCount > 0 || state.pendingDemoLoads > 0) {
          const cur = state.loadProgress || {};
          if (cur.stage && cur.stage !== 'ready' && cur.stage !== 'idle') {
            emitLoadProgress(
              cur.stage,
              'Paused in background — switch back to resume...',
              cur.loadedBytes || 0,
              cur.totalBytes || 0,
              cur.percent || 4
            );
          }
        } else if (state.engineStarted && !isPaused()) {
          state.autoPausedByVisibility = true;
          state.paused = true;
          callWasm('JK_DemoPause', 'number', [], []);
          updateUIControls();
        }
      } else {
        if (state.autoPausedByVisibility) {
          state.autoPausedByVisibility = false;
          resume();
        }
        if (!state.muted) {
          unlockAudio();
          syncAudioContextGain();
        }
        scheduleSync();
      }
    };

    origDocAddEventListener.call(document, 'visibilitychange', handleVisibilityOrFocusChange);
    origWinAddEventListener.call(window, 'pagehide', handleVisibilityOrFocusChange);
    origWinAddEventListener.call(window, 'pageshow', handleVisibilityOrFocusChange);
    origWinAddEventListener.call(window, 'focus', handleVisibilityOrFocusChange);

    const unlockOnGesture = () => {
      if (!state.muted && !isPageHidden()) {
        unlockAudio();
      }
    };
    origWinAddEventListener.call(window, 'pointerdown', unlockOnGesture, { passive: true });
    origWinAddEventListener.call(window, 'touchstart', unlockOnGesture, { passive: true });
    origWinAddEventListener.call(window, 'keydown', unlockOnGesture, { passive: true });
  }

  function applyQueryConfig(searchStr) {
    const cfg = parseQueryConfig(searchStr);
    if (typeof cfg.speed === 'number') setSpeed(cfg.speed);
    if (typeof cfg.volume === 'number') setVolume(cfg.volume);
    if (typeof cfg.muted === 'boolean') setMuted(cfg.muted);
    if (cfg.hasExplicitMusic && typeof cfg.musicEnabled === 'boolean') {
      setMusicEnabled(cfg.musicEnabled);
    }
    if (cfg.hasExplicitThirdPerson && typeof cfg.thirdPerson === 'boolean') {
      setThirdPerson(cfg.thirdPerson);
    }
    if (cfg.hasExplicitGamma && typeof cfg.gamma === 'number') {
      setGamma(cfg.gamma);
    }
    if (cfg.hasExplicitOverbright && typeof cfg.overbright === 'number') {
      setOverbright(cfg.overbright);
    }
    const normDemo = cfg.demo ? normalizeDemoFileName(cfg.demo) : '';
    if (normDemo && (normDemo !== state.demoName || state.demoEnded)) {
      return loadDemo(cfg.demo).then(() => {
        if (typeof cfg.speed === 'number') setSpeed(cfg.speed);
        if (typeof cfg.volume === 'number') setVolume(cfg.volume);
        if (typeof cfg.muted === 'boolean') setMuted(cfg.muted);
        return cfg;
      });
    }
    return Promise.resolve(cfg);
  }

  function isSoftwareRenderer() {
    const canvas = document.getElementById('jk-canvas');
    return Boolean((canvas && canvas.__jkUsingSoftwareWebGL) || state.forceSoftwareRenderer);
  }

  function setForceSoftwareRenderer(enabled) {
    const force = Boolean(enabled);
    const params = new URLSearchParams(window.location.search || '');
    params.delete('renderer');
    if (force) {
      params.set('software', '1');
    } else {
      params.delete('software');
    }
    if (state.demoName && state.demoName !== '1.51ef9.dm_26') {
      params.set('demo', state.demoName);
    }
    if (state.speed && state.speed !== 1.0) {
      params.set('speed', String(state.speed));
    }
    if (state.muted) {
      params.set('muted', '1');
    }
    const qs = params.toString();
    const nextUrl = window.location.pathname + (qs ? '?' + qs : '') + (window.location.hash || '');
    window.location.assign(nextUrl);
    return force;
  }

  function toggleSoftwareRenderer() {
    return setForceSoftwareRenderer(!state.forceSoftwareRenderer);
  }

  // Main-thread WebCodecs capability pre-probe + interactive console `/capture pipe` Blob sink
  (function initMainThreadPipeAndWebCodecs() {
    if (typeof window === 'undefined') return;
    if (!window.__jkWebCodecsCaps && typeof VideoEncoder !== 'undefined') {
      const caps = {
        supported: true,
        avcPrefix: 'avc1.6400',
        quantizer: false,
        aac: false,
        opus: false,
      };
      window.__jkWebCodecsCaps = caps;
      (async () => {
        for (const pfx of ['avc1.6400', 'avc1.4d00', 'avc1.4200']) {
          try {
            const sup = await VideoEncoder.isConfigSupported({
              codec: pfx + '2a',
              width: 1280,
              height: 720,
              framerate: 60,
              avc: { format: 'avc' },
            });
            if (sup && sup.supported) {
              caps.avcPrefix = pfx;
              break;
            }
          } catch (_) {}
        }
        try {
          const qSup = await VideoEncoder.isConfigSupported({
            codec: caps.avcPrefix + '2a',
            width: 1280,
            height: 720,
            framerate: 60,
            avc: { format: 'avc' },
            bitrateMode: 'quantizer',
          });
          caps.quantizer = Boolean(qSup && qSup.supported);
        } catch (_) {}
        if (typeof AudioEncoder !== 'undefined') {
          try {
            const aSup = await AudioEncoder.isConfigSupported({
              codec: 'mp4a.40.2',
              sampleRate: 44100,
              numberOfChannels: 2,
              bitrate: 128000,
            });
            caps.aac = Boolean(aSup && aSup.supported);
          } catch (_) {}
          try {
            const oSup = await AudioEncoder.isConfigSupported({
              codec: 'opus',
              sampleRate: 48000,
              numberOfChannels: 2,
              bitrate: 128000,
            });
            caps.opus = Boolean(oSup && oSup.supported);
          } catch (_) {}
        }
      })();
    }

    const interactivePipes = new Map();
    let nextMainPipeId = 1;
    if (typeof window.__jkPipeOpen !== 'function') {
      window.__jkPipeOpen = function (qpath) {
        const id = nextMainPipeId++;
        const raw = String(qpath || 'jka-capture.mp4').split('/').pop() || 'jka-capture.mp4';
        interactivePipes.set(id, {
          filename: /\.mp4$/i.test(raw) ? raw : raw + '.mp4',
          chunks: [],
        });
        return id;
      };
    }
    if (typeof window.__jkPipeWrite !== 'function') {
      window.__jkPipeWrite = function (pipeId, uint8View) {
        const entry = interactivePipes.get(pipeId);
        if (!entry || !uint8View || uint8View.byteLength === 0) return 0;
        const copy = new Uint8Array(uint8View.byteLength);
        copy.set(uint8View);
        entry.chunks.push(copy);
        return copy.byteLength;
      };
    }
    if (typeof window.__jkPipeClose !== 'function') {
      window.__jkPipeClose = function (pipeId) {
        const entry = interactivePipes.get(pipeId);
        if (!entry) return;
        interactivePipes.delete(pipeId);
        if (entry.chunks.length === 0) return;
        const blob = new Blob(entry.chunks, { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        if (a.parentNode) a.parentNode.removeChild(a);
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        }, 30000);
      };
    }
  })();

  function getExportSourceDescriptor() {
    const cfg = window.JKDemoConfig || {};
    const rawScriptUrl =
      typeof cfg.scriptUrl === 'string' && cfg.scriptUrl
        ? cfg.scriptUrl
        : `/openjk.js?v=${DEFAULT_ENGINE_VERSION}`;
    const scriptUrl = rawScriptUrl.includes('?')
      ? rawScriptUrl
      : `${rawScriptUrl}?v=${DEFAULT_ENGINE_VERSION}`;
    const scriptPathOnly = scriptUrl.split('?')[0];
    const scriptQuery = scriptUrl.includes('?')
      ? scriptUrl.slice(scriptUrl.indexOf('?'))
      : `?v=${DEFAULT_ENGINE_VERSION}`;
    const wasmDir = scriptPathOnly.includes('/')
      ? scriptPathOnly.slice(0, scriptPathOnly.lastIndexOf('/') + 1)
      : '/';
    const rawWasmUrl =
      typeof cfg.wasmUrl === 'string' && cfg.wasmUrl ? cfg.wasmUrl : `${wasmDir}openjk.wasm`;
    const wasmUrl = rawWasmUrl.includes('?') ? rawWasmUrl : `${rawWasmUrl}${scriptQuery}`;
    const autoexecUrl =
      typeof cfg.autoexecUrl === 'string' && cfg.autoexecUrl
        ? cfg.autoexecUrl
        : `${wasmDir}autoexec.cfg?v=${DEFAULT_PLAYER_VERSION}`;

    const rawSource =
      typeof state.lastDemoSource === 'object' && state.lastDemoSource
        ? String(state.lastDemoSource.url || state.lastDemoSource.demo || state.demoName || '')
        : String(state.lastDemoSource || state.demoName || '');
    const customLabel =
      typeof state.lastDemoSource === 'object' && state.lastDemoSource
        ? String(state.lastDemoSource.label || state.lastDemoSource.title || '')
        : '';

    const fileName = normalizeDemoFileName(state.demoName || rawSource) || 'current.dm_26';
    const shortName = stripDemoExt(fileName) || 'current';

    let mmeInitBytes = null;
    let mmeMeta = null;
    if (mmeStreamState.active) {
      const cached = mmeStreamState.cacheKey ? mmeInitCache.get(mmeStreamState.cacheKey) : null;
      if (cached && cached.initBytes) {
        mmeInitBytes = cached.initBytes;
      } else if (mmeStreamState.chunks.has(0)) {
        mmeInitBytes = mmeStreamState.chunks.get(0);
      }
      if (mmeStreamState.fileSize > 0 && Array.isArray(mmeStreamState.index)) {
        mmeMeta = {
          fileSize: mmeStreamState.fileSize,
          startTime: mmeStreamState.startTime,
          endTime: mmeStreamState.endTime,
          totalFrames: mmeStreamState.totalFrames,
          index: mmeStreamState.index,
        };
      }
    }

    let demoBytes = null;
    if (!mmeStreamState.active) {
      demoBytes =
        demoByteCache.get(rawSource) ||
        demoByteCache.get(fileName) ||
        demoByteCache.get(state.demoName) ||
        null;
    }

    return {
      isMmeStream: Boolean(mmeStreamState.active && mmeStreamState.baseUrl),
      streamUrl: mmeStreamState.active ? mmeStreamState.baseUrl : '',
      mmeInitBytes,
      mmeMeta,
      sourceUrl: rawSource,
      fileName,
      shortName,
      label: customLabel || shortName,
      demoBytes,
      durationMs: getDurationMs(),
      currentTimeMs: getCurrentTimeMs(),
      thirdPerson: getThirdPerson(),
      speed: getSpeed(),
      muted: isMuted(),
      musicEnabled: isMusicEnabled(),
      gamma: getGamma(),
      overbright: getOverbright(),
      pk3Manifest: window.__jkPk3Manifest || null,
      engineConfig: {
        scriptUrl,
        wasmUrl,
        autoexecUrl,
      },
    };
  }

  const playerAPI = {
    pause,
    resume,
    play,
    togglePause,
    setPaused,
    isPaused,
    setSpeed,
    getSpeed,
    setTimescale,
    getTimescale,
    mute,
    unmute,
    toggleMute,
    setMuted,
    isMuted,
    setMusicEnabled,
    getMusicEnabled: isMusicEnabled,
    isMusicEnabled,
    toggleMusic,
    unlockAudio,
    setVolume,
    getVolume,
    execCommand,
    sendCommand: execCommand,
    exec: execCommand,
    reloadAutoexec,
    loadDemo,
    playDemo,
    restartDemo,
    getStartTimeMs,
    getEndTimeMs,
    getDurationMs,
    getCurrentTimeMs,
    seekToMs,
    seek: seekToMs,
    seekToRatio,
    seekRatio: seekToRatio,
    startOver,
    restart: startOver,
    setLoop,
    getLoop,
    isLooping: getLoop,
    toggleLoop,
    setThirdPerson,
    getThirdPerson,
    isThirdPerson: getThirdPerson,
    toggleThirdPerson,
    setGamma,
    getGamma,
    setOverbright,
    getOverbright,
    setMapOverbright: setOverbright,
    getMapOverbright: getOverbright,
    setLighting,
    getLighting,
    formatTimeMMSS,
    init: function () {
      return prewarmEngineInBackground();
    },
    preload: prewarmEngineInBackground,
    prewarm: prewarmEngineInBackground,
    getCacheStats,
    clearCache,
    getStartupMetrics,
    getLoadProgress,
    onDemoComplete,
    onDemoEnded,
    getStatus,
    setInteractiveMode,
    resize,
    setResolution,
    applyQueryConfig,
    isSoftwareRenderer,
    setForceSoftwareRenderer,
    toggleSoftwareRenderer,
    getModule: function () {
      return window.Module || null;
    },
    getExportSourceDescriptor,
    _onInternalDemoCompleted: handleInternalDemoCompleted,
  };

  window.JKDemoPlayer = playerAPI;
  window.OpenJKPlayer = playerAPI;

  let isScrubbingTimeline = false;

  function updateUIControls() {
    const btnPlayPause = document.getElementById('btn-play-pause');
    if (btnPlayPause) {
      btnPlayPause.textContent = state.paused ? 'Resume' : 'Pause';
    }
    const selectSpeed = document.getElementById('select-speed');
    if (selectSpeed) {
      selectSpeed.value = String(state.speed);
    }
    const btnMusic = document.getElementById('btn-music');
    if (btnMusic) {
      const musicOn = isMusicEnabled();
      btnMusic.setAttribute('aria-pressed', musicOn ? 'true' : 'false');
      btnMusic.title = musicOn
        ? 'Background music on (click to mute music only)'
        : 'Background music off (sound effects still play)';
    }
    const btnMute = document.getElementById('btn-mute');
    if (btnMute) {
      btnMute.textContent = state.muted ? 'Unmute' : 'Mute';
    }
    const sliderVol = document.getElementById('slider-volume');
    if (sliderVol) {
      sliderVol.value = String(state.volume);
    }
    const btnLoop = document.getElementById('btn-loop');
    if (btnLoop) {
      const looping = getLoop();
      btnLoop.textContent = looping ? 'Loop: On' : 'Loop: Off';
      btnLoop.setAttribute('aria-pressed', looping ? 'true' : 'false');
    }
    const btnCamera = document.getElementById('btn-camera');
    if (btnCamera) {
      const is3p = getThirdPerson();
      btnCamera.textContent = is3p ? 'View: 3rd' : 'View: 1st';
      btnCamera.setAttribute(
        'aria-label',
        is3p
          ? 'View: 3rd — Switch to first-person camera'
          : 'View: 1st — Switch to third-person camera'
      );
      btnCamera.style.borderColor = is3p ? '' : '#58a6ff';
      btnCamera.style.color = is3p ? '' : '#58a6ff';
    }
    const sliderGamma = document.getElementById('slider-gamma');
    if (sliderGamma && document.activeElement !== sliderGamma) {
      sliderGamma.value = String(state.gamma);
      sliderGamma.setAttribute('aria-valuetext', state.gamma.toFixed(2));
    }
    const gammaDisplay = document.getElementById('gamma-display');
    if (gammaDisplay) {
      gammaDisplay.textContent = state.gamma.toFixed(2);
    }
    const selectOverbright = document.getElementById('select-overbright');
    if (selectOverbright && document.activeElement !== selectOverbright) {
      selectOverbright.value = String(state.overbright);
    }
    const sliderSeek = document.getElementById('slider-seek');
    const timeDisplay = document.getElementById('time-display');
    if (sliderSeek || timeDisplay) {
      const dur = getDurationMs();
      const cur = getCurrentTimeMs();
      if (sliderSeek && !isScrubbingTimeline) {
        sliderSeek.max = String(dur > 0 ? dur : 1000);
        sliderSeek.value = String(Math.min(cur, dur > 0 ? dur : 1000));
      }
      if (timeDisplay) {
        timeDisplay.textContent = formatTimeMMSS(cur) + ' / ' + formatTimeMMSS(dur);
      }
    }
    const btnRenderer = document.getElementById('btn-renderer');
    if (btnRenderer) {
      const canvas = document.getElementById('jk-canvas');
      const usingSW = Boolean(canvas && canvas.__jkUsingSoftwareWebGL);
      if (state.forceSoftwareRenderer) {
        btnRenderer.textContent = 'Renderer: Software (Forced)';
        btnRenderer.style.borderColor = '#58a6ff';
        btnRenderer.style.color = '#58a6ff';
      } else if (usingSW) {
        btnRenderer.textContent = 'Renderer: Software (Auto)';
        btnRenderer.style.borderColor = '';
        btnRenderer.style.color = '';
      } else {
        btnRenderer.textContent = 'Renderer: GPU (Force SW)';
        btnRenderer.style.borderColor = '';
        btnRenderer.style.color = '';
      }
    }
  }

  function bindHostControls() {
    const btnPlayPause = document.getElementById('btn-play-pause');
    if (btnPlayPause) {
      btnPlayPause.addEventListener('click', () => {
        togglePause();
      });
    }
    const btnStartOver = document.getElementById('btn-start-over');
    if (btnStartOver) {
      btnStartOver.addEventListener('click', () => {
        startOver();
      });
    }
    const sliderSeek = document.getElementById('slider-seek');
    if (sliderSeek) {
      sliderSeek.addEventListener('pointerdown', () => {
        isScrubbingTimeline = true;
      });
      sliderSeek.addEventListener('pointerup', () => {
        isScrubbingTimeline = false;
      });
      sliderSeek.addEventListener('input', (e) => {
        const target = parseFloat(e.target.value);
        if (Number.isFinite(target)) {
          seekToMs(target);
        }
      });
      sliderSeek.addEventListener('change', (e) => {
        isScrubbingTimeline = false;
        const target = parseFloat(e.target.value);
        if (Number.isFinite(target)) {
          seekToMs(target);
        }
      });
    }
    const btnLoop = document.getElementById('btn-loop');
    if (btnLoop) {
      btnLoop.addEventListener('click', () => {
        toggleLoop();
      });
    }
    const btnCamera = document.getElementById('btn-camera');
    if (btnCamera) {
      btnCamera.addEventListener('click', () => {
        toggleThirdPerson();
      });
    }
    const sliderGamma = document.getElementById('slider-gamma');
    if (sliderGamma) {
      const onGammaInput = (e) => {
        setGamma(parseFloat(e.target.value));
      };
      sliderGamma.addEventListener('input', onGammaInput);
      sliderGamma.addEventListener('change', onGammaInput);
    }
    const selectOverbright = document.getElementById('select-overbright');
    if (selectOverbright) {
      selectOverbright.addEventListener('change', (e) => {
        setOverbright(parseInt(e.target.value, 10));
      });
    }
    const selectSpeed = document.getElementById('select-speed');
    if (selectSpeed) {
      selectSpeed.addEventListener('change', (e) => {
        setSpeed(parseFloat(e.target.value));
      });
    }
    const btnMusic = document.getElementById('btn-music');
    if (btnMusic) {
      btnMusic.addEventListener('click', () => {
        toggleMusic();
      });
    }
    const btnMute = document.getElementById('btn-mute');
    if (btnMute) {
      btnMute.addEventListener('click', () => {
        toggleMute();
      });
    }
    const sliderVol = document.getElementById('slider-volume');
    if (sliderVol) {
      sliderVol.addEventListener('input', (e) => {
        setVolume(parseFloat(e.target.value));
      });
    }
    const btnLoadDemo = document.getElementById('btn-load-demo');
    const selectDemo = document.getElementById('select-demo');
    if (selectDemo && state.demoName) {
      selectDemo.value = state.demoName;
    }
    if (btnLoadDemo && selectDemo) {
      btnLoadDemo.addEventListener('click', () => {
        loadDemo(selectDemo.value);
      });
    }
    const btnRenderer = document.getElementById('btn-renderer');
    if (btnRenderer) {
      btnRenderer.addEventListener('click', () => {
        toggleSoftwareRenderer();
      });
    }
    const btnExport = document.getElementById('btn-export');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        if (window.JKVideoExport && typeof window.JKVideoExport.openForStandalone === 'function') {
          window.JKVideoExport.openForStandalone();
        }
      });
    }
    const btnFullscreen = document.getElementById('btn-fullscreen');
    if (btnFullscreen) {
      const getFsEl = () =>
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        null;
      const fsTarget =
        document.querySelector('main') ||
        document.getElementById('jk-player-pane');
      const syncHostFs = () => {
        const active =
          Boolean(fsTarget && getFsEl() === fsTarget) ||
          Boolean(fsTarget && fsTarget.classList.contains('jk-host-pseudo-fs'));
        btnFullscreen.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
        btnFullscreen.setAttribute('aria-pressed', active ? 'true' : 'false');
        resize();
      };
      btnFullscreen.addEventListener('click', () => {
        if (!fsTarget) return;
        const active =
          getFsEl() === fsTarget || fsTarget.classList.contains('jk-host-pseudo-fs');
        if (active) {
          if (fsTarget.classList.contains('jk-host-pseudo-fs')) {
            fsTarget.classList.remove('jk-host-pseudo-fs');
            syncHostFs();
          } else if (typeof document.exitFullscreen === 'function') {
            document.exitFullscreen().catch(() => {});
          } else if (typeof document.webkitExitFullscreen === 'function') {
            document.webkitExitFullscreen();
          }
        } else {
          const req = fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen;
          if (typeof req === 'function') {
            try {
              const p = req.call(fsTarget);
              if (p && typeof p.catch === 'function') {
                p.catch(() => {
                  fsTarget.classList.add('jk-host-pseudo-fs');
                  syncHostFs();
                });
              }
            } catch (_) {
              fsTarget.classList.add('jk-host-pseudo-fs');
              syncHostFs();
            }
          } else {
            fsTarget.classList.add('jk-host-pseudo-fs');
            syncHostFs();
          }
        }
      });
      origDocAddEventListener.call(document, 'fullscreenchange', syncHostFs);
      origDocAddEventListener.call(document, 'webkitfullscreenchange', syncHostFs);
    }

    setInterval(() => {
      updateUIControls();
      const statusBar = document.getElementById('status-bar');
      if (!statusBar) return;
      const st = getStatus();
      const mb = (st.pk3BytesTransferred / (1024 * 1024)).toFixed(2);
      const cacheMb = (st.pk3CacheBytes / (1024 * 1024)).toFixed(2);
      const rLabel = st.usingSoftwareRenderer
        ? (st.forceSoftwareRenderer ? 'SW (Forced)' : 'SW')
        : 'GPU';
      const cacheLabel =
        st.pk3CacheHits > 0 ? ` | Cache: ${cacheMb} MB (${st.pk3CacheHits} hits)` : '';
      const prog = st.loadProgress;
      const progLabel =
        !st.isPlaying && prog && prog.message && prog.stage !== 'idle' && prog.stage !== 'ready'
          ? `[${prog.percent}% ${prog.message}] | `
          : '';
      statusBar.textContent = `${progLabel}Demo: ${st.demoName} | Time: ${formatTimeMMSS(st.currentTimeMs)}/${formatTimeMMSS(st.durationMs)} (${st.serverTime}ms) | Frame: ${st.frameCount} | Speed: ${st.speed}x | Renderer: ${rLabel} | Net: ${mb} MB (${st.pk3RangeRequests} reqs)${cacheLabel}`;
    }, 250);
  }

  let hostInitialized = false;
  let engineBootPromise = null;
  let engineScriptInjected = false;

  function initHostPlayerOnce() {
    if (hostInitialized) return;
    hostInitialized = true;
    bindHostControls();
    updateUIControls();
    setupDynamicResizeObservers();
  }

  function validateOpenjkScriptBytes(bytes) {
    if (!bytes || bytes.byteLength < 32768) {
      throw new Error('openjk.js payload too small');
    }
    let firstIdx = 0;
    while (
      firstIdx < bytes.byteLength &&
      (bytes[firstIdx] === 0x20 ||
        bytes[firstIdx] === 0x09 ||
        bytes[firstIdx] === 0x0a ||
        bytes[firstIdx] === 0x0d ||
        bytes[firstIdx] === 0xef ||
        bytes[firstIdx] === 0xbb ||
        bytes[firstIdx] === 0xbf)
    ) {
      firstIdx++;
    }
    if (firstIdx < bytes.byteLength && bytes[firstIdx] === 0x3c) {
      throw new Error('Unexpected HTML response for openjk.js');
    }
    let lastIdx = bytes.byteLength - 1;
    while (
      lastIdx >= 0 &&
      (bytes[lastIdx] === 0x20 ||
        bytes[lastIdx] === 0x09 ||
        bytes[lastIdx] === 0x0a ||
        bytes[lastIdx] === 0x0d)
    ) {
      lastIdx--;
    }
    const lastByte = lastIdx >= 0 ? bytes[lastIdx] : 0;
    // Valid Emscripten JS ends with ';' (0x3b) or '}' (0x7d)
    if (lastByte !== 0x3b && lastByte !== 0x7d) {
      throw new Error('Truncated openjk.js script');
    }
    return true;
  }

  function ensureEngineBooted(opts) {
    initHostPlayerOnce();
    if (state.engineStarted) return Promise.resolve(true);
    if (engineBootPromise) return engineBootPromise;

    const options = opts || {};
    const lowPriority = Boolean(
      options.background && state.preloadOnly && !state.demoLoadedOnce
    );

    engineBootPromise = (async () => {
      const canvas = document.getElementById('jk-canvas');
      const initialDims = resize();
      const cfg = window.JKDemoConfig || {};
      const rawScriptUrl =
        typeof cfg.scriptUrl === 'string' && cfg.scriptUrl
          ? cfg.scriptUrl
          : `/openjk.js?v=${DEFAULT_ENGINE_VERSION}`;
      const scriptUrl = rawScriptUrl.includes('?')
        ? rawScriptUrl
        : `${rawScriptUrl}?v=${DEFAULT_ENGINE_VERSION}`;
      const scriptPathOnly = scriptUrl.split('?')[0];
      const scriptQuery = scriptUrl.includes('?')
        ? scriptUrl.slice(scriptUrl.indexOf('?'))
        : `?v=${DEFAULT_ENGINE_VERSION}`;
      const wasmDir = scriptPathOnly.includes('/')
        ? scriptPathOnly.slice(0, scriptPathOnly.lastIndexOf('/') + 1)
        : '/';
      const rawWasmUrl =
        typeof cfg.wasmUrl === 'string' && cfg.wasmUrl
          ? cfg.wasmUrl
          : `${wasmDir}openjk.wasm`;
      const wasmUrl = rawWasmUrl.includes('?')
        ? rawWasmUrl
        : `${rawWasmUrl}${scriptQuery}`;

      state.engineBootError = '';
      state.engineBootStage = 'downloading';
      state.engineLastProgressAt = Date.now();

      let jsLoaded = 0;
      let jsTotal = EXPECTED_OPENJK_JS_BYTES;
      let wasmLoaded = 0;
      let wasmTotal = EXPECTED_OPENJK_WASM_BYTES;
      const updateEngineProgress = () => {
        state.engineDownloadLoaded = jsLoaded + wasmLoaded;
        state.engineDownloadTotal = Math.max(
          jsTotal + wasmTotal,
          state.engineDownloadLoaded
        );
        state.engineLastProgressAt = Date.now();
      };
      updateEngineProgress();

      let jsRes = null;
      let wasmRes = null;
      let bootDemoData = null;
      let autoexecText = DEFAULT_AUTOEXEC_CFG;

      if (!engineScriptInjected) {
        const shouldPrefetchBootDemo =
          !state.preloadOnly &&
          !state.demoLoadedOnce &&
          !isQueryDemoUrl(state.lastDemoSource || state.demoName);
        try {
          [jsRes, wasmRes, bootDemoData, , autoexecText] = await Promise.all([
            fetchBytesWithProgressAndRetry(scriptUrl, {
              maxAttempts: 4,
              minBytes: 32768,
              fallbackTotalBytes: EXPECTED_OPENJK_JS_BYTES,
              lowPriority,
              onProgress: (loaded, total) => {
                jsLoaded = loaded;
                if (total > 0) jsTotal = total;
                updateEngineProgress();
              },
              validateBytes: validateOpenjkScriptBytes,
            }),
            fetchBytesWithProgressAndRetry(wasmUrl, {
              maxAttempts: 4,
              minBytes: 65536,
              fallbackTotalBytes: EXPECTED_OPENJK_WASM_BYTES,
              lowPriority,
              onProgress: (loaded, total) => {
                wasmLoaded = loaded;
                if (total > 0) wasmTotal = total;
                updateEngineProgress();
              },
              validateBytes: async (bytes) => {
                state.engineBootStage = 'compiling';
                state.engineLastProgressAt = Date.now();
                const compiled = await WebAssembly.compile(bytes);
                state.engineLastProgressAt = Date.now();
                return compiled;
              },
            }),
            shouldPrefetchBootDemo
              ? fetchAndValidateDemoBytes(state.lastDemoSource || state.demoName)
              : Promise.resolve(null),
            hydrateCacheFromIndexedDB().then(() => prefetchStartupCoreAssetsAsync()),
            fetchAutoexecConfig(wasmDir, `?v=${DEFAULT_PLAYER_VERSION}`),
          ]);
        } catch (err) {
          console.warn('[OpenJK] Engine download/compile failed:', err);
          state.engineBootStage = 'error';
          state.engineBootError = 'Network error loading 3D engine';
          engineBootPromise = null;
          return false;
        }

        if (!jsRes || !jsRes.ok || !jsRes.bytes || !wasmRes || !wasmRes.ok || !wasmRes.extra) {
          state.engineBootStage = 'error';
          state.engineBootError = 'Failed to load 3D engine files';
          engineBootPromise = null;
          return false;
        }
      }

      let willUseSoftwareWebGL = Boolean(state.forceSoftwareRenderer);
      if (!willUseSoftwareWebGL) {
        try {
          const probeCanvas = document.createElement('canvas');
          probeCanvas.width = 4;
          probeCanvas.height = 4;
          const probeCtx =
            probeCanvas.getContext('webgl') ||
            probeCanvas.getContext('experimental-webgl');
          if (
            !probeCtx ||
            typeof probeCtx.createShader !== 'function' ||
            probeCtx.__jkUsingSoftwareWebGL ||
            probeCanvas.__jkUsingSoftwareWebGL
          ) {
            willUseSoftwareWebGL = true;
          } else {
            const dbgExt = probeCtx.getExtension('WEBGL_debug_renderer_info');
            const unmasked = dbgExt
              ? String(probeCtx.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '')
              : '';
            const rStr = String(probeCtx.getParameter(probeCtx.RENDERER) || '');
            if (/swiftshader|software/i.test(unmasked) || /software/i.test(rStr)) {
              willUseSoftwareWebGL = true;
            }
          }
        } catch (_) {
          willUseSoftwareWebGL = true;
        }
      }

      const engineArgs = [
        '+set', 'fs_basepath', '.',
        '+set', 'fs_homepath', '.',
        '+set', 'sv_pure', '0',
        '+set', 'com_bootlogo', '0',
        '+set', 'ui_bypassMainMenuLoad', '1',
        '+set', 'cl_skipMenu', '1',
        '+set', 'r_primitives', '2',
        '+set', 'r_fullscreen', '0',
        '+set', 'r_mode', '-1',
        '+set', 'r_customwidth', String(initialDims.width || 640),
        '+set', 'r_customheight', String(initialDims.height || 360),
        '+set', 'r_ext_multitexture', willUseSoftwareWebGL ? '0' : '1',
        '+set', 'r_vertexLight', willUseSoftwareWebGL ? '1' : '0',
        '+set', 'in_InteractiveMode', '0',
        '+set', 'in_nograb', '1',
        '+set', 'timescale', String(state.speed),
        '+set', 's_khz', '22',
        '+set', 's_volume', String(state.muted ? 0.0 : state.volume),
        '+set', 's_musicvolume', String(state.muted || !state.musicEnabled ? 0.0 : state.volume * 0.5),
      ];

      if (willUseSoftwareWebGL) {
        engineArgs.push(
          '+set', 'r_picmip', '2',
          '+set', 'r_lodbias', '2',
          '+set', 'r_subdivisions', '20',
          '+set', 'r_detailtextures', '0',
          '+set', 'cg_shadows', '0',
          '+set', 'r_dynamiclight', '0'
        );
      }

      if (!state.preloadOnly && !state.demoLoadedOnce) {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.demoLoadStartMs = Math.round(nowMs * 100) / 100;
      }

      let compiledWasmModule = wasmRes ? wasmRes.extra : null;
      if (wasmRes) {
        wasmRes.bytes = null;
        wasmRes.extra = null;
      }
      let scriptBytes = jsRes ? jsRes.bytes : null;
      if (jsRes) {
        jsRes.bytes = null;
      }

      const runtimeReadyPromise = new Promise((resolveRuntime) => {
        let settled = false;
        const finishRuntime = (ok) => {
          if (settled) return;
          settled = true;
          resolveRuntime(Boolean(ok));
        };

        window.Module = {
          canvas: canvas,
          noInitialRun: false,
          arguments: engineArgs,
          locateFile: function (path) {
            if (path.endsWith('.wasm')) {
              return wasmUrl;
            }
            return wasmDir + path + (path.includes('?') ? '' : scriptQuery);
          },
          instantiateWasm: compiledWasmModule
            ? function (imports, successCallback) {
                state.engineBootStage = 'initializing';
                state.engineLastProgressAt = Date.now();
                const modToInstantiate = compiledWasmModule;
                compiledWasmModule = null;
                WebAssembly.instantiate(modToInstantiate, imports)
                  .then(function (instance) {
                    state.engineLastProgressAt = Date.now();
                    successCallback(instance);
                  })
                  .catch(function (err) {
                    console.error('[OpenJK] WebAssembly.instantiate failed:', err);
                    state.engineBootStage = 'error';
                    state.engineBootError = 'Failed to initialize 3D engine';
                    finishRuntime(false);
                  });
                return {};
              }
            : undefined,
          preRun: [
            function () {
              state.engineLastProgressAt = Date.now();
              writeConfigToFS(
                'autoexec.cfg',
                autoexecText +
                  `\nset cg_thirdPerson "${state.thirdPerson ? '1' : '0'}"\n` +
                  `set r_mapOverBrightBits "${state.overbright}"\n`
              );
              if (bootDemoData) {
                writeDemoToFS(bootDemoData.fileName, bootDemoData.bytes);
              }
            },
          ],
          onRuntimeInitialized: function () {
            if (window.Module) {
              const safeGetters = [
                '_JK_DemoIsPlaying',
                '_JK_DemoIsReady',
                '_JK_DemoIsPaused',
                '_JK_DemoIsMuted',
                '_JK_DemoIsMusicEnabled',
                '_JK_DemoIsCompleted',
                '_JK_DemoHasEnded',
                '_JK_DemoGetCompletedCount',
                '_JK_DemoGetState',
                '_JK_DemoGetServerTime',
                '_JK_DemoGetServerTimeMs',
                '_JK_DemoGetRealtime',
                '_JK_DemoGetFrameCount',
                '_JK_DemoGetStartTimeMs',
                '_JK_DemoGetEndTimeMs',
                '_JK_DemoGetDurationMs',
                '_JK_DemoGetCurrentTimeMs',
                '_JK_DemoGetLoop',
                '_JK_DemoGetSpeed',
                '_JK_DemoGetVolume',
                '_JK_DemoGetPk3BytesTransferred',
                '_JK_DemoGetPK3BytesTransferred',
                '_JK_DemoGetPk3RangeRequests',
                '_JK_DemoGetPK3RangeRequests',
                '_JK_DemoGetLoadedPackCount',
                '_JK_DemoGetViewportWidth',
                '_JK_DemoGetViewportHeight',
                '_JK_DemoGetMapOverbright',
                '_JK_DemoIsAudioActive',
                '_JK_DemoGetAudioSamplesMixed',
              ];
              const lastGetterVals = {};
              for (const gName of safeGetters) {
                const origFn = window.Module[gName];
                if (typeof origFn === 'function') {
                  lastGetterVals[gName] = 0;
                  window.Module[gName] = function (...args) {
                    if (gName === '_JK_DemoIsPlaying' && state.pendingDemoLoads > 0) {
                      return 0;
                    }
                    const mod = window.Module;
                    if (
                      window.__jkSyncXhrDepth > 0 ||
                      (mod && mod.Asyncify && (mod.Asyncify.state !== 0 || mod.Asyncify.currData))
                    ) {
                      return lastGetterVals[gName];
                    }
                    const val = origFn.apply(this, args);
                    lastGetterVals[gName] = val;
                    return val;
                  };
                }
              }
            }
            state.engineStarted = true;
            state.engineBootStage = 'ready';
            state.engineBootError = '';
            state.engineLastProgressAt = Date.now();
            finishRuntime(true);

            const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
            state.metrics.runtimeInitMs =
              Math.round((nowMs - state.metrics.bootStartMs) * 100) / 100;
            callWasm('JK_DemoSetLoop', 'number', ['number'], [state.loop ? 1 : 0]);
            syncCameraModeToEngine();
            syncLightingToEngine();
            applyCanvasGammaFilter();
            syncMusicToEngine();
            if (state.muted) mute();
            else setVolume(state.volume);
            flushPendingCommands();
            resize();
            if (state.preloadOnly && !state.demoLoadedOnce && state.activeDemoLoadCount === 0) {
              prewarmEngineInBackground();
            } else if (!state.preloadOnly && !state.demoLoadedOnce) {
              loadDemo(state.lastDemoSource || state.demoName);
            }
            setTimeout(() => {
              resize();
              if (state.speed !== 1.0) setSpeed(state.speed);
              syncMusicToEngine();
              if (state.muted) mute();
              else setVolume(state.volume);
            }, 100);
          },
          print: function (text) {
            if (text) console.log('[OpenJK]', text);
          },
          printErr: function (text) {
            if (text) console.warn('[OpenJK]', text);
          },
        };

        if (!engineScriptInjected) {
          engineScriptInjected = true;
          state.engineBootStage = 'initializing';
          state.engineLastProgressAt = Date.now();
          interceptingEmscriptenListeners = true;

          let blobUrl = '';
          try {
            if (scriptBytes && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
              blobUrl = URL.createObjectURL(
                new Blob([scriptBytes], { type: 'text/javascript' })
              );
            }
          } catch (_) {
            blobUrl = '';
          }
          scriptBytes = null;

          const injectDirectFallback = () => {
            const fallbackScript = document.createElement('script');
            fallbackScript.src = scriptUrl;
            fallbackScript.async = true;
            fallbackScript.onerror = () => {
              if (fallbackScript.parentNode) {
                fallbackScript.parentNode.removeChild(fallbackScript);
              }
              engineScriptInjected = false;
              state.engineBootStage = 'error';
              state.engineBootError = 'Network error loading 3D engine';
              finishRuntime(false);
            };
            document.body.appendChild(fallbackScript);
          };

          if (blobUrl) {
            const script = document.createElement('script');
            script.src = blobUrl;
            script.async = true;
            script.onload = () => {
              try {
                URL.revokeObjectURL(blobUrl);
              } catch (_) {}
            };
            script.onerror = () => {
              try {
                URL.revokeObjectURL(blobUrl);
              } catch (_) {}
              if (script.parentNode) script.parentNode.removeChild(script);
              injectDirectFallback();
            };
            document.body.appendChild(script);
          } else {
            injectDirectFallback();
          }
        }
      });

      const ok = await runtimeReadyPromise;
      if (!ok) {
        engineBootPromise = null;
      }
      return ok;
    })();

    return engineBootPromise;
  }

  function bootEngine() {
    initHostPlayerOnce();
    applyCanvasGammaFilter();
    ensureEngineBooted({
      background: Boolean(state.preloadOnly && !state.demoLoadedOnce),
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootEngine);
  } else {
    bootEngine();
  }
})();
