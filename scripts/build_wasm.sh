#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build-wasm"
WEB_DIR="${ROOT_DIR}/web"

source /home/dan/emsdk/emsdk_env.sh >/dev/null 2>&1

emcmake cmake -B "${BUILD_DIR}" -S "${ROOT_DIR}" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBuildMPEngine=ON \
  -DBuildMPRdVanilla=ON \
  -DBuildMPCGame=ON \
  -DBuildMPUI=ON \
  -DBuildMPDed=OFF \
  -DBuildMPGame=OFF \
  -DBuildMPRend2=OFF \
  -DBuildSPEngine=OFF \
  -DBuildSPGame=OFF \
  -DBuildSPRdVanilla=OFF \
  -DUseInternalPNG=ON \
  -DUseInternalZlib=ON \
  -DUseInternalJPEG=ON

ninja -C "${BUILD_DIR}"

mkdir -p "${BUILD_DIR}/codemp" "${WEB_DIR}"
cp -f "${BUILD_DIR}/openjk.js" "${BUILD_DIR}/codemp/openjk.js"
cp -f "${BUILD_DIR}/openjk.wasm" "${BUILD_DIR}/codemp/openjk.wasm"
cp -f "${BUILD_DIR}/openjk.js" "${BUILD_DIR}/jamme.js"
cp -f "${BUILD_DIR}/openjk.wasm" "${BUILD_DIR}/jamme.wasm"
cp -f "${BUILD_DIR}/openjk.js" "${WEB_DIR}/openjk.js"
cp -f "${BUILD_DIR}/openjk.wasm" "${WEB_DIR}/openjk.wasm"
cp -f "${BUILD_DIR}/openjk.js" "${WEB_DIR}/jamme.js"
cp -f "${BUILD_DIR}/openjk.wasm" "${WEB_DIR}/jamme.wasm"
