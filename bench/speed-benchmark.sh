#!/bin/bash
# AgentDoc Speed Benchmark
# Measures P95 latency across 5 runs for: list, load, write
# Outputs a single composite number (total P95 ms, lower is better)

set -euo pipefail

BASE_URL="${AGENTDOC_BENCH_URL:-https://agentdoc.up.railway.app}"
PUBLIC_SLUG="f1ivgc8m"  # Geogemma doc (public, always accessible)
RUNS=5
HEADERS='-H "x-agentdoc-client-version: 0.30.0" -H "x-agentdoc-client-build: bench" -H "x-agentdoc-client-protocol: 3"'

declare -a list_times load_times

# Measure document list
for i in $(seq 1 $RUNS); do
  t=$(curl -s -o /dev/null -w "%{time_total}" --compressed "$BASE_URL/documents" \
    -H "x-agentdoc-client-version: 0.30.0" \
    -H "x-agentdoc-client-build: bench" \
    -H "x-agentdoc-client-protocol: 3" 2>/dev/null)
  ms=$(echo "$t * 1000" | bc | cut -d. -f1)
  list_times+=($ms)
done

# Measure document load (state endpoint)
for i in $(seq 1 $RUNS); do
  t=$(curl -s -o /dev/null -w "%{time_total}" --compressed "$BASE_URL/documents/$PUBLIC_SLUG/state" \
    -H "x-agentdoc-client-version: 0.30.0" \
    -H "x-agentdoc-client-build: bench" \
    -H "x-agentdoc-client-protocol: 3" 2>/dev/null)
  ms=$(echo "$t * 1000" | bc | cut -d. -f1)
  load_times+=($ms)
done

# P95 = max of 5 runs (with 5 samples, P95 ≈ max)
p95_list=$(printf '%s\n' "${list_times[@]}" | sort -n | tail -1)
p95_load=$(printf '%s\n' "${load_times[@]}" | sort -n | tail -1)

total=$((p95_list + p95_load))

echo "=== AgentDoc Speed Benchmark ==="
echo "List  P95: ${p95_list}ms  (runs: ${list_times[*]})"
echo "Load  P95: ${p95_load}ms  (runs: ${load_times[*]})"
echo "---"
echo "METRIC: ${total}"
