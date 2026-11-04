#!/usr/bin/env python3
"""
Tier 3 — Cross-Feature Pairwise Combinations E2E Tests (16 test cases).
Exercises 2-way and 3-way interactions across features F1–F13.
"""

import concurrent.futures
import json
import time
from typing import List

from .harness import E2ETestContext, TestCase


def t3_01_pause_change_speed_while_paused_then_resume(ctx: E2ETestContext) -> None:
    """Pairwise F9 (Pause/Resume) x F10 (Playback Speed)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(1.0);
        p.resume();
        await new Promise(r => setTimeout(r, 80));
        const tBeforePause = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 350));
        const delta1x = p.getStatus().serverTime - tBeforePause;

        // Pause, change speed to 3.0 while paused, verify serverTime stays frozen
        p.pause();
        await new Promise(r => setTimeout(r, 60));
        const tPaused0 = p.getStatus().serverTime;
        p.setSpeed(3.0);
        await new Promise(r => setTimeout(r, 500));
        const tPaused1 = p.getStatus().serverTime;

        // Resume at 3.0x speed
        p.resume();
        await new Promise(r => setTimeout(r, 350));
        const tResumed = p.getStatus().serverTime;
        const delta3x = tResumed - tPaused1;
        p.setSpeed(1.0);
        return { delta1x, tPaused0, tPaused1, delta3x, speedDuringPlay: 3.0 };
        """
    )
    assert res["tPaused0"] == res["tPaused1"], f"serverTime drifted while paused during setSpeed: {res}"
    assert res["delta3x"] > res["delta1x"] * 1.4, f"Expected 3x speed after resume to exceed 1x delta: {res}"


def t3_02_mute_change_volume_while_muted_then_unmute(ctx: E2ETestContext) -> None:
    """Pairwise F11 (Mute) x F11 (Volume)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.mute();
        const muted1 = p.isMuted();
        p.setVolume(0.35);
        const volWhileMuted = p.getVolume();
        const stillMuted = p.isMuted();
        p.unmute();
        await new Promise(r => setTimeout(r, 80));
        const st = p.getStatus();
        const volAfterUnmute = p.getVolume();
        p.setVolume(0.8);
        return {
          muted1,
          volWhileMuted,
          stillMuted,
          mutedAfter: p.isMuted(),
          volAfterUnmute,
          audioContextState: st.audioContextState,
        };
        """
    )
    assert res["muted1"] is True and res["stillMuted"] is True
    assert abs(res["volWhileMuted"] - 0.35) < 0.02
    assert res["mutedAfter"] is False
    assert abs(res["volAfterUnmute"] - 0.35) < 0.02
    assert res["audioContextState"] == "running"


def t3_03_pause_switch_demo_auto_unpauses_and_plays(ctx: E2ETestContext) -> None:
    """Pairwise F9 (Pause) x F12 (Dynamic Demo Switching)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.pause();
        const pausedBefore = p.isPaused();
        const ok = await p.loadDemo('out.dm_26');
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const st = p.getStatus();
          if (st.isPlaying && !st.isPaused && String(st.demoName).toLowerCase().includes('out') && st.serverTime > 0) {
            break;
          }
          await new Promise(r => setTimeout(r, 80));
        }
        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 350));
        const st1 = p.getStatus();
        return {
          pausedBefore,
          ok,
          pausedAfter: st1.isPaused,
          isPlaying: st1.isPlaying,
          demoName: st1.demoName,
          dt: st1.serverTime - st0.serverTime,
        };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "out.dm_26"
    assert res["pausedBefore"] is True
    assert res["ok"] is True
    assert res["pausedAfter"] is False, f"loadDemo should unpause automatically: {res}"
    assert res["isPlaying"] is True and res["dt"] > 0


def t3_04_custom_speed_preserved_or_updated_across_demo_switch(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F10 (Speed) x F12 (Dynamic Demo Switching)."""
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setSpeed(2.0);
        const ok = await p.loadDemo('hood.dm_26');
        p.setSpeed(2.0);
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('hood') && st.serverTime > 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        const t0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 400));
        const t1 = p.getStatus().serverTime;
        const sp = p.getSpeed();
        p.setSpeed(1.0);
        return { ok, sp, dt: t1 - t0 };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "hood.dm_26"
    assert res["ok"] is True
    assert abs(res["sp"] - 2.0) < 0.05
    assert res["dt"] >= 450, f"Expected >= 450ms serverTime delta over 400ms at 2x speed, got {res}"


def t3_05_multi_demo_switch_combined_pk3_transfer_under_150mb(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F5 (Telemetry) x F6 (HTTP Range VFS) x F12 (Demo Switch)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.ensure_booted("out.dm_26")
    m = ctx.get_metrics()
    limit = 150 * 1024 * 1024
    assert m["pk3FullRequests"] == 0, f"Expected 0 full .pk3 requests: {m}"
    assert (
        0 < m["pk3BytesTransferred"] < limit
    ), f"Multi-demo cumulative .pk3 bytes {m['pk3BytesTransferred']:,} B exceeded 150 MB"


def t3_06_pause_canvas_screenshot_stability_then_resume_motion(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F4 (WebGL) x F9 (Pause/Resume) x F13 (Screenshot Verification)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.pause();")
    time.sleep(0.1)
    snap_paused_1 = ctx.capture_canvas_screenshot("t3_06_paused_1")
    time.sleep(0.35)
    snap_paused_2 = ctx.capture_canvas_screenshot("t3_06_paused_2")

    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.resume();")
    time.sleep(0.55)
    snap_resumed = ctx.capture_canvas_screenshot("t3_06_resumed")

    assert (
        snap_paused_1["status"]["serverTime"] == snap_paused_2["status"]["serverTime"]
    ), "serverTime changed while paused"
    assert (
        snap_resumed["status"]["serverTime"] > snap_paused_2["status"]["serverTime"]
    ), "serverTime did not advance after resume"
    diff_after_resume = ctx.compare_screenshots(snap_paused_2, snap_resumed)
    assert (
        diff_after_resume["mean_abs_diff"] > 0.2
    ), f"Canvas pixels did not change after resuming from pause: {diff_after_resume}"


def t3_07_high_speed_fast_forward_increases_visual_frame_delta(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F10 (Speed 4.0x) x F13 (3D Scene Screenshot Motion)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.setSpeed(4.0); p.resume();")
    snap_a = ctx.capture_canvas_screenshot("t3_07_fast_a")
    time.sleep(0.45)
    snap_b = ctx.capture_canvas_screenshot("t3_07_fast_b")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.setSpeed(1.0);")
    dt = snap_b["status"]["serverTime"] - snap_a["status"]["serverTime"]
    cmp_res = ctx.compare_screenshots(snap_a, snap_b)
    assert dt >= 800, f"Expected >= 800ms serverTime advance at 4.0x over 450ms, got {dt}"
    assert cmp_res["mean_abs_diff"] > 0.3, f"Expected visual change during 4x fast-forward: {cmp_res}"


def t3_08_url_query_params_combined_demo_speed_muted_boot(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F8 (Direct Boot / Config) x F10 (Speed) x F11 (Mute)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (typeof p.applyQueryConfig === 'function') {
          await p.applyQueryConfig('?demo=out.dm_26&speed=2.0&muted=1');
        } else {
          await p.loadDemo('out.dm_26');
          p.setSpeed(2.0);
          p.setMuted(true);
        }
        const st = p.getStatus();
        const out = {
          demoName: st.demoName,
          speed: p.getSpeed(),
          muted: p.isMuted(),
        };
        p.setSpeed(1.0);
        p.setMuted(false);
        return out;
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "out.dm_26"
    assert "out" in str(res["demoName"]).lower()
    assert abs(res["speed"] - 2.0) < 0.05
    assert res["muted"] is True


def t3_09_non_interactive_input_while_paused_and_playing_with_audio(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F7 (Non-Interactive Canvas) x F9 (Pause/Resume) x F11 (Audio)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.unmute();
        const canvas = document.getElementById('jk-canvas');
        const inp = document.createElement('input');
        document.body.appendChild(inp);

        // Click canvas while playing
        canvas.click();
        const plPlaying = document.pointerLockElement;

        // Pause and type into input
        p.pause();
        inp.focus();
        const ev = new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true });
        inp.dispatchEvent(ev);
        inp.value = 'test_while_paused';
        const plPaused = document.pointerLockElement;

        p.resume();
        const val = inp.value;
        inp.remove();
        return {
          plPlaying,
          plPaused,
          defaultPrevented: ev.defaultPrevented,
          val,
          audioActive: p.getStatus().audioActive,
        };
        """
    )
    assert res["plPlaying"] is None and res["plPaused"] is None
    assert res["defaultPrevented"] is False
    assert res["val"] == "test_while_paused"
    assert res["audioActive"] is True


def t3_10_fast_forward_to_demo_completion_fires_event_and_updates_status(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F10 (Fast-Forward Speed) x F12 (Demo Completion Event)."""
    res = ctx.run_short_demo_to_completion(packet_count=12)
    assert res["loadOk"] is True
    assert res["callbacksCount"] >= 1
    assert (
        res["afterStatus"].get("demoCompletedCount", 0)
        >= res["beforeStatus"].get("demoCompletedCount", 0)
    )


def t3_11_load_new_demo_after_demo_completion_resumes_cleanly(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F8 (Demo Playback) x F12 (Post-Completion Switch) x F13 (3D Rendering)."""
    st = ctx.ensure_booted("1.51ef9.dm_26")
    assert st.get("isPlaying") is True
    assert st.get("demoEnded") is False
    snap = ctx.capture_canvas_screenshot("t3_11_post_completion")
    assert snap["std_rgb"] > 10.0


def t3_12_manifest_demo_list_every_demo_servable_via_http_range_server(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F5 (Manifest & Demo Routes) x F8 (Demo Availability)."""
    ctx.ensure_server()
    st, _, body = ctx.http_request("GET", "/base/manifest.json")
    assert st == 200
    manifest = json.loads(body.decode("utf-8"))
    demos = manifest.get("demos") or []
    assert len(demos) >= 5, f"Expected >= 5 demos in manifest, got {demos}"
    for demo_entry in demos[:10]:
        dname = demo_entry["name"] if isinstance(demo_entry, dict) else str(demo_entry)
        st_head, hdr_head, _ = ctx.http_request("HEAD", f"/demos/{dname}")
        assert st_head == 200, f"Demo {dname} from manifest returned HTTP {st_head}"
        clen = int(hdr_head.get("content-length", "0"))
        assert clen > 100_000, f"Demo {dname} Content-Length too small: {clen}"


def t3_13_concurrent_range_requests_and_metrics_accuracy(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F5 (HTTP Range Server + Metrics) x F6 (Multi-Archive Range Fetching)."""
    ctx.ensure_server()
    ctx.reset_metrics()
    targets = [
        ("/base/assets0.pk3", "bytes=0-99", 100),
        ("/base/assets1.pk3", "bytes=0-199", 200),
        ("/base/assets2.pk3", "bytes=0-299", 300),
        ("/base/assets3.pk3", "bytes=0-399", 400),
        ("/base/ctf_kejim.pk3", "bytes=0-499", 500),
    ]

    def fetch_one(item):
        path, rng, expected_len = item
        st, _, body = ctx.http_request("GET", path, headers={"Range": rng})
        assert st == 206, f"Expected 206 on {path}, got {st}"
        assert len(body) == expected_len
        return len(body)

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        lengths = list(ex.map(fetch_one, targets))

    assert sum(lengths) == 1500
    m = ctx.get_metrics()
    assert m["pk3RangeRequests"] >= 5, f"Expected >= 5 range requests in metrics, got {m}"
    assert m["pk3BytesTransferred"] >= 1500, f"Expected >= 1500 bytes in metrics, got {m}"
    assert m["pk3FullRequests"] == 0


def t3_14_audio_mute_unmute_across_demo_switch_preserves_state(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F11 (Audio Mute/Volume) x F12 (Dynamic Demo Switch)."""
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.setVolume(0.45);
        p.mute();
        await p.loadDemo('out.dm_26');
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const st = p.getStatus();
          if (st.isPlaying && String(st.demoName).toLowerCase().includes('out') && st.serverTime > 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        const mutedAfterSwitch = p.isMuted();
        const volAfterSwitch = p.getVolume();
        p.unmute();
        const mutedAfterUnmute = p.isMuted();
        p.setVolume(0.8);
        return { mutedAfterSwitch, volAfterSwitch, mutedAfterUnmute };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "out.dm_26"
    assert res["mutedAfterSwitch"] is True, f"Mute state lost across demo switch: {res}"
    assert abs(res["volAfterSwitch"] - 0.45) < 0.03, f"Volume lost across demo switch: {res}"
    assert res["mutedAfterUnmute"] is False


def t3_15_main_loop_responsiveness_during_on_demand_pk3_map_load(
    ctx: E2ETestContext,
) -> None:
    """Pairwise F3 (Main Loop) x F6 (On-Demand HTTP Range Fetch) x F12 (Map Switch)."""
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const ok = await p.loadDemo('1.51ef9.dm_26');
        const f0 = p.getStatus().frameCount;
        await new Promise(r => setTimeout(r, 400));
        const st1 = p.getStatus();
        const c = document.getElementById('jk-canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        return {
          ok,
          df: st1.frameCount - f0,
          isPlaying: st1.isPlaying,
          glLost: gl.isContextLost(),
        };
        """,
        timeout=45.0,
    )
    ctx.current_boot_demo = "1.51ef9.dm_26"
    assert res["ok"] is True
    assert res["df"] > 0 and res["isPlaying"] is True
    assert res["glLost"] is False


def t3_16_native_and_wasm_coexistence_in_workspace(ctx: E2ETestContext) -> None:
    """Pairwise F1 (Native Linux Build) x F2 (Emscripten Wasm Build)."""
    native_bin = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    wasm_bin = ctx.build_wasm_dir / "codemp" / "openjk.wasm"
    web_wasm = ctx.web_dir / "openjk.wasm"
    assert native_bin.exists(), f"Missing {native_bin}"
    assert wasm_bin.exists(), f"Missing {wasm_bin}"
    assert web_wasm.exists(), f"Missing {web_wasm}"
    assert native_bin.read_bytes()[:4] == b"\x7fELF"
    assert web_wasm.read_bytes()[:4] == b"\x00asm"


def get_tier3_tests() -> List[TestCase]:
    return [
        TestCase("T3_01_pause_change_speed_while_paused_then_resume", 3, "F9,F10", "Pause playback, change timescale while paused, then resume without time-jump", t3_01_pause_change_speed_while_paused_then_resume),
        TestCase("T3_02_mute_change_volume_while_muted_then_unmute", 3, "F11", "Mute audio, adjust volume while muted, then unmute and verify volume & AudioContext", t3_02_mute_change_volume_while_muted_then_unmute),
        TestCase("T3_03_pause_switch_demo_auto_unpauses_and_plays", 3, "F9,F12", "Switch demo via loadDemo() while paused and verify automatic unpause and playback", t3_03_pause_switch_demo_auto_unpauses_and_plays),
        TestCase("T3_04_custom_speed_preserved_or_updated_across_demo_switch", 3, "F10,F12", "Verify 2.0x playback speed across dynamic demo switching", t3_04_custom_speed_preserved_or_updated_across_demo_switch),
        TestCase("T3_05_multi_demo_switch_combined_pk3_transfer_under_150mb", 3, "F5,F6,F12", "Verify switching across multiple demos keeps cumulative .pk3 HTTP transfer < 150 MB", t3_05_multi_demo_switch_combined_pk3_transfer_under_150mb),
        TestCase("T3_06_pause_canvas_screenshot_stability_then_resume_motion", 3, "F4,F9,F13", "Verify paused screenshots hold serverTime constant and resuming restores 3D pixel motion", t3_06_pause_canvas_screenshot_stability_then_resume_motion),
        TestCase("T3_07_high_speed_fast_forward_increases_visual_frame_delta", 3, "F10,F13", "Verify 4.0x fast-forward advances serverTime >= 800ms and changes 3D scene pixels", t3_07_high_speed_fast_forward_increases_visual_frame_delta),
        TestCase("T3_08_url_query_params_combined_demo_speed_muted_boot", 3, "F8,F10,F11", "Verify combined ?demo=out.dm_26&speed=2.0&muted=1 configuration", t3_08_url_query_params_combined_demo_speed_muted_boot),
        TestCase("T3_09_non_interactive_input_while_paused_and_playing_with_audio", 3, "F7,F9,F11", "Verify non-interactive canvas, host input, pause/resume, and active audio together", t3_09_non_interactive_input_while_paused_and_playing_with_audio),
        TestCase("T3_10_fast_forward_to_demo_completion_fires_event_and_updates_status", 3, "F10,F12", "Fast-forward demo to completion and verify onDemoComplete callback & status counter", t3_10_fast_forward_to_demo_completion_fires_event_and_updates_status),
        TestCase("T3_11_load_new_demo_after_demo_completion_resumes_cleanly", 3, "F8,F12,F13", "Load a new demo after CL_DemoCompleted and verify 3D WebGL playback resumes cleanly", t3_11_load_new_demo_after_demo_completion_resumes_cleanly),
        TestCase("T3_12_manifest_demo_list_every_demo_servable_via_http_range_server", 3, "F5,F6,F8", "Verify every .dm_26 demo listed in /base/manifest.json is servable via /demos/<name>", t3_12_manifest_demo_list_every_demo_servable_via_http_range_server),
        TestCase("T3_13_concurrent_range_requests_and_metrics_accuracy", 3, "F5,F6", "Execute 5 concurrent HTTP Range requests across all .pk3 archives and verify /api/metrics", t3_13_concurrent_range_requests_and_metrics_accuracy),
        TestCase("T3_14_audio_mute_unmute_across_demo_switch_preserves_state", 3, "F11,F12", "Verify mute and volume settings persist across dynamic loadDemo() map reloads", t3_14_audio_mute_unmute_across_demo_switch_preserves_state),
        TestCase("T3_15_main_loop_responsiveness_during_on_demand_pk3_map_load", 3, "F3,F6,F12", "Verify main loop and WebGL context survive Asyncify on-demand .pk3 map switching", t3_15_main_loop_responsiveness_during_on_demand_pk3_map_load),
        TestCase("T3_16_native_and_wasm_coexistence_in_workspace", 3, "F1,F2", "Verify native x86_64 ELF and Emscripten Wasm builds coexist cleanly in workspace", t3_16_native_and_wasm_coexistence_in_workspace),
    ]
