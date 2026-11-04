#!/usr/bin/env python3
"""
Tier 5 White-Box Adversarial Test Suite — Challenger 2 (challenger_p2_r1_2).
Targets R3 (F11–F14: Floating PiP Player & Playback Controls) and
R4 (F15–F18: Archive Website & Nginx/Docker Integration on http://localhost:8081).

Run with:
  timeout 180 python3 /home/dan/OpenJK/tests/e2e_r2/tier5_challenger_2.py
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import traceback
from typing import Any, Dict, List, Tuple

os.environ.setdefault("CHROME_PATH", "/opt/google/chrome/chrome")

ROOT_DIR = Path("/home/dan/OpenJK/jaMME")
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tests.e2e_r2.harness import E2ER2TestContext, TestCase


# ==============================================================================
# T5_C2_01: F18 — Nginx Wasm MIME, Caching, HEAD/Range & Deployment Sync Audit
# ==============================================================================
def t5_c2_01_nginx_wasm_mime_headers_and_deployment_sync(ctx: E2ER2TestContext) -> None:
    # 1. Verify both /jkplayer/openjk.wasm and /openjk.wasm serve application/wasm + valid Wasm magic
    for wasm_path in ("/jkplayer/openjk.wasm", "/openjk.wasm"):
        st, hdrs, body = ctx.http_request("GET", wasm_path)
        assert st == 200, f"GET {wasm_path} returned HTTP {st}"
        ctype = hdrs.get("content-type", "").lower()
        assert "application/wasm" in ctype, f"{wasm_path} wrong Content-Type: {ctype!r}"
        assert "max-age=3600" in hdrs.get("cache-control", "").lower(), (
            f"{wasm_path} missing Cache-Control max-age=3600: {hdrs.get('cache-control')!r}"
        )
        assert body[:8] == b"\x00asm\x01\x00\x00\x00", (
            f"{wasm_path} invalid Wasm binary header: {body[:8]!r}"
        )
        assert len(body) > 1_500_000, f"{wasm_path} unexpectedly small: {len(body)} bytes"

    # 2. Verify HEAD and byte-range requests on /jkplayer/openjk.wasm
    st_head, hdrs_head, body_head = ctx.http_request("HEAD", "/jkplayer/openjk.wasm")
    assert st_head == 200 and body_head == b"", f"HEAD /jkplayer/openjk.wasm failed: {st_head}"
    assert "application/wasm" in hdrs_head.get("content-type", "").lower()

    st_rng, hdrs_rng, body_rng = ctx.http_request(
        "GET", "/jkplayer/openjk.wasm", headers={"Range": "bytes=0-7"}
    )
    assert st_rng == 206 and body_rng == b"\x00asm\x01\x00\x00\x00", (
        f"Range bytes=0-7 on /jkplayer/openjk.wasm failed: status={st_rng}, body={body_rng!r}"
    )

    # 3. Verify byte-for-byte synchronization between staged /home/dan/OpenJK/web/ and deployed /jkplayer/
    pairs = [
        (ctx.web_dir / "jk-pip-player.js", ctx.archive_public_dir / "jkplayer" / "jk-pip-player.js"),
        (ctx.web_dir / "player.js", ctx.archive_public_dir / "jkplayer" / "player.js"),
        (ctx.web_dir / "openjk.js", ctx.archive_public_dir / "jkplayer" / "openjk.js"),
        (ctx.web_dir / "openjk.wasm", ctx.archive_public_dir / "jkplayer" / "openjk.wasm"),
    ]
    for src, dst in pairs:
        assert src.exists() and dst.exists(), f"Missing file in sync pair: {src} vs {dst}"
        h_src = hashlib.md5(src.read_bytes()).hexdigest()
        h_dst = hashlib.md5(dst.read_bytes()).hexdigest()
        assert h_src == h_dst, f"MD5 mismatch between {src} ({h_src}) and {dst} ({h_dst})"


# ==============================================================================
# T5_C2_02: F18 — Nginx /base/*.pk3 HTTP 206 Partial Content Boundary & Concurrent Stress
# ==============================================================================
def t5_c2_02_nginx_pk3_http_206_range_boundary_and_concurrent_stress(ctx: E2ER2TestContext) -> None:
    manifest = ctx.get_manifest()
    by_name = {e["name"]: e for e in manifest["pk3s"]}
    assets0 = by_name["assets0.pk3"]
    size0 = assets0["size"]

    # 1. First byte (0-0), last byte (size-1..size-1), suffix range (-22 = EOCD), and 256KB chunk boundaries
    st_first, hdr_first, b_first = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=0-0"}
    )
    assert st_first == 206 and b_first == b"P"
    assert hdr_first.get("content-range") == f"bytes 0-0/{size0}"

    st_last, hdr_last, b_last = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": f"bytes={size0 - 1}-{size0 - 1}"}
    )
    assert st_last == 206 and len(b_last) == 1
    assert hdr_last.get("content-range") == f"bytes {size0 - 1}-{size0 - 1}/{size0}"

    st_suf, hdr_suf, b_suf = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": "bytes=-22"}
    )
    assert st_suf == 206 and len(b_suf) == 22 and b_suf[:4] == b"PK\x05\x06"

    # 256KB chunk boundary (chunk 0)
    chunk_sz = 256 * 1024
    st_c0, hdr_c0, b_c0 = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": f"bytes=0-{chunk_sz - 1}"}
    )
    assert st_c0 == 206 and len(b_c0) == chunk_sz and b_c0[:4] == b"PK\x03\x04"

    # 2. Invalid / unsatisfiable ranges -> 416, nonexistent -> 404
    st_416, _, _ = ctx.http_request(
        "GET", "/base/assets0.pk3", headers={"Range": f"bytes={size0}-{size0 + 1024}"}
    )
    assert st_416 == 416, f"Expected 416 at exact EOF offset {size0}, got {st_416}"

    st_404, _, _ = ctx.http_request("GET", "/base/does_not_exist_adversarial_999.pk3")
    assert st_404 == 404, f"Expected 404 for nonexistent PK3, got {st_404}"

    # 3. 16-way concurrent Central Directory Range stress across base, custom, and alternate-checksum PK3s
    alt_entries = [
        e for e in manifest["pk3s"]
        if re.match(r"^.+\.[0-9a-f]{8}\.pk3$", e["name"], flags=re.I)
    ][:6]
    target_names = [
        "assets0.pk3",
        "assets1.pk3",
        "assets2.pk3",
        "assets3.pk3",
        "ctf_fim.pk3",
        "ctf_kejim.pk3",
        "ctf_ns_streets.pk3",
        "ctf_bespin.pk3",
        "mp_ctf_oneround.pk3",
        "japlus_cia.pk3",
    ] + [e["name"] for e in alt_entries]
    target_entries = [by_name[n] for n in target_names if n in by_name]
    assert len(target_entries) >= 12

    def fetch_cd_head(entry: Dict[str, Any]) -> Tuple[str, int, bytes, str]:
        cd_off = entry["cd_offset"]
        cd_end = cd_off + min(entry["cd_size"], 512) - 1
        st, hdrs, body = ctx.http_request(
            "GET",
            f"/base/{entry['name']}",
            headers={"Range": f"bytes={cd_off}-{cd_end}"},
        )
        return entry["name"], st, body[:4], hdrs.get("accept-ranges", "")

    with ThreadPoolExecutor(max_workers=16) as pool:
        futs = [pool.submit(fetch_cd_head, e) for e in target_entries]
        for fut in as_completed(futs):
            name, st, magic4, accept_ranges = fut.result()
            assert st == 206, f"Concurrent Range request on {name} returned HTTP {st}"
            assert magic4 == b"PK\x01\x02", f"Concurrent CD fetch on {name} had bad magic {magic4!r}"
            assert "bytes" in accept_ranges.lower(), f"Missing Accept-Ranges: bytes on {name}"


# ==============================================================================
# T5_C2_03: F13 + F15 + F16 + F17 — Zero Layout Shift & Link Audit Across All 4 Pages
# ==============================================================================
def t5_c2_03_zero_layout_shift_and_link_audit_across_all_four_pages(ctx: E2ER2TestContext) -> None:
    # Verify aplayer2.js empty-hash fallback contract (defaults hashdata['id'] to 5950160f87b4d04bf8d5e099 when #id= is omitted)
    aplayer2_js = (ctx.archive_public_dir / "aplayer2.js").read_text(encoding="utf-8", errors="replace")
    assert "if (!hashdata['id'])" in aplayer2_js and "5950160f87b4d04bf8d5e099" in aplayer2_js, (
        "aplayer2.js missing empty-hash default player ID fallback logic"
    )

    pages = [
        ("match.html", "#recentdemos", ["getdemo.php?", "mergedemo.php?", "trimdemo.php?", "rpc=matchdemo"]),
        ("aplayer2.html#id=5950160f87b4d04bf8d5e099", "body", ["getdemo.php?", "trimdemo.php?"]),
        ("debugplayer2.html#id=5950160f87b4d04bf8d5e099", "body", ["getdemo.php?", "trimdemo.php?"]),
        ("index.html", "#recentdemos", ["getdemo.php?"]),
    ]

    for page_name, ref_selector, required_substrings in pages:
        for attempt in range(2):
            try:
                ctx.ensure_page_loaded(page_name, force_reload=(page_name != "match.html" or attempt > 0))
                break
            except Exception:
                if attempt == 1:
                    raise
                time.sleep(1.0)
        res = ctx.eval_js(
            """
            const refEl = document.querySelector(arg.refSelector) || document.body;
            const pip = window.JKPiPPlayer;
            if (pip && pip.close) pip.close();
            await new Promise(r => setTimeout(r, 30));

            const rectClosed1 = refEl.getBoundingClientRect();
            const scrollWClosed = document.documentElement.scrollWidth;

            // Open PiP card across size presets to verify zero host DOM layout shift
            const card = document.getElementById('jk-pip-card');
            card.hidden = false;
            card.classList.add('jk-pip-open');
            pip.setSizePreset('default');
            const rectOpenDefault = refEl.getBoundingClientRect();
            const scrollWOpenDefault = document.documentElement.scrollWidth;

            pip.setSizePreset('large');
            const rectOpenLarge = refEl.getBoundingClientRect();
            const scrollWOpenLarge = document.documentElement.scrollWidth;

            pip.setSizePreset('compact');
            const rectOpenCompact = refEl.getBoundingClientRect();

            pip.close();
            const rectClosed2 = refEl.getBoundingClientRect();

            // Audit demo links & #rpc=lookup exclusion on this page
            const substrCounts = {};
            for (const sub of arg.requiredSubstrings) {
              const links = Array.from(document.querySelectorAll(`a[href*="${sub}"]`));
              const withBtn = links.filter(a => a.nextElementSibling && a.nextElementSibling.classList.contains('jk-play-btn'));
              substrCounts[sub] = { total: links.length, withBtn: withBtn.length };
            }

            const lookups = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]'));
            const lookupsWithBtn = lookups.filter(a => a.nextElementSibling && a.nextElementSibling.classList.contains('jk-play-btn'));

            const doubleBtns = Array.from(document.querySelectorAll('.jk-play-btn')).filter(
              b => b.nextElementSibling && b.nextElementSibling.classList.contains('jk-play-btn')
            );

            return {
              widthDiffDefault: Math.abs(rectOpenDefault.width - rectClosed1.width),
              leftDiffDefault: Math.abs(rectOpenDefault.left - rectClosed1.left),
              widthDiffLarge: Math.abs(rectOpenLarge.width - rectClosed1.width),
              widthDiffCompact: Math.abs(rectOpenCompact.width - rectClosed1.width),
              widthDiffAfterClose: Math.abs(rectClosed2.width - rectClosed1.width),
              scrollWCarryDefault: Math.abs(scrollWOpenDefault - scrollWClosed),
              scrollWCarryLarge: Math.abs(scrollWOpenLarge - scrollWClosed),
              substrCounts,
              lookupCount: lookups.length,
              lookupsWithBtn: lookupsWithBtn.length,
              doubleBtns: doubleBtns.length,
            };
            """,
            {"refSelector": ref_selector, "requiredSubstrings": required_substrings},
        )

        assert res["widthDiffDefault"] == 0 and res["leftDiffDefault"] == 0, (
            f"Layout shift detected on {page_name} (default): {res}"
        )
        assert res["widthDiffLarge"] == 0 and res["widthDiffCompact"] == 0 and res["widthDiffAfterClose"] == 0, (
            f"Layout shift detected on {page_name} during resize/close: {res}"
        )
        assert res["scrollWCarryDefault"] == 0 and res["scrollWCarryLarge"] == 0, (
            f"Horizontal scrollWidth shift detected on {page_name}: {res}"
        )

        for sub, counts in res["substrCounts"].items():
            assert counts["total"] > 0 and counts["withBtn"] == counts["total"], (
                f"On {page_name}, link type {sub!r} missing .jk-play-btn: {counts}"
            )
        assert res["lookupsWithBtn"] == 0, (
            f"On {page_name}, found #rpc=lookup permalink with .jk-play-btn: {res}"
        )
        assert res["doubleBtns"] == 0, f"On {page_name}, found duplicate .jk-play-btn: {res}"

        logs = ctx.get_browser_logs()
        assert logs.get("pageErrors", []) == [], (
            f"Uncaught pageErrors on {page_name}: {logs.get('pageErrors')}"
        )


# ==============================================================================
# T5_C2_04: F12 + F15 — Prewarm State, All 4 Demo Link Types & Adversarial #rpc=lookup Exclusion
# ==============================================================================
def t5_c2_04_match_html_prewarm_and_adversarial_link_decoration(ctx: E2ER2TestContext) -> None:
    obs = None
    for attempt in range(2):
        try:
            obs = ctx.ensure_prewarm_observed(force_fresh=(attempt > 0))
            break
        except Exception:
            if attempt == 1:
                raise
            time.sleep(1.0)
    assert obs is not None and obs["ready"] is True, f"Prewarm did not reach ready: {obs}"
    assert obs["pipHidden"] is True, f"PiP card should stay hidden during prewarm: {obs}"
    assert obs["isMuted"] is True, f"Prewarm must stay muted: {obs}"
    assert obs["loadedPacks"] == 4 and 0 <= obs["rangeRequests"] <= 8, (
        f"Prewarm must mount only 4 base packs and <=8 range requests: {obs}"
    )

    res = ctx.eval_js(
        """
        // Check all 4 required demo link types on match.html
        const types = {
          matchdemo: Array.from(document.querySelectorAll('a[href*="rpc=matchdemo"]')),
          getdemo: Array.from(document.querySelectorAll('a[href*="getdemo.php?"]')),
          mergedemo: Array.from(document.querySelectorAll('a[href*="mergedemo.php?"]')),
          trimdemo: Array.from(document.querySelectorAll('a[href*="trimdemo.php?"]')),
        };
        const stats = {};
        for (const [k, arr] of Object.entries(types)) {
          const decorated = arr.filter(a => {
            const nxt = a.nextElementSibling;
            return nxt && nxt.classList.contains('jk-play-btn') && nxt.dataset.demoUrl === a.getAttribute('href');
          });
          stats[k] = { total: arr.length, decorated: decorated.length };
        }

        // Check that zero #rpc=lookup links have .jk-play-btn
        const lookups = Array.from(document.querySelectorAll('a[href*="#rpc=lookup"]'));
        const lookupsWithBtn = lookups.filter(a => a.nextElementSibling && a.nextElementSibling.classList.contains('jk-play-btn'));

        // Adversarial DOM injection test: inject tricky non-demo and hybrid #rpc=lookup links
        const sandbox = document.createElement('div');
        sandbox.id = 'tier5-adversarial-links';
        sandbox.innerHTML = `
          <a id="adv-lookup-1" href="#rpc=lookup&id=004a5ab0b7024e11">Permalink 1</a>
          <a id="adv-lookup-2" href="match.html#rpc=lookup&id=004a5ab0b7024e11">Permalink 2</a>
          <a id="adv-lookup-3" href="getdemo.php?demo=fake.dm_26#rpc=lookup&id=123">Hybrid Permalink</a>
          <a id="adv-profile" href="aplayer2.html#id=5950160f87b4d04bf8d5e099">Player Profile</a>
          <a id="adv-empty" href="#">Hash Only</a>
          <a id="adv-valid" href="getdemo.php?demo=%2Fcygdrive%2FU%2Fdemos%2Fvalid.dm_26">Valid Demo</a>
        `;
        document.body.appendChild(sandbox);
        if (window.JKPiPPlayer && window.JKPiPPlayer.decorateLinks) {
          window.JKPiPPlayer.decorateLinks(sandbox);
          // Call twice to verify idempotency (no double buttons)
          window.JKPiPPlayer.decorateLinks(sandbox);
        }
        await new Promise(r => setTimeout(r, 60));

        const hasBtn = (id) => {
          const el = document.getElementById(id);
          return Boolean(el && el.nextElementSibling && el.nextElementSibling.classList.contains('jk-play-btn'));
        };
        const validBtnCount = sandbox.querySelectorAll('.jk-play-btn').length;
        const advResult = {
          lookup1: hasBtn('adv-lookup-1'),
          lookup2: hasBtn('adv-lookup-2'),
          lookup3: hasBtn('adv-lookup-3'),
          profile: hasBtn('adv-profile'),
          empty: hasBtn('adv-empty'),
          valid: hasBtn('adv-valid'),
          validBtnCount,
        };
        sandbox.remove();
        return {
          stats,
          lookupTotal: lookups.length,
          lookupsWithBtn: lookupsWithBtn.length,
          advResult,
        };
        """
    )

    for k in ("matchdemo", "getdemo", "mergedemo", "trimdemo"):
        st = res["stats"][k]
        assert st["total"] > 0 and st["decorated"] == st["total"], (
            f"Demo link type {k} missing .jk-play-btn on match.html: {st}"
        )
    assert res["lookupTotal"] > 0 and res["lookupsWithBtn"] == 0, (
        f"#rpc=lookup permalinks must never have .jk-play-btn: {res}"
    )
    adv = res["advResult"]
    assert adv["lookup1"] is False and adv["lookup2"] is False and adv["lookup3"] is False
    assert adv["profile"] is False and adv["empty"] is False
    assert adv["valid"] is True and adv["validBtnCount"] == 1


# ==============================================================================
# T5_C2_05: F13 — Out-of-Bounds Drag (-99999, -99999 & +99999, +99999), Foreign PointerId & Button Guard
# ==============================================================================
def t5_c2_05_pip_out_of_bounds_drag_and_pointer_capture_adversarial(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "trimdemo.php")
    res = ctx.eval_js(
        """
        const card = document.getElementById('jk-pip-card');
        const header = document.getElementById('jk-pip-header');
        const compactBtn = document.getElementById('jk-pip-size-compact');
        if (!card || !header || !compactBtn) throw new Error('Missing PiP elements');

        window.JKPiPPlayer.setSizePreset('default');
        await new Promise(r => setTimeout(r, 30));

        // 1. Verify pointerdown on a button inside #jk-pip-header does NOT start dragging
        const rBeforeBtn = card.getBoundingClientRect();
        compactBtn.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 77, button: 0, buttons: 1,
          clientX: rBeforeBtn.left + 10, clientY: rBeforeBtn.top + 10
        }));
        const stateDuringBtnDown = window.JKPiPPlayer.getState();
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 77, button: 0, buttons: 0
        }));

        // 2. Drag to (-99999, -99999)
        const rStart = card.getBoundingClientRect();
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 101, pointerType: 'mouse', button: 0, buttons: 1,
          clientX: rStart.left + 50, clientY: rStart.top + 12
        }));

        // Foreign pointerId (999) during active drag must be ignored
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 999, pointerType: 'mouse', buttons: 1,
          clientX: 250, clientY: 250
        }));
        const rAfterForeign = card.getBoundingClientRect();

        // Actual pointerId (101) moves to (-99999, -99999)
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 101, pointerType: 'mouse', buttons: 1,
          clientX: -99999, clientY: -99999
        }));
        const rNeg = card.getBoundingClientRect();

        // Actual pointerId (101) moves to (+99999, +99999)
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 101, pointerType: 'mouse', buttons: 1,
          clientX: 99999, clientY: 99999
        }));
        const rPos = card.getBoundingClientRect();

        // Rapid corner thrashing
        const corners = [
          [-99999, -99999],
          [99999, -99999],
          [-99999, 99999],
          [99999, 99999],
        ];
        const cornerChecks = [];
        for (let i = 0; i < 8; i++) {
          const [cx, cy] = corners[i % corners.length];
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, cancelable: true, pointerId: 101, pointerType: 'mouse', buttons: 1,
            clientX: cx, clientY: cy
          }));
          const cr = card.getBoundingClientRect();
          cornerChecks.push({
            left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom
          });
        }

        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 101, pointerType: 'mouse', button: 0, buttons: 0,
          clientX: 99999, clientY: 99999
        }));

        const savedLayout = JSON.parse(localStorage.getItem('jk_pip_layout_v1') || '{}');
        return {
          draggingOnBtn: stateDuringBtnDown.dragging,
          foreignMoved: Math.abs(rAfterForeign.left - rStart.left) + Math.abs(rAfterForeign.top - rStart.top),
          negRect: { left: rNeg.left, top: rNeg.top, right: rNeg.right, bottom: rNeg.bottom, width: rNeg.width, height: rNeg.height },
          posRect: { left: rPos.left, top: rPos.top, right: rPos.right, bottom: rPos.bottom, width: rPos.width, height: rPos.height },
          cornerChecks,
          vw: window.innerWidth,
          vh: window.innerHeight,
          savedLayout,
        };
        """
    )

    assert res["draggingOnBtn"] is False, "Clicking a header button must not start header drag"
    assert res["foreignMoved"] == 0, f"Foreign pointerId moved card by {res['foreignMoved']}px"

    vw, vh = res["vw"], res["vh"]
    neg = res["negRect"]
    pos = res["posRect"]
    assert neg["left"] == 0 and neg["top"] == 0, f"Drag to (-99999,-99999) not clamped to (0,0): {neg}"
    assert abs(pos["right"] - vw) <= 1 and abs(pos["bottom"] - vh) <= 1, (
        f"Drag to (+99999,+99999) not clamped to ({vw},{vh}): {pos}"
    )
    for c in res["cornerChecks"]:
        assert c["left"] >= -1 and c["top"] >= -1 and c["right"] <= vw + 1 and c["bottom"] <= vh + 1, (
            f"Corner thrash out of bounds: {c} vs viewport ({vw},{vh})"
        )
    assert 0 <= res["savedLayout"]["x"] <= vw and 0 <= res["savedLayout"]["y"] <= vh


# ==============================================================================
# T5_C2_06: F13 — Keyboard Arrow Key Nudging & Viewport Edge Clamping
# ==============================================================================
def t5_c2_06_pip_keyboard_arrow_key_nudging_and_edge_clamping(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "trimdemo.php")
    res = ctx.eval_js(
        """
        const card = document.getElementById('jk-pip-card');
        const header = document.getElementById('jk-pip-header');
        window.JKPiPPlayer.setSizePreset('default');

        // Place card in center (300, 200) via drag
        const r0 = card.getBoundingClientRect();
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 50, pointerType: 'mouse', button: 0, buttons: 1,
          clientX: r0.left + 20, clientY: r0.top + 10
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 50, pointerType: 'mouse', buttons: 1,
          clientX: 320, clientY: 210
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 50, pointerType: 'mouse', button: 0, buttons: 0,
          clientX: 320, clientY: 210
        }));

        header.focus();
        const startRect = card.getBoundingClientRect();

        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        const afterLeft = card.getBoundingClientRect();

        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        const afterUp = card.getBoundingClientRect();

        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        const afterRight = card.getBoundingClientRect();

        header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        const afterDown = card.getBoundingClientRect();

        // Nudge 30 times top-left to test clamping at (0, 0)
        for (let i = 0; i < 30; i++) {
          header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
          header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        }
        const clampedTL = card.getBoundingClientRect();

        return {
          stepLeft: afterLeft.left - startRect.left,
          stepUp: afterUp.top - afterLeft.top,
          stepRight: afterRight.left - afterUp.left,
          stepDown: afterDown.top - afterRight.top,
          clampedTL: { left: clampedTL.left, top: clampedTL.top },
        };
        """
    )

    assert res["stepLeft"] == -20, f"Expected ArrowLeft step -20, got {res['stepLeft']}"
    assert res["stepUp"] == -20, f"Expected ArrowUp step -20, got {res['stepUp']}"
    assert res["stepRight"] == 20, f"Expected ArrowRight step +20, got {res['stepRight']}"
    assert res["stepDown"] == 20, f"Expected ArrowDown step +20, got {res['stepDown']}"
    assert res["clampedTL"]["left"] == 0 and res["clampedTL"]["top"] == 0, (
        f"Arrow key nudging failed to clamp at (0,0): {res['clampedTL']}"
    )


# ==============================================================================
# T5_C2_07: F13 — Rapid Size Presets + Out-of-Bounds Resize Handle Drag Stress
# ==============================================================================
def t5_c2_07_pip_rapid_size_presets_and_resize_handle_stress(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "trimdemo.php")
    res = ctx.eval_js(
        """
        const card = document.getElementById('jk-pip-card');
        const handle = document.getElementById('jk-pip-resize-handle');
        const canvas = document.getElementById('jk-canvas');
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);

        // 1. Rapidly cycle size presets
        const presetObservations = {};
        for (const preset of ['compact', 'large', 'default', 'compact', 'large', 'default']) {
          const btn = document.getElementById('jk-pip-size-' + preset);
          btn.click();
          const r = card.getBoundingClientRect();
          presetObservations[preset] = {
            width: Math.round(r.width),
            height: Math.round(r.height),
            activeBtn: btn.classList.contains('active'),
          };
        }

        // 2. Resize handle out-of-bounds minimum (-99999, -99999)
        const r0 = card.getBoundingClientRect();
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 202, pointerType: 'mouse', button: 0, buttons: 1,
          clientX: r0.right - 3, clientY: r0.bottom - 3
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 202, pointerType: 'mouse', buttons: 1,
          clientX: -99999, clientY: -99999
        }));
        const rMin = card.getBoundingClientRect();

        // 3. Resize handle out-of-bounds maximum (+99999, +99999)
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 202, pointerType: 'mouse', buttons: 1,
          clientX: 99999, clientY: 99999
        }));
        const rMax = card.getBoundingClientRect();

        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 202, pointerType: 'mouse', button: 0, buttons: 0,
          clientX: 99999, clientY: 99999
        }));

        // Restore default size
        window.JKPiPPlayer.setSizePreset('default');
        await new Promise(r => setTimeout(r, 50));

        const vpW = mod && mod._JK_DemoGetViewportWidth ? mod._JK_DemoGetViewportWidth() : canvas.width;
        const vpH = mod && mod._JK_DemoGetViewportHeight ? mod._JK_DemoGetViewportHeight() : canvas.height;

        return {
          presetObservations,
          minSize: { width: Math.round(rMin.width), height: Math.round(rMin.height) },
          maxSize: {
            width: Math.round(rMax.width),
            height: Math.round(rMax.height),
            left: rMax.left,
            top: rMax.top,
            right: rMax.right,
            bottom: rMax.bottom,
          },
          vw: window.innerWidth,
          vh: window.innerHeight,
          canvasW: canvas.width,
          canvasH: canvas.height,
          vpW,
          vpH,
          playing: mod._JK_DemoIsPlaying() === 1,
        };
        """
    )

    obs = res["presetObservations"]
    assert obs["compact"]["width"] == 420 and obs["compact"]["height"] == 290 and obs["compact"]["activeBtn"]
    assert obs["default"]["width"] == 560 and obs["default"]["height"] == 376 and obs["default"]["activeBtn"]
    assert obs["large"]["width"] == 760 and obs["large"]["height"] == 496 and obs["large"]["activeBtn"]

    assert res["minSize"]["width"] == 320 and res["minSize"]["height"] == 220, (
        f"Expected minimum size clamp (320, 220), got {res['minSize']}"
    )
    vw, vh = res["vw"], res["vh"]
    mx = res["maxSize"]
    assert mx["width"] == vw - 16 and mx["height"] == vh - 16, (
        f"Expected maximum size clamp ({vw - 16}, {vh - 16}), got {mx}"
    )
    assert mx["left"] >= -1 and mx["top"] >= -1 and mx["right"] <= vw + 1 and mx["bottom"] <= vh + 1
    assert res["canvasW"] == res["vpW"] >= 320 and res["canvasH"] == res["vpH"] >= 180
    assert res["playing"] is True


# ==============================================================================
# T5_C2_08: F12 + F14 — Multi-Cycle Close & Re-open Lifecycle (Wasm Alive + Audio Muted)
# ==============================================================================
def t5_c2_08_close_and_reopen_multi_cycle_wasm_alive_and_audio_muted(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "trimdemo.php")
    logs_before = ctx.get_browser_logs()
    wasm_fetches_before = [
        r for r in logs_before.get("networkResponses", []) if "openjk.wasm" in r["url"]
    ]

    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const pip = window.JKPiPPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);
        const card = document.getElementById('jk-pip-card');
        const closeBtn = document.getElementById('jk-pip-close');
        const playBtn = document.querySelector('.jk-play-btn[data-demo-url*="trimdemo.php"]') || document.querySelector('.jk-play-btn');

        window.__tier5ModRef = mod;
        const cycles = [];

        for (let i = 0; i < 3; i++) {
          // Unmute and set volume before closing to verify Close strictly mutes audio
          pip.setMuted(false);
          pip.setVolume(0.8);
          const unmutedBeforeClose = mod._JK_DemoIsMuted() === 0;

          // Close via button on even cycles, via API on odd cycles
          if (i % 2 === 0) {
            closeBtn.click();
          } else {
            pip.close();
          }

          const csClosed = window.getComputedStyle(card);
          const closedCheck = {
            unmutedBeforeClose,
            isOpen: pip.isOpen(),
            cardHidden: card.hidden || csClosed.display === 'none',
            isMutedOnClose: mod._JK_DemoIsMuted() === 1,
            isPausedOnClose: mod._JK_DemoIsPaused() === 1,
            wasmReadyWhileClosed: mod._JK_DemoIsReady() === 1,
            sameModRef: window.Module === window.__tier5ModRef,
          };

          // Re-open and wait for openAndPlay / loadDemo promise to complete (status overlay hidden + playing)
          const overlay = document.getElementById('jk-pip-status-overlay');
          const t0 = performance.now();
          playBtn.click();
          while (performance.now() - t0 < 25000) {
            const overlayHidden = !overlay || overlay.style.display === 'none';
            if (overlayHidden && pip.isOpen() && window.getComputedStyle(card).display !== 'none' && mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoIsPaused() === 0) {
              break;
            }
            await new Promise(r => setTimeout(r, 40));
          }
          const reopenMs = performance.now() - t0;
          cycles.push(Object.assign(closedCheck, {
            reopenedVisible: pip.isOpen() && window.getComputedStyle(card).display !== 'none',
            playingAfterReopen: mod._JK_DemoIsPlaying() === 1 && mod._JK_DemoIsPaused() === 0,
            reopenMs,
            canvasCount: document.querySelectorAll('#jk-canvas').length,
            pipCardCount: document.querySelectorAll('#jk-pip-card').length,
          }));
        }
        pip.setMuted(true);
        return { cycles };
        """,
        timeout=60.0,
    )

    logs_after = ctx.get_browser_logs()
    wasm_fetches_after = [
        r for r in logs_after.get("networkResponses", []) if "openjk.wasm" in r["url"]
    ]
    assert len(wasm_fetches_after) == len(wasm_fetches_before), (
        f"openjk.wasm was re-fetched during Close/Re-open cycles: before={len(wasm_fetches_before)}, after={len(wasm_fetches_after)}"
    )

    for idx, c in enumerate(res["cycles"]):
        assert c["unmutedBeforeClose"] is True, f"Cycle {idx}: failed to unmute before close: {c}"
        assert c["isOpen"] is False and c["cardHidden"] is True, f"Cycle {idx}: card not hidden on close: {c}"
        assert c["isMutedOnClose"] is True, f"Cycle {idx}: audio not muted on close: {c}"
        assert c["isPausedOnClose"] is True, f"Cycle {idx}: playback not paused on close: {c}"
        assert c["wasmReadyWhileClosed"] is True and c["sameModRef"] is True, (
            f"Cycle {idx}: Wasm runtime did not stay alive on close: {c}"
        )
        assert c["reopenedVisible"] is True and c["playingAfterReopen"] is True, (
            f"Cycle {idx}: failed to reopen and play: {c}"
        )
        assert c["canvasCount"] == 1 and c["pipCardCount"] == 1


# ==============================================================================
# T5_C2_09: F11 + F14 — Controls Bar Stress & Corrupt localStorage Resilience
# ==============================================================================
def t5_c2_09_pip_controls_stress_and_corrupt_localstorage_resilience(ctx: E2ER2TestContext) -> None:
    ctx.ensure_pip_playing("match.html", "trimdemo.php")
    res = ctx.eval_js(
        """
        const p = window.JKDemoPlayer || window.OpenJKPlayer;
        const pip = window.JKPiPPlayer;
        const mod = window.Module || (p && p.getModule ? p.getModule() : null);

        // 1. Corrupt localStorage keys and verify player/PiP functions do not throw
        localStorage.setItem('jk_pip_layout_v1', '{corrupt_json_layout');
        localStorage.setItem('openjk_player_prefs_v1', '{corrupt_json_prefs');

        // 2. Speed selector & out-of-range clamping
        const speedSelect = document.getElementById('jk-pip-speed');
        const speedResults = [];
        for (const val of ['0.25', '0.5', '1', '2', '4']) {
          speedSelect.value = val;
          speedSelect.dispatchEvent(new Event('change', { bubbles: true }));
          speedResults.push(mod._JK_DemoGetSpeed());
        }
        // Extreme speed clamping via API
        p.setSpeed(9999);
        const maxClampedSpeed = mod._JK_DemoGetSpeed();
        p.setSpeed(0.0001);
        const minClampedSpeed = mod._JK_DemoGetSpeed();
        pip.setSpeed(1.0);

        // 3. Volume slider auto-unmute when muted + Mute toggle
        const volInput = document.getElementById('jk-pip-volume');
        const muteBtn = document.getElementById('jk-pip-mute');
        pip.setMuted(true);
        const initiallyMuted = mod._JK_DemoIsMuted() === 1;
        volInput.value = '0.55';
        volInput.dispatchEvent(new Event('input', { bubbles: true }));
        volInput.dispatchEvent(new Event('change', { bubbles: true }));
        const unmutedByVolumeSlider = mod._JK_DemoIsMuted() === 0;
        const volAfterSlider = mod._JK_DemoGetVolume();
        muteBtn.click();
        const mutedAfterBtn = mod._JK_DemoIsMuted() === 1;

        // 4. Seek scrubber rapid multi-point scrub + Start Over (0:00)
        const seekInput = document.getElementById('jk-pip-seek');
        const startOverBtn = document.getElementById('jk-pip-start-over');
        const dur = mod._JK_DemoGetDurationMs();
        const scrubTargets = [
          Math.floor(dur * 0.25),
          Math.floor(dur * 0.60),
          Math.floor(dur * 0.10),
        ];
        const scrubObserved = [];
        for (const t of scrubTargets) {
          seekInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          seekInput.value = String(t);
          seekInput.dispatchEvent(new Event('input', { bubbles: true }));
          seekInput.dispatchEvent(new Event('change', { bubbles: true }));
          seekInput.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          scrubObserved.push(mod._JK_DemoGetCurrentTimeMs());
        }
        startOverBtn.click();
        const afterStartOver = mod._JK_DemoGetCurrentTimeMs();

        // 5. Loop button aria-pressed & state sync
        const loopBtn = document.getElementById('jk-pip-loop');
        pip.setLoop(true);
        loopBtn.click();
        const loopOff = mod._JK_DemoGetLoop() === 0 && loopBtn.getAttribute('aria-pressed') === 'false';
        loopBtn.click();
        const loopOn = mod._JK_DemoGetLoop() === 1 && loopBtn.getAttribute('aria-pressed') === 'true';

        return {
          speedResults,
          maxClampedSpeed,
          minClampedSpeed,
          initiallyMuted,
          unmutedByVolumeSlider,
          volAfterSlider,
          mutedAfterBtn,
          scrubTargets,
          scrubObserved,
          afterStartOver,
          loopOff,
          loopOn,
        };
        """
    )

    for exp, act in zip([0.25, 0.5, 1.0, 2.0, 4.0], res["speedResults"]):
        assert abs(act - exp) < 0.02, f"Speed mismatch: expected {exp}, got {act}"
    assert abs(res["maxClampedSpeed"] - 20.0) < 0.05
    assert abs(res["minClampedSpeed"] - 0.05) < 0.01
    assert res["initiallyMuted"] is True and res["unmutedByVolumeSlider"] is True
    assert abs(res["volAfterSlider"] - 0.55) < 0.05 and res["mutedAfterBtn"] is True
    for target, obs_ms in zip(res["scrubTargets"], res["scrubObserved"]):
        assert abs(obs_ms - target) <= 600, f"Scrub target {target} landed at {obs_ms}"
    assert 0 <= res["afterStartOver"] <= 400
    assert res["loopOff"] is True and res["loopOn"] is True


def get_tier5_challenger2_tests() -> List[TestCase]:
    return [
        TestCase(
            "T5_C2_01_nginx_wasm_mime_headers_and_deployment_sync",
            5,
            "F18",
            "Verify application/wasm MIME, Cache-Control, HEAD/Range on openjk.wasm, and MD5 sync across staged/deployed files",
            t5_c2_01_nginx_wasm_mime_headers_and_deployment_sync,
        ),
        TestCase(
            "T5_C2_02_nginx_pk3_http_206_range_boundary_and_concurrent_stress",
            5,
            "F18",
            "Stress-test HTTP 206 Partial Content (0-0, EOF-1, suffix -22, 256KB chunks, 416/404, and 16-way concurrent CD Range fetches)",
            t5_c2_02_nginx_pk3_http_206_range_boundary_and_concurrent_stress,
        ),
        TestCase(
            "T5_C2_04_match_html_prewarm_and_adversarial_link_decoration",
            5,
            "F12+F15",
            "Verify background prewarm, all 4 demo link types on match.html, and strict exclusion of .jk-play-btn from #rpc=lookup & hybrid links",
            t5_c2_04_match_html_prewarm_and_adversarial_link_decoration,
        ),
        TestCase(
            "T5_C2_05_pip_out_of_bounds_drag_and_pointer_capture_adversarial",
            5,
            "F13",
            "Stress-test out-of-bounds header drag (-99999,-99999 and +99999,+99999), corner thrashing, foreign pointerId, and button click guard",
            t5_c2_05_pip_out_of_bounds_drag_and_pointer_capture_adversarial,
        ),
        TestCase(
            "T5_C2_06_pip_keyboard_arrow_key_nudging_and_edge_clamping",
            5,
            "F13",
            "Verify keyboard ArrowLeft/Right/Up/Down 20px nudging on focused #jk-pip-header and viewport edge clamping",
            t5_c2_06_pip_keyboard_arrow_key_nudging_and_edge_clamping,
        ),
        TestCase(
            "T5_C2_07_pip_rapid_size_presets_and_resize_handle_stress",
            5,
            "F13",
            "Stress-test rapid Compact/Default/Large preset cycling and out-of-bounds resize handle dragging (-99999 to +99999) with viewport sync",
            t5_c2_07_pip_rapid_size_presets_and_resize_handle_stress,
        ),
        TestCase(
            "T5_C2_08_close_and_reopen_multi_cycle_wasm_alive_and_audio_muted",
            5,
            "F12+F14",
            "Execute 3 Close & Re-open cycles verifying audio mutes on close, playback pauses, card hides, and Wasm runtime stays alive",
            t5_c2_08_close_and_reopen_multi_cycle_wasm_alive_and_audio_muted,
        ),
        TestCase(
            "T5_C2_09_pip_controls_stress_and_corrupt_localstorage_resilience",
            5,
            "F11+F14",
            "Stress-test speed clamping, volume auto-unmute, multi-point seek scrubbing, Start Over, Loop aria-pressed, and corrupt localStorage",
            t5_c2_09_pip_controls_stress_and_corrupt_localstorage_resilience,
        ),
        TestCase(
            "T5_C2_03_zero_layout_shift_and_link_audit_across_all_four_pages",
            5,
            "F13+F15+F16+F17",
            "Verify zero layout shift (0px table/scrollWidth delta) and strict link decoration across match.html, aplayer2.html, debugplayer2.html, and index.html",
            t5_c2_03_zero_layout_shift_and_link_audit_across_all_four_pages,
        ),
    ]


def main() -> int:
    tests = get_tier5_challenger2_tests()
    print("=" * 100, flush=True)
    print(f"Running Tier 5 White-Box Adversarial Suite — Challenger 2 ({len(tests)} tests)", flush=True)
    print("=" * 100, flush=True)

    ctx = E2ER2TestContext(base_url="http://localhost:8081")

    def _cleanup_handler(signum: int, _frame: Any) -> None:
        ctx.close()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, _cleanup_handler)
    signal.signal(signal.SIGINT, _cleanup_handler)

    passed = 0
    failed = 0
    t0_suite = time.time()

    try:
        # Pre-warm headless Chrome bridge with fallback binaries if concurrent load causes timeout
        chrome_candidates = [
            "/opt/google/chrome/chrome",
            "/home/dan/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome",
            "/usr/bin/google-chrome",
        ]
        for cand in chrome_candidates:
            if not os.path.exists(cand):
                continue
            os.environ["CHROME_PATH"] = cand
            try:
                ctx.ensure_browser_bridge()
                ctx.rpc("init", timeout=35.0)
                break
            except Exception:
                ctx.close()
                time.sleep(1.0)

        for idx, tc in enumerate(tests, 1):
            t0 = time.time()
            try:
                tc.fn(ctx)
                dt_ms = (time.time() - t0) * 1000.0
                passed += 1
                print(
                    f"[{idx:2d}/{len(tests):2d}] [PASS] (T{tc.tier} {tc.feature:<15}) "
                    f"{tc.test_id} ({dt_ms:.0f} ms)",
                    flush=True,
                )
            except Exception as exc:
                dt_ms = (time.time() - t0) * 1000.0
                failed += 1
                print(
                    f"[{idx:2d}/{len(tests):2d}] [FAIL] (T{tc.tier} {tc.feature:<15}) "
                    f"{tc.test_id} ({dt_ms:.0f} ms) -> {exc}",
                    flush=True,
                )
                traceback.print_exc()
    finally:
        ctx.close()

    elapsed = time.time() - t0_suite
    pct = (passed / len(tests) * 100.0) if tests else 0.0
    print("=" * 100, flush=True)
    print(
        f"Tier 5 Challenger 2 Summary: {passed}/{len(tests)} passed "
        f"({failed} failed) — {pct:.1f}% in {elapsed:.1f}s",
        flush=True,
    )
    print("=" * 100, flush=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
