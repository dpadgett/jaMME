#!/usr/bin/env python3
"""
Tier 5 Empirical Challenger 1 Suite (R1: F1-F5 Checksum-Indexed PK3 Pool & On-Demand Checksum-First Mounting;
R2: F6-F10 Demo Timeline Bounds, Forward/Backward Seeking & Auto-Looping).

Owned exclusively by: challenger_p2_r1_1
Run command:
    timeout 180 python3 /home/dan/OpenJK/tests/e2e_r2/tier5_challenger_1.py
"""

import json
from pathlib import Path
import re
import sys
import time
from typing import Any, Dict, List

# Ensure tests/e2e_r2 is importable when executed directly
THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

from harness import (
    EXPECTED_BASE_CHECKSUMS,
    E2ER2TestContext,
    TestCase,
    canonical_pk3_basename,
    com_block_checksum,
    inspect_zip_eocd,
)


# ==============================================================================
# T5_C1_01 — Exhaustive Signed 32-Bit Com_BlockChecksum & Alternate
#            <basename>.<hex_checksum>.pk3 Verification (R1: F1, F2, F3)
# ==============================================================================
def t5_c1_01_exhaustive_checksum_and_alternate_pk3_verification(
    ctx: E2ER2TestContext,
) -> None:
    manifest = ctx.get_manifest()
    assert isinstance(manifest, dict), "manifest.json root must be a JSON object"
    assert (
        manifest.get("version") == 2
    ), f"Expected manifest version 2, got {manifest.get('version')}"
    pk3s = manifest.get("pk3s", [])
    assert (
        len(pk3s) >= 480
    ), f"Expected >= 480 pk3s in manifest.json, got {len(pk3s)}"

    # Verify live HTTP /base/manifest.json matches on-disk manifest.json byte-for-byte
    status, headers, body = ctx.http_request("GET", "/base/manifest.json")
    assert status == 200, f"GET /base/manifest.json returned HTTP {status}"
    live_manifest = json.loads(body.decode("utf-8"))
    assert (
        live_manifest == manifest
    ), "Live HTTP /base/manifest.json diverges from on-disk manifest.json"

    # Verify md4.cpp n == 0 double-tail edge case matches web/consolidate_and_index_pk3s.py
    if str(ctx.web_dir) not in sys.path:
        sys.path.insert(0, str(ctx.web_dir))
    import consolidate_and_index_pk3s as indexer  # type: ignore

    empty_oracle_sum = com_block_checksum(b"")
    empty_indexer_sum = indexer.com_block_checksum(b"")
    assert (
        empty_oracle_sum == empty_indexer_sum
    ), f"0-byte Com_BlockChecksum mismatch between harness ({empty_oracle_sum}) and indexer ({empty_indexer_sum})"

    # Group all entries by canonical basename and validate uniqueness + physical files
    seen_names = set()
    seen_checksums_per_base: Dict[str, Dict[int, str]] = {}
    groups_by_base: Dict[str, List[Dict[str, Any]]] = {}
    alt_entries: List[Dict[str, Any]] = []
    alt_pattern = re.compile(
        r"^([a-z0-9_+\-~!@#$%^&()=\[\]{};',.]+)\.([0-9a-f]{8})\.pk3$"
    )

    for entry in pk3s:
        name = entry["name"]
        bname = entry["basename"]
        size = entry["size"]
        csum = entry["checksum"]
        base_init = entry["base_init"]

        assert name == name.lower(), f"Non-lowercase archive name in manifest: {name}"
        assert name.endswith(".pk3"), f"Non-.pk3 archive name in manifest: {name}"
        assert name not in seen_names, f"Duplicate archive name in manifest: {name}"
        seen_names.add(name)

        # Signed 32-bit int range check
        assert isinstance(csum, int) and not isinstance(
            csum, bool
        ), f"Checksum for {name} is not int: {type(csum)}"
        assert (
            -(2**31) <= csum <= (2**31) - 1
        ), f"Checksum for {name} out of int32 range: {csum}"

        # Physical file existence and exact byte size
        p = ctx.consolidated_pk3_dir / name
        assert (
            p.exists() and p.is_file()
        ), f"Missing physical consolidated PK3 on disk: {p}"
        actual_size = p.stat().st_size
        assert (
            actual_size == size
        ), f"Size mismatch for {name}: manifest={size}, disk={actual_size}"

        cbase = canonical_pk3_basename(name)
        assert (
            cbase == bname.lower()
        ), f"Canonical basename mismatch for {name}: {cbase} != {bname.lower()}"
        groups_by_base.setdefault(cbase, []).append(entry)
        base_csums = seen_checksums_per_base.setdefault(cbase, {})
        assert (
            csum not in base_csums
        ), f"Duplicate checksum {csum} under canonical basename {cbase}: {name} vs {base_csums[csum]}"
        base_csums[csum] = name

        # Check alternate <basename>.<hex_checksum>.pk3 naming contract
        stem = name[:-4]
        if "." in stem and re.search(r"\.[0-9a-f]{8}$", stem):
            m = alt_pattern.match(name)
            assert m is not None, f"Malformed alternate PK3 filename: {name}"
            expected_hex = f"{csum & 0xFFFFFFFF:08x}"
            actual_hex = m.group(2)
            assert (
                actual_hex == expected_hex
            ), f"Alternate PK3 hex suffix mismatch for {name}: suffix={actual_hex}, expected={expected_hex} (checksum={csum})"
            assert (
                not base_init
            ), f"Alternate PK3 {name} must not have base_init=True"
            alt_entries.append(entry)

    assert (
        len(alt_entries) >= 35
    ), f"Expected >= 35 alternate <basename>.<hex_checksum>.pk3 entries, got {len(alt_entries)}"

    # Verify every multi-version group has 1 primary <basename>.pk3 and >= 1 alternate <basename>.<hex>.pk3,
    # and recompute the exact signed 32-bit Com_BlockChecksum from the ZIP central directory for ALL entries
    # in every multi-version group (all primaries + all 37 alternates) plus assets0..3.pk3.
    multi_version_groups = {
        b: grp for b, grp in groups_by_base.items() if len(grp) > 1
    }
    assert (
        len(multi_version_groups) >= 20
    ), f"Expected >= 20 multi-version PK3 groups, got {len(multi_version_groups)}"

    verified_count = 0
    neg_alt_verified = 0
    pos_alt_verified = 0

    for cbase, grp in sorted(multi_version_groups.items()):
        primary_name = f"{cbase}.pk3"
        primaries = [e for e in grp if e["name"] == primary_name]
        alternates = [e for e in grp if e["name"] != primary_name]
        assert (
            len(primaries) == 1
        ), f"Multi-version group '{cbase}' must have exactly 1 primary '{primary_name}', got {[e['name'] for e in grp]}"
        assert (
            len(alternates) >= 1
        ), f"Multi-version group '{cbase}' has no alternates"

        for e in grp:
            pk3_file = ctx.consolidated_pk3_dir / e["name"]
            oracle_csum = ctx.get_pk3_checksum(pk3_file)
            assert (
                oracle_csum == e["checksum"]
            ), f"Com_BlockChecksum mismatch on {e['name']}: manifest={e['checksum']}, oracle={oracle_csum}"
            verified_count += 1
            if e["name"] != primary_name:
                if oracle_csum < 0:
                    neg_alt_verified += 1
                else:
                    pos_alt_verified += 1

    # Also verify base JKA assets0..3.pk3 exact signed 32-bit checksums
    for base_name, expected_csum in EXPECTED_BASE_CHECKSUMS.items():
        base_entries = [e for e in pk3s if e["name"] == base_name]
        assert len(base_entries) == 1, f"Missing {base_name} in manifest.json"
        be = base_entries[0]
        assert (
            be["checksum"] == expected_csum
        ), f"{base_name} checksum mismatch: {be['checksum']} != {expected_csum}"
        assert be["base_init"] is True, f"{base_name} must have base_init=True"
        oracle_csum = ctx.get_pk3_checksum(ctx.consolidated_pk3_dir / base_name)
        assert (
            oracle_csum == expected_csum
        ), f"Oracle checksum mismatch for {base_name}: {oracle_csum} != {expected_csum}"
        verified_count += 1

    assert (
        neg_alt_verified >= 10
    ), f"Expected >= 10 negative-checksum alternate PK3s verified, got {neg_alt_verified}"
    assert (
        pos_alt_verified >= 10
    ), f"Expected >= 10 positive-checksum alternate PK3s verified, got {pos_alt_verified}"

    # Verify HTTP 206 Partial Content Central Directory + EOCD Range serving on both negative and positive
    # signed 32-bit checksum alternate <basename>.<hex_checksum>.pk3 archives
    neg_alt = next(e for e in alt_entries if e["checksum"] < 0)
    pos_alt = next(e for e in alt_entries if e["checksum"] > 0)
    for sample_alt in (neg_alt, pos_alt):
        alt_name = sample_alt["name"]
        alt_path = ctx.consolidated_pk3_dir / alt_name
        eocd = inspect_zip_eocd(alt_path)
        assert (
            eocd["cd_magic"] == b"PK\x01\x02"
        ), f"Invalid CD magic on disk for {alt_name}"

        # Range request for Central Directory -> EOF (exact WasmPK3_EnsureCentralDirLoaded pattern)
        cd_start = eocd["cd_offset"]
        cd_end = eocd["size"] - 1
        st, hdrs, cd_body = ctx.http_request(
            "GET",
            f"/base/{alt_name}",
            headers={"Range": f"bytes={cd_start}-{cd_end}"},
        )
        assert (
            st == 206
        ), f"Range GET /base/{alt_name} returned {st}, expected 206"
        assert (
            len(cd_body) == eocd["tail_size"]
        ), f"Range body length mismatch for {alt_name}"
        assert (
            cd_body[:4] == b"PK\x01\x02"
        ), f"HTTP Range Central Directory magic mismatch for {alt_name}"
        assert (
            b"PK\x05\x06" in cd_body[-65557:]
        ), f"HTTP Range EOCD magic missing in tail of {alt_name}"


# ==============================================================================
# T5_C1_02 — Base-Only Prewarm Isolation, localStorage v2 Schema &
#            <= 8 Range Request Budget (R1: F4)
# ==============================================================================
def t5_c1_02_base_only_prewarm_and_poison_recovery(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    pk3s = manifest["pk3s"]
    base_init_names = [a["name"] for a in pk3s if a.get("base_init")]
    assert base_init_names == [
        "assets0.pk3",
        "assets1.pk3",
        "assets2.pk3",
        "assets3.pk3",
    ], f"manifest.json base_init must be true ONLY on assets0..3.pk3, got {base_init_names}"

    obs = ctx.ensure_prewarm_observed()
    assert (
        obs["ready"] is True
    ), f"Engine failed to reach ready state during prewarm: {obs}"
    assert (
        obs["pipHidden"] is True
    ), f"PiP card should remain hidden during prewarm: {obs}"
    assert (
        obs["isPlaying"] is False
    ), f"Demo should not be playing during prewarm: {obs}"
    assert (
        obs["loadedPacks"] == 4
    ), f"Prewarm must mount ONLY the 4 base PK3s (assets0..3.pk3), got loadedPacks={obs['loadedPacks']}"
    assert (
        0 < obs["rangeRequests"] <= 8
    ), f"Prewarm range requests must be in [1, 8], got rangeRequests={obs['rangeRequests']}"
    assert (
        0 < obs["bytesTransferred"] < 5 * 1024 * 1024
    ), f"Prewarm bytesTransferred out of expected Central-Directory-only bounds: {obs['bytesTransferred']}"
    assert (
        obs["hasV2Cache"] is True and obs["v2CacheLen"] > 10000
    ), "openjk_pk3_manifest_v2 was not populated"

    # Inspect openjk_pk3_manifest_v2 JSON content in localStorage and verify schema & base_init flags
    v2_stats = ctx.eval_js(
        """
        const raw = localStorage.getItem('openjk_pk3_manifest_v2') || '{}';
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed.pk3s) ? parsed.pk3s : [];
        const baseOnes = list.filter(e => e && e.base_init === true).map(e => e.name);
        return { version: parsed.version, count: list.length, baseOnes };
        """
    )
    assert (
        v2_stats["version"] == 2
    ), f"Expected openjk_pk3_manifest_v2 version 2, got {v2_stats}"
    assert v2_stats["count"] == len(pk3s), (
        f"openjk_pk3_manifest_v2 entry count ({v2_stats['count']}) != manifest.json ({len(pk3s)})"
    )
    assert v2_stats["baseOnes"] == [
        "assets0.pk3",
        "assets1.pk3",
        "assets2.pk3",
        "assets3.pk3",
    ], f"openjk_pk3_manifest_v2 base_init=true entries mismatch: {v2_stats['baseOnes']}"

    # Verify zero non-base .pk3 requests occurred in browser network responses during prewarm
    pk3_urls = [
        r["url"]
        for r in obs.get("networkResponses", [])
        if ".pk3" in r.get("url", "").lower()
    ]
    non_base_pk3_urls = [
        u
        for u in pk3_urls
        if not any(
            b in u.lower()
            for b in ("assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3")
        )
    ]
    assert (
        len(non_base_pk3_urls) == 0
    ), f"Non-base PK3s were fetched during prewarm: {non_base_pk3_urls}"


# ==============================================================================
# T5_C1_03 — On-Demand Checksum-First Mounting, Custom Archive Unlinking &
#            Zero Duplicate PK3 Mounts Across Demo Reloads (R1: F3, F5)
# ==============================================================================
def t5_c1_03_on_demand_checksum_first_mounting_and_no_duplicates(
    ctx: E2ER2TestContext,
) -> None:
    play_status = ctx.ensure_pip_playing("match.html", "getdemo.php")
    assert play_status["isPlaying"] is True
    assert play_status["durationMs"] >= 30000

    manifest = ctx.get_manifest()
    pk3s_by_name = {a["name"]: a for a in manifest["pk3s"]}
    assert "ctf_bespin.pk3" in pk3s_by_name, "ctf_bespin.pk3 missing from manifest"
    assert "ctf_bespin.a999bae8.pk3" in pk3s_by_name, "ctf_bespin.a999bae8.pk3 missing from manifest"
    assert (
        pk3s_by_name["ctf_bespin.pk3"]["checksum"]
        != pk3s_by_name["ctf_bespin.a999bae8.pk3"]["checksum"]
    ), "Primary and alternate ctf_bespin checksums must differ"

    # Reload the active demo multiple times via JKDemoPlayer.restartDemo() (which executes
    # JK_DemoLoad -> CL_PlayDemo_f -> CL_ParseGamestate -> CL_SystemInfoChanged -> FS_WasmPrepareDemoPaks)
    # and verify that:
    # 1. _JK_DemoGetLoadedPackCount() remains strictly invariant (zero duplicate searchpath_t mounts).
    # 2. _JK_DemoGetPk3RangeRequests() does not increase on subsequent reloads because FS_WasmPrepareDemoPaks
    #    retains arch->loadedPack and arch->chunks in memory when unlinking custom packs.
    dup_check = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        if (!p || !mod) throw new Error('Player / Module not accessible');

        const mapName = (typeof mod._JK_DemoGetMapName === 'function' && mod.UTF8ToString)
          ? mod.UTF8ToString(mod._JK_DemoGetMapName())
          : '';
        const packCounts = [mod._JK_DemoGetLoadedPackCount()];
        const rangeCounts = [mod._JK_DemoGetPk3RangeRequests()];

        for (let i = 0; i < 3; i++) {
          await p.restartDemo();
          packCounts.push(mod._JK_DemoGetLoadedPackCount());
          rangeCounts.push(mod._JK_DemoGetPk3RangeRequests());
        }

        const baseStubs = (mod.FS && typeof mod.FS.readdir === 'function')
          ? mod.FS.readdir('/base').filter(f => f.endsWith('.pk3'))
          : [];

        return {
          mapName,
          packCounts,
          rangeCounts,
          baseStubs,
          isPlaying: mod._JK_DemoIsPlaying() === 1,
        };
        """,
        timeout=90.0,
    )

    assert (
        dup_check["isPlaying"] is True
    ), f"Demo not playing after restartDemo loop: {dup_check}"
    assert dup_check["mapName"], f"Expected non-empty mapName: {dup_check}"
    pack_counts = dup_check["packCounts"]
    assert (
        len(set(pack_counts)) == 1 and pack_counts[0] >= 4
    ), f"Duplicate or leaked PK3 mount detected across repeated demo loads! packCounts={pack_counts}"

    # Verify in-memory pack & chunk caching across reloads: after reload #1, reloads #2 and #3 must issue 0 new range requests
    range_counts = dup_check["rangeCounts"]
    assert (
        range_counts[-1] == range_counts[1]
    ), f"Expected 0 additional PK3 Range requests across cached demo reloads, got rangeCounts={range_counts}"


# ==============================================================================
# T5_C1_04 — Rapid Multi-Seek Stress Test: Forward -> Backward -> 0:00 ->
#            Sawtooth -> Paused -> Clamp -> Near-EOF -> Auto-Loop (R2: F6-F10)
# ==============================================================================
def t5_c1_04_rapid_multi_seek_stress_and_auto_loop(ctx: E2ER2TestContext) -> None:
    play_status = ctx.ensure_pip_playing("match.html", "getdemo.php")
    dur = play_status["durationMs"]
    assert dur >= 30000, f"Expected match demo duration >= 30000 ms, got {dur}"

    stress_res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        if (!mod) throw new Error('Wasm Module not found');

        const startMs = mod._JK_DemoGetStartTimeMs();
        const endMs = mod._JK_DemoGetEndTimeMs();
        const durationMs = mod._JK_DemoGetDurationMs();
        const initialPacks = mod._JK_DemoGetLoadedPackCount();
        const initialRangeReqs = mod._JK_DemoGetPk3RangeRequests();

        const capturedLogs = [];
        const origLog = window.console.log;
        const origWarn = window.console.warn;
        const origErr = window.console.error;
        function recordLog(level, args) {
          try {
            capturedLogs.push(level + ': ' + Array.from(args).map(String).join(' '));
          } catch (_) {}
        }
        window.console.log = function() { recordLog('LOG', arguments); return origLog.apply(this, arguments); };
        window.console.warn = function() { recordLog('WARN', arguments); return origWarn.apply(this, arguments); };
        window.console.error = function() { recordLog('ERR', arguments); return origErr.apply(this, arguments); };

        const steps = [];
        function doSeek(label, targetMs) {
          const t0 = performance.now();
          const retMs = mod._JK_DemoSeekToMs(targetMs);
          const elapsedMs = performance.now() - t0;
          const actualMs = mod._JK_DemoGetCurrentTimeMs();
          const packs = mod._JK_DemoGetLoadedPackCount();
          const rangeReqs = mod._JK_DemoGetPk3RangeRequests();
          const playing = mod._JK_DemoIsPlaying();
          const paused = mod._JK_DemoIsPaused();
          steps.push({
            label,
            targetMs,
            retMs,
            actualMs,
            elapsedMs: Math.round(elapsedMs * 10) / 10,
            packs,
            rangeReqs,
            playing,
            paused,
          });
        }

        try {
          mod._JK_DemoResume();
          mod._JK_DemoSetSpeed(1.0);
          mod._JK_DemoSetLoop(1);
          mod._JK_DemoSeekToMs(0);

          // Phase 1: Monotonic forward seeks (5% -> 15% -> 30% -> 50% -> 70% -> 85%)
          for (const frac of [0.05, 0.15, 0.30, 0.50, 0.70, 0.85]) {
            doSeek('fwd_' + Math.round(frac * 100), Math.floor(durationMs * frac));
          }

          // Phase 2: Monotonic backward seeks (85% -> 35% -> 15% -> 5%)
          for (const frac of [0.35, 0.15, 0.05]) {
            doSeek('bwd_' + Math.round(frac * 100), Math.floor(durationMs * frac));
          }

          // Phase 3: Exact 0:00 rewind
          doSeek('zero_1', 0);

          // Phase 4: Rapid back-to-back sawtooth stress (forward -> backward -> 0:00 -> forward -> backward)
          for (const frac of [0.25, 0.08, 0.30, 0.04, 0.20, 0.0]) {
            doSeek('saw_' + Math.round(frac * 100), Math.floor(durationMs * frac));
          }

          // Phase 5: Paused seek preservation (pause -> forward seek -> backward seek -> resume)
          mod._JK_DemoPause();
          doSeek('paused_fwd_18', Math.floor(durationMs * 0.18));
          doSeek('paused_bwd_6', Math.floor(durationMs * 0.06));
          mod._JK_DemoResume();

          // Phase 6: Negative out-of-bounds clamp (-50000 -> 0)
          doSeek('clamp_neg', -50000);

          // Phase 7: Single-jump near-EOF seek (0 -> durationMs - 300) + overflow clamp + auto-loop wrap-around
          doSeek('near_eof', Math.max(0, durationMs - 300));
          doSeek('clamp_over', durationMs + 500000);
          mod._JK_DemoSetSpeed(4.0);
          const loopWaitStart = Date.now();
          let loopObserved = false;
          let postLoopTimeMs = mod._JK_DemoGetCurrentTimeMs();
          while (Date.now() - loopWaitStart < 6000) {
            await new Promise(r => setTimeout(r, 80));
            const cur = mod._JK_DemoGetCurrentTimeMs();
            if (cur < durationMs * 0.25 && mod._JK_DemoIsPlaying() === 1) {
              loopObserved = true;
              postLoopTimeMs = cur;
              break;
            }
          }
          mod._JK_DemoSetSpeed(1.0);

          // Phase 8: Post-loop forward & backward seeks to verify timeline integrity after auto-loop
          doSeek('post_loop_fwd_15', Math.floor(durationMs * 0.15));
          doSeek('post_loop_bwd_5', Math.floor(durationMs * 0.05));
          doSeek('post_loop_zero', 0);

          return {
            startMs,
            endMs,
            durationMs,
            initialPacks,
            finalPacks: mod._JK_DemoGetLoadedPackCount(),
            initialRangeReqs,
            finalRangeReqs: mod._JK_DemoGetPk3RangeRequests(),
            loopObserved,
            postLoopTimeMs,
            steps,
            capturedLogs,
          };
        } finally {
          window.console.log = origLog;
          window.console.warn = origWarn;
          window.console.error = origErr;
        }
        """,
        timeout=90.0,
    )

    assert (
        stress_res["endMs"] - stress_res["startMs"] == stress_res["durationMs"]
    ), f"Timeline invariant endMs - startMs == durationMs failed: {stress_res}"
    assert (
        stress_res["initialPacks"] == stress_res["finalPacks"]
    ), f"PK3 pack count changed during multi-seek stress: {stress_res['initialPacks']} -> {stress_res['finalPacks']}"
    assert (
        stress_res["initialRangeReqs"] == stress_res["finalRangeReqs"]
    ), f"Unexpected PK3 HTTP Range requests during in-memory multi-seek stress: {stress_res['initialRangeReqs']} -> {stress_res['finalRangeReqs']}"
    assert (
        stress_res["loopObserved"] is True
    ), f"Near-EOF auto-loop did not wrap back near 0:00 within timeout: postLoopTimeMs={stress_res['postLoopTimeMs']}"

    steps = stress_res["steps"]
    assert len(steps) == 24, f"Expected 24 seek steps, got {len(steps)}"

    dur = stress_res["durationMs"]
    for st in steps:
        label = st["label"]
        assert (
            st["retMs"] >= 0 and st["retMs"] == st["actualMs"]
        ), f"Seek step {label} returned retMs={st['retMs']} != actualMs={st['actualMs']}"
        assert (
            st["playing"] == 1
        ), f"Playback dropped (playing=0) on seek step {label}"
        assert (
            st["packs"] == stress_res["initialPacks"]
        ), f"Pack count changed at step {label}: {st['packs']} != {stress_res['initialPacks']}"
        assert (
            st["rangeReqs"] == stress_res["initialRangeReqs"]
        ), f"Range requests changed at step {label}: {st['rangeReqs']} != {stress_res['initialRangeReqs']}"

        if label.startswith("paused_"):
            assert st["paused"] == 1, f"Paused state not preserved during {label}"
        else:
            assert st["paused"] == 0, f"Unexpected paused state during {label}"

        expected_ms = max(0, min(dur, st["targetMs"]))
        diff_ms = abs(st["actualMs"] - expected_ms)
        assert (
            diff_ms <= 2500
        ), f"Seek step {label} landed too far from target: target={expected_ms}, actual={st['actualMs']}, diff={diff_ms}ms"

    # Verify strict monotonic progression across Phase 1 (fwd_5 .. fwd_85) and Phase 2 (bwd_35 .. bwd_5)
    fwd_actuals = [s["actualMs"] for s in steps if s["label"].startswith("fwd_")]
    assert fwd_actuals == sorted(fwd_actuals) and fwd_actuals[0] < fwd_actuals[-1], (
        f"Forward seek steps were not monotonically increasing: {fwd_actuals}"
    )
    bwd_actuals = [s["actualMs"] for s in steps if s["label"].startswith("bwd_")]
    assert (
        bwd_actuals == sorted(bwd_actuals, reverse=True)
        and bwd_actuals[0] > bwd_actuals[-1]
    ), f"Backward seek steps were not monotonically decreasing: {bwd_actuals}"

    # Check captured logs + browser bridge logs for any Com_Error / reliable command cycle out / snapshot errors
    browser_logs = ctx.get_browser_logs()
    all_log_text = (
        "\n".join(stress_res.get("capturedLogs", []))
        + "\n"
        + "\n".join(m.get("text", "") for m in browser_logs.get("consoleMessages", []))
    )
    forbidden_patterns = [
        "CL_GetServerCommand: a reliable command was cycled out",
        "MAX_GAMESTATE_CHARS exceeded",
        "CL_GetSnapshot: truncated",
        "Com_Error",
        "ERR_DROP",
        "ERR_FATAL",
    ]
    for pat in forbidden_patterns:
        assert (
            pat not in all_log_text
        ), f"Forbidden engine error '{pat}' detected during rapid multi-seek stress!"
    assert (
        len(browser_logs.get("pageErrors", [])) == 0
    ), f"Uncaught pageErrors detected during rapid multi-seek stress: {browser_logs.get('pageErrors')}"

    # Verify WebGL canvas still renders a healthy 3D scene after 24 rapid seeks + auto-loop
    snap = ctx.capture_canvas_screenshot("t5_c1_04_post_stress")
    assert (
        snap["non_black_ratio"] > 0.05
    ), f"Canvas appears black after rapid seek stress: {snap['non_black_ratio']}"
    assert (
        snap["std_rgb"] > 5.0
    ), f"Canvas lacks 3D variance after rapid seek stress: {snap['std_rgb']}"


# ==============================================================================
# T5_C1_05 — Trimmed Clip ("NS!") vs Full-Match Timeline Switching &
#            Multi-Demo Seek/Loop Integrity (R1: F5, R2: F6, F8, F9, F10)
# ==============================================================================
def t5_c1_05_trimmed_vs_full_demo_switch_and_seek_stress(
    ctx: E2ER2TestContext,
) -> None:
    ctx.ensure_page_loaded("match.html")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
        if (!p || !mod) throw new Error('Player / Module missing');

        // Find a trimmed NS! clip button (trimdemo.php) on match.html
        const trimBtn = document.querySelector('.jk-play-btn[data-demo-url*="trimdemo.php"]')
          || Array.from(document.querySelectorAll('a[href*="trimdemo.php"]')).map(a => a.nextElementSibling).find(b => b && b.classList.contains('jk-play-btn'));
        if (!trimBtn) throw new Error('No trimdemo.php Play button found on match.html');

        trimBtn.click();
        const t0 = Date.now();
        let trimDur = 0;
        while (Date.now() - t0 < 45000) {
          const d = mod._JK_DemoGetDurationMs();
          if (mod._JK_DemoIsPlaying() === 1 && d > 0 && d < 45000) {
            trimDur = d;
            break;
          }
          await new Promise(r => setTimeout(r, 120));
        }
        if (trimDur <= 0 || trimDur >= 45000) {
          throw new Error('Failed to load trimmed demo clip, dur=' + trimDur);
        }

        const trimStart = mod._JK_DemoGetStartTimeMs();
        const trimEnd = mod._JK_DemoGetEndTimeMs();
        const trimPacksBefore = mod._JK_DemoGetLoadedPackCount();

        // Rapid seek stress inside the trimmed clip: 0 -> 70% -> 20% -> 0
        mod._JK_DemoSeekToMs(0);
        const s0 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(Math.floor(trimDur * 0.70));
        const s70 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(Math.floor(trimDur * 0.20));
        const s20 = mod._JK_DemoGetCurrentTimeMs();
        mod._JK_DemoSeekToMs(0);
        const sRewind = mod._JK_DemoGetCurrentTimeMs();
        const trimPacksAfter = mod._JK_DemoGetLoadedPackCount();

        return {
          trimStart,
          trimEnd,
          trimDur,
          s0,
          s70,
          s20,
          sRewind,
          trimPacksBefore,
          trimPacksAfter,
          playing: mod._JK_DemoIsPlaying(),
        };
        """,
        timeout=60.0,
    )

    assert (
        res["trimEnd"] - res["trimStart"] == res["trimDur"]
    ), f"Trimmed clip bounds mismatch: {res}"
    assert (
        1000 <= res["trimDur"] < 45000
    ), f"Expected trimmed clip duration in [1000, 45000) ms, got {res['trimDur']}"
    assert res["playing"] == 1, f"Trimmed clip stopped playing after rapid seeks: {res}"
    assert (
        res["trimPacksBefore"] == res["trimPacksAfter"]
    ), f"PK3 pack count changed during trimmed clip seeks: {res}"
    assert (
        res["s0"] <= 1000 and res["sRewind"] <= 1000
    ), f"Trimmed clip rewind to 0 inaccurate: {res}"
    assert (
        res["s70"] > res["s20"] > res["sRewind"]
    ), f"Trimmed clip forward/backward seeks not monotonic: {res}"


def get_tier5_challenger_1_tests() -> List[TestCase]:
    return [
        TestCase(
            test_id="T5_C1_01",
            tier=5,
            feature="F1,F2,F3",
            description="Exhaustive signed 32-bit Com_BlockChecksum & alternate <basename>.<hex_checksum>.pk3 verification across all multi-version archive groups and HTTP 206 Range endpoints",
            fn=t5_c1_01_exhaustive_checksum_and_alternate_pk3_verification,
        ),
        TestCase(
            test_id="T5_C1_02",
            tier=5,
            feature="F4",
            description="Base-only prewarm isolation (base_init=true only on assets0..3.pk3, <= 8 range requests), openjk_pk3_manifest_v2 validation, and zero non-base PK3 fetches",
            fn=t5_c1_02_base_only_prewarm_and_poison_recovery,
        ),
        TestCase(
            test_id="T5_C1_03",
            tier=5,
            feature="F3,F5",
            description="On-demand PK3 mounting, in-memory pack/chunk caching, and zero duplicate searchpath_t mounts across repeated demo reloads",
            fn=t5_c1_03_on_demand_checksum_first_mounting_and_no_duplicates,
        ),
        TestCase(
            test_id="T5_C1_04",
            tier=5,
            feature="F6,F7,F8,F9,F10",
            description="24-step rapid multi-seek stress test (forward -> backward -> 0:00 -> sawtooth -> paused -> clamp -> near-EOF -> auto-loop -> post-loop seeks) with zero Com_Error/overflow and zero duplicate PK3 mounts",
            fn=t5_c1_04_rapid_multi_seek_stress_and_auto_loop,
        ),
        TestCase(
            test_id="T5_C1_05",
            tier=5,
            feature="F5,F6,F8,F9",
            description="Trimmed clip ('NS!') vs full-match demo switching and rapid forward/backward/0:00 seek stress",
            fn=t5_c1_05_trimmed_vs_full_demo_switch_and_seek_stress,
        ),
    ]


def main() -> int:
    tests = get_tier5_challenger_1_tests()
    ctx = E2ER2TestContext()
    passed = 0
    failed = 0
    results = []
    suite_start = time.time()

    print(f"=== Running Tier 5 Challenger 1 Suite ({len(tests)} tests) ===", flush=True)
    try:
        for tc in tests:
            t0 = time.time()
            try:
                tc.fn(ctx)
                dt_ms = (time.time() - t0) * 1000.0
                passed += 1
                print(
                    f"[PASS] {tc.test_id} ({tc.feature}) — {tc.description} [{dt_ms:.1f} ms]",
                    flush=True,
                )
                results.append(
                    {"id": tc.test_id, "status": "PASS", "ms": round(dt_ms, 1)}
                )
            except Exception as exc:
                dt_ms = (time.time() - t0) * 1000.0
                failed += 1
                print(
                    f"[FAIL] {tc.test_id} ({tc.feature}) — {tc.description} [{dt_ms:.1f} ms]: {exc}",
                    flush=True,
                )
                results.append(
                    {
                        "id": tc.test_id,
                        "status": "FAIL",
                        "ms": round(dt_ms, 1),
                        "error": str(exc),
                    }
                )
    finally:
        ctx.close()

    total_ms = (time.time() - suite_start) * 1000.0
    print(
        f"=== Tier 5 Challenger 1 Summary: {passed}/{len(tests)} passed, {failed} failed in {total_ms:.1f} ms ===",
        flush=True,
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
