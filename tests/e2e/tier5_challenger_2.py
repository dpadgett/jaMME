#!/usr/bin/env python3
"""
Tier 5 White-Box Adversarial Stress Test Suite — Challenger #2 (tier5_challenger_2.py)

Standalone white-box verification & adversarial stress harness for the OpenJK
WebAssembly Multiplayer Demo Player (codemp). Uses an isolated ephemeral local
port and dedicated headless Chrome instance so it never conflicts with concurrent
test runners.

Covers:
1. White-Box Binary & Symbol Isolation Verification:
   - Wasm static libraries (rd-vanilla_wasm32.a, cgamewasm32.a, uiwasm32.a) and
     monolithic openjk.wasm symbol isolation (GetRefAPI, GetCGameAPI_Static,
     GetUIAPI_Static, UI_SYM_vmMain, UI_SYM_*, CG_SYM_*).
   - Native Linux x86_64 ELF64 binaries & shared libraries (openjk.x86_64,
     rd-vanilla_x86_64.so, cgamex86_64.so, uix86_64.so) and ldd resolution.
2. URL Query Parameter & window.JKDemoConfig Precedence / Edge Cases:
   - True cold-boot with ?demo=out.dm_26&speed=2.0&muted=1, verifying direct-to-demo
     boot skipping main menus, initial speed (2.0), initial muted state (true),
     Wasm Cvar synchronization, and 3D WebGL frame rendering.
   - window.JKDemoConfig fallback vs URL query parameter override precedence and
     path-traversal / malformed query sanitization (?demo=../../etc/passwd&speed=NaN).
3. Pause/Resume Time-Jump Invariant (2+ Wall-Clock Seconds):
   - Pausing demo playback for >= 2.2 wall-clock seconds while cls.realtime and
     frameCount advance, confirming serverTime delta == 0 while paused, then
     resuming and verifying cl.serverTimeDelta -= cls.frametime compensation
     prevents serverTime from jumping forward by the paused wall-clock duration.
   - High-speed (4.0x) pause/resume stress test.
4. Audio Pipeline, SDL2 DMA Mixing & Autoplay / Volume Boundary Stress:
   - Verifying SDL2 DMA initialization (JK_DemoIsAudioActive == 1), active sample
     mixing (JK_DemoGetAudioSamplesMixed / audioSamplesMixed > 0 and advancing),
     mute()/unmute()/setVolume(0.35) persistence across mute cycles, and
     adversarial boundary inputs (NaN, -5, 99, Infinity, -Infinity, invalid strings)
     at both the JS API and direct Wasm C export (_JK_DemoSetVolume) levels.
5. Demo Completion (CL_DemoCompleted) & Error Recovery via loadDemo:
   - Playing a synthesized short .dm_26 stream to EOF, confirming onDemoComplete /
     onDemoEnded callbacks and window 'jkdemo:ended' / 'jkdemo:complete' CustomEvents
     fire with { demoName, serverTime, frameCount } without Com_Error(ERR_DISCONNECT),
     confirming resilience when a completion listener throws an exception, and
     recovering into a new demo via loadDemo().
"""

import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List

# Ensure parent package import works when executed directly as a script
ROOT_DIR = Path("/home/dan/OpenJK/jaMME")
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tests.e2e.harness import (
    E2ETestContext,
    find_free_port,
    parse_wasm_sections,
)


# ==============================================================================
# 1. White-Box Binary & Symbol Isolation Tests
# ==============================================================================
def t5_c2_01_wasm_static_archives_and_symbol_isolation(ctx: E2ETestContext) -> None:
    """
    White-box check of build-wasm static archives (rd-vanilla_wasm32.a,
    cgamewasm32.a, uiwasm32.a) and linked web/openjk.wasm to verify that
    rd-vanilla, cgame, and ui are compiled and statically linked with
    UI_SYM_ / CG_SYM_ symbol isolation and static module entrypoints.
    """
    wasm_build = ctx.build_wasm_dir / "codemp" / "openjk.wasm"
    wasm_web = ctx.web_dir / "openjk.wasm"
    js_web = ctx.web_dir / "openjk.js"
    assert wasm_build.exists() and wasm_web.exists() and js_web.exists()
    assert wasm_build.stat().st_size == wasm_web.stat().st_size

    sections = parse_wasm_sections(wasm_web)
    sec_ids = {sec_id for sec_id, _ in sections}
    for req_id in (1, 2, 3, 7, 10, 11):
        assert req_id in sec_ids, f"Missing Wasm section {req_id}"

    rd_a = ctx.build_wasm_dir / "codemp" / "rd-vanilla" / "rd-vanilla_wasm32.a"
    cg_a = ctx.build_wasm_dir / "codemp" / "cgame" / "cgamewasm32.a"
    ui_a = ctx.build_wasm_dir / "codemp" / "ui" / "uiwasm32.a"
    assert rd_a.exists(), f"Missing static renderer archive: {rd_a}"
    assert cg_a.exists(), f"Missing static cgame archive: {cg_a}"
    assert ui_a.exists(), f"Missing static ui archive: {ui_a}"

    llvm_nm = "/home/dan/emsdk/upstream/bin/llvm-nm"
    assert os.path.exists(llvm_nm), f"Missing llvm-nm at {llvm_nm}"

    rd_nm = subprocess.check_output([llvm_nm, str(rd_a)], text=True)
    cg_nm = subprocess.check_output([llvm_nm, str(cg_a)], text=True)
    ui_nm = subprocess.check_output([llvm_nm, str(ui_a)], text=True)

    # Verify static module API entrypoints in respective static archives
    assert " T GetRefAPI" in rd_nm, "GetRefAPI not defined in rd-vanilla_wasm32.a"
    assert " T GetCGameAPI_Static" in cg_nm, "GetCGameAPI_Static not defined in cgamewasm32.a"
    assert " T GetUIAPI_Static" in ui_nm, "GetUIAPI_Static not defined in uiwasm32.a"

    # Verify symbol prefix isolation between cgame and ui
    assert " T UI_SYM_vmMain" in ui_nm, "UI_SYM_vmMain missing in uiwasm32.a"
    assert " T UI_SYM_dllEntry" in ui_nm, "UI_SYM_dllEntry missing in uiwasm32.a"
    assert " T UI_SYM_BG_EvaluateTrajectory" in ui_nm, "UI_SYM_BG_EvaluateTrajectory missing in uiwasm32.a"
    assert " T vmMain" in cg_nm, "Unprefixed cgame vmMain missing in cgamewasm32.a"
    assert " D CG_SYM_broadsword" in cg_nm, "CG_SYM_broadsword missing in cgamewasm32.a"
    assert " D CG_SYM_cl_paused" in cg_nm, "CG_SYM_cl_paused missing in cgamewasm32.a"

    # Verify linked openjk.wasm contains all three modules' symbols in its profiling name section
    wasm_bytes = wasm_web.read_bytes()
    for required_sym in (
        b"GetCGameAPI_Static",
        b"GetUIAPI_Static",
        b"UI_SYM_",
        b"RE_BeginRegistration",
        b"RE_RenderScene",
        b"CG_Init",
        b"CG_DrawActiveFrame",
        b"UI_Init",
        b"CL_DemoCompleted",
        b"CL_SetCGameTime",
        b"JK_DemoPause",
        b"JK_DemoResume",
        b"JK_DemoSetSpeed",
        b"JK_DemoSetMuted",
        b"JK_DemoSetVolume",
        b"JK_DemoLoad",
        b"JK_DemoGetAudioSamplesMixed",
    ):
        assert (
            required_sym in wasm_bytes
        ), f"Expected linked symbol {required_sym!r} in web/openjk.wasm"


def t5_c2_02_native_x86_64_binaries_elf_and_ldd_isolation(ctx: E2ETestContext) -> None:
    """
    White-box check of build-native ELF64 x86-64 binaries and shared libraries
    (openjk.x86_64, rd-vanilla_x86_64.so, cgamex86_64.so, uix86_64.so) and ldd.
    """
    expected_targets = [
        (ctx.build_native_dir / "openjk.x86_64", []),
        (ctx.build_native_dir / "codemp" / "openjk.x86_64", []),
        (ctx.build_native_dir / "codemp" / "rd-vanilla_x86_64.so", ["GetRefAPI"]),
        (ctx.build_native_dir / "codemp" / "cgamex86_64.so", ["GetModuleAPI", "vmMain", "dllEntry"]),
        (ctx.build_native_dir / "codemp" / "uix86_64.so", ["GetModuleAPI", "vmMain", "dllEntry"]),
    ]

    for path, expected_exports in expected_targets:
        assert path.exists(), f"Missing native build artifact: {path}"
        hdr = path.read_bytes()[:20]
        assert hdr[:4] == b"\x7fELF", f"Invalid ELF magic in {path}"
        ei_class = hdr[4]
        ei_data = hdr[5]
        e_type, e_machine = struct.unpack("<HH", hdr[16:20])
        assert ei_class == 2, f"Expected ELF64 (2) in {path}, got {ei_class}"
        assert ei_data == 1, f"Expected little-endian (1) in {path}, got {ei_data}"
        assert e_type in (2, 3), f"Expected ET_EXEC/ET_DYN in {path}, got {e_type}"
        assert e_machine == 0x3E, f"Expected EM_X86_64 (0x3e) in {path}, got {hex(e_machine)}"

        ldd_out = subprocess.check_output(["ldd", str(path)], text=True)
        assert "not found" not in ldd_out, f"Unresolved dynamic library in {path}:\n{ldd_out}"

        if expected_exports:
            nm_out = subprocess.check_output(["nm", "-D", str(path)], text=True)
            for sym in expected_exports:
                assert sym in nm_out, f"Expected dynamic export {sym} in {path}"


# ==============================================================================
# 2. Cold-Boot URL Query Parameter & window.JKDemoConfig Precedence Tests
# ==============================================================================
def t5_c2_03_cold_boot_url_query_params_out_speed2_muted1(ctx: E2ETestContext) -> None:
    """
    Cold-boot headless Chrome directly with /index.html?demo=out.dm_26&speed=2.0&muted=1.
    Verify:
    - Boots directly into demo playback of out.dm_26 (skipping main menus, CA_ACTIVE == 8).
    - Initial speed is 2.0 in both JS getStatus()/getSpeed() and C _JK_DemoGetSpeed().
    - Initial muted state is True in both JS getStatus()/isMuted() and C _JK_DemoIsMuted().
    - WebGL canvas renders non-blank 3D scene frames of mp/ctf1.
    """
    ctx.ensure_server()
    ctx.ensure_browser_bridge()
    ctx.reset_metrics()

    url = f"{ctx.base_url}/index.html?demo=out.dm_26&speed=2.0&muted=1"
    res = ctx.rpc(
        "goto",
        {
            "url": url,
            "clearLogs": True,
            "waitForReady": True,
            "requirePlaying": True,
            "readyTimeout": 240000,
        },
        timeout=300.0,
    )
    ctx.booted = True
    ctx.current_boot_demo = "out.dm_26"

    # Wait briefly to ensure onRuntimeInitialized 100ms post-init hook has settled
    probe = ctx.eval_js(
        """
        await new Promise(r => setTimeout(r, 250));
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const st = p.getStatus();
        const mod = window.Module;
        const cState = mod._JK_DemoGetState ? mod._JK_DemoGetState() : -1;
        const cSpeed = mod._JK_DemoGetSpeed ? mod._JK_DemoGetSpeed() : -1;
        const cMuted = mod._JK_DemoIsMuted ? mod._JK_DemoIsMuted() : -1;
        const cMap = mod._JK_DemoGetMapName && mod.UTF8ToString ? mod.UTF8ToString(mod._JK_DemoGetMapName()) : '';
        return {
          status: st,
          jsSpeed: p.getSpeed(),
          jsMuted: p.isMuted(),
          cState,
          cSpeed,
          cMuted,
          cMap,
        };
        """
    )

    st = probe["status"]
    assert st["ready"] is True and st["isPlaying"] is True, f"Not playing after cold boot: {probe}"
    assert "out" in st["demoName"].lower(), f"Expected demoName 'out.dm_26', got {st['demoName']}"
    assert probe["cState"] == 8, f"Expected CA_ACTIVE (8), got {probe['cState']}"
    assert abs(probe["jsSpeed"] - 2.0) < 0.05, f"Expected initial JS speed 2.0, got {probe['jsSpeed']}"
    assert abs(probe["cSpeed"] - 2.0) < 0.05, f"Expected initial C timescale 2.0, got {probe['cSpeed']}"
    assert probe["jsMuted"] is True, f"Expected initial JS muted=True, got {probe['jsMuted']}"
    assert probe["cMuted"] == 1, f"Expected initial C muted=1, got {probe['cMuted']}"
    assert "ctf1" in probe["cMap"].lower(), f"Expected map mp/ctf1 for out.dm_26, got {probe['cMap']}"

    snap = ctx.capture_canvas_screenshot("t5_c2_03_cold_boot_out")
    assert (
        snap["width"] >= 640 and snap["height"] >= 360
    ), f"Invalid canvas dimensions: {snap['width']}x{snap['height']}"
    assert snap["std_rgb"] > 10.0 and snap["unique_colors"] > 500, f"Blank canvas on cold boot: {snap}"

    # Restore normal speed and unmuted state for subsequent tests
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer;
        p.setSpeed(1.0);
        p.unmute();
        p.setVolume(0.8);
        """
    )


def t5_c2_04_jkdemoconfig_precedence_and_adversarial_query_inputs(
    ctx: E2ETestContext,
) -> None:
    """
    Stress-test URL query parameter vs window.JKDemoConfig precedence and
    malformed/hostile query parameters (?demo=../../../etc/passwd&speed=-999&volume=NaN).
    """
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer;
        // 1. Set window.JKDemoConfig fallback and call applyQueryConfig('?') (no URL params)
        window.JKDemoConfig = { speed: 1.75, muted: true, volume: 0.4 };
        await p.applyQueryConfig('?');
        const afterFallback = {
          speed: p.getSpeed(),
          muted: p.isMuted(),
          volume: p.getVolume(),
        };

        // 2. URL query parameters must override window.JKDemoConfig
        await p.applyQueryConfig('?speed=0.5&muted=0&volume=0.65');
        const afterOverride = {
          speed: p.getSpeed(),
          muted: p.isMuted(),
          volume: p.getVolume(),
        };

        // 3. Adversarial query parameters: path traversal demo, extreme speed/volume, NaN
        delete window.JKDemoConfig;
        await p.applyQueryConfig('?demo=../../../etc/passwd&speed=-999&volume=NaN&muted=invalid');
        const afterAdversarial = {
          demoName: p.getStatus().demoName,
          isPlaying: p.getStatus().isPlaying,
          speed: p.getSpeed(),
          volume: p.getVolume(),
          muted: p.isMuted(),
        };

        // Restore defaults
        p.setSpeed(1.0);
        p.setVolume(0.8);
        p.unmute();
        return { afterFallback, afterOverride, afterAdversarial };
        """
    )

    assert abs(res["afterFallback"]["speed"] - 1.75) < 0.05, f"Fallback speed mismatch: {res}"
    assert res["afterFallback"]["muted"] is True, f"Fallback muted mismatch: {res}"
    assert abs(res["afterFallback"]["volume"] - 0.4) < 0.02, f"Fallback volume mismatch: {res}"

    assert abs(res["afterOverride"]["speed"] - 0.5) < 0.05, f"Override speed mismatch: {res}"
    assert res["afterOverride"]["muted"] is False, f"Override muted mismatch: {res}"
    assert abs(res["afterOverride"]["volume"] - 0.65) < 0.02, f"Override volume mismatch: {res}"

    # Path traversal must be rejected without crashing active playback; -999 clamped to 0.05; NaN volume ignored
    assert res["afterAdversarial"]["isPlaying"] is True, f"Playback stopped after adversarial query: {res}"
    assert "passwd" not in res["afterAdversarial"]["demoName"], f"Path traversal not blocked: {res}"
    assert abs(res["afterAdversarial"]["speed"] - 0.05) < 0.01, f"Speed -999 not clamped to 0.05: {res}"
    assert abs(res["afterAdversarial"]["volume"] - 0.65) < 0.02, f"NaN volume corrupted state: {res}"
    assert res["afterAdversarial"]["muted"] is False, f"Invalid muted param should be false: {res}"


# ==============================================================================
# 3. Pause / Resume 2+ Second Time-Jump Invariant Stress Tests
# ==============================================================================
def t5_c2_05_pause_2_seconds_resume_no_server_time_jump(ctx: E2ETestContext) -> None:
    """
    Empirically stress-test the pause/resume time-jump invariant:
    - Play demo at 1.0x speed.
    - Pause for >= 2.2 wall-clock seconds (2200ms).
    - Confirm serverTime delta == 0 across the entire 2.2s pause while cls.realtime
      and frameCount continue advancing.
    - Resume and sample serverTime 150ms later; confirm serverTime advances by
      only ~150ms (strictly < 600ms), proving cl.serverTimeDelta -= cls.frametime
      in CL_SetCGameTime prevents jumping forward by the 2.2s paused wall-clock duration.
    """
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer;
        const mod = window.Module;
        p.setSpeed(1.0);
        p.resume();
        await new Promise(r => setTimeout(r, 200));

        p.pause();
        const tPauseStart = p.getStatus().serverTime;
        const rtPauseStart = mod._JK_DemoGetRealtime();
        const fcPauseStart = p.getStatus().frameCount;
        const wallStart = performance.now();

        await new Promise(r => setTimeout(r, 1100));
        const tMidPause = p.getStatus().serverTime;

        await new Promise(r => setTimeout(r, 1150));
        const wallPausedMs = performance.now() - wallStart;
        const tPauseEnd = p.getStatus().serverTime;
        const rtPauseEnd = mod._JK_DemoGetRealtime();
        const fcPauseEnd = p.getStatus().frameCount;

        // Resume and sample after ~160ms
        const resumeWallStart = performance.now();
        p.resume();
        await new Promise(r => setTimeout(r, 160));
        const resumeWallElapsed = performance.now() - resumeWallStart;
        const tAfterResume = p.getStatus().serverTime;

        return {
          tPauseStart,
          tMidPause,
          tPauseEnd,
          pausedServerDelta: tPauseEnd - tPauseStart,
          wallPausedMs,
          realtimeDeltaDuringPause: rtPauseEnd - rtPauseStart,
          framesDuringPause: fcPauseEnd - fcPauseStart,
          resumeWallElapsed,
          tAfterResume,
          postResumeServerDelta: tAfterResume - tPauseEnd,
        };
        """,
        timeout=15.0,
    )

    assert res["wallPausedMs"] >= 2000.0, f"Pause duration was < 2s: {res}"
    assert (
        res["pausedServerDelta"] == 0 and res["tMidPause"] == res["tPauseStart"]
    ), f"serverTime drifted while paused: {res}"
    assert (
        res["realtimeDeltaDuringPause"] >= 1500
    ), f"cls.realtime did not advance while paused: {res}"
    assert (
        res["framesDuringPause"] >= 15
    ), f"Engine main loop frames did not run while paused: {res}"
    # If cl.serverTimeDelta were not compensated, postResumeServerDelta would jump by ~2400ms+!
    assert (
        0 < res["postResumeServerDelta"] < 650
    ), f"Time-jump invariant violated on resume! Expected < 650ms, got {res['postResumeServerDelta']}ms ({res})"


def t5_c2_06_pause_2_seconds_at_4x_speed_resume_no_time_jump(
    ctx: E2ETestContext,
) -> None:
    """
    Stress-test pause/resume time-jump invariant under 4.0x timescale:
    Even when timescale=4.0 during a 2.1s pause (~8,400ms of scaled cls.realtime),
    serverTime must remain frozen and must not jump by 8+ seconds on resume.
    """
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer;
        const mod = window.Module;
        p.setSpeed(4.0);
        p.resume();
        await new Promise(r => setTimeout(r, 150));

        p.pause();
        const t0 = p.getStatus().serverTime;
        const rt0 = mod._JK_DemoGetRealtime();
        await new Promise(r => setTimeout(r, 2100));
        const t1 = p.getStatus().serverTime;
        const rt1 = mod._JK_DemoGetRealtime();

        // Drop speed to 1.0x right before resuming so post-resume delta over 150ms is ~150ms
        p.setSpeed(1.0);
        p.resume();
        await new Promise(r => setTimeout(r, 150));
        const t2 = p.getStatus().serverTime;

        return {
          t0,
          t1,
          t2,
          pausedDelta: t1 - t0,
          scaledRealtimeDuringPause: rt1 - rt0,
          postResumeDelta: t2 - t1,
        };
        """,
        timeout=15.0,
    )

    assert res["pausedDelta"] == 0, f"serverTime drifted during 4x pause: {res}"
    assert res["scaledRealtimeDuringPause"] >= 4000, f"Expected scaled cls.realtime advance: {res}"
    assert (
        0 < res["postResumeDelta"] < 650
    ), f"4x pause caused a time-jump on resume: {res}"


# ==============================================================================
# 4. Audio Pipeline, SDL2 DMA Mixing & Volume/Mute Boundary Stress Tests
# ==============================================================================
def t5_c2_07_sdl2_dma_audio_mixing_and_boundary_fuzzing(ctx: E2ETestContext) -> None:
    """
    Verify:
    - SDL2 DMA audio device is active (JK_DemoIsAudioActive == 1).
    - S_PaintChannels actively mixes samples into the DMA ringbuffer
      (audioSamplesMixed > 0 and strictly increases during playback).
    - Mute/unmute and setVolume(0.35) update both JS state, WebAudio GainNode,
      and C s_volume Cvar.
    - Adversarial boundary inputs (NaN, -5, 99, Infinity, -Infinity, 'abc')
      are safely clamped/ignored at both JS and C export levels.
    """
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer;
        const mod = window.Module;
        p.unmute();
        p.setVolume(0.8);
        p.resume();

        const st0 = p.getStatus();
        await new Promise(r => setTimeout(r, 500));
        const st1 = p.getStatus();

        // Test mute -> setVolume(0.35) -> unmute persistence
        p.mute();
        const mutedState = {
          jsMuted: p.isMuted(),
          cMuted: mod._JK_DemoIsMuted(),
          audioActive: p.getStatus().audioActive,
        };
        const v035 = p.setVolume(0.35);
        const mutedWith035 = {
          jsMuted: p.isMuted(),
          jsVol: p.getVolume(),
          cVol: mod._JK_DemoGetVolume(),
        };
        p.unmute();
        const unmutedWith035 = {
          jsMuted: p.isMuted(),
          cMuted: mod._JK_DemoIsMuted(),
          jsVol: p.getVolume(),
          cVol: mod._JK_DemoGetVolume(),
          audioContextState: p.getStatus().audioContextState,
        };

        // Test adversarial boundary inputs on JS API
        const vNeg = p.setVolume(-5);
        const gotNeg = p.getVolume();
        const vHigh = p.setVolume(99);
        const gotHigh = p.getVolume();
        p.setVolume(0.35);
        const vNaN = p.setVolume(NaN);
        const gotNaN = p.getVolume();
        const vInf = p.setVolume(Infinity);
        const vNegInf = p.setVolume(-Infinity);
        const vStr = p.setVolume('not_a_number');

        // Also test direct C exports with NaN, -5.0, 99.0
        const cVolNeg = mod.ccall('JK_DemoSetVolume', 'number', ['number'], [-5.0]);
        const cVolHigh = mod.ccall('JK_DemoSetVolume', 'number', ['number'], [99.0]);
        mod.ccall('JK_DemoSetVolume', 'number', ['number'], [0.42]);
        const cVolNaN = mod.ccall('JK_DemoSetVolume', 'number', ['number'], [NaN]);

        // Restore 0.8
        p.setVolume(0.8);

        return {
          cAudioActive: mod._JK_DemoIsAudioActive(),
          samples0: st0.audioSamplesMixed,
          samples1: st1.audioSamplesMixed,
          samplesDelta: st1.audioSamplesMixed - st0.audioSamplesMixed,
          mutedState,
          v035,
          mutedWith035,
          unmutedWith035,
          boundaries: {
            vNeg, gotNeg,
            vHigh, gotHigh,
            vNaN, gotNaN,
            vInf, vNegInf, vStr,
            cVolNeg, cVolHigh, cVolNaN,
          },
        };
        """
    )

    assert res["cAudioActive"] == 1, f"Expected SDL2 audio initialized (1), got {res}"
    assert res["samples1"] > 0, f"Expected audioSamplesMixed > 0, got {res}"
    assert (
        res["samplesDelta"] > 0
    ), f"Expected audioSamplesMixed to increase over 500ms of playback, got {res}"

    assert res["mutedState"] == {"jsMuted": True, "cMuted": 1, "audioActive": False}
    assert abs(res["v035"] - 0.35) < 1e-3
    assert res["mutedWith035"]["jsMuted"] is True
    assert abs(res["mutedWith035"]["jsVol"] - 0.35) < 1e-2
    assert abs(res["mutedWith035"]["cVol"] - 0.35) < 1e-2

    assert res["unmutedWith035"]["jsMuted"] is False
    assert res["unmutedWith035"]["cMuted"] == 0
    assert abs(res["unmutedWith035"]["jsVol"] - 0.35) < 1e-2
    assert abs(res["unmutedWith035"]["cVol"] - 0.35) < 1e-2
    assert res["unmutedWith035"]["audioContextState"] == "running"

    b = res["boundaries"]
    assert b["vNeg"] == 0.0 and b["gotNeg"] == 0.0, f"-5 not clamped to 0.0: {b}"
    assert b["vHigh"] == 1.0 and b["gotHigh"] == 1.0, f"99 not clamped to 1.0: {b}"
    assert abs(b["vNaN"] - 0.35) < 1e-2 and abs(b["gotNaN"] - 0.35) < 1e-2, f"NaN corrupted volume: {b}"
    assert abs(b["vInf"] - 0.35) < 1e-2 and abs(b["vNegInf"] - 0.35) < 1e-2
    assert abs(b["vStr"] - 0.35) < 1e-2
    assert b["cVolNeg"] == 0.0, f"C JK_DemoSetVolume(-5) not clamped to 0.0: {b}"
    assert b["cVolHigh"] == 1.0, f"C JK_DemoSetVolume(99) not clamped to 1.0: {b}"
    assert abs(b["cVolNaN"] - 0.42) < 1e-2, f"C JK_DemoSetVolume(NaN) did not preserve volume: {b}"


# ==============================================================================
# 5. Demo Completion (CL_DemoCompleted) & Error Recovery via loadDemo
# ==============================================================================
def t5_c2_08_demo_completion_events_throwing_listener_and_load_demo_recovery(
    ctx: E2ETestContext,
) -> None:
    """
    Play a short demo to EOF and verify:
    1. An exception thrown inside the first onDemoComplete callback does NOT
       prevent subsequent onDemoComplete / onDemoEnded callbacks or window
       'jkdemo:ended' / 'jkdemo:complete' CustomEvents from firing.
    2. CL_DemoCompleted transitions cleanly without Com_Error(ERR_DISCONNECT)
       or unhandled pageErrors.
    3. Subsequent recovery via loadDemo('1.51ef9.dm_26') resets demoEnded to
       False, resumes active playback (isPlaying === True, serverTime > 0),
       and renders non-blank 3D WebGL frames while keeping total .pk3 bytes < 150 MB.
    """
    ctx.ensure_booted("out.dm_26")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer;

        // Synthesize a 10-packet short demo from out.dm_26 with (-1, -1) EOF marker
        if (!window.__t5ShortDemoBytes) {
          const resp = await fetch('/demos/out.dm_26');
          const fullBuf = await resp.arrayBuffer();
          const view = new DataView(fullBuf);
          let offset = 0;
          for (let i = 0; i < 10 && offset + 8 <= fullBuf.byteLength; i++) {
            const cursize = view.getInt32(offset + 4, true);
            if (cursize < 0 || offset + 8 + cursize > fullBuf.byteLength) break;
            offset += 8 + cursize;
          }
          const shortBuf = new Uint8Array(offset + 8);
          shortBuf.set(new Uint8Array(fullBuf, 0, offset), 0);
          const tail = new DataView(shortBuf.buffer, offset, 8);
          tail.setInt32(0, -1, true);
          tail.setInt32(4, -1, true);
          window.__t5ShortDemoBytes = shortBuf;

          const origFetch = window.fetch.bind(window);
          window.fetch = async function(input, init) {
            const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
            if (urlStr.includes('t5_short_eof')) {
              return new Response(window.__t5ShortDemoBytes.slice(0), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
              });
            }
            return origFetch(input, init);
          };
        }

        const captured = {
          goodCallbackDetails: [],
          endedEventDetails: [],
          completeEventDetails: [],
        };

        // Register a throwing listener first to test listener isolation
        const unsubThrow = p.onDemoComplete(() => {
          throw new Error('Intentional adversarial listener exception');
        });
        const unsubGood = p.onDemoEnded((detail) => {
          captured.goodCallbackDetails.push(detail);
        });
        window.addEventListener('jkdemo:ended', (ev) => {
          captured.endedEventDetails.push(ev.detail);
        }, { once: true });
        window.addEventListener('jkdemo:complete', (ev) => {
          captured.completeEventDetails.push(ev.detail);
        }, { once: true });

        const beforeCount = p.getStatus().demoCompletedCount;
        p.setSpeed(4.0);
        const shortLoaded = await p.loadDemo('t5_short_eof.dm_26');

        const waitStart = Date.now();
        while (Date.now() - waitStart < 25000) {
          const st = p.getStatus();
          if (
            captured.goodCallbackDetails.length > 0 &&
            captured.endedEventDetails.length > 0 &&
            st.demoEnded
          ) {
            break;
          }
          await new Promise(r => setTimeout(r, 50));
        }

        const eofStatus = p.getStatus();
        unsubThrow();
        unsubGood();

        // Now recover by loading a different map's demo (1.51ef9.dm_26 on mp/ctf_kejim) at 1.0x speed
        p.setSpeed(1.0);
        const recoveredOk = await p.loadDemo('1.51ef9.dm_26');
        await new Promise(r => setTimeout(r, 300));
        const recoveredStatus = p.getStatus();

        return {
          shortLoaded,
          beforeCount,
          eofStatus,
          captured,
          recoveredOk,
          recoveredStatus,
        };
        """,
        timeout=120.0,
    )
    ctx.current_boot_demo = "1.51ef9.dm_26"

    assert res["shortLoaded"] is True
    assert len(res["captured"]["goodCallbackDetails"]) >= 1, f"onDemoEnded callback did not fire: {res}"
    assert len(res["captured"]["endedEventDetails"]) >= 1, f"jkdemo:ended CustomEvent did not fire: {res}"
    assert len(res["captured"]["completeEventDetails"]) >= 1, f"jkdemo:complete CustomEvent did not fire: {res}"

    detail = res["captured"]["goodCallbackDetails"][0]
    assert "t5_short_eof" in str(detail.get("demoName", "")).lower()
    assert isinstance(detail.get("serverTime"), (int, float))
    assert isinstance(detail.get("frameCount"), (int, float)) and detail["frameCount"] > 0
    assert res["eofStatus"]["demoCompletedCount"] > res["beforeCount"]

    # Verify post-EOF recovery via loadDemo
    assert res["recoveredOk"] is True, f"loadDemo recovery after EOF failed: {res}"
    rec = res["recoveredStatus"]
    assert rec["isPlaying"] is True, f"Expected isPlaying=True after recovery, got {rec}"
    assert rec["demoEnded"] is False, f"Expected demoEnded=False after recovery, got {rec}"
    assert rec["serverTime"] > 0, f"Expected serverTime > 0 after recovery, got {rec}"
    assert "1.51ef9" in rec["demoName"].lower()

    snap = ctx.capture_canvas_screenshot("t5_c2_08_recovered")
    assert snap["std_rgb"] > 10.0 and snap["unique_colors"] > 500, f"Blank frame after recovery: {snap}"

    # Verify cumulative .pk3 HTTP transfer stayed strictly < 150 MB with 0 full downloads
    metrics = ctx.get_metrics()
    assert metrics["pk3FullRequests"] == 0, f"Unexpected full .pk3 download: {metrics}"
    assert (
        0 < metrics["pk3BytesTransferred"] < 150 * 1024 * 1024
    ), f"PK3 transfer {metrics['pk3BytesTransferred']:,} B exceeded 150 MB budget"

    logs = ctx.get_browser_logs()
    assert len(logs["pageErrors"]) == 0, f"Unhandled pageErrors detected: {logs['pageErrors']}"


def main() -> int:
    port = find_free_port()
    ctx = E2ETestContext(port=port)
    tests: List[ tuple[str, Callable[[E2ETestContext], None]] ] = [
        ("T5_C2_01_wasm_static_archives_and_symbol_isolation", t5_c2_01_wasm_static_archives_and_symbol_isolation),
        ("T5_C2_02_native_x86_64_binaries_elf_and_ldd_isolation", t5_c2_02_native_x86_64_binaries_elf_and_ldd_isolation),
        ("T5_C2_03_cold_boot_url_query_params_out_speed2_muted1", t5_c2_03_cold_boot_url_query_params_out_speed2_muted1),
        ("T5_C2_04_jkdemoconfig_precedence_and_adversarial_query_inputs", t5_c2_04_jkdemoconfig_precedence_and_adversarial_query_inputs),
        ("T5_C2_05_pause_2_seconds_resume_no_server_time_jump", t5_c2_05_pause_2_seconds_resume_no_server_time_jump),
        ("T5_C2_06_pause_2_seconds_at_4x_speed_resume_no_time_jump", t5_c2_06_pause_2_seconds_at_4x_speed_resume_no_time_jump),
        ("T5_C2_07_sdl2_dma_audio_mixing_and_boundary_fuzzing", t5_c2_07_sdl2_dma_audio_mixing_and_boundary_fuzzing),
        ("T5_C2_08_demo_completion_events_throwing_listener_and_load_demo_recovery", t5_c2_08_demo_completion_events_throwing_listener_and_load_demo_recovery),
    ]

    print("=" * 92)
    print(f"OpenJK Tier 5 White-Box Adversarial Stress Suite (Challenger #2) — Port {port}")
    print("=" * 92)

    passed = 0
    failed = 0
    suite_start = time.time()

    try:
        for idx, (name, fn) in enumerate(tests, 1):
            t0 = time.time()
            try:
                fn(ctx)
                ms = (time.time() - t0) * 1000.0
                print(f"[{idx:2d}/{len(tests):2d}] [PASS] {name} ({ms:.0f} ms)", flush=True)
                passed += 1
            except Exception as exc:
                ms = (time.time() - t0) * 1000.0
                print(f"[{idx:2d}/{len(tests):2d}] [FAIL] {name} ({ms:.0f} ms): {exc}", flush=True)
                failed += 1
    finally:
        ctx.close()

    total_s = time.time() - suite_start
    print("-" * 92)
    print(f"SUMMARY: {passed}/{len(tests)} passed ({failed} failed) in {total_s:.1f}s")
    print("=" * 92)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
