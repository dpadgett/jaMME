#!/usr/bin/env python3
"""
Consolidate all unique valid ZIP/PK3 archives across the 5 JKA source directories
into /media/dan/Elements/pk3/base/ and generate /media/dan/Elements/pk3/base/manifest.json.
"""

import json
import os
import re
import shutil
import struct
import sys
import zipfile
from typing import Dict, List, Optional, Tuple


SOURCE_DIRS = [
    "/home/jkashared",
    "/home/dan/refresh/base",
    "/home/dan/whoracle/home/whoracle/base",
    "/home/dan/whoracle/home/whoracle/base_backup",
    "/media/dan/Elements/pk3/DriveC",
    "/media/dan/Elements/pk3/DriveD",
    "/media/dan/Elements/pk3/m0n573r",
    "/media/dan/Elements/pk3/m0n573rii",
    "/media/dan/Elements/pk3/MyGames",
]

OUTPUT_DIR = "/media/dan/Elements/pk3/base"
MANIFEST_PATH = os.path.join(OUTPUT_DIR, "manifest.json")

BASE_INIT_NAMES = {"assets0.pk3", "assets1.pk3", "assets2.pk3", "assets3.pk3"}
EXPECTED_BASE_CHECKSUMS = {
    "assets0.pk3": 1767559464,
    "assets1.pk3": -682941524,
    "assets2.pk3": -1239421272,
    "assets3.pk3": -1342311474,
}


def _lshift(x: int, s: int) -> int:
    x &= 0xFFFFFFFF
    return ((x << s) | (x >> (32 - s))) & 0xFFFFFFFF


def _mdfour64(M: Tuple[int, ...], A: int, B: int, C: int, D: int) -> Tuple[int, int, int, int]:
    AA, BB, CC, DD = A, B, C, D

    # Round 1
    for a_idx, b_idx, c_idx, d_idx, k, s in (
        (0, 1, 2, 3, 0, 3), (3, 0, 1, 2, 1, 7), (2, 3, 0, 1, 2, 11), (1, 2, 3, 0, 3, 19),
        (0, 1, 2, 3, 4, 3), (3, 0, 1, 2, 5, 7), (2, 3, 0, 1, 6, 11), (1, 2, 3, 0, 7, 19),
        (0, 1, 2, 3, 8, 3), (3, 0, 1, 2, 9, 7), (2, 3, 0, 1, 10, 11), (1, 2, 3, 0, 11, 19),
        (0, 1, 2, 3, 12, 3), (3, 0, 1, 2, 13, 7), (2, 3, 0, 1, 14, 11), (1, 2, 3, 0, 15, 19),
    ):
        st = [A, B, C, D]
        f_val = ((st[b_idx] & st[c_idx]) | ((~st[b_idx] & 0xFFFFFFFF) & st[d_idx])) & 0xFFFFFFFF
        st[a_idx] = _lshift((st[a_idx] + f_val + M[k]) & 0xFFFFFFFF, s)
        A, B, C, D = st

    # Round 2
    for a_idx, b_idx, c_idx, d_idx, k, s in (
        (0, 1, 2, 3, 0, 3), (3, 0, 1, 2, 4, 5), (2, 3, 0, 1, 8, 9), (1, 2, 3, 0, 12, 13),
        (0, 1, 2, 3, 1, 3), (3, 0, 1, 2, 5, 5), (2, 3, 0, 1, 9, 9), (1, 2, 3, 0, 13, 13),
        (0, 1, 2, 3, 2, 3), (3, 0, 1, 2, 6, 5), (2, 3, 0, 1, 10, 9), (1, 2, 3, 0, 14, 13),
        (0, 1, 2, 3, 3, 3), (3, 0, 1, 2, 7, 5), (2, 3, 0, 1, 11, 9), (1, 2, 3, 0, 15, 13),
    ):
        st = [A, B, C, D]
        g_val = ((st[b_idx] & st[c_idx]) | (st[b_idx] & st[d_idx]) | (st[c_idx] & st[d_idx])) & 0xFFFFFFFF
        st[a_idx] = _lshift((st[a_idx] + g_val + M[k] + 0x5A827999) & 0xFFFFFFFF, s)
        A, B, C, D = st

    # Round 3
    for a_idx, b_idx, c_idx, d_idx, k, s in (
        (0, 1, 2, 3, 0, 3), (3, 0, 1, 2, 8, 9), (2, 3, 0, 1, 4, 11), (1, 2, 3, 0, 12, 15),
        (0, 1, 2, 3, 2, 3), (3, 0, 1, 2, 10, 9), (2, 3, 0, 1, 6, 11), (1, 2, 3, 0, 14, 15),
        (0, 1, 2, 3, 1, 3), (3, 0, 1, 2, 9, 9), (2, 3, 0, 1, 5, 11), (1, 2, 3, 0, 13, 15),
        (0, 1, 2, 3, 3, 3), (3, 0, 1, 2, 11, 9), (2, 3, 0, 1, 7, 11), (1, 2, 3, 0, 15, 15),
    ):
        st = [A, B, C, D]
        h_val = (st[b_idx] ^ st[c_idx] ^ st[d_idx]) & 0xFFFFFFFF
        st[a_idx] = _lshift((st[a_idx] + h_val + M[k] + 0x6ED9EBA1) & 0xFFFFFFFF, s)
        A, B, C, D = st

    A = (A + AA) & 0xFFFFFFFF
    B = (B + BB) & 0xFFFFFFFF
    C = (C + CC) & 0xFFFFFFFF
    D = (D + DD) & 0xFFFFFFFF
    return A, B, C, D


def com_block_checksum(buffer: bytes) -> int:
    """
    Exact Python implementation of OpenJK's Com_BlockChecksum (codemp/qcommon/md4.cpp),
    returning a signed 32-bit integer matching FS_LoadZipFile pack->checksum.
    """
    A, B, C, D = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476
    totalN = 0
    n = len(buffer)
    offset = 0

    def mdfour_tail(tail_bytes: bytes, tail_len: int) -> None:
        nonlocal A, B, C, D, totalN
        totalN = (totalN + tail_len) & 0xFFFFFFFF
        b = (totalN * 8) & 0xFFFFFFFF
        buf = bytearray(128)
        if tail_len:
            buf[:tail_len] = tail_bytes[:tail_len]
        buf[tail_len] = 0x80
        if tail_len <= 55:
            struct.pack_into("<I", buf, 56, b)
            M = struct.unpack_from("<16I", buf, 0)
            A, B, C, D = _mdfour64(M, A, B, C, D)
        else:
            struct.pack_into("<I", buf, 120, b)
            M1 = struct.unpack_from("<16I", buf, 0)
            A, B, C, D = _mdfour64(M1, A, B, C, D)
            M2 = struct.unpack_from("<16I", buf, 64)
            A, B, C, D = _mdfour64(M2, A, B, C, D)

    if n == 0:
        mdfour_tail(b"", 0)

    while n >= 64:
        M = struct.unpack_from("<16I", buffer, offset)
        A, B, C, D = _mdfour64(M, A, B, C, D)
        offset += 64
        n -= 64
        totalN = (totalN + 64) & 0xFFFFFFFF

    mdfour_tail(buffer[offset : offset + n], n)

    val_u32 = (A ^ B ^ C ^ D) & 0xFFFFFFFF
    return struct.unpack("<i", struct.pack("<I", val_u32))[0]


def extract_canonical_basename(filename: str) -> str:
    return re.sub(r"\.(?:dis_)?pk_?3?.*$", "", filename, flags=re.I).lower()


def inspect_pk3_archive(filepath: str) -> Optional[dict]:
    try:
        real_path = os.path.realpath(filepath)
        if not os.path.isfile(real_path):
            return None
        size = os.path.getsize(real_path)
        if size <= 0 or not zipfile.is_zipfile(real_path):
            return None

        with zipfile.ZipFile(real_path, "r") as zf:
            infos = zf.infolist()
            crcs = [info.CRC & 0xFFFFFFFF for info in infos if info.file_size > 0]
            maps: List[str] = []
            maps_seen = set()
            for info in infos:
                norm_name = info.filename.replace("\\", "/").lower()
                if norm_name.startswith("maps/") and norm_name.endswith(".bsp") and info.file_size > 0:
                    rel_map = norm_name[len("maps/") : -len(".bsp")]
                    if rel_map and rel_map not in maps_seen:
                        maps_seen.add(rel_map)
                        maps.append(rel_map)
                    leaf_map = rel_map.split("/")[-1]
                    if leaf_map and leaf_map not in maps_seen:
                        maps_seen.add(leaf_map)
                        maps.append(leaf_map)

        crc_buf = struct.pack(f"<{len(crcs)}I", *crcs) if crcs else b""
        checksum = com_block_checksum(crc_buf)

        tail_len = min(size, 65558)
        with open(real_path, "rb") as f:
            f.seek(size - tail_len)
            tail = f.read(tail_len)
        idx = tail.rfind(b"PK\x05\x06")
        if idx != -1 and idx + 22 <= len(tail):
            _, _, _, _, _, cd_size_hdr, cd_offset_hdr, _ = struct.unpack(
                "<4sHHHHIIH", tail[idx : idx + 22]
            )
            cd_offset = int(cd_offset_hdr)
            cd_size = int(size - cd_offset)
        else:
            cd_offset = max(0, size - tail_len)
            cd_size = int(size - cd_offset)

        if cd_offset < 0 or cd_offset >= size or cd_size <= 0:
            cd_offset = max(0, size - min(size, 65558))
            cd_size = int(size - cd_offset)

        return {
            "source_path": real_path,
            "size": int(size),
            "checksum": int(checksum),
            "cd_offset": int(cd_offset),
            "cd_size": int(cd_size),
            "maps": maps,
        }
    except Exception as exc:
        print(f"[WARN] Skipping unreadable archive {filepath}: {exc}", file=sys.stderr)
        return None


def main() -> int:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_dev = os.stat(OUTPUT_DIR).st_dev

    # Track unique (basename, checksum) pairs and primary version per basename
    seen_pairs = set()
    seen_basenames: Dict[str, int] = {}
    same_dev_by_sig: Dict[Tuple[int, int], str] = {}
    records: List[dict] = []

    for src_dir in SOURCE_DIRS:
        if not os.path.isdir(src_dir):
            continue
        entries = sorted(os.listdir(src_dir), key=lambda s: s.lower())
        for fname in entries:
            full_path = os.path.join(src_dir, fname)
            if os.path.isdir(full_path):
                continue
            # Check if filename looks like a pk3 or tweaked pk3 candidate, or any zip in the pk3 dirs
            if not re.search(r"\.(?:dis_)?pk_?3?", fname, flags=re.I):
                continue
            info = inspect_pk3_archive(full_path)
            if info is None:
                continue

            try:
                if os.stat(info["source_path"]).st_dev == out_dev:
                    same_dev_by_sig.setdefault((info["size"], info["checksum"]), info["source_path"])
            except OSError:
                pass

            basename = extract_canonical_basename(fname)
            if not basename:
                continue

            pair_key = (basename, info["checksum"])
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            if basename not in seen_basenames:
                seen_basenames[basename] = info["checksum"]
                out_name = f"{basename}.pk3"
            else:
                hex_sum = f"{info['checksum'] & 0xFFFFFFFF:08x}"
                out_name = f"{basename}.{hex_sum}.pk3"

            base_init = out_name in BASE_INIT_NAMES
            records.append(
                {
                    "name": out_name,
                    "basename": basename,
                    "checksum": info["checksum"],
                    "size": info["size"],
                    "cd_offset": info["cd_offset"],
                    "cd_size": info["cd_size"],
                    "base_init": base_init,
                    "maps": info["maps"],
                    "_source_path": info["source_path"],
                }
            )

    # Verify base_init checksums before writing
    by_name = {r["name"]: r for r in records}
    for req_name, exp_sum in EXPECTED_BASE_CHECKSUMS.items():
        if req_name not in by_name:
            raise RuntimeError(f"Missing required base asset {req_name}")
        actual_sum = by_name[req_name]["checksum"]
        if actual_sum != exp_sum:
            raise RuntimeError(
                f"Checksum mismatch for {req_name}: got {actual_sum}, expected {exp_sum}"
            )

    # Consolidate files into OUTPUT_DIR
    manifest_entries: List[dict] = []
    expected_filenames = {r["name"] for r in records} | {"manifest.json"}

    # Clean up any stale files in OUTPUT_DIR not in expected_filenames
    for existing in os.listdir(OUTPUT_DIR):
        if existing not in expected_filenames:
            try:
                os.unlink(os.path.join(OUTPUT_DIR, existing))
            except OSError:
                pass

    linked_count = 0
    copied_count = 0
    reused_count = 0

    for rec in records:
        dst_path = os.path.join(OUTPUT_DIR, rec["name"])
        src_path = rec["_source_path"]
        sig = (rec["size"], rec["checksum"])
        same_dev_src = same_dev_by_sig.get(sig)

        need_write = True
        if os.path.isfile(dst_path) and not os.path.islink(dst_path):
            try:
                if os.path.getsize(dst_path) == rec["size"]:
                    need_write = False
                    reused_count += 1
            except OSError:
                need_write = True

        if need_write:
            if os.path.lexists(dst_path):
                os.unlink(dst_path)
            link_candidate = same_dev_src or src_path
            linked = False
            try:
                if os.stat(link_candidate).st_dev == out_dev:
                    os.link(link_candidate, dst_path)
                    linked = True
                    linked_count += 1
            except OSError:
                linked = False
            if not linked:
                shutil.copy2(src_path, dst_path)
                copied_count += 1

        manifest_entries.append(
            {
                "name": rec["name"],
                "basename": rec["basename"],
                "checksum": rec["checksum"],
                "size": rec["size"],
                "cd_offset": rec["cd_offset"],
                "cd_size": rec["cd_size"],
                "base_init": rec["base_init"],
                "maps": rec["maps"],
            }
        )

    manifest_data = {
        "version": 2,
        "pk3s": manifest_entries,
    }
    tmp_manifest = MANIFEST_PATH + ".tmp"
    with open(tmp_manifest, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)
    os.replace(tmp_manifest, MANIFEST_PATH)

    print(
        f"Consolidated {len(manifest_entries)} unique PK3 versions across {len(seen_basenames)} basenames "
        f"into {OUTPUT_DIR} (linked={linked_count}, copied={copied_count}, reused={reused_count})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
