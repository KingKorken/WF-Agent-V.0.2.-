#!/bin/bash
# Build script for native Swift recorder binaries.
# Run from repo root: bash local-agent/src/recorder/native/build.sh
# Or from this directory: bash build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../../../bin"
SDK="$(xcrun --show-sdk-path)"

mkdir -p "$BIN_DIR"

echo "Compiling event-monitor..."
swiftc -O -sdk "$SDK" "$SCRIPT_DIR/event-monitor.swift" -o "$BIN_DIR/event-monitor-darwin"
echo "  → $BIN_DIR/event-monitor-darwin"

echo "Compiling audio-recorder..."
swiftc -O -sdk "$SDK" "$SCRIPT_DIR/audio-recorder.swift" -o "$BIN_DIR/audio-recorder-darwin"
echo "  → $BIN_DIR/audio-recorder-darwin"

chmod +x "$BIN_DIR/event-monitor-darwin" "$BIN_DIR/audio-recorder-darwin"

echo ""
echo "Done. Binaries:"
ls -lh "$BIN_DIR/"
