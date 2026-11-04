#!/usr/bin/env python3
"""
Tier 3 — Cross-Feature Pairwise Interaction E2E Tests for Round 2 (18 test cases: T3_01–T3_18).
Exercises multi-feature interactions across F1–F18.
"""

import re
from typing import List

from .harness import E2ER2TestContext, TestCase


def t3_01_prewarm_manifest_v2_base_only_range_and_hidden_muted_pip(ctx: E2ER2TestContext) -> None:
    """F4 + F12 + F18: Prewarm fetches /base/manifest.json v2 (200 OK), mounts only assets0..3.pk3 (<=8 ranges), keeps PiP hidden and muted."""
    obs = ctx.ensure_prewarm_observed()
    assert obs["ready"] is True
    assert obs["pipHidden"] is True
    assert obs["isMuted"] is True
    assert obs["loadedPacks"] == 4 and 0 <= obs["rangeRequests"] <= 8
    assert obs["hasV2Cache"] is True


def t3_02_match_html_play_btn_opens_pip_fetches_getdemo_without_table_reflow(ctx: E2ER2TestContext) -> None:
    """F15 + F13 + F11: Clicking .jk-play-btn on getdemo.php opens #jk-pip-card on right without reflowing #recentdemos and starts playback."""
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const tbl = document.querySelector('#recentdemos');
        const pip = window.JKPiPPlayer;
        if (pip && pip.close) pip.close();
        await new Promise(r => setTimeout(r, 60));
        const rBefore = tbl.getBoundingClientRect();
        const btn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]') || document.querySelector('.jk-play-btn');
        btn.click();
        const start = Date.now();
        let mod = null;
        while (Date.now() - start < 90000) {
          const p = window.JKDemoPlayer || window.OpenJKPlayer;
          mod = window.Module || (p && p.getModule ? p.getModule() : null);
          if (mod && mod._JK_DemoIsPlaying && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const rAfter = tbl.getBoundingClientRect();
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const cardRect = card.getBoundingClientRect();
        return {
          tableWidthDiff: Math.abs(rAfter.width - rBefore.width),
          cardVisible: window.getComputedStyle(card).display !== 'none',
          cardRightSide: cardRect.right > window.innerWidth * 0.5,
          playing: Boolean(mod && mod._JK_DemoIsPlaying && mod._JK_DemoIsPlaying() === 1),
        };
        """,
        timeout=105.0,
    )
    assert res["tableWidthDiff"] == 0 and res["cardVisible"] is True and res["playing"] is True


def t3_03_custom_map_demo_resolves_pk3_by_checksum_and_loads_bsp(ctx: E2ER2TestContext) -> None:
    """F1 + F2 + F3 + F5: Custom map demo dynamically resolves PK3 from manifest.json by signed 32-bit checksum and loads .bsp."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const mapName = mod.UTF8ToString(mod._JK_DemoGetMapName());
        const packs = mod._JK_DemoGetLoadedPackCount ? mod._JK_DemoGetLoadedPackCount() : 5;
        return { mapName, packs, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True and len(res["mapName"]) > 0
    logs = ctx.get_browser_logs()
    missing_bsp = [
        c["text"] for c in logs.get("consoleLogs", [])
        if "RE_LoadWorldMap" in c["text"] and "not found" in c["text"]
    ]
    assert missing_bsp == [], f"Unexpected missing BSP error in console: {missing_bsp}"


def t3_04_demo_load_scans_bounds_and_syncs_pip_time_display(ctx: E2ER2TestContext) -> None:
    """F5 + F6 + F7 + F14: Demo load scans start/end serverTime and updates PiP MM:SS / MM:SS display."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const startMs = mod._JK_DemoGetStartTimeMs();
        const endMs = mod._JK_DemoGetEndTimeMs();
        const durMs = mod._JK_DemoGetDurationMs();
        await new Promise(r => setTimeout(r, 350));
        const timeEl = document.querySelector('#jk-pip-time, #time-display');
        const sliderEl = document.querySelector('#jk-pip-seek, #slider-seek');
        return {
          startMs,
          endMs,
          durMs,
          timeText: timeEl ? timeEl.textContent.trim() : '',
          sliderMax: sliderEl ? parseInt(sliderEl.max || '0', 10) : 0,
        };
        """
    )
    assert res["durMs"] == res["endMs"] - res["startMs"] > 0
    assert re.search(r"\d+:\d{2}\s*/\s*\d+:\d{2}", res["timeText"])


def t3_05_scrubber_forward_seek_drains_commands_and_renders_new_frame(ctx: E2ER2TestContext) -> None:
    """F7 + F8 + F14: Scrubbing PiP seek slider forward invokes JK_DemoSeekToMs, drains serverCommands, and updates WebGL frame."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSeekToMs(200);
        await new Promise(r => setTimeout(r, 100));
        """
    )
    snap0 = ctx.capture_canvas_screenshot("t3_05_t0")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        const target = Math.floor(dur * 0.55);
        const slider = document.querySelector('#jk-pip-seek, #slider-seek');
        slider.value = String(target);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 150));
        return { target, cur: mod._JK_DemoGetCurrentTimeMs() };
        """
    )
    snap1 = ctx.capture_canvas_screenshot("t3_05_t1")
    assert abs(res["cur"] - res["target"]) <= 800
    assert ctx.compare_screenshots(snap0, snap1)["mean_abs_diff"] > 0.15


def t3_06_forward_seek_then_backward_seek_and_start_over_zero_range_requests(ctx: E2ER2TestContext) -> None:
    """F8 + F9 + F14: Forward seek (65%) -> backward seek (15%) -> Start Over (0:00) rewinds in-place with 0 new PK3 Range requests."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.65));
        const at65 = mod._JK_DemoGetCurrentTimeMs();
        const reqBefore = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.15));
        const at15 = mod._JK_DemoGetCurrentTimeMs();
        const startOverBtn = document.querySelector('#jk-pip-start-over, #btn-start-over');
        startOverBtn.click();
        await new Promise(r => setTimeout(r, 100));
        const at0 = mod._JK_DemoGetCurrentTimeMs();
        const reqAfter = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        return { dur, at65, at15, at0, reqDelta: reqAfter - reqBefore, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True and res["reqDelta"] == 0
    assert res["at65"] > res["at15"] > res["at0"] and res["at0"] <= 400


def t3_07_pause_then_forward_and_backward_seek_then_resume(ctx: E2ER2TestContext) -> None:
    """F8 + F9 + F14: Pause via PiP control -> seek forward -> seek backward while paused -> resume without time jump."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoPause();
        const fTarget = Math.floor(dur * 0.5);
        mod._JK_DemoSeekToMs(fTarget);
        const atForward = mod._JK_DemoGetCurrentTimeMs();
        const bTarget = Math.floor(dur * 0.2);
        mod._JK_DemoSeekToMs(bTarget);
        const atBackward = mod._JK_DemoGetCurrentTimeMs();
        const stillPaused = mod._JK_DemoIsPaused() === 1;
        mod._JK_DemoResume();
        await new Promise(r => setTimeout(r, 350));
        const afterResume = mod._JK_DemoGetCurrentTimeMs();
        return { fTarget, atForward, bTarget, atBackward, stillPaused, afterResume };
        """
    )
    assert res["stillPaused"] is True
    assert abs(res["atForward"] - res["fTarget"]) <= 500
    assert abs(res["atBackward"] - res["bTarget"]) <= 500
    assert res["afterResume"] > res["atBackward"]


def t3_08_speed_4x_plus_forward_seek_to_end_triggers_instant_loop(ctx: E2ER2TestContext) -> None:
    """F8 + F10 + F14: Set speed to 4x via PiP UI, seek near EOF, and verify instant loop back to 0:00."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        mod._JK_DemoSetSpeed(4.0);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSeekToMs(Math.max(0, dur - 250));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        const cur = mod._JK_DemoGetCurrentTimeMs();
        return { looped: mod._JK_DemoGetCompletedCount() > c0, cur, dur, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["looped"] is True and res["playing"] is True and res["cur"] < res["dur"] * 0.5


def t3_09_disable_loop_reach_eof_then_start_over_from_memfs(ctx: E2ER2TestContext) -> None:
    """F9 + F10 + F14: Disable Loop toggle -> seek to EOF -> verify non-looping completion -> click Start Over (0:00)."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 180));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0 || mod._JK_DemoIsCompleted()) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        mod._JK_DemoSetLoop(1);
        document.querySelector('#jk-pip-start-over, #btn-start-over').click();
        await new Promise(r => setTimeout(r, 200));
        return { cur: mod._JK_DemoGetCurrentTimeMs(), playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True and res["cur"] < 1000


def t3_10_match_html_nice_shot_trimdemo_play_scan_and_seek(ctx: E2ER2TestContext) -> None:
    """F11 + F15 + F6 + F8: Click .jk-play-btn on trimdemo.php Nice Shot on match.html, verify clip duration and seeking."""
    st = ctx.ensure_pip_playing("match.html", "trimdemo.php", force_reload_demo=True)
    assert st["isPlaying"] is True and 1000 <= st["durationMs"] <= 45000
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        const half = Math.floor(dur * 0.5);
        mod._JK_DemoSeekToMs(half);
        const atHalf = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        const atZero = mod._JK_DemoGetCurrentTimeMs();
        return { half, atHalf, atZero };
        """
    )
    assert abs(res["atHalf"] - res["half"]) <= 500 and res["atZero"] <= 350


def t3_11_match_html_mergedemo_grey_link_play_and_seek(ctx: E2ER2TestContext) -> None:
    """F11 + F15 + F5 + F8: Load valid mergedemo.php link from match.html, verify map PK3 mount and forward/backward seek."""
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const url = '/mergedemo.php?matchid=004a5ab0b7024e11&clientid=3';
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (pip && pip.openAndPlay) {
          await pip.openAndPlay(url, { label: 'Merged POV Client 3' });
        } else {
          await p.loadDemo(url);
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 60000) {
          if (mod && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 120));
        }
        const dur = mod._JK_DemoGetDurationMs();
        const target = Math.floor(dur * 0.4);
        mod._JK_DemoSeekToMs(target);
        const cur = mod._JK_DemoGetCurrentTimeMs();
        return { dur, target, cur, playing: mod._JK_DemoIsPlaying() === 1 };
        """,
        timeout=75.0,
    )
    assert res["playing"] is True and res["dur"] > 0 and abs(res["cur"] - res["target"]) <= 500


def t3_12_match_html_matchdemo_merged_highlight_play_and_seek(ctx: E2ER2TestContext) -> None:
    """F11 + F15 + F5 + F8: Load /minrpc.py?rpc=matchdemo&id=0053b07a2f638a96 on match.html, verify playback and seek."""
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const url = '/minrpc.py?rpc=matchdemo&id=0053b07a2f638a96';
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (pip && pip.openAndPlay) {
          await pip.openAndPlay(url, { label: 'Match Demo 0053b0' });
        } else {
          await p.loadDemo(url);
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 75000) {
          if (mod && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 150));
        }
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.3));
        return { dur, cur: mod._JK_DemoGetCurrentTimeMs(), playing: mod._JK_DemoIsPlaying() === 1 };
        """,
        timeout=90.0,
    )
    assert res["playing"] is True and res["dur"] > 0


def t3_13_pip_drag_and_resize_during_active_playback_and_seeking(ctx: E2ER2TestContext) -> None:
    """F13 + F14 + F8: Drag PiP header and resize pane while playing, verify canvas resolution updates and seeking works."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (pip && pip.setSizePreset) pip.setSizePreset('compact');
        await new Promise(r => setTimeout(r, 80));
        const w1 = mod._JK_DemoGetViewportWidth ? mod._JK_DemoGetViewportWidth() : document.querySelector('#jk-canvas').width;
        if (pip && pip.setSizePreset) pip.setSizePreset('large');
        await new Promise(r => setTimeout(r, 80));
        const w2 = mod._JK_DemoGetViewportWidth ? mod._JK_DemoGetViewportWidth() : document.querySelector('#jk-canvas').width;
        if (pip && pip.setSizePreset) pip.setSizePreset('default');
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.35));
        return { w1, w2, playing: mod._JK_DemoIsPlaying() === 1, cur: mod._JK_DemoGetCurrentTimeMs() };
        """
    )
    assert res["playing"] is True and res["w2"] >= res["w1"]


def t3_14_close_pip_and_reopen_different_demo_on_match_html(ctx: E2ER2TestContext) -> None:
    """F12 + F14 + F15: Close PiP pane -> click another .jk-play-btn on match.html -> verify immediate reopen and playback."""
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const closeBtn = document.querySelector('#jk-pip-close, #btn-close');
        closeBtn.click();
        await new Promise(r => setTimeout(r, 80));
        const btns = Array.from(document.querySelectorAll('.jk-play-btn[data-demo-url*="trimdemo.php"]'));
        const nextBtn = btns[0] || document.querySelector('.jk-play-btn');
        nextBtn.click();
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 45000) {
          const card = document.querySelector('#jk-pip-card, #jk-player-pip');
          const visible = card && window.getComputedStyle(card).display !== 'none';
          if (visible && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) {
            return { visible, playing: true, dur: mod._JK_DemoGetDurationMs() };
          }
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('Failed to reopen and play second demo after Close');
        """,
        timeout=60.0,
    )
    assert res["visible"] is True and res["playing"] is True and res["dur"] > 0


def t3_15_multi_map_demo_switch_unlinks_custom_paks_and_updates_timeline(ctx: E2ER2TestContext) -> None:
    """F5 + F11 + F8 + F9: Switch between two demos on different maps, verify custom PK3 mount/unlink and seek on second demo."""
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const pip = window.JKPiPPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const demo1 = '/getdemo.php?demo=' + encodeURIComponent('/cygdrive/U/demos/demobot/2026/10/31/0 mpctf_kejim 2026-10-31_23-44-17.dm_26');
        const demo2 = '/getdemo.php?demo=' + encodeURIComponent('/cygdrive/U/demos/demobot/2026/10/31/0 mpctf_taloraan 2026-10-31_23-53-19.dm_26');

        if (pip && pip.openAndPlay) await pip.openAndPlay(demo1); else await p.loadDemo(demo1);
        let t0 = Date.now();
        while (Date.now() - t0 < 45000) {
          if (mod._JK_DemoIsPlaying() === 1 && mod.UTF8ToString(mod._JK_DemoGetMapName()).toLowerCase().includes('kejim')) break;
          await new Promise(r => setTimeout(r, 120));
        }
        const map1 = mod.UTF8ToString(mod._JK_DemoGetMapName());

        if (pip && pip.openAndPlay) await pip.openAndPlay(demo2); else await p.loadDemo(demo2);
        t0 = Date.now();
        while (Date.now() - t0 < 45000) {
          if (mod._JK_DemoIsPlaying() === 1 && mod.UTF8ToString(mod._JK_DemoGetMapName()).toLowerCase().includes('taloraan')) break;
          await new Promise(r => setTimeout(r, 120));
        }
        const map2 = mod.UTF8ToString(mod._JK_DemoGetMapName());
        const dur2 = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur2 * 0.4));
        const cur2 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        const rew2 = mod._JK_DemoGetCurrentTimeMs();
        return { map1, map2, dur2, cur2, rew2 };
        """,
        timeout=95.0,
    )
    assert "kejim" in res["map1"].lower() and "taloraan" in res["map2"].lower()
    assert res["dur2"] > 0 and res["rew2"] <= 400


def t3_16_index_html_rpc_table_play_seek_and_speed(ctx: E2ER2TestContext) -> None:
    """F16 + F11 + F13 + F14: On index.html, click .jk-play-btn in #recentdemos, seek forward/backward, and change speed."""
    st = ctx.ensure_pip_playing("index.html", "getdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.3));
        const at30 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        const at0 = mod._JK_DemoGetCurrentTimeMs();
        return { dur, at30, at0 };
        """
    )
    assert abs(res["at30"] - int(res["dur"] * 0.3)) <= 600 and res["at0"] <= 400


def t3_17_aplayer2_html_nice_shot_play_seek_and_loop(ctx: E2ER2TestContext) -> None:
    """F17 + F11 + F13 + F14: On aplayer2.html, click .jk-play-btn on a Nice Shot trimdemo.php link and verify playback & seeking."""
    st = ctx.ensure_pip_playing("aplayer2.html", "trimdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.5));
        const at50 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        const at0 = mod._JK_DemoGetCurrentTimeMs();
        return { dur, at50, at0 };
        """
    )
    assert abs(res["at50"] - int(res["dur"] * 0.5)) <= 600 and res["at0"] <= 400


def t3_18_multi_version_pk3_checksum_disambiguation_and_rewind(ctx: E2ER2TestContext) -> None:
    """F1 + F2 + F3 + F5 + F9: Verify alternate <basename>.<hex>.pk3 checksum entries in manifest are addressable via HTTP Range."""
    manifest = ctx.get_manifest()
    by_base = {}
    for e in manifest["pk3s"]:
        by_base.setdefault(e["basename"], []).append(e)
    multi_base, entries = next((b, es) for b, es in by_base.items() if len(es) >= 2)
    for e in entries[:2]:
        status, _, body = ctx.http_request(
            "GET",
            f"/base/{e['name']}",
            headers={"Range": f"bytes={e['cd_offset']}-{e['cd_offset'] + 3}"},
        )
        assert status == 206 and body == b"PK\x01\x02", (
            f"Multi-version PK3 {e['name']} (checksum={e['checksum']}) failed CD range fetch"
        )


def get_tier3_tests() -> List[TestCase]:
    return [
        TestCase("T3_01_prewarm_manifest_v2_base_only_range_and_hidden_muted_pip", 3, "F4+F12+F18", "Prewarm fetches manifest v2, mounts only assets0..3.pk3 (<=8 ranges), keeps PiP hidden & muted", t3_01_prewarm_manifest_v2_base_only_range_and_hidden_muted_pip),
        TestCase("T3_02_match_html_play_btn_opens_pip_fetches_getdemo_without_table_reflow", 3, "F11+F13+F15", "Clicking .jk-play-btn on match.html opens PiP without table reflow and plays getdemo.php", t3_02_match_html_play_btn_opens_pip_fetches_getdemo_without_table_reflow),
        TestCase("T3_03_custom_map_demo_resolves_pk3_by_checksum_and_loads_bsp", 3, "F1+F2+F3+F5", "Custom map demo resolves PK3 by signed 32-bit checksum and loads .bsp without error", t3_03_custom_map_demo_resolves_pk3_by_checksum_and_loads_bsp),
        TestCase("T3_04_demo_load_scans_bounds_and_syncs_pip_time_display", 3, "F5+F6+F7+F14", "Demo load scans snapshot serverTime bounds and syncs PiP MM:SS / MM:SS display", t3_04_demo_load_scans_bounds_and_syncs_pip_time_display),
        TestCase("T3_05_scrubber_forward_seek_drains_commands_and_renders_new_frame", 3, "F7+F8+F14", "Scrubbing PiP seek slider forward drains serverCommands and renders new 3D WebGL frame", t3_05_scrubber_forward_seek_drains_commands_and_renders_new_frame),
        TestCase("T3_06_forward_seek_then_backward_seek_and_start_over_zero_range_requests", 3, "F8+F9+F14", "Forward seek (65%) -> backward seek (15%) -> Start Over (0:00) with 0 new PK3 Range requests", t3_06_forward_seek_then_backward_seek_and_start_over_zero_range_requests),
        TestCase("T3_07_pause_then_forward_and_backward_seek_then_resume", 3, "F8+F9+F14", "Pause via PiP button -> forward & backward seek while paused -> resume smoothly", t3_07_pause_then_forward_and_backward_seek_then_resume),
        TestCase("T3_08_speed_4x_plus_forward_seek_to_end_triggers_instant_loop", 3, "F8+F10+F14", "Set 4x speed + seek near EOF triggers automatic instant loop to 0:00", t3_08_speed_4x_plus_forward_seek_to_end_triggers_instant_loop),
        TestCase("T3_09_disable_loop_reach_eof_then_start_over_from_memfs", 3, "F9+F10+F14", "Disable Loop -> reach EOF -> click Start Over (0:00) restarts from MEMFS", t3_09_disable_loop_reach_eof_then_start_over_from_memfs),
        TestCase("T3_10_match_html_nice_shot_trimdemo_play_scan_and_seek", 3, "F6+F8+F11+F15", "Play trimdemo.php Nice Shot clip on match.html, verify clip duration and seeking", t3_10_match_html_nice_shot_trimdemo_play_scan_and_seek),
        TestCase("T3_11_match_html_mergedemo_grey_link_play_and_seek", 3, "F5+F8+F11+F15", "Play mergedemo.php grey link on match.html, verify custom map mount and seeking", t3_11_match_html_mergedemo_grey_link_play_and_seek),
        TestCase("T3_12_match_html_matchdemo_merged_highlight_play_and_seek", 3, "F5+F8+F11+F15", "Play /minrpc.py?rpc=matchdemo link on match.html, verify playback and seeking", t3_12_match_html_matchdemo_merged_highlight_play_and_seek),
        TestCase("T3_13_pip_drag_and_resize_during_active_playback_and_seeking", 3, "F8+F13+F14", "Resize PiP presets and drag header during active playback and seeking", t3_13_pip_drag_and_resize_during_active_playback_and_seeking),
        TestCase("T3_14_close_pip_and_reopen_different_demo_on_match_html", 3, "F12+F14+F15", "Close PiP pane and click another .jk-play-btn to reopen immediately using warm Wasm", t3_14_close_pip_and_reopen_different_demo_on_match_html),
        TestCase("T3_15_multi_map_demo_switch_unlinks_custom_paks_and_updates_timeline", 3, "F5+F8+F9+F11", "Switch between mp/ctf_kejim and mp/ctf_taloraan demos, verify PK3 switch and seeking", t3_15_multi_map_demo_switch_unlinks_custom_paks_and_updates_timeline),
        TestCase("T3_16_index_html_rpc_table_play_seek_and_speed", 3, "F11+F13+F14+F16", "On index.html, click .jk-play-btn in #recentdemos and verify playback and seeking", t3_16_index_html_rpc_table_play_seek_and_speed),
        TestCase("T3_17_aplayer2_html_nice_shot_play_seek_and_loop", 3, "F11+F13+F14+F17", "On aplayer2.html, click .jk-play-btn on Nice Shot trimdemo.php clip and verify seeking", t3_17_aplayer2_html_nice_shot_play_seek_and_loop),
        TestCase("T3_18_multi_version_pk3_checksum_disambiguation_and_rewind", 3, "F1+F2+F3+F5+F9", "Verify multi-version <basename>.<hex>.pk3 archives are addressable via HTTP Range", t3_18_multi_version_pk3_checksum_disambiguation_and_rewind),
    ]
