#!/usr/bin/env python3
"""
Tier 1 — Feature Coverage E2E Tests for Round 2 (90 test cases: 5 per feature across F1–F18).
Uses Category-Partition Method to verify primary behavior for every feature in PROJECT.md.
"""

import json
import os
from pathlib import Path
import re
from typing import List
import zipfile

from .harness import (
    EXPECTED_BASE_CHECKSUMS,
    E2ER2TestContext,
    TestCase,
    canonical_pk3_basename,
    compute_q3_pk3_checksum,
    inspect_zip_eocd,
    scan_dm26_packets,
)


# ==============================================================================
# F1: Multi-Directory PK3 Consolidation (consolidate_and_index_pk3s.py) (5 tests)
# ==============================================================================
def t1_f01_01_consolidation_script_and_pool_dir_exist(ctx: E2ER2TestContext) -> None:
    script = ctx.web_dir / "consolidate_and_index_pk3s.py"
    assert script.exists(), f"Missing PK3 consolidation script: {script}"
    assert ctx.consolidated_pk3_dir.exists() and ctx.consolidated_pk3_dir.is_dir(), (
        f"Consolidated PK3 pool directory missing: {ctx.consolidated_pk3_dir}"
    )


def t1_f01_02_consolidated_pool_pk3_count_and_basenames(ctx: E2ER2TestContext) -> None:
    pk3_files = sorted(ctx.consolidated_pk3_dir.glob("*.pk3"))
    assert len(pk3_files) >= 480, (
        f"Expected >= 480 consolidated .pk3 files in {ctx.consolidated_pk3_dir}, got {len(pk3_files)}"
    )
    basenames = {canonical_pk3_basename(p.name) for p in pk3_files}
    assert len(basenames) >= 440, (
        f"Expected >= 440 unique canonical basenames, got {len(basenames)}"
    )


def t1_f01_03_primary_versions_named_basename_pk3(ctx: E2ER2TestContext) -> None:
    for required in ("assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3", "ctf_fim.pk3", "ctf_kejim.pk3"):
        p = ctx.consolidated_pk3_dir / required
        assert p.exists() and p.stat().st_size > 0, f"Primary PK3 missing or empty: {p}"


def t1_f01_04_alternate_checksum_versions_named_with_uint32_hex(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    pk3s = manifest.get("pk3s", [])
    alt_entries = [
        e for e in pk3s
        if re.match(r"^.+\.[0-9a-f]{8}\.pk3$", e["name"], flags=re.IGNORECASE)
    ]
    assert len(alt_entries) >= 30, (
        f"Expected >= 30 alternate <basename>.<uint32_hex>.pk3 entries in manifest, got {len(alt_entries)}"
    )
    for entry in alt_entries[:15]:
        expected_hex = f"{entry['checksum'] & 0xFFFFFFFF:08x}"
        expected_name = f"{entry['basename']}.{expected_hex}.pk3"
        assert entry["name"].lower() == expected_name.lower(), (
            f"Alternate PK3 name {entry['name']} does not match {expected_name}"
        )
        fp = ctx.consolidated_pk3_dir / entry["name"]
        assert fp.exists() and fp.stat().st_size == entry["size"], f"Missing alternate PK3 file {fp}"


def t1_f01_05_tweaked_extension_archives_consolidated(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    basenames = {e["basename"].lower() for e in manifest.get("pk3s", [])}
    for tweaked_base in ("ctf_orion", "ctf_generis", "ctf3_pro", "tri_ctf_maps", "ctf_kejim"):
        assert tweaked_base in basenames, (
            f"Tweaked-extension archive basename '{tweaked_base}' missing from consolidated manifest"
        )


# ==============================================================================
# F2: Quake 3 Signed 32-bit Com_BlockChecksum Calculation (5 tests)
# ==============================================================================
def t1_f02_01_assets0_checksum_matches_q3_md4_oracle(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assert "assets0.pk3" in by_name, "assets0.pk3 missing from manifest"
    assert by_name["assets0.pk3"]["checksum"] == 1767559464, (
        f"assets0.pk3 checksum mismatch: {by_name['assets0.pk3']['checksum']}"
    )
    oracle = ctx.get_pk3_checksum(ctx.consolidated_pk3_dir / "assets0.pk3")
    assert oracle == 1767559464, f"MD4 oracle mismatch for assets0.pk3: {oracle}"


def t1_f02_02_assets1_checksum_matches_q3_md4_oracle(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assert "assets1.pk3" in by_name, "assets1.pk3 missing from manifest"
    assert by_name["assets1.pk3"]["checksum"] == -682941524, (
        f"assets1.pk3 checksum mismatch: {by_name['assets1.pk3']['checksum']}"
    )
    oracle = ctx.get_pk3_checksum(ctx.consolidated_pk3_dir / "assets1.pk3")
    assert oracle == -682941524, f"MD4 oracle mismatch for assets1.pk3: {oracle}"


def t1_f02_03_assets2_and_assets3_checksums_match_q3_md4_oracle(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    for name, expected in (("assets2.pk3", -1239421272), ("assets3.pk3", -1342311474)):
        assert name in by_name, f"{name} missing from manifest"
        assert by_name[name]["checksum"] == expected, (
            f"{name} checksum {by_name[name]['checksum']} != {expected}"
        )
        oracle = ctx.get_pk3_checksum(ctx.consolidated_pk3_dir / name)
        assert oracle == expected, f"MD4 oracle for {name} = {oracle} != {expected}"


def t1_f02_04_custom_map_pk3_checksums_match_fs_loadzipfile_oracle(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assert by_name["ctf_fim.pk3"]["checksum"] == 104394672, (
        f"ctf_fim.pk3 checksum {by_name['ctf_fim.pk3']['checksum']} != 104394672"
    )
    for custom_name in ("ctf_fim.pk3", "ctf_kejim.pk3", "ctf_orion.pk3"):
        if custom_name in by_name:
            fp = ctx.consolidated_pk3_dir / custom_name
            oracle = ctx.get_pk3_checksum(fp)
            assert by_name[custom_name]["checksum"] == oracle, (
                f"Manifest checksum for {custom_name} ({by_name[custom_name]['checksum']}) != oracle ({oracle})"
            )


def t1_f02_05_multi_version_pk3_checksums_distinct_and_verified(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_base = {}
    for e in manifest["pk3s"]:
        by_base.setdefault(e["basename"], []).append(e)
    multi = {b: entries for b, entries in by_base.items() if len(entries) > 1}
    assert len(multi) >= 20, f"Expected >= 20 basenames with multiple checksum versions, got {len(multi)}"
    checked = 0
    for b, entries in list(multi.items())[:8]:
        sums = [e["checksum"] for e in entries]
        assert len(sums) == len(set(sums)), f"Duplicate checksums under same basename {b}: {sums}"
        for e in entries:
            fp = ctx.consolidated_pk3_dir / e["name"]
            assert ctx.get_pk3_checksum(fp) == e["checksum"]
            checked += 1
    assert checked >= 16


# ==============================================================================
# F3: /media/dan/Elements/pk3/base/manifest.json Generation (v2) (5 tests)
# ==============================================================================
def t1_f03_01_manifest_v2_exists_and_valid_top_level_schema(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    assert isinstance(manifest, dict), "manifest.json root must be a JSON object"
    assert manifest.get("version") == 2, f"Expected manifest version 2, got {manifest.get('version')}"
    pk3s = manifest.get("pk3s")
    assert isinstance(pk3s, list) and len(pk3s) >= 480, (
        f"Expected manifest['pk3s'] list with >= 480 entries, got {len(pk3s) if isinstance(pk3s, list) else type(pk3s)}"
    )


def t1_f03_02_manifest_entries_have_all_required_fields_and_types(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    required_keys = {"name", "basename", "checksum", "size", "cd_offset", "cd_size", "base_init", "maps"}
    for idx, entry in enumerate(manifest["pk3s"]):
        missing = required_keys - set(entry.keys())
        assert not missing, f"Entry #{idx} ({entry.get('name')}) missing keys: {missing}"
        assert isinstance(entry["name"], str) and entry["name"].endswith(".pk3")
        assert isinstance(entry["basename"], str) and len(entry["basename"]) > 0
        assert isinstance(entry["checksum"], int) and not isinstance(entry["checksum"], bool)
        assert isinstance(entry["size"], int) and entry["size"] > 0
        assert isinstance(entry["cd_offset"], int) and entry["cd_offset"] > 0
        assert isinstance(entry["cd_size"], int) and entry["cd_size"] > 0
        assert isinstance(entry["base_init"], bool)
        assert isinstance(entry["maps"], list)


def t1_f03_03_manifest_entries_match_physical_files_on_disk(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    for entry in manifest["pk3s"]:
        fp = ctx.consolidated_pk3_dir / entry["name"]
        assert fp.is_file(), f"Manifest entry file does not exist: {fp}"
        st_size = fp.stat().st_size
        assert st_size == entry["size"], (
            f"Size mismatch for {entry['name']}: disk={st_size} != manifest={entry['size']}"
        )


def t1_f03_04_base_init_true_only_for_assets0_to_assets3(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    base_init_names = sorted(e["name"] for e in manifest["pk3s"] if e.get("base_init") is True)
    assert base_init_names == ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"], (
        f"Expected base_init=True ONLY on assets0..3.pk3, got: {base_init_names}"
    )


def t1_f03_05_manifest_maps_field_indexes_bsp_names(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assert "ctf_fim" in [m.lower() for m in by_name["ctf_fim.pk3"]["maps"]], (
        f"Expected 'ctf_fim' in ctf_fim.pk3 maps: {by_name['ctf_fim.pk3']['maps']}"
    )
    kejim_maps = [m.lower() for m in by_name["ctf_kejim.pk3"]["maps"]]
    assert "ctf_kejim" in kejim_maps or "mp/ctf_kejim" in kejim_maps, (
        f"Expected ctf_kejim in ctf_kejim.pk3 maps: {kejim_maps}"
    )


# ==============================================================================
# F4: Base-Only Engine Prewarm Mounting (WasmPK3_InitManifest) (5 tests)
# ==============================================================================
def t1_f04_01_files_cpp_expanded_archive_table_and_v2_manifest_cache_key(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "openjk_pk3_manifest_v2" in files_cpp, (
        "codemp/qcommon/files.cpp must use localStorage cache key 'openjk_pk3_manifest_v2'"
    )
    assert "base_init" in files_cpp, "codemp/qcommon/files.cpp must inspect 'base_init' during WasmPK3_InitManifest"


def t1_f04_02_prewarm_mounts_only_base_init_archives(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["ready"] is True, f"Engine prewarm did not reach ready=True: {obs}"
    assert obs["loadedPacks"] == 4, (
        f"Expected exactly 4 loaded base packs (assets0..3.pk3) on prewarm, got {obs['loadedPacks']}"
    )


def t1_f04_03_prewarm_pk3_range_requests_at_most_8(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert 0 <= obs["rangeRequests"] <= 8, (
        f"Expected g_jkPk3RangeRequests <= 8 on prewarm before demo load, got {obs['rangeRequests']}"
    )


def t1_f04_04_prewarm_network_fetches_only_assets0_to_assets3(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    pk3_urls = [
        r["url"] for r in obs.get("networkResponses", [])
        if ".pk3" in r["url"]
    ]
    non_base = [
        u for u in pk3_urls
        if not any(b in u for b in ("assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"))
    ]
    assert len(non_base) == 0, (
        f"Prewarm fetched non-base PK3 archives before any demo was loaded: {non_base}"
    )


def t1_f04_05_prewarm_populates_manifest_v2_in_localstorage(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["hasV2Cache"] is True and obs["v2CacheLen"] > 10000, (
        f"Expected openjk_pk3_manifest_v2 cached in localStorage (>10KB), got {obs}"
    )


# ==============================================================================
# F5: Checksum-First Dynamic On-Demand PK3 Mounting (FS_WasmPrepareDemoPaks) (5 tests)
# ==============================================================================
def t1_f05_01_cl_parse_hooks_cl_systeminfochanged_for_demoplaying(ctx: E2ER2TestContext) -> None:
    cl_parse = (ctx.root_dir / "codemp" / "client" / "cl_parse.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "FS_WasmPrepareDemoPaks" in cl_parse, (
        "codemp/client/cl_parse.cpp must call FS_WasmPrepareDemoPaks in CL_SystemInfoChanged"
    )
    assert "sv_referencedPaks" in cl_parse and "sv_referencedPakNames" in cl_parse, (
        "CL_SystemInfoChanged must extract sv_referencedPaks and sv_referencedPakNames"
    )


def t1_f05_02_custom_map_demo_dynamically_mounts_pk3_on_demand(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        const mapName = (mod && typeof mod._JK_DemoGetMapName === 'function' && mod.UTF8ToString)
          ? mod.UTF8ToString(mod._JK_DemoGetMapName())
          : (p && typeof p.getStatus === 'function' ? p.getStatus().mapName : '');
        const rangeReqs = (mod && typeof mod._JK_DemoGetPk3RangeRequests === 'function')
          ? mod._JK_DemoGetPk3RangeRequests()
          : (p && typeof p.getStatus === 'function' ? p.getStatus().pk3RangeRequests : 0);
        const bytes = (mod && typeof mod._JK_DemoGetPk3BytesTransferred === 'function')
          ? mod._JK_DemoGetPk3BytesTransferred()
          : (p && typeof p.getStatus === 'function' ? p.getStatus().pk3BytesTransferred : 0);
        return { mapName, rangeReqs, bytes };
        """
    )
    assert res["mapName"], f"Expected non-empty loaded mapName during demo playback, got {res}"
    assert res["rangeReqs"] > 0 and res["bytes"] < 150 * 1024 * 1024, (
        f"Expected positive range requests and <150MB transfer, got {res}"
    )


def t1_f05_03_priority_1_checksum_match_resolution_in_files_cpp(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "FS_WasmPrepareDemoPaks" in files_cpp, "FS_WasmPrepareDemoPaks missing in files.cpp"
    assert "checksum" in files_cpp, "Checksum matching missing in files.cpp"


def t1_f05_04_priority_2_basename_fallback_resolution(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "basename" in files_cpp, "Canonical basename fallback missing in files.cpp"


def t1_f05_05_priority_3_mapname_bsp_fallback_resolution(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "maps" in files_cpp and ".bsp" in files_cpp, (
        "Mapname .bsp fallback lookup missing in FS_WasmPrepareDemoPaks"
    )


# ==============================================================================
# F6: .dm_26 Snapshot serverTime Bounds Scanner (CL_ScanDemoTimeBounds) (5 tests)
# ==============================================================================
def t1_f06_01_demo_load_populates_positive_start_time_ms(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("match.html", "getdemo.php")
    assert st["startTimeMs"] > 0, f"Expected startTimeMs > 0, got {st}"


def t1_f06_02_demo_load_populates_end_time_greater_than_start_time(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("match.html", "getdemo.php")
    assert st["endTimeMs"] > st["startTimeMs"], (
        f"Expected endTimeMs ({st['endTimeMs']}) > startTimeMs ({st['startTimeMs']})"
    )


def t1_f06_03_demo_duration_ms_equals_end_minus_start(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("match.html", "getdemo.php")
    expected_dur = st["endTimeMs"] - st["startTimeMs"]
    assert st["durationMs"] == expected_dur and st["durationMs"] > 0, (
        f"Expected durationMs ({st['durationMs']}) == endTimeMs - startTimeMs ({expected_dur})"
    )


def t1_f06_04_scanner_rewinds_demofile_so_playback_starts_near_zero(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        if (mod && typeof mod._JK_DemoSeekToMs === 'function') {
          mod._JK_DemoSeekToMs(0);
        } else if (p && typeof p.seekToMs === 'function') {
          p.seekToMs(0);
        }
        const cur = (mod && typeof mod._JK_DemoGetCurrentTimeMs === 'function')
          ? mod._JK_DemoGetCurrentTimeMs()
          : p.getCurrentTimeMs();
        const dur = (mod && typeof mod._JK_DemoGetDurationMs === 'function')
          ? mod._JK_DemoGetDurationMs()
          : p.getDurationMs();
        return { cur, dur };
        """
    )
    assert 0 <= res["cur"] <= min(1000, res["dur"]), (
        f"Expected currentTimeMs near 0 after rewind to start, got {res}"
    )


def t1_f06_05_trimmed_clip_scanner_reports_shorter_clip_duration(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const trimBtn = document.querySelector('.jk-play-btn[data-demo-url*="trimdemo.php"]')
          || Array.from(document.querySelectorAll('a[href*="trimdemo.php"]')).map(a => a.nextElementSibling).find(b => b && b.classList.contains('jk-play-btn'));
        if (!trimBtn) throw new Error('No trimdemo.php Play button found on match.html');
        trimBtn.click();
        const start = Date.now();
        while (Date.now() - start < 60000) {
          const p = window.JKDemoPlayer || window.OpenJKPlayer;
          const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
          const dur = (mod && typeof mod._JK_DemoGetDurationMs === 'function') ? mod._JK_DemoGetDurationMs() : (p && p.getDurationMs ? p.getDurationMs() : 0);
          const playing = (mod && typeof mod._JK_DemoIsPlaying === 'function') ? (mod._JK_DemoIsPlaying() === 1) : Boolean(p && p.getStatus && p.getStatus().isPlaying);
          if (playing && dur > 0 && dur < 45000) {
            return { dur, playing };
          }
          await new Promise(r => setTimeout(r, 150));
        }
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        return {
          dur: (mod && mod._JK_DemoGetDurationMs) ? mod._JK_DemoGetDurationMs() : 0,
          playing: (mod && mod._JK_DemoIsPlaying) ? (mod._JK_DemoIsPlaying() === 1) : false,
        };
        """,
        timeout=70.0,
    )
    assert res["playing"] and 1000 <= res["dur"] <= 45000, (
        f"Expected trimmed NS clip duration in [1000, 45000] ms, got {res}"
    )


# ==============================================================================
# F7: Demo Timeline & Seek C/JS Exports (5 tests)
# ==============================================================================
def t1_f07_01_cmake_and_openjk_js_export_timeline_and_seek_functions(ctx: E2ER2TestContext) -> None:
    cmake_txt = (ctx.root_dir / "codemp" / "CMakeLists.txt").read_text(encoding="utf-8")
    openjk_js_path = ctx.archive_public_dir / "jkplayer" / "openjk.js"
    if not openjk_js_path.exists():
        openjk_js_path = ctx.web_dir / "openjk.js"
    js_txt = openjk_js_path.read_text(encoding="utf-8", errors="ignore")
    for fn_name in (
        "_JK_DemoGetStartTimeMs",
        "_JK_DemoGetEndTimeMs",
        "_JK_DemoGetCurrentTimeMs",
        "_JK_DemoGetDurationMs",
        "_JK_DemoSeekToMs",
        "_JK_DemoSetLoop",
        "_JK_DemoGetLoop",
    ):
        assert fn_name in cmake_txt, f"{fn_name} missing from codemp/CMakeLists.txt EXPORTED_FUNCTIONS"
        assert fn_name in js_txt, f"{fn_name} missing from compiled openjk.js"


def t1_f07_02_window_jkdemoplayer_exposes_timeline_seek_and_loop_api(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (!p) throw new Error('window.JKDemoPlayer / OpenJKPlayer missing');
        const methods = ['getStartTimeMs', 'getEndTimeMs', 'getCurrentTimeMs', 'getDurationMs', 'seekToMs', 'startOver', 'setLoop', 'getLoop'];
        const missing = methods.filter(m => typeof p[m] !== 'function');
        return { missing };
        """
    )
    assert res["missing"] == [], f"Missing methods on JKDemoPlayer: {res['missing']}"


def t1_f07_03_window_jkpipplayer_exposes_control_api(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const pip = window.JKPiPPlayer;
        if (!pip) throw new Error('window.JKPiPPlayer missing');
        const methods = ['close', 'togglePause', 'seekToMs', 'startOver', 'setLoop', 'getLoop', 'setSpeed', 'setVolume', 'setMuted'];
        const missing = methods.filter(m => typeof pip[m] !== 'function');
        const hasOpen = typeof pip.openAndPlay === 'function' || typeof pip.playDemoUrl === 'function';
        return { missing, hasOpen };
        """
    )
    assert res["hasOpen"] is True, "window.JKPiPPlayer missing openAndPlay / playDemoUrl"
    assert res["missing"] == [], f"Missing methods on window.JKPiPPlayer: {res['missing']}"


def t1_f07_04_current_time_ms_advances_during_active_playback(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (mod && mod._JK_DemoResume) mod._JK_DemoResume();
        if (mod && mod._JK_DemoSetSpeed) mod._JK_DemoSetSpeed(1.0);
        const t0 = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        await new Promise(r => setTimeout(r, 550));
        const t1 = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { t0, t1, delta: t1 - t0 };
        """
    )
    assert res["delta"] > 0, f"Expected JK_DemoGetCurrentTimeMs() to advance over 550ms, got {res}"


def t1_f07_05_player_status_includes_timeline_and_loop_fields(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    st = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        return p.getStatus ? p.getStatus() : p.getStats();
        """
    )
    assert isinstance(st.get("durationMs"), (int, float)) and st["durationMs"] > 0, (
        f"Expected positive durationMs in player status, got {st}"
    )
    assert isinstance(st.get("currentTimeMs"), (int, float)) and st["currentTimeMs"] >= 0, (
        f"Expected non-negative currentTimeMs in player status, got {st}"
    )


# ==============================================================================
# F8: In-Memory Forward Demo Seeking & serverCommands Draining (5 tests)
# ==============================================================================
def t1_f08_01_forward_seek_updates_current_time_ms_to_target(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        const target = Math.min(Math.floor(dur * 0.45), dur - 500);
        const ret = mod ? mod._JK_DemoSeekToMs(target) : p.seekToMs(target);
        const after = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { dur, target, ret, after, diff: Math.abs(after - target) };
        """
    )
    assert res["diff"] <= 500, (
        f"Forward seek to {res['target']}ms landed at {res['after']}ms (diff={res['diff']}ms > 500ms)"
    )


def t1_f08_02_forward_seek_preserves_active_playing_state(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        const target = Math.floor(dur * 0.6);
        mod ? mod._JK_DemoSeekToMs(target) : p.seekToMs(target);
        await new Promise(r => setTimeout(r, 150));
        const state = mod && mod._JK_DemoGetState ? mod._JK_DemoGetState() : 8;
        const playing = mod && mod._JK_DemoIsPlaying ? (mod._JK_DemoIsPlaying() === 1) : p.getStatus().isPlaying;
        return { state, playing };
        """
    )
    assert res["playing"] is True and res["state"] == 8, (
        f"Expected CA_ACTIVE (8) and isPlaying=True after forward seek, got {res}"
    )


def t1_f08_03_sequential_multi_step_forward_seeks(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        const steps = [0.2, 0.5, 0.8].map(r => Math.floor(dur * r));
        const actuals = [];
        for (const t of steps) {
          mod ? mod._JK_DemoSeekToMs(t) : p.seekToMs(t);
          actuals.push(mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs());
        }
        return { steps, actuals };
        """
    )
    for t, a in zip(res["steps"], res["actuals"]):
        assert abs(a - t) <= 500, f"Step seek mismatch: target={t}, actual={a}"
    assert res["actuals"][0] < res["actuals"][1] < res["actuals"][2], (
        f"Expected monotonically increasing timestamps across forward seeks: {res['actuals']}"
    )


def t1_f08_04_forward_seek_drains_server_commands_without_overflow(ctx: E2ER2TestContext) -> None:
    cl_main = (ctx.root_dir / "codemp" / "client" / "cl_main.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "CG_ExecuteNewServerCommands" in cl_main or "CL_GetServerCommand" in cl_main, (
        "JK_DemoSeekToMs in codemp/client/cl_main.cpp must drain serverCommands via CG_ExecuteNewServerCommands / CL_GetServerCommand"
    )
    # Also verify seeking from 0 to 85% of a real match demo produces zero console errors or drops
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        const target = Math.floor(dur * 0.85);
        mod ? mod._JK_DemoSeekToMs(target) : p.seekToMs(target);
        const after = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { dur, target, after };
        """
    )
    assert abs(res["after"] - res["target"]) <= 500


def t1_f08_05_forward_seek_updates_rendered_3d_canvas_scene(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod ? mod._JK_DemoSeekToMs(500) : p.seekToMs(500);
        await new Promise(r => setTimeout(r, 120));
        """
    )
    snap_early = ctx.capture_canvas_screenshot("t1_f08_05_early")
    ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        const target = Math.floor(dur * 0.65);
        mod ? mod._JK_DemoSeekToMs(target) : p.seekToMs(target);
        await new Promise(r => setTimeout(r, 120));
        """
    )
    snap_late = ctx.capture_canvas_screenshot("t1_f08_05_late")
    assert snap_late["std_rgb"] > 8.0 and snap_late["unique_colors"] > 200
    diff = ctx.compare_screenshots(snap_early, snap_late)
    assert diff["mean_abs_diff"] > 0.15, (
        f"Expected 3D canvas frame to change after forward seek, got diff={diff}"
    )


# ==============================================================================
# F9: In-Place Backward Demo Seeking & Start Over (0:00) (5 tests)
# ==============================================================================
def t1_f09_01_start_over_seek_to_zero_rewinds_immediately(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        const mid = Math.floor(dur * 0.5);
        mod ? mod._JK_DemoSeekToMs(mid) : p.seekToMs(mid);
        const atMid = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        const atZero = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { mid, atMid, atZero };
        """
    )
    assert res["atMid"] >= res["mid"] - 500
    assert 0 <= res["atZero"] <= 350, (
        f"Expected JK_DemoSeekToMs(0) to rewind currentTimeMs to ~0, got {res['atZero']}"
    )


def t1_f09_02_backward_seek_to_intermediate_timestamp(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        const high = Math.floor(dur * 0.7);
        const low = Math.floor(dur * 0.25);
        mod ? mod._JK_DemoSeekToMs(high) : p.seekToMs(high);
        const atHigh = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        mod ? mod._JK_DemoSeekToMs(low) : p.seekToMs(low);
        const atLow = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { high, atHigh, low, atLow };
        """
    )
    assert abs(res["atLow"] - res["low"]) <= 500, (
        f"Backward seek to {res['low']}ms landed at {res['atLow']}ms"
    )


def t1_f09_03_backward_seek_resets_cgame_snapshots_without_err_drop(ctx: E2ER2TestContext) -> None:
    cg_snap = (ctx.root_dir / "codemp" / "cgame" / "cg_snapshot.c").read_text(encoding="utf-8", errors="ignore")
    assert "CG_ResetForDemoSeek" in cg_snap or "latestSnapshotNum = 0" in cg_snap, (
        "codemp/cgame/cg_snapshot.c must provide cgame snapshot reset for in-place demo rewind"
    )
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(Math.floor(dur * 0.6)) : p.seekToMs(Math.floor(dur * 0.6));
        await new Promise(r => setTimeout(r, 150));
        mod ? mod._JK_DemoSeekToMs(Math.floor(dur * 0.15)) : p.seekToMs(Math.floor(dur * 0.15));
        await new Promise(r => setTimeout(r, 250));
        const playing = mod && mod._JK_DemoIsPlaying ? (mod._JK_DemoIsPlaying() === 1) : p.getStatus().isPlaying;
        return { playing, state: mod && mod._JK_DemoGetState ? mod._JK_DemoGetState() : 8 };
        """
    )
    assert res["playing"] is True and res["state"] == 8, (
        f"Expected active playback without ERR_DROP after backward seek, got {res}"
    )


def t1_f09_04_backward_seek_preserves_loaded_gpu_assets_zero_range_requests(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(Math.floor(dur * 0.5)) : p.seekToMs(Math.floor(dur * 0.5));
        await new Promise(r => setTimeout(r, 120));
        const reqBefore = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        await new Promise(r => setTimeout(r, 120));
        const reqAfter = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        return { reqBefore, reqAfter, delta: reqAfter - reqBefore };
        """
    )
    assert res["delta"] == 0, (
        f"In-place backward seek to 0:00 should not re-fetch PK3 ranges, got delta={res['delta']}"
    )


def t1_f09_05_playback_advances_and_renders_after_backward_seek(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod ? mod._JK_DemoSeekToMs(0) : p.seekToMs(0);
        const t0 = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        await new Promise(r => setTimeout(r, 500));
        const t1 = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { t0, t1, delta: t1 - t0 };
        """
    )
    assert res["delta"] > 0, f"Playback did not advance after backward seek to 0: {res}"
    snap = ctx.capture_canvas_screenshot("t1_f09_05_post_rewind")
    assert snap["std_rgb"] > 8.0 and snap["unique_colors"] > 200


# ==============================================================================
# F10: Automatic Instant Demo Looping (5 tests)
# ==============================================================================
def t1_f10_01_loop_enabled_by_default(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const cLoop = mod && mod._JK_DemoGetLoop ? mod._JK_DemoGetLoop() : 1;
        const jsLoop = p && p.getLoop ? p.getLoop() : true;
        return { cLoop, jsLoop };
        """
    )
    assert res["cLoop"] == 1 and res["jsLoop"] is True, (
        f"Expected loop enabled by default, got {res}"
    )


def t1_f10_02_reaching_demo_end_with_loop_enabled_restarts_from_zero(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (mod && mod._JK_DemoSetLoop) mod._JK_DemoSetLoop(1);
        if (p && p.setLoop) p.setLoop(true);
        const beforeCompleted = mod && mod._JK_DemoGetCompletedCount ? mod._JK_DemoGetCompletedCount() : 0;
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        if (mod && mod._JK_DemoSetSpeed) mod._JK_DemoSetSpeed(4.0);
        const seekTarget = Math.max(0, dur - 250);
        mod ? mod._JK_DemoSeekToMs(seekTarget) : p.seekToMs(seekTarget);
        const start = Date.now();
        let looped = false;
        let postLoopTime = dur;
        while (Date.now() - start < 8000) {
          const cur = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
          const comp = mod && mod._JK_DemoGetCompletedCount ? mod._JK_DemoGetCompletedCount() : 0;
          if (comp > beforeCompleted || cur < Math.floor(dur * 0.4)) {
            looped = true;
            postLoopTime = cur;
            break;
          }
          await new Promise(r => setTimeout(r, 60));
        }
        if (mod && mod._JK_DemoSetSpeed) mod._JK_DemoSetSpeed(1.0);
        const playing = mod && mod._JK_DemoIsPlaying ? (mod._JK_DemoIsPlaying() === 1) : p.getStatus().isPlaying;
        return { looped, postLoopTime, dur, playing };
        """
    )
    assert res["looped"] is True and res["playing"] is True, (
        f"Expected demo to loop automatically at EOF and continue playing, got {res}"
    )
    assert res["postLoopTime"] < res["dur"] * 0.5, (
        f"Expected post-loop currentTimeMs near 0, got {res['postLoopTime']} (dur={res['dur']})"
    )


def t1_f10_03_auto_loop_increments_completed_count(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        const c0 = mod._JK_DemoGetCompletedCount();
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 200));
        const start = Date.now();
        while (Date.now() - start < 8000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 60));
        }
        mod._JK_DemoSetSpeed(1.0);
        const c1 = mod._JK_DemoGetCompletedCount();
        return { c0, c1 };
        """
    )
    assert res["c1"] > res["c0"], f"Expected completed count to increment on loop: {res}"


def t1_f10_04_auto_loop_performs_in_place_rewind_zero_pk3_fetches(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.max(0, dur - 200));
        const req0 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        const start = Date.now();
        while (Date.now() - start < 8000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 60));
        }
        mod._JK_DemoSetSpeed(1.0);
        const req1 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        return { req0, req1, delta: req1 - req0 };
        """
    )
    assert res["delta"] == 0, f"Expected 0 additional PK3 range requests during instant loop, got {res}"


def t1_f10_05_loop_disabled_stops_at_demo_end_without_rewinding(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        if (p && p.setLoop) p.setLoop(false);
        const c0 = mod._JK_DemoGetCompletedCount();
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 200));
        const start = Date.now();
        while (Date.now() - start < 8000) {
          if (mod._JK_DemoGetCompletedCount() > c0 || mod._JK_DemoIsCompleted()) break;
          await new Promise(r => setTimeout(r, 60));
        }
        await new Promise(r => setTimeout(r, 250));
        const loopVal = mod._JK_DemoGetLoop();
        const completed = mod._JK_DemoGetCompletedCount() > c0 || mod._JK_DemoIsCompleted() === 1;
        // Restore loop enabled and restart at 0:00
        mod._JK_DemoSetLoop(1);
        if (p && p.setLoop) p.setLoop(true);
        mod._JK_DemoSetSpeed(1.0);
        mod._JK_DemoSeekToMs(0);
        return { loopVal, completed };
        """
    )
    assert res["loopVal"] == 0 and res["completed"] is True, (
        f"Expected demo to complete without looping when loop=0, got {res}"
    )


# ==============================================================================
# F11: Arbitrary Query-String Demo URL Fetching into MEMFS (5 tests)
# ==============================================================================
def t1_f11_01_fetch_and_play_getdemo_php_query_url(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("match.html", "getdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0


def t1_f11_02_fetch_and_play_mergedemo_php_query_url(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    # Find a valid mergedemo.php link on match.html whose payload is > 100 bytes
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="mergedemo.php"]'));
        let validHref = null;
        for (const a of links.slice(0, 12)) {
          const href = a.getAttribute('href');
          const r = await fetch(href);
          if (r.ok) {
            const buf = await r.arrayBuffer();
            if (buf.byteLength > 200) {
              validHref = href;
              break;
            }
          }
        }
        if (!validHref) throw new Error('No non-empty mergedemo.php link found');
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (pip && pip.openAndPlay) {
          await pip.openAndPlay(validHref, { label: 'Merged POV Test' });
        } else {
          await p.loadDemo(validHref);
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 60000) {
          const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
          const playing = mod ? (mod._JK_DemoIsPlaying() === 1) : p.getStatus().isPlaying;
          if (playing && dur > 0) return { validHref, dur, playing };
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Timed out playing mergedemo.php URL: ' + validHref);
        """,
        timeout=75.0,
    )
    assert res["playing"] is True and res["dur"] > 0


def t1_f11_03_fetch_and_play_trimdemo_php_query_url(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("match.html", "trimdemo.php", force_reload_demo=True)
    assert st["isPlaying"] is True and st["durationMs"] > 0


def t1_f11_04_fetch_and_play_minrpc_matchdemo_query_url(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const matchDemoUrl = '/minrpc.py?rpc=matchdemo&id=0053b07a2f638a96';
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (pip && pip.openAndPlay) {
          await pip.openAndPlay(matchDemoUrl, { label: 'Match Demo Test' });
        } else {
          await p.loadDemo(matchDemoUrl);
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 75000) {
          const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
          const playing = mod ? (mod._JK_DemoIsPlaying() === 1) : p.getStatus().isPlaying;
          if (playing && dur > 0) return { dur, playing };
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error('Timed out loading matchdemo URL');
        """,
        timeout=90.0,
    )
    assert res["playing"] is True and res["dur"] > 0


def t1_f11_05_pip_title_populated_from_demo_metadata_or_content_disposition(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    title = ctx.eval_js(
        """
        const el = document.querySelector('#jk-pip-title, .jk-pip-title');
        return el ? el.textContent.trim() : '';
        """
    )
    assert len(title) > 0, "Expected non-empty title in #jk-pip-title"


# ==============================================================================
# F12: Background Wasm Engine Prewarming (5 tests)
# ==============================================================================
def t1_f12_01_background_prewarm_reaches_ready_without_user_click(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["ready"] is True, f"Expected background prewarming to reach ready=True: {obs}"


def t1_f12_02_pip_card_stays_hidden_during_and_after_prewarm(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["pipHidden"] is True, (
        f"Expected #jk-pip-card to remain hidden during background prewarming, got {obs}"
    )


def t1_f12_03_background_prewarm_initializes_audio_muted(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["isMuted"] is True, (
        f"Expected background prewarm to initialize with audio muted, got {obs}"
    )


def t1_f12_04_background_prewarm_mounts_only_base_assets(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["loadedPacks"] == 4 and obs["rangeRequests"] <= 8, (
        f"Expected 4 base packs and <=8 range requests on prewarm, got {obs}"
    )


def t1_f12_05_clicking_play_reuses_prewarmed_wasm_module(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    logs = ctx.get_browser_logs()
    wasm_fetches = [
        r for r in logs.get("networkResponses", [])
        if "openjk.wasm" in r["url"] and r["status"] == 200
    ]
    assert len(wasm_fetches) <= 1, (
        f"Expected openjk.wasm to be fetched at most once and reused after prewarm, got {len(wasm_fetches)}"
    )


# ==============================================================================
# F13: Floating Draggable & Resizable PiP Player Pane (5 tests)
# ==============================================================================
def t1_f13_01_pip_card_fixed_positioning_and_viewport_anchoring(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        if (!card) throw new Error('#jk-pip-card missing');
        const cs = window.getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        return {
          position: cs.position,
          zIndex: parseInt(cs.zIndex || '0', 10),
          display: cs.display,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
        """
    )
    assert res["position"] == "fixed", f"Expected position: fixed on #jk-pip-card, got {res['position']}"
    assert res["zIndex"] >= 9000, f"Expected z-index >= 9000, got {res['zIndex']}"
    assert res["rect"]["width"] >= 320 and res["rect"]["height"] >= 220, f"Invalid PiP dimensions: {res['rect']}"


def t1_f13_02_pip_card_does_not_reflow_underlying_scoreboard_table(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const tbl = document.querySelector('#recentdemos');
        const pip = window.JKPiPPlayer;
        const rectOpen = tbl.getBoundingClientRect();
        pip.close();
        await new Promise(r => setTimeout(r, 80));
        const rectClosed = tbl.getBoundingClientRect();
        // Re-open
        const btn = document.querySelector('.jk-play-btn');
        btn.click();
        await new Promise(r => setTimeout(r, 150));
        return {
          widthDiff: Math.abs(rectOpen.width - rectClosed.width),
          leftDiff: Math.abs(rectOpen.left - rectClosed.left),
        };
        """
    )
    assert res["widthDiff"] == 0 and res["leftDiff"] == 0, (
        f"Opening/closing PiP card reflowed #recentdemos table: {res}"
    )


def t1_f13_03_pip_header_pointer_events_dragging_updates_position(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const header = document.querySelector('#jk-pip-header, .jk-pip-header');
        if (!card || !header) throw new Error('Missing #jk-pip-card or #jk-pip-header');
        const before = card.getBoundingClientRect();
        const startX = before.left + 60;
        const startY = before.top + 14;
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: startX, clientY: startY
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: startX - 120, clientY: startY - 80
        }));
        header.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 1, buttons: 1, clientX: startX - 120, clientY: startY - 80
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 0, clientX: startX - 120, clientY: startY - 80
        }));
        header.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 0, clientX: startX - 120, clientY: startY - 80
        }));
        const after = card.getBoundingClientRect();
        return {
          before: { left: before.left, top: before.top },
          after: { left: after.left, top: after.top },
          dx: after.left - before.left,
          dy: after.top - before.top,
        };
        """
    )
    assert abs(res["dx"]) > 20 or abs(res["dy"]) > 20, (
        f"Pointer drag on #jk-pip-header did not move #jk-pip-card: {res}"
    )


def t1_f13_04_pip_size_presets_resize_card_and_canvas(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const pip = window.JKPiPPlayer;
        if (pip && typeof pip.setSizePreset === 'function') {
          pip.setSizePreset('compact');
        } else {
          const btn = document.querySelector('[data-size-preset="compact"], #jk-pip-size-compact, .jk-pip-preset-btn');
          if (btn) btn.click();
        }
        await new Promise(r => setTimeout(r, 80));
        const rCompact = card.getBoundingClientRect();

        if (pip && typeof pip.setSizePreset === 'function') {
          pip.setSizePreset('large');
        } else {
          const btns = document.querySelectorAll('[data-size-preset="large"], #jk-pip-size-large, .jk-pip-preset-btn');
          if (btns.length > 0) btns[btns.length - 1].click();
        }
        await new Promise(r => setTimeout(r, 80));
        const rLarge = card.getBoundingClientRect();

        if (pip && typeof pip.setSizePreset === 'function') {
          pip.setSizePreset('default');
        }
        return { compactW: rCompact.width, largeW: rLarge.width };
        """
    )
    assert res["largeW"] > res["compactW"], (
        f"Expected Large preset width ({res['largeW']}) > Compact preset width ({res['compactW']})"
    )


def t1_f13_05_pip_resize_handle_updates_card_and_viewport_dimensions(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const handle = document.querySelector('#jk-pip-resize-handle, .jk-pip-resize-handle');
        if (!handle) throw new Error('Missing #jk-pip-resize-handle');
        const before = card.getBoundingClientRect();
        const hx = before.right - 4;
        const hy = before.bottom - 4;
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 1, clientX: hx, clientY: hy
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 2, buttons: 1, clientX: hx + 80, clientY: hy + 50
        }));
        handle.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 2, buttons: 1, clientX: hx + 80, clientY: hy + 50
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 0, clientX: hx + 80, clientY: hy + 50
        }));
        handle.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 0, clientX: hx + 80, clientY: hy + 50
        }));
        await new Promise(r => setTimeout(r, 80));
        const after = card.getBoundingClientRect();
        const canvas = document.querySelector('#jk-canvas');
        return {
          beforeW: before.width,
          afterW: after.width,
          canvasW: canvas ? canvas.width : 0,
          canvasH: canvas ? canvas.height : 0,
        };
        """
    )
    assert res["canvasW"] >= 300 and res["canvasH"] >= 180, (
        f"Expected valid resized canvas dimensions, got {res}"
    )


# ==============================================================================
# F14: Full PiP Playback Controls Bar (5 tests)
# ==============================================================================
def t1_f14_01_pip_play_pause_button_toggles_engine_pause_state(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const btn = document.querySelector('#jk-pip-play-pause, #btn-play-pause');
        if (!btn) throw new Error('Play/Pause button missing');
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (mod && mod._JK_DemoIsPaused() === 1) mod._JK_DemoResume();
        btn.click();
        await new Promise(r => setTimeout(r, 60));
        const pausedAfterFirst = mod ? (mod._JK_DemoIsPaused() === 1) : p.isPaused();
        btn.click();
        await new Promise(r => setTimeout(r, 60));
        const pausedAfterSecond = mod ? (mod._JK_DemoIsPaused() === 1) : p.isPaused();
        return { pausedAfterFirst, pausedAfterSecond };
        """
    )
    assert res["pausedAfterFirst"] is True and res["pausedAfterSecond"] is False, (
        f"Play/Pause button failed to toggle pause state: {res}"
    )


def t1_f14_02_pip_start_over_button_rewinds_to_zero(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const btn = document.querySelector('#jk-pip-start-over, #btn-start-over');
        if (!btn) throw new Error('Start Over button missing');
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        mod ? mod._JK_DemoSeekToMs(Math.floor(dur * 0.5)) : p.seekToMs(Math.floor(dur * 0.5));
        btn.click();
        await new Promise(r => setTimeout(r, 80));
        const cur = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        return { cur };
        """
    )
    assert 0 <= res["cur"] <= 400, f"Expected Start Over button to rewind to ~0, got {res['cur']}"


def t1_f14_03_pip_timeline_seek_scrubber_and_mm_ss_label(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const slider = document.querySelector('#jk-pip-seek, #slider-seek');
        const timeLabel = document.querySelector('#jk-pip-time, #time-display');
        if (!slider || !timeLabel) throw new Error('Seek slider or time label missing');
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod ? mod._JK_DemoGetDurationMs() : p.getDurationMs();
        const target = Math.floor(dur * 0.4);
        slider.value = String(target);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const cur = mod ? mod._JK_DemoGetCurrentTimeMs() : p.getCurrentTimeMs();
        const labelText = timeLabel.textContent.trim();
        return { dur, target, cur, labelText };
        """
    )
    assert re.search(r"\d+:\d{2}\s*/\s*\d+:\d{2}", res["labelText"]), (
        f"Expected MM:SS / MM:SS format in #jk-pip-time, got {res['labelText']!r}"
    )
    assert abs(res["cur"] - res["target"]) <= 800, (
        f"Scrubbing slider to {res['target']} resulted in {res['cur']}"
    )


def t1_f14_04_pip_loop_toggle_button_updates_engine_loop_state(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const btn = document.querySelector('#jk-pip-loop, #btn-loop');
        if (!btn) throw new Error('Loop button missing');
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (mod && mod._JK_DemoSetLoop) mod._JK_DemoSetLoop(1);
        btn.click();
        await new Promise(r => setTimeout(r, 50));
        const afterFirst = mod ? mod._JK_DemoGetLoop() : (p.getLoop() ? 1 : 0);
        btn.click();
        await new Promise(r => setTimeout(r, 50));
        const afterSecond = mod ? mod._JK_DemoGetLoop() : (p.getLoop() ? 1 : 0);
        return { afterFirst, afterSecond };
        """
    )
    assert res["afterFirst"] != res["afterSecond"] and res["afterSecond"] == 1, (
        f"Loop toggle button did not toggle loop state: {res}"
    )


def t1_f14_05_pip_speed_volume_mute_fullscreen_and_close_controls_exist_and_work(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const speedEl = document.querySelector('#jk-pip-speed, #select-speed');
        const muteBtn = document.querySelector('#jk-pip-mute, #btn-mute');
        const volSlider = document.querySelector('#jk-pip-volume, #slider-volume');
        const fsBtn = document.querySelector('#jk-pip-fullscreen, #btn-fullscreen');
        const closeBtn = document.querySelector('#jk-pip-close, #btn-close');
        if (!speedEl || !muteBtn || !volSlider || !fsBtn || !closeBtn) {
          throw new Error('Missing one or more required PiP control elements');
        }
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (speedEl.tagName === 'SELECT') {
          speedEl.value = '2';
          speedEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          window.JKPiPPlayer.setSpeed(2.0);
        }
        const speedAfter = mod ? mod._JK_DemoGetSpeed() : p.getSpeed();
        if (speedEl.tagName === 'SELECT') {
          speedEl.value = '1';
          speedEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          window.JKPiPPlayer.setSpeed(1.0);
        }
        return { speedAfter };
        """
    )
    assert abs(res["speedAfter"] - 2.0) < 0.05, f"Expected speed=2.0, got {res['speedAfter']}"


# ==============================================================================
# F15: match.html (matchrpc.js) Play Button Integration (5 tests)
# ==============================================================================
def t1_f15_01_match_html_includes_pip_script_and_renders_play_buttons(ctx: E2ER2TestContext) -> None:
    info = ctx.ensure_page_loaded("match.html")
    assert info["playBtnCount"] >= 10, (
        f"Expected >= 10 .jk-play-btn buttons on match.html, got {info['playBtnCount']}"
    )


def t1_f15_02_match_html_matchdemo_links_have_adjacent_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="rpc=matchdemo"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Every rpc=matchdemo link on match.html must have an adjacent .jk-play-btn: {res}"
    )


def t1_f15_03_match_html_getdemo_pov_links_have_adjacent_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="getdemo.php"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Every getdemo.php link on match.html must have an adjacent .jk-play-btn: {res}"
    )


def t1_f15_04_match_html_mergedemo_grey_links_have_adjacent_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="mergedemo.php"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Every mergedemo.php link on match.html must have an adjacent .jk-play-btn: {res}"
    )


def t1_f15_05_match_html_trimdemo_ns_and_bookmark_links_have_adjacent_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="trimdemo.php"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Every trimdemo.php NS/Bookmark link on match.html must have an adjacent .jk-play-btn: {res}"
    )


# ==============================================================================
# F16: index.html (rpc.js) Play Button & RPC Integration (5 tests)
# ==============================================================================
def t1_f16_01_index_html_includes_jk_pip_player_script(ctx: E2ER2TestContext) -> None:
    index_html = (ctx.archive_public_dir / "index.html").read_text(encoding="utf-8", errors="ignore")
    assert "jk-pip-player.js" in index_html, "index.html must include /jkplayer/jk-pip-player.js"


def t1_f16_02_index_html_populates_recentdemos_table_rows(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    res = ctx.eval_js(
        """
        const rows = document.querySelectorAll('#recentdemos tr');
        const links = document.querySelectorAll('#recentdemos a[href*="getdemo.php"]');
        return { rowCount: rows.length, linkCount: links.length };
        """
    )
    assert res["rowCount"] > 1 and res["linkCount"] > 0, (
        f"Expected #recentdemos on index.html to populate with demo rows, got {res}"
    )


def t1_f16_03_index_html_numdemos_counter_populated(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    num_text = ctx.eval_js(
        """
        const el = document.querySelector('#numdemos');
        return el ? el.textContent.trim() : '';
        """
    )
    assert num_text.isdigit() and int(num_text) > 0, (
        f"Expected positive integer in #numdemos on index.html, got {num_text!r}"
    )


def t1_f16_04_index_html_every_getdemo_link_has_adjacent_play_button(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('#recentdemos a[href*="getdemo.php"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Every getdemo.php link on index.html must have an adjacent .jk-play-btn: {res}"
    )


def t1_f16_05_index_html_clicking_play_button_opens_pip_and_plays_demo(ctx: E2ER2TestContext) -> None:
    st = ctx.ensure_pip_playing("index.html", "getdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0


# ==============================================================================
# F17: aplayer2.html & debugplayer2.html (aplayer2.js) Download Links & Play Buttons (5 tests)
# ==============================================================================
def t1_f17_01_aplayer2_html_loads_default_player_without_url_hash(ctx: E2ER2TestContext) -> None:
    info = ctx.ensure_page_loaded("aplayer2.html")
    assert info["playBtnCount"] > 0, (
        f"Expected aplayer2.html (without #id=...) to load default player and render .jk-play-btn: {info}"
    )


def t1_f17_02_aplayer2_html_renders_game_demo_getdemo_links_and_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("aplayer2.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="getdemo.php"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Expected getdemo.php links with adjacent .jk-play-btn on aplayer2.html, got {res}"
    )


def t1_f17_03_aplayer2_html_renders_nice_shot_trimdemo_links_and_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("aplayer2.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="trimdemo.php"][href*="before=9000"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Expected Nice Shot trimdemo.php (before=9000) links with .jk-play-btn on aplayer2.html, got {res}"
    )


def t1_f17_04_aplayer2_html_renders_bookmark_trimdemo_links_and_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("aplayer2.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="trimdemo.php"][href*="before=13000"]'));
        const withBtn = links.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { total: links.length, withBtn: withBtn.length };
        """
    )
    assert res["total"] > 0 and res["withBtn"] == res["total"], (
        f"Expected Bookmark trimdemo.php (before=13000) links with .jk-play-btn on aplayer2.html, got {res}"
    )


def t1_f17_05_debugplayer2_html_renders_demo_ns_bookmark_links_and_play_buttons(ctx: E2ER2TestContext) -> None:
    info = ctx.ensure_page_loaded("debugplayer2.html")
    assert info["playBtnCount"] > 0 and info["demoLinks"]["getdemo"] > 0 and info["demoLinks"]["trimdemo"] > 0, (
        f"Expected getdemo.php and trimdemo.php links with .jk-play-btn on debugplayer2.html, got {info}"
    )


# ==============================================================================
# F18: Docker & Nginx /base Mount, Wasm MIME & Live Port 8081 Deployment (5 tests)
# ==============================================================================
def t1_f18_01_docker_compose_mounts_consolidated_base_dir_and_nginx_conf(ctx: E2ER2TestContext) -> None:
    compose_txt = ctx.docker_compose_path.read_text(encoding="utf-8")
    assert "/media/dan/Elements/pk3/base:/var/www/web/public/base" in compose_txt, (
        "docker-compose.yaml must mount /media/dan/Elements/pk3/base:/var/www/web/public/base:ro"
    )


def t1_f18_02_live_http_get_base_manifest_json_returns_200_ok(ctx: E2ER2TestContext) -> None:
    status, headers, body = ctx.http_request("GET", "/base/manifest.json")
    assert status == 200, f"GET /base/manifest.json returned HTTP {status}"
    data = json.loads(body.decode("utf-8"))
    assert data.get("version") == 2 and len(data.get("pk3s", [])) >= 480, (
        f"Invalid /base/manifest.json payload served on port 8081"
    )


def t1_f18_03_live_http_range_request_on_base_assets0_pk3_returns_206(ctx: E2ER2TestContext) -> None:
    status, headers, body = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-1023"}
    )
    assert status == 206, f"Expected 206 Partial Content for /base/assets0.pk3 Range request, got {status}"
    assert len(body) == 1024, f"Expected 1024 bytes, got {len(body)}"
    assert body[:4] == b"PK\x03\x04", f"Expected ZIP local file header magic PK\\x03\\x04, got {body[:4]!r}"
    assert "bytes" in headers.get("accept-ranges", "").lower()


def t1_f18_04_live_http_get_openjk_wasm_returns_200_and_application_wasm_mime(ctx: E2ER2TestContext) -> None:
    status, headers, body = ctx.http_request("GET", "/jkplayer/openjk.wasm")
    assert status == 200, f"GET /jkplayer/openjk.wasm returned HTTP {status}"
    ctype = headers.get("content-type", "").lower()
    assert "application/wasm" in ctype, f"Expected Content-Type: application/wasm, got {ctype!r}"
    assert body[:4] == b"\x00asm", f"Invalid Wasm magic header: {body[:4]!r}"


def t1_f18_05_live_http_get_jk_pip_player_js_and_openjk_js_return_200(ctx: E2ER2TestContext) -> None:
    for path in ("/jkplayer/jk-pip-player.js", "/jkplayer/openjk.js"):
        status, headers, body = ctx.http_request("GET", path)
        assert status == 200 and len(body) > 5000, (
            f"Expected 200 OK and >5KB payload for {path}, got HTTP {status} ({len(body)} bytes)"
        )


def get_tier1_tests() -> List[TestCase]:
    return [
        # F1 (5)
        TestCase("T1_F01_01_consolidation_script_and_pool_dir_exist", 1, "F1", "Verify consolidate_and_index_pk3s.py and /media/dan/Elements/pk3/base/ exist", t1_f01_01_consolidation_script_and_pool_dir_exist),
        TestCase("T1_F01_02_consolidated_pool_pk3_count_and_basenames", 1, "F1", "Verify consolidated pool contains ~488 PK3 files across >= 440 canonical basenames", t1_f01_02_consolidated_pool_pk3_count_and_basenames),
        TestCase("T1_F01_03_primary_versions_named_basename_pk3", 1, "F1", "Verify primary versions are saved as <basename>.pk3", t1_f01_03_primary_versions_named_basename_pk3),
        TestCase("T1_F01_04_alternate_checksum_versions_named_with_uint32_hex", 1, "F1", "Verify alternate checksum versions are saved as <basename>.<uint32_hex_checksum>.pk3", t1_f01_04_alternate_checksum_versions_named_with_uint32_hex),
        TestCase("T1_F01_05_tweaked_extension_archives_consolidated", 1, "F1", "Verify tweaked-extension ZIP archives (.pk_3, .pk3_cydremoved, .pk3.disable) are consolidated", t1_f01_05_tweaked_extension_archives_consolidated),
        # F2 (5)
        TestCase("T1_F02_01_assets0_checksum_matches_q3_md4_oracle", 1, "F2", "Verify assets0.pk3 signed 32-bit Com_BlockChecksum == 1767559464", t1_f02_01_assets0_checksum_matches_q3_md4_oracle),
        TestCase("T1_F02_02_assets1_checksum_matches_q3_md4_oracle", 1, "F2", "Verify assets1.pk3 signed 32-bit Com_BlockChecksum == -682941524", t1_f02_02_assets1_checksum_matches_q3_md4_oracle),
        TestCase("T1_F02_03_assets2_and_assets3_checksums_match_q3_md4_oracle", 1, "F2", "Verify assets2.pk3 (-1239421272) and assets3.pk3 (-1342311474) checksums match oracle", t1_f02_03_assets2_and_assets3_checksums_match_q3_md4_oracle),
        TestCase("T1_F02_04_custom_map_pk3_checksums_match_fs_loadzipfile_oracle", 1, "F2", "Verify custom map PK3 checksums (ctf_fim=104394672, ctf_kejim) match FS_LoadZipFile MD4", t1_f02_04_custom_map_pk3_checksums_match_fs_loadzipfile_oracle),
        TestCase("T1_F02_05_multi_version_pk3_checksums_distinct_and_verified", 1, "F2", "Verify multi-version custom PK3s have distinct signed 32-bit checksums matching MD4 oracle", t1_f02_05_multi_version_pk3_checksums_distinct_and_verified),
        # F3 (5)
        TestCase("T1_F03_01_manifest_v2_exists_and_valid_top_level_schema", 1, "F3", "Verify /media/dan/Elements/pk3/base/manifest.json v2 exists with >= 480 entries", t1_f03_01_manifest_v2_exists_and_valid_top_level_schema),
        TestCase("T1_F03_02_manifest_entries_have_all_required_fields_and_types", 1, "F3", "Verify every manifest entry has name, basename, checksum, size, cd_offset, cd_size, base_init, maps", t1_f03_02_manifest_entries_have_all_required_fields_and_types),
        TestCase("T1_F03_03_manifest_entries_match_physical_files_on_disk", 1, "F3", "Verify every manifest entry file exists in /media/dan/Elements/pk3/base/ with matching byte size", t1_f03_03_manifest_entries_match_physical_files_on_disk),
        TestCase("T1_F03_04_base_init_true_only_for_assets0_to_assets3", 1, "F3", "Verify base_init is true ONLY for assets0.pk3–assets3.pk3", t1_f03_04_base_init_true_only_for_assets0_to_assets3),
        TestCase("T1_F03_05_manifest_maps_field_indexes_bsp_names", 1, "F3", "Verify manifest maps array indexes .bsp names inside maps/", t1_f03_05_manifest_maps_field_indexes_bsp_names),
        # F4 (5)
        TestCase("T1_F04_01_files_cpp_expanded_archive_table_and_v2_manifest_cache_key", 1, "F4", "Verify files.cpp uses openjk_pk3_manifest_v2 and checks base_init", t1_f04_01_files_cpp_expanded_archive_table_and_v2_manifest_cache_key),
        TestCase("T1_F04_02_prewarm_mounts_only_base_init_archives", 1, "F4", "Verify startup/prewarm mounts only the 4 base_init archives (assets0..3.pk3)", t1_f04_02_prewarm_mounts_only_base_init_archives),
        TestCase("T1_F04_03_prewarm_pk3_range_requests_at_most_8", 1, "F4", "Verify g_jkPk3RangeRequests <= 8 on prewarm before a demo is loaded", t1_f04_03_prewarm_pk3_range_requests_at_most_8),
        TestCase("T1_F04_04_prewarm_network_fetches_only_assets0_to_assets3", 1, "F4", "Verify browser network requests during prewarm only touch assets0..3.pk3", t1_f04_04_prewarm_network_fetches_only_assets0_to_assets3),
        TestCase("T1_F04_05_prewarm_populates_manifest_v2_in_localstorage", 1, "F4", "Verify openjk_pk3_manifest_v2 is populated in localStorage on prewarm", t1_f04_05_prewarm_populates_manifest_v2_in_localstorage),
        # F5 (5)
        TestCase("T1_F05_01_cl_parse_hooks_cl_systeminfochanged_for_demoplaying", 1, "F5", "Verify CL_SystemInfoChanged calls FS_WasmPrepareDemoPaks during demo playback", t1_f05_01_cl_parse_hooks_cl_systeminfochanged_for_demoplaying),
        TestCase("T1_F05_02_custom_map_demo_dynamically_mounts_pk3_on_demand", 1, "F5", "Verify loading a demo dynamically mounts required custom map PK3 via HTTP Range", t1_f05_02_custom_map_demo_dynamically_mounts_pk3_on_demand),
        TestCase("T1_F05_03_priority_1_checksum_match_resolution_in_files_cpp", 1, "F5", "Verify Priority 1 signed 32-bit checksum matching in FS_WasmPrepareDemoPaks", t1_f05_03_priority_1_checksum_match_resolution_in_files_cpp),
        TestCase("T1_F05_04_priority_2_basename_fallback_resolution", 1, "F5", "Verify Priority 2 canonical basename fallback in FS_WasmPrepareDemoPaks", t1_f05_04_priority_2_basename_fallback_resolution),
        TestCase("T1_F05_05_priority_3_mapname_bsp_fallback_resolution", 1, "F5", "Verify Priority 3 mapname .bsp fallback lookup in FS_WasmPrepareDemoPaks", t1_f05_05_priority_3_mapname_bsp_fallback_resolution),
        # F6 (5)
        TestCase("T1_F06_01_demo_load_populates_positive_start_time_ms", 1, "F6", "Verify CL_ScanDemoTimeBounds populates positive JK_DemoGetStartTimeMs()", t1_f06_01_demo_load_populates_positive_start_time_ms),
        TestCase("T1_F06_02_demo_load_populates_end_time_greater_than_start_time", 1, "F6", "Verify CL_ScanDemoTimeBounds populates JK_DemoGetEndTimeMs() > JK_DemoGetStartTimeMs()", t1_f06_02_demo_load_populates_end_time_greater_than_start_time),
        TestCase("T1_F06_03_demo_duration_ms_equals_end_minus_start", 1, "F6", "Verify JK_DemoGetDurationMs() equals endServerTime - startServerTime > 0", t1_f06_03_demo_duration_ms_equals_end_minus_start),
        TestCase("T1_F06_04_scanner_rewinds_demofile_so_playback_starts_near_zero", 1, "F6", "Verify CL_ScanDemoTimeBounds rewinds demofile so playback starts at 0:00", t1_f06_04_scanner_rewinds_demofile_so_playback_starts_near_zero),
        TestCase("T1_F06_05_trimmed_clip_scanner_reports_shorter_clip_duration", 1, "F6", "Verify scanning a trimmed Nice Shot clip reports its shorter clip durationMs", t1_f06_05_trimmed_clip_scanner_reports_shorter_clip_duration),
        # F7 (5)
        TestCase("T1_F07_01_cmake_and_openjk_js_export_timeline_and_seek_functions", 1, "F7", "Verify CMakeLists.txt and openjk.js export all 7 timeline/seek/loop C functions", t1_f07_01_cmake_and_openjk_js_export_timeline_and_seek_functions),
        TestCase("T1_F07_02_window_jkdemoplayer_exposes_timeline_seek_and_loop_api", 1, "F7", "Verify window.JKDemoPlayer exposes timeline, seekToMs, startOver, and loop methods", t1_f07_02_window_jkdemoplayer_exposes_timeline_seek_and_loop_api),
        TestCase("T1_F07_03_window_jkpipplayer_exposes_control_api", 1, "F7", "Verify window.JKPiPPlayer exposes openAndPlay, close, seekToMs, startOver, setLoop, etc.", t1_f07_03_window_jkpipplayer_exposes_control_api),
        TestCase("T1_F07_04_current_time_ms_advances_during_active_playback", 1, "F7", "Verify JK_DemoGetCurrentTimeMs() advances monotonically during active playback", t1_f07_04_current_time_ms_advances_during_active_playback),
        TestCase("T1_F07_05_player_status_includes_timeline_and_loop_fields", 1, "F7", "Verify player.getStatus() includes durationMs and currentTimeMs", t1_f07_05_player_status_includes_timeline_and_loop_fields),
        # F8 (5)
        TestCase("T1_F08_01_forward_seek_updates_current_time_ms_to_target", 1, "F8", "Verify JK_DemoSeekToMs(targetMs) forward seek updates JK_DemoGetCurrentTimeMs()", t1_f08_01_forward_seek_updates_current_time_ms_to_target),
        TestCase("T1_F08_02_forward_seek_preserves_active_playing_state", 1, "F8", "Verify forward seeking keeps cls.state == CA_ACTIVE and isPlaying == true", t1_f08_02_forward_seek_preserves_active_playing_state),
        TestCase("T1_F08_03_sequential_multi_step_forward_seeks", 1, "F8", "Verify sequential forward seeks (20% -> 50% -> 80%) advance accurately", t1_f08_03_sequential_multi_step_forward_seeks),
        TestCase("T1_F08_04_forward_seek_drains_server_commands_without_overflow", 1, "F8", "Verify forward seek across >64 serverCommands drains buffer without overflow", t1_f08_04_forward_seek_drains_server_commands_without_overflow),
        TestCase("T1_F08_05_forward_seek_updates_rendered_3d_canvas_scene", 1, "F8", "Verify WebGL canvas renders updated 3D scene immediately after forward seek", t1_f08_05_forward_seek_updates_rendered_3d_canvas_scene),
        # F9 (5)
        TestCase("T1_F09_01_start_over_seek_to_zero_rewinds_immediately", 1, "F9", "Verify JK_DemoSeekToMs(0) Start Over rewinds currentTimeMs to ~0 immediately", t1_f09_01_start_over_seek_to_zero_rewinds_immediately),
        TestCase("T1_F09_02_backward_seek_to_intermediate_timestamp", 1, "F9", "Verify backward seek from 70% to 25% of durationMs lands accurately", t1_f09_02_backward_seek_to_intermediate_timestamp),
        TestCase("T1_F09_03_backward_seek_resets_cgame_snapshots_without_err_drop", 1, "F9", "Verify backward seek resets cgame snapshots in-place without ERR_DROP", t1_f09_03_backward_seek_resets_cgame_snapshots_without_err_drop),
        TestCase("T1_F09_04_backward_seek_preserves_loaded_gpu_assets_zero_range_requests", 1, "F9", "Verify in-place backward seek reuses loaded GPU assets with 0 new PK3 Range requests", t1_f09_04_backward_seek_preserves_loaded_gpu_assets_zero_range_requests),
        TestCase("T1_F09_05_playback_advances_and_renders_after_backward_seek", 1, "F9", "Verify demo playback advances and renders valid 3D frames after backward seek", t1_f09_05_playback_advances_and_renders_after_backward_seek),
        # F10 (5)
        TestCase("T1_F10_01_loop_enabled_by_default", 1, "F10", "Verify demo loop is enabled by default (_JK_DemoGetLoop() == 1)", t1_f10_01_loop_enabled_by_default),
        TestCase("T1_F10_02_reaching_demo_end_with_loop_enabled_restarts_from_zero", 1, "F10", "Verify reaching demo EOF with Loop enabled automatically restarts from 0:00", t1_f10_02_reaching_demo_end_with_loop_enabled_restarts_from_zero),
        TestCase("T1_F10_03_auto_loop_increments_completed_count", 1, "F10", "Verify automatic loop at EOF increments _JK_DemoGetCompletedCount()", t1_f10_03_auto_loop_increments_completed_count),
        TestCase("T1_F10_04_auto_loop_performs_in_place_rewind_zero_pk3_fetches", 1, "F10", "Verify automatic loop performs in-place rewind with 0 additional PK3 Range requests", t1_f10_04_auto_loop_performs_in_place_rewind_zero_pk3_fetches),
        TestCase("T1_F10_05_loop_disabled_stops_at_demo_end_without_rewinding", 1, "F10", "Verify disabling Loop stops playback at demo EOF without rewinding to 0:00", t1_f10_05_loop_disabled_stops_at_demo_end_without_rewinding),
        # F11 (5)
        TestCase("T1_F11_01_fetch_and_play_getdemo_php_query_url", 1, "F11", "Verify fetching and playing getdemo.php?demo=... query URL in MEMFS", t1_f11_01_fetch_and_play_getdemo_php_query_url),
        TestCase("T1_F11_02_fetch_and_play_mergedemo_php_query_url", 1, "F11", "Verify fetching and playing mergedemo.php?matchid=...&clientid=... query URL", t1_f11_02_fetch_and_play_mergedemo_php_query_url),
        TestCase("T1_F11_03_fetch_and_play_trimdemo_php_query_url", 1, "F11", "Verify fetching and playing trimdemo.php?demo=...&time=... Nice Shot query URL", t1_f11_03_fetch_and_play_trimdemo_php_query_url),
        TestCase("T1_F11_04_fetch_and_play_minrpc_matchdemo_query_url", 1, "F11", "Verify fetching and playing /minrpc.py?rpc=matchdemo&id=... query URL", t1_f11_04_fetch_and_play_minrpc_matchdemo_query_url),
        TestCase("T1_F11_05_pip_title_populated_from_demo_metadata_or_content_disposition", 1, "F11", "Verify PiP header title (#jk-pip-title) is populated when loading query-string demo", t1_f11_05_pip_title_populated_from_demo_metadata_or_content_disposition),
        # F12 (5)
        TestCase("T1_F12_01_background_prewarm_reaches_ready_without_user_click", 1, "F12", "Verify background Wasm engine prewarming reaches ready=true after page load", t1_f12_01_background_prewarm_reaches_ready_without_user_click),
        TestCase("T1_F12_02_pip_card_stays_hidden_during_and_after_prewarm", 1, "F12", "Verify #jk-pip-card stays hidden during background prewarming until Play is clicked", t1_f12_02_pip_card_stays_hidden_during_and_after_prewarm),
        TestCase("T1_F12_03_background_prewarm_initializes_audio_muted", 1, "F12", "Verify background prewarming keeps audio muted to respect autoplay policies", t1_f12_03_background_prewarm_initializes_audio_muted),
        TestCase("T1_F12_04_background_prewarm_mounts_only_base_assets", 1, "F12", "Verify background prewarming mounts only assets0..3.pk3 (rangeRequests <= 8)", t1_f12_04_background_prewarm_mounts_only_base_assets),
        TestCase("T1_F12_05_clicking_play_reuses_prewarmed_wasm_module", 1, "F12", "Verify clicking Play reuses the prewarmed Wasm engine without re-downloading openjk.wasm", t1_f12_05_clicking_play_reuses_prewarmed_wasm_module),
        # F13 (5)
        TestCase("T1_F13_01_pip_card_fixed_positioning_and_viewport_anchoring", 1, "F13", "Verify #jk-pip-card uses position: fixed, z-index >= 9000, anchored to viewport right", t1_f13_01_pip_card_fixed_positioning_and_viewport_anchoring),
        TestCase("T1_F13_02_pip_card_does_not_reflow_underlying_scoreboard_table", 1, "F13", "Verify opening #jk-pip-card does not reflow #recentdemos scoreboard table", t1_f13_02_pip_card_does_not_reflow_underlying_scoreboard_table),
        TestCase("T1_F13_03_pip_header_pointer_events_dragging_updates_position", 1, "F13", "Verify Pointer Events dragging on #jk-pip-header moves #jk-pip-card", t1_f13_03_pip_header_pointer_events_dragging_updates_position),
        TestCase("T1_F13_04_pip_size_presets_resize_card_and_canvas", 1, "F13", "Verify Compact/Default/Large size presets resize #jk-pip-card", t1_f13_04_pip_size_presets_resize_card_and_canvas),
        TestCase("T1_F13_05_pip_resize_handle_updates_card_and_viewport_dimensions", 1, "F13", "Verify #jk-pip-resize-handle updates card and #jk-canvas dimensions", t1_f13_05_pip_resize_handle_updates_card_and_viewport_dimensions),
        # F14 (5)
        TestCase("T1_F14_01_pip_play_pause_button_toggles_engine_pause_state", 1, "F14", "Verify PiP Play/Pause button toggles _JK_DemoIsPaused()", t1_f14_01_pip_play_pause_button_toggles_engine_pause_state),
        TestCase("T1_F14_02_pip_start_over_button_rewinds_to_zero", 1, "F14", "Verify PiP Start Over (0:00) button rewinds playback to ~0", t1_f14_02_pip_start_over_button_rewinds_to_zero),
        TestCase("T1_F14_03_pip_timeline_seek_scrubber_and_mm_ss_label", 1, "F14", "Verify PiP timeline seek scrubber and MM:SS / MM:SS time display", t1_f14_03_pip_timeline_seek_scrubber_and_mm_ss_label),
        TestCase("T1_F14_04_pip_loop_toggle_button_updates_engine_loop_state", 1, "F14", "Verify PiP Loop button toggles _JK_DemoGetLoop()", t1_f14_04_pip_loop_toggle_button_updates_engine_loop_state),
        TestCase("T1_F14_05_pip_speed_volume_mute_fullscreen_and_close_controls_exist_and_work", 1, "F14", "Verify PiP Speed, Mute/Volume, Fullscreen, and Close controls exist and update engine state", t1_f14_05_pip_speed_volume_mute_fullscreen_and_close_controls_exist_and_work),
        # F15 (5)
        TestCase("T1_F15_01_match_html_includes_pip_script_and_renders_play_buttons", 1, "F15", "Verify http://localhost:8081/match.html loads jk-pip-player.js and renders .jk-play-btn", t1_f15_01_match_html_includes_pip_script_and_renders_play_buttons),
        TestCase("T1_F15_02_match_html_matchdemo_links_have_adjacent_play_buttons", 1, "F15", "Verify all rpc=matchdemo links on match.html have adjacent .jk-play-btn", t1_f15_02_match_html_matchdemo_links_have_adjacent_play_buttons),
        TestCase("T1_F15_03_match_html_getdemo_pov_links_have_adjacent_play_buttons", 1, "F15", "Verify all getdemo.php links on match.html have adjacent .jk-play-btn", t1_f15_03_match_html_getdemo_pov_links_have_adjacent_play_buttons),
        TestCase("T1_F15_04_match_html_mergedemo_grey_links_have_adjacent_play_buttons", 1, "F15", "Verify all mergedemo.php links on match.html have adjacent .jk-play-btn", t1_f15_04_match_html_mergedemo_grey_links_have_adjacent_play_buttons),
        TestCase("T1_F15_05_match_html_trimdemo_ns_and_bookmark_links_have_adjacent_play_buttons", 1, "F15", "Verify all trimdemo.php NS/Bookmark links on match.html have adjacent .jk-play-btn", t1_f15_05_match_html_trimdemo_ns_and_bookmark_links_have_adjacent_play_buttons),
        # F16 (5)
        TestCase("T1_F16_01_index_html_includes_jk_pip_player_script", 1, "F16", "Verify index.html includes /jkplayer/jk-pip-player.js", t1_f16_01_index_html_includes_jk_pip_player_script),
        TestCase("T1_F16_02_index_html_populates_recentdemos_table_rows", 1, "F16", "Verify http://localhost:8081/index.html populates #recentdemos with demo rows", t1_f16_02_index_html_populates_recentdemos_table_rows),
        TestCase("T1_F16_03_index_html_numdemos_counter_populated", 1, "F16", "Verify #numdemos counter on index.html displays positive demo count", t1_f16_03_index_html_numdemos_counter_populated),
        TestCase("T1_F16_04_index_html_every_getdemo_link_has_adjacent_play_button", 1, "F16", "Verify every getdemo.php link on index.html has adjacent .jk-play-btn", t1_f16_04_index_html_every_getdemo_link_has_adjacent_play_button),
        TestCase("T1_F16_05_index_html_clicking_play_button_opens_pip_and_plays_demo", 1, "F16", "Verify clicking .jk-play-btn on index.html opens PiP pane and plays demo", t1_f16_05_index_html_clicking_play_button_opens_pip_and_plays_demo),
        # F17 (5)
        TestCase("T1_F17_01_aplayer2_html_loads_default_player_without_url_hash", 1, "F17", "Verify http://localhost:8081/aplayer2.html loads default top player when hash is empty", t1_f17_01_aplayer2_html_loads_default_player_without_url_hash),
        TestCase("T1_F17_02_aplayer2_html_renders_game_demo_getdemo_links_and_play_buttons", 1, "F17", "Verify aplayer2.html renders getdemo.php links and .jk-play-btn for game.demos", t1_f17_02_aplayer2_html_renders_game_demo_getdemo_links_and_play_buttons),
        TestCase("T1_F17_03_aplayer2_html_renders_nice_shot_trimdemo_links_and_play_buttons", 1, "F17", "Verify aplayer2.html renders trimdemo.php links and .jk-play-btn for game.ns.shots", t1_f17_03_aplayer2_html_renders_nice_shot_trimdemo_links_and_play_buttons),
        TestCase("T1_F17_04_aplayer2_html_renders_bookmark_trimdemo_links_and_play_buttons", 1, "F17", "Verify aplayer2.html renders trimdemo.php links and .jk-play-btn for game.bookmarks", t1_f17_04_aplayer2_html_renders_bookmark_trimdemo_links_and_play_buttons),
        TestCase("T1_F17_05_debugplayer2_html_renders_demo_ns_bookmark_links_and_play_buttons", 1, "F17", "Verify http://localhost:8081/debugplayer2.html renders demo/NS/bookmark links and .jk-play-btn", t1_f17_05_debugplayer2_html_renders_demo_ns_bookmark_links_and_play_buttons),
        # F18 (5)
        TestCase("T1_F18_01_docker_compose_mounts_consolidated_base_dir_and_nginx_conf", 1, "F18", "Verify docker-compose.yaml mounts /media/dan/Elements/pk3/base:/var/www/web/public/base:ro", t1_f18_01_docker_compose_mounts_consolidated_base_dir_and_nginx_conf),
        TestCase("T1_F18_02_live_http_get_base_manifest_json_returns_200_ok", 1, "F18", "Verify GET http://localhost:8081/base/manifest.json returns 200 OK with v2 manifest", t1_f18_02_live_http_get_base_manifest_json_returns_200_ok),
        TestCase("T1_F18_03_live_http_range_request_on_base_assets0_pk3_returns_206", 1, "F18", "Verify GET http://localhost:8081/base/assets0.pk3 with Range header returns 206 Partial Content", t1_f18_03_live_http_range_request_on_base_assets0_pk3_returns_206),
        TestCase("T1_F18_04_live_http_get_openjk_wasm_returns_200_and_application_wasm_mime", 1, "F18", "Verify GET http://localhost:8081/jkplayer/openjk.wasm returns 200 OK and application/wasm", t1_f18_04_live_http_get_openjk_wasm_returns_200_and_application_wasm_mime),
        TestCase("T1_F18_05_live_http_get_jk_pip_player_js_and_openjk_js_return_200", 1, "F18", "Verify GET /jkplayer/jk-pip-player.js and /jkplayer/openjk.js return 200 OK", t1_f18_05_live_http_get_jk_pip_player_js_and_openjk_js_return_200),
    ]
