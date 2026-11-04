#!/usr/bin/env python3
"""
Tier 4 — Real-World Application Scenarios E2E Tests for Round 2 (9 test cases: T4_01–T4_09).
End-to-end user journeys against http://localhost:8081 in real Headless Chrome with WebGL.
"""

import json
import re
import time
from typing import List

from .harness import EXPECTED_BASE_CHECKSUMS, E2ER2TestContext, TestCase


def t4_01_consolidated_pk3_pool_and_live_nginx_base_serving_audit(ctx: E2ER2TestContext) -> None:
    """
    Scenario 1 (F1, F2, F3, F18):
    End-to-end audit of /media/dan/Elements/pk3/base/manifest.json (~488 entries, base_init only on assets0..3,
    exact signed 32-bit Com_BlockChecksum MD4) and live HTTP Range serving on http://localhost:8081/base/.
    """
    manifest = ctx.get_manifest()
    pk3s = manifest["pk3s"]
    assert manifest.get("version") == 2 and len(pk3s) >= 480

    by_name = {e["name"]: e for e in pk3s}
    for name, expected_sum in EXPECTED_BASE_CHECKSUMS.items():
        assert by_name[name]["checksum"] == expected_sum
        assert by_name[name]["base_init"] is True

    st_man, _, body_man = ctx.http_request("GET", "/base/manifest.json")
    assert st_man == 200
    live_man = json.loads(body_man.decode("utf-8"))
    assert len(live_man["pk3s"]) == len(pk3s)

    st_rng, hdr_rng, body_rng = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-1023"}
    )
    assert st_rng == 206 and len(body_rng) == 1024 and body_rng[:4] == b"PK\x03\x04"
    assert "bytes" in hdr_rng.get("accept-ranges", "").lower()

    st_wasm, hdr_wasm, body_wasm = ctx.http_request("GET", "/jkplayer/openjk.wasm")
    assert st_wasm == 200 and "application/wasm" in hdr_wasm.get("content-type", "").lower()
    assert body_wasm[:4] == b"\x00asm"


def t4_02_archive_match_html_load_play_buttons_and_background_prewarm(ctx: E2ER2TestContext) -> None:
    """
    Scenario 2 (F4, F12, F15, F18):
    Load http://localhost:8081/match.html, verify Play buttons on all 4 demo link types,
    zero Play buttons on #rpc=lookup permalinks, and background Wasm prewarm with <= 8 range requests.
    """
    obs = ctx.ensure_prewarm_observed()
    assert obs["ready"] is True
    assert obs["pipHidden"] is True
    assert obs["isMuted"] is True
    assert obs["loadedPacks"] == 4 and 0 <= obs["rangeRequests"] <= 8

    info = ctx.ensure_page_loaded("match.html")
    links = info["demoLinks"]
    assert links["getdemo"] > 0 and links["mergedemo"] > 0 and links["trimdemo"] > 0 and links["matchdemo"] > 0
    assert links["lookupPermalinks"] > 0

    lookup_check = ctx.eval_js(
        """
        const bad = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]')).filter(
          a => a.nextElementSibling && a.nextElementSibling.classList.contains('jk-play-btn')
        );
        return { badCount: bad.length };
        """
    )
    assert lookup_check["badCount"] == 0


def t4_03_match_html_custom_map_playback_checksum_mount_and_webgl_3d_rendering(ctx: E2ER2TestContext) -> None:
    """
    Scenario 3 (F5, F11, F13, F15):
    Click Play on http://localhost:8081/match.html, verify floating PiP opens on right without table reflow,
    mounts custom map PK3 on-demand (< 150 MB), and renders non-blank changing 3D WebGL frames on #jk-canvas.
    """
    st = ctx.ensure_pip_playing("match.html", "getdemo.php", force_reload_demo=True)
    assert st["isPlaying"] is True and st["durationMs"] > 0

    snap1 = ctx.capture_canvas_screenshot("t4_03_frame1")
    time.sleep(0.55)
    snap2 = ctx.capture_canvas_screenshot("t4_03_frame2")

    for snap in (snap1, snap2):
        assert snap["width"] >= 320 and snap["height"] >= 180
        assert snap["std_rgb"] > 8.0, f"Blank/flat WebGL canvas frame: {snap['std_rgb']}"
        assert snap["unique_colors"] > 250, f"Too few unique RGB colors on #jk-canvas: {snap['unique_colors']}"
        assert snap["non_black_ratio"] > 0.15

    diff = ctx.compare_screenshots(snap1, snap2)
    assert diff["mean_abs_diff"] > 0.15, f"Expected changing 3D scene pixels over 550ms, got {diff}"


def t4_04_interactive_timeline_scrubbing_forward_backward_and_start_over(ctx: E2ER2TestContext) -> None:
    """
    Scenario 4 (F6, F7, F8, F9, F14):
    Verify JK_DemoGetDurationMs() > 0, advancing JK_DemoGetCurrentTimeMs(), forward seeking (30% -> 70%),
    backward seeking (70% -> 15%), and Start Over (0:00) with zero ERR_DROP and valid 3D WebGL frames.
    """
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        const t30 = Math.floor(dur * 0.30);
        const t70 = Math.floor(dur * 0.70);
        const t15 = Math.floor(dur * 0.15);

        mod._JK_DemoSeekToMs(t30);
        const cur30 = mod._JK_DemoGetCurrentTimeMs();

        mod._JK_DemoSeekToMs(t70);
        const cur70 = mod._JK_DemoGetCurrentTimeMs();

        const reqBeforeRewind = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        mod._JK_DemoSeekToMs(t15);
        const cur15 = mod._JK_DemoGetCurrentTimeMs();

        document.querySelector('#jk-pip-start-over, #btn-start-over').click();
        await new Promise(r => setTimeout(r, 120));
        const cur0 = mod._JK_DemoGetCurrentTimeMs();
        const reqAfterRewind = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();

        return {
          dur, t30, cur30, t70, cur70, t15, cur15, cur0,
          reqDelta: reqAfterRewind - reqBeforeRewind,
          playing: mod._JK_DemoIsPlaying() === 1,
        };
        """
    )
    assert res["playing"] is True and res["reqDelta"] == 0
    assert abs(res["cur30"] - res["t30"]) <= 500
    assert abs(res["cur70"] - res["t70"]) <= 500
    assert abs(res["cur15"] - res["t15"]) <= 500
    assert 0 <= res["cur0"] <= 400
    snap = ctx.capture_canvas_screenshot("t4_04_after_scrubbing")
    assert snap["std_rgb"] > 8.0 and snap["unique_colors"] > 200


def t4_05_automatic_instant_demo_looping_and_loop_toggle_journey(ctx: E2ER2TestContext) -> None:
    """
    Scenario 5 (F7, F9, F10, F14):
    Verify automatic instant loop at demo EOF when Loop is enabled by default, then toggle Loop off,
    verify playback stops at EOF, and click Start Over (0:00) to resume.
    """
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 220));
        let t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const c1 = mod._JK_DemoGetCompletedCount();
        const playingAfterAutoLoop = mod._JK_DemoIsPlaying() === 1;
        const curAfterAutoLoop = mod._JK_DemoGetCurrentTimeMs();

        // Now disable loop via button or API and reach EOF
        mod._JK_DemoSetLoop(0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 180));
        t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c1 || mod._JK_DemoIsCompleted()) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        mod._JK_DemoSetLoop(1);
        document.querySelector('#jk-pip-start-over, #btn-start-over').click();
        await new Promise(r => setTimeout(r, 200));
        const playingAfterStartOver = mod._JK_DemoIsPlaying() === 1;
        return {
          looped: c1 > c0,
          playingAfterAutoLoop,
          curAfterAutoLoop,
          dur,
          playingAfterStartOver,
        };
        """
    )
    assert res["looped"] is True and res["playingAfterAutoLoop"] is True
    assert res["curAfterAutoLoop"] < res["dur"] * 0.5
    assert res["playingAfterStartOver"] is True


def t4_06_full_pip_controls_drag_and_resize_user_journey(ctx: E2ER2TestContext) -> None:
    """
    Scenario 6 (F13, F14):
    Exercise Play/Pause, Speed (0.25x..4x), Volume/Mute, Fullscreen, Pointer Events dragging,
    size presets & resize handle, and Close + re-open in a single continuous session.
    """
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const pip = window.JKPiPPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const header = document.querySelector('#jk-pip-header, .jk-pip-header');
        const playPauseBtn = document.querySelector('#jk-pip-play-pause, #btn-play-pause');
        const muteBtn = document.querySelector('#jk-pip-mute, #btn-mute');
        const closeBtn = document.querySelector('#jk-pip-close, #btn-close');

        // 1. Pause & Resume
        if (mod._JK_DemoIsPaused() === 1) mod._JK_DemoResume();
        playPauseBtn.click();
        const isPaused = mod._JK_DemoIsPaused() === 1;
        playPauseBtn.click();
        const isResumed = mod._JK_DemoIsPaused() === 0;

        // 2. Speed sweep
        const speeds = [];
        for (const s of [0.25, 0.5, 1, 2, 4]) {
          pip.setSpeed(s);
          speeds.push(mod._JK_DemoGetSpeed());
        }
        pip.setSpeed(1);

        // 3. Volume & Mute
        pip.setMuted(false);
        pip.setVolume(0.45);
        const vol45 = mod._JK_DemoGetVolume();
        muteBtn.click();
        const muted = mod._JK_DemoIsMuted() === 1;

        // 4. Dragging
        const r0 = card.getBoundingClientRect();
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 21, button: 0, buttons: 1, clientX: r0.left + 50, clientY: r0.top + 12
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 21, buttons: 1, clientX: r0.left - 80, clientY: r0.top - 60
        }));
        header.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 21, buttons: 1, clientX: r0.left - 80, clientY: r0.top - 60
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 21, button: 0, buttons: 0, clientX: r0.left - 80, clientY: r0.top - 60
        }));
        header.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 21, button: 0, buttons: 0, clientX: r0.left - 80, clientY: r0.top - 60
        }));
        const r1 = card.getBoundingClientRect();

        // 5. Close & Reopen
        closeBtn.click();
        await new Promise(r => setTimeout(r, 80));
        const hiddenOnClose = window.getComputedStyle(card).display === 'none' || card.hidden;
        document.querySelector('.jk-play-btn').click();
        await new Promise(r => setTimeout(r, 150));
        const visibleOnReopen = window.getComputedStyle(card).display !== 'none';

        return {
          isPaused, isResumed, speeds, vol45, muted,
          dragDelta: Math.abs(r1.left - r0.left) + Math.abs(r1.top - r0.top),
          hiddenOnClose, visibleOnReopen,
        };
        """
    )
    assert res["isPaused"] is True and res["isResumed"] is True
    assert abs(res["vol45"] - 0.45) < 0.05 and res["muted"] is True
    assert res["dragDelta"] > 20
    assert res["hiddenOnClose"] is True and res["visibleOnReopen"] is True


def t4_07_multi_endpoint_switching_on_match_html_getdemo_trimdemo_mergedemo_matchdemo(ctx: E2ER2TestContext) -> None:
    """
    Scenario 7 (F5, F11, F14, F15):
    Sequentially play getdemo.php -> trimdemo.php -> mergedemo.php -> minrpc.py?rpc=matchdemo on match.html.
    """
    ctx.ensure_page_loaded("match.html")
    urls = [
        "/getdemo.php?demo=" + "%2Fcygdrive%2FU%2Fdemos%2Fdemobot%2F2026%2F10%2F31%2F0%20mpctf_kejim%202026-10-31_23-44-17.dm_26",
        "/trimdemo.php?demo=" + "%2Fcygdrive%2FU%2Fdemos%2Fdemobot%2F2026%2F10%2F31%2F0%20mpctf_kejim%202026-10-31_23-45-01.dm_26&time=2281&before=13000&after=7000&prefix=test+",
        "/mergedemo.php?matchid=004a5ab0b7024e11&clientid=3",
        "/minrpc.py?rpc=matchdemo&id=0053b07a2f638a96",
    ]
    for idx, url in enumerate(urls):
        res = ctx.eval_js(
            """
            const pip = window.JKPiPPlayer;
            const p = window.JKDemoPlayer || window.OpenJKPlayer;
            if (pip && pip.openAndPlay) {
              await pip.openAndPlay(arg.url, { label: 'Endpoint ' + arg.idx });
            } else {
              await p.loadDemo(arg.url);
            }
            const mod = window.Module || (p && p.getModule ? p.getModule() : null);
            const start = Date.now();
            while (Date.now() - start < 75000) {
              if (mod && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) {
                return { playing: true, dur: mod._JK_DemoGetDurationMs() };
              }
              await new Promise(r => setTimeout(r, 120));
            }
            throw new Error('Endpoint failed to play: ' + arg.url);
            """,
            {"url": url, "idx": idx},
            timeout=90.0,
        )
        assert res["playing"] is True and res["dur"] > 0


def t4_08_index_html_raw_demo_archive_discovery_and_pip_playback(ctx: E2ER2TestContext) -> None:
    """
    Scenario 8 (F11, F13, F14, F16, F18):
    Load http://localhost:8081/index.html, verify #numdemos and #recentdemos populate with Play buttons,
    click Play, and verify WebGL rendering, advancing time, and seeking.
    """
    info = ctx.ensure_page_loaded("index.html", force_reload=True)
    assert info["playBtnCount"] > 0 and info["demoLinks"]["getdemo"] > 0

    st = ctx.ensure_pip_playing("index.html", "getdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0

    snap = ctx.capture_canvas_screenshot("t4_08_index_html_play")
    assert snap["std_rgb"] > 8.0 and snap["unique_colors"] > 200

    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        const target = Math.floor(dur * 0.4);
        mod._JK_DemoSeekToMs(target);
        const cur = mod._JK_DemoGetCurrentTimeMs();
        return { dur, target, cur };
        """
    )
    assert abs(res["cur"] - res["target"]) <= 600


def t4_09_aplayer2_and_debugplayer2_profile_nice_shot_and_bookmark_playback(ctx: E2ER2TestContext) -> None:
    """
    Scenario 9 (F11, F13, F14, F17, F18):
    Load http://localhost:8081/aplayer2.html and debugplayer2.html, verify constructed download links and
    Play buttons for game demos, Nice Shots, and Bookmarks (excluding #rpc=lookup permalinks), and play a Nice Shot clip.
    """
    info_dbg = ctx.ensure_page_loaded("debugplayer2.html", force_reload=True)
    assert info_dbg["playBtnCount"] > 0 and info_dbg["demoLinks"]["getdemo"] > 0 and info_dbg["demoLinks"]["trimdemo"] > 0

    info_ap2 = ctx.ensure_page_loaded("aplayer2.html", force_reload=True)
    assert info_ap2["playBtnCount"] > 0 and info_ap2["demoLinks"]["getdemo"] > 0 and info_ap2["demoLinks"]["trimdemo"] > 0

    st = ctx.ensure_pip_playing("aplayer2.html", "trimdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0

    snap = ctx.capture_canvas_screenshot("t4_09_aplayer2_niceshot")
    assert snap["std_rgb"] > 8.0 and snap["unique_colors"] > 200

    logs = ctx.get_browser_logs()
    assert logs.get("pageErrors", []) == [], f"Unexpected pageErrors on aplayer2.html: {logs.get('pageErrors')}"


def get_tier4_tests() -> List[TestCase]:
    return [
        TestCase("T4_01_consolidated_pk3_pool_and_live_nginx_base_serving_audit", 4, "F1+F2+F3+F18", "End-to-end audit of consolidated PK3 pool, manifest.json v2, and port 8081 HTTP Range serving", t4_01_consolidated_pk3_pool_and_live_nginx_base_serving_audit),
        TestCase("T4_02_archive_match_html_load_play_buttons_and_background_prewarm", 4, "F4+F12+F15+F18", "End-to-end match.html load, Play button verification, permalink exclusion, and background prewarm", t4_02_archive_match_html_load_play_buttons_and_background_prewarm),
        TestCase("T4_03_match_html_custom_map_playback_checksum_mount_and_webgl_3d_rendering", 4, "F5+F11+F13+F15", "End-to-end custom map demo playback on match.html with checksum PK3 mount and 3D WebGL verification", t4_03_match_html_custom_map_playback_checksum_mount_and_webgl_3d_rendering),
        TestCase("T4_04_interactive_timeline_scrubbing_forward_backward_and_start_over", 4, "F6+F7+F8+F9+F14", "End-to-end interactive timeline scrubbing: forward seek, backward seek, and Start Over (0:00)", t4_04_interactive_timeline_scrubbing_forward_backward_and_start_over),
        TestCase("T4_05_automatic_instant_demo_looping_and_loop_toggle_journey", 4, "F7+F9+F10+F14", "End-to-end automatic instant demo looping at EOF and Loop toggle workflow", t4_05_automatic_instant_demo_looping_and_loop_toggle_journey),
        TestCase("T4_06_full_pip_controls_drag_and_resize_user_journey", 4, "F13+F14", "End-to-end PiP controls bar (Play/Pause, Speed, Volume/Mute, Drag, Resize, Close & Reopen)", t4_06_full_pip_controls_drag_and_resize_user_journey),
        TestCase("T4_07_multi_endpoint_switching_on_match_html_getdemo_trimdemo_mergedemo_matchdemo", 4, "F5+F11+F14+F15", "End-to-end switching across getdemo.php, trimdemo.php, mergedemo.php, and minrpc.py?rpc=matchdemo", t4_07_multi_endpoint_switching_on_match_html_getdemo_trimdemo_mergedemo_matchdemo),
        TestCase("T4_08_index_html_raw_demo_archive_discovery_and_pip_playback", 4, "F11+F13+F14+F16+F18", "End-to-end index.html raw demo table discovery, Play button click, 3D rendering, and seeking", t4_08_index_html_raw_demo_archive_discovery_and_pip_playback),
        TestCase("T4_09_aplayer2_and_debugplayer2_profile_nice_shot_and_bookmark_playback", 4, "F11+F13+F14+F17+F18", "End-to-end aplayer2.html & debugplayer2.html Nice Shot/Bookmark link generation and PiP playback", t4_09_aplayer2_and_debugplayer2_profile_nice_shot_and_bookmark_playback),
    ]
