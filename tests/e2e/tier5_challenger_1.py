#!/usr/bin/env python3
"""
Tier 5 — White-Box Adversarial Verification & Stress Suite (Challenger 1).
Standalone script that spawns an isolated local server & headless Chrome session on a free port
and empirically stress-tests:
1. HTTP Range VFS & Server Stress (suffix ranges, open-ended ranges, single-byte ranges, 416 errors,
   CORS preflight, path traversal rejection, 24-way concurrent Range stress).
2. Cold-boot on-demand .pk3 HTTP 206 Partial Content loading (< 150 MB budget, 0 full downloads,
   C-level counter synchronization).
3. Headless Chrome 3D WebGL rendering across multiple timestamps & maps (toDataURL + gl.readPixels,
   non-blank changing 3D scene pixels, zero GL/JS/Wasm errors, pointerLockElement === null).
4. Rapid JS playback control transitions (20x pause/resume toggles, pause time-jump prevention,
   extreme timescale 0.1 -> 10.0 -> 1.0 transitions, rapid volume/mute toggles, C-level nonexistent
   demo guard, listener exception isolation/unsubscribe, and multi-map loadDemo switching).
"""

import concurrent.futures
import json
import os
from pathlib import Path
import sys
import time
import traceback
from typing import Any, Dict, List

# Ensure /home/dan/OpenJK is on sys.path so tests.e2e.harness imports cleanly
ROOT_DIR = Path("/home/dan/OpenJK/jaMME")
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tests.e2e.harness import E2ETestContext, TestCase, find_free_port, inspect_zip_eocd


# ==============================================================================
# 1. HTTP Range Server White-Box Boundary & Protocol Stress
# ==============================================================================
def t5_c1_01_server_http_range_boundaries_suffix_open_and_416(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    ctx.reset_metrics()

    assets0_disk = ctx.pk3_base_dir / "assets0.pk3"
    eocd = inspect_zip_eocd(assets0_disk)
    total_size = eocd["size"]  # 561,806,019

    # 1a. Suffix range: bytes=-65536
    st_suf, hdr_suf, body_suf = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=-65536"}
    )
    assert st_suf == 206, f"Expected 206 for suffix range bytes=-65536, got {st_suf}"
    assert len(body_suf) == 65536, f"Expected 65536 bytes, got {len(body_suf)}"
    expected_start = total_size - 65536
    assert (
        hdr_suf.get("content-range")
        == f"bytes {expected_start}-{total_size - 1}/{total_size}"
    ), f"Unexpected Content-Range for suffix range: {hdr_suf.get('content-range')}"
    assert b"PK\x05\x06" in body_suf[-64:], "Missing EOCD signature in suffix range tail"

    # 1b. Exact 22-byte EOCD suffix range: bytes=-22
    st_eocd, _, body_eocd = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=-22"}
    )
    assert st_eocd == 206 and len(body_eocd) == 22
    assert body_eocd[:4] == b"PK\x05\x06", f"Expected PK\\x05\\x06 at -22, got {body_eocd[:4]!r}"

    # 1c. Open-ended range: bytes=<size-22>-
    st_open, hdr_open, body_open = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": f"bytes={total_size - 22}-"}
    )
    assert st_open == 206 and body_open == body_eocd
    assert (
        hdr_open.get("content-range")
        == f"bytes {total_size - 22}-{total_size - 1}/{total_size}"
    )

    # 1d. Single-byte ranges: first byte (0-0) and last byte (size-1 to size-1)
    st_first, _, body_first = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-0"}
    )
    assert st_first == 206 and body_first == b"P"
    st_last, hdr_last, body_last = ctx.http_request(
        "GET",
        "/base/assets0.pk3",
        headers={"Range": f"bytes={total_size - 1}-{total_size - 1}"},
    )
    assert st_last == 206 and len(body_last) == 1
    assert (
        hdr_last.get("content-range")
        == f"bytes {total_size - 1}-{total_size - 1}/{total_size}"
    )

    # 1e. Range with end beyond EOF (clamped to size - 1 per RFC 7233)
    st_clamp, hdr_clamp, body_clamp = ctx.http_request(
        "GET",
        "/base/assets0.pk3",
        headers={"Range": f"bytes={total_size - 10}-{total_size + 50000}"},
    )
    assert st_clamp == 206 and len(body_clamp) == 10
    assert (
        hdr_clamp.get("content-range")
        == f"bytes {total_size - 10}-{total_size - 1}/{total_size}"
    )

    # 1f. Invalid / unsatisfiable ranges -> 416 Range Not Satisfiable
    m_before_416 = ctx.get_metrics()
    invalid_ranges = [
        "bytes=-0",
        "bytes=-",
        "bytes=500-100",
        f"bytes={total_size}-{total_size + 10}",
        "bytes=999999999-1000000000",
        "items=0-15",
        "bytes=abc-def",
    ]
    for bad_rng in invalid_ranges:
        st_bad, hdr_bad, _ = ctx.http_request(
            "GET", "/base/assets0.pk3", headers={"Range": bad_rng}
        )
        assert (
            st_bad == 416
        ), f"Expected 416 for invalid Range '{bad_rng}', got {st_bad}"
        assert (
            hdr_bad.get("content-range") == f"bytes */{total_size}"
        ), f"Expected Content-Range: bytes */{total_size} on 416, got {hdr_bad}"

    m_after_416 = ctx.get_metrics()
    assert (
        m_after_416["pk3BytesTransferred"] == m_before_416["pk3BytesTransferred"]
    ), "416 responses must not increment pk3BytesTransferred"
    assert m_after_416["pk3FullRequests"] == 0

    # 1g. OPTIONS CORS preflight
    st_opt, hdr_opt, _ = ctx.http_request("OPTIONS", "/base/assets0.pk3")
    assert st_opt == 204, f"Expected 204 for OPTIONS, got {st_opt}"
    assert "content-range" in hdr_opt.get("access-control-expose-headers", "").lower()


# ==============================================================================
# 2. Path Traversal & Filename Injection Rejection
# ==============================================================================
def t5_c1_02_server_path_traversal_and_injection_rejection(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    m0 = ctx.get_metrics()
    traversal_paths = [
        "/base/../web/server.py",
        "/base/%2e%2e/web/server.py",
        "/base/..%2f..%2fetc/passwd",
        "/base/..\\web\\server.py",
        "/base/sub/assets0.pk3",
        "/demos/../../web/server.py",
        "/demos/%2e%2e%2fweb%2fserver.py",
        "/base/demos/../../../etc/hosts",
        "/../web/server.py",
    ]
    for bad_path in traversal_paths:
        st, _, body = ctx.http_request("GET", bad_path)
        assert st == 404, f"Expected HTTP 404 for traversal path {bad_path!r}, got {st}"
        assert b"OpenJKHTTPServer" not in body, f"Leaked server.py source on {bad_path!r}"

    m1 = ctx.get_metrics()
    assert m1["pk3BytesTransferred"] == m0["pk3BytesTransferred"]
    assert m1["demoBytesTransferred"] == m0["demoBytesTransferred"]


# ==============================================================================
# 3. High-Concurrency Multi-Archive HTTP Range Stress
# ==============================================================================
def t5_c1_03_server_concurrent_24_range_stress_and_exact_metrics(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    ctx.reset_metrics()

    archives = [
        "assets0.pk3",
        "assets1.pk3",
        "assets2.pk3",
        "assets3.pk3",
        "ctf_kejim.pk3",
    ]
    tasks = []
    for i in range(24):
        arch = archives[i % len(archives)]
        start = i * 4096
        length = 512 + (i * 128)
        end = start + length - 1
        tasks.append((arch, start, end, length))

    def worker(item):
        arch, s, e, expected_len = item
        st, hdr, body = ctx.http_request(
            "GET", f"/base/{arch}", headers={"Range": f"bytes={s}-{e}"}
        )
        assert st == 206, f"Concurrent Range on {arch} [{s}-{e}] failed with {st}"
        assert (
            len(body) == expected_len
        ), f"Length mismatch on {arch}: {len(body)} != {expected_len}"
        assert hdr.get("content-range", "").startswith(f"bytes {s}-{e}/")
        return expected_len

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(worker, tasks))

    expected_total = sum(results)
    m = ctx.get_metrics()
    assert (
        m["pk3RangeRequests"] == 24
    ), f"Expected 24 range requests recorded, got {m['pk3RangeRequests']}"
    assert (
        m["pk3BytesTransferred"] == expected_total
    ), f"Expected {expected_total} bytes recorded, got {m['pk3BytesTransferred']}"
    assert m["pk3FullRequests"] == 0


# ==============================================================================
# 4. Cold-Boot On-Demand .pk3 HTTP 206 Verification & < 150 MB Budget
# ==============================================================================
def t5_c1_04_cold_boot_on_demand_pk3_http_206_and_under_150mb_budget(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_server()
    ctx.reset_metrics()
    st = ctx.ensure_booted("1.51ef9.dm_26", force_reload=True)
    m = ctx.cold_boot_metrics or ctx.get_metrics()

    assert st.get("ready") is True and st.get("isPlaying") is True, f"Cold boot failed: {st}"
    assert "1.51ef9" in str(st.get("demoName", "")).lower()

    # Verify HTTP Range 206 metrics
    limit_150mb = 150 * 1024 * 1024
    assert m["pk3RangeRequests"] >= 5, f"Expected >= 5 HTTP Range requests, got {m}"
    assert m["pk3FullRequests"] == 0, f"Expected 0 full .pk3 downloads, got {m}"
    assert (
        0 < m["pk3BytesTransferred"] < limit_150mb
    ), f"pk3BytesTransferred ({m['pk3BytesTransferred']:,} B) violated < 150 MB budget"

    per_file = m.get("perFileBytes") or {}
    assert per_file.get("assets0.pk3", 0) > 0, f"assets0.pk3 not indexed: {per_file}"
    assert per_file.get("ctf_kejim.pk3", 0) > 0, f"ctf_kejim.pk3 not fetched: {per_file}"

    # Verify C-level Wasm counters in files.cpp match positive Range activity
    c_metrics = ctx.eval_js(
        """
        return {
          cBytes: Module._JK_DemoGetPk3BytesTransferred ? Module._JK_DemoGetPk3BytesTransferred() : 0,
          cReqs: Module._JK_DemoGetPk3RangeRequests ? Module._JK_DemoGetPk3RangeRequests() : 0,
          pointerLock: document.pointerLockElement,
        };
        """
    )
    assert c_metrics["cBytes"] > 0 and c_metrics["cBytes"] < limit_150mb, f"Bad C bytes: {c_metrics}"
    assert c_metrics["cReqs"] >= 5, f"Bad C range reqs: {c_metrics}"
    assert c_metrics["pointerLock"] is None, f"Pointer lock engaged: {c_metrics}"

    logs = ctx.get_browser_logs()
    assert len(logs.get("pageErrors") or []) == 0, f"Unhandled page errors: {logs['pageErrors']}"


# ==============================================================================
# 5. Multi-Timestamp 3D WebGL Rendering & Raw Pixel Buffer Verification
# ==============================================================================
def t5_c1_05_multi_timestamp_webgl_3d_rendering_and_pixel_motion(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.eval_js(
        "const p = window.JKDemoPlayer || window.OpenJKPlayer; p.resume(); p.setSpeed(1.5);"
    )

    snaps = []
    for i in range(4):
        if i > 0:
            time.sleep(0.45)
        snaps.append(ctx.capture_canvas_screenshot(f"t5_c1_05_t{i}"))

    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.setSpeed(1.0);")

    # Verify each frame's 3D visual richness
    for idx, s in enumerate(snaps):
        assert s["width"] >= 640 and s["height"] >= 360, f"Unexpected canvas size: {s}"
        assert s["std_rgb"] > 10.0, f"Frame {idx} blank/low std_rgb: {s['std_rgb']}"
        assert s["center_std_rgb"] > 8.0, f"Frame {idx} low center_std_rgb: {s['center_std_rgb']}"
        assert s["unique_colors"] > 400, f"Frame {idx} low unique_colors: {s['unique_colors']}"
        assert s["non_black_ratio"] > 0.20, f"Frame {idx} mostly black: {s['non_black_ratio']}"

    # Verify monotonic serverTime and positive pixel motion across timestamps
    for i in range(len(snaps) - 1):
        t_a = snaps[i]["status"]["serverTime"]
        t_b = snaps[i + 1]["status"]["serverTime"]
        assert t_b > t_a, f"serverTime did not advance: {t_a} -> {t_b}"
        diff = ctx.compare_screenshots(snaps[i], snaps[i + 1])
        assert (
            diff["mean_abs_diff"] > 0.15
        ), f"No 3D pixel change between t{i} and t{i+1}: {diff}"

    # Direct WebGL readPixels check on the active context
    gl_check = ctx.eval_js(
        """
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        const w = 64, h = 64;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(Math.floor(c.width / 2 - w / 2), Math.floor(c.height / 2 - h / 2), w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let nonZero = 0;
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const lum = buf[i] + buf[i+1] + buf[i+2];
          if (lum > 15) nonZero++;
          sum += lum;
        }
        return {
          isLost: gl.isContextLost(),
          glErr: gl.getError(),
          nonZeroCenterPixels: nonZero,
          meanLum: sum / (w * h * 3),
          pointerLock: document.pointerLockElement,
        };
        """
    )
    assert gl_check["isLost"] is False
    assert gl_check["glErr"] == 0
    assert gl_check["nonZeroCenterPixels"] > 500, f"readPixels center patch blank: {gl_check}"
    assert gl_check["pointerLock"] is None


# ==============================================================================
# 6. Rapid JS Playback Control Stress (Pause/Resume, Extreme Timescale, Audio)
# ==============================================================================
def t5_c1_06_rapid_js_controls_pause_speed_audio_stress(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")

    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(1.0);
        p.resume();

        // 1. 20 rapid togglePause() calls
        const toggles = [];
        for (let i = 0; i < 20; i++) {
          toggles.push(p.togglePause());
        }

        // 2. Pause for 650ms, verify zero serverTime drift, then resume for 180ms and verify no time-jump
        p.pause();
        await new Promise(r => setTimeout(r, 60));
        const tPause0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 650));
        const tPause1 = p.getStatus().serverTime;
        p.resume();
        await new Promise(r => setTimeout(r, 180));
        const tPostResume = p.getStatus().serverTime;
        const postResumeDelta = tPostResume - tPause1;

        // 3. Extreme timescale transitions: 0.1 -> 10.0 -> 0.05 -> 20.0 -> 1.0
        const speedTrace = [];
        const timeTrace = [p.getStatus().serverTime];
        for (const sp of [0.1, 10.0, 0.05, 20.0, 0.25, 4.0, 1.0]) {
          const applied = p.setSpeed(sp);
          speedTrace.push(applied);
          await new Promise(r => setTimeout(r, 90));
          timeTrace.push(p.getStatus().serverTime);
        }
        // Test fractional carry specifically at 0.1x over 400ms
        p.setSpeed(0.1);
        const tSlow0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 400));
        const tSlow1 = p.getStatus().serverTime;
        p.setSpeed(1.0);

        // 4. Rapid volume & mute toggles + C-level verification
        const volTrace = [];
        for (const v of [0.0, 0.15, 0.5, 1.0, -2.0, 9.0, 0.75]) {
          volTrace.push(p.setVolume(v));
          p.toggleMute();
        }
        p.unmute();
        p.setVolume(0.8);
        await new Promise(r => setTimeout(r, 80));

        let monotonic = true;
        for (let i = 1; i < timeTrace.length; i++) {
          if (timeTrace[i] < timeTrace[i - 1]) monotonic = false;
        }

        return {
          togglesLen: toggles.length,
          finalPausedAfterToggles: toggles[toggles.length - 1],
          tPause0,
          tPause1,
          postResumeDelta,
          speedTrace,
          monotonic,
          slowAdvance: tSlow1 - tSlow0,
          volTrace,
          finalMuted: p.isMuted(),
          finalVol: p.getVolume(),
          cMuted: Module._JK_DemoIsMuted ? Module._JK_DemoIsMuted() : -1,
          cVol: Module._JK_DemoGetVolume ? Module._JK_DemoGetVolume() : -1,
          audioContextState: p.getStatus().audioContextState,
        };
        """
    )

    assert res["togglesLen"] == 20 and res["finalPausedAfterToggles"] is False
    assert res["tPause0"] == res["tPause1"], f"serverTime drifted while paused: {res}"
    assert (
        0 < res["postResumeDelta"] < 550
    ), f"Unpause time-jump detected after 650ms pause + 180ms play: {res}"
    assert res["speedTrace"] == [0.1, 10.0, 0.05, 20.0, 0.25, 4.0, 1.0]
    assert res["monotonic"] is True, f"Non-monotonic serverTime during extreme speed transitions: {res}"
    assert res["slowAdvance"] > 0, f"0.1x timescale failed to advance serverTime: {res}"
    assert res["volTrace"] == [0.0, 0.15, 0.5, 1.0, 0.0, 1.0, 0.75]
    assert res["finalMuted"] is False and res["cMuted"] == 0
    assert abs(res["finalVol"] - 0.8) < 0.02 and abs(res["cVol"] - 0.8) < 0.02
    assert res["audioContextState"] == "running"


# ==============================================================================
# 7. White-Box C Exports, Nonexistent Demo Guard & Listener Exception Isolation
# ==============================================================================
def t5_c1_07_whitebox_c_exports_and_nonexistent_demo_guard(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")

    # 7a. Verify C-level exports and CL_PlayDemo_f guard against nonexistent demo disconnecting active demo
    c_res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const stateBefore = Module._JK_DemoGetState();
        const mapName = Module.UTF8ToString(Module._JK_DemoGetMapName());
        const demoName = Module.UTF8ToString(Module._JK_DemoGetName());
        const rt0 = Module._JK_DemoGetRealtime();

        // Invoke C-level JK_DemoLoad with a missing file; cl_main.cpp:600-610 must abort before CL_Disconnect
        Module.ccall('JK_DemoLoad', 'number', ['string'], ['missing_nonexistent_file_xyz']);
        await new Promise(r => setTimeout(r, 150));

        const stateAfter = Module._JK_DemoGetState();
        const playingAfter = p.getStatus().isPlaying;
        const rt1 = Module._JK_DemoGetRealtime();
        return {
          stateBefore,
          stateAfter,
          playingAfter,
          mapName,
          demoName,
          rtDelta: rt1 - rt0,
        };
        """
    )
    assert c_res["stateBefore"] == 8 and c_res["stateAfter"] == 8, f"Expected CA_ACTIVE (8): {c_res}"
    assert c_res["playingAfter"] is True, f"Missing demo load killed active playback: {c_res}"
    assert "ctf_kejim" in c_res["mapName"].lower(), f"Unexpected mapName: {c_res}"
    assert c_res["rtDelta"] > 0

    # 7b. Verify onDemoComplete unsubscribe and exception isolation across listeners
    comp_res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        let unsubscribedCalled = 0;
        let throwingCalled = 0;
        let afterThrowCalled = 0;

        const unsub = p.onDemoComplete(() => { unsubscribedCalled++; });
        unsub();

        const unsubThrow = p.onDemoComplete(() => {
          throwingCalled++;
          throw new Error('Intentional adversarial listener error');
        });
        const unsubValid = p.onDemoComplete((detail) => {
          afterThrowCalled++;
        });

        p._onInternalDemoCompleted('1.51ef9.dm_26', p.getStatus().serverTime, p.getStatus().frameCount, p.getStatus().demoCompletedCount + 1);
        // Restore demoEnded=false since demo is still playing
        unsubThrow();
        unsubValid();
        return {
          unsubscribedCalled,
          throwingCalled,
          afterThrowCalled,
        };
        """
    )
    assert comp_res["unsubscribedCalled"] == 0, "Unsubscribed listener was still invoked"
    assert comp_res["throwingCalled"] == 1
    assert (
        comp_res["afterThrowCalled"] == 1
    ), "Exception in first listener prevented subsequent listener from firing"


# ==============================================================================
# 8. Multi-Demo Map Switching & Concurrent loadChain Stress
# ==============================================================================
def t5_c1_08_multi_demo_switching_and_concurrent_loadchain_stress(
    ctx: E2ETestContext,
) -> None:
    ctx.ensure_booted("1.51ef9.dm_26")

    # 8a. Verify 1.51ef9.dm_26 (mp/ctf_kejim) and switch to out.dm_26 (mp/ctf1)
    map_snaps = {}
    for demo, expected_map in [("1.51ef9.dm_26", "ctf_kejim"), ("out.dm_26", "ctf1")]:
        st = ctx.ensure_booted(demo)
        assert st.get("isPlaying") is True, f"Failed playing {demo}: {st}"
        time.sleep(0.3)
        c_map = ctx.eval_js("return Module.UTF8ToString(Module._JK_DemoGetMapName());")
        assert (
            expected_map in c_map.lower()
        ), f"Expected map {expected_map} for {demo}, got {c_map!r}"
        snap = ctx.capture_canvas_screenshot(f"t5_c1_08_{demo}")
        assert snap["std_rgb"] > 10.0 and snap["unique_colors"] > 400
        map_snaps[demo] = snap

    # 8b. Concurrent back-to-back loadDemo() calls exercising state.loadChain serialization
    # while transitioning to the third map hood.dm_26 (mp/ffa3)
    chain_res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const p1 = p.loadDemo('nonexistent_chain_test.dm_26');
        const p2 = p.loadDemo('hood.dm_26');
        const [r1, r2] = await Promise.all([p1, p2]);
        const st = p.getStatus();
        return {
          r1,
          r2,
          finalDemo: st.demoName,
          isPlaying: st.isPlaying,
          mapName: Module.UTF8ToString(Module._JK_DemoGetMapName()),
          pointerLock: document.pointerLockElement,
        };
        """,
        timeout=90.0,
    )
    ctx.current_boot_demo = "hood.dm_26"
    assert chain_res["r1"] is False and chain_res["r2"] is True, f"loadChain failed: {chain_res}"
    assert "hood" in str(chain_res["finalDemo"]).lower(), f"Wrong final demo: {chain_res}"
    assert "ffa3" in str(chain_res["mapName"]).lower(), f"Expected ffa3 for hood.dm_26: {chain_res}"
    assert chain_res["isPlaying"] is True
    assert chain_res["pointerLock"] is None

    time.sleep(0.3)
    snap_hood = ctx.capture_canvas_screenshot("t5_c1_08_hood.dm_26")
    assert snap_hood["std_rgb"] > 10.0 and snap_hood["unique_colors"] > 400
    map_snaps["hood.dm_26"] = snap_hood

    diff_12 = ctx.compare_screenshots(map_snaps["1.51ef9.dm_26"], map_snaps["out.dm_26"])
    diff_23 = ctx.compare_screenshots(map_snaps["out.dm_26"], map_snaps["hood.dm_26"])
    assert diff_12["mean_abs_diff"] > 2.0, f"Maps 1 and 2 identical: {diff_12}"
    assert diff_23["mean_abs_diff"] > 2.0, f"Maps 2 and 3 identical: {diff_23}"

    # 8c. Final bandwidth & error audit across the entire Tier 5 Challenger 1 run
    m = ctx.get_metrics()
    assert m["pk3FullRequests"] == 0, f"Full .pk3 downloads occurred: {m}"
    assert (
        0 < m["pk3BytesTransferred"] < 150 * 1024 * 1024
    ), f"Total .pk3 transfer {m['pk3BytesTransferred']:,} B exceeded 150 MB"

    logs = ctx.get_browser_logs()
    assert len(logs.get("pageErrors") or []) == 0, f"Unhandled page errors: {logs['pageErrors']}"


def get_tier5_challenger_1_tests() -> List[TestCase]:
    return [
        TestCase(
            "T5_C1_01_server_http_range_boundaries_suffix_open_and_416",
            5,
            "F5,F6",
            "White-box HTTP Range server stress: suffix (-65536, -22), open-ended, clamped, 416 errors, OPTIONS CORS",
            t5_c1_01_server_http_range_boundaries_suffix_open_and_416,
        ),
        TestCase(
            "T5_C1_02_server_path_traversal_and_injection_rejection",
            5,
            "F5",
            "White-box security check: reject ../, URL-encoded %2e%2e, and backslash traversal on /base and /demos",
            t5_c1_02_server_path_traversal_and_injection_rejection,
        ),
        TestCase(
            "T5_C1_03_server_concurrent_24_range_stress_and_exact_metrics",
            5,
            "F5,F6",
            "24-way multi-threaded HTTP Range stress across 5 .pk3 archives with exact byte telemetry verification",
            t5_c1_03_server_concurrent_24_range_stress_and_exact_metrics,
        ),
        TestCase(
            "T5_C1_04_cold_boot_on_demand_pk3_http_206_and_under_150mb_budget",
            5,
            "F2,F3,F5,F6,F8",
            "Cold-boot 1.51ef9.dm_26 in headless Chrome and verify HTTP 206 Range < 150 MB, 0 full downloads, C counter sync",
            t5_c1_04_cold_boot_on_demand_pk3_http_206_and_under_150mb_budget,
        ),
        TestCase(
            "T5_C1_05_multi_timestamp_webgl_3d_rendering_and_pixel_motion",
            5,
            "F4,F7,F13",
            "Multi-timestamp WebGL 3D scene rendering (toDataURL + gl.readPixels), pixel motion, zero GL errors, no PointerLock",
            t5_c1_05_multi_timestamp_webgl_3d_rendering_and_pixel_motion,
        ),
        TestCase(
            "T5_C1_06_rapid_js_controls_pause_speed_audio_stress",
            5,
            "F9,F10,F11",
            "20x rapid pause/resume toggles, pause delta check, extreme timescale (0.1->10->0.05->20->1), rapid mute/volume",
            t5_c1_06_rapid_js_controls_pause_speed_audio_stress,
        ),
        TestCase(
            "T5_C1_07_whitebox_c_exports_and_nonexistent_demo_guard",
            5,
            "F8,F12",
            "Direct C Wasm exports check, nonexistent demo disconnect guard, and onDemoComplete listener exception isolation",
            t5_c1_07_whitebox_c_exports_and_nonexistent_demo_guard,
        ),
        TestCase(
            "T5_C1_08_multi_demo_switching_and_concurrent_loadchain_stress",
            5,
            "F6,F12,F13",
            "Dynamic loadDemo across 3 maps (ctf_kejim, ctf1, ffa3) + concurrent loadChain serialization under 150 MB budget",
            t5_c1_08_multi_demo_switching_and_concurrent_loadchain_stress,
        ),
    ]


def main() -> int:
    port = find_free_port()
    ctx = E2ETestContext(port=port)
    tests = get_tier5_challenger_1_tests()
    print("=" * 96)
    print(
        f"OpenJK WebAssembly Demo Player — Tier 5 Challenger 1 White-Box Suite ({len(tests)} tests on port {port})"
    )
    print("=" * 96)

    passed = 0
    failed = 0
    start_all = time.time()
    try:
        for idx, tc in enumerate(tests, 1):
            t0 = time.time()
            try:
                tc.fn(ctx)
                dt_ms = (time.time() - t0) * 1000.0
                passed += 1
                print(
                    f"[{idx:2d}/{len(tests):2d}] [PASS] (T{tc.tier} {tc.feature}) {tc.test_id} ({dt_ms:.0f} ms)",
                    flush=True,
                )
            except Exception as e:
                dt_ms = (time.time() - t0) * 1000.0
                failed += 1
                print(
                    f"[{idx:2d}/{len(tests):2d}] [FAIL] (T{tc.tier} {tc.feature}) {tc.test_id} ({dt_ms:.0f} ms): {e}",
                    flush=True,
                )
                traceback.print_exc()
    finally:
        ctx.close()

    total_s = time.time() - start_all
    print("-" * 96)
    print(
        f"Tier 5 Challenger 1 Summary: {passed}/{len(tests)} passed ({failed} failed) in {total_s:.1f}s"
    )
    print("=" * 96)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
