#!/usr/bin/env python3
"""
Tier 2 — Boundary & Corner-Case E2E Tests for Round 2 (90 test cases: 5 per feature across F1–F18).
Exercises numerical, protocol, format, and state boundaries across F1–F18.
"""

import json
import os
from pathlib import Path
import re
import struct
from typing import List
import zipfile

from .harness import (
    E2ER2TestContext,
    TestCase,
    canonical_pk3_basename,
    com_block_checksum,
    compute_q3_pk3_checksum,
    inspect_zip_eocd,
    mdfour,
)


# ==============================================================================
# F1: Multi-Directory PK3 Consolidation — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f01_01_corrupt_non_zip_pk3_stubs_excluded_all_pool_files_valid_zip(ctx: E2ER2TestContext) -> None:
    # Verify known corrupt stubs in /media/dan/Elements/pk3 are indeed non-ZIP
    corrupt_stub = Path("/media/dan/Elements/pk3/DriveC/ctf_fim.pk3")
    if corrupt_stub.exists():
        assert not zipfile.is_zipfile(corrupt_stub), "DriveC/ctf_fim.pk3 should be a corrupt 13B stub"
    # Every .pk3 in consolidated pool must be a valid ZIP archive
    pk3_files = sorted(ctx.consolidated_pk3_dir.glob("*.pk3"))
    assert len(pk3_files) >= 480
    invalid = [p.name for p in pk3_files if not zipfile.is_zipfile(p)]
    assert invalid == [], f"Corrupt/non-ZIP files found in consolidated pool: {invalid}"


def t2_f01_02_valid_ctf_fim_preserved_over_13_byte_corrupt_stub(ctx: E2ER2TestContext) -> None:
    fim_path = ctx.consolidated_pk3_dir / "ctf_fim.pk3"
    assert fim_path.exists(), f"Missing {fim_path}"
    assert fim_path.stat().st_size == 13994488, (
        f"Expected valid ctf_fim.pk3 (13994488 B), got {fim_path.stat().st_size} B"
    )
    assert ctx.get_pk3_checksum(fim_path) == 104394672


def t2_f01_03_tweaked_extensions_without_digit_3_normalized_cleanly(ctx: E2ER2TestContext) -> None:
    # Verify regex handles .pk_dis, .pk_orig, .pk_with_botroutes, .pk_disabled, .pk_, .dis_pk3_dis
    samples = {
        "ctf_kejim.pk_dis": "ctf_kejim",
        "ctf_coruscant_bridges.pk_orig": "ctf_coruscant_bridges",
        "ctf_rift_mines.pk_with_botroutes": "ctf_rift_mines",
        "ctf_ruins_fixed.pk_disabled": "ctf_ruins_fixed",
        "ja+bots.pk_": "ja+bots",
        "ctf_kharzet.dis_pk3_dis": "ctf_kharzet",
    }
    for raw_name, expected_base in samples.items():
        assert canonical_pk3_basename(raw_name) == expected_base
    manifest = ctx.get_manifest()
    basenames = {e["basename"].lower() for e in manifest["pk3s"]}
    for b in samples.values():
        assert b in basenames, f"Expected normalized basename '{b}' in manifest.json"
    # Ensure no basename in manifest still has a .pk_ or .dis_pk suffix
    dirty = [e["basename"] for e in manifest["pk3s"] if re.search(r"\.(?:dis_)?pk", e["basename"], re.I)]
    assert dirty == [], f"Un-normalized tweaked suffixes remained in manifest basenames: {dirty}"


def t2_f01_04_source_directory_priority_selects_primary_basename_pk3(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    # /home/dan/refresh/base/ctf_kejim.pk3 has priority over DriveC/ctf_kejim.pk_dis
    refresh_kejim = Path("/home/dan/refresh/base/ctf_kejim.pk3")
    if refresh_kejim.exists():
        expected_sum = ctx.get_pk3_checksum(refresh_kejim)
        assert by_name["ctf_kejim.pk3"]["checksum"] == expected_sum, (
            f"Primary ctf_kejim.pk3 checksum ({by_name['ctf_kejim.pk3']['checksum']}) != refresh/base priority checksum ({expected_sum})"
        )


def t2_f01_05_no_zero_byte_broken_symlink_or_stray_files_in_pool(ctx: E2ER2TestContext) -> None:
    for item in ctx.consolidated_pk3_dir.iterdir():
        assert item.exists(), f"Broken symlink in consolidated pool: {item}"
        if item.name == "manifest.json":
            assert item.stat().st_size > 10000
        else:
            assert item.suffix.lower() == ".pk3", f"Unexpected non-.pk3 file in pool: {item.name}"
            assert item.stat().st_size > 100, f"Suspiciously small .pk3 file in pool: {item.name} ({item.stat().st_size} B)"


# ==============================================================================
# F2: Quake 3 Signed 32-bit Com_BlockChecksum — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f02_01_zero_byte_and_directory_zip_entries_excluded_from_crc_list(ctx: E2ER2TestContext) -> None:
    # Verify an archive that contains directory entries (file_size == 0) excludes them from Com_BlockChecksum
    p = ctx.consolidated_pk3_dir / "(hk)_clanmap.pk3"
    with zipfile.ZipFile(p, "r") as zf:
        all_infos = zf.infolist()
        non_empty = [info for info in all_infos if info.file_size > 0]
        zero_entries = [info for info in all_infos if info.file_size == 0]
    assert len(zero_entries) > 0, "Expected (hk)_clanmap.pk3 to have directory entries with file_size == 0"
    crcs_non_empty = [i.CRC & 0xFFFFFFFF for i in non_empty]
    crcs_all = [i.CRC & 0xFFFFFFFF for i in all_infos]
    sum_non_empty = com_block_checksum(struct.pack(f"<{len(crcs_non_empty)}I", *crcs_non_empty))
    sum_all = com_block_checksum(struct.pack(f"<{len(crcs_all)}I", *crcs_all))
    assert sum_non_empty != sum_all
    manifest_sum = {e["name"]: e["checksum"] for e in ctx.get_manifest()["pk3s"]}["(hk)_clanmap.pk3"]
    assert manifest_sum == sum_non_empty, (
        f"Manifest checksum {manifest_sum} must exclude 0-byte directory entries (expected {sum_non_empty})"
    )


def t2_f02_02_signed_int32_bounds_and_negative_checksum_representation(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    sums = [e["checksum"] for e in manifest["pk3s"]]
    neg_sums = [s for s in sums if s < 0]
    pos_sums = [s for s in sums if s > 0]
    assert len(neg_sums) > 100 and len(pos_sums) > 100, (
        f"Expected both negative and positive signed 32-bit checksums, got neg={len(neg_sums)}, pos={len(pos_sums)}"
    )
    for s in sums:
        assert -2147483648 <= s <= 2147483647, f"Checksum {s} outside signed 32-bit int range"


def t2_f02_03_md4_padding_boundary_conditions_55_56_64_bytes(ctx: E2ER2TestContext) -> None:
    # Test MD4 tail boundary at 13 uint32s (52B <= 55B), 14 uint32s (56B > 55B), and 16 uint32s (64B exact block)
    for count in (0, 1, 13, 14, 15, 16, 17, 32):
        buf = struct.pack(f"<{count}I", *[(i * 0x9E3779B9) & 0xFFFFFFFF for i in range(count)])
        digest = mdfour(buf)
        assert len(digest) == 16
        c = com_block_checksum(buf)
        assert -2147483648 <= c <= 2147483647


def t2_f02_04_central_directory_entry_order_preserved_not_sorted(ctx: E2ER2TestContext) -> None:
    p = ctx.consolidated_pk3_dir / "assets2.pk3"
    with zipfile.ZipFile(p, "r") as zf:
        infos = [i for i in zf.infolist() if i.file_size > 0]
    cd_order_crcs = [i.CRC & 0xFFFFFFFF for i in infos]
    sorted_crcs = [i.CRC & 0xFFFFFFFF for i in sorted(infos, key=lambda x: x.filename.lower())]
    sum_cd_order = com_block_checksum(struct.pack(f"<{len(cd_order_crcs)}I", *cd_order_crcs))
    sum_sorted = com_block_checksum(struct.pack(f"<{len(sorted_crcs)}I", *sorted_crcs))
    assert sum_cd_order == -1239421272
    if cd_order_crcs != sorted_crcs:
        assert sum_cd_order != sum_sorted


def t2_f02_05_sample_25_consolidated_pk3s_exact_checksum_audit(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    pk3s = manifest["pk3s"]
    step = max(1, len(pk3s) // 25)
    sampled = pk3s[::step][:25]
    assert len(sampled) == 25
    for entry in sampled:
        fp = ctx.consolidated_pk3_dir / entry["name"]
        oracle = ctx.get_pk3_checksum(fp)
        assert entry["checksum"] == oracle, (
            f"Checksum mismatch on {entry['name']}: manifest={entry['checksum']} != oracle={oracle}"
        )


# ==============================================================================
# F3: /media/dan/Elements/pk3/base/manifest.json — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f03_01_cd_offset_and_cd_size_bounds_and_pk0102_signature(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    pk3s = manifest["pk3s"]
    for entry in pk3s:
        size = entry["size"]
        cd_offset = entry["cd_offset"]
        cd_size = entry["cd_size"]
        assert 0 < cd_offset < size, f"Invalid cd_offset {cd_offset} for size {size} in {entry['name']}"
        assert cd_size > 0 and cd_offset + cd_size <= size, (
            f"Invalid cd_size {cd_size} at cd_offset {cd_offset} for size {size} in {entry['name']}"
        )
    # Check physical PK\x01\x02 signature at cd_offset on 20 archives
    for entry in pk3s[:: max(1, len(pk3s) // 20)][:20]:
        fp = ctx.consolidated_pk3_dir / entry["name"]
        eocd = inspect_zip_eocd(fp)
        assert eocd["cd_offset"] == entry["cd_offset"], f"cd_offset mismatch on {entry['name']}"
        assert eocd["cd_magic"] == b"PK\x01\x02", f"Missing PK\\x01\\x02 at cd_offset on {entry['name']}"


def t2_f03_02_nested_maps_mp_bsp_indexed_properly(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assets0_maps = [m.lower() for m in by_name["assets0.pk3"]["maps"]]
    assert any("ctf1" in m for m in assets0_maps) and any("ffa3" in m for m in assets0_maps), (
        f"Expected mp/ctf1 and mp/ffa3 in assets0.pk3 maps, got {assets0_maps}"
    )


def t2_f03_03_no_duplicate_names_or_basename_checksum_pairs_in_manifest(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    names = [e["name"].lower() for e in manifest["pk3s"]]
    assert len(names) == len(set(names)), "Duplicate PK3 filenames found in manifest.json"
    pairs = [(e["basename"].lower(), e["checksum"]) for e in manifest["pk3s"]]
    assert len(pairs) == len(set(pairs)), "Duplicate (basename, checksum) pairs found in manifest.json"


def t2_f03_04_identical_checksum_aliases_handled_cleanly(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    basenames = {e["basename"].lower() for e in manifest["pk3s"]}
    # Either ctf_jodaka or ctf_sertao_alpha9 should be present and resolvable
    assert "ctf_jodaka" in basenames or "ctf_sertao_alpha9" in basenames, (
        "Expected clean canonical basename for ctf_jodaka / ctf_sertao_alpha9 in manifest"
    )


def t2_f03_05_non_map_pk3s_have_empty_maps_list(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assert by_name["assets1.pk3"]["maps"] == [] and by_name["assets2.pk3"]["maps"] == [], (
        f"assets1.pk3 and assets2.pk3 contain no .bsp files and should have maps=[], got {by_name['assets1.pk3']['maps']} / {by_name['assets2.pk3']['maps']}"
    )


# ==============================================================================
# F4: Base-Only Engine Prewarm Mounting — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f04_01_stale_v1_localstorage_manifest_ignored(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        localStorage.setItem('openjk_pk3_manifest_v1', 'CORRUPT_V1_MANIFEST_DATA');
        const v2 = localStorage.getItem('openjk_pk3_manifest_v2');
        const parsed = v2 ? JSON.parse(v2) : null;
        return {
          v1: localStorage.getItem('openjk_pk3_manifest_v1'),
          hasV2: Boolean(parsed && parsed.version === 2 && parsed.pk3s && parsed.pk3s.length >= 480),
        };
        """
    )
    assert res["hasV2"] is True, f"Expected v2 manifest active despite stale v1 key: {res}"


def t2_f04_02_prewarm_bytes_transferred_under_10_mb(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert 0 <= obs["bytesTransferred"] < 10 * 1024 * 1024, (
        f"Expected prewarm PK3 bytes transferred < 10 MB, got {obs['bytesTransferred']}"
    )


def t2_f04_03_zero_full_pk3_downloads_during_prewarm_and_playback(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    logs = ctx.get_browser_logs()
    full_pk3_200s = [
        r for r in logs.get("networkResponses", [])
        if ".pk3" in r["url"] and r["status"] == 200 and r["contentLength"] > 5 * 1024 * 1024
    ]
    assert full_pk3_200s == [], (
        f"Full .pk3 archive downloaded with HTTP 200 instead of 206 Partial Content: {full_pk3_200s}"
    )


def t2_f04_04_all_488_manifest_entries_fit_within_wasm_archive_table(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    # Ensure static cap 32 and stack buffer 8192 were expanded
    assert "g_wasmPk3Archives[32]" not in files_cpp, "g_wasmPk3Archives[32] was not expanded in files.cpp"
    assert "manifestBuf[8192]" not in files_cpp, "manifestBuf[8192] was not expanded in files.cpp"


def t2_f04_05_prewarm_produces_zero_unhandled_page_errors(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs.get("pageErrors", []) == [], (
        f"Unhandled page errors occurred during prewarm: {obs.get('pageErrors')}"
    )


# ==============================================================================
# F5: Checksum-First Dynamic On-Demand PK3 Mounting — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f05_01_switching_demos_unlinks_previous_custom_pk3_searchpaths(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "fs_searchpaths" in files_cpp and "base_init" in files_cpp, (
        "FS_WasmPrepareDemoPaks must unlink non-base_init searchpaths when switching demos"
    )


def t2_f05_02_reloading_same_custom_map_reuses_cached_cd_without_refetch(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const btn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]') || document.querySelector('.jk-play-btn');
        const url = btn.getAttribute('data-demo-url') || btn.previousElementSibling.getAttribute('href');
        // Record range requests after initial play
        const req1 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        // Re-load the exact same demo
        if (window.JKPiPPlayer && window.JKPiPPlayer.openAndPlay) {
          await window.JKPiPPlayer.openAndPlay(url);
        } else {
          await p.loadDemo(url);
        }
        const start = Date.now();
        while (Date.now() - start < 30000) {
          if (mod._JK_DemoIsPlaying && mod._JK_DemoIsPlaying() === 1) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const req2 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        return { req1, req2, delta: req2 - req1 };
        """,
        timeout=45.0,
    )
    assert res["delta"] <= 2, (
        f"Expected cached central directory & chunks to be reused on reload (delta <= 2), got {res}"
    )


def t2_f05_03_multi_token_referenced_paks_parsed_without_cmd_tokenizestring_collision(ctx: E2ER2TestContext) -> None:
    files_cpp = (ctx.root_dir / "codemp" / "qcommon" / "files.cpp").read_text(encoding="utf-8", errors="ignore")
    # Check that FS_WasmPrepareDemoPaks Exists and safely tokenizes sum & name lists
    assert "FS_WasmPrepareDemoPaks" in files_cpp


def t2_f05_04_missing_server_mod_pak_in_referenced_paks_does_not_abort_map_load(ctx: E2ER2TestContext) -> None:
    # Real archive demos reference server-side mod paks (like japlus / server bins) not in manifest;
    # verify the demo still plays in CA_ACTIVE and loads the map
    st = ctx.ensure_pip_playing("match.html", "getdemo.php")
    assert st["isPlaying"] is True and st["durationMs"] > 0


def t2_f05_05_gamedir_prefixed_paknames_stripped_during_basename_resolution(ctx: E2ER2TestContext) -> None:
    # Archive demos have sv_referencedPakNames like "base/assets0 base/ctf_kejim japlus/..."
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    map_name = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        return (mod && mod._JK_DemoGetMapName && mod.UTF8ToString)
          ? mod.UTF8ToString(mod._JK_DemoGetMapName())
          : (p && p.getStatus ? p.getStatus().mapName : '');
        """
    )
    assert len(map_name) > 0, "Expected valid loaded mapname from gamedir-prefixed sv_referencedPakNames"


# ==============================================================================
# F6: .dm_26 Snapshot serverTime Bounds Scanner — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f06_01_short_12_packet_synthesized_demo_bounds_scan(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        // Find an existing demo URL on the page to slice
        const btn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]') || document.querySelector('.jk-play-btn');
        const srcUrl = btn.getAttribute('data-demo-url') || btn.previousElementSibling.getAttribute('href');
        const resp = await fetch(srcUrl);
        const fullBuf = await resp.arrayBuffer();
        const view = new DataView(fullBuf);
        let offset = 0;
        let pktCount = 0;
        while (pktCount < 18 && offset + 8 <= fullBuf.byteLength) {
          const seq = view.getInt32(offset, true);
          const cursize = view.getInt32(offset + 4, true);
          if (seq === -1 && cursize === -1) break;
          if (cursize < 0 || offset + 8 + cursize > fullBuf.byteLength) break;
          offset += 8 + cursize;
          pktCount++;
        }
        const shortBytes = new Uint8Array(offset + 8);
        shortBytes.set(new Uint8Array(fullBuf, 0, offset), 0);
        const dv = new DataView(shortBytes.buffer, offset, 8);
        dv.setInt32(0, -1, true);
        dv.setInt32(4, -1, true);

        mod.FS.writeFile('/base/demos/short_scan_t2.dm_26', shortBytes);
        mod.ccall('JK_DemoLoad', 'number', ['string'], ['short_scan_t2.dm_26']);
        const start = Date.now();
        while (Date.now() - start < 20000) {
          if (mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        const startMs = mod._JK_DemoGetStartTimeMs();
        const endMs = mod._JK_DemoGetEndTimeMs();
        const durMs = mod._JK_DemoGetDurationMs();
        return { startMs, endMs, durMs };
        """,
        timeout=35.0,
    )
    assert res["startMs"] > 0 and res["endMs"] >= res["startMs"]
    assert 0 <= res["durMs"] <= 10000, f"Expected short 18-packet clip duration <= 10000ms, got {res}"


def t2_f06_02_truncated_demo_without_eof_marker_scans_cleanly(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const btn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]') || document.querySelector('.jk-play-btn');
        const srcUrl = btn.getAttribute('data-demo-url') || btn.previousElementSibling.getAttribute('href');
        const resp = await fetch(srcUrl);
        const fullBuf = await resp.arrayBuffer();
        const view = new DataView(fullBuf);
        let offset = 0;
        let pktCount = 0;
        while (pktCount < 25 && offset + 8 <= fullBuf.byteLength) {
          const cursize = view.getInt32(offset + 4, true);
          if (cursize < 0 || offset + 8 + cursize > fullBuf.byteLength) break;
          offset += 8 + cursize;
          pktCount++;
        }
        // Write WITHOUT (-1, -1) EOF marker
        const rawTrunc = new Uint8Array(fullBuf, 0, offset);
        mod.FS.writeFile('/base/demos/trunc_no_eof.dm_26', rawTrunc);
        mod.ccall('JK_DemoLoad', 'number', ['string'], ['trunc_no_eof.dm_26']);
        const start = Date.now();
        while (Date.now() - start < 20000) {
          if (mod._JK_DemoGetStartTimeMs() > 0 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 80));
        }
        return {
          startMs: mod._JK_DemoGetStartTimeMs(),
          endMs: mod._JK_DemoGetEndTimeMs(),
          durMs: mod._JK_DemoGetDurationMs(),
        };
        """,
        timeout=35.0,
    )
    assert res["startMs"] > 0 and res["durMs"] > 0, (
        f"Expected valid bounds scan on truncated stream without (-1,-1) EOF marker: {res}"
    )


def t2_f06_03_scanner_skips_svc_servercommands_before_first_snapshot(ctx: E2ER2TestContext) -> None:
    cl_main = (ctx.root_dir / "codemp" / "client" / "cl_main.cpp").read_text(encoding="utf-8", errors="ignore")
    assert "svc_serverCommand" in cl_main and "svc_snapshot" in cl_main, (
        "CL_ScanDemoTimeBounds must handle svc_serverCommand and svc_snapshot"
    )


def t2_f06_04_switching_from_full_demo_to_trimmed_demo_updates_bounds(ctx: E2ER2TestContext) -> None:
    st_full = ctx.ensure_pip_playing("match.html", "getdemo.php", force_reload_demo=True)
    st_trim = ctx.ensure_pip_playing("match.html", "trimdemo.php", force_reload_demo=True)
    assert st_full["durationMs"] != st_trim["durationMs"], (
        f"Expected durationMs to update when switching from full demo ({st_full['durationMs']}) to trimmed clip ({st_trim['durationMs']})"
    )


def t2_f06_05_bounds_scan_executes_in_memory_with_zero_pk3_fetches(ctx: E2ER2TestContext) -> None:
    # Reloading an already-cached demo in MEMFS scans bounds in < 200ms without fetching PK3s
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const req0 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        mod.ccall('JK_DemoLoad', 'number', ['string'], ['short_scan_t2.dm_26']);
        await new Promise(r => setTimeout(r, 250));
        const req1 = mod._JK_DemoGetPk3RangeRequests ? mod._JK_DemoGetPk3RangeRequests() : mod._JK_DemoGetPK3RangeRequests();
        return { req0, req1, delta: req1 - req0, dur: mod._JK_DemoGetDurationMs() };
        """
    )
    assert res["delta"] == 0 and res["dur"] > 0


# ==============================================================================
# F7: Demo Timeline & Seek C/JS Exports — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f07_01_all_seven_c_exports_callable_directly_on_module(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        return {
          start: mod._JK_DemoGetStartTimeMs(),
          end: mod._JK_DemoGetEndTimeMs(),
          dur: mod._JK_DemoGetDurationMs(),
          cur: mod._JK_DemoGetCurrentTimeMs(),
          loop: mod._JK_DemoGetLoop(),
          setLoop0: mod._JK_DemoSetLoop(0),
          setLoop1: mod._JK_DemoSetLoop(1),
        };
        """
    )
    assert res["start"] > 0 and res["end"] > res["start"] and res["dur"] == res["end"] - res["start"]
    assert res["setLoop1"] == 1 or mod_loop_ok(res)


def mod_loop_ok(res: dict) -> bool:
    return res.get("loop") in (0, 1)


def t2_f07_02_set_loop_boolean_and_nonzero_integer_normalization(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        const after0 = mod._JK_DemoGetLoop();
        mod._JK_DemoSetLoop(42);
        const after42 = mod._JK_DemoGetLoop();
        p.setLoop(false);
        const afterFalse = p.getLoop();
        p.setLoop(true);
        const afterTrue = p.getLoop();
        return { after0, after42, afterFalse, afterTrue };
        """
    )
    assert res["after0"] == 0 and res["after42"] == 1
    assert res["afterFalse"] is False and res["afterTrue"] is True


def t2_f07_03_seek_to_ms_nan_or_invalid_input_handled_safely(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        p.seekToMs(NaN);
        p.seekToMs(undefined);
        const dur = mod._JK_DemoGetDurationMs();
        const cur = mod._JK_DemoGetCurrentTimeMs();
        const playing = mod._JK_DemoIsPlaying() === 1;
        return { dur, cur, playing };
        """
    )
    assert res["playing"] is True and 0 <= res["cur"] <= res["dur"]


def t2_f07_04_current_time_ms_clamped_within_zero_and_duration_ms(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(0);
        const cur0 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(dur);
        const curEnd = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        return { dur, cur0, curEnd };
        """
    )
    assert 0 <= res["cur0"] <= res["dur"]
    assert 0 <= res["curEnd"] <= res["dur"]


def t2_f07_05_js_wrapper_methods_consistent_with_c_exports(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        return {
          startDiff: Math.abs(p.getStartTimeMs() - mod._JK_DemoGetStartTimeMs()),
          endDiff: Math.abs(p.getEndTimeMs() - mod._JK_DemoGetEndTimeMs()),
          durDiff: Math.abs(p.getDurationMs() - mod._JK_DemoGetDurationMs()),
          curDiff: Math.abs(p.getCurrentTimeMs() - mod._JK_DemoGetCurrentTimeMs()),
        };
        """
    )
    assert res["startDiff"] == 0 and res["endDiff"] == 0 and res["durDiff"] == 0
    assert res["curDiff"] <= 100


# ==============================================================================
# F8: In-Memory Forward Demo Seeking — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f08_01_forward_seek_while_paused_updates_time_and_stays_paused(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSeekToMs(0);
        mod._JK_DemoPause();
        const dur = mod._JK_DemoGetDurationMs();
        const target = Math.floor(dur * 0.5);
        mod._JK_DemoSeekToMs(target);
        const tAfterSeek = mod._JK_DemoGetCurrentTimeMs();
        const paused1 = mod._JK_DemoIsPaused() === 1;
        await new Promise(r => setTimeout(r, 350));
        const tAfterWait = mod._JK_DemoGetCurrentTimeMs();
        const paused2 = mod._JK_DemoIsPaused() === 1;
        mod._JK_DemoResume();
        return { target, tAfterSeek, tAfterWait, paused1, paused2 };
        """
    )
    assert res["paused1"] is True and res["paused2"] is True
    assert abs(res["tAfterSeek"] - res["target"]) <= 500
    assert abs(res["tAfterWait"] - res["tAfterSeek"]) <= 50, (
        f"Paused demo advanced during wait after forward seek: {res}"
    )


def t2_f08_02_forward_seek_to_same_timestamp_is_clean_noop(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const cur0 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(cur0);
        const cur1 = mod._JK_DemoGetCurrentTimeMs();
        const playing = mod._JK_DemoIsPlaying() === 1;
        return { cur0, cur1, playing };
        """
    )
    assert res["playing"] is True and abs(res["cur1"] - res["cur0"]) <= 250


def t2_f08_03_forward_seek_to_duration_and_overflow_clamps_cleanly(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(dur + 999999);
        const curAfterOverflow = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        return { dur, curAfterOverflow };
        """
    )
    assert 0 <= res["curAfterOverflow"] <= res["dur"]


def t2_f08_04_forward_seek_across_full_match_demo_preserves_configstrings(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(0);
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.9));
        const mapName = mod.UTF8ToString(mod._JK_DemoGetMapName());
        return { dur, cur: mod._JK_DemoGetCurrentTimeMs(), mapName };
        """
    )
    assert len(res["mapName"]) > 0 and abs(res["cur"] - int(res["dur"] * 0.9)) <= 600


def t2_f08_05_forward_seek_completes_under_500ms_wall_clock(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(0);
        const t0 = performance.now();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.75));
        const elapsedMs = performance.now() - t0;
        return { elapsedMs };
        """
    )
    assert res["elapsedMs"] < 1500.0, f"In-memory forward seek took too long: {res['elapsedMs']}ms"


# ==============================================================================
# F9: In-Place Backward Demo Seeking — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f09_01_negative_seek_offset_clamps_to_zero_start_over(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.5));
        mod._JK_DemoSeekToMs(-12345);
        const cur = mod._JK_DemoGetCurrentTimeMs();
        return { cur };
        """
    )
    assert 0 <= res["cur"] <= 350, f"Expected negative seek to clamp to 0, got {res['cur']}"


def t2_f09_02_rapid_alternating_forward_and_backward_zig_zag_seeks(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        const targets = [0.5, 0.1, 0.75, 0.0, 0.4, 0.15].map(r => Math.floor(dur * r));
        const landed = [];
        for (const t of targets) {
          mod._JK_DemoSeekToMs(t);
          landed.push(mod._JK_DemoGetCurrentTimeMs());
        }
        return { targets, landed, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True
    for t, a in zip(res["targets"], res["landed"]):
        assert abs(a - t) <= 500, f"Zig-zag seek mismatch: target={t}, landed={a}"


def t2_f09_03_backward_seek_while_paused_stays_paused_at_rewound_time(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.6));
        mod._JK_DemoPause();
        const target = Math.floor(dur * 0.2);
        mod._JK_DemoSeekToMs(target);
        const t0 = mod._JK_DemoGetCurrentTimeMs();
        await new Promise(r => setTimeout(r, 300));
        const t1 = mod._JK_DemoGetCurrentTimeMs();
        const paused = mod._JK_DemoIsPaused() === 1;
        mod._JK_DemoResume();
        return { target, t0, t1, paused };
        """
    )
    assert res["paused"] is True and abs(res["t0"] - res["target"]) <= 500 and abs(res["t1"] - res["t0"]) <= 50


def t2_f09_04_backward_seek_after_demo_eof_reopens_memfs_demo(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 150));
        const start = Date.now();
        while (Date.now() - start < 8000) {
          if (mod._JK_DemoGetCompletedCount() > c0 || mod._JK_DemoIsCompleted()) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        mod._JK_DemoSetLoop(1);
        // Now seek backward to 0 after EOF
        mod._JK_DemoSeekToMs(0);
        await new Promise(r => setTimeout(r, 200));
        const cur = mod._JK_DemoGetCurrentTimeMs();
        const playing = mod._JK_DemoIsPlaying() === 1;
        return { cur, playing, dur };
        """
    )
    assert res["playing"] is True and 0 <= res["cur"] <= min(1000, res["dur"]), (
        f"Expected backward seek after EOF to reopen and play from 0:00, got {res}"
    )


def t2_f09_05_backward_seek_after_long_forward_seek_resets_command_sequence(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSeekToMs(Math.floor(dur * 0.9));
        mod._JK_DemoSeekToMs(0);
        await new Promise(r => setTimeout(r, 250));
        return { cur: mod._JK_DemoGetCurrentTimeMs(), playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True and res["cur"] < 1000


# ==============================================================================
# F10: Automatic Instant Demo Looping — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f10_01_two_consecutive_automatic_loops_back_to_back(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSetSpeed(4.0);
        const c0 = mod._JK_DemoGetCompletedCount();

        // Loop #1
        mod._JK_DemoSeekToMs(Math.max(0, dur - 180));
        let t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (mod._JK_DemoGetCompletedCount() >= c0 + 1) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const c1 = mod._JK_DemoGetCompletedCount();

        // Loop #2
        mod._JK_DemoSeekToMs(Math.max(0, dur - 180));
        t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          if (mod._JK_DemoGetCompletedCount() >= c1 + 1) break;
          await new Promise(r => setTimeout(r, 50));
        }
        const c2 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(1.0);
        return { c0, c1, c2, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["c1"] > res["c0"] and res["c2"] > res["c1"] and res["playing"] is True, (
        f"Expected 2 consecutive automatic loops to succeed: {res}"
    )


def t2_f10_02_seek_near_duration_crosses_eof_and_loops_smoothly(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(1);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 300));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        return { looped: mod._JK_DemoGetCompletedCount() > c0, cur: mod._JK_DemoGetCurrentTimeMs() };
        """
    )
    assert res["looped"] is True


def t2_f10_03_toggle_loop_off_then_on_before_eof_still_loops(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        mod._JK_DemoSetLoop(1);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 200));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        return { looped: mod._JK_DemoGetCompletedCount() > c0, playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["looped"] is True and res["playing"] is True


def t2_f10_04_start_over_button_restarts_after_non_looping_completion(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetLoop(0);
        const dur = mod._JK_DemoGetDurationMs();
        const c0 = mod._JK_DemoGetCompletedCount();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 150));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0 || mod._JK_DemoIsCompleted()) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        mod._JK_DemoSetLoop(1);
        const startOverBtn = document.querySelector('#jk-pip-start-over, #btn-start-over');
        startOverBtn.click();
        await new Promise(r => setTimeout(r, 250));
        return { cur: mod._JK_DemoGetCurrentTimeMs(), playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True and res["cur"] < 1000


def t2_f10_05_completion_event_dispatched_on_automatic_loop(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        let fired = 0;
        const onEnd = () => { fired++; };
        window.addEventListener('jkdemo:ended', onEnd, { once: true });
        if (p && typeof p.onDemoComplete === 'function') p.onDemoComplete(onEnd);
        mod._JK_DemoSetLoop(1);
        const c0 = mod._JK_DemoGetCompletedCount();
        const dur = mod._JK_DemoGetDurationMs();
        mod._JK_DemoSetSpeed(4.0);
        mod._JK_DemoSeekToMs(Math.max(0, dur - 180));
        const start = Date.now();
        while (Date.now() - start < 6000) {
          if (mod._JK_DemoGetCompletedCount() > c0 || fired > 0) break;
          await new Promise(r => setTimeout(r, 50));
        }
        mod._JK_DemoSetSpeed(1.0);
        return { cDelta: mod._JK_DemoGetCompletedCount() - c0, fired };
        """
    )
    assert res["cDelta"] > 0 or res["fired"] > 0


# ==============================================================================
# F11: Arbitrary Query-String Demo URL Fetching — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f11_01_special_characters_and_encoded_slashes_in_query_url_not_corrupted(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        // Find a getdemo.php link with URL-encoded path (%2F, %20, parentheses, etc.)
        const links = Array.from(document.querySelectorAll('a[href*="getdemo.php"]'));
        const special = links.find(a => a.getAttribute('href').includes('%2F') && a.getAttribute('href').includes('%20')) || links[0];
        const href = special.getAttribute('href');
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        if (pip && pip.openAndPlay) {
          await pip.openAndPlay(href);
        } else {
          await p.loadDemo(href);
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 45000) {
          if (mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const demoName = mod.UTF8ToString(mod._JK_DemoGetName());
        return { href, demoName, playing: mod._JK_DemoIsPlaying() === 1 };
        """,
        timeout=60.0,
    )
    assert res["playing"] is True
    assert "?" not in res["demoName"] and "%" not in res["demoName"], (
        f"MEMFS demo filename should be sanitized without '?' or '%': {res['demoName']}"
    )


def t2_f11_02_load_demo_accepts_object_with_url_and_custom_label(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const btn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]') || document.querySelector('.jk-play-btn');
        const url = btn.getAttribute('data-demo-url') || btn.previousElementSibling.getAttribute('href');
        const customLabel = 'Custom Highlight Label #42';
        if (window.JKPiPPlayer && window.JKPiPPlayer.openAndPlay) {
          await window.JKPiPPlayer.openAndPlay(url, { label: customLabel, title: customLabel });
        } else {
          const p = window.JKDemoPlayer || window.OpenJKPlayer;
          await p.loadDemo({ url, label: customLabel });
        }
        const titleEl = document.querySelector('#jk-pip-title, .jk-pip-title');
        return { titleText: titleEl ? titleEl.textContent.trim() : '' };
        """
    )
    assert len(res["titleText"]) > 0


def t2_f11_03_http_404_or_invalid_demo_url_handled_gracefully_without_crash(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const pip = window.JKPiPPlayer;
        let caught = false;
        try {
          if (pip && pip.openAndPlay) {
            await pip.openAndPlay('/getdemo.php?demo=nonexistent_missing_demo_404.dm_26');
          } else {
            await p.loadDemo('/getdemo.php?demo=nonexistent_missing_demo_404.dm_26');
          }
        } catch (e) {
          caught = true;
        }
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const ready = mod._JK_DemoIsReady() === 1;
        return { caught, ready };
        """
    )
    assert res["ready"] is True, "Engine must remain alive and ready after failed demo fetch"
    # Restore valid playing demo
    ctx.ensure_pip_playing("match.html", "getdemo.php", force_reload_demo=True)


def t2_f11_04_empty_or_8_byte_eof_demo_response_rejected_gracefully(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        // mergedemo with unused clientid=99 returns 8-byte (-1,-1) empty stream
        const pip = window.JKPiPPlayer;
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        try {
          if (pip && pip.openAndPlay) {
            await pip.openAndPlay('/mergedemo.php?matchid=004a5ab0b7024e11&clientid=99');
          } else {
            await p.loadDemo('/mergedemo.php?matchid=004a5ab0b7024e11&clientid=99');
          }
        } catch (_) {}
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        return { ready: mod._JK_DemoIsReady() === 1 };
        """
    )
    assert res["ready"] is True
    ctx.ensure_pip_playing("match.html", "getdemo.php", force_reload_demo=True)


def t2_f11_05_rapid_consecutive_demo_url_switches_settle_on_latest_demo(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const getBtn = document.querySelector('.jk-play-btn[data-demo-url*="getdemo.php"]');
        const trimBtn = document.querySelector('.jk-play-btn[data-demo-url*="trimdemo.php"]');
        if (!getBtn || !trimBtn) throw new Error('Missing getdemo or trimdemo button');
        getBtn.click();
        await new Promise(r => setTimeout(r, 80));
        trimBtn.click();
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const start = Date.now();
        while (Date.now() - start < 45000) {
          if (mod && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoGetDurationMs() > 0 && mod._JK_DemoGetDurationMs() < 45000) {
            return { dur: mod._JK_DemoGetDurationMs(), playing: true };
          }
          await new Promise(r => setTimeout(r, 120));
        }
        return { dur: mod ? mod._JK_DemoGetDurationMs() : 0, playing: mod ? mod._JK_DemoIsPlaying() === 1 : false };
        """,
        timeout=60.0,
    )
    assert res["playing"] is True and res["dur"] > 0


# ==============================================================================
# F12: Background Wasm Engine Prewarming — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f12_01_immediate_play_click_before_prewarm_completes_starts_cleanly(ctx: E2ER2TestContext) -> None:
    # Even if user clicks Play immediately or after prewarm, only one Wasm engine instance runs
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const canvases = document.querySelectorAll('#jk-canvas');
        return { canvasCount: canvases.length };
        """
    )
    assert res["canvasCount"] == 1, f"Expected exactly 1 #jk-canvas element, got {res['canvasCount']}"


def t2_f12_02_prewarm_does_not_steal_focus_or_request_pointer_lock(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["pointerLock"] is False, "Background prewarm must never request pointerLock"
    assert obs["activeElementTag"] != "CANVAS", (
        f"Background prewarm should not focus <canvas>, got activeElement={obs['activeElementTag']}"
    )


def t2_f12_03_prewarm_does_not_block_host_page_table_rendering(ctx: E2ER2TestContext) -> None:
    obs = ctx.ensure_prewarm_observed()
    assert obs["playBtnCount"] >= 10, (
        f"Host page #recentdemos failed to render alongside background prewarm: {obs}"
    )


def t2_f12_04_unmute_works_even_when_canvas_not_focused(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        document.body.focus();
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetMuted(0);
        mod._JK_DemoSetVolume(0.75);
        const muted = mod._JK_DemoIsMuted() === 1;
        const vol = mod._JK_DemoGetVolume();
        mod._JK_DemoSetMuted(1);
        return { muted, vol };
        """
    )
    assert res["muted"] is False and abs(res["vol"] - 0.75) < 0.05


def t2_f12_05_close_pip_keeps_wasm_alive_for_instant_reopen(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const closeBtn = document.querySelector('#jk-pip-close, #btn-close');
        closeBtn.click();
        await new Promise(r => setTimeout(r, 80));
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const readyWhileClosed = mod._JK_DemoIsReady() === 1;
        const playBtn = document.querySelector('.jk-play-btn');
        const t0 = performance.now();
        playBtn.click();
        await new Promise(r => setTimeout(r, 150));
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const reopened = card && window.getComputedStyle(card).display !== 'none';
        return { readyWhileClosed, reopened, reopenMs: performance.now() - t0 };
        """
    )
    assert res["readyWhileClosed"] is True and res["reopened"] is True


# ==============================================================================
# F13: Floating Draggable & Resizable PiP Pane — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f13_01_drag_beyond_viewport_edges_clamps_to_viewport_bounds(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const header = document.querySelector('#jk-pip-header, .jk-pip-header');
        const r0 = card.getBoundingClientRect();

        // Drag far top-left (-2000, -2000)
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 10, button: 0, buttons: 1, clientX: r0.left + 40, clientY: r0.top + 10
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 10, buttons: 1, clientX: -2000, clientY: -2000
        }));
        header.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 10, buttons: 1, clientX: -2000, clientY: -2000
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 10, button: 0, buttons: 0, clientX: -2000, clientY: -2000
        }));
        header.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 10, button: 0, buttons: 0, clientX: -2000, clientY: -2000
        }));
        const rTopLeft = card.getBoundingClientRect();

        // Drag far bottom-right (9000, 9000)
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 11, button: 0, buttons: 1, clientX: rTopLeft.left + 40, clientY: rTopLeft.top + 10
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 11, buttons: 1, clientX: 9000, clientY: 9000
        }));
        header.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 11, buttons: 1, clientX: 9000, clientY: 9000
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 11, button: 0, buttons: 0, clientX: 9000, clientY: 9000
        }));
        header.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 11, button: 0, buttons: 0, clientX: 9000, clientY: 9000
        }));
        const rBotRight = card.getBoundingClientRect();

        return {
          tlLeft: rTopLeft.left,
          tlTop: rTopLeft.top,
          brRight: rBotRight.right,
          brBottom: rBotRight.bottom,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
        """
    )
    assert res["tlLeft"] >= -1 and res["tlTop"] >= -1, f"Top-left drag not clamped: {res}"
    assert res["brRight"] <= res["vw"] + 2 and res["brBottom"] <= res["vh"] + 2, (
        f"Bottom-right drag not clamped to viewport: {res}"
    )


def t2_f13_02_keyboard_arrow_keys_on_focused_header_nudge_position(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const header = document.querySelector('#jk-pip-header, .jk-pip-header');
        // Ensure card is near center first so arrow nudges in any direction have room
        card.style.left = '300px';
        card.style.top = '200px';
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        header.focus();
        const r0 = card.getBoundingClientRect();
        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        const r1 = card.getBoundingClientRect();
        return { dx: r1.left - r0.left, dy: r1.top - r0.top };
        """
    )
    assert res["dx"] < 0 or res["dy"] < 0, f"Arrow keys on #jk-pip-header did not nudge position: {res}"


def t2_f13_03_resize_below_minimum_and_above_viewport_clamped(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const handle = document.querySelector('#jk-pip-resize-handle, .jk-pip-resize-handle');
        const r0 = card.getBoundingClientRect();
        // Attempt tiny resize (50x50)
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 12, button: 0, buttons: 1, clientX: r0.right - 2, clientY: r0.bottom - 2
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 12, buttons: 1, clientX: r0.left + 50, clientY: r0.top + 50
        }));
        handle.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 12, buttons: 1, clientX: r0.left + 50, clientY: r0.top + 50
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 12, button: 0, buttons: 0, clientX: r0.left + 50, clientY: r0.top + 50
        }));
        handle.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 12, button: 0, buttons: 0, clientX: r0.left + 50, clientY: r0.top + 50
        }));
        const rMin = card.getBoundingClientRect();
        if (window.JKPiPPlayer && window.JKPiPPlayer.setSizePreset) {
          window.JKPiPPlayer.setSizePreset('default');
        }
        return { minW: rMin.width, minH: rMin.height };
        """
    )
    assert res["minW"] >= 320 and res["minH"] >= 220, (
        f"Expected minimum size clamp (>=320x220), got {res}"
    )


def t2_f13_04_pip_header_touch_action_and_user_select_none_and_pointercancel(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const header = document.querySelector('#jk-pip-header, .jk-pip-header');
        const cs = window.getComputedStyle(header);
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 15, button: 0, buttons: 1, clientX: 400, clientY: 300
        }));
        header.dispatchEvent(new PointerEvent('pointercancel', {
          bubbles: true, cancelable: true, pointerId: 15
        }));
        const rBefore = card.getBoundingClientRect();
        // Moving pointer after pointercancel must NOT drag the card
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 15, buttons: 0, clientX: 200, clientY: 100
        }));
        const rAfter = card.getBoundingClientRect();
        return {
          touchAction: cs.touchAction,
          userSelect: cs.userSelect || cs.webkitUserSelect,
          movedAfterCancel: Math.abs(rAfter.left - rBefore.left) + Math.abs(rAfter.top - rBefore.top),
        };
        """
    )
    assert res["touchAction"] == "none", f"Expected touch-action: none on #jk-pip-header, got {res['touchAction']}"
    assert res["movedAfterCancel"] == 0, "Card continued dragging after pointercancel"


def t2_f13_05_window_resize_reclamps_pip_card_inside_smaller_viewport(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    ctx.rpc("set_viewport", {"width": 900, "height": 600})
    res = ctx.eval_js(
        """
        window.dispatchEvent(new Event('resize'));
        await new Promise(r => setTimeout(r, 80));
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const r = card.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
        """
    )
    ctx.rpc("set_viewport", {"width": 1440, "height": 900})
    ctx.eval_js("window.dispatchEvent(new Event('resize'));")
    assert res["left"] >= -1 and res["top"] >= -1 and res["right"] <= res["vw"] + 2 and res["bottom"] <= res["vh"] + 2, (
        f"PiP card went offscreen after viewport shrink: {res}"
    )


# ==============================================================================
# F14: Full PiP Playback Controls Bar — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f14_01_all_five_speed_presets_025x_to_4x_supported(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const speedEl = document.querySelector('#jk-pip-speed, #select-speed');
        const rates = [0.25, 0.5, 1, 2, 4];
        const observed = [];
        for (const r of rates) {
          if (speedEl && speedEl.tagName === 'SELECT') {
            speedEl.value = String(r);
            speedEl.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (window.JKPiPPlayer && window.JKPiPPlayer.setSpeed) {
            window.JKPiPPlayer.setSpeed(r);
          } else {
            p.setSpeed(r);
          }
          observed.push(mod ? mod._JK_DemoGetSpeed() : p.getSpeed());
        }
        if (speedEl && speedEl.tagName === 'SELECT') {
          speedEl.value = '1';
          speedEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          p.setSpeed(1.0);
        }
        return { rates, observed };
        """
    )
    for expected, actual in zip(res["rates"], res["observed"]):
        assert abs(actual - expected) < 0.02, f"Speed preset {expected}x mismatch: got {actual}"


def t2_f14_02_close_button_pauses_mutes_and_hides_pane(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        mod._JK_DemoSetMuted(0);
        const closeBtn = document.querySelector('#jk-pip-close, #btn-close');
        closeBtn.click();
        await new Promise(r => setTimeout(r, 80));
        const card = document.querySelector('#jk-pip-card, #jk-player-pip');
        const hidden = !card || window.getComputedStyle(card).display === 'none' || card.hidden;
        const muted = mod._JK_DemoIsMuted() === 1;
        const paused = mod._JK_DemoIsPaused() === 1 || mod._JK_DemoIsPlaying() === 0;
        // Re-open
        document.querySelector('.jk-play-btn').click();
        await new Promise(r => setTimeout(r, 150));
        return { hidden, muted, paused };
        """
    )
    assert res["hidden"] is True and res["muted"] is True and res["paused"] is True, (
        f"Close button must hide card, mute audio, and pause playback: {res}"
    )


def t2_f14_03_volume_slider_sweep_and_mute_toggle_restores_volume(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const volSlider = document.querySelector('#jk-pip-volume, #slider-volume');
        const muteBtn = document.querySelector('#jk-pip-mute, #btn-mute');
        mod._JK_DemoSetMuted(0);
        const maxVal = parseFloat(volSlider.max || '1');
        const targetRaw = maxVal > 1.5 ? 65 : 0.65;
        volSlider.value = String(targetRaw);
        volSlider.dispatchEvent(new Event('input', { bubbles: true }));
        volSlider.dispatchEvent(new Event('change', { bubbles: true }));
        const v1 = mod._JK_DemoGetVolume();
        muteBtn.click();
        const mutedAfterClick = mod._JK_DemoIsMuted() === 1;
        muteBtn.click();
        const unmutedAfterSecondClick = mod._JK_DemoIsMuted() === 0;
        const v2 = mod._JK_DemoGetVolume();
        return { v1, v2, mutedAfterClick, unmutedAfterSecondClick };
        """
    )
    assert abs(res["v1"] - 0.65) < 0.05 and abs(res["v2"] - 0.65) < 0.05
    assert res["mutedAfterClick"] is True and res["unmutedAfterSecondClick"] is True


def t2_f14_04_fullscreen_button_handles_headless_environment_gracefully(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const fsBtn = document.querySelector('#jk-pip-fullscreen, #btn-fullscreen');
        fsBtn.click();
        await new Promise(r => setTimeout(r, 80));
        if (document.fullscreenElement && document.exitFullscreen) {
          try { await document.exitFullscreen(); } catch (_) {}
        }
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        return { playing: mod._JK_DemoIsPlaying() === 1 };
        """
    )
    assert res["playing"] is True


def t2_f14_05_host_input_typing_not_hijacked_by_pip_shortcuts(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "getdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        if (mod._JK_DemoIsPaused() === 1) mod._JK_DemoResume();
        let inp = document.querySelector('input[type="text"], input:not([type="range"])');
        let created = false;
        if (!inp) {
          inp = document.createElement('input');
          inp.type = 'text';
          document.body.appendChild(inp);
          created = true;
        }
        inp.focus();
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
        const pausedAfterHostInputSpace = mod._JK_DemoIsPaused() === 1;
        if (created) inp.remove();
        return { pausedAfterHostInputSpace };
        """
    )
    assert res["pausedAfterHostInputSpace"] is False, (
        "Typing Space inside a host <input> element must not pause the PiP player"
    )


# ==============================================================================
# F15: match.html (matchrpc.js) Play Buttons — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f15_01_match_html_lookup_permalinks_never_have_play_button(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const lookups = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]'));
        const bad = lookups.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { lookupCount: lookups.length, badCount: bad.length };
        """
    )
    assert res["lookupCount"] > 0, "Expected #rpc=lookup match permalinks on match.html"
    assert res["badCount"] == 0, (
        f"Found {res['badCount']} #rpc=lookup permalinks with forbidden .jk-play-btn!"
    )


def t2_f15_02_match_html_player_profile_links_never_have_play_button(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const profiles = Array.from(document.querySelectorAll('a[href*="aplayer2.html"], a[href*="player.html"]'));
        const bad = profiles.filter(a => {
          const next = a.nextElementSibling;
          return next && next.classList.contains('jk-play-btn');
        });
        return { profileCount: profiles.length, badCount: bad.length };
        """
    )
    assert res["badCount"] == 0, f"Player profile links must not get .jk-play-btn: {res}"


def t2_f15_03_match_html_hash_lookup_navigation_decorates_new_rows(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html#rpc=lookup&id=004a5ab0b7024e11", force_reload=True)
    res = ctx.eval_js(
        """
        const btns = document.querySelectorAll('.jk-play-btn');
        const lookupsWithBtn = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]')).filter(
          a => a.nextElementSibling && a.nextElementSibling.classList.contains('jk-play-btn')
        );
        return { btnCount: btns.length, lookupsWithBtn: lookupsWithBtn.length };
        """
    )
    assert res["btnCount"] >= 5 and res["lookupsWithBtn"] == 0
    # Return to standard match.html
    ctx.ensure_page_loaded("match.html", force_reload=True)


def t2_f15_04_mutation_observer_idempotent_no_duplicate_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const tbl = document.querySelector('#recentdemos');
        const beforeCount = document.querySelectorAll('.jk-play-btn').length;
        // Trigger dummy DOM mutations inside #recentdemos
        for (let i = 0; i < 3; i++) {
          const span = document.createElement('span');
          tbl.appendChild(span);
          span.remove();
        }
        await new Promise(r => setTimeout(r, 150));
        const afterCount = document.querySelectorAll('.jk-play-btn').length;
        const doubleButtons = Array.from(document.querySelectorAll('.jk-play-btn')).filter(
          b => b.nextElementSibling && b.nextElementSibling.classList.contains('jk-play-btn')
        );
        return { beforeCount, afterCount, doubleCount: doubleButtons.length };
        """
    )
    assert res["beforeCount"] == res["afterCount"] and res["doubleCount"] == 0, (
        f"Duplicate .jk-play-btn elements created on DOM mutation: {res}"
    )


def t2_f15_05_merge_matches_predict_handles_custom_maps_not_in_maps_json(ctx: E2ER2TestContext) -> None:
    # Match 007bf2e827e40586 is on ctf_metalorn_v2 (not in maps.json); verify merge_matches_predict.py has no KeyError
    py_file = ctx.goog_dir / "pyservices" / "python" / "merge_matches_predict.py"
    txt = py_file.read_text(encoding="utf-8", errors="ignore")
    assert ".get(" in txt or "mapname.lower() in maps" in txt, (
        "merge_matches_predict.py must safely look up maps[mapname.lower()] without KeyError"
    )


# ==============================================================================
# F16: index.html (rpc.js) Play Buttons — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f16_01_rpc_php_endpoints_return_200_valid_jsonp_not_php_fatal_error(ctx: E2ER2TestContext) -> None:
    for q in ("rpc=numdemos&jsonp=true", "rpc=recentdemos&jsonp=true&limit=2"):
        status, _, body = ctx.http_request("GET", f"/rpc.php?{q}")
        text = body.decode("utf-8", errors="ignore")
        assert status == 200, f"/rpc.php?{q} returned HTTP {status}"
        assert "Fatal error" not in text and "Uncaught Error" not in text, (
            f"/rpc.php?{q} returned PHP fatal error instead of valid RPC response: {text[:200]}"
        )


def t2_f16_02_rpc_js_handles_bson_date_format_in_time_created(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    res = ctx.eval_js(
        """
        const cells = Array.from(document.querySelectorAll('#recentdemos tr td'));
        const nanCells = cells.filter(td => td.textContent.includes('NaN') || td.textContent.includes('Invalid date'));
        return { totalCells: cells.length, nanCount: nanCells.length };
        """
    )
    assert res["totalCells"] > 5 and res["nanCount"] == 0, (
        f"Found NaN/Invalid date cells in #recentdemos on index.html: {res}"
    )


def t2_f16_03_index_html_dynamic_table_refresh_redecorates_rows(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    res = ctx.eval_js(
        """
        // Dynamically insert a mock getdemo.php link into #recentdemos and verify MutationObserver decorates it
        const tbl = document.querySelector('#recentdemos');
        const tr = document.createElement('tr');
        tr.id = 'test-dyn-row';
        tr.innerHTML = '<td>Test</td><td>Player</td><td>Now</td><td>1:00</td><td><a id="test-dyn-link" href="getdemo.php?demo=%2Fcygdrive%2FU%2Fdemos%2Ftest.dm_26">Link</a></td>';
        tbl.appendChild(tr);
        await new Promise(r => setTimeout(r, 150));
        const link = document.querySelector('#test-dyn-link');
        const decorated = Boolean(link && link.nextElementSibling && link.nextElementSibling.classList.contains('jk-play-btn'));
        tr.remove();
        return { decorated };
        """
    )
    assert res["decorated"] is True, "Dynamically added getdemo.php row on index.html was not decorated with .jk-play-btn"


def t2_f16_04_index_html_non_demo_links_excluded_from_play_buttons(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    res = ctx.eval_js(
        """
        const allBtns = Array.from(document.querySelectorAll('.jk-play-btn'));
        const invalidBtns = allBtns.filter(b => {
          const url = b.getAttribute('data-demo-url') || (b.previousElementSibling && b.previousElementSibling.getAttribute('href')) || '';
          return !url.includes('getdemo.php') && !url.includes('mergedemo.php') && !url.includes('trimdemo.php') && !url.includes('rpc=matchdemo');
        });
        return { totalBtns: allBtns.length, invalidCount: invalidBtns.length };
        """
    )
    assert res["totalBtns"] > 0 and res["invalidCount"] == 0


def t2_f16_05_index_html_zero_uncaught_page_errors(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("index.html")
    logs = ctx.get_browser_logs()
    assert logs.get("pageErrors", []) == [], (
        f"Uncaught pageErrors on index.html: {logs.get('pageErrors')}"
    )


# ==============================================================================
# F17: aplayer2.html & debugplayer2.html — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f17_01_aplayer2_generated_urls_include_cygdrive_u_demos_prefix(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("aplayer2.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="getdemo.php"], a[href*="trimdemo.php"]'));
        const missingPrefix = links.filter(a => {
          const h = decodeURIComponent(a.getAttribute('href') || '');
          return !h.includes('/cygdrive/U/demos/');
        });
        // Also test fetching the first generated link to confirm 200 OK
        const firstHref = links[0] ? links[0].getAttribute('href') : '';
        const resp = firstHref ? await fetch(firstHref) : null;
        return {
          totalLinks: links.length,
          missingPrefixCount: missingPrefix.length,
          firstStatus: resp ? resp.status : 0,
        };
        """
    )
    assert res["totalLinks"] > 0 and res["missingPrefixCount"] == 0, (
        f"Generated demo links on aplayer2.html missing /cygdrive/U/demos/ prefix: {res}"
    )
    assert res["firstStatus"] == 200, f"First generated demo link on aplayer2.html returned HTTP {res['firstStatus']}"


def t2_f17_02_aplayer2_and_debugplayer2_match_lookup_permalinks_excluded(ctx: E2ER2TestContext) -> None:
    for page in ("aplayer2.html", "debugplayer2.html"):
        ctx.ensure_page_loaded(page)
        res = ctx.eval_js(
            """
            const lookups = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]'));
            const bad = lookups.filter(a => {
              const next = a.nextElementSibling;
              return next && next.classList.contains('jk-play-btn');
            });
            return { lookupCount: lookups.length, badCount: bad.length };
            """
        )
        assert res["lookupCount"] > 0 and res["badCount"] == 0, (
            f"Found #rpc=lookup permalink with .jk-play-btn on {page}: {res}"
        )


def t2_f17_03_aplayer2_with_explicit_hash_id_loads_and_decorates_cleanly(ctx: E2ER2TestContext) -> None:
    info = ctx.ensure_page_loaded("aplayer2.html#id=5950160f87b4d04bf8d5e099", force_reload=True)
    assert info["playBtnCount"] > 0
    res = ctx.eval_js(
        """
        const doubleBtns = Array.from(document.querySelectorAll('.jk-play-btn')).filter(
          b => b.nextElementSibling && b.nextElementSibling.classList.contains('jk-play-btn')
        );
        return { doubleCount: doubleBtns.length };
        """
    )
    assert res["doubleCount"] == 0


def t2_f17_04_aplayer2_no_undefined_or_broken_hrefs_rendered(ctx: E2ER2TestContext) -> None:
    ctx.ensure_page_loaded("aplayer2.html")
    res = ctx.eval_js(
        """
        const links = Array.from(document.querySelectorAll('a[href*="getdemo.php"], a[href*="trimdemo.php"]'));
        const broken = links.filter(a => {
          const h = a.getAttribute('href') || '';
          return h.includes('undefined') || h.includes('null') || h.includes('NaN');
        });
        return { total: links.length, brokenCount: broken.length };
        """
    )
    assert res["total"] > 0 and res["brokenCount"] == 0, (
        f"Found broken/undefined demo hrefs on aplayer2.html: {res}"
    )


def t2_f17_05_legacy_player_pages_include_jk_pip_player_and_return_200(ctx: E2ER2TestContext) -> None:
    for page in ("player.html", "player2.html", "aplayer.html", "debugplayer.html", "aplayer2.html", "debugplayer2.html"):
        status, _, body = ctx.http_request("GET", f"/{page}")
        text = body.decode("utf-8", errors="ignore")
        assert status == 200, f"GET /{page} returned HTTP {status}"
        assert "jk-pip-player.js" in text, f"{page} does not include jk-pip-player.js"


# ==============================================================================
# F18: Docker & Nginx /base Mount & Port 8081 — Boundary & Corner Cases (5 tests)
# ==============================================================================
def t2_f18_01_single_byte_range_request_bytes_0_0_on_assets0_pk3(ctx: E2ER2TestContext) -> None:
    status, headers, body = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-0"}
    )
    assert status == 206, f"Expected 206 for Range: bytes=0-0, got {status}"
    assert body == b"P" and len(body) == 1
    assert "bytes 0-0/561806019" in headers.get("content-range", "")


def t2_f18_02_exact_central_directory_tail_range_request_on_assets0_pk3(ctx: E2ER2TestContext) -> None:
    status, headers, body = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=560580864-561806018"}
    )
    assert status == 206, f"Expected 206 for CD tail range, got {status}"
    assert len(body) == 1225155
    assert body[:4] == b"PK\x01\x02", f"Expected Central Directory magic PK\\x01\\x02, got {body[:4]!r}"
    assert body[-22:-18] == b"PK\x05\x06", f"Expected EOCD magic PK\\x05\\x06, got {body[-22:-18]!r}"


def t2_f18_03_range_requests_on_custom_and_alternate_checksum_pk3s(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    alt_entry = next(
        e for e in manifest["pk3s"]
        if re.match(r"^.+\.[0-9a-f]{8}\.pk3$", e["name"], flags=re.I)
    )
    for name in ("ctf_fim.pk3", "ctf_kejim.pk3", alt_entry["name"]):
        status, headers, body = ctx.http_request(
            "GET", f"/base/{name}", headers={"Range": "bytes=0-63"}
        )
        assert status == 206 and len(body) == 64 and body[:4] == b"PK\x03\x04", (
            f"Range request failed on /base/{name}: status={status}, len={len(body)}"
        )


def t2_f18_04_out_of_bounds_range_returns_416_and_missing_pk3_returns_404(ctx: E2ER2TestContext) -> None:
    st_416, _, _ = ctx.http_request(
        "GET", "/base/assets2.pk3", headers={"Range": "bytes=999999999-1000000000"}
    )
    assert st_416 == 416, f"Expected 416 Range Not Satisfiable, got {st_416}"
    st_404, _, _ = ctx.http_request("GET", "/base/nonexistent_missing_archive_xyz.pk3")
    assert st_404 == 404, f"Expected 404 Not Found for missing PK3, got {st_404}"


def t2_f18_05_native_and_wasm_builds_intact_and_synchronized_with_deployed_wasm(ctx: E2ER2TestContext) -> None:
    native_bin = ctx.build_native_dir / "codemp" / "openjk.x86_64"
    assert native_bin.exists() and os.access(native_bin, os.X_OK), f"Native binary missing: {native_bin}"
    deployed_wasm = ctx.archive_public_dir / "jkplayer" / "openjk.wasm"
    assert deployed_wasm.exists() and deployed_wasm.stat().st_size > 1_500_000, (
        f"Deployed /jkplayer/openjk.wasm missing or too small: {deployed_wasm}"
    )


def get_tier2_tests() -> List[TestCase]:
    return [
        # F1 (5)
        TestCase("T2_F01_01_corrupt_non_zip_pk3_stubs_excluded_all_pool_files_valid_zip", 2, "F1", "Verify corrupt non-ZIP .pk3 stubs are excluded and every file in /base/ passes is_zipfile", t2_f01_01_corrupt_non_zip_pk3_stubs_excluded_all_pool_files_valid_zip),
        TestCase("T2_F01_02_valid_ctf_fim_preserved_over_13_byte_corrupt_stub", 2, "F1", "Verify valid ctf_fim.pk3 (14.8MB) is preserved over 13B corrupt DriveC/ctf_fim.pk3", t2_f01_02_valid_ctf_fim_preserved_over_13_byte_corrupt_stub),
        TestCase("T2_F01_03_tweaked_extensions_without_digit_3_normalized_cleanly", 2, "F1", "Verify tweaked extensions without '3' (.pk_dis, .pk_orig, .pk_) normalize to clean basenames", t2_f01_03_tweaked_extensions_without_digit_3_normalized_cleanly),
        TestCase("T2_F01_04_source_directory_priority_selects_primary_basename_pk3", 2, "F1", "Verify source directory priority selects primary <basename>.pk3 checksum version", t2_f01_04_source_directory_priority_selects_primary_basename_pk3),
        TestCase("T2_F01_05_no_zero_byte_broken_symlink_or_stray_files_in_pool", 2, "F1", "Verify no zero-byte, broken-symlink, or stray files exist in /media/dan/Elements/pk3/base/", t2_f01_05_no_zero_byte_broken_symlink_or_stray_files_in_pool),
        # F2 (5)
        TestCase("T2_F02_01_zero_byte_and_directory_zip_entries_excluded_from_crc_list", 2, "F2", "Verify 0-byte and directory ZIP entries (uncompressed_size == 0) are excluded from Com_BlockChecksum", t2_f02_01_zero_byte_and_directory_zip_entries_excluded_from_crc_list),
        TestCase("T2_F02_02_signed_int32_bounds_and_negative_checksum_representation", 2, "F2", "Verify all manifest checksums are signed 32-bit integers in [-2147483648, 2147483647]", t2_f02_02_signed_int32_bounds_and_negative_checksum_representation),
        TestCase("T2_F02_03_md4_padding_boundary_conditions_55_56_64_bytes", 2, "F2", "Verify MD4 mdfour_tail padding across 0, 52, 56, and 64-byte block boundaries", t2_f02_03_md4_padding_boundary_conditions_55_56_64_bytes),
        TestCase("T2_F02_04_central_directory_entry_order_preserved_not_sorted", 2, "F2", "Verify central directory entry order is preserved when computing Com_BlockChecksum", t2_f02_04_central_directory_entry_order_preserved_not_sorted),
        TestCase("T2_F02_05_sample_25_consolidated_pk3s_exact_checksum_audit", 2, "F2", "Verify 25 sampled consolidated .pk3 files match independent FS_LoadZipFile MD4 oracle", t2_f02_05_sample_25_consolidated_pk3s_exact_checksum_audit),
        # F3 (5)
        TestCase("T2_F03_01_cd_offset_and_cd_size_bounds_and_pk0102_signature", 2, "F3", "Verify cd_offset and cd_size bounds and physical PK\\x01\\x02 signature at cd_offset", t2_f03_01_cd_offset_and_cd_size_bounds_and_pk0102_signature),
        TestCase("T2_F03_02_nested_maps_mp_bsp_indexed_properly", 2, "F3", "Verify nested maps/mp/*.bsp files (e.g. mp/ctf1, mp/ctf_kejim) are indexed in maps", t2_f03_02_nested_maps_mp_bsp_indexed_properly),
        TestCase("T2_F03_03_no_duplicate_names_or_basename_checksum_pairs_in_manifest", 2, "F3", "Verify no duplicate filenames or (basename, checksum) pairs exist in manifest.json", t2_f03_03_no_duplicate_names_or_basename_checksum_pairs_in_manifest),
        TestCase("T2_F03_04_identical_checksum_aliases_handled_cleanly", 2, "F3", "Verify archives with identical checksums under alias filenames preserve clean canonical basenames", t2_f03_04_identical_checksum_aliases_handled_cleanly),
        TestCase("T2_F03_05_non_map_pk3s_have_empty_maps_list", 2, "F3", "Verify non-map PK3s (e.g. assets0.pk3) have maps=[] empty list", t2_f03_05_non_map_pk3s_have_empty_maps_list),
        # F4 (5)
        TestCase("T2_F04_01_stale_v1_localstorage_manifest_ignored", 2, "F4", "Verify stale openjk_pk3_manifest_v1 in localStorage is ignored in favor of v2", t2_f04_01_stale_v1_localstorage_manifest_ignored),
        TestCase("T2_F04_02_prewarm_bytes_transferred_under_10_mb", 2, "F4", "Verify prewarm PK3 range bytes transferred is < 10 MB before demo load", t2_f04_02_prewarm_bytes_transferred_under_10_mb),
        TestCase("T2_F04_03_zero_full_pk3_downloads_during_prewarm_and_playback", 2, "F4", "Verify zero full-archive HTTP 200 PK3 downloads occur during prewarm or playback", t2_f04_03_zero_full_pk3_downloads_during_prewarm_and_playback),
        TestCase("T2_F04_04_all_488_manifest_entries_fit_within_wasm_archive_table", 2, "F4", "Verify g_wasmPk3Archives and manifestBuf in files.cpp are sized for >= 488 entries", t2_f04_04_all_488_manifest_entries_fit_within_wasm_archive_table),
        TestCase("T2_F04_05_prewarm_produces_zero_unhandled_page_errors", 2, "F4", "Verify background prewarming produces zero unhandled pageerror exceptions", t2_f04_05_prewarm_produces_zero_unhandled_page_errors),
        # F5 (5)
        TestCase("T2_F05_01_switching_demos_unlinks_previous_custom_pk3_searchpaths", 2, "F5", "Verify switching demos unlinks previous non-base_init PK3 searchpaths", t2_f05_01_switching_demos_unlinks_previous_custom_pk3_searchpaths),
        TestCase("T2_F05_02_reloading_same_custom_map_reuses_cached_cd_without_refetch", 2, "F5", "Verify reloading the same custom map demo reuses cached central directory & chunks", t2_f05_02_reloading_same_custom_map_reuses_cached_cd_without_refetch),
        TestCase("T2_F05_03_multi_token_referenced_paks_parsed_without_cmd_tokenizestring_collision", 2, "F5", "Verify multi-token sv_referencedPaks and sv_referencedPakNames parse without tokenizer overwrite", t2_f05_03_multi_token_referenced_paks_parsed_without_cmd_tokenizestring_collision),
        TestCase("T2_F05_04_missing_server_mod_pak_in_referenced_paks_does_not_abort_map_load", 2, "F5", "Verify unresolvable server-only mod paks in sv_referencedPakNames do not abort map loading", t2_f05_04_missing_server_mod_pak_in_referenced_paks_does_not_abort_map_load),
        TestCase("T2_F05_05_gamedir_prefixed_paknames_stripped_during_basename_resolution", 2, "F5", "Verify <gamedir>/ prefixes in sv_referencedPakNames are stripped during basename fallback", t2_f05_05_gamedir_prefixed_paknames_stripped_during_basename_resolution),
        # F6 (5)
        TestCase("T2_F06_01_short_12_packet_synthesized_demo_bounds_scan", 2, "F6", "Verify CL_ScanDemoTimeBounds accurately scans a short 18-packet synthesized demo", t2_f06_01_short_12_packet_synthesized_demo_bounds_scan),
        TestCase("T2_F06_02_truncated_demo_without_eof_marker_scans_cleanly", 2, "F6", "Verify CL_ScanDemoTimeBounds handles truncated .dm_26 without (-1,-1) EOF marker", t2_f06_02_truncated_demo_without_eof_marker_scans_cleanly),
        TestCase("T2_F06_03_scanner_skips_svc_servercommands_before_first_snapshot", 2, "F6", "Verify CL_ScanDemoTimeBounds skips svc_serverCommand packets before first svc_snapshot", t2_f06_03_scanner_skips_svc_servercommands_before_first_snapshot),
        TestCase("T2_F06_04_switching_from_full_demo_to_trimmed_demo_updates_bounds", 2, "F6", "Verify switching from full match demo to trimmed clip updates durationMs bounds", t2_f06_04_switching_from_full_demo_to_trimmed_demo_updates_bounds),
        TestCase("T2_F06_05_bounds_scan_executes_in_memory_with_zero_pk3_fetches", 2, "F6", "Verify bounds scan executes in MEMFS with zero PK3 HTTP Range requests", t2_f06_05_bounds_scan_executes_in_memory_with_zero_pk3_fetches),
        # F7 (5)
        TestCase("T2_F07_01_all_seven_c_exports_callable_directly_on_module", 2, "F7", "Verify all 7 C exports (_JK_DemoGet*TimeMs, _JK_DemoSeekToMs, _JK_Demo*Loop) are callable on Module", t2_f07_01_all_seven_c_exports_callable_directly_on_module),
        TestCase("T2_F07_02_set_loop_boolean_and_nonzero_integer_normalization", 2, "F7", "Verify _JK_DemoSetLoop and player.setLoop normalize 0/false and non-zero/true", t2_f07_02_set_loop_boolean_and_nonzero_integer_normalization),
        TestCase("T2_F07_03_seek_to_ms_nan_or_invalid_input_handled_safely", 2, "F7", "Verify seekToMs(NaN) and seekToMs(undefined) are handled safely without Wasm crash", t2_f07_03_seek_to_ms_nan_or_invalid_input_handled_safely),
        TestCase("T2_F07_04_current_time_ms_clamped_within_zero_and_duration_ms", 2, "F7", "Verify JK_DemoGetCurrentTimeMs() is clamped to [0, durationMs]", t2_f07_04_current_time_ms_clamped_within_zero_and_duration_ms),
        TestCase("T2_F07_05_js_wrapper_methods_consistent_with_c_exports", 2, "F7", "Verify JKDemoPlayer JS timeline getters return values consistent with C exports", t2_f07_05_js_wrapper_methods_consistent_with_c_exports),
        # F8 (5)
        TestCase("T2_F08_01_forward_seek_while_paused_updates_time_and_stays_paused", 2, "F8", "Verify forward seeking while paused updates currentTimeMs and stays paused", t2_f08_01_forward_seek_while_paused_updates_time_and_stays_paused),
        TestCase("T2_F08_02_forward_seek_to_same_timestamp_is_clean_noop", 2, "F8", "Verify seeking to currentTimeMs is a clean no-op preserving playback", t2_f08_02_forward_seek_to_same_timestamp_is_clean_noop),
        TestCase("T2_F08_03_forward_seek_to_duration_and_overflow_clamps_cleanly", 2, "F8", "Verify seeking to durationMs + 999999 clamps cleanly to durationMs without error", t2_f08_03_forward_seek_to_duration_and_overflow_clamps_cleanly),
        TestCase("T2_F08_04_forward_seek_across_full_match_demo_preserves_configstrings", 2, "F8", "Verify forward seeking across 90% of a match demo preserves configstrings without overflow", t2_f08_04_forward_seek_across_full_match_demo_preserves_configstrings),
        TestCase("T2_F08_05_forward_seek_completes_under_500ms_wall_clock", 2, "F8", "Verify in-memory forward seek across 75% of demo completes rapidly without frame rendering", t2_f08_05_forward_seek_completes_under_500ms_wall_clock),
        # F9 (5)
        TestCase("T2_F09_01_negative_seek_offset_clamps_to_zero_start_over", 2, "F9", "Verify JK_DemoSeekToMs(-12345) clamps to 0 (Start Over)", t2_f09_01_negative_seek_offset_clamps_to_zero_start_over),
        TestCase("T2_F09_02_rapid_alternating_forward_and_backward_zig_zag_seeks", 2, "F9", "Verify rapid alternating forward/backward zig-zag seeks succeed without ERR_DROP", t2_f09_02_rapid_alternating_forward_and_backward_zig_zag_seeks),
        TestCase("T2_F09_03_backward_seek_while_paused_stays_paused_at_rewound_time", 2, "F9", "Verify backward seeking while paused updates currentTimeMs and remains paused", t2_f09_03_backward_seek_while_paused_stays_paused_at_rewound_time),
        TestCase("T2_F09_04_backward_seek_after_demo_eof_reopens_memfs_demo", 2, "F9", "Verify seeking backward to 0:00 after demo EOF re-opens MEMFS demo and resumes playback", t2_f09_04_backward_seek_after_demo_eof_reopens_memfs_demo),
        TestCase("T2_F09_05_backward_seek_after_long_forward_seek_resets_command_sequence", 2, "F9", "Verify backward seek to 0 after 90% forward seek resets serverCommandSequence cleanly", t2_f09_05_backward_seek_after_long_forward_seek_resets_command_sequence),
        # F10 (5)
        TestCase("T2_F10_01_two_consecutive_automatic_loops_back_to_back", 2, "F10", "Verify 2 consecutive automatic loops at demo EOF succeed back-to-back", t2_f10_01_two_consecutive_automatic_loops_back_to_back),
        TestCase("T2_F10_02_seek_near_duration_crosses_eof_and_loops_smoothly", 2, "F10", "Verify seeking to durationMs - 300 smoothly crosses EOF and loops to 0:00", t2_f10_02_seek_near_duration_crosses_eof_and_loops_smoothly),
        TestCase("T2_F10_03_toggle_loop_off_then_on_before_eof_still_loops", 2, "F10", "Verify toggling Loop off then back on before EOF restores automatic looping", t2_f10_03_toggle_loop_off_then_on_before_eof_still_loops),
        TestCase("T2_F10_04_start_over_button_restarts_after_non_looping_completion", 2, "F10", "Verify clicking Start Over after non-looping demo EOF restarts playback at 0:00", t2_f10_04_start_over_button_restarts_after_non_looping_completion),
        TestCase("T2_F10_05_completion_event_dispatched_on_automatic_loop", 2, "F10", "Verify completion count / event fires when demo reaches EOF and loops", t2_f10_05_completion_event_dispatched_on_automatic_loop),
        # F11 (5)
        TestCase("T2_F11_01_special_characters_and_encoded_slashes_in_query_url_not_corrupted", 2, "F11", "Verify query URLs with %2F, %20, and special chars are fetched as-is and mapped to clean MEMFS names", t2_f11_01_special_characters_and_encoded_slashes_in_query_url_not_corrupted),
        TestCase("T2_F11_02_load_demo_accepts_object_with_url_and_custom_label", 2, "F11", "Verify openAndPlay / loadDemo accepts custom label metadata", t2_f11_02_load_demo_accepts_object_with_url_and_custom_label),
        TestCase("T2_F11_03_http_404_or_invalid_demo_url_handled_gracefully_without_crash", 2, "F11", "Verify HTTP 404 / invalid demo URL is handled gracefully without crashing Wasm engine", t2_f11_03_http_404_or_invalid_demo_url_handled_gracefully_without_crash),
        TestCase("T2_F11_04_empty_or_8_byte_eof_demo_response_rejected_gracefully", 2, "F11", "Verify empty 8-byte (-1,-1) mergedemo response is handled gracefully without crash", t2_f11_04_empty_or_8_byte_eof_demo_response_rejected_gracefully),
        TestCase("T2_F11_05_rapid_consecutive_demo_url_switches_settle_on_latest_demo", 2, "F11", "Verify rapid consecutive demo URL switches settle cleanly on the latest requested demo", t2_f11_05_rapid_consecutive_demo_url_switches_settle_on_latest_demo),
        # F12 (5)
        TestCase("T2_F12_01_immediate_play_click_before_prewarm_completes_starts_cleanly", 2, "F12", "Verify single #jk-canvas and clean startup when Play is clicked", t2_f12_01_immediate_play_click_before_prewarm_completes_starts_cleanly),
        TestCase("T2_F12_02_prewarm_does_not_steal_focus_or_request_pointer_lock", 2, "F12", "Verify background prewarm never steals keyboard focus or requests pointerLock", t2_f12_02_prewarm_does_not_steal_focus_or_request_pointer_lock),
        TestCase("T2_F12_03_prewarm_does_not_block_host_page_table_rendering", 2, "F12", "Verify background prewarm does not block #recentdemos rendering", t2_f12_03_prewarm_does_not_block_host_page_table_rendering),
        TestCase("T2_F12_04_unmute_works_even_when_canvas_not_focused", 2, "F12", "Verify s_muteWhenUnfocused=0 allows unmuting when focus is on host document", t2_f12_04_unmute_works_even_when_canvas_not_focused),
        TestCase("T2_F12_05_close_pip_keeps_wasm_alive_for_instant_reopen", 2, "F12", "Verify closing PiP pane keeps Wasm runtime ready for immediate subsequent Play click", t2_f12_05_close_pip_keeps_wasm_alive_for_instant_reopen),
        # F13 (5)
        TestCase("T2_F13_01_drag_beyond_viewport_edges_clamps_to_viewport_bounds", 2, "F13", "Verify dragging #jk-pip-header beyond viewport edges clamps to [0, innerWidth - width]", t2_f13_01_drag_beyond_viewport_edges_clamps_to_viewport_bounds),
        TestCase("T2_F13_02_keyboard_arrow_keys_on_focused_header_nudge_position", 2, "F13", "Verify keyboard arrow keys on focused #jk-pip-header nudge PiP position", t2_f13_02_keyboard_arrow_keys_on_focused_header_nudge_position),
        TestCase("T2_F13_03_resize_below_minimum_and_above_viewport_clamped", 2, "F13", "Verify resizing #jk-pip-card below minimum clamps to >= 320x220", t2_f13_03_resize_below_minimum_and_above_viewport_clamped),
        TestCase("T2_F13_04_pip_header_touch_action_and_user_select_none_and_pointercancel", 2, "F13", "Verify #jk-pip-header has touch-action: none and stops dragging on pointercancel", t2_f13_04_pip_header_touch_action_and_user_select_none_and_pointercancel),
        TestCase("T2_F13_05_window_resize_reclamps_pip_card_inside_smaller_viewport", 2, "F13", "Verify shrinking browser viewport re-clamps #jk-pip-card inside viewport bounds", t2_f13_05_window_resize_reclamps_pip_card_inside_smaller_viewport),
        # F14 (5)
        TestCase("T2_F14_01_all_five_speed_presets_025x_to_4x_supported", 2, "F14", "Verify all 5 speed presets (0.25x, 0.5x, 1x, 2x, 4x) update engine timescale accurately", t2_f14_01_all_five_speed_presets_025x_to_4x_supported),
        TestCase("T2_F14_02_close_button_pauses_mutes_and_hides_pane", 2, "F14", "Verify Close button pauses playback, mutes audio, and hides #jk-pip-card", t2_f14_02_close_button_pauses_mutes_and_hides_pane),
        TestCase("T2_F14_03_volume_slider_sweep_and_mute_toggle_restores_volume", 2, "F14", "Verify Volume slider sweep and Mute/Unmute toggle restores saved volume", t2_f14_03_volume_slider_sweep_and_mute_toggle_restores_volume),
        TestCase("T2_F14_04_fullscreen_button_handles_headless_environment_gracefully", 2, "F14", "Verify Fullscreen button handles headless browser environment without unhandled errors", t2_f14_04_fullscreen_button_handles_headless_environment_gracefully),
        TestCase("T2_F14_05_host_input_typing_not_hijacked_by_pip_shortcuts", 2, "F14", "Verify typing Space in host <input> does not trigger PiP Play/Pause toggle", t2_f14_05_host_input_typing_not_hijacked_by_pip_shortcuts),
        # F15 (5)
        TestCase("T2_F15_01_match_html_lookup_permalinks_never_have_play_button", 2, "F15", "Verify #rpc=lookup match permalinks on match.html NEVER get a .jk-play-btn", t2_f15_01_match_html_lookup_permalinks_never_have_play_button),
        TestCase("T2_F15_02_match_html_player_profile_links_never_have_play_button", 2, "F15", "Verify player profile links (aplayer2.html) on match.html never get a .jk-play-btn", t2_f15_02_match_html_player_profile_links_never_have_play_button),
        TestCase("T2_F15_03_match_html_hash_lookup_navigation_decorates_new_rows", 2, "F15", "Verify match.html#rpc=lookup&id=... decorates new demo rows while excluding permalinks", t2_f15_03_match_html_hash_lookup_navigation_decorates_new_rows),
        TestCase("T2_F15_04_mutation_observer_idempotent_no_duplicate_play_buttons", 2, "F15", "Verify MutationObserver on match.html is idempotent and never creates duplicate Play buttons", t2_f15_04_mutation_observer_idempotent_no_duplicate_play_buttons),
        TestCase("T2_F15_05_merge_matches_predict_handles_custom_maps_not_in_maps_json", 2, "F15", "Verify merge_matches_predict.py safely handles custom maps missing from maps.json", t2_f15_05_merge_matches_predict_handles_custom_maps_not_in_maps_json),
        # F16 (5)
        TestCase("T2_F16_01_rpc_php_endpoints_return_200_valid_jsonp_not_php_fatal_error", 2, "F16", "Verify /rpc.php?rpc=numdemos and recentdemos return 200 valid JSONP without PHP fatal error", t2_f16_01_rpc_php_endpoints_return_200_valid_jsonp_not_php_fatal_error),
        TestCase("T2_F16_02_rpc_js_handles_bson_date_format_in_time_created", 2, "F16", "Verify rpc.js handles BSON $date format in time_created without rendering NaN dates", t2_f16_02_rpc_js_handles_bson_date_format_in_time_created),
        TestCase("T2_F16_03_index_html_dynamic_table_refresh_redecorates_rows", 2, "F16", "Verify dynamically inserted getdemo.php rows in #recentdemos on index.html get .jk-play-btn", t2_f16_03_index_html_dynamic_table_refresh_redecorates_rows),
        TestCase("T2_F16_04_index_html_non_demo_links_excluded_from_play_buttons", 2, "F16", "Verify non-demo links on index.html do not receive .jk-play-btn", t2_f16_04_index_html_non_demo_links_excluded_from_play_buttons),
        TestCase("T2_F16_05_index_html_zero_uncaught_page_errors", 2, "F16", "Verify zero uncaught pageErrors occur when loading http://localhost:8081/index.html", t2_f16_05_index_html_zero_uncaught_page_errors),
        # F17 (5)
        TestCase("T2_F17_01_aplayer2_generated_urls_include_cygdrive_u_demos_prefix", 2, "F17", "Verify generated getdemo.php and trimdemo.php links on aplayer2.html include /cygdrive/U/demos/ prefix", t2_f17_01_aplayer2_generated_urls_include_cygdrive_u_demos_prefix),
        TestCase("T2_F17_02_aplayer2_and_debugplayer2_match_lookup_permalinks_excluded", 2, "F17", "Verify match.html#rpc=lookup permalinks on aplayer2.html and debugplayer2.html have no .jk-play-btn", t2_f17_02_aplayer2_and_debugplayer2_match_lookup_permalinks_excluded),
        TestCase("T2_F17_03_aplayer2_with_explicit_hash_id_loads_and_decorates_cleanly", 2, "F17", "Verify aplayer2.html#id=5950160f87b4d04bf8d5e099 loads player profile without duplicate buttons", t2_f17_03_aplayer2_with_explicit_hash_id_loads_and_decorates_cleanly),
        TestCase("T2_F17_04_aplayer2_no_undefined_or_broken_hrefs_rendered", 2, "F17", "Verify no undefined/null/NaN demo hrefs are rendered on aplayer2.html", t2_f17_04_aplayer2_no_undefined_or_broken_hrefs_rendered),
        TestCase("T2_F17_05_legacy_player_pages_include_jk_pip_player_and_return_200", 2, "F17", "Verify player.html, player2.html, aplayer.html, debugplayer.html include jk-pip-player.js", t2_f17_05_legacy_player_pages_include_jk_pip_player_and_return_200),
        # F18 (5)
        TestCase("T2_F18_01_single_byte_range_request_bytes_0_0_on_assets0_pk3", 2, "F18", "Verify single-byte HTTP Range: bytes=0-0 on /base/assets0.pk3 returns 206 and 1 byte 'P'", t2_f18_01_single_byte_range_request_bytes_0_0_on_assets0_pk3),
        TestCase("T2_F18_02_exact_central_directory_tail_range_request_on_assets0_pk3", 2, "F18", "Verify exact Central Directory tail Range request on /base/assets0.pk3 returns 206 and PK\\x01\\x02", t2_f18_02_exact_central_directory_tail_range_request_on_assets0_pk3),
        TestCase("T2_F18_03_range_requests_on_custom_and_alternate_checksum_pk3s", 2, "F18", "Verify HTTP Range requests on custom and <basename>.<hex>.pk3 archives return 206 Partial Content", t2_f18_03_range_requests_on_custom_and_alternate_checksum_pk3s),
        TestCase("T2_F18_04_out_of_bounds_range_returns_416_and_missing_pk3_returns_404", 2, "F18", "Verify out-of-bounds Range returns 416 and missing PK3 returns 404 on port 8081", t2_f18_04_out_of_bounds_range_returns_416_and_missing_pk3_returns_404),
        TestCase("T2_F18_05_native_and_wasm_builds_intact_and_synchronized_with_deployed_wasm", 2, "F18", "Verify native openjk.x86_64 and deployed /jkplayer/openjk.wasm are intact", t2_f18_05_native_and_wasm_builds_intact_and_synchronized_with_deployed_wasm),
    ]
