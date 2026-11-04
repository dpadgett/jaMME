#!/usr/bin/env python3
import argparse
import json
import os
import re
import struct
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_WEB_DIR = os.path.join(DEFAULT_ROOT, "web")
DEFAULT_PK3_DIRS = ["/home/jkashared", "/home/dan/refresh/base", "/home/dan/.local/share/openjk/base"]
DEFAULT_DEMO_DIRS = ["/home/dan/DemoTools/DemoChanger", "/home/dan/.local/share/openjk/base/demos"]
CORE_PK3_NAMES = ["assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3", "ctf_kejim.pk3"]


class MetricsStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self.pk3_bytes_transferred = 0
            self.total_range_requests = 0
            self.per_archive_bytes = {}
            self.per_archive_requests = {}
            self.full_pk3_downloads = 0
            self.demo_requests = 0
            self.demo_bytes_transferred = 0

    def record_pk3_range(self, name: str, num_bytes: int):
        with self._lock:
            self.pk3_bytes_transferred += num_bytes
            self.total_range_requests += 1
            self.per_archive_bytes[name] = self.per_archive_bytes.get(name, 0) + num_bytes
            self.per_archive_requests[name] = self.per_archive_requests.get(name, 0) + 1

    def record_pk3_full(self, name: str, num_bytes: int):
        with self._lock:
            self.pk3_bytes_transferred += num_bytes
            self.full_pk3_downloads += 1
            self.per_archive_bytes[name] = self.per_archive_bytes.get(name, 0) + num_bytes

    def record_demo(self, num_bytes: int):
        with self._lock:
            self.demo_requests += 1
            self.demo_bytes_transferred += num_bytes

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "pk3BytesTransferred": self.pk3_bytes_transferred,
                "totalRangeRequests": self.total_range_requests,
                "pk3RangeRequests": self.total_range_requests,
                "perArchiveBytes": dict(self.per_archive_bytes),
                "perFileBytes": dict(self.per_archive_bytes),
                "perArchiveRequests": dict(self.per_archive_requests),
                "perFileRangeRequests": dict(self.per_archive_requests),
                "fullPk3Downloads": self.full_pk3_downloads,
                "pk3FullRequests": self.full_pk3_downloads,
                "demoRequests": self.demo_requests,
                "demoBytesTransferred": self.demo_bytes_transferred,
            }


def inspect_pk3_central_dir(filepath: str) -> dict:
    real_path = os.path.realpath(filepath)
    size = os.path.getsize(real_path)
    tail_len = min(size, 65558)
    with open(real_path, "rb") as f:
        f.seek(size - tail_len)
        tail = f.read(tail_len)
    idx = tail.rfind(b"PK\x05\x06")
    if idx != -1 and idx + 22 <= len(tail):
        _, _, _, _, entries, cd_size_hdr, cd_offset_hdr, _ = struct.unpack(
            "<4sHHHHIIH", tail[idx : idx + 22]
        )
        eocd_offset = (size - tail_len) + idx
        cd_offset = cd_offset_hdr
        cd_size = cd_size_hdr
    else:
        entries = 0
        eocd_offset = max(0, size - 22)
        cd_offset = max(0, size - tail_len)
        cd_size = size - cd_offset
    return {
        "name": os.path.basename(filepath),
        "size": size,
        "entries": entries,
        "cd_offset": cd_offset,
        "cd_size": cd_size,
        "tail_size": size - cd_offset,
        "eocd_offset": eocd_offset,
    }


def resolve_pk3_path(name: str, pk3_dirs: list) -> str:
    for d in pk3_dirs:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate):
            return os.path.realpath(candidate)
    return ""


def resolve_demo_path(name: str, demo_dirs: list) -> str:
    for d in demo_dirs:
        candidate = os.path.join(d, name)
        if os.path.isfile(candidate):
            return os.path.realpath(candidate)
        if not name.lower().endswith(".dm_26"):
            candidate_ext = os.path.join(d, name + ".dm_26")
            if os.path.isfile(candidate_ext):
                return os.path.realpath(candidate_ext)
    return ""


def build_manifest(pk3_dirs: list, demo_dirs: list) -> dict:
    pk3s = []
    seen_pk3s = set()
    for name in CORE_PK3_NAMES:
        resolved = resolve_pk3_path(name, pk3_dirs)
        if resolved and os.path.isfile(resolved):
            seen_pk3s.add(name.lower())
            info = inspect_pk3_central_dir(resolved)
            info["name"] = name
            pk3s.append(info)
    default_norm = {os.path.realpath(p) for p in DEFAULT_PK3_DIRS if os.path.exists(p)}
    for d in pk3_dirs:
        if os.path.isdir(d) and os.path.realpath(d) not in default_norm:
            for fname in sorted(os.listdir(d)):
                if fname.lower().endswith(".pk3") and fname.lower() not in seen_pk3s:
                    full = os.path.realpath(os.path.join(d, fname))
                    if os.path.isfile(full):
                        seen_pk3s.add(fname.lower())
                        info = inspect_pk3_central_dir(full)
                        info["name"] = fname
                        pk3s.append(info)

    demos_seen = set()
    demos = []
    for d in demo_dirs:
        if os.path.isdir(d):
            for fname in sorted(os.listdir(d)):
                if fname.lower().endswith(".dm_26") and fname not in demos_seen:
                    full = os.path.realpath(os.path.join(d, fname))
                    if os.path.isfile(full):
                        demos_seen.add(fname)
                        demos.append(
                            {
                                "name": fname,
                                "size": os.path.getsize(full),
                                "url": f"/demos/{fname}",
                            }
                        )
    return {"pk3s": pk3s, "demos": demos}


def is_safe_filename(name: str) -> bool:
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or ".." in name or "\x00" in name:
        return False
    return True


class OpenJKRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        import socket
        try:
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        super().setup()

    def log_message(self, format, *args):
        pass

    def _send_cors_and_common_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )

    def _send_json(self, status_code: int, payload: dict, head_only: bool = False):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self._send_cors_and_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_error_plain(
        self, status_code: int, message: str, extra_headers=None, head_only: bool = False
    ):
        body = message.encode("utf-8")
        self.send_response(status_code)
        self._send_cors_and_common_headers()
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_and_common_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        content_len = int(self.headers.get("Content-Length", "0") or "0")
        if content_len > 0:
            self.rfile.read(content_len)
        if path == "/api/metrics/reset":
            self.server.metrics.reset()
            self._send_json(200, self.server.metrics.snapshot())
        else:
            self._send_error_plain(404, "Not Found")

    def do_HEAD(self):
        self._handle_get_or_head(head_only=True)

    def do_GET(self):
        self._handle_get_or_head(head_only=False)

    def _handle_get_or_head(self, head_only: bool):
        parsed = urllib.parse.urlparse(self.path)
        raw_path = parsed.path
        path = urllib.parse.unquote(raw_path)

        if ".." in raw_path or ".." in path or "\\" in path:
            self._send_error_plain(404, "Not Found", head_only=head_only)
            return

        if path == "/api/metrics":
            self._send_json(200, self.server.metrics.snapshot(), head_only=head_only)
            return

        if path == "/api/metrics/reset":
            self.server.metrics.reset()
            self._send_json(200, self.server.metrics.snapshot(), head_only=head_only)
            return

        if path in ("/base/manifest.json", "/api/manifest"):
            self._send_json(200, self.server.manifest, head_only=head_only)
            return

        if path.startswith("/base/demos/") or path.startswith("/demos/"):
            prefix = "/base/demos/" if path.startswith("/base/demos/") else "/demos/"
            demo_name = path[len(prefix) :]
            if not is_safe_filename(demo_name):
                self._send_error_plain(404, "Not Found", head_only=head_only)
                return
            candidate = resolve_demo_path(demo_name, self.server.demo_dirs)
            if not candidate:
                self._send_error_plain(404, "Demo Not Found", head_only=head_only)
                return
            self._serve_file(
                candidate,
                "application/octet-stream",
                head_only=head_only,
                is_pk3=False,
                is_demo=True,
            )
            return

        if path.startswith("/base/"):
            rel_name = path[len("/base/") :]
            if not is_safe_filename(rel_name):
                self._send_error_plain(404, "Not Found", head_only=head_only)
                return
            candidate = resolve_pk3_path(rel_name, self.server.pk3_dirs)
            if not candidate:
                self._send_error_plain(404, "Asset Not Found", head_only=head_only)
                return
            is_pk3 = rel_name.lower().endswith(".pk3")
            self._serve_file(
                candidate,
                "application/octet-stream",
                head_only=head_only,
                is_pk3=is_pk3,
                pk3_name=rel_name,
            )
            return

        static_map = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/player.js": ("player.js", "application/javascript; charset=utf-8"),
            "/openjk.js": ("openjk.js", "application/javascript; charset=utf-8"),
            "/openjk.wasm": ("openjk.wasm", "application/wasm"),
            "/autoexec.cfg": ("autoexec.cfg", "text/plain; charset=utf-8"),
            "/jkplayer/autoexec.cfg": ("autoexec.cfg", "text/plain; charset=utf-8"),
        }
        if path in static_map:
            fname, content_type = static_map[path]
            fpath = os.path.join(self.server.web_dir, fname)
            if not os.path.isfile(fpath):
                self._send_error_plain(404, f"{fname} not found", head_only=head_only)
                return
            self._serve_file(fpath, content_type, head_only=head_only, is_pk3=False)
            return

        if path == "/favicon.ico":
            self.send_response(204)
            self._send_cors_and_common_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self._send_error_plain(404, "Not Found", head_only=head_only)

    def _serve_file(
        self,
        filepath: str,
        content_type: str,
        head_only: bool = False,
        is_pk3: bool = False,
        pk3_name: str = "",
        is_demo: bool = False,
    ):
        file_size = os.path.getsize(filepath)
        range_header = self.headers.get("Range")

        if range_header is not None:
            m = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
            if not m:
                self._send_error_plain(
                    416,
                    "Range Not Satisfiable",
                    extra_headers={
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes */{file_size}",
                    },
                    head_only=head_only,
                )
                return
            start_s, end_s = m.group(1), m.group(2)
            if start_s == "" and end_s == "":
                self._send_error_plain(
                    416,
                    "Range Not Satisfiable",
                    extra_headers={
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes */{file_size}",
                    },
                    head_only=head_only,
                )
                return
            if start_s == "":
                suffix_len = int(end_s)
                if suffix_len <= 0:
                    self._send_error_plain(
                        416,
                        "Range Not Satisfiable",
                        extra_headers={
                            "Accept-Ranges": "bytes",
                            "Content-Range": f"bytes */{file_size}",
                        },
                        head_only=head_only,
                    )
                    return
                start = max(0, file_size - suffix_len)
                end = file_size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s != "" else (file_size - 1)
                if start >= file_size or end < start:
                    self._send_error_plain(
                        416,
                        "Range Not Satisfiable",
                        extra_headers={
                            "Accept-Ranges": "bytes",
                            "Content-Range": f"bytes */{file_size}",
                        },
                        head_only=head_only,
                    )
                    return
                if end >= file_size:
                    end = file_size - 1

            content_len = (end - start) + 1
            if not head_only:
                if is_pk3:
                    self.server.metrics.record_pk3_range(pk3_name, content_len)
                elif is_demo:
                    self.server.metrics.record_demo(content_len)

            self.send_response(206)
            self._send_cors_and_common_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(content_len))
            self.end_headers()
            if not head_only:
                with open(filepath, "rb") as f:
                    f.seek(start)
                    remaining = content_len
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            return

        if not head_only:
            if is_pk3:
                self.server.metrics.record_pk3_full(pk3_name, file_size)
            elif is_demo:
                self.server.metrics.record_demo(file_size)

        self.send_response(200)
        self._send_cors_and_common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(file_size))
        self.end_headers()
        if not head_only:
            with open(filepath, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)


class OpenJKHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass, web_dir, pk3_dirs, demo_dirs):
        super().__init__(server_address, RequestHandlerClass)
        self.web_dir = web_dir
        self.pk3_dirs = pk3_dirs
        self.demo_dirs = demo_dirs
        self.metrics = MetricsStore()
        self.manifest = build_manifest(pk3_dirs, demo_dirs)


def main():
    parser = argparse.ArgumentParser(description="OpenJK WebAssembly HTTP Range & Demo Server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    parser.add_argument("--root", default=DEFAULT_ROOT, help="Project root directory")
    parser.add_argument("--web-dir", default=DEFAULT_WEB_DIR, help="Web assets directory")
    parser.add_argument("--assets-dir", default="", help="Additional .pk3 directory")
    parser.add_argument("--demos-dir", default="", help="Additional .dm_26 directory")
    args = parser.parse_args()

    pk3_dirs = ([args.assets_dir] if args.assets_dir else []) + DEFAULT_PK3_DIRS
    demo_dirs = ([args.demos_dir] if args.demos_dir else []) + DEFAULT_DEMO_DIRS

    httpd = OpenJKHTTPServer(
        (args.host, args.port),
        OpenJKRequestHandler,
        web_dir=args.web_dir,
        pk3_dirs=pk3_dirs,
        demo_dirs=demo_dirs,
    )
    print(f"OpenJK Web Server listening on http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
