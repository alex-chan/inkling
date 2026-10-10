#!/bin/sh
# 打包 Chrome Web Store 上传用的 zip：manifest.json 位于 zip 根目录
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")
OUT="dist/inkling-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
(cd extension && zip -r -X -q "../$OUT" . -x '*.DS_Store' -x '.*')
echo "$OUT ($(du -h "$OUT" | cut -f1))"
