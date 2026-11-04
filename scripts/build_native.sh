#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build-native"

cmake -B "${BUILD_DIR}" -S "${ROOT_DIR}" -GNinja \
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
  -DUseInternalJPEG=ON \
  -DSDL2_INCLUDE_DIR="${ROOT_DIR}/lib/SDL2/include" \
  -DSDL2_INCLUDE_DIRS="${ROOT_DIR}/lib/SDL2/include" \
  -DSDL2_LIBRARY="/usr/lib/x86_64-linux-gnu/libSDL2-2.0.so.0" \
  -DSDL2_LIBRARIES="/usr/lib/x86_64-linux-gnu/libSDL2-2.0.so.0"

ninja -C "${BUILD_DIR}"

mkdir -p "${BUILD_DIR}/codemp"
if [ -f "${BUILD_DIR}/jamme" ]; then
  cp -f "${BUILD_DIR}/jamme" "${BUILD_DIR}/jamme.x86_64"
fi
if [ -f "${BUILD_DIR}/jamme.x86_64" ]; then
  cp -f "${BUILD_DIR}/jamme.x86_64" "${BUILD_DIR}/openjk.x86_64"
  cp -f "${BUILD_DIR}/jamme.x86_64" "${BUILD_DIR}/codemp/jamme.x86_64"
fi
cp -f "${BUILD_DIR}/openjk.x86_64" "${BUILD_DIR}/codemp/openjk.x86_64"
cp -f "${BUILD_DIR}/codemp/rd-vanilla/"*rd-*.so "${BUILD_DIR}/codemp/" 2>/dev/null || true
cp -f "${BUILD_DIR}/codemp/cgame/"*cgame*.so "${BUILD_DIR}/codemp/" 2>/dev/null || true
cp -f "${BUILD_DIR}/codemp/ui/"*ui*.so "${BUILD_DIR}/codemp/" 2>/dev/null || true
