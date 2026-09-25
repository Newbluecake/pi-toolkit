#!/usr/bin/env bash
# Experiment 6 Part B driver: all expert × arm × rep runs, ≤4 concurrent, skips finished ones.
set -uo pipefail
cd "$(dirname "$0")/../.."
{
  for rep in 1 2 3; do
    for arm in FULL TRIM; do echo "edoc$rep $arm $rep"; done
  done
  for ex in ec1 ec2; do for rep in 1 2 3; do for arm in FULL TRIM; do echo "$ex $arm $rep"; done; done; done
} | xargs -P 4 -L 1 bash -c 'timeout 720 npx tsx scripts/exp/exp6-part-b-run.ts "$0" "$1" "$2" 2>&1 | tail -3'
echo "spent: $(npx tsx scripts/exp/exp6-part-b-run.ts --spent)"
