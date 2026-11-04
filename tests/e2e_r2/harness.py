#!/usr/bin/env python3
"""
Shared E2E Test Harness for OpenJK Round 2 (codemp + JKA Demo Archive Integration).
Provides:
- Exact RFC 1320 MD4 & Quake 3 signed 32-bit Com_BlockChecksum oracle matching FS_LoadZipFile
- ZIP Central Directory & EOCD binary inspection helpers
- HTTP & Range request client against http://localhost:8081
- Persistent Headless Chrome 151 (Puppeteer) RPC session (browser_bridge.js)
- Unified JS/Wasm bridge helper supporting window.JKPiPPlayer, window.JKDemoPlayer, window.OpenJKPlayer, and Module._JK_Demo* exports
- Screenshot decoding & WebGL 3D pixel analysis (Pillow + NumPy)
"""

import base64
import dataclasses
import io
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request
import zipfile

import numpy as np
from PIL import Image

RPC_PREFIX = "__RPC_RES__"

# Known base JKA PK3 signed 32-bit Com_BlockChecksum values (verified from codemp/qcommon/files.cpp)
EXPECTED_BASE_CHECKSUMS: Dict[str, int] = {
    "assets0.pk3": 1767559464,
    "assets1.pk3": -682941524,
    "assets2.pk3": -1239421272,
    "assets3.pk3": -1342311474,
}

PK3_SOURCE_DIRS: List[Path] = [
    Path("/home/jkashared"),
    Path("/home/dan/refresh/base"),
    Path("/home/dan/whoracle/home/whoracle/base"),
    Path("/home/dan/whoracle/home/whoracle/base_backup"),
    Path("/media/dan/Elements/pk3"),
]


@dataclasses.dataclass
class TestCase:
    test_id: str
    tier: int
    feature: str
    description: str
    fn: Callable[["E2ER2TestContext"], None]


# ==============================================================================
# Quake 3 / OpenJK MD4 & Com_BlockChecksum Reference Oracle (codemp/qcommon/md4.cpp)
# ==============================================================================
def _lshift32(x: int, s: int) -> int:
    x &= 0xFFFFFFFF
    return ((x << s) | (x >> (32 - s))) & 0xFFFFFFFF


def _mdfour64(state: List[int], m_words: Tuple[int, ...]) -> None:
    a, b, c, d = state
    aa, bb, cc, dd = a, b, c, d

    def f(x: int, y: int, z: int) -> int:
        return (x & y) | ((~x & 0xFFFFFFFF) & z)

    def g(x: int, y: int, z: int) -> int:
        return (x & y) | (x & z) | (y & z)

    def h(x: int, y: int, z: int) -> int:
        return x ^ y ^ z

    # Round 1
    for k, s in (
        (0, 3), (1, 7), (2, 11), (3, 19),
        (4, 3), (5, 7), (6, 11), (7, 19),
        (8, 3), (9, 7), (10, 11), (11, 19),
        (12, 3), (13, 7), (14, 11), (15, 19),
    ):
        if s == 3:
            a = _lshift32(a + f(b, c, d) + m_words[k], s)
        elif s == 7:
            d = _lshift32(d + f(a, b, c) + m_words[k], s)
        elif s == 11:
            c = _lshift32(c + f(d, a, b) + m_words[k], s)
        else:
            b = _lshift32(b + f(c, d, a) + m_words[k], s)

    # Round 2
    for k, s in (
        (0, 3), (4, 5), (8, 9), (12, 13),
        (1, 3), (5, 5), (9, 9), (13, 13),
        (2, 3), (6, 5), (10, 9), (14, 13),
        (3, 3), (7, 5), (11, 9), (15, 13),
    ):
        if s == 3:
            a = _lshift32(a + g(b, c, d) + m_words[k] + 0x5A827999, s)
        elif s == 5:
            d = _lshift32(d + g(a, b, c) + m_words[k] + 0x5A827999, s)
        elif s == 9:
            c = _lshift32(c + g(d, a, b) + m_words[k] + 0x5A827999, s)
        else:
            b = _lshift32(b + g(c, d, a) + m_words[k] + 0x5A827999, s)

    # Round 3
    for k, s in (
        (0, 3), (8, 9), (4, 11), (12, 15),
        (2, 3), (10, 9), (6, 11), (14, 15),
        (1, 3), (9, 9), (5, 11), (13, 15),
        (3, 3), (11, 9), (7, 11), (15, 15),
    ):
        if s == 3:
            a = _lshift32(a + h(b, c, d) + m_words[k] + 0x6ED9EBA1, s)
        elif s == 9:
            d = _lshift32(d + h(a, b, c) + m_words[k] + 0x6ED9EBA1, s)
        elif s == 11:
            c = _lshift32(c + h(d, a, b) + m_words[k] + 0x6ED9EBA1, s)
        else:
            b = _lshift32(b + h(c, d, a) + m_words[k] + 0x6ED9EBA1, s)

    state[0] = (a + aa) & 0xFFFFFFFF
    state[1] = (b + bb) & 0xFFFFFFFF
    state[2] = (c + cc) & 0xFFFFFFFF
    state[3] = (d + dd) & 0xFFFFFFFF


def mdfour(data: bytes) -> bytes:
    """Exact port of mdfour() in codemp/qcommon/md4.cpp."""
    state = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476]
    total_n = 0
    n = len(data)
    offset = 0

    if n == 0:
        # Note: in codemp/qcommon/md4.cpp line 164: if (n == 0) mdfour_tail(in, n); followed by mdfour_tail(in, n);
        for _ in range(2):
            buf = bytearray(128)
            buf[0] = 0x80
            struct.pack_into("<I", buf, 56, 0)
            _mdfour64(state, struct.unpack("<16I", bytes(buf[:64])))
        return struct.pack("<4I", *state)

    while n >= 64:
        _mdfour64(state, struct.unpack("<16I", data[offset : offset + 64]))
        offset += 64
        n -= 64
        total_n += 64

    total_n += n
    bit_len = (total_n * 8) & 0xFFFFFFFF
    buf = bytearray(128)
    if n > 0:
        buf[:n] = data[offset : offset + n]
    buf[n] = 0x80
    if n <= 55:
        struct.pack_into("<I", buf, 56, bit_len)
        _mdfour64(state, struct.unpack("<16I", bytes(buf[:64])))
    else:
        struct.pack_into("<I", buf, 120, bit_len)
        _mdfour64(state, struct.unpack("<16I", bytes(buf[:64])))
        _mdfour64(state, struct.unpack("<16I", bytes(buf[64:128])))

    return struct.pack("<4I", *state)


def com_block_checksum(buffer: bytes) -> int:
    """Exact port of Com_BlockChecksum() + LittleLong() returning signed 32-bit int."""
    d0, d1, d2, d3 = struct.unpack("<4i", mdfour(buffer))
    return int(d0 ^ d1 ^ d2 ^ d3)


def compute_q3_pk3_checksum(pk3_path: Path) -> int:
    """
    Compute exact signed 32-bit Quake 3 pack->checksum matching FS_LoadZipFile
    in codemp/qcommon/files.cpp:2527-2552.
    """
    with zipfile.ZipFile(pk3_path, "r") as zf:
        crcs = [info.CRC & 0xFFFFFFFF for info in zf.infolist() if info.file_size > 0]
    buf = struct.pack(f"<{len(crcs)}I", *crcs) if crcs else b""
    return com_block_checksum(buf)


def canonical_pk3_basename(filename: str) -> str:
    """Normalize a PK3 filename (including tweaked suffixes like .pk_3, .pk_dis, .dis_pk3_dis) to canonical lowercase basename."""
    base = re.sub(r"\.(?:dis_)?pk_?3?.*$", "", filename, flags=re.IGNORECASE)
    # Also strip any .<8hex> alternate checksum suffix if called on an already-consolidated name
    base = re.sub(r"\.[0-9a-f]{8}$", "", base, flags=re.IGNORECASE)
    return base.lower()


def inspect_zip_eocd(path: Path) -> Dict[str, Any]:
    """Read the physical ZIP End-of-Central-Directory (EOCD) record and Central Directory header from a .pk3 file."""
    size = path.stat().st_size
    read_len = min(size, 65557)
    with path.open("rb") as f:
        f.seek(size - read_len)
        tail = f.read(read_len)
        pos = tail.rfind(b"PK\x05\x06")
        if pos < 0:
            raise ValueError(f"EOCD signature not found in {path}")
        _, _, _, _, entries, cd_size, cd_offset, _ = struct.unpack(
            "<4sHHHHIIH", tail[pos : pos + 22]
        )
        f.seek(cd_offset)
        cd_magic = f.read(4)
    return {
        "size": size,
        "entries": entries,
        "cd_offset": cd_offset,
        "cd_size": cd_size,
        "tail_size": size - cd_offset,
        "cd_magic": cd_magic,
    }


def scan_dm26_packets(dm26_bytes: bytes) -> Dict[str, Any]:
    """Parse message packet framing (seq, msgLen) in a .dm_26 binary stream."""
    offset = 0
    n = len(dm26_bytes)
    packet_count = 0
    total_payload_bytes = 0
    reached_eof_marker = False
    while offset + 8 <= n:
        seq, msg_len = struct.unpack_from("<ii", dm26_bytes, offset)
        offset += 8
        if seq == -1 and msg_len == -1:
            reached_eof_marker = True
            break
        if msg_len < 0 or offset + msg_len > n:
            break
        packet_count += 1
        total_payload_bytes += msg_len
        offset += msg_len
    return {
        "packet_count": packet_count,
        "total_payload_bytes": total_payload_bytes,
        "reached_eof_marker": reached_eof_marker,
        "bytes_parsed": offset,
    }


class E2ER2TestContext:
    """Shared context managing HTTP client, Headless Chrome bridge, and cached observations for Round 2."""

    def __init__(self, base_url: str = "http://localhost:8081") -> None:
        self.root_dir = Path("/home/dan/OpenJK/jaMME")
        self.scripts_dir = self.root_dir / "scripts"
        self.build_native_dir = self.root_dir / "build-native"
        self.build_wasm_dir = self.root_dir / "build-wasm"
        self.web_dir = self.root_dir / "web"
        self.tests_dir = self.root_dir / "tests" / "e2e_r2"
        self.consolidated_pk3_dir = Path("/media/dan/Elements/pk3/base")
        self.manifest_path = self.consolidated_pk3_dir / "manifest.json"
        self.goog_dir = Path("/home/dan/goog")
        self.archive_public_dir = (
            self.goog_dir / "phpdocker" / "nginx" / "nginx" / "web" / "public"
        )
        self.nginx_conf_path = (
            self.goog_dir / "phpdocker" / "nginx" / "nginx" / "nginx.conf"
        )
        self.docker_compose_path = (
            self.goog_dir / "stacks" / "demos-web" / "docker-compose.yaml"
        )
        self.demo_dir = Path("/home/dan/DemoTools/DemoChanger")
        self.screenshot_dir = Path("/tmp/openjk_e2e_r2_screenshots")
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)

        self.base_url = base_url.rstrip("/")
        self.bridge_proc: Optional[subprocess.Popen] = None
        self._rpc_id: int = 0

        self._manifest_cache: Optional[Dict[str, Any]] = None
        self._checksum_cache: Dict[str, int] = {}
        self.current_page_name: Optional[str] = None
        self.prewarm_observation: Optional[Dict[str, Any]] = None
        self.page_dom_cache: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Manifest & Checksum helpers
    # ------------------------------------------------------------------
    def get_manifest(self) -> Dict[str, Any]:
        if self._manifest_cache is None:
            assert (
                self.manifest_path.exists()
            ), f"Missing consolidated manifest at {self.manifest_path}"
            self._manifest_cache = json.loads(
                self.manifest_path.read_text(encoding="utf-8")
            )
        return self._manifest_cache

    def get_pk3_checksum(self, pk3_path: Path) -> int:
        key = str(pk3_path)
        if key not in self._checksum_cache:
            self._checksum_cache[key] = compute_q3_pk3_checksum(pk3_path)
        return self._checksum_cache[key]

    # ------------------------------------------------------------------
    # HTTP helpers against http://localhost:8081
    # ------------------------------------------------------------------
    def http_request(
        self,
        method: str,
        path: str,
        headers: Optional[Dict[str, str]] = None,
        data: Optional[bytes] = None,
        timeout: float = 20.0,
    ) -> Tuple[int, Dict[str, str], bytes]:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        req = urllib.request.Request(
            url, data=data, headers=headers or {}, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = resp.status
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read() if method != "HEAD" else b""
                return status, resp_headers, body
        except urllib.error.HTTPError as e:
            resp_headers = (
                {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
            )
            body = e.read() if method != "HEAD" else b""
            return e.code, resp_headers, body

    # ------------------------------------------------------------------
    # Browser Bridge Lifecycle
    # ------------------------------------------------------------------
    def ensure_browser_bridge(self) -> None:
        if self.bridge_proc is not None and self.bridge_proc.poll() is None:
            return

        bridge_script = self.tests_dir / "browser_bridge.js"
        node_bin = "/home/dan/.local/bin/node"
        if not os.path.exists(node_bin):
            node_bin = "node"

        env = os.environ.copy()
        existing_node_path = env.get("NODE_PATH", "")
        flights_nm = "/home/dan/flights/node_modules"
        env["NODE_PATH"] = (
            f"{flights_nm}:{existing_node_path}" if existing_node_path else flights_nm
        )
        env["PATH"] = (
            f"/home/dan/.local/bin:/home/dan/.local/node/bin:{env.get('PATH', '/usr/bin:/bin')}"
        )

        self.bridge_proc = subprocess.Popen(
            [node_bin, str(bridge_script)],
            cwd=str(self.root_dir),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        res = self.rpc("ping", timeout=15.0)
        assert res.get("status") == "ok", f"Bridge ping failed: {res}"

    def rpc(
        self, cmd: str, params: Optional[Dict[str, Any]] = None, timeout: float = 120.0
    ) -> Any:
        if self.bridge_proc is None or self.bridge_proc.poll() is not None:
            if cmd != "ping":
                self.ensure_browser_bridge()
        assert self.bridge_proc is not None
        assert self.bridge_proc.stdin is not None
        assert self.bridge_proc.stdout is not None

        self._rpc_id += 1
        req_id = self._rpc_id
        payload = json.dumps({"id": req_id, "cmd": cmd, "params": params or {}})
        self.bridge_proc.stdin.write(payload + "\n")
        self.bridge_proc.stdin.flush()

        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.bridge_proc.stdout.readline()
            if not line:
                stderr_txt = ""
                if self.bridge_proc.stderr:
                    try:
                        stderr_txt = self.bridge_proc.stderr.read()
                    except Exception:
                        pass
                raise RuntimeError(
                    f"browser_bridge.js EOF while waiting for cmd={cmd}: {stderr_txt}"
                )
            line = line.strip()
            if not line.startswith(RPC_PREFIX):
                continue
            resp = json.loads(line[len(RPC_PREFIX) :])
            if resp.get("id") != req_id:
                continue
            if not resp.get("ok"):
                raise RuntimeError(
                    f"Browser RPC error in '{cmd}': {resp.get('error')}\n{resp.get('stack', '')}"
                )
            return resp.get("result")

        raise TimeoutError(f"Browser RPC '{cmd}' timed out after {timeout}s")

    def eval_js(self, script: str, arg: Any = None, timeout: float = 60.0) -> Any:
        self.ensure_browser_bridge()
        return self.rpc("eval", {"script": script, "arg": arg}, timeout=timeout)

    def get_browser_logs(self) -> Dict[str, Any]:
        self.ensure_browser_bridge()
        return self.rpc("get_logs")

    def close(self) -> None:
        if self.bridge_proc is not None and self.bridge_proc.poll() is None:
            try:
                self.rpc("close", timeout=5.0)
            except Exception:
                pass
            try:
                self.bridge_proc.terminate()
                self.bridge_proc.wait(timeout=3.0)
            except Exception:
                try:
                    self.bridge_proc.kill()
                except Exception:
                    pass
            self.bridge_proc = None

    # ------------------------------------------------------------------
    # Archive Page & Prewarm / PiP Helpers
    # ------------------------------------------------------------------
    def ensure_prewarm_observed(self, force_fresh: bool = False) -> Dict[str, Any]:
        """
        Navigate to http://localhost:8081/match.html on a clean state (without clicking Play),
        wait for background Wasm engine prewarming to reach ready===true, and capture prewarm metrics.
        """
        if self.prewarm_observation is not None and not force_fresh:
            return self.prewarm_observation

        self.ensure_browser_bridge()
        url = f"{self.base_url}/match.html"
        self.rpc(
            "goto",
            {
                "url": url,
                "clearLogs": True,
                "waitUntil": "domcontentloaded",
                "timeout": 45000,
            },
            timeout=60.0,
        )
        self.current_page_name = "match.html"

        obs = self.eval_js(
            """
            const start = Date.now();
            // Trigger or wait for background prewarming
            while (Date.now() - start < 75000) {
              const p = window.JKDemoPlayer || window.OpenJKPlayer;
              const pip = window.JKPiPPlayer;
              let mod = window.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
              if (!mod) {
                const iframes = document.querySelectorAll('iframe');
                for (const f of iframes) {
                  try {
                    if (f.contentWindow && f.contentWindow.Module) {
                      mod = f.contentWindow.Module;
                      break;
                    }
                  } catch (_) {}
                }
              }
              const st = p && typeof p.getStatus === 'function' ? p.getStatus() : (p && typeof p.getStats === 'function' ? p.getStats() : null);
              const isReady = (st && st.ready) || (mod && typeof mod._JK_DemoIsReady === 'function' && mod._JK_DemoIsReady() === 1) || (pip && typeof pip.getState === 'function' && pip.getState().ready);
              const playBtns = document.querySelectorAll('.jk-play-btn');
              if (isReady && playBtns.length > 0) {
                const card = document.querySelector('#jk-pip-card, #jk-player-pip');
                const cardStyle = card ? window.getComputedStyle(card) : null;
                const pipHidden = !card || cardStyle.display === 'none' || cardStyle.visibility === 'hidden' || cardStyle.opacity === '0' || card.hidden;
                const rangeReqs = (mod && typeof mod._JK_DemoGetPk3RangeRequests === 'function')
                  ? mod._JK_DemoGetPk3RangeRequests()
                  : (mod && typeof mod._JK_DemoGetPK3RangeRequests === 'function')
                  ? mod._JK_DemoGetPK3RangeRequests()
                  : (st && typeof st.pk3RangeRequests === 'number' ? st.pk3RangeRequests : 0);
                const bytesTransferred = (mod && typeof mod._JK_DemoGetPk3BytesTransferred === 'function')
                  ? mod._JK_DemoGetPk3BytesTransferred()
                  : (mod && typeof mod._JK_DemoGetPK3BytesTransferred === 'function')
                  ? mod._JK_DemoGetPK3BytesTransferred()
                  : (st && typeof st.pk3BytesTransferred === 'number' ? st.pk3BytesTransferred : 0);
                const loadedPacks = (mod && typeof mod._JK_DemoGetLoadedPackCount === 'function')
                  ? mod._JK_DemoGetLoadedPackCount()
                  : (st && typeof st.loadedPacks === 'number' ? st.loadedPacks : 4);
                const isMuted = (mod && typeof mod._JK_DemoIsMuted === 'function')
                  ? (mod._JK_DemoIsMuted() === 1)
                  : (p && typeof p.isMuted === 'function' ? p.isMuted() : true);
                const isPlaying = (mod && typeof mod._JK_DemoIsPlaying === 'function')
                  ? (mod._JK_DemoIsPlaying() === 1)
                  : Boolean(st && st.isPlaying);
                const v2Cache = localStorage.getItem('openjk_pk3_manifest_v2');
                return {
                  ready: true,
                  pipHidden,
                  rangeRequests: rangeReqs,
                  bytesTransferred,
                  loadedPacks,
                  isMuted,
                  isPlaying,
                  playBtnCount: playBtns.length,
                  hasV2Cache: Boolean(v2Cache),
                  v2CacheLen: v2Cache ? v2Cache.length : 0,
                  activeElementTag: document.activeElement ? document.activeElement.tagName : 'BODY',
                  pointerLock: Boolean(document.pointerLockElement),
                };
              }
              await new Promise(r => setTimeout(r, 200));
            }
            throw new Error('Timed out waiting for background prewarm and .jk-play-btn on match.html');
            """,
            timeout=85.0,
        )
        logs = self.get_browser_logs()
        obs["networkResponses"] = logs.get("networkResponses", [])
        obs["pageErrors"] = logs.get("pageErrors", [])
        self.prewarm_observation = obs
        return obs

    def ensure_page_loaded(
        self, page_path: str = "match.html", force_reload: bool = False
    ) -> Dict[str, Any]:
        """Ensure the specified archive page (match.html, index.html, aplayer2.html, debugplayer2.html) is loaded and decorated with .jk-play-btn."""
        self.ensure_browser_bridge()
        clean_path = page_path.lstrip("/")
        if self.current_page_name != clean_path or force_reload:
            url = f"{self.base_url}/{clean_path}"
            self.rpc(
                "goto",
                {
                    "url": url,
                    "clearLogs": True,
                    "waitUntil": "domcontentloaded",
                    "timeout": 45000,
                },
                timeout=60.0,
            )
            self.current_page_name = clean_path

        info = self.eval_js(
            """
            const start = Date.now();
            while (Date.now() - start < 45000) {
              const btns = document.querySelectorAll('.jk-play-btn');
              if (btns.length > 0) {
                const demoLinks = {
                  getdemo: document.querySelectorAll('a[href*="getdemo.php"]').length,
                  mergedemo: document.querySelectorAll('a[href*="mergedemo.php"]').length,
                  trimdemo: document.querySelectorAll('a[href*="trimdemo.php"]').length,
                  matchdemo: document.querySelectorAll('a[href*="rpc=matchdemo"]').length,
                  lookupPermalinks: document.querySelectorAll('a[href*="#rpc=lookup"]').length,
                };
                return {
                  url: window.location.href,
                  playBtnCount: btns.length,
                  demoLinks,
                };
              }
              await new Promise(r => setTimeout(r, 150));
            }
            throw new Error('Timed out waiting for .jk-play-btn on ' + window.location.href);
            """,
            timeout=50.0,
        )
        return info

    def ensure_pip_playing(
        self,
        page_path: str = "match.html",
        link_filter: str = "getdemo.php",
        force_reload_demo: bool = False,
    ) -> Dict[str, Any]:
        """
        Ensure the browser is on `page_path` ( capturing prewarm observation first if on match.html )
        and has clicked a `.jk-play-btn` matching `link_filter` so a demo is actively playing in the PiP pane.
        """
        if page_path.lstrip("/") == "match.html" and self.prewarm_observation is None:
            self.ensure_prewarm_observed()

        self.ensure_page_loaded(page_path)

        status = self.eval_js(
            """
            const filterStr = (arg && arg.linkFilter) || 'getdemo.php';
            const forceReload = Boolean(arg && arg.forceReload);

            function getEngineHandles() {
              let win = window;
              let p = win.JKDemoPlayer || win.OpenJKPlayer;
              let pip = win.JKPiPPlayer;
              let mod = win.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
              if (!mod) {
                const iframes = document.querySelectorAll('iframe');
                for (const f of iframes) {
                  try {
                    if (f.contentWindow && (f.contentWindow.Module || f.contentWindow.JKDemoPlayer || f.contentWindow.OpenJKPlayer)) {
                      win = f.contentWindow;
                      p = win.JKDemoPlayer || win.OpenJKPlayer || p;
                      mod = win.Module || (p && typeof p.getModule === 'function' ? p.getModule() : null);
                      break;
                    }
                  } catch (_) {}
                }
              }
              return { win, p, pip, mod };
            }

            let { p, pip, mod } = getEngineHandles();
            const card = document.querySelector('#jk-pip-card, #jk-player-pip');
            const cardVisible = card && window.getComputedStyle(card).display !== 'none' && window.getComputedStyle(card).visibility !== 'hidden' && !card.hidden;
            const currentlyPlaying = mod && typeof mod._JK_DemoIsPlaying === 'function'
              ? mod._JK_DemoIsPlaying() === 1
              : Boolean(p && typeof p.getStatus === 'function' && p.getStatus().isPlaying);

            if (!currentlyPlaying || !cardVisible || forceReload) {
              // Find a matching .jk-play-btn
              const btns = Array.from(document.querySelectorAll('.jk-play-btn'));
              let targetBtn = btns.find(b => {
                const u = b.getAttribute('data-demo-url') || (b.previousElementSibling && b.previousElementSibling.getAttribute('href')) || '';
                return u.includes(filterStr);
              }) || btns[0];
              if (!targetBtn) {
                throw new Error('No .jk-play-btn found matching ' + filterStr);
              }
              targetBtn.click();
            }

            const start = Date.now();
            while (Date.now() - start < 90000) {
              ({ p, pip, mod } = getEngineHandles());
              const isPlaying = (mod && typeof mod._JK_DemoIsPlaying === 'function' && mod._JK_DemoIsPlaying() === 1)
                || Boolean(p && typeof p.getStatus === 'function' && p.getStatus().isPlaying);
              const dur = (mod && typeof mod._JK_DemoGetDurationMs === 'function')
                ? mod._JK_DemoGetDurationMs()
                : (p && typeof p.getDurationMs === 'function' ? p.getDurationMs() : 0);
              if (isPlaying && dur > 0) {
                if (mod && typeof mod._JK_DemoIsPaused === 'function' && mod._JK_DemoIsPaused() === 1) {
                  mod._JK_DemoResume();
                } else if (p && typeof p.isPaused === 'function' && p.isPaused()) {
                  p.resume();
                }
                if (mod && typeof mod._JK_DemoSetSpeed === 'function') {
                  mod._JK_DemoSetSpeed(1.0);
                } else if (p && typeof p.setSpeed === 'function') {
                  p.setSpeed(1.0);
                }
                if (mod && typeof mod._JK_DemoSetLoop === 'function') {
                  mod._JK_DemoSetLoop(1);
                } else if (p && typeof p.setLoop === 'function') {
                  p.setLoop(true);
                }
                const cur = (mod && typeof mod._JK_DemoGetCurrentTimeMs === 'function')
                  ? mod._JK_DemoGetCurrentTimeMs()
                  : (p && typeof p.getCurrentTimeMs === 'function' ? p.getCurrentTimeMs() : 0);
                const startMs = (mod && typeof mod._JK_DemoGetStartTimeMs === 'function')
                  ? mod._JK_DemoGetStartTimeMs()
                  : (p && typeof p.getStartTimeMs === 'function' ? p.getStartTimeMs() : 0);
                const endMs = (mod && typeof mod._JK_DemoGetEndTimeMs === 'function')
                  ? mod._JK_DemoGetEndTimeMs()
                  : (p && typeof p.getEndTimeMs === 'function' ? p.getEndTimeMs() : 0);
                return {
                  isPlaying: true,
                  startTimeMs: startMs,
                  endTimeMs: endMs,
                  durationMs: dur,
                  currentTimeMs: cur,
                };
              }
              await new Promise(r => setTimeout(r, 150));
            }
            throw new Error('Timed out waiting for PiP demo playback to become active');
            """,
            {"linkFilter": link_filter, "forceReload": force_reload_demo},
            timeout=105.0,
        )
        return status

    def capture_canvas_screenshot(
        self, save_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Capture #jk-canvas as PNG via toDataURL, decode with Pillow/NumPy, and compute 3D scene metrics."""
        snap = self.rpc("canvas_screenshot", {"selector": "#jk-canvas"}, timeout=30.0)
        data_url: str = snap["dataUrl"]
        assert data_url.startswith(
            "data:image/png;base64,"
        ), "Invalid canvas PNG dataUrl prefix"
        png_bytes = base64.b64decode(data_url.split(",", 1)[1])

        if save_name:
            out_path = self.screenshot_dir / f"{save_name}.png"
            out_path.write_bytes(png_bytes)

        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        arr = np.asarray(img, dtype=np.uint8)
        h, w, _ = arr.shape
        rgb = arr[:, :, :3].astype(np.float32)
        alpha = arr[:, :, 3]

        mean_rgb = float(rgb.mean())
        std_rgb = float(rgb.std())
        non_black_mask = (arr[:, :, 0] > 8) | (arr[:, :, 1] > 8) | (arr[:, :, 2] > 8)
        non_black_ratio = float(non_black_mask.mean())

        cy0, cy1 = h // 4, (3 * h) // 4
        cx0, cx1 = w // 4, (3 * w) // 4
        center_rgb = rgb[cy0:cy1, cx0:cx1]
        center_std_rgb = float(center_rgb.std())

        sub = arr[::4, ::4, :3].reshape(-1, 3)
        packed = (
            (sub[:, 0].astype(np.uint32) << 16)
            | (sub[:, 1].astype(np.uint32) << 8)
            | sub[:, 2].astype(np.uint32)
        )
        unique_colors = int(np.unique(packed).size)

        return {
            "width": w,
            "height": h,
            "png_size": len(png_bytes),
            "mean_rgb": mean_rgb,
            "std_rgb": std_rgb,
            "center_std_rgb": center_std_rgb,
            "non_black_ratio": non_black_ratio,
            "unique_colors": unique_colors,
            "alpha_min": int(alpha.min()),
            "alpha_max": int(alpha.max()),
            "status": snap.get("status") or {},
            "rgb": rgb,
        }

    @staticmethod
    def compare_screenshots(
        snap_a: Dict[str, Any], snap_b: Dict[str, Any]
    ) -> Dict[str, float]:
        rgb_a = snap_a["rgb"]
        rgb_b = snap_b["rgb"]
        if rgb_a.shape != rgb_b.shape:
            # Resize snap_b to snap_a dimensions if viewport was resized
            img_b = Image.fromarray(rgb_b.astype(np.uint8)).resize(
                (rgb_a.shape[1], rgb_a.shape[0])
            )
            rgb_b = np.asarray(img_b, dtype=np.float32)
        diff = np.abs(rgb_a - rgb_b)
        mean_abs_diff = float(diff.mean())
        changed_pixels = float((diff.max(axis=2) > 5.0).mean())
        return {
            "mean_abs_diff": mean_abs_diff,
            "changed_pixel_ratio": changed_pixels,
        }
