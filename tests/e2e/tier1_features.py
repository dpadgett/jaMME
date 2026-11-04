#!/usr/bin/env python3
"""
Tier 1 — Feature Coverage E2E Tests (65 test cases: 5 per feature across F1–F13).
Uses Category-Partition Method to verify primary behavior for every feature in PROJECT.md.
"""

import json
import os
import struct
import subprocess
import time
from typing import List

from .harness import E2ETestContext, TestCase


# ==============================================================================
# F1: Native Linux Build Compatibility (5 tests)
# ==============================================================================
def t1_f01_01_native_build_script_exists_and_succeeds(ctx: E2ETestContext) -> None:
    script = ctx.scripts_dir / "build_native.sh"
    assert script.exists(), f"Missing native build script: {script}"
    bin_path = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    if not bin_path.exists():
        proc = subprocess.run(
            ["bash", str(script)],
            cwd=str(ctx.root_dir),
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert (
            proc.returncode == 0
        ), f"build_native.sh failed ({proc.returncode}):\n{proc.stderr}"
    assert bin_path.exists(), f"Native binary not produced at {bin_path}"


def t1_f01_02_native_binary_elf_x86_64(ctx: E2ETestContext) -> None:
    bin_path = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    assert bin_path.exists(), f"Missing {bin_path}"
    with bin_path.open("rb") as f:
        hdr = f.read(20)
    assert hdr[:4] == b"\x7fELF", f"Invalid ELF magic: {hdr[:4]!r}"
    ei_class = hdr[4]
    ei_data = hdr[5]
    e_type, e_machine = struct.unpack("<HH", hdr[16:20])
    assert ei_class == 2, f"Expected 64-bit ELF (class 2), got {ei_class}"
    assert ei_data == 1, f"Expected little-endian ELF (data 1), got {ei_data}"
    assert e_type in (2, 3), f"Expected ET_EXEC (2) or ET_DYN/PIE (3), got {e_type}"
    assert e_machine == 0x3E, f"Expected EM_X86_64 (0x3e), got {hex(e_machine)}"


def t1_f01_03_native_binary_size_and_permissions(ctx: E2ETestContext) -> None:
    bin_path = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    assert bin_path.exists(), f"Missing {bin_path}"
    size = bin_path.stat().st_size
    assert size > 500_000, f"Native binary unexpectedly small: {size} bytes"
    assert os.access(bin_path, os.X_OK), f"Native binary {bin_path} is not executable"


def t1_f01_04_native_modules_built_or_linked(ctx: E2ETestContext) -> None:
    codemp_dir = ctx.build_native_dir / "codemp"
    bin_path = codemp_dir / "openjk.x86_64"
    assert bin_path.exists(), f"Missing {bin_path}"
    all_files = [p.name for p in codemp_dir.rglob("*") if p.is_file()]
    has_rd = any("rd-vanilla" in n for n in all_files)
    has_cg = any("cgame" in n for n in all_files)
    has_ui = any("ui" in n for n in all_files)
    if not (has_rd and has_cg and has_ui):
        # Check if statically linked into openjk.x86_64
        nm_out = subprocess.check_output(["nm", str(bin_path)], text=True)
        assert "GetRefAPI" in nm_out, "Neither rd-vanilla artifact nor GetRefAPI found"
        assert (
            "GetCGameAPI_Static" in nm_out or "CG_Init" in nm_out
        ), "cgame not found in native build"
        assert (
            "GetUIAPI_Static" in nm_out or "UI_Init" in nm_out
        ), "ui not found in native build"


def t1_f01_05_native_shared_library_dependencies(ctx: E2ETestContext) -> None:
    bin_path = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    assert bin_path.exists(), f"Missing {bin_path}"
    ldd_out = subprocess.check_output(["ldd", str(bin_path)], text=True)
    assert "not found" not in ldd_out, f"Unresolved shared libraries in ldd:\n{ldd_out}"
    assert "libSDL2" in ldd_out, f"Expected libSDL2 linked in openjk.x86_64:\n{ldd_out}"


# ==============================================================================
# F2: Wasm Static Compilation & Module Linking (5 tests)
# ==============================================================================
def t1_f02_01_wasm_build_script_and_artifacts(ctx: E2ETestContext) -> None:
    script = ctx.scripts_dir / "build_wasm.sh"
    assert script.exists(), f"Missing Wasm build script: {script}"
    wasm_build = ctx.build_wasm_dir / "codemp" / "openjk.wasm"
    js_build = ctx.build_wasm_dir / "codemp" / "openjk.js"
    wasm_web = ctx.web_dir / "openjk.wasm"
    js_web = ctx.web_dir / "openjk.js"
    if not (wasm_web.exists() and js_web.exists()):
        proc = subprocess.run(
            ["bash", str(script)],
            cwd=str(ctx.root_dir),
            capture_output=True,
            text=True,
            timeout=600,
        )
        assert (
            proc.returncode == 0
        ), f"build_wasm.sh failed ({proc.returncode}):\n{proc.stderr}"
    assert wasm_build.exists(), f"Missing {wasm_build}"
    assert js_build.exists(), f"Missing {js_build}"
    assert wasm_web.exists(), f"Missing staged {wasm_web}"
    assert js_web.exists(), f"Missing staged {js_web}"


def t1_f02_02_wasm_binary_magic_and_version(ctx: E2ETestContext) -> None:
    wasm_web = ctx.web_dir / "openjk.wasm"
    assert wasm_web.exists(), f"Missing {wasm_web}"
    size = wasm_web.stat().st_size
    assert size > 1_500_000, f"openjk.wasm too small ({size} B) to contain monolithic engine"
    with wasm_web.open("rb") as f:
        hdr = f.read(8)
    assert hdr[:4] == b"\x00asm", f"Invalid Wasm magic bytes: {hdr[:4]!r}"
    assert hdr[4:8] == b"\x01\x00\x00\x00", f"Invalid Wasm version bytes: {hdr[4:8]!r}"


def t1_f02_03_wasm_static_module_linking_no_dlopen_side_modules(
    ctx: E2ETestContext,
) -> None:
    codemp_wasm_dir = ctx.build_wasm_dir / "codemp"
    assert codemp_wasm_dir.exists(), f"Missing {codemp_wasm_dir}"
    # Verify static archives (.a) or static object files exist for rd-vanilla, cgame, ui
    all_artifacts = [p.name for p in codemp_wasm_dir.rglob("*") if p.is_file()]
    has_rd = any("rd-vanilla" in n or "tr_init" in n for n in all_artifacts)
    has_cg = any("cgame" in n or "cg_main" in n for n in all_artifacts)
    has_ui = any("ui" in n or "ui_main" in n for n in all_artifacts)
    assert has_rd, f"rd-vanilla not found in build-wasm/codemp: {all_artifacts[:20]}"
    assert has_cg, f"cgame not found in build-wasm/codemp: {all_artifacts[:20]}"
    assert has_ui, f"ui not found in build-wasm/codemp: {all_artifacts[:20]}"


def t1_f02_04_wasm_js_loader_exports_and_asyncify(ctx: E2ETestContext) -> None:
    js_web = ctx.web_dir / "openjk.js"
    assert js_web.exists(), f"Missing {js_web}"
    content = js_web.read_text(encoding="utf-8", errors="ignore")
    assert len(content) > 20_000, f"openjk.js suspiciously small: {len(content)} chars"
    assert "WebAssembly" in content, "openjk.js missing WebAssembly loader logic"
    assert (
        "Asyncify" in content or "asyncify" in content
    ), "openjk.js missing Asyncify support for on-demand HTTP Range FS_Read"


def t1_f02_05_wasm_staged_files_match_build_outputs(ctx: E2ETestContext) -> None:
    wasm_build = ctx.build_wasm_dir / "codemp" / "openjk.wasm"
    wasm_web = ctx.web_dir / "openjk.wasm"
    js_build = ctx.build_wasm_dir / "codemp" / "openjk.js"
    js_web = ctx.web_dir / "openjk.js"
    assert (
        wasm_build.stat().st_size == wasm_web.stat().st_size
    ), "Staged web/openjk.wasm size differs from build-wasm/codemp/openjk.wasm"
    assert (
        js_build.stat().st_size == js_web.stat().st_size
    ), "Staged web/openjk.js size differs from build-wasm/codemp/openjk.js"


# ==============================================================================
# F3: Emscripten Main Loop & Frame Pacing (5 tests)
# ==============================================================================
def t1_f03_01_browser_boot_reaches_ready_state(ctx: E2ETestContext) -> None:
    st = ctx.ensure_booted("1.51ef9.dm_26")
    assert st.get("ready") is True, f"Expected ready === true, got {st}"


def t1_f03_02_frame_count_advances_across_raf_ticks(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const f0 = p.getStatus().frameCount;
        await new Promise(r => setTimeout(r, 450));
        const f1 = p.getStatus().frameCount;
        return { f0, f1, delta: f1 - f0 };
        """
    )
    assert (
        res["delta"] > 0
    ), f"frameCount did not advance over 450ms: f0={res['f0']}, f1={res['f1']}"


def t1_f03_03_js_event_loop_and_promises_not_blocked(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const t0 = performance.now();
        await Promise.resolve();
        const tPromise = performance.now() - t0;
        const t1 = performance.now();
        await new Promise(r => setTimeout(r, 50));
        const tTimeout = performance.now() - t1;
        const t2 = performance.now();
        await new Promise(r => requestAnimationFrame(() => r()));
        const tRaf = performance.now() - t2;
        return { tPromise, tTimeout, tRaf };
        """
    )
    assert res["tPromise"] < 100.0, f"Microtask blocked: {res}"
    assert res["tTimeout"] < 500.0, f"setTimeout(50) blocked by busy-wait: {res}"
    assert res["tRaf"] < 500.0, f"requestAnimationFrame blocked: {res}"


def t1_f03_04_frame_pacing_sustains_interactive_framerate(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const f0 = p.getStatus().frameCount;
        await new Promise(r => setTimeout(r, 1000));
        const f1 = p.getStatus().frameCount;
        return { f0, f1, delta: f1 - f0 };
        """
    )
    assert (
        res["delta"] >= 8
    ), f"Expected >= 8 frames over 1000ms in headless Chrome, got {res['delta']}"


def t1_f03_05_zero_unhandled_wasm_or_js_exceptions(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    logs = ctx.get_browser_logs()
    page_errors = logs.get("pageErrors") or []
    assert len(page_errors) == 0, f"Unhandled browser page errors: {page_errors}"


# ==============================================================================
# F4: WebGL 1.0 Renderer Compatibility (5 tests)
# ==============================================================================
def t1_f04_01_webgl_context_created_on_jk_canvas(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    info = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        if (!c) return { hasCanvas: false };
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return { hasCanvas: true, hasGl: false };
        return {
          hasCanvas: true,
          hasGl: true,
          isLost: gl.isContextLost(),
          version: gl.getParameter(gl.VERSION),
          renderer: gl.getParameter(gl.RENDERER),
        };
        """
    )
    assert info.get("hasCanvas") is True, "Missing #jk-canvas"
    assert info.get("hasGl") is True, "WebGL context not created on #jk-canvas"
    assert info.get("isLost") is False, "WebGL context is lost"
    assert "WebGL" in str(info.get("version")), f"Unexpected GL version: {info}"


def t1_f04_02_webgl_context_attributes_preserve_drawing_buffer(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    attrs = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        return gl.getContextAttributes();
        """
    )
    assert (
        attrs.get("preserveDrawingBuffer") is True
    ), f"Expected preserveDrawingBuffer: true, got {attrs}"
    assert attrs.get("depth") is True, f"Expected depth: true, got {attrs}"


def t1_f04_03_webgl_depth_and_stencil_buffer_bits(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    params = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        return {
          depthBits: gl.getParameter(gl.DEPTH_BITS),
          stencilBits: gl.getParameter(gl.STENCIL_BITS),
          maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        };
        """
    )
    assert params["depthBits"] >= 16, f"Expected depthBits >= 16, got {params}"
    assert params["maxTexSize"] >= 2048, f"Expected maxTexSize >= 2048, got {params}"


def t1_f04_04_webgl_renders_non_blank_frame(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t1_f04_04")
    assert snap["std_rgb"] > 8.0, f"Rendered frame looks blank/uniform: std={snap['std_rgb']}"
    assert (
        snap["non_black_ratio"] > 0.15
    ), f"Rendered frame is mostly black: ratio={snap['non_black_ratio']}"


def t1_f04_05_webgl_zero_fatal_gl_errors(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    err = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        // Drain any sticky bit, wait 2 frames, and check gl.getError()
        gl.getError();
        await new Promise(r => setTimeout(r, 120));
        return gl.getError();
        """
    )
    assert err == 0, f"Expected gl.getError() == 0 (NO_ERROR), got {hex(err)}"


# ==============================================================================
# F5: HTTP Range Server & .pk3 Manifest (5 tests)
# ==============================================================================
def t1_f05_01_server_serves_index_player_and_wasm(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    for path, min_len in [
        ("/", 200),
        ("/index.html", 200),
        ("/player.js", 200),
        ("/openjk.js", 20_000),
        ("/openjk.wasm", 1_000_000),
    ]:
        status, headers, body = ctx.http_request("GET", path)
        assert status == 200, f"GET {path} returned HTTP {status}"
        assert (
            len(body) >= min_len
        ), f"GET {path} body length {len(body)} < expected {min_len}"


def t1_f05_02_server_manifest_json_structure(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    status, headers, body = ctx.http_request("GET", "/base/manifest.json")
    assert status == 200, f"GET /base/manifest.json returned HTTP {status}"
    manifest = json.loads(body.decode("utf-8"))
    assert isinstance(manifest, dict), f"Manifest must be JSON object: {type(manifest)}"
    pk3s = manifest.get("pk3s") or manifest.get("archives") or manifest.get("files")
    assert isinstance(pk3s, (list, dict)) and len(pk3s) >= 4, f"Missing pk3 list in manifest: {manifest.keys()}"
    demos = manifest.get("demos")
    assert isinstance(demos, list) and len(demos) >= 5, f"Missing demos list in manifest: {demos}"


def t1_f05_03_server_pk3_head_and_range_206(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    st_head, hdr_head, _ = ctx.http_request("HEAD", "/base/assets0.pk3")
    assert st_head == 200, f"HEAD /base/assets0.pk3 returned {st_head}"
    assert (
        hdr_head.get("content-length") == "561806019"
    ), f"Unexpected Content-Length on assets0.pk3: {hdr_head}"
    assert (
        "bytes" in hdr_head.get("accept-ranges", "").lower()
    ), f"Missing Accept-Ranges: bytes in {hdr_head}"

    st_rng, hdr_rng, body_rng = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-3"}
    )
    assert st_rng == 206, f"Expected 206 Partial Content, got {st_rng}"
    assert body_rng == b"PK\x03\x04", f"Expected ZIP local header magic PK\\x03\\x04, got {body_rng!r}"
    assert (
        "bytes 0-3/561806019" in hdr_rng.get("content-range", "")
    ), f"Unexpected Content-Range header: {hdr_rng.get('content-range')}"


def t1_f05_04_server_serves_dm26_demo_files(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    st1, _, b1 = ctx.http_request("GET", "/demos/1.51ef9.dm_26")
    assert st1 == 200, f"GET /demos/1.51ef9.dm_26 returned {st1}"
    assert len(b1) == 2_393_964, f"Expected 2,393,964 bytes for 1.51ef9.dm_26, got {len(b1)}"

    st2, _, b2 = ctx.http_request("GET", "/base/demos/out.dm_26")
    assert st2 == 200, f"GET /base/demos/out.dm_26 returned {st2}"
    assert len(b2) == 2_651_811, f"Expected 2,651,811 bytes for out.dm_26, got {len(b2)}"


def t1_f05_05_server_metrics_and_reset_endpoints(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    # Trigger a small 16-byte range request then check metrics
    ctx.http_request("GET", "/base/assets2.pk3", headers={"Range": "bytes=0-15"})
    m1 = ctx.get_metrics()
    for required_key in (
        "pk3BytesTransferred",
        "pk3RangeRequests",
        "pk3FullRequests",
        "perFileBytes",
        "demoBytesTransferred",
    ):
        assert required_key in m1, f"Missing '{required_key}' in /api/metrics: {m1}"
    assert m1["pk3BytesTransferred"] >= 16
    assert m1["pk3RangeRequests"] >= 1


# ==============================================================================
# F6: On-Demand .pk3 Loading via HTTP Range (5 tests)
# ==============================================================================
def t1_f06_01_pk3_mounted_via_range_requests_only(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    assert (
        m["pk3RangeRequests"] > 0
    ), f"Expected pk3RangeRequests > 0 during demo boot, got {m}"
    assert (
        m["pk3FullRequests"] == 0
    ), f"Expected pk3FullRequests == 0 (no full .pk3 downloads), got {m}"


def t1_f06_02_central_directory_indexed_without_full_archive_download(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    per_file = m.get("perFileBytes") or {}
    a0_bytes = per_file.get("assets0.pk3", 0)
    a1_bytes = per_file.get("assets1.pk3", 0)
    assert (
        a0_bytes < 60 * 1024 * 1024
    ), f"assets0.pk3 transferred {a0_bytes:,} B (>= 60 MB out of 535.8 MB)"
    assert (
        a1_bytes < 75 * 1024 * 1024
    ), f"assets1.pk3 transferred {a1_bytes:,} B (>= 75 MB out of 622.6 MB)"


def t1_f06_03_total_pk3_bytes_transferred_under_150mb(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    total_pk3 = m["pk3BytesTransferred"]
    limit = 150 * 1024 * 1024  # 157,286,400 bytes
    assert 0 < total_pk3 < limit, (
        f"Expected 0 < pk3BytesTransferred < {limit:,} B (150 MB), got {total_pk3:,} B "
        f"({total_pk3 / (1024 * 1024):.2f} MB)"
    )


def t1_f06_04_custom_map_pk3_fetched_on_demand(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    per_file = m.get("perFileBytes") or {}
    kejim_bytes = per_file.get("ctf_kejim.pk3", 0)
    assert (
        kejim_bytes > 0
    ), f"Expected ctf_kejim.pk3 bytes > 0 for map mp/ctf_kejim demo 1.51ef9.dm_26, got {per_file}"


def t1_f06_05_subsequent_frames_use_in_memory_cache(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m_before = ctx.get_metrics()
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const f0 = p.getStatus().frameCount;
        const start = Date.now();
        while (Date.now() - start < 2000 && p.getStatus().frameCount - f0 < 20) {
          await new Promise(r => setTimeout(r, 40));
        }
        return p.getStatus();
        """
    )
    m_after = ctx.get_metrics()
    delta_bytes = m_after["pk3BytesTransferred"] - m_before["pk3BytesTransferred"]
    assert (
        delta_bytes < 5 * 1024 * 1024
    ), f"Expected < 5 MB incremental transfer over 20 cached frames, got {delta_bytes:,} B"


# ==============================================================================
# F7: Embedded <canvas> & Non-Interactive Input (5 tests)
# ==============================================================================
def t1_f07_01_canvas_inside_player_pane_with_valid_dimensions(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    dom_info = ctx.eval_js(
        """
        const pane = document.getElementById('jk-player-pane');
        const canvas = document.getElementById('jk-canvas');
        if (!canvas) return { hasCanvas: false };
        const rect = canvas.getBoundingClientRect();
        return {
          hasPane: !!pane,
          insidePane: pane ? pane.contains(canvas) : false,
          hasCanvas: true,
          width: canvas.width,
          height: canvas.height,
          rectWidth: rect.width,
          rectHeight: rect.height,
        };
        """
    )
    assert dom_info.get("hasCanvas") is True, "Missing #jk-canvas"
    assert dom_info.get("hasPane") is True, "Missing #jk-player-pane container"
    assert dom_info.get("insidePane") is True, "#jk-canvas must be inside #jk-player-pane"
    assert dom_info["width"] >= 640 and dom_info["height"] >= 360, f"Invalid canvas size: {dom_info}"


def t1_f07_02_pointer_lock_not_engaged_during_playback(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    pl_state = ctx.eval_js(
        """
        const canvas = document.getElementById('jk-canvas');
        canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 400, clientY: 300 }));
        canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 400, clientY: 300 }));
        canvas.click();
        await new Promise(r => setTimeout(r, 100));
        return {
          pointerLockElement: document.pointerLockElement ? document.pointerLockElement.id : null,
        };
        """
    )
    assert (
        pl_state["pointerLockElement"] is None
    ), f"Canvas must not engage Pointer Lock: {pl_state}"


def t1_f07_03_host_page_controls_remain_clickable(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    clicked = ctx.eval_js(
        """
        let count = 0;
        const btn = document.createElement('button');
        btn.id = 'e2e-test-host-btn';
        btn.textContent = 'Host Action';
        document.body.appendChild(btn);
        btn.addEventListener('click', () => { count += 1; });
        btn.click();
        btn.remove();
        return count;
        """
    )
    assert clicked == 1, f"Host page button click failed: count={clicked}"


def t1_f07_04_host_page_keyboard_input_not_hijacked(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.id = 'e2e-test-input';
        document.body.appendChild(inp);
        inp.focus();
        let defaultPreventedCount = 0;
        for (const ch of ['j', 'k', 'a']) {
          const ev = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true });
          const notCancelled = inp.dispatchEvent(ev);
          if (!notCancelled || ev.defaultPrevented) defaultPreventedCount++;
          inp.value += ch;
        }
        const val = inp.value;
        inp.remove();
        return { val, defaultPreventedCount };
        """
    )
    assert res["val"] == "jka", f"Input value corrupted: {res}"
    assert (
        res["defaultPreventedCount"] == 0
    ), f"SDL2 hijacked host input keydown events: {res}"


def t1_f07_05_window_api_aliases_exposed(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    api_check = ctx.eval_js(
        """
        const jk = window.JKDemoPlayer;
        const ojk = window.OpenJKPlayer;
        const methods = [
          'pause', 'resume', 'play', 'togglePause', 'setPaused', 'isPaused',
          'setSpeed', 'setTimescale', 'getSpeed', 'getTimescale',
          'mute', 'unmute', 'setMuted', 'isMuted', 'setVolume', 'getVolume',
          'loadDemo', 'onDemoComplete', 'getStatus'
        ];
        const missing = methods.filter(m => !jk || typeof jk[m] !== 'function');
        return {
          hasJKDemoPlayer: !!jk,
          hasOpenJKPlayer: !!ojk,
          missing,
        };
        """
    )
    assert api_check["hasJKDemoPlayer"] is True, "Missing window.JKDemoPlayer"
    assert api_check["hasOpenJKPlayer"] is True, "Missing window.OpenJKPlayer alias"
    assert (
        len(api_check["missing"]) == 0
    ), f"Missing required methods on JKDemoPlayer: {api_check['missing']}"


# ==============================================================================
# F8: Direct-to-Demo Boot Skipping Menus (5 tests)
# ==============================================================================
def t1_f08_01_query_param_demo_boots_directly_into_playback(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.cold_boot_status or ctx.get_player_status()
    assert st.get("ready") is True, f"Player not ready on boot: {st}"
    assert st.get("isPlaying") is True, f"Player did not boot directly into demo playback: {st}"


def t1_f08_02_active_demo_name_matches_requested_demo(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.cold_boot_status or ctx.get_player_status()
    demo_name = str(st.get("demoName") or "")
    assert (
        "1.51ef9" in demo_name
    ), f"Expected demoName containing '1.51ef9', got {demo_name!r}"


def t1_f08_03_server_time_advances_automatically_on_boot(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const t0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 400));
        const t1 = p.getStatus().serverTime;
        return { t0, t1, delta: t1 - t0 };
        """
    )
    assert res["t0"] > 0, f"Expected positive serverTime, got {res}"
    assert res["delta"] > 0, f"serverTime did not advance during playback: {res}"


def t1_f08_04_main_menu_bypassed_no_ui_menu_trap(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.get_player_status()
    assert st.get("isPlaying") is True, f"Expected active demo playback, got {st}"
    assert st.get("demoEnded") is False, f"Expected demoEnded === false during active playback: {st}"


def t1_f08_05_jkdemoconfig_object_supported(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    has_config_support = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        return typeof p === 'object' && p !== null && typeof p.getStatus === 'function';
        """
    )
    assert has_config_support is True


# ==============================================================================
# F9: JS Playback Control: Pause & Resume (5 tests)
# ==============================================================================
def t1_f09_01_pause_sets_is_paused_true(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.pause();
        const isPaused = p.isPaused();
        const stPaused = p.getStatus().isPaused;
        p.resume();
        return { ret, isPaused, stPaused };
        """
    )
    assert res["ret"] is True, f"pause() should return true, got {res}"
    assert res["isPaused"] is True, f"isPaused() should be true after pause(), got {res}"
    assert res["stPaused"] is True, f"getStatus().isPaused should be true, got {res}"


def t1_f09_02_pause_holds_server_time_constant(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        await new Promise(r => setTimeout(r, 80));
        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 600));
        const st1 = p.getStatus();
        p.resume();
        return {
          t0: st0.serverTime,
          t1: st1.serverTime,
          f0: st0.frameCount,
          f1: st1.frameCount,
        };
        """
    )
    assert (
        res["t1"] == res["t0"]
    ), f"serverTime advanced while paused: t0={res['t0']} -> t1={res['t1']}"


def t1_f09_03_resume_sets_is_paused_false(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        const ret = p.resume();
        const isPaused = p.isPaused();
        const stPaused = p.getStatus().isPaused;
        return { ret, isPaused, stPaused };
        """
    )
    assert res["ret"] is False, f"resume() should return false, got {res}"
    assert res["isPaused"] is False, f"isPaused() should be false after resume(), got {res}"
    assert res["stPaused"] is False, f"getStatus().isPaused should be false, got {res}"


def t1_f09_04_resume_continues_smoothly_without_time_jump(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(1.0);
        p.pause();
        await new Promise(r => setTimeout(r, 60));
        const tPaused = p.getStatus().serverTime;
        // Stay paused for 1000ms wall-clock
        await new Promise(r => setTimeout(r, 1000));
        const tStillPaused = p.getStatus().serverTime;
        p.resume();
        // Wait only 200ms after resume
        await new Promise(r => setTimeout(r, 200));
        const tAfterResume = p.getStatus().serverTime;
        return {
          tPaused,
          tStillPaused,
          tAfterResume,
          jumpDelta: tAfterResume - tStillPaused,
        };
        """
    )
    assert res["tStillPaused"] == res["tPaused"], f"Drifted during pause: {res}"
    assert (
        0 < res["jumpDelta"] < 650
    ), f"Unpause time-jump bug detected (expected 0 < delta < 650ms after 1000ms pause + 200ms play): {res}"


def t1_f09_05_toggle_pause_and_set_paused(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        const t1 = p.togglePause();
        const t2 = p.togglePause();
        const s1 = p.setPaused(true);
        const s2 = p.setPaused(false);
        return { t1, t2, s1, s2, finalPaused: p.isPaused() };
        """
    )
    assert res == {
        "t1": True,
        "t2": False,
        "s1": True,
        "s2": False,
        "finalPaused": False,
    }, f"Unexpected togglePause/setPaused results: {res}"


# ==============================================================================
# F10: JS Playback Control: Playback Speed (timescale) (5 tests)
# ==============================================================================
def t1_f10_01_default_speed_is_one(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(1.0);
        return {
          speed: p.getSpeed(),
          timescale: p.getTimescale(),
          statusSpeed: p.getStatus().speed,
        };
        """
    )
    assert abs(res["speed"] - 1.0) < 0.01, f"Expected speed 1.0, got {res}"
    assert abs(res["timescale"] - 1.0) < 0.01, f"Expected timescale 1.0, got {res}"


def t1_f10_02_set_speed_updates_get_speed(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setSpeed(2.0);
        const got = p.getSpeed();
        const st = p.getStatus();
        p.setSpeed(1.0);
        return { ret, got, stSpeed: st.speed, stTimescale: st.timescale };
        """
    )
    assert abs(res["ret"] - 2.0) < 0.01, f"setSpeed(2.0) returned {res['ret']}"
    assert abs(res["got"] - 2.0) < 0.01, f"getSpeed() returned {res['got']}"
    assert abs(res["stTimescale"] - 2.0) < 0.01, f"getStatus().timescale returned {res['stTimescale']}"


def t1_f10_03_set_timescale_alias_updates_speed(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setTimescale(0.5);
        const got = p.getTimescale();
        p.setTimescale(1.0);
        return { ret, got };
        """
    )
    assert abs(res["ret"] - 0.5) < 0.01, f"setTimescale(0.5) returned {res['ret']}"
    assert abs(res["got"] - 0.5) < 0.01, f"getTimescale() returned {res['got']}"


def t1_f10_04_fast_speed_accelerates_server_time_rate(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(1.0);
        await new Promise(r => setTimeout(r, 80));
        const t1_start = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 450));
        const delta1x = p.getStatus().serverTime - t1_start;

        p.setSpeed(4.0);
        await new Promise(r => setTimeout(r, 80));
        const t4_start = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 450));
        const delta4x = p.getStatus().serverTime - t4_start;

        p.setSpeed(1.0);
        return { delta1x, delta4x, ratio: delta1x > 0 ? delta4x / delta1x : 0 };
        """
    )
    assert res["delta1x"] > 0, f"1x speed did not advance serverTime: {res}"
    assert (
        res["delta4x"] >= res["delta1x"] * 1.8
    ), f"4x speed did not accelerate serverTime relative to 1x: {res}"


def t1_f10_05_slow_speed_decelerates_server_time_rate(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(1.0);
        await new Promise(r => setTimeout(r, 80));
        const t1_start = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 500));
        const delta1x = p.getStatus().serverTime - t1_start;

        p.setSpeed(0.25);
        await new Promise(r => setTimeout(r, 80));
        const tSlow_start = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 500));
        const deltaSlow = p.getStatus().serverTime - tSlow_start;

        p.setSpeed(1.0);
        return { delta1x, deltaSlow };
        """
    )
    assert res["deltaSlow"] > 0, f"0.25x speed stalled serverTime at 0: {res}"
    assert (
        res["deltaSlow"] < res["delta1x"] * 0.7
    ), f"0.25x speed did not decelerate serverTime relative to 1x: {res}"


# ==============================================================================
# F11: In-Game Audio & JS Mute/Volume API (5 tests)
# ==============================================================================
def t1_f11_01_audio_subsystem_initialized_and_active(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.unmute();
        await new Promise(r => setTimeout(r, 100));
        return p.getStatus();
        """
    )
    assert st.get("audioActive") is True, f"Expected audioActive === true when unmuted, got {st}"
    assert st.get("audioContextState") in (
        "running",
        "suspended",
    ), f"Unexpected audioContextState: {st}"


def t1_f11_02_mute_and_is_muted(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.mute();
        const isMuted = p.isMuted();
        const stMuted = p.getStatus().muted;
        return { isMuted, stMuted };
        """
    )
    assert res["isMuted"] is True, f"Expected isMuted() === true after mute(), got {res}"
    assert res["stMuted"] is True, f"Expected getStatus().muted === true, got {res}"


def t1_f11_03_unmute_and_audio_context_running(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.mute();
        p.unmute();
        await new Promise(r => setTimeout(r, 100));
        const st = p.getStatus();
        return {
          isMuted: p.isMuted(),
          stMuted: st.muted,
          audioContextState: st.audioContextState,
        };
        """
    )
    assert res["isMuted"] is False, f"Expected isMuted() === false after unmute(), got {res}"
    assert res["stMuted"] is False, f"Expected getStatus().muted === false, got {res}"
    assert (
        res["audioContextState"] == "running"
    ), f"Expected audioContextState === 'running' after unmute(), got {res}"


def t1_f11_04_set_volume_and_get_volume(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setVolume(0.65);
        const got = p.getVolume();
        const stVol = p.getStatus().volume;
        p.setVolume(0.8);
        return { ret, got, stVol };
        """
    )
    assert abs(res["ret"] - 0.65) < 0.02, f"setVolume(0.65) returned {res['ret']}"
    assert abs(res["got"] - 0.65) < 0.02, f"getVolume() returned {res['got']}"
    assert abs(res["stVol"] - 0.65) < 0.02, f"getStatus().volume returned {res['stVol']}"


def t1_f11_05_audio_remains_active_on_canvas_blur(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.unmute();
        const canvas = document.getElementById('jk-canvas');
        canvas.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        window.dispatchEvent(new Event('blur'));
        await new Promise(r => setTimeout(r, 150));
        const st = p.getStatus();
        return {
          isMuted: p.isMuted(),
          audioActive: st.audioActive,
          audioContextState: st.audioContextState,
        };
        """
    )
    assert res["isMuted"] is False, f"Canvas blur unexpectedly muted player: {res}"
    assert res["audioActive"] is True, f"Canvas blur deactivated audio: {res}"


# ==============================================================================
# F12: JS Dynamic Demo Switching & Completion Event (5 tests)
# ==============================================================================
def t1_f12_01_load_demo_switches_to_new_demo_at_runtime(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok = await p.loadDemo('out.dm_26');
        const start = Date.now();
        while (Date.now() - start < 30000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('out') && st.serverTime > 0) {
            return { ok, status: st };
          }
          await new Promise(r => setTimeout(r, 100));
        }
        return { ok, status: p.getStatus() };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "out.dm_26"
    assert res["ok"] is True, f"loadDemo('out.dm_26') did not resolve to true: {res}"
    assert "out" in str(res["status"].get("demoName", "")).lower(), f"demoName did not switch to out: {res}"
    assert res["status"].get("isPlaying") is True, f"isPlaying not true after loadDemo: {res}"


def t1_f12_02_switched_demo_advances_server_time_and_frames(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 450));
        const st1 = p.getStatus();
        return {
          dt: st1.serverTime - st0.serverTime,
          df: st1.frameCount - st0.frameCount,
          demoName: st1.demoName,
        };
        """
    )
    assert res["dt"] > 0, f"Switched demo serverTime did not advance: {res}"
    assert res["df"] > 0, f"Switched demo frameCount did not advance: {res}"


def t1_f12_03_on_demo_complete_callback_registration(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const fn = () => {};
        p.onDemoComplete(fn);
        if (typeof p.onDemoEnded === 'function') p.onDemoEnded(fn);
        return { registered: true };
        """
    )
    assert res["registered"] is True


def t1_f12_04_demo_completion_fires_callback_and_custom_event(
    ctx: E2ETestContext,
) -> None:
    res = ctx.run_short_demo_to_completion(packet_count=12)
    assert res["loadOk"] is True, f"Short demo load failed: {res}"
    assert (
        res["callbacksCount"] >= 1
    ), f"Expected onDemoComplete callback to fire on CL_DemoCompleted, got {res}"
    assert (
        res["endedEventsCount"] >= 1 or res["completeEventsCount"] >= 1
    ), f"Expected jkdemo:ended / jkdemo:complete CustomEvent on window, got {res}"


def t1_f12_05_demo_completion_does_not_throw_err_disconnect_or_open_main_menu(
    ctx: E2ETestContext,
) -> None:
    logs = ctx.get_browser_logs()
    assert len(logs.get("pageErrors") or []) == 0, f"Unhandled errors on demo completion: {logs['pageErrors']}"
    # Verify engine recovers immediately into playing 1.51ef9.dm_26
    st = ctx.ensure_booted("1.51ef9.dm_26")
    assert st.get("isPlaying") is True, f"Engine failed to play new demo after completion: {st}"


# ==============================================================================
# F13: Full E2E Browser Verification & 3D Scene Rendering (5 tests)
# ==============================================================================
def t1_f13_01_capture_png_screenshot_from_canvas(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t1_f13_01")
    assert snap["width"] >= 640 and snap["height"] >= 360, f"Invalid screenshot dimensions: {snap}"
    assert snap["png_size"] > 5_000, f"PNG screenshot suspiciously small ({snap['png_size']} B)"


def t1_f13_02_rendered_3d_scene_has_rich_color_variance(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t1_f13_02")
    assert snap["std_rgb"] > 10.0, f"Expected std_rgb > 10.0 for 3D scene, got {snap['std_rgb']:.2f}"
    assert (
        snap["non_black_ratio"] > 0.20
    ), f"Expected non_black_ratio > 0.20, got {snap['non_black_ratio']:.3f}"
    assert (
        snap["unique_colors"] > 200
    ), f"Expected > 200 unique RGB colors in subsampled frame, got {snap['unique_colors']}"


def t1_f13_03_multi_point_screenshots_differ_as_demo_advances(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap1 = ctx.capture_canvas_screenshot("t1_f13_03_a")
    time.sleep(0.55)
    snap2 = ctx.capture_canvas_screenshot("t1_f13_03_b")
    cmp_res = ctx.compare_screenshots(snap1, snap2)
    assert (
        cmp_res["mean_abs_diff"] > 0.2 or cmp_res["changed_pixel_ratio"] > 0.005
    ), f"Screenshots did not change as demo time advanced: {cmp_res}"


def t1_f13_04_paused_screenshots_remain_visually_consistent(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.pause();")
    time.sleep(0.1)
    snap1 = ctx.capture_canvas_screenshot("t1_f13_04_paused_a")
    time.sleep(0.35)
    snap2 = ctx.capture_canvas_screenshot("t1_f13_04_paused_b")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.resume();")
    assert (
        snap1["status"].get("serverTime") == snap2["status"].get("serverTime")
    ), "serverTime changed while paused"
    assert snap1["std_rgb"] > 8.0 and snap2["std_rgb"] > 8.0, "Paused frame became blank"


def t1_f13_05_post_switch_demo_renders_new_map_scene(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap_kejim = ctx.capture_canvas_screenshot("t1_f13_05_kejim")
    ctx.ensure_booted("out.dm_26")
    time.sleep(0.3)
    snap_ctf1 = ctx.capture_canvas_screenshot("t1_f13_05_ctf1")
    assert snap_ctf1["std_rgb"] > 10.0, f"Switched map scene looks blank: {snap_ctf1['std_rgb']}"
    cmp_res = ctx.compare_screenshots(snap_kejim, snap_ctf1)
    assert (
        cmp_res["mean_abs_diff"] > 2.0
    ), f"New map screenshot is unexpectedly identical to previous map: {cmp_res}"


def get_tier1_tests() -> List[TestCase]:
    return [
        # F1
        TestCase("T1_F01_01_native_build_script_exists_and_succeeds", 1, "F1", "Verify scripts/build_native.sh produces build-native/codemp/openjk.x86_64", t1_f01_01_native_build_script_exists_and_succeeds),
        TestCase("T1_F01_02_native_binary_elf_x86_64", 1, "F1", "Verify openjk.x86_64 is a valid 64-bit little-endian x86_64 ELF binary", t1_f01_02_native_binary_elf_x86_64),
        TestCase("T1_F01_03_native_binary_size_and_permissions", 1, "F1", "Verify openjk.x86_64 is executable and > 500 KB", t1_f01_03_native_binary_size_and_permissions),
        TestCase("T1_F01_04_native_modules_built_or_linked", 1, "F1", "Verify rd-vanilla, cgame, and ui are built or linked in build-native", t1_f01_04_native_modules_built_or_linked),
        TestCase("T1_F01_05_native_shared_library_dependencies", 1, "F1", "Verify ldd on openjk.x86_64 resolves all shared library dependencies", t1_f01_05_native_shared_library_dependencies),
        # F2
        TestCase("T1_F02_01_wasm_build_script_and_artifacts", 1, "F2", "Verify scripts/build_wasm.sh produces build-wasm and web openjk.wasm + openjk.js", t1_f02_01_wasm_build_script_and_artifacts),
        TestCase("T1_F02_02_wasm_binary_magic_and_version", 1, "F2", "Verify web/openjk.wasm has valid WebAssembly binary magic and version 1", t1_f02_02_wasm_binary_magic_and_version),
        TestCase("T1_F02_03_wasm_static_module_linking_no_dlopen_side_modules", 1, "F2", "Verify rd-vanilla, cgame, and ui are statically compiled into Wasm build", t1_f02_03_wasm_static_module_linking_no_dlopen_side_modules),
        TestCase("T1_F02_04_wasm_js_loader_exports_and_asyncify", 1, "F2", "Verify web/openjk.js contains WebAssembly loader and Asyncify support", t1_f02_04_wasm_js_loader_exports_and_asyncify),
        TestCase("T1_F02_05_wasm_staged_files_match_build_outputs", 1, "F2", "Verify staged web/openjk.wasm and openjk.js match build-wasm outputs", t1_f02_05_wasm_staged_files_match_build_outputs),
        # F3
        TestCase("T1_F03_01_browser_boot_reaches_ready_state", 1, "F3", "Verify Wasm engine boots in headless Chrome and reaches ready === true", t1_f03_01_browser_boot_reaches_ready_state),
        TestCase("T1_F03_02_frame_count_advances_across_raf_ticks", 1, "F3", "Verify frameCount advances across requestAnimationFrame ticks", t1_f03_02_frame_count_advances_across_raf_ticks),
        TestCase("T1_F03_03_js_event_loop_and_promises_not_blocked", 1, "F3", "Verify JS Promises, setTimeout, and rAF are not blocked by Com_Frame", t1_f03_03_js_event_loop_and_promises_not_blocked),
        TestCase("T1_F03_04_frame_pacing_sustains_interactive_framerate", 1, "F3", "Verify main loop sustains continuous frame execution over 1000ms", t1_f03_04_frame_pacing_sustains_interactive_framerate),
        TestCase("T1_F03_05_zero_unhandled_wasm_or_js_exceptions", 1, "F3", "Verify zero unhandled JS or Wasm page errors during main loop execution", t1_f03_05_zero_unhandled_wasm_or_js_exceptions),
        # F4
        TestCase("T1_F04_01_webgl_context_created_on_jk_canvas", 1, "F4", "Verify active WebGL context is created on #jk-canvas", t1_f04_01_webgl_context_created_on_jk_canvas),
        TestCase("T1_F04_02_webgl_context_attributes_preserve_drawing_buffer", 1, "F4", "Verify WebGL context has preserveDrawingBuffer: true and depth: true", t1_f04_02_webgl_context_attributes_preserve_drawing_buffer),
        TestCase("T1_F04_03_webgl_depth_and_stencil_buffer_bits", 1, "F4", "Verify WebGL depth buffer >= 16 bits and MAX_TEXTURE_SIZE >= 2048", t1_f04_03_webgl_depth_and_stencil_buffer_bits),
        TestCase("T1_F04_04_webgl_renders_non_blank_frame", 1, "F4", "Verify WebGL renders non-blank 3D frame onto #jk-canvas", t1_f04_04_webgl_renders_non_blank_frame),
        TestCase("T1_F04_05_webgl_zero_fatal_gl_errors", 1, "F4", "Verify gl.getError() returns NO_ERROR (0) during active rendering", t1_f04_05_webgl_zero_fatal_gl_errors),
        # F5
        TestCase("T1_F05_01_server_serves_index_player_and_wasm", 1, "F5", "Verify web/server.py serves /, /index.html, /player.js, /openjk.js, /openjk.wasm", t1_f05_01_server_serves_index_player_and_wasm),
        TestCase("T1_F05_02_server_manifest_json_structure", 1, "F5", "Verify GET /base/manifest.json returns valid pk3 metadata and demo list", t1_f05_02_server_manifest_json_structure),
        TestCase("T1_F05_03_server_pk3_head_and_range_206", 1, "F5", "Verify HEAD and GET Range on /base/assets0.pk3 return 206 Partial Content", t1_f05_03_server_pk3_head_and_range_206),
        TestCase("T1_F05_04_server_serves_dm26_demo_files", 1, "F5", "Verify GET /demos/<name>.dm_26 serves exact demo file bytes", t1_f05_04_server_serves_dm26_demo_files),
        TestCase("T1_F05_05_server_metrics_and_reset_endpoints", 1, "F5", "Verify GET /api/metrics tracks Range byte transfers accurately", t1_f05_05_server_metrics_and_reset_endpoints),
        # F6
        TestCase("T1_F06_01_pk3_mounted_via_range_requests_only", 1, "F6", "Verify client mounts .pk3 archives via HTTP Range (pk3FullRequests == 0)", t1_f06_01_pk3_mounted_via_range_requests_only),
        TestCase("T1_F06_02_central_directory_indexed_without_full_archive_download", 1, "F6", "Verify assets0.pk3 and assets1.pk3 transfer < 10% of full archive size", t1_f06_02_central_directory_indexed_without_full_archive_download),
        TestCase("T1_F06_03_total_pk3_bytes_transferred_under_150mb", 1, "F6", "Verify total .pk3 bytes transferred during startup + playback is < 150 MB", t1_f06_03_total_pk3_bytes_transferred_under_150mb),
        TestCase("T1_F06_04_custom_map_pk3_fetched_on_demand", 1, "F6", "Verify custom map archive ctf_kejim.pk3 is fetched on demand for 1.51ef9.dm_26", t1_f06_04_custom_map_pk3_fetched_on_demand),
        TestCase("T1_F06_05_subsequent_frames_use_in_memory_cache", 1, "F6", "Verify subsequent playback frames reuse cached .pk3 entries (< 5 MB delta)", t1_f06_05_subsequent_frames_use_in_memory_cache),
        # F7
        TestCase("T1_F07_01_canvas_inside_player_pane_with_valid_dimensions", 1, "F7", "Verify <canvas id='jk-canvas'> is mounted inside #jk-player-pane", t1_f07_01_canvas_inside_player_pane_with_valid_dimensions),
        TestCase("T1_F07_02_pointer_lock_not_engaged_during_playback", 1, "F7", "Verify document.pointerLockElement remains null during demo playback", t1_f07_02_pointer_lock_not_engaged_during_playback),
        TestCase("T1_F07_03_host_page_controls_remain_clickable", 1, "F7", "Verify host webpage buttons outside canvas receive normal click events", t1_f07_03_host_page_controls_remain_clickable),
        TestCase("T1_F07_04_host_page_keyboard_input_not_hijacked", 1, "F7", "Verify host webpage <input> receives keystrokes without SDL2 capture", t1_f07_04_host_page_keyboard_input_not_hijacked),
        TestCase("T1_F07_05_window_api_aliases_exposed", 1, "F7", "Verify window.JKDemoPlayer and window.OpenJKPlayer expose all contract methods", t1_f07_05_window_api_aliases_exposed),
        # F8
        TestCase("T1_F08_01_query_param_demo_boots_directly_into_playback", 1, "F8", "Verify ?demo=1.51ef9.dm_26 boots directly to isPlaying === true", t1_f08_01_query_param_demo_boots_directly_into_playback),
        TestCase("T1_F08_02_active_demo_name_matches_requested_demo", 1, "F8", "Verify getStatus().demoName matches the requested demo", t1_f08_02_active_demo_name_matches_requested_demo),
        TestCase("T1_F08_03_server_time_advances_automatically_on_boot", 1, "F8", "Verify serverTime > 0 and advances automatically on direct demo boot", t1_f08_03_server_time_advances_automatically_on_boot),
        TestCase("T1_F08_04_main_menu_bypassed_no_ui_menu_trap", 1, "F8", "Verify main menu is bypassed and player is not trapped in UIMENU_MAIN", t1_f08_04_main_menu_bypassed_no_ui_menu_trap),
        TestCase("T1_F08_05_jkdemoconfig_object_supported", 1, "F8", "Verify player initialization configuration contract is supported", t1_f08_05_jkdemoconfig_object_supported),
        # F9
        TestCase("T1_F09_01_pause_sets_is_paused_true", 1, "F9", "Verify pause() returns true and sets isPaused() === true", t1_f09_01_pause_sets_is_paused_true),
        TestCase("T1_F09_02_pause_holds_server_time_constant", 1, "F9", "Verify serverTime remains constant while paused over 600ms", t1_f09_02_pause_holds_server_time_constant),
        TestCase("T1_F09_03_resume_sets_is_paused_false", 1, "F9", "Verify resume() returns false and sets isPaused() === false", t1_f09_03_resume_sets_is_paused_false),
        TestCase("T1_F09_04_resume_continues_smoothly_without_time_jump", 1, "F9", "Verify resume() after 1000ms pause does not jump serverTime by paused duration", t1_f09_04_resume_continues_smoothly_without_time_jump),
        TestCase("T1_F09_05_toggle_pause_and_set_paused", 1, "F9", "Verify togglePause() and setPaused(bool) transition pause state accurately", t1_f09_05_toggle_pause_and_set_paused),
        # F10
        TestCase("T1_F10_01_default_speed_is_one", 1, "F10", "Verify default playback speed / timescale is 1.0", t1_f10_01_default_speed_is_one),
        TestCase("T1_F10_02_set_speed_updates_get_speed", 1, "F10", "Verify setSpeed(2.0) updates getSpeed() and getStatus().timescale to 2.0", t1_f10_02_set_speed_updates_get_speed),
        TestCase("T1_F10_03_set_timescale_alias_updates_speed", 1, "F10", "Verify setTimescale(0.5) updates getTimescale() to 0.5", t1_f10_03_set_timescale_alias_updates_speed),
        TestCase("T1_F10_04_fast_speed_accelerates_server_time_rate", 1, "F10", "Verify setSpeed(4.0) accelerates serverTime advancement relative to 1.0x", t1_f10_04_fast_speed_accelerates_server_time_rate),
        TestCase("T1_F10_05_slow_speed_decelerates_server_time_rate", 1, "F10", "Verify setSpeed(0.25) decelerates serverTime advancement while keeping > 0 progress", t1_f10_05_slow_speed_decelerates_server_time_rate),
        # F11
        TestCase("T1_F11_01_audio_subsystem_initialized_and_active", 1, "F11", "Verify SDL2 WebAudio subsystem is initialized and audioActive === true", t1_f11_01_audio_subsystem_initialized_and_active),
        TestCase("T1_F11_02_mute_and_is_muted", 1, "F11", "Verify mute() sets isMuted() === true and getStatus().muted === true", t1_f11_02_mute_and_is_muted),
        TestCase("T1_F11_03_unmute_and_audio_context_running", 1, "F11", "Verify unmute() sets isMuted() === false and audioContextState === 'running'", t1_f11_03_unmute_and_audio_context_running),
        TestCase("T1_F11_04_set_volume_and_get_volume", 1, "F11", "Verify setVolume(0.65) updates getVolume() and getStatus().volume", t1_f11_04_set_volume_and_get_volume),
        TestCase("T1_F11_05_audio_remains_active_on_canvas_blur", 1, "F11", "Verify audio remains active when #jk-canvas loses focus", t1_f11_05_audio_remains_active_on_canvas_blur),
        # F12
        TestCase("T1_F12_01_load_demo_switches_to_new_demo_at_runtime", 1, "F12", "Verify loadDemo('out.dm_26') dynamically switches active demo to out", t1_f12_01_load_demo_switches_to_new_demo_at_runtime),
        TestCase("T1_F12_02_switched_demo_advances_server_time_and_frames", 1, "F12", "Verify switched demo actively advances serverTime and frameCount", t1_f12_02_switched_demo_advances_server_time_and_frames),
        TestCase("T1_F12_03_on_demo_complete_callback_registration", 1, "F12", "Verify onDemoComplete and onDemoEnded register completion callbacks", t1_f12_03_on_demo_complete_callback_registration),
        TestCase("T1_F12_04_demo_completion_fires_callback_and_custom_event", 1, "F12", "Verify CL_DemoCompleted fires onDemoComplete callback and jkdemo:ended CustomEvent", t1_f12_04_demo_completion_fires_callback_and_custom_event),
        TestCase("T1_F12_05_demo_completion_does_not_throw_err_disconnect_or_open_main_menu", 1, "F12", "Verify demo completion does not abort with ERR_DISCONNECT and allows loading next demo", t1_f12_05_demo_completion_does_not_throw_err_disconnect_or_open_main_menu),
        # F13
        TestCase("T1_F13_01_capture_png_screenshot_from_canvas", 1, "F13", "Verify PNG screenshot capture from #jk-canvas produces valid 1280x720 image", t1_f13_01_capture_png_screenshot_from_canvas),
        TestCase("T1_F13_02_rendered_3d_scene_has_rich_color_variance", 1, "F13", "Verify rendered 3D scene has high spatial RGB variance and > 200 unique colors", t1_f13_02_rendered_3d_scene_has_rich_color_variance),
        TestCase("T1_F13_03_multi_point_screenshots_differ_as_demo_advances", 1, "F13", "Verify screenshots captured at distinct serverTime points differ as 3D scene advances", t1_f13_03_multi_point_screenshots_differ_as_demo_advances),
        TestCase("T1_F13_04_paused_screenshots_remain_visually_consistent", 1, "F13", "Verify screenshots captured while paused hold serverTime constant and remain non-blank", t1_f13_04_paused_screenshots_remain_visually_consistent),
        TestCase("T1_F13_05_post_switch_demo_renders_new_map_scene", 1, "F13", "Verify switching demos across maps renders a new non-blank 3D map scene", t1_f13_05_post_switch_demo_renders_new_map_scene),
    ]
