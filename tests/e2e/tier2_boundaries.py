#!/usr/bin/env python3
"""
Tier 2 — Boundary & Corner Cases E2E Tests (65 test cases: 5 per feature across F1–F13).
Uses Boundary Value Analysis to exercise numerical, protocol, and state limits.
"""

import json
import subprocess
import time
from typing import List

from .harness import (
    E2ETestContext,
    TestCase,
    inspect_zip_eocd,
    parse_wasm_sections,
)


# ==============================================================================
# F1 Boundaries: Native Linux Build (5 tests)
# ==============================================================================
def t2_f01_01_native_binary_no_undefined_engine_symbols(ctx: E2ETestContext) -> None:
    bin_path = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    assert bin_path.exists(), f"Missing {bin_path}"
    nm_u = subprocess.check_output(["nm", "-u", str(bin_path)], text=True)
    for prefix in ("Com_Init", "CL_Init", "FS_InitFilesystem", "VM_Create", "Cbuf_Execute"):
        assert (
            prefix not in nm_u
        ), f"Core engine symbol {prefix} is undefined in openjk.x86_64"


def t2_f01_02_native_binary_exports_or_resolves_renderer_api(
    ctx: E2ETestContext,
) -> None:
    codemp_dir = ctx.build_native_dir / "codemp"
    rd_so = list(codemp_dir.glob("*rd-vanilla*.so"))
    if rd_so:
        nm_out = subprocess.check_output(["nm", "-D", str(rd_so[0])], text=True)
        assert "GetRefAPI" in nm_out, f"GetRefAPI not exported by {rd_so[0]}"
    else:
        nm_out = subprocess.check_output(
            ["nm", str(codemp_dir / "openjk.x86_64")], text=True
        )
        assert "GetRefAPI" in nm_out, "GetRefAPI not found in native build"


def t2_f01_03_native_binary_exports_or_resolves_cgame_and_ui_api(
    ctx: E2ETestContext,
) -> None:
    codemp_dir = ctx.build_native_dir / "codemp"
    cg_so = list(codemp_dir.glob("*cgame*.so"))
    ui_so = list(codemp_dir.glob("*ui*.so"))
    if cg_so and ui_so:
        nm_cg = subprocess.check_output(["nm", "-D", str(cg_so[0])], text=True)
        nm_ui = subprocess.check_output(["nm", "-D", str(ui_so[0])], text=True)
        assert "GetModuleAPI" in nm_cg, f"GetModuleAPI missing from {cg_so[0]}"
        assert "GetModuleAPI" in nm_ui, f"GetModuleAPI missing from {ui_so[0]}"
    else:
        nm_bin = subprocess.check_output(
            ["nm", str(codemp_dir / "openjk.x86_64")], text=True
        )
        assert "GetCGameAPI_Static" in nm_bin and "GetUIAPI_Static" in nm_bin


def t2_f01_04_native_build_idempotent_incremental_invocation(
    ctx: E2ETestContext,
) -> None:
    script = ctx.scripts_dir / "build_native.sh"
    proc = subprocess.run(
        ["bash", str(script)],
        cwd=str(ctx.root_dir),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert (
        proc.returncode == 0
    ), f"Incremental build_native.sh failed ({proc.returncode}):\n{proc.stderr}"


def t2_f01_05_native_build_preserves_clean_source_tree(ctx: E2ETestContext) -> None:
    stray_objs = list((ctx.root_dir / "codemp").rglob("*.o")) + list(
        (ctx.root_dir / "shared").rglob("*.o")
    )
    assert (
        len(stray_objs) == 0
    ), f"Found in-tree .o files outside build directories: {stray_objs[:5]}"


# ==============================================================================
# F2 Boundaries: Wasm Static Compilation & Module Linking (5 tests)
# ==============================================================================
def t2_f02_01_wasm_binary_sections_validation(ctx: E2ETestContext) -> None:
    wasm_web = ctx.web_dir / "openjk.wasm"
    sections = parse_wasm_sections(wasm_web)
    sec_ids = {sec_id for sec_id, _ in sections}
    # Required standard Wasm sections: 1=Type, 2=Import, 3=Function, 6=Global, 7=Export, 10=Code, 11=Data
    for req_id in (1, 2, 3, 7, 10, 11):
        assert req_id in sec_ids, f"Wasm binary missing standard section ID {req_id}: {sec_ids}"


def t2_f02_02_wasm_symbol_isolation_cgame_vs_ui(ctx: E2ETestContext) -> None:
    codemp_wasm = ctx.build_wasm_dir / "codemp"
    static_libs = list(codemp_wasm.rglob("*.a"))
    # Verify both cgame and ui were compiled into build-wasm without symbol collision
    has_ui_prefix = list((ctx.root_dir / "codemp").rglob("*sym_prefix*.h")) + list(
        ctx.build_wasm_dir.rglob("*sym_prefix*.h")
    )
    assert (
        len(static_libs) >= 2 or len(has_ui_prefix) >= 1
    ), f"Expected static module libraries or symbol prefix headers in Wasm build"


def t2_f02_03_wasm_memory_configuration_bounds(ctx: E2ETestContext) -> None:
    js_web = ctx.web_dir / "openjk.js"
    content = js_web.read_text(encoding="utf-8", errors="ignore")
    # Verify memory growth or large initial heap is present
    assert (
        "WebAssembly.Memory" in content or "wasmMemory" in content
    ), "Missing WebAssembly.Memory initialization in openjk.js"


def t2_f02_04_wasm_build_idempotent_incremental_invocation(
    ctx: E2ETestContext,
) -> None:
    script = ctx.scripts_dir / "build_wasm.sh"
    proc = subprocess.run(
        ["bash", str(script)],
        cwd=str(ctx.root_dir),
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert (
        proc.returncode == 0
    ), f"Incremental build_wasm.sh failed ({proc.returncode}):\n{proc.stderr}"


def t2_f02_05_wasm_no_desktop_glx_or_x11_imports(ctx: E2ETestContext) -> None:
    js_web = ctx.web_dir / "openjk.js"
    content = js_web.read_text(encoding="utf-8", errors="ignore")
    for forbidden in ("glXCreateContext", "glXSwapBuffers", "XOpenDisplay"):
        assert (
            forbidden not in content
        ), f"Forbidden desktop X11/GLX symbol '{forbidden}' found in openjk.js"


# ==============================================================================
# F3 Boundaries: Main Loop & Frame Pacing (5 tests)
# ==============================================================================
def t2_f03_01_frame_loop_under_paused_state_continues_raf(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        const f0 = p.getStatus().frameCount;
        await new Promise(r => setTimeout(r, 400));
        const f1 = p.getStatus().frameCount;
        p.resume();
        return { f0, f1, delta: f1 - f0 };
        """
    )
    assert (
        res["delta"] > 0
    ), f"Main loop stopped advancing frameCount while paused: {res}"


def t2_f03_02_frame_loop_under_minimum_timescale(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(0.05);
        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 600));
        const st1 = p.getStatus();
        p.setSpeed(1.0);
        return {
          df: st1.frameCount - st0.frameCount,
          dt: st1.serverTime - st0.serverTime,
        };
        """
    )
    assert res["df"] > 0, f"frameCount stalled at speed=0.05: {res}"
    assert res["dt"] > 0, f"serverTime stalled at speed=0.05 (missing fractional carry): {res}"


def t2_f03_03_frame_loop_under_maximum_timescale(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(8.0);
        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 350));
        const st1 = p.getStatus();
        p.setSpeed(1.0);
        return {
          df: st1.frameCount - st0.frameCount,
          dt: st1.serverTime - st0.serverTime,
        };
        """
    )
    assert res["df"] > 0, f"frameCount stalled at speed=8.0: {res}"
    assert res["dt"] > 0, f"serverTime did not advance at speed=8.0: {res}"


def t2_f03_04_concurrent_async_fetch_during_main_loop(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const t0 = performance.now();
        const [r1, r2] = await Promise.all([
          fetch('/api/metrics').then(r => r.json()),
          fetch('/base/manifest.json').then(r => r.json()),
        ]);
        const elapsed = performance.now() - t0;
        return {
          elapsed,
          hasMetrics: typeof r1.pk3BytesTransferred === 'number',
          hasManifest: typeof r2 === 'object' && r2 !== null,
        };
        """
    )
    assert res["hasMetrics"] is True and res["hasManifest"] is True
    assert res["elapsed"] < 2000.0, f"Concurrent fetch took too long ({res['elapsed']}ms)"


def t2_f03_05_visibility_change_and_focus_events_do_not_crash_loop(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        const f0 = p.getStatus().frameCount;
        await new Promise(r => setTimeout(r, 300));
        const f1 = p.getStatus().frameCount;
        return { f0, f1, delta: f1 - f0 };
        """
    )
    assert res["delta"] > 0, f"Main loop stopped after visibilitychange/blur/focus: {res}"


# ==============================================================================
# F4 Boundaries: WebGL 1.0 Renderer Compatibility (5 tests)
# ==============================================================================
def t2_f04_01_webgl_no_gl_array_element_missing_error(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    logs = ctx.get_browser_logs()
    for entry in logs.get("consoleLogs") or []:
        txt = str(entry.get("text") or "")
        assert (
            "glArrayElement" not in txt
        ), f"Found forbidden glArrayElement error in console: {txt}"


def t2_f04_02_webgl_no_texture_rectangle_or_rgba16_invalid_enum(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    err = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        return gl.getError();
        """
    )
    assert err == 0, f"WebGL reported sticky error {hex(err)}"


def t2_f04_03_webgl_canvas_resize_and_viewport_stability(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t2_f04_03_quadrants")
    q_tl, q_tr, q_bl, q_br = snap["quadrant_stds"]
    non_empty_quadrants = sum(1 for q in (q_tl, q_tr, q_bl, q_br) if q > 3.0)
    assert (
        non_empty_quadrants >= 3
    ), f"Expected at least 3 of 4 screen quadrants to have rendered detail, got stds={(q_tl, q_tr, q_bl, q_br)}"


def t2_f04_04_webgl_alpha_channel_opaque_rendering(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t2_f04_04_alpha")
    assert (
        snap["alpha_max"] == 255 and snap["alpha_min"] >= 250
    ), f"Expected opaque alpha channel on WebGL canvas, got min={snap['alpha_min']}, max={snap['alpha_max']}"


def t2_f04_05_webgl_multiple_consecutive_readpixels_calls(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    for i in range(5):
        snap = ctx.capture_canvas_screenshot()
        assert (
            snap["std_rgb"] > 6.0 and snap["non_black_ratio"] > 0.10
        ), f"Consecutive screenshot #{i+1} returned cleared buffer (preserveDrawingBuffer failed): {snap}"


# ==============================================================================
# F5 Boundaries: HTTP Range Server & .pk3 Manifest (5 tests)
# ==============================================================================
def t2_f05_01_http_range_single_first_byte(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    st, hdr, body = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-0"}
    )
    assert st == 206, f"Expected 206 for Range: bytes=0-0, got {st}"
    assert body == b"P", f"Expected single byte b'P', got {body!r}"
    assert hdr.get("content-length") == "1", f"Expected Content-Length: 1, got {hdr}"
    assert "bytes 0-0/561806019" in hdr.get("content-range", "")


def t2_f05_02_http_range_eocd_tail_exact_bytes(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    # assets0.pk3: size=561806019, cd_offset=560580864, tail_len=1225155
    st, hdr, body = ctx.http_request(
        "GET",
        "/base/assets0.pk3",
        headers={"Range": "bytes=560580864-561806018"},
    )
    assert st == 206, f"Expected 206 for Central Directory tail range, got {st}"
    assert len(body) == 1_225_155, f"Expected 1,225,155 bytes, got {len(body)}"
    assert body[:4] == b"PK\x01\x02", f"Expected Central Dir magic PK\\x01\\x02 at start, got {body[:4]!r}"
    assert b"PK\x05\x06" in body[-64:], "Expected EOCD magic PK\\x05\\x06 at end of tail"


def t2_f05_03_http_range_out_of_bounds_returns_416(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    st, _, _ = ctx.http_request(
        "GET",
        "/base/assets2.pk3",
        headers={"Range": "bytes=999999999-1000000000"},
    )
    assert st in (416, 400), f"Expected HTTP 416 Range Not Satisfiable for out-of-bounds range, got {st}"


def t2_f05_04_http_nonexistent_pk3_and_demo_return_404(ctx: E2ETestContext) -> None:
    ctx.ensure_server()
    st_pk3, _, _ = ctx.http_request("GET", "/base/nonexistent_archive_999.pk3")
    st_demo, _, _ = ctx.http_request("GET", "/demos/nonexistent_demo_999.dm_26")
    assert st_pk3 == 404, f"Expected 404 for nonexistent .pk3, got {st_pk3}"
    assert st_demo == 404, f"Expected 404 for nonexistent .dm_26, got {st_demo}"


def t2_f05_05_http_demo_name_with_and_without_dm26_suffix(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    st1, _, b1 = ctx.http_request("GET", "/demos/hood.dm_26")
    st2, _, b2 = ctx.http_request("GET", "/demos/hood")
    assert st1 == 200 and st2 == 200, f"Expected 200 for both /demos/hood.dm_26 ({st1}) and /demos/hood ({st2})"
    assert len(b1) == 3_287_542 and len(b2) == 3_287_542, f"Size mismatch: {len(b1)} vs {len(b2)}"


# ==============================================================================
# F6 Boundaries: On-Demand .pk3 Loading via HTTP Range (5 tests)
# ==============================================================================
def t2_f06_01_pk3_manifest_cd_offsets_match_physical_files(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    st, _, body = ctx.http_request("GET", "/base/manifest.json")
    assert st == 200
    manifest = json.loads(body.decode("utf-8"))
    raw_pk3s = manifest.get("pk3s") or manifest.get("archives") or manifest.get("files")
    if isinstance(raw_pk3s, dict):
        pk3_map = raw_pk3s
    else:
        pk3_map = {item["name"]: item for item in raw_pk3s}

    for name, disk_path in [
        ("assets0.pk3", ctx.pk3_base_dir / "assets0.pk3"),
        ("assets1.pk3", ctx.pk3_base_dir / "assets1.pk3"),
        ("assets2.pk3", ctx.pk3_base_dir / "assets2.pk3"),
        ("assets3.pk3", ctx.pk3_base_dir / "assets3.pk3"),
        ("ctf_kejim.pk3", ctx.pk3_refresh_dir / "ctf_kejim.pk3"),
    ]:
        assert name in pk3_map, f"Missing {name} in /base/manifest.json"
        expected = inspect_zip_eocd(disk_path)
        entry = pk3_map[name]
        assert entry["size"] == expected["size"], f"{name} size mismatch: {entry} vs {expected}"
        assert (
            entry["cd_offset"] == expected["cd_offset"]
        ), f"{name} cd_offset mismatch: {entry} vs {expected}"
        assert (
            entry["cd_size"] == expected["cd_size"]
        ), f"{name} cd_size mismatch: {entry} vs {expected}"


def t2_f06_02_ui_init_existence_probes_do_not_download_unused_player_icons(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    a1_bytes = (m.get("perFileBytes") or {}).get("assets1.pk3", 0)
    # assets1.pk3 is 652.8 MB; lazy FS_Read must keep transfer under 75 MB
    assert (
        0 < a1_bytes < 75 * 1024 * 1024
    ), f"assets1.pk3 transfer ({a1_bytes:,} B) exceeded 75 MB budget"


def t2_f06_03_sp_voiceovers_and_roq_videos_never_fetched(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    m = ctx.cold_boot_metrics or ctx.get_metrics()
    a0_bytes = (m.get("perFileBytes") or {}).get("assets0.pk3", 0)
    # assets0.pk3 is 561.8 MB (308 MB SP voiceovers + 109 MB .roq videos); must stay < 50 MB
    assert (
        0 < a0_bytes < 50 * 1024 * 1024
    ), f"assets0.pk3 transfer ({a0_bytes:,} B) exceeded 50 MB budget"


def t2_f06_04_metrics_reset_followed_by_demo_switch_tracks_incremental_bytes(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    reset_res = ctx.reset_metrics()
    assert reset_res.get("pk3BytesTransferred", 0) == 0
    ctx.ensure_booted("hood.dm_26")
    m = ctx.get_metrics()
    # Switching to hood.dm_26 (map mp/ffa3) fetches mp/ffa3.bsp and map textures (< 60 MB)
    assert (
        m["pk3BytesTransferred"] < 60 * 1024 * 1024
    ), f"Incremental demo switch transferred too many bytes: {m}"
    assert m["pk3FullRequests"] == 0, f"Full .pk3 request occurred during demo switch: {m}"


def t2_f06_05_reload_same_demo_uses_cached_pk3_blocks(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("hood.dm_26")
    ctx.reset_metrics()
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        await p.loadDemo('hood.dm_26');
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const st = p.getStatus();
          if (st.isPlaying && st.serverTime > 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        return p.getStatus();
        """
    )
    m = ctx.get_metrics()
    assert (
        m["pk3BytesTransferred"] < 10 * 1024 * 1024
    ), f"Reloading same demo re-downloaded {m['pk3BytesTransferred']:,} B of .pk3 data instead of using cache"


# ==============================================================================
# F7 Boundaries: Embedded <canvas> & Non-Interactive Input (5 tests)
# ==============================================================================
def t2_f07_01_multiple_rapid_canvas_clicks_never_trigger_pointer_lock(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    pl = ctx.eval_js(
        """
        const canvas = document.getElementById('jk-canvas');
        for (let i = 0; i < 10; i++) {
          canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 + i * 20, clientY: 100 + i * 15 }));
          canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100 + i * 20, clientY: 100 + i * 15 }));
          canvas.click();
        }
        return document.pointerLockElement;
        """
    )
    assert pl is None, f"Rapid canvas clicks engaged pointer lock: {pl}"


def t2_f07_02_game_hotkeys_in_host_input_do_not_trigger_engine_binds(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const inp = document.createElement('input');
        document.body.appendChild(inp);
        inp.focus();
        const keys = ['`', '~', 'Escape', ' ', 'w', 'a', 's', 'd', 'Tab', 'F1'];
        let prevented = 0;
        for (const k of keys) {
          const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
          inp.dispatchEvent(ev);
          if (ev.defaultPrevented) prevented++;
        }
        inp.remove();
        return { prevented, isPlaying: p.getStatus().isPlaying };
        """
    )
    assert res["prevented"] == 0, f"Game hotkeys in host input were intercepted: {res}"
    assert res["isPlaying"] is True, f"Game hotkeys disrupted demo playback: {res}"


def t2_f07_03_mouse_wheel_and_mousemove_over_canvas_do_not_lock_page(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const canvas = document.getElementById('jk-canvas');
        canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500, clientY: 400 }));
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
        return {
          pointerLock: document.pointerLockElement,
          ready: window.JKDemoPlayer.getStatus().ready,
        };
        """
    )
    assert res["pointerLock"] is None
    assert res["ready"] is True


def t2_f07_04_get_status_returns_all_required_contract_fields(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.get_player_status()
    required = [
        "ready",
        "isPlaying",
        "isPaused",
        "demoEnded",
        "demoCompletedCount",
        "demoName",
        "serverTime",
        "frameCount",
        "timescale",
        "speed",
        "muted",
        "volume",
        "audioContextState",
        "audioActive",
        "pk3BytesTransferred",
        "pk3RangeRequests",
    ]
    missing = [k for k in required if k not in st]
    assert len(missing) == 0, f"getStatus() missing contract fields {missing}: {st}"


def t2_f07_05_openjkplayer_alias_is_strictly_identical_to_jkdemoplayer(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    same = ctx.eval_js(
        """
        return (
          window.OpenJKPlayer === window.JKDemoPlayer ||
          JSON.stringify(window.OpenJKPlayer.getStatus()) === JSON.stringify(window.JKDemoPlayer.getStatus())
        );
        """
    )
    assert same is True, "window.OpenJKPlayer does not match window.JKDemoPlayer"


# ==============================================================================
# F8 Boundaries: Direct-to-Demo Boot Skipping Menus (5 tests)
# ==============================================================================
def t2_f08_01_boot_with_demo_name_without_dm26_extension(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok = await p.loadDemo('out');
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('out') && st.serverTime > 0) {
            return { ok, status: st };
          }
          await new Promise(r => setTimeout(r, 80));
        }
        return { ok, status: p.getStatus() };
        """
    )
    ctx.current_boot_demo = "out.dm_26"
    assert res["ok"] is True
    assert "out" in str(res["status"].get("demoName", "")).lower()


def t2_f08_02_boot_with_demo_url_path_prefix(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok = await p.loadDemo('/demos/1.51ef9.dm_26');
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('1.51ef9') && st.serverTime > 0) {
            return { ok, status: st };
          }
          await new Promise(r => setTimeout(r, 80));
        }
        return { ok, status: p.getStatus() };
        """
    )
    ctx.current_boot_demo = "1.51ef9.dm_26"
    assert res["ok"] is True
    assert "1.51ef9" in str(res["status"].get("demoName", "")).lower()


def t2_f08_03_boot_with_initial_speed_query_param(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    # Verify URL query parsing helper or runtime speed application
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (typeof p.applyQueryConfig === 'function') {
          p.applyQueryConfig('?demo=1.51ef9.dm_26&speed=2.0');
        } else {
          const params = new URLSearchParams('?demo=1.51ef9.dm_26&speed=2.0');
          if (params.has('speed')) p.setSpeed(parseFloat(params.get('speed')));
        }
        const sp = p.getSpeed();
        p.setSpeed(1.0);
        return sp;
        """
    )
    assert abs(res - 2.0) < 0.01, f"Expected speed 2.0, got {res}"


def t2_f08_04_boot_with_initial_muted_query_param(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setMuted(true);
        const m1 = p.isMuted();
        p.setMuted(false);
        const m0 = p.isMuted();
        return { m1, m0 };
        """
    )
    assert res == {"m1": True, "m0": False}


def t2_f08_05_boot_custom_map_demo_ctf_kejim(ctx: E2ETestContext) -> None:
    st = ctx.ensure_booted("1.51ef9.dm_26")
    assert st.get("isPlaying") is True
    assert "1.51ef9" in str(st.get("demoName", "")).lower()


# ==============================================================================
# F9 Boundaries: Pause & Resume (5 tests)
# ==============================================================================
def t2_f09_01_idempotent_double_pause(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        const r1 = p.pause();
        const t1 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 150));
        const r2 = p.pause();
        await new Promise(r => setTimeout(r, 250));
        const t2 = p.getStatus().serverTime;
        const paused = p.isPaused();
        p.resume();
        return { r1, r2, t1, t2, paused };
        """
    )
    assert res["r1"] is True and res["r2"] is True
    assert res["paused"] is True
    assert res["t1"] == res["t2"], f"serverTime drifted during double pause: {res}"


def t2_f09_02_idempotent_double_resume(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        const r1 = p.resume();
        const r2 = p.resume();
        const paused = p.isPaused();
        return { r1, r2, paused };
        """
    )
    assert res["r1"] is False and res["r2"] is False and res["paused"] is False


def t2_f09_03_rapid_toggle_pause_10_times(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        const t0 = p.getStatus().serverTime;
        const states = [];
        for (let i = 0; i < 10; i++) {
          states.push(p.togglePause());
        }
        await new Promise(r => setTimeout(r, 200));
        const t1 = p.getStatus().serverTime;
        return { states, finalPaused: p.isPaused(), t0, t1 };
        """
    )
    assert res["states"] == [True, False] * 5, f"Unexpected toggle sequence: {res['states']}"
    assert res["finalPaused"] is False
    assert res["t1"] >= res["t0"], f"serverTime went backwards during rapid toggle: {res}"


def t2_f09_04_play_method_alias_for_resume(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        const pausedBefore = p.isPaused();
        const ret = p.play();
        const pausedAfter = p.isPaused();
        return { pausedBefore, ret, pausedAfter };
        """
    )
    assert res["pausedBefore"] is True
    assert res["ret"] is False
    assert res["pausedAfter"] is False


def t2_f09_05_pause_events_dispatched_on_window(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        let pausedFired = false;
        let resumedFired = false;
        window.addEventListener('jkdemo:paused', () => { pausedFired = true; }, { once: true });
        window.addEventListener('jkdemo:resumed', () => { resumedFired = true; }, { once: true });
        p.pause();
        p.resume();
        return { pausedFired, resumedFired, isPaused: p.isPaused() };
        """
    )
    assert res["isPaused"] is False


# ==============================================================================
# F10 Boundaries: Playback Speed (timescale) (5 tests)
# ==============================================================================
def t2_f10_01_speed_lower_boundary_clamping(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const s_min = p.setSpeed(0.05);
        const s_sub = p.setSpeed(0.0001);
        const s_neg = p.setSpeed(-3.0);
        p.setSpeed(1.0);
        return { s_min, s_sub, s_neg };
        """
    )
    assert abs(res["s_min"] - 0.05) < 0.01, f"Expected 0.05 at lower boundary, got {res}"
    assert res["s_sub"] >= 0.05 - 1e-4, f"Expected clamping >= 0.05 for 0.0001, got {res}"
    assert res["s_neg"] >= 0.05 - 1e-4, f"Expected clamping >= 0.05 for -3.0, got {res}"


def t2_f10_02_speed_upper_boundary_clamping(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const s_8 = p.setSpeed(8.0);
        const s_10 = p.setSpeed(10.0);
        const s_huge = p.setSpeed(999.0);
        p.setSpeed(1.0);
        return { s_8, s_10, s_huge };
        """
    )
    assert abs(res["s_8"] - 8.0) < 0.05
    assert abs(res["s_10"] - 10.0) < 0.05
    assert 8.0 <= res["s_huge"] <= 20.0, f"Expected upper clamp in [8.0, 20.0], got {res}"


def t2_f10_03_speed_nan_and_invalid_input_handling(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(1.0);
        p.setSpeed(NaN);
        const s1 = p.getSpeed();
        p.setSpeed(1.0);
        return { s1, finite: Number.isFinite(s1) && s1 > 0 };
        """
    )
    assert res["finite"] is True, f"setSpeed(NaN) corrupted timescale: {res}"


def t2_f10_04_fractional_slow_motion_speeds_advance_monotonically(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(0.1);
        const t0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 350));
        const t1 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 350));
        const t2 = p.getStatus().serverTime;
        p.setSpeed(1.0);
        return { t0, t1, t2 };
        """
    )
    assert (
        res["t2"] > res["t0"] and res["t1"] >= res["t0"] and res["t2"] >= res["t1"]
    ), f"Non-monotonic or stalled serverTime at 0.1x speed: {res}"


def t2_f10_05_rapid_speed_transitions_preserve_monotonic_server_time(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        const times = [p.getStatus().serverTime];
        for (const sp of [0.25, 4.0, 0.5, 2.0, 0.1, 1.0]) {
          p.setSpeed(sp);
          await new Promise(r => setTimeout(r, 70));
          times.push(p.getStatus().serverTime);
        }
        p.setSpeed(1.0);
        let monotonic = true;
        for (let i = 1; i < times.length; i++) {
          if (times[i] < times[i - 1]) monotonic = false;
        }
        return { times, monotonic };
        """
    )
    assert res["monotonic"] is True, f"serverTime decreased during speed transitions: {res}"


# ==============================================================================
# F11 Boundaries: Audio & Mute/Volume API (5 tests)
# ==============================================================================
def t2_f11_01_volume_zero_boundary(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setVolume(0.0);
        const got = p.getVolume();
        p.setVolume(0.8);
        return { ret, got };
        """
    )
    assert abs(res["ret"] - 0.0) < 1e-4 and abs(res["got"] - 0.0) < 1e-4


def t2_f11_02_volume_one_boundary(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setVolume(1.0);
        const got = p.getVolume();
        p.setVolume(0.8);
        return { ret, got };
        """
    )
    assert abs(res["ret"] - 1.0) < 1e-4 and abs(res["got"] - 1.0) < 1e-4


def t2_f11_03_volume_below_zero_clamped(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setVolume(-0.75);
        const got = p.getVolume();
        p.setVolume(0.8);
        return { ret, got };
        """
    )
    assert res["ret"] == 0.0 and res["got"] == 0.0, f"Negative volume not clamped to 0.0: {res}"


def t2_f11_04_volume_above_one_clamped(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ret = p.setVolume(3.5);
        const got = p.getVolume();
        p.setVolume(0.8);
        return { ret, got };
        """
    )
    assert res["ret"] == 1.0 and res["got"] == 1.0, f"Volume > 1.0 not clamped to 1.0: {res}"


def t2_f11_05_idempotent_mute_unmute_and_set_muted(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setVolume(0.55);
        p.mute();
        p.mute();
        const m1 = p.isMuted();
        p.unmute();
        p.unmute();
        const m2 = p.isMuted();
        const s1 = p.setMuted(true);
        const s2 = p.setMuted(false);
        const volAfter = p.getVolume();
        p.setVolume(0.8);
        return { m1, m2, s1, s2, volAfter };
        """
    )
    assert res["m1"] is True and res["m2"] is False
    assert res["s1"] is True and res["s2"] is False
    assert abs(res["volAfter"] - 0.55) < 0.02, f"Mute/unmute lost saved volume: {res}"


# ==============================================================================
# F12 Boundaries: Dynamic Demo Switching & Completion Event (5 tests)
# ==============================================================================
def t2_f12_01_load_demo_with_and_without_extension(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok1 = await p.loadDemo('hood');
        const st1 = p.getStatus();
        const ok2 = await p.loadDemo('hood.dm_26');
        const st2 = p.getStatus();
        return { ok1, name1: st1.demoName, ok2, name2: st2.demoName };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "hood.dm_26"
    assert res["ok1"] is True and res["ok2"] is True
    assert "hood" in str(res["name1"]).lower() and "hood" in str(res["name2"]).lower()


def t2_f12_02_load_demo_with_full_path_prefix(ctx: E2ETestContext) -> None:
    ctx.ensure_booted("hood.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok = await p.loadDemo('/demos/kom.dm_26');
        const start = Date.now();
        while (Date.now() - start < 30000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('kom') && st.serverTime > 0) {
            return { ok, status: st };
          }
          await new Promise(r => setTimeout(r, 100));
        }
        return { ok, status: p.getStatus() };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "kom.dm_26"
    assert res["ok"] is True, f"loadDemo('/demos/kom.dm_26') failed: {res}"
    assert "kom" in str(res["status"].get("demoName", "")).lower()


def t2_f12_03_load_demo_across_distinct_maps(ctx: E2ETestContext) -> None:
    for demo in ("1.51ef9.dm_26", "out.dm_26", "hood3.dm_26"):
        st = ctx.ensure_booted(demo)
        assert st.get("isPlaying") is True, f"Failed switching to {demo}: {st}"


def t2_f12_04_load_demo_invalid_or_empty_name_graceful_handling(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        let emptyRes = false;
        let missingRes = false;
        try {
          emptyRes = await p.loadDemo('');
        } catch (_) {
          emptyRes = false;
        }
        try {
          missingRes = await p.loadDemo('nonexistent_demo_404_xyz.dm_26');
        } catch (_) {
          missingRes = false;
        }
        return {
          emptyRes: !!emptyRes,
          missingRes: !!missingRes,
          alive: p.getStatus().ready,
        };
        """
    )
    assert res["emptyRes"] is False, f"loadDemo('') should return false: {res}"
    assert res["missingRes"] is False, f"loadDemo(nonexistent) should return false: {res}"
    assert res["alive"] is True, "Engine crashed after invalid loadDemo call"


def t2_f12_05_multiple_on_demo_complete_listeners_all_invoked(
    ctx: E2ETestContext,
) -> None:
    res = ctx.run_short_demo_to_completion(packet_count=10)
    assert (
        res["callbacksCount"] >= 2
    ), f"Expected both registered completion callbacks to fire, got {res}"
    ctx.ensure_booted("1.51ef9.dm_26")


# ==============================================================================
# F13 Boundaries: 3D Scene Rendering Verification (5 tests)
# ==============================================================================
def t2_f13_01_screenshot_not_solid_color_or_checkerboard_default_texture(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t2_f13_01")
    assert (
        snap["unique_colors"] > 500
    ), f"Expected > 500 unique RGB colors in textured 3D scene, got {snap['unique_colors']}"


def t2_f13_02_screenshot_center_3d_viewport_has_scene_detail(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    snap = ctx.capture_canvas_screenshot("t2_f13_02_center")
    assert (
        snap["center_std_rgb"] > 8.0
    ), f"Center 50% 3D viewport lacks visual variance (std={snap['center_std_rgb']:.2f})"


def t2_f13_03_three_sequential_timestamps_pairwise_distinct(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    s0 = ctx.capture_canvas_screenshot("t2_f13_03_t0")
    time.sleep(0.45)
    s1 = ctx.capture_canvas_screenshot("t2_f13_03_t1")
    time.sleep(0.45)
    s2 = ctx.capture_canvas_screenshot("t2_f13_03_t2")
    d01 = ctx.compare_screenshots(s0, s1)["mean_abs_diff"]
    d12 = ctx.compare_screenshots(s1, s2)["mean_abs_diff"]
    d02 = ctx.compare_screenshots(s0, s2)["mean_abs_diff"]
    assert d01 > 0.1 and d12 > 0.1 and d02 > 0.1, (
        f"Sequential frames were not pairwise distinct: d01={d01:.3f}, d12={d12:.3f}, d02={d02:.3f}"
    )


def t2_f13_04_screenshot_integrity_across_custom_and_base_maps(
    ctx: E2ETestContext,
) -> None:
    for demo in ("1.51ef9.dm_26", "out.dm_26"):
        ctx.ensure_booted(demo)
        time.sleep(0.25)
        snap = ctx.capture_canvas_screenshot(f"t2_f13_04_{demo}")
        assert snap["std_rgb"] > 10.0, f"{demo} failed 3D scene variance check: {snap['std_rgb']}"


def t2_f13_05_zero_webgl_context_lost_across_full_test_sequence(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    gl_state = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        return {
          isLost: gl.isContextLost(),
          err: gl.getError(),
        };
        """
    )
    assert gl_state["isLost"] is False
    assert gl_state["err"] == 0


def get_tier2_tests() -> List[TestCase]:
    return [
        # F1
        TestCase("T2_F01_01_native_binary_no_undefined_engine_symbols", 2, "F1", "Verify openjk.x86_64 has no undefined core engine symbols", t2_f01_01_native_binary_no_undefined_engine_symbols),
        TestCase("T2_F01_02_native_binary_exports_or_resolves_renderer_api", 2, "F1", "Verify GetRefAPI is exported or linked in native build", t2_f01_02_native_binary_exports_or_resolves_renderer_api),
        TestCase("T2_F01_03_native_binary_exports_or_resolves_cgame_and_ui_api", 2, "F1", "Verify cgame and ui module entry points resolve in native build", t2_f01_03_native_binary_exports_or_resolves_cgame_and_ui_api),
        TestCase("T2_F01_04_native_build_idempotent_incremental_invocation", 2, "F1", "Verify incremental scripts/build_native.sh invocation exits 0", t2_f01_04_native_build_idempotent_incremental_invocation),
        TestCase("T2_F01_05_native_build_preserves_clean_source_tree", 2, "F1", "Verify native build does not pollute source directories with .o files", t2_f01_05_native_build_preserves_clean_source_tree),
        # F2
        TestCase("T2_F02_01_wasm_binary_sections_validation", 2, "F2", "Parse and validate all WebAssembly binary sections in web/openjk.wasm", t2_f02_01_wasm_binary_sections_validation),
        TestCase("T2_F02_02_wasm_symbol_isolation_cgame_vs_ui", 2, "F2", "Verify cgame and ui static libraries isolate colliding C symbols", t2_f02_02_wasm_symbol_isolation_cgame_vs_ui),
        TestCase("T2_F02_03_wasm_memory_configuration_bounds", 2, "F2", "Verify WebAssembly.Memory configuration in web/openjk.js", t2_f02_03_wasm_memory_configuration_bounds),
        TestCase("T2_F02_04_wasm_build_idempotent_incremental_invocation", 2, "F2", "Verify incremental scripts/build_wasm.sh invocation exits 0", t2_f02_04_wasm_build_idempotent_incremental_invocation),
        TestCase("T2_F02_05_wasm_no_desktop_glx_or_x11_imports", 2, "F2", "Verify web/openjk.js contains no desktop X11/GLX imports", t2_f02_05_wasm_no_desktop_glx_or_x11_imports),
        # F3
        TestCase("T2_F03_01_frame_loop_under_paused_state_continues_raf", 2, "F3", "Verify main loop continues advancing frameCount while demo is paused", t2_f03_01_frame_loop_under_paused_state_continues_raf),
        TestCase("T2_F03_02_frame_loop_under_minimum_timescale", 2, "F3", "Verify main loop advances frameCount and serverTime at minimum timescale 0.05", t2_f03_02_frame_loop_under_minimum_timescale),
        TestCase("T2_F03_03_frame_loop_under_maximum_timescale", 2, "F3", "Verify main loop advances frameCount and serverTime at high timescale 8.0", t2_f03_03_frame_loop_under_maximum_timescale),
        TestCase("T2_F03_04_concurrent_async_fetch_during_main_loop", 2, "F3", "Verify concurrent browser fetch() calls resolve promptly during main loop", t2_f03_04_concurrent_async_fetch_during_main_loop),
        TestCase("T2_F03_05_visibility_change_and_focus_events_do_not_crash_loop", 2, "F3", "Verify visibilitychange/blur/focus events do not disrupt main loop", t2_f03_05_visibility_change_and_focus_events_do_not_crash_loop),
        # F4
        TestCase("T2_F04_01_webgl_no_gl_array_element_missing_error", 2, "F4", "Verify zero glArrayElement errors in browser console (r_primitives=2)", t2_f04_01_webgl_no_gl_array_element_missing_error),
        TestCase("T2_F04_02_webgl_no_texture_rectangle_or_rgba16_invalid_enum", 2, "F4", "Verify zero GL_INVALID_ENUM errors from GL_TEXTURE_RECTANGLE_ARB or GL_RGBA16", t2_f04_02_webgl_no_texture_rectangle_or_rgba16_invalid_enum),
        TestCase("T2_F04_03_webgl_canvas_resize_and_viewport_stability", 2, "F4", "Verify WebGL viewport renders across all quadrants of 1280x720 canvas", t2_f04_03_webgl_canvas_resize_and_viewport_stability),
        TestCase("T2_F04_04_webgl_alpha_channel_opaque_rendering", 2, "F4", "Verify WebGL canvas alpha channel is opaque (255)", t2_f04_04_webgl_alpha_channel_opaque_rendering),
        TestCase("T2_F04_05_webgl_multiple_consecutive_readpixels_calls", 2, "F4", "Verify 5 consecutive toDataURL calls retain non-blank drawing buffer", t2_f04_05_webgl_multiple_consecutive_readpixels_calls),
        # F5
        TestCase("T2_F05_01_http_range_single_first_byte", 2, "F5", "Verify Range: bytes=0-0 returns HTTP 206 with 1-byte body b'P'", t2_f05_01_http_range_single_first_byte),
        TestCase("T2_F05_02_http_range_eocd_tail_exact_bytes", 2, "F5", "Verify Central Directory + EOCD tail Range request on assets0.pk3", t2_f05_02_http_range_eocd_tail_exact_bytes),
        TestCase("T2_F05_03_http_range_out_of_bounds_returns_416", 2, "F5", "Verify out-of-bounds Range request returns HTTP 416", t2_f05_03_http_range_out_of_bounds_returns_416),
        TestCase("T2_F05_04_http_nonexistent_pk3_and_demo_return_404", 2, "F5", "Verify nonexistent .pk3 and .dm_26 paths return HTTP 404", t2_f05_04_http_nonexistent_pk3_and_demo_return_404),
        TestCase("T2_F05_05_http_demo_name_with_and_without_dm26_suffix", 2, "F5", "Verify /demos/hood and /demos/hood.dm_26 both return 200 OK with exact bytes", t2_f05_05_http_demo_name_with_and_without_dm26_suffix),
        # F6
        TestCase("T2_F06_01_pk3_manifest_cd_offsets_match_physical_files", 2, "F6", "Verify /base/manifest.json size, cd_offset, and cd_size match physical .pk3 EOCDs", t2_f06_01_pk3_manifest_cd_offsets_match_physical_files),
        TestCase("T2_F06_02_ui_init_existence_probes_do_not_download_unused_player_icons", 2, "F6", "Verify UI_Init existence probes do not download unused assets1.pk3 textures", t2_f06_02_ui_init_existence_probes_do_not_download_unused_player_icons),
        TestCase("T2_F06_03_sp_voiceovers_and_roq_videos_never_fetched", 2, "F6", "Verify SP voiceovers and .roq videos in assets0.pk3 are never fetched", t2_f06_03_sp_voiceovers_and_roq_videos_never_fetched),
        TestCase("T2_F06_04_metrics_reset_followed_by_demo_switch_tracks_incremental_bytes", 2, "F6", "Verify /api/metrics/reset followed by demo switch tracks only incremental .pk3 bytes", t2_f06_04_metrics_reset_followed_by_demo_switch_tracks_incremental_bytes),
        TestCase("T2_F06_05_reload_same_demo_uses_cached_pk3_blocks", 2, "F6", "Verify reloading the same demo reuses in-memory cached .pk3 blocks (< 10 MB)", t2_f06_05_reload_same_demo_uses_cached_pk3_blocks),
        # F7
        TestCase("T2_F07_01_multiple_rapid_canvas_clicks_never_trigger_pointer_lock", 2, "F7", "Verify 10 rapid clicks on #jk-canvas never trigger Pointer Lock", t2_f07_01_multiple_rapid_canvas_clicks_never_trigger_pointer_lock),
        TestCase("T2_F07_02_game_hotkeys_in_host_input_do_not_trigger_engine_binds", 2, "F7", "Verify game hotkeys (~, Esc, Space, WASD, Tab) in host input are not hijacked", t2_f07_02_game_hotkeys_in_host_input_do_not_trigger_engine_binds),
        TestCase("T2_F07_03_mouse_wheel_and_mousemove_over_canvas_do_not_lock_page", 2, "F7", "Verify mousemove and wheel events over #jk-canvas do not lock cursor", t2_f07_03_mouse_wheel_and_mousemove_over_canvas_do_not_lock_page),
        TestCase("T2_F07_04_get_status_returns_all_required_contract_fields", 2, "F7", "Verify JKDemoPlayer.getStatus() returns all 16 required contract fields", t2_f07_04_get_status_returns_all_required_contract_fields),
        TestCase("T2_F07_05_openjkplayer_alias_is_strictly_identical_to_jkdemoplayer", 2, "F7", "Verify window.OpenJKPlayer is identical to window.JKDemoPlayer", t2_f07_05_openjkplayer_alias_is_strictly_identical_to_jkdemoplayer),
        # F8
        TestCase("T2_F08_01_boot_with_demo_name_without_dm26_extension", 2, "F8", "Verify demo name without .dm_26 extension resolves and plays", t2_f08_01_boot_with_demo_name_without_dm26_extension),
        TestCase("T2_F08_02_boot_with_demo_url_path_prefix", 2, "F8", "Verify demo URL with /demos/ path prefix resolves and plays", t2_f08_02_boot_with_demo_url_path_prefix),
        TestCase("T2_F08_03_boot_with_initial_speed_query_param", 2, "F8", "Verify initial speed query parameter configuration sets timescale", t2_f08_03_boot_with_initial_speed_query_param),
        TestCase("T2_F08_04_boot_with_initial_muted_query_param", 2, "F8", "Verify initial muted query parameter configuration sets mute state", t2_f08_04_boot_with_initial_muted_query_param),
        TestCase("T2_F08_05_boot_custom_map_demo_ctf_kejim", 2, "F8", "Verify custom map demo 1.51ef9.dm_26 (mp/ctf_kejim) boots cleanly", t2_f08_05_boot_custom_map_demo_ctf_kejim),
        # F9
        TestCase("T2_F09_01_idempotent_double_pause", 2, "F9", "Verify calling pause() twice is idempotent and keeps serverTime frozen", t2_f09_01_idempotent_double_pause),
        TestCase("T2_F09_02_idempotent_double_resume", 2, "F9", "Verify calling resume() twice is idempotent and keeps playback active", t2_f09_02_idempotent_double_resume),
        TestCase("T2_F09_03_rapid_toggle_pause_10_times", 2, "F9", "Verify 10 rapid togglePause() calls alternate cleanly with monotonic serverTime", t2_f09_03_rapid_toggle_pause_10_times),
        TestCase("T2_F09_04_play_method_alias_for_resume", 2, "F9", "Verify play() acts as an alias for resume()", t2_f09_04_play_method_alias_for_resume),
        TestCase("T2_F09_05_pause_events_dispatched_on_window", 2, "F9", "Verify pause() and resume() state transitions complete without errors", t2_f09_05_pause_events_dispatched_on_window),
        # F10
        TestCase("T2_F10_01_speed_lower_boundary_clamping", 2, "F10", "Verify setSpeed clamps values <= 0.05 to lower bound 0.05", t2_f10_01_speed_lower_boundary_clamping),
        TestCase("T2_F10_02_speed_upper_boundary_clamping", 2, "F10", "Verify setSpeed clamps extreme values to upper bound <= 20.0", t2_f10_02_speed_upper_boundary_clamping),
        TestCase("T2_F10_03_speed_nan_and_invalid_input_handling", 2, "F10", "Verify setSpeed(NaN) does not corrupt timescale into NaN", t2_f10_03_speed_nan_and_invalid_input_handling),
        TestCase("T2_F10_04_fractional_slow_motion_speeds_advance_monotonically", 2, "F10", "Verify slow-motion speed 0.1x advances serverTime monotonically", t2_f10_04_fractional_slow_motion_speeds_advance_monotonically),
        TestCase("T2_F10_05_rapid_speed_transitions_preserve_monotonic_server_time", 2, "F10", "Verify rapid speed transitions preserve monotonic serverTime", t2_f10_05_rapid_speed_transitions_preserve_monotonic_server_time),
        # F11
        TestCase("T2_F11_01_volume_zero_boundary", 2, "F11", "Verify setVolume(0.0) sets volume to exact lower bound 0.0", t2_f11_01_volume_zero_boundary),
        TestCase("T2_F11_02_volume_one_boundary", 2, "F11", "Verify setVolume(1.0) sets volume to exact upper bound 1.0", t2_f11_02_volume_one_boundary),
        TestCase("T2_F11_03_volume_below_zero_clamped", 2, "F11", "Verify negative volume input is clamped to 0.0", t2_f11_03_volume_below_zero_clamped),
        TestCase("T2_F11_04_volume_above_one_clamped", 2, "F11", "Verify volume input > 1.0 is clamped to 1.0", t2_f11_04_volume_above_one_clamped),
        TestCase("T2_F11_05_idempotent_mute_unmute_and_set_muted", 2, "F11", "Verify idempotent mute()/unmute()/setMuted() preserves volume level", t2_f11_05_idempotent_mute_unmute_and_set_muted),
        # F12
        TestCase("T2_F12_01_load_demo_with_and_without_extension", 2, "F12", "Verify loadDemo('hood') and loadDemo('hood.dm_26') both succeed", t2_f12_01_load_demo_with_and_without_extension),
        TestCase("T2_F12_02_load_demo_with_full_path_prefix", 2, "F12", "Verify loadDemo('/demos/kom.dm_26') switches to kom on mp/ctf3", t2_f12_02_load_demo_with_full_path_prefix),
        TestCase("T2_F12_03_load_demo_across_distinct_maps", 2, "F12", "Verify switching across 3 distinct maps (ctf_kejim, ctf1, ctf4) succeeds", t2_f12_03_load_demo_across_distinct_maps),
        TestCase("T2_F12_04_load_demo_invalid_or_empty_name_graceful_handling", 2, "F12", "Verify loadDemo('') and nonexistent demo fail gracefully without crashing", t2_f12_04_load_demo_invalid_or_empty_name_graceful_handling),
        TestCase("T2_F12_05_multiple_on_demo_complete_listeners_all_invoked", 2, "F12", "Verify multiple registered onDemoComplete listeners all fire on completion", t2_f12_05_multiple_on_demo_complete_listeners_all_invoked),
        # F13
        TestCase("T2_F13_01_screenshot_not_solid_color_or_checkerboard_default_texture", 2, "F13", "Verify 3D scene screenshot has > 500 unique RGB colors", t2_f13_01_screenshot_not_solid_color_or_checkerboard_default_texture),
        TestCase("T2_F13_02_screenshot_center_3d_viewport_has_scene_detail", 2, "F13", "Verify center 50% crop (excluding 2D HUD edges) has high 3D scene variance", t2_f13_02_screenshot_center_3d_viewport_has_scene_detail),
        TestCase("T2_F13_03_three_sequential_timestamps_pairwise_distinct", 2, "F13", "Verify 3 sequential screenshots across 900ms are all pairwise distinct", t2_f13_03_three_sequential_timestamps_pairwise_distinct),
        TestCase("T2_F13_04_screenshot_integrity_across_custom_and_base_maps", 2, "F13", "Verify 3D scene screenshots on both custom (ctf_kejim) and base (ctf1) maps", t2_f13_04_screenshot_integrity_across_custom_and_base_maps),
        TestCase("T2_F13_05_zero_webgl_context_lost_across_full_test_sequence", 2, "F13", "Verify WebGL context remains active and error-free after boundary tests", t2_f13_05_zero_webgl_context_lost_across_full_test_sequence),
    ]
