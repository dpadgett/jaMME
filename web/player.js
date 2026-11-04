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

  const BOOT_START_MS = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const WASM_PK3_CHUNK_SIZE = 256 * 1024;
  const IDB_NAME = 'openjk-cache-v1';
  const IDB_VERSION = 1;
  const LS_MANIFEST_KEY = 'openjk_pk3_manifest_v2';
  const LS_HOT_CHUNKS_KEY = 'openjk_hot_chunks_v1';
  const LS_PREFS_KEY = 'openjk_player_prefs_v1';

  const state = {
    ready: false,
    interactiveMode: false,
    paused: false,
    loop: true,
    speed: 1.0,
    muted: false,
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
    prewarmed: false,
    preloadOnly: false,
    demoLoadedOnce: false,
    bypassCache: false,
    forceSoftwareRenderer: false,
    pendingCommands: [],
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
        if (typeof prefs.volume === 'number' && Number.isFinite(prefs.volume)) {
          state.volume = Math.min(1.0, Math.max(0.0, prefs.volume));
        }
        if (typeof prefs.loop === 'boolean') {
          state.loop = prefs.loop;
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
          volume: state.volume,
          loop: state.loop,
        })
      );
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
    return { demo, speed, muted, volume, forceSoftwareRenderer, preloadOnly, bypassCache };
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
  state.volume = initialCfg.volume;
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
      deleteBuffer() {},
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
      deleteTexture() {},
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
          if (/swiftshader/i.test(unmaskedRenderer)) {
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
  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  if (OrigAudioContext) {
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

    const WrappedAudioContext = function () {
      let ctx;
      if (arguments.length === 0) {
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
      state.audioContexts.push(ctx);
      try {
        if (typeof ctx.createGain === 'function') {
          const masterGain = ctx.createGain();
          masterGain.gain.value = state.muted ? 0.0 : state.volume;
          ctx.__jkMasterGain = masterGain;
          masterGain.connect(ctx.destination);
          state.masterGains.push(masterGain);
        }
      } catch (_) {}
      if (!state.muted && typeof ctx.resume === 'function') {
        ctx.resume().catch(() => {});
      }
      return ctx;
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
        if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
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
      type === 'mousewheel'
    ) {
      if (!state.interactiveMode) return true;
    }
    return false;
  }

  let interceptingEmscriptenListeners = false;
  const origWinAddEventListener = window.addEventListener;
  const origDocAddEventListener = document.addEventListener;

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
          type === 'blur' ||
          type === 'focusout')
      ) {
        const wrapped = function (ev) {
          if (type === 'blur' || type === 'focusout') {
            // Never let canvas/window blur deactivate audio or pause demo
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

  // Helper to call exported Wasm C functions safely
  function callWasm(fnName, returnType, argTypes, args) {
    const mod = window.Module;
    if (!mod || !state.engineStarted) return null;
    if (mod.Asyncify && mod.Asyncify.state !== 0) return null;
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

  // =========================================================================
  // IndexedDB + localStorage + In-Memory Asset & Demo Cache
  // =========================================================================
  const pk3ChunkCache = new Map(); // "<pk3Name>:<chunkIdx>" -> Uint8Array
  const pk3CdCache = new Map(); // "<pk3Name>:<start>-<end>" -> Uint8Array
  const demoByteCache = new Map(); // "<fileName>" -> Uint8Array
  const hotChunkSet = new Set(); // "<pk3Name>:<chunkIdx>"
  let idbInstance = null;
  let idbOpenPromise = null;
  let idbWriteQueue = [];
  let idbFlushTimer = 0;
  let hotChunksSaveTimer = 0;

  window.__jkPk3ChunkCache = pk3ChunkCache;
  window.__jkPk3CdCache = pk3CdCache;
  window.__jkDemoCache = demoByteCache;

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

  loadHotChunkList();

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
    idbFlushTimer = 0;
    if (state.bypassCache || idbWriteQueue.length === 0) return;
    const batch = idbWriteQueue;
    idbWriteQueue = [];
    openCacheDB().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(['chunks'], 'readwrite');
        const store = tx.objectStore('chunks');
        const now = Date.now();
        for (const item of batch) {
          store.put({ key: item.key, data: item.data, ts: now });
        }
      } catch (_) {}
    });
  }

  function queueIdbChunkWrite(key, uint8Data) {
    if (state.bypassCache) return;
    idbWriteQueue.push({ key, data: uint8Data });
    if (!idbFlushTimer) {
      idbFlushTimer = setTimeout(flushIdbWriteQueue, 120);
    }
  }

  async function hydrateCacheFromIndexedDB() {
    if (state.bypassCache) {
      try {
        delete window.__jkPk3Manifest;
        localStorage.removeItem(LS_MANIFEST_KEY);
      } catch (_) {}
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Kick off async manifest refresh in parallel if not already in localStorage
    const manifestPromise = (async () => {
      try {
        const cachedRaw = localStorage.getItem(LS_MANIFEST_KEY);
        if (cachedRaw) {
          window.__jkPk3Manifest = JSON.parse(cachedRaw);
          return;
        }
        const resp = await fetch('/base/manifest.json');
        if (resp.ok) {
          const data = await resp.json();
          window.__jkPk3Manifest = data;
          try {
            localStorage.setItem(LS_MANIFEST_KEY, JSON.stringify(data));
          } catch (_) {}
        }
      } catch (_) {}
    })();

    const db = await openCacheDB();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(['chunks', 'demos'], 'readonly');
          const chunkStore = tx.objectStore('chunks');
          const demoStore = tx.objectStore('demos');
          const chunkReq = chunkStore.getAll();
          const demoReq = demoStore.getAll();
          let hydratedChunks = 0;
          let hydratedBytes = 0;

          chunkReq.onsuccess = function () {
            const rows = chunkReq.result || [];
            for (const row of rows) {
              if (!row || !row.key || !row.data) continue;
              const bytes =
                row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
              if (row.key.startsWith('chunk:')) {
                const subKey = row.key.slice(6);
                pk3ChunkCache.set(subKey, bytes);
                hydratedChunks++;
                hydratedBytes += bytes.byteLength;
              } else if (row.key.startsWith('cd:')) {
                const subKey = row.key.slice(3);
                pk3CdCache.set(subKey, bytes);
                hydratedBytes += bytes.byteLength;
              }
            }
            state.metrics.idbHydratedChunks = hydratedChunks;
            state.metrics.idbHydratedBytes = hydratedBytes;
          };
          demoReq.onsuccess = function () {
            const rows = demoReq.result || [];
            for (const row of rows) {
              if (!row || !row.name || !row.data) continue;
              const bytes =
                row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
              demoByteCache.set(row.name, bytes);
            }
          };
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
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

  // Hooks called by C++ EM_JS in codemp/qcommon/files.cpp
  window.__jkPk3GetCachedCD = function (name, start, end, dst) {
    if (state.bypassCache) return 0;
    const key = name + ':' + start + '-' + end;
    const bytes = pk3CdCache.get(key);
    if (!bytes || !window.Module || !window.Module.HEAPU8) return 0;
    const expected = end - start + 1;
    const copyLen = Math.min(bytes.byteLength, expected);
    window.Module.HEAPU8.set(bytes.subarray(0, copyLen), dst);
    state.pk3CacheHits++;
    state.pk3CacheBytes += copyLen;
    return copyLen;
  };

  window.__jkPk3HasCachedChunk = function (name, chunkIdx) {
    if (state.bypassCache) return false;
    return pk3ChunkCache.has(name + ':' + chunkIdx);
  };

  window.__jkPk3GetCachedChunk = function (name, chunkIdx, dst, maxLen) {
    if (state.bypassCache) return 0;
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

  window.__jkPk3OnRangeFetched = function (name, start, end, subarray) {
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
      }
    } else {
      const copy = new Uint8Array(subarray.byteLength);
      copy.set(subarray);
      const cdKey = name + ':' + start + '-' + end;
      pk3CdCache.set(cdKey, copy);
      queueIdbChunkWrite('cd:' + cdKey, copy);
    }
  };

  async function fetchAndValidateDemoBytes(nameOrUrl) {
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
    if (!state.bypassCache && demoByteCache.has(cacheKey)) {
      const cachedBytes = demoByteCache.get(cacheKey);
      if (cachedBytes && cachedBytes.byteLength >= 16) {
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

    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      let headerLabel = customLabel;
      if (!headerLabel && resp.headers && typeof resp.headers.get === 'function') {
        const cd = resp.headers.get('content-disposition') || '';
        const m = cd.match(/filename="?([^";]+)"?/i);
        if (m && m[1]) headerLabel = m[1].trim();
      }
      const ab = await resp.arrayBuffer();
      if (!ab || ab.byteLength < 16) return null;
      const view = new DataView(ab);
      const firstMsgLen = view.getInt32(4, true);
      if (firstMsgLen <= 0 || firstMsgLen > 131072) {
        return null;
      }
      const bytes = new Uint8Array(ab);
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
      return null;
    }
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
        if (!state.muted && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          ctx.resume().catch(() => {});
        }
        if (!state.muted) return 'running';
        return ctx.state;
      }
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
      renderer: canvas && canvas.__jkUsingSoftwareWebGL ? 'software' : 'webgl',
      usingSoftwareRenderer: Boolean(canvas && canvas.__jkUsingSoftwareWebGL),
      forceSoftwareRenderer: Boolean(state.forceSoftwareRenderer),
      metrics: Object.assign({}, state.metrics),
    };
  }

  function pause() {
    state.paused = true;
    callWasm('JK_DemoPause', 'number', [], []);
    try {
      window.dispatchEvent(new CustomEvent('jkdemo:paused', { detail: { isPaused: true } }));
    } catch (_) {}
    updateUIControls();
    return true;
  }

  function resume() {
    state.paused = false;
    callWasm('JK_DemoResume', 'number', [], []);
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
    for (const ctx of state.audioContexts) {
      if (!ctx) continue;
      try {
        if (typeof ctx.resume === 'function') {
          ctx.resume().catch(() => {});
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

  // Async parallel range prefetching for common PK3 chunks (_humanoid.gla + hot chunks)
  async function fetchPk3SpanIntoCache(pk3Name, cStart, cEnd, archSize) {
    const byteStart = cStart * WASM_PK3_CHUNK_SIZE;
    let byteEnd = (cEnd + 1) * WASM_PK3_CHUNK_SIZE;
    if (archSize && byteEnd > archSize) byteEnd = archSize;
    if (byteEnd <= byteStart) return 0;
    try {
      const resp = await fetch('/base/' + pk3Name, {
        headers: { Range: 'bytes=' + byteStart + '-' + (byteEnd - 1) },
      });
      if (resp.status !== 200 && resp.status !== 206) return 0;
      const ab = await resp.arrayBuffer();
      const bytes = new Uint8Array(ab);
      if (bytes.byteLength > 0) {
        window.__jkPk3OnRangeFetched(pk3Name, byteStart, byteEnd - 1, bytes);
      }
      return bytes.byteLength;
    } catch (_) {
      return 0;
    }
  }

  async function prefetchCommonChunksAsync() {
    if (state.bypassCache) return;
    const manifest = window.__jkPk3Manifest;
    const sizeMap = new Map();
    if (manifest && Array.isArray(manifest.pk3s)) {
      for (const p of manifest.pk3s) {
        if (p && p.name && p.size) sizeMap.set(p.name, p.size);
      }
    }

    // Always ensure _humanoid.gla (assets1.pk3 chunks 195..225) is in the prefetch target set
    const byArchive = new Map();
    const addTarget = (pk3Name, cIdx) => {
      if (pk3ChunkCache.has(pk3Name + ':' + cIdx)) return;
      if (!byArchive.has(pk3Name)) byArchive.set(pk3Name, new Set());
      byArchive.get(pk3Name).add(cIdx);
    };

    for (let c = 195; c <= 225; c++) {
      addTarget('assets1.pk3', c);
    }
    for (const key of hotChunkSet) {
      const sep = key.lastIndexOf(':');
      if (sep <= 0) continue;
      const pk3Name = key.slice(0, sep);
      const cIdx = parseInt(key.slice(sep + 1), 10);
      if (Number.isFinite(cIdx) && cIdx >= 0) {
        addTarget(pk3Name, cIdx);
      }
    }

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
          cEnd - cStart < 31
        ) {
          i++;
          cEnd = sorted[i];
        }
        spans.push({ pk3Name, cStart, cEnd, archSize: sizeMap.get(pk3Name) || 0 });
        i++;
      }
    }

    // Run with bounded concurrency (6 parallel range fetches)
    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, spans.length); w++) {
      workers.push(
        (async () => {
          while (cursor < spans.length) {
            const item = spans[cursor++];
            await fetchPk3SpanIntoCache(item.pk3Name, item.cStart, item.cEnd, item.archSize);
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
      const waitStart = Date.now();
      while (!state.engineStarted && Date.now() - waitStart < 30000) {
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!state.engineStarted) return false;

      const res = callWasm('JK_DemoPrewarmAssets', 'number', [], []);
      if (res === 1) {
        state.prewarmed = true;
        state.ready = true;
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.prewarmCompleteMs = Math.round(nowMs * 100) / 100;
        flushIdbWriteQueue();
        try {
          window.dispatchEvent(
            new CustomEvent('jkdemo:prewarmed', { detail: getStartupMetrics() })
          );
        } catch (_) {}
      }
      return state.prewarmed;
    })();
    return prewarmPromise;
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
    state.pendingDemoLoads = (state.pendingDemoLoads || 0) + 1;
    let decrementedPending = false;
    const decPending = () => {
      if (!decrementedPending) {
        decrementedPending = true;
        state.pendingDemoLoads = Math.max(0, (state.pendingDemoLoads || 1) - 1);
      }
    };

    const runLoad = async () => {
      try {
        const loadStartNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.demoLoadStartMs = Math.round(loadStartNow * 100) / 100;
        state.metrics.firstActiveFrameMs = 0;
        state.metrics.demoLoadDurationMs = 0;

        const demoData = await fetchAndValidateDemoBytes(nameOrUrl);
        if (!demoData) {
          return false;
        }

        // Wait until engine is initialized if called during boot
        const bootWaitStart = Date.now();
        while (!state.engineStarted && Date.now() - bootWaitStart < 30000) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!state.engineStarted) return false;

        // If prewarming is currently in flight, wait for it so assets are ready
        if (prewarmPromise && !state.prewarmed) {
          try {
            await prewarmPromise;
          } catch (_) {}
        }

        const asyncWaitStart = Date.now();
        while (
          window.Module &&
          window.Module.Asyncify &&
          (window.Module.Asyncify.state !== 0 || window.Module.Asyncify.currData) &&
          Date.now() - asyncWaitStart < 15000
        ) {
          await new Promise((r) => setTimeout(r, 25));
        }

        writeDemoToFS(demoData.fileName, demoData.bytes);
        decPending();
        const prevStatus = getStatus();
        const prevCompleted = prevStatus.demoCompletedCount;
        const startFrameCount = prevStatus.frameCount;
        state.lastDemoSource = demoData.sourceUrl || nameOrUrl;
        state.demoName = demoData.fileName;
        state.demoEnded = false;
        state.paused = false;

        callWasm('JK_DemoSetLoop', 'number', ['number'], [state.loop ? 1 : 0]);
        callWasm('JK_DemoLoad', 'number', ['string'], [demoData.shortName]);

        try {
          window.dispatchEvent(
            new CustomEvent('jkdemo:loaded', {
              detail: { demoName: demoData.fileName, sourceUrl: state.lastDemoSource },
            })
          );
        } catch (_) {}

        const pollStart = Date.now();
        let pollTicks = 0;
        const targetShort = demoData.shortName.toLowerCase();
        while (Date.now() - pollStart < 40000 || pollTicks < 20) {
          const st = getStatus();
          if (st.demoCompletedCount > prevCompleted || st.demoEnded) {
            updateUIControls();
            return true;
          }
          if (
            st.isPlaying &&
            st.serverTime > 0 &&
            st.frameCount >= startFrameCount + 6 &&
            String(st.demoName || '').toLowerCase().includes(targetShort)
          ) {
            updateUIControls();
            return true;
          }
          pollTicks++;
          await new Promise((r) => setTimeout(r, 50));
        }
        const finalSt = getStatus();
        updateUIControls();
        return Boolean(finalSt.isPlaying || finalSt.demoCompletedCount > prevCompleted);
      } finally {
        decPending();
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
    const res = callWasm('JK_DemoSeekToMs', 'number', ['number'], [clamped]);
    updateUIControls();
    return typeof res === 'number' ? res : getCurrentTimeMs();
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
      };
    }

    const canvas = document.getElementById('jk-canvas');
    const pane = document.getElementById('jk-player-pane') || (canvas && canvas.parentElement) || canvas;
    let cssW = 640;
    let cssH = 360;
    if (pane && typeof pane.getBoundingClientRect === 'function') {
      const rect = pane.getBoundingClientRect();
      if (rect.width >= 64 && rect.height >= 64) {
        cssW = Math.round(rect.width);
        cssH = Math.round(rect.height);
      }
    }

    // In hardware/native WebGL mode, render at full 1:1 container resolution.
    // In CPU Software WebGL fallback mode, use a 640x360 base matching the container aspect ratio.
    const isHardwareWebGL = Boolean(
      canvas && canvas.__jkActiveWebGLContext && !canvas.__jkUsingSoftwareWebGL
    );
    const scale = isHardwareWebGL
      ? 1.0
      : Math.min(1.0, Math.max(640 / Math.max(cssW, 1), 360 / Math.max(cssH, 1)));
    let width = Math.max(64, Math.round(cssW * scale)) & ~1;
    let height = Math.max(64, Math.round(cssH * scale)) & ~1;
    if (cssW >= 640 && width < 640) width = 640;
    if (cssH >= 360 && height < 360) height = 360;
    return { width, height, cssW, cssH };
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
            detail: { width: dims.width, height: dims.height, cssWidth: dims.cssW, cssHeight: dims.cssH },
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
  }

  function applyQueryConfig(searchStr) {
    const cfg = parseQueryConfig(searchStr);
    if (typeof cfg.speed === 'number') setSpeed(cfg.speed);
    if (typeof cfg.volume === 'number') setVolume(cfg.volume);
    if (typeof cfg.muted === 'boolean') setMuted(cfg.muted);
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
    unlockAudio,
    setVolume,
    getVolume,
    execCommand,
    sendCommand: execCommand,
    exec: execCommand,
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
    formatTimeMMSS,
    init: function () {
      return prewarmEngineInBackground();
    },
    preload: prewarmEngineInBackground,
    prewarm: prewarmEngineInBackground,
    getCacheStats,
    clearCache,
    getStartupMetrics,
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
    const selectSpeed = document.getElementById('select-speed');
    if (selectSpeed) {
      selectSpeed.addEventListener('change', (e) => {
        setSpeed(parseFloat(e.target.value));
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
      statusBar.textContent = `Demo: ${st.demoName} | Time: ${formatTimeMMSS(st.currentTimeMs)}/${formatTimeMMSS(st.durationMs)} (${st.serverTime}ms) | Frame: ${st.frameCount} | Speed: ${st.speed}x | Renderer: ${rLabel} | Net: ${mb} MB (${st.pk3RangeRequests} reqs)${cacheLabel}`;
    }, 250);
  }

  async function bootEngine() {
    bindHostControls();
    updateUIControls();
    setupDynamicResizeObservers();

    const canvas = document.getElementById('jk-canvas');
    const initialDims = resize();
    const [bootDemoData] = await Promise.all([
      state.preloadOnly ? Promise.resolve(null) : fetchAndValidateDemoBytes(state.lastDemoSource || state.demoName),
      hydrateCacheFromIndexedDB(),
    ]);
    const bootShortName = bootDemoData ? bootDemoData.shortName : stripDemoExt(state.demoName);

    let willUseSoftwareWebGL = Boolean(state.forceSoftwareRenderer);
    if (!willUseSoftwareWebGL) {
      try {
        const probeCanvas = document.createElement('canvas');
        probeCanvas.width = 4;
        probeCanvas.height = 4;
        const probeCtx = probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl');
        if (!probeCtx || typeof probeCtx.createShader !== 'function' || probeCtx.__jkUsingSoftwareWebGL || probeCanvas.__jkUsingSoftwareWebGL) {
          willUseSoftwareWebGL = true;
        } else {
          const dbgExt = probeCtx.getExtension('WEBGL_debug_renderer_info');
          const unmasked = dbgExt ? String(probeCtx.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) || '') : '';
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
      '+set', 'cg_fovAspectAdjust', '1',
      '+set', 'r_ext_multitexture', willUseSoftwareWebGL ? '0' : '1',
      '+set', 'r_picmip', willUseSoftwareWebGL ? '2' : '0',
      '+set', 'r_vertexLight', willUseSoftwareWebGL ? '1' : '0',
      '+set', 'r_lodbias', willUseSoftwareWebGL ? '2' : '0',
      '+set', 'r_subdivisions', willUseSoftwareWebGL ? '20' : '4',
      '+set', 'r_detailtextures', willUseSoftwareWebGL ? '0' : '1',
      '+set', 'r_textureMode', 'GL_LINEAR_MIPMAP_NEAREST',
      '+set', 'cg_draw2D', '1',
      '+set', 'cg_simpleItems', '1',
      '+set', 'cg_shadows', willUseSoftwareWebGL ? '0' : '1',
      '+set', 'r_dynamiclight', willUseSoftwareWebGL ? '0' : '1',
      '+set', 'r_drawfog', '0',
      '+set', 'r_noportals', '1',
      '+set', 'in_InteractiveMode', '0',
      '+set', 'in_nograb', '1',
      '+set', 'timescale', String(state.speed),
      '+set', 's_khz', '22',
      '+set', 's_volume', String(state.muted ? 0.0 : state.volume),
    ];

    if (!state.preloadOnly) {
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      state.metrics.demoLoadStartMs = Math.round(nowMs * 100) / 100;
      engineArgs.push('+demo', bootShortName);
    }

    const cfg = window.JKDemoConfig || {};
    const scriptUrl = typeof cfg.scriptUrl === 'string' && cfg.scriptUrl ? cfg.scriptUrl : '/openjk.js';
    const wasmDir = scriptUrl.includes('/') ? scriptUrl.slice(0, scriptUrl.lastIndexOf('/') + 1) : '/';

    window.Module = {
      canvas: canvas,
      noInitialRun: false,
      arguments: engineArgs,
      locateFile: function (path) {
        if (path.endsWith('.wasm') && typeof cfg.wasmUrl === 'string' && cfg.wasmUrl) {
          return cfg.wasmUrl;
        }
        return wasmDir + path;
      },
      preRun: [
        function () {
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
                if (mod && mod.Asyncify && mod.Asyncify.state !== 0) {
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
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        state.metrics.runtimeInitMs =
          Math.round((nowMs - state.metrics.bootStartMs) * 100) / 100;
        callWasm('JK_DemoSetLoop', 'number', ['number'], [state.loop ? 1 : 0]);
        if (state.muted) mute();
        else setVolume(state.volume);
        flushPendingCommands();
        resize();
        if (state.preloadOnly) {
          prewarmEngineInBackground();
        }
        setTimeout(() => {
          resize();
          if (state.speed !== 1.0) setSpeed(state.speed);
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

    interceptingEmscriptenListeners = true;
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    document.body.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootEngine);
  } else {
    bootEngine();
  }
})();
