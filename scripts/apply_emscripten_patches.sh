#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="${ROOT_DIR}/.emsdk-version"
EXPECTED_VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
PATCH_FILE="${ROOT_DIR}/patches/emscripten-${EXPECTED_VERSION}-gl.patch"

MODE="apply"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ "${1:-}" == "--revert" ]]; then
  MODE="revert"
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--check | --revert]" >&2
  exit 2
fi

resolve_em_root() {
  if [[ -n "${EMSCRIPTEN_ROOT:-}" && -f "${EMSCRIPTEN_ROOT}/emscripten-version.txt" ]]; then
    echo "${EMSCRIPTEN_ROOT}"
    return 0
  fi
  if command -v emcc >/dev/null 2>&1; then
    local emcc_dir
    emcc_dir="$(cd "$(dirname "$(readlink -f "$(command -v emcc)")")" && pwd)"
    if [[ -f "${emcc_dir}/emscripten-version.txt" ]]; then
      echo "${emcc_dir}"
      return 0
    fi
  fi
  local sdk_dir="${EMSDK:-/home/dan/emsdk}"
  if [[ -f "${sdk_dir}/upstream/emscripten/emscripten-version.txt" ]]; then
    echo "${sdk_dir}/upstream/emscripten"
    return 0
  fi
  return 1
}

if ! EM_ROOT="$(resolve_em_root)"; then
  echo "[emscripten-patches] ERROR: Could not locate Emscripten installation." >&2
  echo "  Install/activate Emscripten ${EXPECTED_VERSION} via emsdk, or set EMSDK / EMSCRIPTEN_ROOT." >&2
  exit 1
fi

ACTUAL_VERSION="$(tr -d '"[:space:]' < "${EM_ROOT}/emscripten-version.txt")"
if [[ "${ACTUAL_VERSION}" != "${EXPECTED_VERSION}" ]]; then
  if [[ "${ALLOW_EMSDK_VERSION_MISMATCH:-0}" != "1" ]]; then
    echo "[emscripten-patches] ERROR: Emscripten version mismatch at ${EM_ROOT}" >&2
    echo "  Expected: ${EXPECTED_VERSION} (from .emsdk-version)" >&2
    echo "  Found:    ${ACTUAL_VERSION}" >&2
    echo "  Run: emsdk install ${EXPECTED_VERSION} && emsdk activate ${EXPECTED_VERSION}" >&2
    echo "  (Or set ALLOW_EMSDK_VERSION_MISMATCH=1 to attempt patching anyway.)" >&2
    exit 1
  fi
  echo "[emscripten-patches] WARNING: Attempting ${EXPECTED_VERSION} patch on Emscripten ${ACTUAL_VERSION}..." >&2
fi

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "[emscripten-patches] ERROR: Missing patch file ${PATCH_FILE}" >&2
  exit 1
fi

is_applied() {
  patch -d "${EM_ROOT}" -p1 -R --forward --dry-run --batch --silent -i "${PATCH_FILE}" >/dev/null 2>&1
}

case "${MODE}" in
  check)
    if is_applied; then
      echo "[emscripten-patches] OK: $(basename "${PATCH_FILE}") is applied at ${EM_ROOT} (v${ACTUAL_VERSION})."
      exit 0
    else
      echo "[emscripten-patches] MISSING: $(basename "${PATCH_FILE}") is NOT applied at ${EM_ROOT}." >&2
      echo "  Run: ${ROOT_DIR}/scripts/apply_emscripten_patches.sh" >&2
      exit 1
    fi
    ;;
  revert)
    if ! is_applied; then
      echo "[emscripten-patches] Already unpatched at ${EM_ROOT}."
      exit 0
    fi
    patch -d "${EM_ROOT}" -p1 -R --forward --batch -i "${PATCH_FILE}"
    echo "[emscripten-patches] Reverted $(basename "${PATCH_FILE}") at ${EM_ROOT}."
    ;;
  apply)
    if is_applied; then
      echo "[emscripten-patches] OK: $(basename "${PATCH_FILE}") already applied (Emscripten ${ACTUAL_VERSION})."
      exit 0
    fi
    if ! patch -d "${EM_ROOT}" -p1 --forward --dry-run --batch -i "${PATCH_FILE}" >/dev/null 2>&1; then
      echo "[emscripten-patches] ERROR: Patch dry-run failed against ${EM_ROOT} (Emscripten ${ACTUAL_VERSION})." >&2
      patch -d "${EM_ROOT}" -p1 --forward --dry-run --batch -i "${PATCH_FILE}" || true
      exit 1
    fi
    patch -d "${EM_ROOT}" -p1 --forward --batch -i "${PATCH_FILE}"
    echo "[emscripten-patches] Applied $(basename "${PATCH_FILE}") to ${EM_ROOT} (Emscripten ${ACTUAL_VERSION})."
    ;;
esac
