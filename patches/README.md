# Emscripten Toolchain Patches (`6.0.13`)

Because `emsdk` unpacks `upstream/emscripten` as a non-git release archive, fixes to Emscripten's JavaScript WebGL / `LEGACY_GL_EMULATION` libraries (`src/lib/libglemu.js` and `src/lib/libwebgl.js`) are tracked here as [`emscripten-6.0.13-gl.patch`](./emscripten-6.0.13-gl.patch) alongside [`.emsdk-version`](../.emsdk-version).

## Usage

[`scripts/build_wasm.sh`](../scripts/build_wasm.sh) runs [`scripts/apply_emscripten_patches.sh`](../scripts/apply_emscripten_patches.sh) automatically before invoking CMake/Ninja. You can also run it directly:

```bash
# Idempotently verify version and apply patch if not already applied
./scripts/apply_emscripten_patches.sh

# Read-only check (exits non-zero if unpatched or wrong Emscripten version)
./scripts/apply_emscripten_patches.sh --check

# Revert back to stock Emscripten 6.0.13
./scripts/apply_emscripten_patches.sh --revert
```

## Summary of Changes in `emscripten-6.0.13-gl.patch`

### 1. Upstream `LEGACY_GL_EMULATION` Bugfixes (`src/lib/libglemu.js`)
- **Missing `$warnOnce` dependency**: Adds `'$warnOnce'` to `$GLEmulation__deps` so legacy GL warning paths do not throw `ReferenceError: warnOnce is not defined`.
- **`GL_TEXTURE_ENV_MODE` FFP shader-key invalidation**: Handles `case GL_TEXTURE_ENV_MODE:` in `TexEnvJIT.hook_texEnv` (`env.invalidateKey(); env.mode = param | 0;`) so multi-stage shaders switching between `GL_MODULATE`, `GL_REPLACE`, `GL_DECAL`, and `GL_ADD` rebind the matching generated fragment shader.
- **Lighting normal-matrix guard**: Checks `if (this.hasLighting)` instead of `GLEmulation.lightEnabled` before computing/uploading the 3x3 inverse-transpose normal matrix so unlit FFP programs do not touch nonexistent `u_normalMatrix` uniforms.
- **Active texture & element-array bounds guards**: Guards `s_activeTexture` in `hook_enable` / `hook_disable`, checks `this.texCoordLocations[i] >= 0` under `GL_FFP_ONLY`, and checks `GLctx.currentElementArrayBufferBinding` before rebinding `ELEMENT_ARRAY_BUFFER`.

### 2. JKA / Quake 3 Renderer WebGL Performance Tunings (`src/lib/libglemu.js`, `src/lib/libwebgl.js`)
- **2-TMU FFP cap (`libglemu.js`)**: Caps `GLImmediate.MAX_TEXTURES` to `Math.min(maxTextureUnits, 2)` instead of `28`, avoiding 28-unit state-scanning loops on every draw call (vanilla JKA uses at most 2 texture units: diffuse + lightmap/environment).
- **Redundant state/uniform deduplication (`libglemu.js`)**: Skips redundant `setClientAttrib` updates, caches `lastAlphaTestRef` per FFP program, and compares the 16 floats in `glLoadMatrixf` before bumping `matrixVersion`.
- **3-bank temporary VBO/IBO ringbuffer without `getParameter` stalls (`libwebgl.js`)**: Raises `GL.numTempVertexBuffersPerSize` from `64` to `1024`, rotates temporary vertex and index buffers across 3 frame banks (`tempVertexBuffersBanks` / `tempIndexBuffersBanks`), and removes synchronous `GLctx.getParameter(GL_ARRAY_BUFFER_BINDING / ELEMENT_ARRAY_BUFFER_BINDING)` roundtrips during on-demand buffer allocation.
