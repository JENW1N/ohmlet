#!/bin/bash
# Post-convergence one-shot: re-record interactive scenes on an idle GPU,
# then assemble the final cut.
set -e
cd "$(dirname "$0")/.."
echo "=== re-recording interactive scenes"
node demo/record-scenes.mjs live_reveal build wires run_blink scope ai bench date_orbit lens 2>&1 | grep -E "recording|MARK|scene|FAILED"
echo "=== assembling"
python3 demo/assemble.py
echo "=== done"
