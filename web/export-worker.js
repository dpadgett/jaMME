/* Dedicated Web Worker for Off-Screen jaMME Video Export (WebCodecs + In-Engine fMP4 + Pipe Streaming) */
'use strict';

self.__jkHeadlessAudio = true;
self.__jkManualFrameLoop = true;
self.__jkPk3BaseUrl = '/base/';
self.__jkExportTotalExpectedFrames = 0;

const scheduleWorkerFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : function (fn) {
        return setTimeout(fn, 0);
      };

// Software WebGL1 rasterizer fallback (used automatically when hardware WebGL is unavailable or SwiftShader CPU)
function createSoftwareWebGLContext(canvasEl, getCtxFn) {
  const ctx2d = getCtxFn.call(canvasEl, '2d');
  if (!ctx2d) return null;

  let defaultFbW = canvasEl.width || 640;
  let defaultFbH = canvasEl.height || 360;
  let imageData = ctx2d.createImageData(defaultFbW, defaultFbH);
  let defaultColorBuf8 = imageData.data;
  let defaultColorBuf32 = new Uint32Array(defaultColorBuf8.buffer);

  let fbWidth = defaultFbW;
  let fbHeight = defaultFbH;
  let colorBuf8 = defaultColorBuf8;
  let colorBuf32 = defaultColorBuf32;
  let depthBuf = new Float32Array(fbWidth * fbHeight);
  depthBuf.fill(1.0);
  let boundFbo = null;

  const gammaLut = new Uint8Array(256);
  let cachedLutInvGamma = -1;

  function ensureDefaultFramebufferSize() {
    const w = canvasEl.width || 640;
    const h = canvasEl.height || 360;
    if (w !== defaultFbW || h !== defaultFbH) {
      defaultFbW = w;
      defaultFbH = h;
      imageData = ctx2d.createImageData(defaultFbW, defaultFbH);
      defaultColorBuf8 = imageData.data;
      defaultColorBuf32 = new Uint32Array(defaultColorBuf8.buffer);
      defaultColorBuf32.fill(0xff000000);
    }
  }

  function syncRenderTarget() {
    ensureDefaultFramebufferSize();
    if (boundFbo && boundFbo.colorTex && !boundFbo.colorTex.isFloat && boundFbo.colorTex.data) {
      const ct = boundFbo.colorTex;
      fbWidth = ct.width || defaultFbW;
      fbHeight = ct.height || defaultFbH;
      colorBuf8 = ct.data;
      colorBuf32 = ct.data32;
    } else {
      fbWidth = defaultFbW;
      fbHeight = defaultFbH;
      colorBuf8 = defaultColorBuf8;
      colorBuf32 = defaultColorBuf32;
    }
    if (depthBuf.length !== fbWidth * fbHeight) {
      depthBuf = new Float32Array(fbWidth * fbHeight);
      depthBuf.fill(1.0);
    }
    if (gl) {
      gl.drawingBufferWidth = defaultFbW;
      gl.drawingBufferHeight = defaultFbH;
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
    if (boundFbo) return;
    hasDrawnSinceClear = true;
    if (!flushScheduled) {
      flushScheduled = true;
      scheduleWorkerFrame(() => {
        flushScheduled = false;
        presentCompletedFrame();
      });
    }
  }

  let nextObjId = 1;
  let vpX = 0, vpY = 0, vpW = fbWidth, vpH = fbHeight;
  let scX = 0, scY = 0, scW = fbWidth, scH = fbHeight;
  let clearR = 0, clearG = 0, clearB = 0;
  let clearDepthVal = 1.0;
  let depthNear = 0.0;
  let depthFar = 1.0;
  let depthTest = false;
  let depthMaskVal = true;
  let depthFuncVal = 0x0203;
  let blendEnabled = false;
  let blendSrc = 1;
  let blendDst = 0;
  let cullEnabled = false;
  let cullFaceMode = 0x0405;
  let frontFaceMode = 0x0901;
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
    if (type === 0x1406) {
      const dv = buf.dv;
      const maxByte = buf.bytes.byteLength;
      if (bytePos + size * 4 <= maxByte) {
        for (let c = 0; c < size; c++) {
          out4[c] = dv.getFloat32(bytePos + c * 4, true);
        }
      }
    } else if (type === 0x1401) {
      const u8 = buf.bytes;
      const scale = attr.normalized ? (1.0 / 255.0) : 1.0;
      if (bytePos + size <= u8.byteLength) {
        for (let c = 0; c < size; c++) {
          out4[c] = u8[bytePos + c] * scale;
        }
      }
    } else if (type === 0x1403) {
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
          const isCCW = area < 0;
          const isFront = frontFaceMode === 0x0901 ? isCCW : !isCCW;
          if (cullFaceMode === 0x0405 && !isFront) continue;
          if (cullFaceMode === 0x0404 && isFront) continue;
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
                if (depthFuncVal === 0x0203) depthPass = z <= curZ + 1e-5;
                else if (depthFuncVal === 0x0201) depthPass = z < curZ;
                else if (depthFuncVal === 0x0202) depthPass = Math.abs(z - curZ) <= 2e-5;
                else if (depthFuncVal === 0x0204) depthPass = z > curZ;
                else if (depthFuncVal === 0x0206) depthPass = z >= curZ - 1e-5;
                else if (depthFuncVal === 0x0200) depthPass = false;
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
                  const tOff = (ty * tex0W + tx) << 2;
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
                  const tOff1 = (ty1 * tex1W + tx1) << 2;
                  r = (r * tex1Data[tOff1]) >> 8;
                  g = (g * tex1Data[tOff1 + 1]) >> 8;
                  b = (b * tex1Data[tOff1 + 2]) >> 8;
                }

                let alphaPass = true;
                if (hasAlphaTest) {
                  if (alphaMode === 1) alphaPass = a >= alphaRef255;
                  else if (alphaMode === 2) alphaPass = a > alphaRef255;
                  else if (alphaMode === 3) alphaPass = a < alphaRef255;
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
                      const invA = 255 - a;
                      r = (r * a + dr * invA) >> 8;
                      g = (g * a + dg * invA) >> 8;
                      b = (b * a + db * invA) >> 8;
                    } else if (blendSrc === 1 && blendDst === 1) {
                      r = Math.min(255, r + dr);
                      g = Math.min(255, g + dg);
                      b = Math.min(255, b + db);
                    } else if (blendSrc === 0x0302 && blendDst === 1) {
                      r = Math.min(255, dr + ((r * a) >> 8));
                      g = Math.min(255, dg + ((g * a) >> 8));
                      b = Math.min(255, db + ((b * a) >> 8));
                    } else if (
                      (blendSrc === 0x0306 && blendDst === 0) ||
                      (blendSrc === 0 && blendDst === 0x0300)
                    ) {
                      r = (r * dr) >> 8;
                      g = (g * dg) >> 8;
                      b = (b * db) >> 8;
                    } else if (blendSrc === 0x0306 && blendDst === 0x0300) {
                      r = Math.min(255, (r * dr) >> 7);
                      g = Math.min(255, (g * dg) >> 7);
                      b = Math.min(255, (b * db) >> 7);
                    } else if (blendSrc === 0x0306 && blendDst === 1) {
                      r = Math.min(255, dr + ((r * dr) >> 8));
                      g = Math.min(255, dg + ((g * dg) >> 8));
                      b = Math.min(255, db + ((b * db) >> 8));
                    } else if (blendSrc === 0x0306 && blendDst === 0x0302) {
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

  const supportedExts = [
    'OES_texture_float',
    'OES_texture_half_float',
    'WEBGL_color_buffer_float',
    'EXT_color_buffer_float',
    'EXT_color_buffer_half_float',
  ];

  const gl = {
    canvas: canvasEl,
    drawingBufferWidth: defaultFbW,
    drawingBufferHeight: defaultFbH,
    _boundArrayBuffer: null,
    _boundElementArrayBuffer: null,
    currentProgram: null,

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
    STATIC_DRAW: 0x88E4,
    TEXTURE0: 0x84C0,
    FRAMEBUFFER_COMPLETE: 0x8CD5,

    getContextAttributes() {
      return { alpha: false, depth: true, stencil: true, antialias: false, preserveDrawingBuffer: true };
    },
    isContextLost() { return false; },
    getSupportedExtensions() { return supportedExts.slice(); },
    getExtension(name) {
      return supportedExts.includes(String(name || '')) ? {} : null;
    },
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
        case 0x8894: return this._boundArrayBuffer;
        case 0x8895: return this._boundElementArrayBuffer;
        case 0x8B8D: return this.currentProgram;
        case 0x1F00: return 'OpenJK';
        case 0x1F01: return 'OpenJK Software WebGL';
        case 0x9245: return 'OpenJK';
        case 0x9246: return 'OpenJK Software WebGL';
        case 0x1F02: return 'WebGL 1.0 (OpenGL ES 2.0 OpenJK)';
        case 0x8B8C: return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0)';
        case 0x8872: return 1;
        case 0x8B4D: return 8;
        case 0x8B4C: return 8;
        case 0x8869: return 16;
        case 0x8DFB: return 256;
        case 0x8DFD: return 256;
        case 0x8DFC: return 16;
        case 0x0D33: return 4096;
        case 0x851C: return 4096;
        case 0x84E8: return 4096;
        case 0x0D3A: return new Int32Array([4096, 4096]);
        case 0x86A2: return 0;
        case 0x86A3: return new Uint32Array(0);
        case 0x0D52: return 8;
        case 0x0D53: return 8;
        case 0x0D54: return 8;
        case 0x0D55: return 8;
        case 0x0D56: return 24;
        case 0x0D57: return 8;
        case 0x0BA2: return new Int32Array([vpX, vpY, vpW, vpH]);
        case 0x0C10: return new Int32Array([scX, scY, scW, scH]);
        default: return 0;
      }
    },

    getShaderPrecisionFormat() {
      return { rangeMin: 127, rangeMax: 127, precision: 23 };
    },

    viewport(x, y, w, h) {
      vpX = x | 0; vpY = y | 0; vpW = w | 0; vpH = h | 0;
      this.drawingBufferWidth = defaultFbW;
      this.drawingBufferHeight = defaultFbH;
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

    clearColor(r, g, b) {
      clearR = Math.min(255, Math.max(0, (r * 255) | 0));
      clearG = Math.min(255, Math.max(0, (g * 255) | 0));
      clearB = Math.min(255, Math.max(0, (b * 255) | 0));
    },
    clearDepth(d) { clearDepthVal = d; },
    clearStencil() {},

    clear(mask) {
      syncRenderTarget();
      if (mask & 0x00004000) {
        if (!boundFbo) {
          presentCompletedFrame();
        }
        const packed = (255 << 24) | (clearB << 16) | (clearG << 8) | clearR;
        colorBuf32.fill(packed);
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
      return {
        id: nextObjId++,
        width: 0,
        height: 0,
        data: null,
        data32: null,
        accum16: null,
        isFloat: false,
        wrapS: 0x2901,
        wrapT: 0x2901,
      };
    },
    deleteTexture(tex) {
      if (!tex) return;
      for (let i = 0; i < boundTextures.length; i++) {
        if (boundTextures[i] === tex) boundTextures[i] = null;
      }
      if (boundFbo && boundFbo.colorTex === tex) {
        boundFbo.colorTex = null;
      }
      tex.data = null;
      tex.data32 = null;
      tex.accum16 = null;
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
      if (pname === 0x2802) tex.wrapS = param | 0;
      else if (pname === 0x2803) tex.wrapT = param | 0;
    },
    texParameterf(target, pname, param) {
      const tex = boundTextures[activeTexUnit];
      if (!tex) return;
      if (pname === 0x2802) tex.wrapS = param | 0;
      else if (pname === 0x2803) tex.wrapT = param | 0;
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
      const wantFloat =
        !pixels &&
        (type === 0x1406 ||
          type === 0x8D61 ||
          internalFormat === 0x8814 ||
          internalFormat === 0x881A);
      tex.isFloat = wantFloat;
      if (wantFloat) {
        tex.data = null;
        tex.data32 = null;
        if (!tex.accum16 || tex.accum16.length !== w * h * 4) {
          tex.accum16 = new Uint16Array(w * h * 4);
        }
        return;
      }
      tex.accum16 = null;
      if (!tex.data || tex.data.length !== w * h * 4) {
        tex.data = new Uint8Array(w * h * 4);
        tex.data32 = new Uint32Array(tex.data.buffer);
      }
      if (!pixels) {
        tex.data32.fill(0xff000000);
        return;
      }
      const src = pixels.buffer
        ? new Uint8Array(pixels.buffer, pixels.byteOffset || 0, pixels.byteLength)
        : pixels;
      const dst = tex.data;
      const n = w * h;
      if (format === 0x1908) {
        dst.set(src.subarray(0, Math.min(src.length, n * 4)));
      } else if (format === 0x1907) {
        for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
          dst[k] = src[j]; dst[k + 1] = src[j + 1]; dst[k + 2] = src[j + 2]; dst[k + 3] = 255;
        }
      } else if (format === 0x1909) {
        for (let i = 0, k = 0; i < n; i++, k += 4) {
          const v = src[i];
          dst[k] = v; dst[k + 1] = v; dst[k + 2] = v; dst[k + 3] = 255;
        }
      } else if (format === 0x1906) {
        for (let i = 0, k = 0; i < n; i++, k += 4) {
          dst[k] = 255; dst[k + 1] = 255; dst[k + 2] = 255; dst[k + 3] = src[i];
        }
      } else if (format === 0x190A) {
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
      if (mode === 0x0004) {
        const numTris = (count / 3) | 0;
        executeDraw(numTris, (t, out) => {
          const base = t * 3;
          out[0] = readIdx(base);
          out[1] = readIdx(base + 1);
          out[2] = readIdx(base + 2);
        });
      } else if (mode === 0x0005) {
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
      } else if (mode === 0x0006) {
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
      if (mode === 0x0004) {
        const numTris = (count / 3) | 0;
        executeDraw(numTris, (t, out) => {
          const base = first + t * 3;
          out[0] = base;
          out[1] = base + 1;
          out[2] = base + 2;
        });
      } else if (mode === 0x0005) {
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
      } else if (mode === 0x0006) {
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
      if (!boundFbo) presentCompletedFrame();
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

    createFramebuffer() {
      return { id: nextObjId++, colorTex: null };
    },
    deleteFramebuffer(fb) {
      if (fb) fb.colorTex = null;
      if (boundFbo && boundFbo === fb) {
        boundFbo = null;
        syncRenderTarget();
      }
    },
    bindFramebuffer(target, fb) {
      if (target === 0x8D40 || target === 0x8CA9 || !target) {
        boundFbo = fb || null;
        syncRenderTarget();
      }
    },
    checkFramebufferStatus() { return 0x8CD5; },
    framebufferRenderbuffer() {},
    framebufferTexture2D(target, attachment, texTarget, tex) {
      if (boundFbo && attachment === 0x8CE0) {
        boundFbo.colorTex = tex || null;
        syncRenderTarget();
      }
    },
    createRenderbuffer() { return { id: nextObjId++ }; },
    deleteRenderbuffer() {},
    bindRenderbuffer() {},
    renderbufferStorage() {},

    __jkSoftwareBlurAccum(blurTex, mainTex, scale, frame) {
      if (!blurTex || !blurTex.accum16 || !mainTex || !mainTex.data) return false;
      const dst = blurTex.accum16;
      const src = mainTex.data;
      const len = Math.min(dst.length, src.length);
      const sFixed = Math.max(0, Math.round((Number(scale) || 0) * 256.0));
      if (frame === 0) {
        for (let i = 0; i < len; i += 4) {
          dst[i] = (src[i] * sFixed) | 0;
          dst[i + 1] = (src[i + 1] * sFixed) | 0;
          dst[i + 2] = (src[i + 2] * sFixed) | 0;
          dst[i + 3] = 65280;
        }
      } else {
        for (let i = 0; i < len; i += 4) {
          const r = dst[i] + ((src[i] * sFixed) | 0);
          const g = dst[i + 1] + ((src[i + 1] * sFixed) | 0);
          const b = dst[i + 2] + ((src[i + 2] * sFixed) | 0);
          dst[i] = r > 65535 ? 65535 : r;
          dst[i + 1] = g > 65535 ? 65535 : g;
          dst[i + 2] = b > 65535 ? 65535 : b;
        }
      }
      return true;
    },

    __jkSoftwareGammaResolve(srcTex, invGamma) {
      if (!srcTex) return false;
      ensureDefaultFramebufferSize();
      const dst8 = defaultColorBuf8;
      const dst32 = defaultColorBuf32;
      const invG = Number.isFinite(invGamma) && invGamma > 0 ? invGamma : 1.0;
      const useGamma = Math.abs(invG - 1.0) > 0.005;
      if (useGamma && Math.abs(invG - cachedLutInvGamma) > 1e-4) {
        cachedLutInvGamma = invG;
        for (let v = 0; v < 256; v++) {
          gammaLut[v] = Math.min(255, Math.max(0, Math.round(Math.pow(v / 255.0, invG) * 255.0)));
        }
      }
      if (srcTex.isFloat && srcTex.accum16) {
        const aSrc = srcTex.accum16;
        const n = Math.min(dst8.length, aSrc.length);
        if (useGamma) {
          for (let i = 0; i < n; i += 4) {
            const r0 = (aSrc[i] + 128) >> 8;
            const g0 = (aSrc[i + 1] + 128) >> 8;
            const b0 = (aSrc[i + 2] + 128) >> 8;
            dst8[i] = gammaLut[r0 > 255 ? 255 : r0];
            dst8[i + 1] = gammaLut[g0 > 255 ? 255 : g0];
            dst8[i + 2] = gammaLut[b0 > 255 ? 255 : b0];
            dst8[i + 3] = 255;
          }
        } else {
          for (let i = 0; i < n; i += 4) {
            const r0 = (aSrc[i] + 128) >> 8;
            const g0 = (aSrc[i + 1] + 128) >> 8;
            const b0 = (aSrc[i + 2] + 128) >> 8;
            dst8[i] = r0 > 255 ? 255 : r0;
            dst8[i + 1] = g0 > 255 ? 255 : g0;
            dst8[i + 2] = b0 > 255 ? 255 : b0;
            dst8[i + 3] = 255;
          }
        }
      } else if (srcTex.data) {
        const uSrc = srcTex.data;
        const n = Math.min(dst8.length, uSrc.length);
        if (useGamma) {
          for (let i = 0; i < n; i += 4) {
            dst8[i] = gammaLut[uSrc[i]];
            dst8[i + 1] = gammaLut[uSrc[i + 1]];
            dst8[i + 2] = gammaLut[uSrc[i + 2]];
            dst8[i + 3] = 255;
          }
        } else if (srcTex.data32 && dst32.length === srcTex.data32.length) {
          dst32.set(srcTex.data32);
        } else {
          dst8.set(uSrc.subarray(0, n));
        }
      } else {
        return false;
      }
      hasDrawnSinceClear = false;
      ctx2d.putImageData(imageData, 0, 0);
      return true;
    },
  };

  if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype) {
    Object.setPrototypeOf(gl, WebGLRenderingContext.prototype);
  }
  return gl;
}

function patchOffscreenCanvas(canvas, isMainRenderCanvas) {
  if (!canvas || canvas.__jkPatched) return canvas;
  canvas.__jkPatched = true;
  const styleStore = {};
  canvas.style = {
    width: '',
    height: '',
    setProperty(k, v) {
      styleStore[k] = String(v);
    },
    removeProperty(k) {
      delete styleStore[k];
    },
    getPropertyValue(k) {
      return styleStore[k] || '';
    },
  };
  if (typeof canvas.addEventListener !== 'function') {
    canvas.addEventListener = function () {};
  }
  if (typeof canvas.removeEventListener !== 'function') {
    canvas.removeEventListener = function () {};
  }
  canvas.getBoundingClientRect = function () {
    return {
      left: 0,
      top: 0,
      right: canvas.width,
      bottom: canvas.height,
      width: canvas.width,
      height: canvas.height,
      x: 0,
      y: 0,
    };
  };
  canvas.focus = function () {};
  canvas.blur = function () {};
  canvas.parentNode = null;
  try {
    Object.defineProperty(canvas, 'clientWidth', {
      configurable: true,
      get() {
        return canvas.width;
      },
    });
    Object.defineProperty(canvas, 'clientHeight', {
      configurable: true,
      get() {
        return canvas.height;
      },
    });
  } catch (_) {}

  const origGetContext = canvas.getContext.bind(canvas);
  if (!isMainRenderCanvas) {
    return canvas;
  }

  canvas.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      if (canvas.__jkActiveWebGLContext) {
        return canvas.__jkActiveWebGLContext;
      }
      const preferredAttrs = Object.assign(
        {
          alpha: false,
          depth: true,
          stencil: true,
          antialias: false,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        },
        attrs || {},
        {
          alpha: false,
          depth: true,
          stencil: true,
          preserveDrawingBuffer: true,
        }
      );
      const candidates = [
        ['webgl', preferredAttrs],
        ['webgl2', preferredAttrs],
        ['webgl', { preserveDrawingBuffer: true }],
      ];
      for (const [candType, candAttrs] of candidates) {
        try {
          const probeCanvas = new OffscreenCanvas(4, 4);
          const probeCtx = probeCanvas.getContext(candType, candAttrs);
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
          const ctx = origGetContext(candType, candAttrs);
          if (ctx && !ctx.isContextLost()) {
            canvas.__jkActiveWebGLContext = ctx;
            canvas.__jkUsingSoftwareWebGL = false;
            canvas.__jkSoftwareMesaWebGL = /llvmpipe|lavapipe|softpipe/i.test(unmaskedRenderer);
            return ctx;
          }
        } catch (_) {}
      }

      const softCtx = createSoftwareWebGLContext(canvas, origGetContext);
      if (softCtx) {
        canvas.__jkActiveWebGLContext = softCtx;
        canvas.__jkUsingSoftwareWebGL = true;
        return softCtx;
      }
    }
    return origGetContext(type, attrs);
  };
  return canvas;
}

const offscreenCanvas =
  typeof OffscreenCanvas !== 'undefined'
    ? patchOffscreenCanvas(new OffscreenCanvas(1280, 720), true)
    : null;

// Minimal DOM & window shims required by Emscripten SDL2 inside a Web Worker
self.window = self;
self.innerWidth = 1920;
self.innerHeight = 1080;
self.scrollX = 0;
self.scrollY = 0;
self.devicePixelRatio = 1;
self.prompt = function () {
  return null;
};
self.screen = { width: 1920, height: 1080 };
self.document = {
  visibilityState: 'visible',
  hidden: false,
  title: 'jaMME Export Worker',
  fullscreenEnabled: false,
  webkitFullscreenEnabled: false,
  fullscreenElement: null,
  webkitFullscreenElement: null,
  pointerLockElement: null,
  body: {
    appendChild() {},
    removeChild() {},
    style: {},
  },
  documentElement: {
    clientWidth: 1920,
    clientHeight: 1080,
    style: {},
  },
  querySelector(sel) {
    if (sel === '#canvas' || sel === 'canvas' || sel === '#jk-canvas') {
      return offscreenCanvas;
    }
    return null;
  },
  getElementById(id) {
    if (id === 'canvas' || id === 'jk-canvas') {
      return offscreenCanvas;
    }
    return null;
  },
  createElement(tag) {
    if (String(tag || '').toLowerCase() === 'canvas' && typeof OffscreenCanvas !== 'undefined') {
      return patchOffscreenCanvas(new OffscreenCanvas(4, 4));
    }
    return {
      style: { setProperty() {}, removeProperty() {} },
      addEventListener() {},
      removeEventListener() {},
      getContext() {
        return null;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
  exitFullscreen() {},
  exitPointerLock() {},
};

const WASM_PK3_CHUNK_SIZE = 256 * 1024;
const MME_CHUNK_SIZE = 524288;
const IDB_NAME = 'openjk-cache-v1';
const IDB_VERSION = 1;

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

const DEFAULT_AUTOEXEC_CFG = [
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

const MAX_PK3_CACHE_CHUNKS = 256; // 64 MB strict LRU ceiling
const MAX_MME_STREAM_CHUNKS = 24; // 24 MB strict LRU ceiling
const MAX_SW_INFLIGHT_BYTES = 12 * 1024 * 1024; // 12 MB stream backpressure threshold
const MAX_FALLBACK_BLOB_BYTES = 96 * 1024 * 1024; // 96 MB safety cap when SW unavailable

const pk3ChunkCache = new Map();
const pk3CdCache = new Map();
const idbKnownKeys = new Set();

function putPk3ChunkCached(subKey, bytes) {
  if (!subKey || !bytes) return;
  if (pk3ChunkCache.has(subKey)) {
    pk3ChunkCache.delete(subKey);
  }
  pk3ChunkCache.set(subKey, bytes);
  while (pk3ChunkCache.size > MAX_PK3_CACHE_CHUNKS) {
    const oldestKey = pk3ChunkCache.keys().next().value;
    if (oldestKey === undefined) break;
    pk3ChunkCache.delete(oldestKey);
  }
}

function getPk3ChunkCached(subKey) {
  const bytes = pk3ChunkCache.get(subKey);
  if (!bytes) return undefined;
  pk3ChunkCache.delete(subKey);
  pk3ChunkCache.set(subKey, bytes);
  return bytes;
}
let idbInstance = null;
let idbOpenPromise = null;
let idbWriteQueue = [];
let idbFlushTimer = 0;

function openCacheDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
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
  if (idbWriteQueue.length === 0) return Promise.resolve();
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
  idbKnownKeys.add(key);
  idbWriteQueue.push({ key, data: uint8Data });
  if (!idbFlushTimer) {
    idbFlushTimer = setTimeout(flushIdbWriteQueue, 150);
  }
}

async function fetchManifestIfNeeded(providedManifest) {
  if (providedManifest && Array.isArray(providedManifest.pk3s) && providedManifest.pk3s.length > 0) {
    self.__jkPk3Manifest = providedManifest;
    return providedManifest;
  }
  if (self.__jkPk3Manifest && Array.isArray(self.__jkPk3Manifest.pk3s)) {
    return self.__jkPk3Manifest;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, attempt * 250));
    }
    try {
      const resp = await fetch('/base/manifest.json');
      if (resp.ok) {
        const data = await resp.json();
        self.__jkPk3Manifest = data;
        return data;
      }
    } catch (_) {}
  }
  return self.__jkPk3Manifest || null;
}

async function hydrateCacheFromIndexedDB(maxRecentChunks = 192) {
  const db = await openCacheDB();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(['chunks'], 'readonly');
      const chunkStore = tx.objectStore('chunks');
      const keysReq = chunkStore.getAllKeys();
      keysReq.onsuccess = function () {
        const keys = keysReq.result || [];
        let budget = Math.max(0, maxRecentChunks | 0);
        const deferred = [];
        const hydrateOne = (k) => {
          const getReq = chunkStore.get(k);
          getReq.onsuccess = function () {
            const row = getReq.result;
            if (!row || !row.data) return;
            const bytes =
              row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
            if (k.startsWith('chunk:')) {
              putPk3ChunkCached(k.slice(6), bytes);
            } else if (k.startsWith('cd:')) {
              pk3CdCache.set(k.slice(3), bytes);
            }
          };
        };
        for (const k of keys) {
          if (typeof k !== 'string') continue;
          idbKnownKeys.add(k);
          if (k.startsWith('cd:')) {
            if (!pk3CdCache.has(k.slice(3))) hydrateOne(k);
          } else if (STARTUP_CORE_CHUNK_KEYS.has(k)) {
            if (!pk3ChunkCache.has(k.slice(6))) {
              budget--;
              hydrateOne(k);
            }
          } else if (k.startsWith('chunk:') && !pk3ChunkCache.has(k.slice(6))) {
            deferred.push(k);
          }
        }
        for (let i = deferred.length - 1; i >= 0 && budget > 0; i--) {
          budget--;
          hydrateOne(deferred[i]);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

async function loadChunksFromIdb(subKeys) {
  if (!subKeys || subKeys.length === 0) return 0;
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
            putPk3ChunkCached(sk, bytes);
            loadedCount++;
          }
        };
      }
      tx.oncomplete = () => resolve(loadedCount);
      tx.onerror = () => resolve(loadedCount);
      tx.onabort = () => resolve(loadedCount);
    } catch (_) {
      resolve(0);
    }
  });
}

async function fetchPk3SpanIntoCache(pk3Name, cStart, cEnd, archSize, signal) {
  let trimStart = cStart;
  while (trimStart <= cEnd && pk3ChunkCache.has(pk3Name + ':' + trimStart)) {
    trimStart++;
  }
  if (trimStart > cEnd) return 0;
  let trimEnd = cEnd;
  while (trimEnd >= trimStart && pk3ChunkCache.has(pk3Name + ':' + trimEnd)) {
    trimEnd--;
  }

  const byteStart = trimStart * WASM_PK3_CHUNK_SIZE;
  let byteEnd = (trimEnd + 1) * WASM_PK3_CHUNK_SIZE - 1;
  if (archSize > 0 && byteEnd >= archSize) {
    byteEnd = archSize - 1;
  }
  if (byteEnd < byteStart) return 0;

  const basePrefix = self.__jkPk3BaseUrl.endsWith('/')
    ? self.__jkPk3BaseUrl
    : self.__jkPk3BaseUrl + '/';
  const url = basePrefix + encodeURIComponent(pk3Name);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal && signal.aborted) return 0;
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    try {
      const resp = await fetch(url, {
        headers: { Range: 'bytes=' + byteStart + '-' + byteEnd },
        signal,
      });
      if (resp.status !== 206 && resp.status !== 200) continue;
      const ab = await resp.arrayBuffer();
      const raw = new Uint8Array(ab);
      const slice =
        resp.status === 200 && byteStart < raw.byteLength
          ? raw.subarray(byteStart, Math.min(raw.byteLength, byteEnd + 1))
          : raw;
      if (slice.byteLength === 0) return 0;
      let c = trimStart;
      for (let off = 0; off < slice.byteLength; off += WASM_PK3_CHUNK_SIZE, c++) {
        const len = Math.min(WASM_PK3_CHUNK_SIZE, slice.byteLength - off);
        const copy = new Uint8Array(len);
        copy.set(slice.subarray(off, off + len));
        const mapKey = pk3Name + ':' + c;
        putPk3ChunkCached(mapKey, copy);
        queueIdbChunkWrite('chunk:' + mapKey, copy);
      }
      return slice.byteLength;
    } catch (_) {}
  }
  return 0;
}

// Hooks invoked by C++ EM_JS in codemp/qcommon/files_pc.cpp
self.__jkPk3GetCachedCD = function (name, start, end, dst) {
  if (!self.Module || !self.Module.HEAPU8) return 0;
  const key = name + ':' + start + '-' + end;
  const expected = end - start + 1;
  const bytes = pk3CdCache.get(key);
  if (bytes) {
    const copyLen = Math.min(bytes.byteLength, expected);
    self.Module.HEAPU8.set(bytes.subarray(0, copyLen), dst);
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
  self.Module.HEAPU8.set(assembled, dst);
  return expected;
};

self.__jkPk3HasCachedChunk = function (name, chunkIdx) {
  return pk3ChunkCache.has(name + ':' + chunkIdx);
};

self.__jkPk3GetCachedChunk = function (name, chunkIdx, dst, maxLen) {
  const bytes = getPk3ChunkCached(name + ':' + chunkIdx);
  if (!bytes || !self.Module || !self.Module.HEAPU8) return 0;
  const copyLen = Math.min(bytes.byteLength, maxLen);
  self.Module.HEAPU8.set(bytes.subarray(0, copyLen), dst);
  return copyLen;
};

self.__jkPk3OnRangeFetched = function (name, start, end, subarray) {
  if (!subarray || subarray.byteLength === 0) return;
  if (start % WASM_PK3_CHUNK_SIZE === 0) {
    let c = (start / WASM_PK3_CHUNK_SIZE) | 0;
    for (let off = 0; off < subarray.byteLength; off += WASM_PK3_CHUNK_SIZE, c++) {
      const len = Math.min(WASM_PK3_CHUNK_SIZE, subarray.byteLength - off);
      const copy = new Uint8Array(len);
      copy.set(subarray.subarray(off, off + len));
      const mapKey = name + ':' + c;
      putPk3ChunkCached(mapKey, copy);
      queueIdbChunkWrite('chunk:' + mapKey, copy);
    }
  } else {
    const copy = new Uint8Array(subarray.byteLength);
    copy.set(subarray);
    const cdKey = name + ':' + start + '-' + end;
    pk3CdCache.set(cdKey, copy);
    queueIdbChunkWrite('cd:' + cdKey, copy);
  }
};

self.__jkPk3PrefetchSpanAsync = function () {};
self.__jkPk3PrefetchChunkAsync = function () {};

// MME progressive stream reader in Worker
const mmeStreamState = {
  active: false,
  baseUrl: '',
  fileSize: 0,
  startTime: 0,
  endTime: 0,
  totalFrames: 0,
  index: [],
  chunks: new Map(),
};

function resetMmeStream() {
  mmeStreamState.active = false;
  mmeStreamState.baseUrl = '';
  mmeStreamState.fileSize = 0;
  mmeStreamState.startTime = 0;
  mmeStreamState.endTime = 0;
  mmeStreamState.totalFrames = 0;
  mmeStreamState.index = [];
  mmeStreamState.chunks.clear();
  if (self.Module && typeof self.Module._JK_DemoSetMmeStream === 'function') {
    try {
      self.Module._JK_DemoSetMmeStream(0, 0, 0, 0, 0, 0, 0);
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
    if (mmeStreamState.chunks.has(cIdx)) {
      mmeStreamState.chunks.delete(cIdx);
    }
    mmeStreamState.chunks.set(cIdx, slice);
    while (mmeStreamState.chunks.size > MAX_MME_STREAM_CHUNKS) {
      const oldest = mmeStreamState.chunks.keys().next().value;
      if (oldest === undefined || oldest === 0) break;
      mmeStreamState.chunks.delete(oldest);
    }
    off += len;
    cIdx++;
  }
}

function applyMmeStreamToWasm(meta) {
  const mod = self.Module;
  if (!mod || typeof mod._JK_DemoSetMmeStream !== 'function') return false;
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

self.__jkMmeRead = function (pos, dst, len) {
  if (!mmeStreamState.active || len <= 0 || !self.Module || !self.Module.HEAPU8) {
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
        xhr.responseType = 'arraybuffer';
        try {
          xhr.setRequestHeader('Range', 'bytes=' + byteStart + '-' + byteEnd);
        } catch (_) {}
        xhr.send(null);
        if ((xhr.status === 200 || xhr.status === 206) && xhr.response) {
          const bytes = new Uint8Array(xhr.response);
          if (bytes.byteLength > 0) {
            storeMmeRangeBytes(byteStart, bytes);
            chunk = mmeStreamState.chunks.get(cIdx);
          }
        }
      } catch (_) {}
    }
    if (!chunk || cOff >= chunk.byteLength) {
      break;
    }
    const take = Math.min(len - copied, chunk.byteLength - cOff);
    self.Module.HEAPU8.set(chunk.subarray(cOff, cOff + take), dst + copied);
    copied += take;
    curPos += take;
  }
  return copied;
};

async function prefetchMmeWindowChunks(startMs, endMs, signal) {
  if (!mmeStreamState.active || !mmeStreamState.baseUrl || mmeStreamState.fileSize <= 0) {
    return;
  }
  const idx = mmeStreamState.index;
  let startByte = 0;
  let endByte = Math.min(mmeStreamState.fileSize - 1, MME_CHUNK_SIZE * 2 - 1);

  if (Array.isArray(idx) && idx.length > 0) {
    const absStart = (mmeStreamState.startTime || 0) + Math.max(0, startMs - 3500);
    const absEnd = (mmeStreamState.startTime || 0) + Math.max(startMs, endMs) + 2500;
    startByte = idx[0][0] | 0;
    endByte = mmeStreamState.fileSize - 1;
    for (let i = 0; i < idx.length; i++) {
      const row = idx[i];
      if (row[1] <= absStart) {
        startByte = row[0] | 0;
      }
      if (row[1] >= absEnd) {
        endByte = Math.min(mmeStreamState.fileSize - 1, (row[0] | 0) + MME_CHUNK_SIZE - 1);
        break;
      }
    }
  }

  const cStart = Math.max(0, Math.floor(startByte / MME_CHUNK_SIZE));
  const cEnd = Math.max(cStart, Math.floor(endByte / MME_CHUNK_SIZE));
  const missing = [];
  for (let c = cStart; c <= cEnd; c++) {
    if (!mmeStreamState.chunks.has(c)) {
      missing.push(c);
    }
  }
  if (missing.length === 0) return;

  const spans = [];
  let i = 0;
  while (i < missing.length) {
    const s = missing[i];
    let e = s;
    while (i + 1 < missing.length && missing[i + 1] === e + 1 && e - s < 3) {
      i++;
      e = missing[i];
    }
    spans.push([s, e]);
    i++;
  }

  let cursor = 0;
  const workers = [];
  for (let w = 0; w < Math.min(3, spans.length); w++) {
    workers.push(
      (async () => {
        while (cursor < spans.length) {
          if (signal && signal.aborted) return;
          const [sChunk, eChunk] = spans[cursor++];
          const bStart = sChunk * MME_CHUNK_SIZE;
          let bEnd = (eChunk + 1) * MME_CHUNK_SIZE - 1;
          if (bEnd >= mmeStreamState.fileSize) bEnd = mmeStreamState.fileSize - 1;
          if (bEnd < bStart) continue;
          try {
            const resp = await fetch(mmeStreamState.baseUrl + '&format=mme', {
              headers: { Range: 'bytes=' + bStart + '-' + bEnd },
              signal,
            });
            if (resp.status === 200 || resp.status === 206) {
              const ab = await resp.arrayBuffer();
              const bytes = new Uint8Array(ab);
              if (bytes.byteLength > 0) {
                storeMmeRangeBytes(bStart, bytes);
              }
            }
          } catch (_) {}
        }
      })()
    );
  }
  await Promise.all(workers);
}

async function probeWebCodecsCaps() {
  if (self.__jkWebCodecsCaps) return self.__jkWebCodecsCaps;
  const caps = {
    supported: typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined',
    avcPrefix: 'avc1.6400',
    hwAccel: 'no-preference',
    quantizer: false,
    aac: false,
    opus: false,
  };
  if (!caps.supported) {
    self.__jkWebCodecsCaps = caps;
    return caps;
  }

  const prefixes = ['avc1.6400', 'avc1.4d00', 'avc1.4200'];
  const accelModes = ['prefer-hardware', 'no-preference'];
  let matched = false;
  for (const hwAccel of accelModes) {
    for (const pfx of prefixes) {
      try {
        const sup = await VideoEncoder.isConfigSupported({
          codec: pfx + '2a',
          width: 1280,
          height: 720,
          framerate: 60,
          avc: { format: 'avc' },
          hardwareAcceleration: hwAccel,
        });
        if (sup && sup.supported) {
          caps.avcPrefix = pfx;
          caps.hwAccel = hwAccel;
          matched = true;
          break;
        }
      } catch (_) {}
    }
    if (matched) break;
  }

  try {
    const qSup = await VideoEncoder.isConfigSupported({
      codec: caps.avcPrefix + '2a',
      width: 1280,
      height: 720,
      framerate: 60,
      avc: { format: 'avc' },
      hardwareAcceleration: caps.hwAccel,
      bitrateMode: 'quantizer',
    });
    caps.quantizer = Boolean(qSup && qSup.supported);
  } catch (_) {
    caps.quantizer = false;
  }

  if (typeof AudioEncoder !== 'undefined') {
    try {
      const aacSup = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      caps.aac = Boolean(aacSup && aacSup.supported);
    } catch (_) {}
    try {
      const opusSup = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      caps.opus = Boolean(opusSup && opusSup.supported);
    } catch (_) {}
  }

  self.__jkWebCodecsCaps = caps;
  return caps;
}

function callWasm(fnName, returnType, argTypes, args) {
  const mod = self.Module;
  if (!mod) return null;
  const raw = mod['_' + fnName];
  if (typeof raw === 'function' && (!argTypes || argTypes.length === 0)) {
    const res = raw();
    if (returnType === 'string') {
      return res && typeof mod.UTF8ToString === 'function' ? mod.UTF8ToString(res) : '';
    }
    return res;
  }
  if (typeof mod.ccall === 'function') {
    try {
      return mod.ccall(fnName, returnType, argTypes || [], args || []);
    } catch (_) {}
  }
  if (typeof raw === 'function') {
    return raw.apply(mod, args || []);
  }
  return null;
}

function execCommand(cmd) {
  if (!cmd) return;
  callWasm('JK_DemoExecCommand', 'number', ['string'], [String(cmd)]);
}

function writeConfigToFS(fileName, content) {
  const mod = self.Module;
  if (!mod || !mod.FS) return false;
  const FS = mod.FS;
  for (const d of ['/base', 'base']) {
    try {
      FS.mkdir(d);
    } catch (_) {}
  }
  const bytes =
    content instanceof Uint8Array
      ? content
      : new TextEncoder().encode(String(content || ''));
  for (const p of ['/base/' + fileName, 'base/' + fileName, '/' + fileName, fileName]) {
    try {
      FS.writeFile(p, bytes);
    } catch (_) {}
  }
  return true;
}

function writeDemoToFS(fileName, uint8Bytes) {
  const mod = self.Module;
  if (!mod || !mod.FS || !uint8Bytes) return false;
  const FS = mod.FS;
  for (const d of ['/base', '/base/demos', 'base', 'base/demos']) {
    try {
      FS.mkdir(d);
    } catch (_) {}
  }
  const seenInodes = new Set();
  for (const p of ['/base/demos/' + fileName, 'base/demos/' + fileName]) {
    try {
      const parentPath = p.slice(0, p.lastIndexOf('/'));
      const parentStat = FS.stat(parentPath);
      if (parentStat && seenInodes.has(parentStat.ino)) continue;
      if (parentStat) seenInodes.add(parentStat.ino);
    } catch (_) {}
    try {
      FS.writeFile(p, uint8Bytes);
    } catch (_) {}
  }
  return true;
}

function cleanupWorkerDemoFS(opts) {
  const mod = self.Module;
  if (!mod || !mod.FS) return;
  const FS = mod.FS;
  const keepRaw = opts && opts.keepRawFile ? String(opts.keepRawFile) : '';
  const keepMmePrefix = opts && opts.keepMmeShortName ? String(opts.keepMmeShortName) : '';
  const dirs = [
    { path: '/base/demos', isMme: false },
    { path: 'base/demos', isMme: false },
    { path: '/base/mmedemos', isMme: true },
    { path: 'base/mmedemos', isMme: true },
  ];
  for (const d of dirs) {
    let entries = null;
    try {
      entries = FS.readdir(d.path);
    } catch (_) {
      entries = null;
    }
    if (!Array.isArray(entries)) continue;
    for (const name of entries) {
      if (!name || name === '.' || name === '..') continue;
      if (!d.isMme && keepRaw && name === keepRaw) continue;
      if (
        d.isMme &&
        keepMmePrefix &&
        (name === keepMmePrefix + '.mme' ||
          name === keepMmePrefix + '.txt' ||
          name.startsWith(keepMmePrefix + '.'))
      ) {
        continue;
      }
      try {
        FS.unlink(d.path + '/' + name);
      } catch (_) {}
    }
  }
}

async function loadDemoFromIdbOrNetwork(fileName, demoUrl, signal) {
  const db = await openCacheDB();
  if (db && fileName) {
    const cached = await new Promise((resolve) => {
      try {
        const tx = db.transaction(['demos'], 'readonly');
        const req = tx.objectStore('demos').get(fileName);
        req.onsuccess = () => {
          const row = req.result;
          if (row && row.data) {
            resolve(row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data));
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    if (cached && cached.byteLength > 16) return cached;
  }

  const candidates = [];
  if (demoUrl) candidates.push(demoUrl);
  if (fileName) {
    candidates.push('/demos/' + encodeURIComponent(fileName));
    candidates.push('/base/demos/' + encodeURIComponent(fileName));
    candidates.push('/' + encodeURIComponent(fileName));
  }
  for (const url of candidates) {
    if (signal && signal.aborted) return null;
    try {
      const resp = await fetch(url, { signal });
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes.byteLength > 16) return bytes;
      }
    } catch (_) {}
  }
  return null;
}

let engineReadyPromise = null;
let engineStarted = false;
let loadedDemoKey = '';
let cachedAutoexecText = '';

async function ensureWorkerEngineBooted(engineConfig, onBootProgress) {
  if (engineStarted && callWasm('JK_DemoIsReady', 'number', [], []) === 1) {
    return true;
  }
  if (engineReadyPromise) {
    return engineReadyPromise;
  }

  engineReadyPromise = (async () => {
    if (!offscreenCanvas) {
      throw new Error('OffscreenCanvas is not supported in this browser.');
    }
    const caps = await probeWebCodecsCaps();
    if (!caps.supported) {
      throw new Error('WebCodecs VideoEncoder is not available in this browser.');
    }

    const scriptUrl = engineConfig.scriptUrl || '/jkplayer/openjk.js';
    const wasmUrl = engineConfig.wasmUrl || '/jkplayer/openjk.wasm';
    const autoexecUrl = engineConfig.autoexecUrl || '/jkplayer/autoexec.cfg';

    if (onBootProgress) {
      onBootProgress('Loading export engine...', 6);
    }

    const [, , autoexecResp] = await Promise.all([
      hydrateCacheFromIndexedDB(192),
      fetchManifestIfNeeded(engineConfig.pk3Manifest || null),
      fetch(autoexecUrl).catch(() => null),
    ]);

    if (autoexecResp && autoexecResp.ok) {
      const txt = await autoexecResp.text().catch(() => '');
      if (txt && !/^\s*<!doctype/i.test(txt) && !/^\s*<html/i.test(txt)) {
        cachedAutoexecText = txt;
      }
    }
    if (!cachedAutoexecText) {
      cachedAutoexecText = DEFAULT_AUTOEXEC_CFG;
    }

    if (onBootProgress) {
      onBootProgress('Compiling export WebAssembly...', 18);
    }

    let bootSoftwareGl = false;
    try {
      const pCanvas = new OffscreenCanvas(4, 4);
      const pGl = pCanvas.getContext('webgl') || pCanvas.getContext('webgl2');
      if (pGl) {
        const dbg = pGl.getExtension('WEBGL_debug_renderer_info');
        const rend = dbg ? String(pGl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
        bootSoftwareGl = /llvmpipe|lavapipe|softpipe|swiftshader|basic render driver/i.test(rend);
        const lose = pGl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } else {
        bootSoftwareGl = true;
      }
    } catch (_) {}

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
      '+set', 'r_customwidth', '640',
      '+set', 'r_customheight', '360',
      '+set', 'r_ext_multitexture', '1',
      '+set', 'r_vertexLight', '0',
      '+set', 'r_picmip', bootSoftwareGl ? '1' : '0',
      '+set', 'r_detailtextures', bootSoftwareGl ? '0' : '1',
      '+set', 'in_InteractiveMode', '0',
      '+set', 'in_nograb', '1',
      '+set', 's_khz', '44',
      '+set', 's_volume', '0.8',
    ];

    if (onBootProgress) {
      onBootProgress('Initializing 3D renderer & audio mixer...', 28);
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      self.Module = {
        canvas: offscreenCanvas,
        noInitialRun: false,
        noImageDecoding: true,
        noAudioDecoding: true,
        arguments: engineArgs,
        locateFile(path) {
          if (path.endsWith('.wasm')) return wasmUrl;
          return path;
        },
        instantiateWasm(imports, successCallback) {
          const runStreaming = async () => {
            if (typeof WebAssembly.instantiateStreaming === 'function') {
              try {
                const res = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
                return res.instance;
              } catch (_) {}
            }
            const resp = await fetch(wasmUrl);
            if (!resp.ok) throw new Error('Failed to download openjk.wasm for export worker');
            const bytes = await resp.arrayBuffer();
            const res = await WebAssembly.instantiate(bytes, imports);
            return res.instance;
          };
          runStreaming()
            .then((inst) => successCallback(inst))
            .catch((err) => finish(err));
          return {};
        },
        preRun: [
          function () {
            writeConfigToFS('autoexec.cfg', cachedAutoexecText);
          },
        ],
        postRun: [
          function () {
            engineStarted = true;
            finish(null);
          },
        ],
        print() {},
        printErr(text) {
          if (
            text &&
            !text.includes('using emscripten GL') &&
            !text.includes('TODO: glShadeModel')
          ) {
            console.warn('[ExportWorker]', text);
          }
        },
      };

      try {
        importScripts(scriptUrl);
      } catch (err) {
        finish(err);
      }
    });

    for (let i = 0; i < 60; i++) {
      if (callWasm('JK_DemoIsReady', 'number', [], []) === 1) break;
      callWasm('JK_ExportStepFrame', 'number', [], []);
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 15; i++) {
      if (callWasm('JK_DemoPrewarmAssets', 'number', [], []) === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    return true;
  })();

  try {
    return await engineReadyPromise;
  } catch (err) {
    engineReadyPromise = null;
    throw err;
  }
}

async function planAndPrefetchDemoChunks(shortName, signal, onLoadProgress) {
  for (let pass = 0; pass < 4; pass++) {
    if (signal && signal.aborted) return;
    const rawPlan = callWasm('JK_DemoPlanLoadChunks', 'string', ['string'], [shortName]);
    if (!rawPlan) break;
    let plan = null;
    try {
      plan = JSON.parse(rawPlan);
    } catch (_) {}
    const rawSpans = plan && Array.isArray(plan.spans) ? plan.spans : [];
    const mapName = String((plan && plan.mapName) || '');
    const candidateByArchive = new Map();
    const sizeMap = new Map();

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

    const toHydrate = [];
    for (const [pk3Name, idxSet] of candidateByArchive.entries()) {
      for (const c of idxSet) {
        const subKey = pk3Name + ':' + c;
        if (!pk3ChunkCache.has(subKey) && idbKnownKeys.has('chunk:' + subKey)) {
          toHydrate.push(subKey);
        }
      }
    }
    const hydrated = toHydrate.length > 0 ? await loadChunksFromIdb(toHydrate) : 0;

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
      if (Number((plan && plan.bspReady) || 0) === 1 && hydrated === 0) {
        break;
      }
      continue;
    }

    const basePct = pass === 0 ? 40 : 58;
    const spanPct = pass === 0 ? 18 : 14;
    const labelPrefix = pass === 0 ? 'Loading map & models' : 'Loading map textures & sounds';
    const stageLabel = mapName ? `${labelPrefix} (${mapName})` : labelPrefix;
    let loadedBytes = 0;

    if (onLoadProgress) {
      const mbTotal = (totalEstimatedBytes / (1024 * 1024)).toFixed(1);
      onLoadProgress(`${stageLabel} (0.0 / ${mbTotal} MB)`, basePct);
    }

    let cursor = 0;
    const workers = [];
    for (let w = 0; w < Math.min(4, spans.length); w++) {
      workers.push(
        (async () => {
          while (cursor < spans.length) {
            if (signal && signal.aborted) return;
            const item = spans[cursor++];
            const got = await fetchPk3SpanIntoCache(
              item.pk3Name,
              item.cStart,
              item.cEnd,
              item.archSize,
              signal
            );
            loadedBytes += got > 0 ? got : item.estBytes;
            if (onLoadProgress && totalEstimatedBytes > 0) {
              const clamped = Math.min(loadedBytes, totalEstimatedBytes);
              const mbLoaded = (clamped / (1024 * 1024)).toFixed(1);
              const mbTotal = (totalEstimatedBytes / (1024 * 1024)).toFixed(1);
              const pct = basePct + Math.round((clamped / totalEstimatedBytes) * spanPct);
              onLoadProgress(`${stageLabel} (${mbLoaded} / ${mbTotal} MB)`, pct);
            }
          }
        })()
      );
    }
    await Promise.all(workers);
    await flushIdbWriteQueue();
  }
}

async function ensureDemoLoadedInWorker(source, settings, signal, onLoadProgress) {
  const demoKey = String(
    (source.isMmeStream ? 'mme:' + source.streamUrl : 'raw:' + (source.sourceUrl || source.fileName)) ||
      ''
  );
  const stateVal = callWasm('JK_DemoGetState', 'number', [], []);
  if (demoKey && demoKey === loadedDemoKey && stateVal === 8) {
    if (source.isMmeStream) {
      onLoadProgress('Buffering clip timeline...', 82);
      await prefetchMmeWindowChunks(settings.startMs, settings.endMs, signal);
    }
    return;
  }

  loadedDemoKey = '';
  callWasm('JK_DemoAbortPrepare', null, [], []);
  if (stateVal > 0) {
    execCommand('disconnect');
    callWasm('JK_ExportStepFrame', 'number', [], []);
  }
  cleanupWorkerDemoFS({ keepRawFile: '', keepMmeShortName: '' });
  await hydrateCacheFromIndexedDB();

  if (cachedAutoexecText) {
    const isCpuSoftwareGl = Boolean(
      offscreenCanvas &&
        (offscreenCanvas.__jkSoftwareMesaWebGL || offscreenCanvas.__jkUsingSoftwareWebGL)
    );
    const effectiveCfg = isCpuSoftwareGl
      ? cachedAutoexecText + '\nset r_picmip "1"\nset r_detailtextures "0"\n'
      : cachedAutoexecText;
    writeConfigToFS('autoexec.cfg', effectiveCfg);
    execCommand('execq autoexec.cfg');
    callWasm('JK_ExportStepFrame', 'number', [], []);
  }

  const shortName = String(source.shortName || 'current').replace(/\.(dm_26|mme)$/i, '') || 'current';
  const fileName = String(source.fileName || shortName + '.dm_26');

  if (source.isMmeStream && source.streamUrl) {
    let initBytes =
      source.mmeInitBytes instanceof Uint8Array
        ? source.mmeInitBytes
        : source.mmeInitBytes
        ? new Uint8Array(source.mmeInitBytes)
        : null;
    let meta = source.mmeMeta || null;

    const metaPromise = meta
      ? Promise.resolve(meta)
      : fetch(source.streamUrl + '&format=mme_meta', { signal }).then((r) =>
          r.ok ? r.json() : null
        );

    if (!initBytes || initBytes.byteLength < 16) {
      onLoadProgress('Downloading demo stream header...', 34);
      const initResp = await fetch(source.streamUrl + '&format=mme_init', { signal });
      if (!initResp.ok) {
        throw new Error('Failed to download demo stream header');
      }
      initBytes = new Uint8Array(await initResp.arrayBuffer());
    }
    if (signal && signal.aborted) return;

    mmeStreamState.active = true;
    mmeStreamState.baseUrl = source.streamUrl;
    mmeStreamState.fileSize = Math.max(initBytes.byteLength, 0x3fffffff);
    mmeStreamState.startTime = 0;
    mmeStreamState.endTime = 0;
    mmeStreamState.totalFrames = 1;
    mmeStreamState.index = [[15, 0, 0]];
    mmeStreamState.chunks.clear();
    storeMmeRangeBytes(0, initBytes);
    applyMmeStreamToWasm({
      fileSize: mmeStreamState.fileSize,
      startTime: 0,
      endTime: 0,
      totalFrames: 1,
      index: [[15, 0, 0]],
    });

    await planAndPrefetchDemoChunks(shortName, signal, onLoadProgress);
    if (signal && signal.aborted) return;

    onLoadProgress('Finalizing demo keyframe index...', 74);
    meta = await metaPromise;
    if (!meta || !meta.fileSize || !Array.isArray(meta.index)) {
      throw new Error('Failed to load demo keyframe index');
    }
    mmeStreamState.fileSize = Number(meta.fileSize);
    mmeStreamState.startTime = Number(meta.startTime || 0);
    mmeStreamState.endTime = Number(meta.endTime || 0);
    mmeStreamState.totalFrames = Number(meta.totalFrames || 1);
    mmeStreamState.index = meta.index;
    applyMmeStreamToWasm(meta);

    onLoadProgress('Buffering clip timeline...', 77);
    await prefetchMmeWindowChunks(settings.startMs, settings.endMs, signal);
  } else {
    resetMmeStream();
    let demoBytes =
      source.demoBytes instanceof Uint8Array
        ? source.demoBytes
        : source.demoBytes
        ? new Uint8Array(source.demoBytes)
        : null;
    if (!demoBytes || demoBytes.byteLength < 16) {
      onLoadProgress('Loading demo file...', 34);
      demoBytes = await loadDemoFromIdbOrNetwork(fileName, source.sourceUrl || '', signal);
    }
    if (!demoBytes || demoBytes.byteLength < 16) {
      throw new Error('Failed to load demo bytes for export');
    }
    writeDemoToFS(fileName, demoBytes);
    await planAndPrefetchDemoChunks(shortName, signal, onLoadProgress);
  }

  if (signal && signal.aborted) return;

  callWasm('JK_DemoSetLoop', 'number', ['number'], [0]);
  callWasm('JK_DemoSetMapOverbright', 'number', ['number'], [settings.overbright | 0]);

  onLoadProgress('Loading map & player models...', 80);
  const prepStarted = callWasm('JK_DemoPrepareBegin', 'number', ['string'], [shortName]);
  if (prepStarted === 1) {
    let stepSafety = 0;
    while (stepSafety < 5000) {
      if (signal && signal.aborted) {
        callWasm('JK_DemoAbortPrepare', null, [], []);
        return;
      }
      stepSafety++;
      const more = callWasm('JK_DemoPrepareStep', 'number', [], []);
      const rawStatus = callWasm('JK_DemoGetPrepareStatus', 'string', [], []);
      if (rawStatus) {
        try {
          const stObj = JSON.parse(rawStatus);
          const subPct = Math.max(0, Math.min(1, Number(stObj.pct || 0)));
          const overallPct = 80 + Math.round(subPct * 18);
          onLoadProgress(stObj.label || 'Preparing demo...', overallPct);
        } catch (_) {}
      }
      if (!more) break;
      if ((stepSafety & 3) === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } else {
    callWasm('JK_DemoLoad', 'number', ['string'], [shortName]);
  }

  // Step a couple initial frames so cgame finishes snapshot initialization
  for (let w = 0; w < 8; w++) {
    if (signal && signal.aborted) return;
    callWasm('JK_ExportStepFrame', 'number', [], []);
    if (callWasm('JK_DemoGetState', 'number', [], []) === 8) break;
  }

  // Once converted .mme is active, drop the raw .dm_26 copy from MEMFS to save RAM
  if (!source.isMmeStream && self.Module && self.Module.FS) {
    try {
      const mmeStat = self.Module.FS.stat('/base/mmedemos/' + shortName + '.mme');
      if (mmeStat && mmeStat.size > 16) {
        cleanupWorkerDemoFS({ keepRawFile: '', keepMmeShortName: shortName });
      }
    } catch (_) {}
  }

  loadedDemoKey = demoKey;
}

let activeJob = null;

async function prepareOpfsSpool(jobId) {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return null;
  }
  let root = null;
  let rawSync = null;
  const safeId = String(jobId || Date.now()).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const rawFileName = `jkexp-${safeId}.raw`;
  const outFileName = `jkexp-${safeId}.mp4`;
  try {
    root = await navigator.storage.getDirectory();
    if (typeof root.entries === 'function') {
      const prevMp4s = [];
      for await (const [entryName] of root.entries()) {
        if (!entryName || !entryName.startsWith('jkexp-')) continue;
        if (entryName.endsWith('.raw')) {
          try {
            await root.removeEntry(entryName);
          } catch (_) {}
        } else if (entryName.endsWith('.mp4')) {
          prevMp4s.push(entryName);
        }
      }
      if (prevMp4s.length > 1) {
        prevMp4s.sort();
        while (prevMp4s.length > 1) {
          const stale = prevMp4s.shift();
          try {
            await root.removeEntry(stale);
          } catch (_) {}
        }
      }
    }
    const rawHandle = await root.getFileHandle(rawFileName, { create: true });
    if (typeof rawHandle.createSyncAccessHandle !== 'function') {
      return null;
    }
    rawSync = await rawHandle.createSyncAccessHandle();
    rawSync.truncate(0);
    return {
      root,
      rawFileName,
      outFileName,
      rawSync,
      outSync: null,
      writeOffset: 0,
    };
  } catch (_) {
    if (rawSync) {
      try {
        await Promise.resolve(rawSync.close());
      } catch (_) {}
    }
    if (root) {
      try {
        await root.removeEntry(rawFileName);
      } catch (_) {}
    }
    return null;
  }
}

async function cleanupAbortedOpfsSpool(spool) {
  if (!spool) return;
  if (spool.outSync) {
    try {
      await Promise.resolve(spool.outSync.close());
    } catch (_) {}
    spool.outSync = null;
  }
  if (spool.rawSync) {
    try {
      await Promise.resolve(spool.rawSync.close());
    } catch (_) {}
    spool.rawSync = null;
  }
  if (spool.root) {
    for (const fname of [spool.rawFileName, spool.outFileName]) {
      if (!fname) continue;
      try {
        await spool.root.removeEntry(fname);
      } catch (_) {}
    }
  }
}

async function finalizeOpfsFastStartFile(spool, hdrBytes, finalFilename) {
  const outHandle = await spool.root.getFileHandle(spool.outFileName, { create: true });
  const outSync = await outHandle.createSyncAccessHandle();
  spool.outSync = outSync;
  outSync.truncate(0);

  let dstPos = 0;
  if (hdrBytes && hdrBytes.byteLength > 0) {
    outSync.write(hdrBytes, { at: 0 });
    dstPos = hdrBytes.byteLength;
  }

  const rawTotal = spool.writeOffset;
  if (rawTotal > 0 && spool.rawSync) {
    await Promise.resolve(spool.rawSync.flush());
    const copyBuf = new Uint8Array(Math.min(1024 * 1024, rawTotal));
    let srcPos = 0;
    while (srcPos < rawTotal) {
      const want = Math.min(copyBuf.byteLength, rawTotal - srcPos);
      const targetView = want === copyBuf.byteLength ? copyBuf : copyBuf.subarray(0, want);
      const got = spool.rawSync.read(targetView, { at: srcPos });
      if (!(got > 0)) break;
      const writeView = got === targetView.byteLength ? targetView : targetView.subarray(0, got);
      outSync.write(writeView, { at: dstPos });
      srcPos += got;
      dstPos += got;
    }
  }

  await Promise.resolve(outSync.flush());
  await Promise.resolve(outSync.close());
  spool.outSync = null;

  if (spool.rawSync) {
    try {
      await Promise.resolve(spool.rawSync.close());
    } catch (_) {}
    spool.rawSync = null;
  }
  try {
    await spool.root.removeEntry(spool.rawFileName);
  } catch (_) {}

  const diskFile = await outHandle.getFile();
  return new File([diskFile], finalFilename, {
    type: 'video/mp4',
    lastModified: Date.now(),
  });
}

async function runExportJob(msg) {
  const jobId = String(msg.jobId || '');
  const settings = msg.settings || {};
  const source = msg.source || {};
  const engineConfig = msg.engineConfig || {};

  const abortCtrl = new AbortController();
  const jobState = {
    jobId,
    cancelled: false,
    abortCtrl,
    opfsSpool: null,
    spoolOpened: false,
    spoolFinalized: false,
    fastStartHeader: null,
    pipedBytes: 0,
    fallbackBytes: 0,
    fallbackOverflow: false,
    fallbackChunks: [],
  };
  activeJob = jobState;
  self.__jkLastEncoderError = '';

  self.__jkMp4SpoolOpen = function () {
    if (jobState.cancelled) return 0;
    jobState.spoolOpened = true;
    jobState.spoolFinalized = false;
    jobState.fastStartHeader = null;
    jobState.pipedBytes = 0;
    if (jobState.opfsSpool && jobState.opfsSpool.rawSync) {
      try {
        jobState.opfsSpool.rawSync.truncate(0);
        jobState.opfsSpool.writeOffset = 0;
      } catch (_) {}
    } else {
      jobState.fallbackBytes = 0;
      jobState.fallbackChunks = [];
    }
    return 1;
  };

  self.__jkMp4SpoolWrite = function (uint8View) {
    if (jobState.cancelled || !uint8View || uint8View.byteLength === 0) return 0;
    const len = uint8View.byteLength;
    if (jobState.opfsSpool && jobState.opfsSpool.rawSync) {
      try {
        jobState.opfsSpool.rawSync.write(uint8View, { at: jobState.opfsSpool.writeOffset });
        jobState.opfsSpool.writeOffset += len;
        jobState.pipedBytes = jobState.opfsSpool.writeOffset;
        return len;
      } catch (errSpool) {
        console.warn('[ExportWorker] OPFS write error, falling back:', errSpool);
      }
    }
    if (jobState.fallbackBytes + len > MAX_FALLBACK_BLOB_BYTES) {
      jobState.fallbackOverflow = true;
      jobState.fallbackChunks = [];
      return 0;
    }
    const copy = new Uint8Array(len);
    copy.set(uint8View);
    jobState.fallbackBytes += len;
    jobState.pipedBytes = jobState.fallbackBytes;
    jobState.fallbackChunks.push(copy);
    return len;
  };

  self.__jkMp4SpoolFinalize = function (hdrCopy) {
    jobState.fastStartHeader = hdrCopy || null;
    jobState.spoolFinalized = true;
  };

  const emitLoading = (label, percent) => {
    if (jobState.cancelled) return;
    self.postMessage({
      type: 'PROGRESS',
      jobId,
      phase: 'loading',
      label: String(label || 'Loading...'),
      percent: Math.max(0, Math.min(99, Math.round(percent || 0))),
      encodedFrames: 0,
      totalFrames: 0,
      bytesWritten: 0,
      etaSeconds: null,
    });
  };

  try {
    jobState.opfsSpool = await prepareOpfsSpool(jobId);
    if (jobState.cancelled) throw new Error('CANCELLED');

    await ensureWorkerEngineBooted(engineConfig, emitLoading);
    if (jobState.cancelled) throw new Error('CANCELLED');

    await ensureDemoLoadedInWorker(source, settings, abortCtrl.signal, emitLoading);
    if (jobState.cancelled) throw new Error('CANCELLED');

    const width = Math.max(64, Math.min(4096, Math.round(Number(settings.width) || 1920))) & ~1;
    const height = Math.max(64, Math.min(4096, Math.round(Number(settings.height) || 1080))) & ~1;
    const fps = Math.max(15, Math.min(120, Number(settings.fps) || 60));
    const speed = Math.max(0.1, Math.min(8.0, Number(settings.speed) || 1.0));
    const startMs = Math.max(0, Math.round(Number(settings.startMs) || 0));
    const endMs = Math.max(startMs + 500, Math.round(Number(settings.endMs) || startMs + 5000));
    const blurFrames = Math.max(0, Math.min(64, Math.round(Number(settings.blurFrames) || 0)));
    const audioEnabled = settings.audio !== false;
    const musicEnabled = audioEnabled && settings.music !== false;
    const thirdPerson = Boolean(settings.thirdPerson);
    const gamma = Math.max(0.5, Math.min(3.0, Number(settings.gamma) || 1.0));
    const overbright = Math.max(0, Math.min(3, Math.round(Number(settings.overbright) || 0)));
    const hudMode = String(settings.hud || 'full');

    const clipDemoMs = Math.max(500, endMs - startMs);
    const clipOutputSec = clipDemoMs / 1000.0 / speed;
    const totalExpectedFrames = Math.max(1, Math.ceil(clipOutputSec * fps));
    self.__jkExportTotalExpectedFrames = totalExpectedFrames;

    // Rate control calculation (safe Discord <10MB / <50MB ceiling vs CRF)
    let targetVideoBitrate = 0;
    let maxMegs = 0;
    let crf = 20;
    let audioBitrate = audioEnabled ? 128000 : 0;
    const qualityPreset = String(settings.quality || 'discord10');

    if (qualityPreset === 'discord10' || qualityPreset === 'discord50') {
      // 8.5 MiB (~8.91 MB decimal) stays safely below Discord Free's 10 MB limit even with HW encoder variance
      maxMegs = qualityPreset === 'discord10' ? 8.5 : 44.0;
      if (qualityPreset === 'discord10' && clipOutputSec > 35 && audioEnabled) {
        audioBitrate = 96000;
      }
      const totalBudgetBits = maxMegs * 1024 * 1024 * 8 * 0.94;
      const availVideoBits = Math.max(
        220000 * clipOutputSec,
        totalBudgetBits - audioBitrate * clipOutputSec
      );
      const maxSensibleBitrate = Math.round(width * height * fps * 0.18);
      targetVideoBitrate = Math.max(
        220000,
        Math.min(maxSensibleBitrate, Math.floor(availVideoBits / Math.max(0.5, clipOutputSec)))
      );
      crf = 23;
    } else if (qualityPreset === 'crf18') {
      targetVideoBitrate = 0;
      maxMegs = 0;
      crf = 18;
    } else if (qualityPreset === 'crf23') {
      targetVideoBitrate = 0;
      maxMegs = 0;
      crf = 23;
    }

    const useFastPreroll = startMs > 160;
    const initW = useFastPreroll ? 160 : width;
    const initH = useFastPreroll ? 90 : height;

    offscreenCanvas.width = initW;
    offscreenCanvas.height = initH;
    self.innerWidth = initW;
    self.innerHeight = initH;
    self.screen.width = initW;
    self.screen.height = initH;
    callWasm('JK_DemoResizeViewport', 'number', ['number', 'number'], [initW, initH]);
    callWasm('JK_DemoSetThirdPerson', 'number', ['number'], [thirdPerson ? 1 : 0]);
    callWasm('JK_DemoSetMapOverbright', 'number', ['number'], [overbright]);

    const draw2D = hudMode === 'none' ? '0' : '1';
    const fragsOnly = hudMode === 'frags' ? '1' : '0';

    const cfgLines = [
      `set cg_fov "80"`,
      `set cg_fovAspectAdjust "1"`,
      `set mov_ratioFix "1"`,
      `set cg_draw2D "${draw2D}"`,
      `set mov_fragsOnly "${fragsOnly}"`,
      `set cg_thirdPerson "${thirdPerson ? '1' : '0'}"`,
      `set r_gamma "${gamma.toFixed(3)}"`,
      `set r_fbo "1"`,
      `set r_fboWidth "${initW}"`,
      `set r_fboHeight "${initH}"`,
      `set r_fboMultiSample "0"`,
      `set r_fboBlur "${blurFrames > 0 ? '1' : '0'}"`,
      `set mme_blurFrames "${blurFrames}"`,
      `set mme_blurOverlap "0"`,
      `set mme_blurType "gaussian"`,
      `set mme_saveShot "1"`,
      `set mme_saveDepth "0"`,
      `set mme_saveStencil "0"`,
      `set mme_saveCubemap "0"`,
      `set mme_dofFrames "0"`,
      `set mme_saveWav "${audioEnabled ? '2' : '0'}"`,
      `set s_volume "0.85"`,
      `set s_musicVolume "${musicEnabled ? '0.425' : '0'}"`,
      `set s_khz "44"`,
      `set mme_mp4Bitrate "${targetVideoBitrate}"`,
      `set mme_mp4MaxMegs "${maxMegs}"`,
      `set mme_mp4Crf "${crf}"`,
      `set mme_mp4AudioBitrate "${audioBitrate || 128000}"`,
    ];
    for (const line of cfgLines) {
      execCommand(line);
    }
    callWasm('JK_DemoSetMusicEnabled', 'number', ['number'], [musicEnabled ? 1 : 0]);

    emitLoading('Seeking to clip start...', 99);
    const started = callWasm(
      'JK_ExportStartCapture',
      'number',
      ['number', 'number', 'number', 'number', 'string', 'string'],
      [startMs, endMs, fps, speed, 'mp4', 'clip']
    );
    if (!started) {
      throw new Error('Engine was not in active demo playback state for capture');
    }

    let fullResApplied = !useFastPreroll;
    const applyFullExportResolution = () => {
      if (fullResApplied) return;
      fullResApplied = true;
      offscreenCanvas.width = width;
      offscreenCanvas.height = height;
      self.innerWidth = width;
      self.innerHeight = height;
      self.screen.width = width;
      self.screen.height = height;
      callWasm('JK_DemoResizeViewport', 'number', ['number', 'number'], [width, height]);
      execCommand(`set r_fboWidth "${width}"`);
      execCommand(`set r_fboHeight "${height}"`);
    };

    let renderStartWallMs = 0;
    let lastProgressSentAt = 0;
    let stepIterations = 0;
    const maxStepIterations = Math.max(5000, totalExpectedFrames * Math.max(1, blurFrames || 1) + 4000);

    while (!jobState.cancelled && stepIterations < maxStepIterations) {
      if (!fullResApplied) {
        const curMsBefore = callWasm('JK_DemoGetCurrentTimeMs', 'number', [], []) || 0;
        if (curMsBefore >= startMs - 80) {
          applyFullExportResolution();
        }
      }
      const batchLimit = !fullResApplied ? 16 : blurFrames >= 8 ? 2 : 4;
      let stillCapturing = 1;
      for (let b = 0; b < batchLimit; b++) {
        if (!fullResApplied) {
          const curMsCheck = callWasm('JK_DemoGetCurrentTimeMs', 'number', [], []) || 0;
          if (curMsCheck >= startMs - 80) {
            applyFullExportResolution();
            break;
          }
        }
        stillCapturing = callWasm('JK_ExportStepFrame', 'number', [], []);
        stepIterations++;
        if (!stillCapturing) break;
        const qSize = callWasm('JK_ExportGetQueueSize', 'number', [], []) || 0;
        if (qSize > 6) break;
      }

      if (self.__jkLastEncoderError) {
        throw new Error('Video encoder failed: ' + self.__jkLastEncoderError);
      }
      if (jobState.fallbackOverflow) {
        throw new Error('Export exceeded in-memory fallback buffer limit');
      }

      // Apply WebCodecs encoder backpressure so VideoFrame queue never builds up
      let backpressureWaits = 0;
      while (
        !jobState.cancelled &&
        (callWasm('JK_ExportGetQueueSize', 'number', [], []) || 0) > 8 &&
        backpressureWaits < 250
      ) {
        await new Promise((r) => setTimeout(r, 10));
        backpressureWaits++;
      }

      const encodedFrames = callWasm('JK_ExportGetCapturedFrames', 'number', [], []) || 0;
      const encodedBytes = Math.max(
        jobState.pipedBytes,
        callWasm('JK_ExportGetEncodedBytes', 'number', [], []) || 0
      );

      if (encodedFrames > 0 && renderStartWallMs === 0) {
        renderStartWallMs = performance.now();
      }

      const now = performance.now();
      if (now - lastProgressSentAt >= 90 || !stillCapturing) {
        lastProgressSentAt = now;
        if (encodedFrames === 0 && stillCapturing) {
          const curDemoMs = callWasm('JK_DemoGetCurrentTimeMs', 'number', [], []) || 0;
          const preStart = Math.max(0, startMs - 1000);
          const preSpan = Math.max(1, startMs - preStart);
          const preRatio = Math.max(0, Math.min(1, (curDemoMs - preStart) / preSpan));
          self.postMessage({
            type: 'PROGRESS',
            jobId,
            phase: 'preroll',
            label: 'Warming up particles & effects...',
            percent: Math.round(preRatio * 100),
            encodedFrames: 0,
            totalFrames: totalExpectedFrames,
            bytesWritten: 0,
            etaSeconds: null,
          });
        } else {
          const ratio = Math.max(0, Math.min(1, encodedFrames / totalExpectedFrames));
          let etaSeconds = null;
          if (renderStartWallMs > 0 && encodedFrames >= 4 && ratio < 1) {
            const elapsedSec = (now - renderStartWallMs) / 1000.0;
            const fpsRate = encodedFrames / Math.max(0.05, elapsedSec);
            if (fpsRate > 0.1) {
              etaSeconds = Math.max(0, Math.round((totalExpectedFrames - encodedFrames) / fpsRate));
            }
          }
          self.postMessage({
            type: 'PROGRESS',
            jobId,
            phase: 'rendering',
            label: `Rendering ${Math.min(encodedFrames, totalExpectedFrames)} / ${totalExpectedFrames} frames`,
            percent: Math.min(99, Math.round(ratio * 100)),
            encodedFrames: Math.min(encodedFrames, totalExpectedFrames),
            totalFrames: totalExpectedFrames,
            bytesWritten: encodedBytes,
            etaSeconds,
          });
        }
      }

      if (!stillCapturing) {
        break;
      }

      await new Promise((r) => setTimeout(r, 0));
    }

    if (jobState.cancelled) {
      throw new Error('CANCELLED');
    }

    // Flush WebCodecs H.264 encoder and finalize Fast-Start moov header
    callWasm('JK_ExportStopCapture', null, [], []);

    self.postMessage({
      type: 'PROGRESS',
      jobId,
      phase: 'flushing',
      label: 'Finalizing Fast-Start MP4...',
      percent: 99,
      encodedFrames: totalExpectedFrames,
      totalFrames: totalExpectedFrames,
      bytesWritten: jobState.pipedBytes,
      etaSeconds: 0,
    });

    let flushTicks = 0;
    while (
      !jobState.cancelled &&
      ((callWasm('JK_ExportIsFlushPending', 'number', [], []) || 0) > 0 ||
        (jobState.spoolOpened && !jobState.spoolFinalized)) &&
      flushTicks < 600
    ) {
      await new Promise((r) => setTimeout(r, 20));
      flushTicks++;
    }

    if (jobState.cancelled) {
      throw new Error('CANCELLED');
    }

    const finalFrames = callWasm('JK_ExportGetCapturedFrames', 'number', [], []) || totalExpectedFrames;
    const finalName = settings.filename || 'jka-clip.mp4';
    const hdrBytes = jobState.fastStartHeader;
    if (!hdrBytes || hdrBytes.byteLength < 32) {
      throw new Error('Failed to build MP4 header (no encoded video frames emitted)');
    }

    let outputFile = null;
    let usedDiskSpool = false;
    if (jobState.opfsSpool && jobState.opfsSpool.rawSync) {
      outputFile = await finalizeOpfsFastStartFile(jobState.opfsSpool, hdrBytes, finalName);
      usedDiskSpool = true;
    } else {
      const parts = [hdrBytes].concat(jobState.fallbackChunks);
      jobState.fallbackChunks = [];
      outputFile = new File(parts, finalName, {
        type: 'video/mp4',
        lastModified: Date.now(),
      });
    }

    self.postMessage({
      type: 'JOB_COMPLETE',
      jobId,
      filename: finalName,
      bytesWritten: outputFile.size,
      encodedFrames: finalFrames,
      fallbackBlob: outputFile,
      usedDiskSpool,
    });
  } catch (err) {
    try {
      callWasm('JK_ExportStopCapture', null, [], []);
    } catch (_) {}

    await cleanupAbortedOpfsSpool(jobState.opfsSpool);
    jobState.opfsSpool = null;
    jobState.fallbackChunks = [];

    const isCancelled =
      jobState.cancelled || (err && String(err.message || err) === 'CANCELLED');

    if (isCancelled) {
      self.postMessage({ type: 'JOB_CANCELLED', jobId });
    } else {
      console.error('[ExportWorker] Job failed:', err);
      self.postMessage({
        type: 'JOB_ERROR',
        jobId,
        error: String((err && err.message) || err || 'Export failed'),
      });
    }
  } finally {
    jobState.fallbackChunks = [];
    jobState.fastStartHeader = null;
    try {
      if (mmeStreamState.chunks.size > 2) {
        const initChunk = mmeStreamState.chunks.get(0);
        mmeStreamState.chunks.clear();
        if (initChunk) mmeStreamState.chunks.set(0, initChunk);
      }
      if (engineStarted && offscreenCanvas) {
        offscreenCanvas.width = 64;
        offscreenCanvas.height = 64;
        execCommand('set r_fboBlur "0"');
        execCommand('set r_fboWidth "64"');
        execCommand('set r_fboHeight "64"');
        callWasm('JK_DemoResizeViewport', 'number', ['number', 'number'], [64, 64]);
        callWasm('JK_ExportStepFrame', 'number', [], []);
      }
    } catch (_) {}
    if (activeJob === jobState) {
      activeJob = null;
    }
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'START_JOB') {
    runExportJob(data);
    return;
  }

  if (data.type === 'CANCEL_JOB') {
    if (activeJob && (!data.jobId || activeJob.jobId === data.jobId)) {
      activeJob.cancelled = true;
      try {
        activeJob.abortCtrl.abort();
      } catch (_) {}
    }
    return;
  }

  if (data.type === 'SHUTDOWN_WORKER') {
    try {
      pk3ChunkCache.clear();
      pk3CdCache.clear();
      mmeStreamState.chunks.clear();
      cleanupWorkerDemoFS({ keepRawFile: '', keepMmeShortName: '' });
      if (idbInstance) {
        try {
          idbInstance.close();
        } catch (_) {}
        idbInstance = null;
      }
      if (offscreenCanvas && offscreenCanvas.__jkActiveWebGLContext) {
        const ctx = offscreenCanvas.__jkActiveWebGLContext;
        if (typeof ctx.getExtension === 'function') {
          const loseExt = ctx.getExtension('WEBGL_lose_context');
          if (loseExt && typeof loseExt.loseContext === 'function') {
            loseExt.loseContext();
          }
        }
        offscreenCanvas.__jkActiveWebGLContext = null;
      }
    } catch (_) {}
  }
});
