#!/usr/bin/env python3
"""
Shared E2E Test Harness for OpenJK WebAssembly Multiplayer Demo Player (codemp).
Manages:
- Local HTTP Range & Telemetry Server (web/server.py)
- Persistent Headless Chrome 151 (Puppeteer) RPC session (browser_bridge.js)
- Screenshot decoding & pixel analysis (Pillow + NumPy)
- Binary inspection helpers (ELF64, WebAssembly binary format, ZIP Central Directory)
"""

import base64
import dataclasses
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

RPC_PREFIX = "__RPC_RES__"


@dataclasses.dataclass
class TestCase:
    test_id: str
    tier: int
    feature: str
    description: str
    fn: Callable[["E2ETestContext"], None]


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def inspect_zip_eocd(path: Path) -> Dict[str, int]:
    """Read the physical ZIP End-of-Central-Directory (EOCD) record from a .pk3 file."""
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
    return {
        "size": size,
        "entries": entries,
        "cd_offset": cd_offset,
        "cd_size": cd_size,
        "tail_size": size - cd_offset,
    }


def parse_wasm_sections(wasm_path: Path) -> List[Tuple[int, int]]:
    """Parse WebAssembly binary header and section (section_id, payload_len) tuples."""
    data = wasm_path.read_bytes()
    if len(data) < 8:
        raise ValueError("Wasm binary shorter than 8-byte header")
    if data[:4] != b"\x00asm":
        raise ValueError(f"Invalid Wasm magic: {data[:4]!r}")
    if data[4:8] != b"\x01\x00\x00\x00":
        raise ValueError(f"Invalid Wasm version: {data[4:8]!r}")

    offset = 8
    sections: List[Tuple[int, int]] = []
    n = len(data)
    while offset < n:
        sec_id = data[offset]
        offset += 1
        # Decode LEB128 u32 length
        sec_len = 0
        shift = 0
        while True:
            if offset >= n:
                raise ValueError("Truncated LEB128 in Wasm section header")
            b = data[offset]
            offset += 1
            sec_len |= (b & 0x7F) << shift
            if (b & 0x80) == 0:
                break
            shift += 7
        if offset + sec_len > n:
            raise ValueError(
                f"Section {sec_id} length {sec_len} exceeds file size {n} at offset {offset}"
            )
        sections.append((sec_id, sec_len))
        offset += sec_len

    if offset != n:
        raise ValueError(f"Wasm trailing bytes mismatch: offset={offset} != size={n}")
    return sections


class E2ETestContext:
    """Shared context managing server, headless browser, and cached build/boot observations."""

    def __init__(self, port: Optional[int] = None) -> None:
        self.root_dir = Path("/home/dan/OpenJK/jaMME")
        self.scripts_dir = self.root_dir / "scripts"
        self.build_native_dir = self.root_dir / "build-native"
        self.build_wasm_dir = self.root_dir / "build-wasm"
        self.web_dir = self.root_dir / "web"
        self.tests_dir = self.root_dir / "tests" / "e2e"
        self.pk3_base_dir = Path("/home/jkashared")
        self.pk3_refresh_dir = Path("/home/dan/refresh/base")
        self.demo_dir = Path("/home/dan/DemoTools/DemoChanger")
        self.screenshot_dir = Path("/tmp/openjk_e2e_screenshots")
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)

        self.port: int = port or find_free_port()
        self.base_url: str = f"http://127.0.0.1:{self.port}"
        self.server_proc: Optional[subprocess.Popen] = None
        self.bridge_proc: Optional[subprocess.Popen] = None
        self._rpc_id: int = 0

        self.booted: bool = False
        self.current_boot_demo: Optional[str] = None
        self.cold_boot_status: Optional[Dict[str, Any]] = None
        self.cold_boot_metrics: Optional[Dict[str, Any]] = None
        self.cold_boot_screenshots: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Lifecycle management
    # ------------------------------------------------------------------
    def ensure_server(self) -> str:
        """Start web/server.py if not already running and wait until it responds."""
        if self.server_proc is not None and self.server_proc.poll() is None:
            return self.base_url

        server_script = self.web_dir / "server.py"
        if not server_script.exists():
            raise FileNotFoundError(f"HTTP server script missing: {server_script}")

        self.server_proc = subprocess.Popen(
            [
                sys.executable,
                str(server_script),
                "--port",
                str(self.port),
                "--host",
                "127.0.0.1",
            ],
            cwd=str(self.root_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )

        deadline = time.time() + 15.0
        last_err = None
        while time.time() < deadline:
            if self.server_proc.poll() is not None:
                stderr_out = (
                    self.server_proc.stderr.read() if self.server_proc.stderr else ""
                )
                raise RuntimeError(
                    f"web/server.py exited prematurely with code {self.server_proc.returncode}: {stderr_out}"
                )
            try:
                status, _, _ = self.http_request("GET", "/api/metrics", timeout=2.0)
                if status == 200:
                    return self.base_url
            except Exception as e:
                last_err = e
            time.sleep(0.15)

        raise RuntimeError(
            f"Timed out waiting for web/server.py on {self.base_url} (last error: {last_err})"
        )

    def ensure_browser_bridge(self) -> None:
        """Start the persistent Node.js Puppeteer RPC bridge if not running."""
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
        """Send an RPC command to browser_bridge.js and return the result."""
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

        if self.server_proc is not None and self.server_proc.poll() is None:
            try:
                self.server_proc.terminate()
                self.server_proc.wait(timeout=3.0)
            except Exception:
                try:
                    self.server_proc.kill()
                except Exception:
                    pass
            self.server_proc = None

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------
    def http_request(
        self,
        method: str,
        path: str,
        headers: Optional[Dict[str, str]] = None,
        data: Optional[bytes] = None,
        timeout: float = 15.0,
    ) -> Tuple[int, Dict[str, str], bytes]:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status = resp.status
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read() if method != "HEAD" else b""
                return status, resp_headers, body
        except urllib.error.HTTPError as e:
            resp_headers = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
            body = e.read() if method != "HEAD" else b""
            return e.code, resp_headers, body

    def get_metrics(self) -> Dict[str, Any]:
        self.ensure_server()
        status, _, body = self.http_request("GET", "/api/metrics")
        assert status == 200, f"GET /api/metrics failed with HTTP {status}"
        return json.loads(body.decode("utf-8"))

    def reset_metrics(self) -> Dict[str, Any]:
        self.ensure_server()
        status, _, body = self.http_request("POST", "/api/metrics/reset", data=b"")
        if status not in (200, 204):
            status, _, body = self.http_request("GET", "/api/metrics/reset")
        assert status == 200, f"/api/metrics/reset failed with HTTP {status}"
        return json.loads(body.decode("utf-8"))

    # ------------------------------------------------------------------
    # Browser & Demo Player Helpers
    # ------------------------------------------------------------------
    def ensure_booted(
        self,
        demo: str = "1.51ef9.dm_26",
        query_extra: str = "",
        force_reload: bool = False,
    ) -> Dict[str, Any]:
        """Ensure headless Chrome has booted the OpenJK Wasm player and is playing a demo."""
        self.ensure_server()
        self.ensure_browser_bridge()

        if not self.booted or force_reload:
            is_first_cold_boot = not self.booted
            if is_first_cold_boot:
                self.reset_metrics()

            q = f"?demo={demo}"
            if query_extra:
                q += "&" + query_extra.lstrip("&?")
            url = f"{self.base_url}/index.html{q}"
            res = self.rpc(
                "goto",
                {
                    "url": url,
                    "clearLogs": True,
                    "waitForReady": True,
                    "requirePlaying": True,
                    "readyTimeout": 95000,
                },
                timeout=110.0,
            )
            status = res.get("status") or self.get_player_status()
            self.booted = True
            self.current_boot_demo = demo

            if is_first_cold_boot:
                # Let a few frames render and capture cold-boot metrics & initial screenshots
                snap1 = self.capture_canvas_screenshot("cold_boot_t0")
                time.sleep(0.55)
                snap2 = self.capture_canvas_screenshot("cold_boot_t1")
                self.cold_boot_status = self.get_player_status()
                self.cold_boot_metrics = self.get_metrics()
                self.cold_boot_screenshots = [snap1, snap2]
            return status

        # Already booted: ensure player is in a clean playing state
        status = self.get_player_status()
        target_short = demo[:-6] if demo.endswith(".dm_26") else demo
        target_short = target_short.split("/")[-1]
        cur_name = str(status.get("demoName") or "")
        cur_short = cur_name[:-6] if cur_name.endswith(".dm_26") else cur_name
        cur_short = cur_short.split("/")[-1]

        if not status.get("isPlaying") or (demo and cur_short.lower() != target_short.lower()):
            self.eval_js(
                """
                const p = window.JKDemoPlayer || window.OpenJKPlayer;
                p.setSpeed(1.0);
                await p.loadDemo(arg.demo);
                const start = Date.now();
                while (Date.now() - start < 30000) {
                  const st = p.getStatus();
                  if (st.isPlaying && st.serverTime > 0) return st;
                  await new Promise(r => setTimeout(r, 100));
                }
                return p.getStatus();
                """,
                {"demo": demo},
                timeout=45.0,
            )
            self.current_boot_demo = demo

        # Restore default unpaused, 1.0x speed state unless caller specifies otherwise
        self.eval_js(
            """
            const p = window.JKDemoPlayer || window.OpenJKPlayer;
            if (p.isPaused()) p.resume();
            if (Math.abs(p.getSpeed() - 1.0) > 0.01) p.setSpeed(1.0);
            return p.getStatus();
            """
        )
        return self.get_player_status()

    def eval_js(self, script: str, arg: Any = None, timeout: float = 60.0) -> Any:
        self.ensure_browser_bridge()
        return self.rpc("eval", {"script": script, "arg": arg}, timeout=timeout)

    def get_player_status(self) -> Dict[str, Any]:
        return self.eval_js(
            """
            const p = window.JKDemoPlayer || window.OpenJKPlayer;
            if (!p || typeof p.getStatus !== 'function') {
              throw new Error('window.JKDemoPlayer.getStatus is not available');
            }
            return p.getStatus();
            """
        )

    def get_browser_logs(self) -> Dict[str, Any]:
        self.ensure_browser_bridge()
        return self.rpc("get_logs")

    def capture_canvas_screenshot(
        self, save_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Capture #jk-canvas as PNG via toDataURL, decode with Pillow/NumPy, and compute metrics."""
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

        # Compute full-frame and center-crop statistics
        mean_rgb = float(rgb.mean())
        std_rgb = float(rgb.std())
        non_black_mask = (arr[:, :, 0] > 8) | (arr[:, :, 1] > 8) | (arr[:, :, 2] > 8)
        non_black_ratio = float(non_black_mask.mean())

        # Center 50% crop (excludes 2D HUD borders)
        cy0, cy1 = h // 4, (3 * h) // 4
        cx0, cx1 = w // 4, (3 * w) // 4
        center_rgb = rgb[cy0:cy1, cx0:cx1]
        center_std_rgb = float(center_rgb.std())

        # Subsample every 4th pixel for fast unique RGB color count
        sub = arr[::4, ::4, :3].reshape(-1, 3)
        packed = (
            (sub[:, 0].astype(np.uint32) << 16)
            | (sub[:, 1].astype(np.uint32) << 8)
            | sub[:, 2].astype(np.uint32)
        )
        unique_colors = int(np.unique(packed).size)

        # Quadrant std devs to verify full-viewport rendering
        q_tl = float(rgb[: h // 2, : w // 2].std())
        q_tr = float(rgb[: h // 2, w // 2 :].std())
        q_bl = float(rgb[h // 2 :, : w // 2].std())
        q_br = float(rgb[h // 2 :, w // 2 :].std())

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
            "quadrant_stds": (q_tl, q_tr, q_bl, q_br),
            "status": snap.get("status") or {},
            "rgb": rgb,
        }

    @staticmethod
    def compare_screenshots(
        snap_a: Dict[str, Any], snap_b: Dict[str, Any]
    ) -> Dict[str, float]:
        """Compute pixel-wise difference metrics between two captured screenshots."""
        rgb_a = snap_a["rgb"]
        rgb_b = snap_b["rgb"]
        assert (
            rgb_a.shape == rgb_b.shape
        ), f"Screenshot shape mismatch: {rgb_a.shape} vs {rgb_b.shape}"
        diff = np.abs(rgb_a - rgb_b)
        mean_abs_diff = float(diff.mean())
        changed_pixels = float((diff.max(axis=2) > 5.0).mean())
        return {
            "mean_abs_diff": mean_abs_diff,
            "changed_pixel_ratio": changed_pixels,
        }

    def run_short_demo_to_completion(
        self, packet_count: int = 12
    ) -> Dict[str, Any]:
        """
        Synthesize a valid short .dm_26 stream in the page by slicing the first
        `packet_count` messages (svc_gamestate + initial snapshots) of 1.51ef9.dm_26
        and appending the 8-byte (-1, -1) EOF marker, then play it via
        JKDemoPlayer.loadDemo('short_e2e.dm_26') and verify CL_DemoCompleted fires
        both onDemoComplete callbacks and window 'jkdemo:ended' / 'jkdemo:complete' events.
        """
        self.ensure_booted("1.51ef9.dm_26")
        res = self.eval_js(
            """
            const player = window.JKDemoPlayer || window.OpenJKPlayer;
            const pktLimit = (arg && arg.packetCount) || 12;

            // Fetch real 1.51ef9.dm_26 bytes and slice after pktLimit messages
            if (!window.__shortDemoBytes) {
              const resp = await fetch('/demos/1.51ef9.dm_26');
              const fullBuf = await resp.arrayBuffer();
              const view = new DataView(fullBuf);
              let offset = 0;
              for (let i = 0; i < pktLimit && offset + 8 <= fullBuf.byteLength; i++) {
                const cursize = view.getInt32(offset + 4, true);
                if (cursize < 0 || offset + 8 + cursize > fullBuf.byteLength) break;
                offset += 8 + cursize;
              }
              const shortBuf = new Uint8Array(offset + 8);
              shortBuf.set(new Uint8Array(fullBuf, 0, offset), 0);
              const tailView = new DataView(shortBuf.buffer, offset, 8);
              tailView.setInt32(0, -1, true);
              tailView.setInt32(4, -1, true);
              window.__shortDemoBytes = shortBuf;

              // Intercept fetch for short_e2e.dm_26 so loadDemo('short_e2e.dm_26') receives it
              const origFetch = window.fetch.bind(window);
              window.fetch = async function(input, init) {
                const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
                if (urlStr.includes('short_e2e')) {
                  return new Response(window.__shortDemoBytes.slice(0), {
                    status: 200,
                    headers: { 'Content-Type': 'application/octet-stream' }
                  });
                }
                return origFetch(input, init);
              };
            }

            const events = {
              callbacks: [],
              endedEvents: [],
              completeEvents: [],
            };

            const cb1 = (detail) => events.callbacks.push({ listener: 1, detail });
            const cb2 = (detail) => events.callbacks.push({ listener: 2, detail });
            if (typeof player.onDemoComplete === 'function') {
              player.onDemoComplete(cb1);
            }
            if (typeof player.onDemoEnded === 'function') {
              player.onDemoEnded(cb2);
            } else if (typeof player.onDemoComplete === 'function') {
              player.onDemoComplete(cb2);
            }

            const onEndedDom = (ev) => events.endedEvents.push(ev.detail || {});
            const onCompleteDom = (ev) => events.completeEvents.push(ev.detail || {});
            window.addEventListener('jkdemo:ended', onEndedDom, { once: true });
            window.addEventListener('jkdemo:complete', onCompleteDom, { once: true });

            const beforeStatus = player.getStatus();
            player.setSpeed(4.0);
            const loadOk = await player.loadDemo('short_e2e.dm_26');

            const start = Date.now();
            while (Date.now() - start < 15000) {
              const st = player.getStatus();
              if (
                events.callbacks.length > 0 ||
                events.endedEvents.length > 0 ||
                st.demoEnded ||
                (st.demoCompletedCount || 0) > (beforeStatus.demoCompletedCount || 0)
              ) {
                break;
              }
              await new Promise(r => setTimeout(r, 60));
            }

            player.setSpeed(1.0);
            const afterStatus = player.getStatus();
            return {
              loadOk,
              beforeStatus,
              afterStatus,
              callbacksCount: events.callbacks.length,
              callbacks: events.callbacks,
              endedEventsCount: events.endedEvents.length,
              endedEvents: events.endedEvents,
              completeEventsCount: events.completeEvents.length,
            };
            """,
            {"packetCount": packet_count},
            timeout=30.0,
        )
        return res
