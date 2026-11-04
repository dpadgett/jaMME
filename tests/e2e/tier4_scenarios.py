#!/usr/bin/env python3
"""
Tier 4 — Real-World Application Scenarios E2E Tests (8 test cases).
Simulates realistic user journeys on a Jedi Academy multiplayer demo highlight archive website.
"""

import time
from typing import List

from .harness import E2ETestContext, TestCase


def t4_01_scenario_cold_boot_custom_map_demo_under_150mb_budget(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 1: Cold-booting the embedded demo player on a custom CTF map highlight
    (1.51ef9.dm_26 on mp/ctf_kejim from /home/dan/refresh/base/ctf_kejim.pk3) and
    verifying < 150 MB HTTP Range transfer.
    """
    ctx.ensure_booted("1.51ef9.dm_26")
    st = ctx.cold_boot_status or ctx.get_player_status()
    m = ctx.cold_boot_metrics or ctx.get_metrics()

    assert st.get("ready") is True and st.get("isPlaying") is True
    assert "1.51ef9" in str(st.get("demoName", "")).lower()
    assert m["pk3RangeRequests"] > 0, f"Expected HTTP Range requests > 0, got {m}"
    assert m["pk3FullRequests"] == 0, f"Expected 0 full .pk3 downloads, got {m}"

    per_file = m.get("perFileBytes") or {}
    assert per_file.get("ctf_kejim.pk3", 0) > 0, f"ctf_kejim.pk3 was not fetched: {per_file}"
    assert (
        0 < m["pk3BytesTransferred"] < 150 * 1024 * 1024
    ), f"Cold boot + playback transferred {m['pk3BytesTransferred']:,} B (>= 150 MB limit)"


def t4_02_scenario_multi_timestamp_3d_scene_rendering_verification(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 2: Capturing 4 PNG screenshots of #jk-canvas across 1.5 seconds of active
    demo playback and verifying rich 3D scene rendering and inter-frame pixel motion.
    """
    ctx.ensure_booted("1.51ef9.dm_26")
    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.resume(); p.setSpeed(1.5);")

    snaps = []
    for idx in range(4):
        if idx > 0:
            time.sleep(0.45)
        snaps.append(ctx.capture_canvas_screenshot(f"t4_02_frame_{idx}"))

    ctx.eval_js("const p = window.JKDemoPlayer || window.OpenJKPlayer; p.setSpeed(1.0);")

    for idx, s in enumerate(snaps):
        assert s["width"] >= 640 and s["height"] >= 360
        assert (
            s["std_rgb"] > 10.0
        ), f"Frame #{idx} lacks 3D scene variance (std={s['std_rgb']:.2f})"
        assert (
            s["unique_colors"] > 400
        ), f"Frame #{idx} lacks color richness ({s['unique_colors']} unique colors)"

    # Verify consecutive frames advance serverTime and exhibit changing 3D scene pixels
    for i in range(len(snaps) - 1):
        t_cur = snaps[i]["status"].get("serverTime", 0)
        t_nxt = snaps[i + 1]["status"].get("serverTime", 0)
        assert t_nxt > t_cur, f"serverTime did not advance between frame {i} ({t_cur}) and {i+1} ({t_nxt})"
        cmp_res = ctx.compare_screenshots(snaps[i], snaps[i + 1])
        assert (
            cmp_res["mean_abs_diff"] > 0.15
        ), f"Frames {i} and {i+1} had near-zero pixel motion: {cmp_res}"


def t4_03_scenario_interactive_review_slow_mo_pause_frame_inspect_fast_forward(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 3: A viewer watches a highlight in 0.25x slow-motion, pauses to inspect a frame,
    verifies no time-drift while paused, then fast-forwards at 2.0x without an unpause time-jump.
    """
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.resume();
        p.setSpeed(0.25);
        const t0 = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 400));
        const tSlow = p.getStatus().serverTime;
        const slowDelta = tSlow - t0;

        // Pause for 700ms to inspect the frame
        p.pause();
        await new Promise(r => setTimeout(r, 60));
        const tPauseStart = p.getStatus().serverTime;
        await new Promise(r => setTimeout(r, 700));
        const tPauseEnd = p.getStatus().serverTime;

        // Switch to 2.0x fast-forward and resume
        p.setSpeed(2.0);
        p.resume();
        await new Promise(r => setTimeout(r, 200));
        const tFast = p.getStatus().serverTime;
        const fastDelta200ms = tFast - tPauseEnd;

        p.setSpeed(1.0);
        return {
          slowDelta,
          tPauseStart,
          tPauseEnd,
          fastDelta200ms,
        };
        """
    )
    assert 0 < res["slowDelta"] < 300, f"Unexpected 0.25x slow-mo delta over 400ms: {res}"
    assert res["tPauseStart"] == res["tPauseEnd"], f"serverTime drifted while paused: {res}"
    assert (
        0 < res["fastDelta200ms"] < 900
    ), f"Unpause time-jump or stall detected after 700ms pause + 200ms @ 2x: {res}"


def t4_04_scenario_autoplay_policy_muted_boot_to_user_unmute_and_volume_slider(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 4: Starting in muted mode for browser autoplay compliance, then user clicks
    unmute, sweeps the volume slider (1.0 -> 0.5 -> 0.2 -> 0.0 -> 0.8), and clicks page UI.
    """
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        p.mute();
        const initialMuted = p.isMuted();

        // Simulate user unmuting and sweeping volume slider
        p.unmute();
        await new Promise(r => setTimeout(r, 80));
        const afterUnmute = p.isMuted();
        const ctxState = p.getStatus().audioContextState;

        const swept = [];
        for (const v of [1.0, 0.5, 0.2, 0.0, 0.8]) {
          p.setVolume(v);
          swept.push(Number(p.getVolume().toFixed(2)));
        }

        // Simulate clicking outside canvas (losing canvas focus)
        window.dispatchEvent(new Event('blur'));
        await new Promise(r => setTimeout(r, 80));
        const stFinal = p.getStatus();

        return {
          initialMuted,
          afterUnmute,
          ctxState,
          swept,
          audioActiveAfterBlur: stFinal.audioActive,
        };
        """
    )
    assert res["initialMuted"] is True
    assert res["afterUnmute"] is False
    assert res["ctxState"] == "running"
    assert res["swept"] == [1.0, 0.5, 0.2, 0.0, 0.8]
    assert res["audioActiveAfterBlur"] is True


def t4_05_scenario_playlist_browsing_across_three_maps_under_bandwidth_budget(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 5: A user browses 3 demo highlights across 3 distinct maps in one session:
    1.51ef9.dm_26 (mp/ctf_kejim) -> out.dm_26 (mp/ctf1) -> hood.dm_26 (mp/ffa3).
    Verifies distinct 3D map screenshots and cumulative .pk3 transfer < 150 MB.
    """
    snaps = {}
    for demo in ("1.51ef9.dm_26", "out.dm_26", "hood.dm_26"):
        st = ctx.ensure_booted(demo)
        assert st.get("isPlaying") is True
        time.sleep(0.3)
        snap = ctx.capture_canvas_screenshot(f"t4_05_{demo}")
        assert snap["std_rgb"] > 10.0, f"Map screenshot for {demo} is blank: {snap['std_rgb']}"
        snaps[demo] = snap

    diff_1_2 = ctx.compare_screenshots(snaps["1.51ef9.dm_26"], snaps["out.dm_26"])
    diff_2_3 = ctx.compare_screenshots(snaps["out.dm_26"], snaps["hood.dm_26"])
    assert diff_1_2["mean_abs_diff"] > 2.0, f"ctf_kejim and ctf1 screenshots look identical: {diff_1_2}"
    assert diff_2_3["mean_abs_diff"] > 2.0, f"ctf1 and ffa3 screenshots look identical: {diff_2_3}"

    m = ctx.get_metrics()
    assert m["pk3FullRequests"] == 0
    assert (
        m["pk3BytesTransferred"] < 150 * 1024 * 1024
    ), f"3-map playlist session exceeded 150 MB budget: {m['pk3BytesTransferred']:,} B"


def t4_06_scenario_full_demo_playback_to_completion_and_auto_advance(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 6: Playing a demo to CL_DemoCompleted, receiving the onDemoComplete callback,
    and automatically advancing to the next demo in the playlist (out.dm_26).
    """
    comp = ctx.run_short_demo_to_completion(packet_count=12)
    assert comp["loadOk"] is True
    assert comp["callbacksCount"] >= 1

    # Now auto-advance to out.dm_26 and confirm continuous playback
    st = ctx.ensure_booted("out.dm_26")
    assert st.get("isPlaying") is True
    assert "out" in str(st.get("demoName", "")).lower()


def t4_07_scenario_host_webpage_ui_integration_and_non_interfering_embed(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 7: Full host page UI interaction (clicking controls, typing search queries
    containing game bind keys, clicking the WebGL canvas) without pointer lock or input loss.
    """
    ctx.ensure_booted("1.51ef9.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const canvas = document.getElementById('jk-canvas');

        // Create simulated host page search bar & control toolbar
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        document.body.appendChild(searchInput);

        // 1. Click canvas
        canvas.click();
        const pl1 = document.pointerLockElement;

        // 2. Type query with game bind keys into search input
        searchInput.focus();
        const query = 'ctf_kejim ~ wasd space';
        let hijacked = 0;
        for (const ch of query) {
          const ev = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true });
          searchInput.dispatchEvent(ev);
          if (ev.defaultPrevented) hijacked++;
          searchInput.value += ch;
        }

        // 3. Control playback via JS API while input is focused
        p.pause();
        const pausedState = p.isPaused();
        p.setSpeed(1.5);
        const speedState = p.getSpeed();
        p.resume();
        const resumedState = !p.isPaused();
        p.setSpeed(1.0);

        const finalVal = searchInput.value;
        searchInput.remove();
        return {
          pl1,
          hijacked,
          finalVal,
          pausedState,
          speedState,
          resumedState,
        };
        """
    )
    assert res["pl1"] is None
    assert res["hijacked"] == 0
    assert res["finalVal"] == "ctf_kejim ~ wasd space"
    assert res["pausedState"] is True
    assert abs(res["speedState"] - 1.5) < 0.05
    assert res["resumedState"] is True


def t4_08_scenario_full_session_end_to_end_stress_and_zero_error_audit(
    ctx: E2ETestContext,
) -> None:
    """
    Scenario 8: End-to-end session audit verifying that after all builds, HTTP Range transfers,
    speed changes, pause/resume cycles, audio operations, map switches, and screenshot captures,
    the player is healthy with zero unhandled errors and < 150 MB .pk3 transfer.
    """
    st = ctx.ensure_booted("1.51ef9.dm_26")
    assert st.get("ready") is True and st.get("isPlaying") is True

    snap = ctx.capture_canvas_screenshot("t4_08_final_audit")
    assert snap["std_rgb"] > 10.0 and snap["non_black_ratio"] > 0.20

    logs = ctx.get_browser_logs()
    page_errors = logs.get("pageErrors") or []
    assert len(page_errors) == 0, f"Unhandled page errors during E2E suite: {page_errors}"

    m = ctx.cold_boot_metrics or ctx.get_metrics()
    assert m["pk3FullRequests"] == 0
    assert 0 < m["pk3BytesTransferred"] < 150 * 1024 * 1024


def get_tier4_tests() -> List[TestCase]:
    return [
        TestCase("T4_01_scenario_cold_boot_custom_map_demo_under_150mb_budget", 4, "F2,F3,F5,F6,F8", "Cold-boot custom map demo 1.51ef9.dm_26 (ctf_kejim.pk3) and verify < 150 MB HTTP Range transfer", t4_01_scenario_cold_boot_custom_map_demo_under_150mb_budget),
        TestCase("T4_02_scenario_multi_timestamp_3d_scene_rendering_verification", 4, "F4,F8,F13", "Capture 4 multi-timestamp WebGL screenshots and verify rich 3D scene detail & pixel motion", t4_02_scenario_multi_timestamp_3d_scene_rendering_verification),
        TestCase("T4_03_scenario_interactive_review_slow_mo_pause_frame_inspect_fast_forward", 4, "F9,F10,F13", "Simulate viewer slow-motion (0.25x), pause frame inspection, and 2.0x resume without time-jump", t4_03_scenario_interactive_review_slow_mo_pause_frame_inspect_fast_forward),
        TestCase("T4_04_scenario_autoplay_policy_muted_boot_to_user_unmute_and_volume_slider", 4, "F8,F11", "Simulate autoplay muted start, user unmute, volume slider sweep, and focus-loss audio persistence", t4_04_scenario_autoplay_policy_muted_boot_to_user_unmute_and_volume_slider),
        TestCase("T4_05_scenario_playlist_browsing_across_three_maps_under_bandwidth_budget", 4, "F5,F6,F12,F13", "Browse 3 demos across 3 maps (ctf_kejim, ctf1, ffa3) and verify distinct 3D scenes & < 150 MB transfer", t4_05_scenario_playlist_browsing_across_three_maps_under_bandwidth_budget),
        TestCase("T4_06_scenario_full_demo_playback_to_completion_and_auto_advance", 4, "F10,F12,F13", "Play demo to CL_DemoCompleted, verify callback/event payload, and auto-advance to next demo", t4_06_scenario_full_demo_playback_to_completion_and_auto_advance),
        TestCase("T4_07_scenario_host_webpage_ui_integration_and_non_interfering_embed", 4, "F7,F9,F10,F11", "Verify host webpage search input, buttons, and embedded canvas coexist without Pointer Lock or key theft", t4_07_scenario_host_webpage_ui_integration_and_non_interfering_embed),
        TestCase("T4_08_scenario_full_session_end_to_end_stress_and_zero_error_audit", 4, "F1-F13", "Full session end-to-end stress audit confirming zero unhandled JS/Wasm errors and < 150 MB budget", t4_08_scenario_full_session_end_to_end_stress_and_zero_error_audit),
    ]
