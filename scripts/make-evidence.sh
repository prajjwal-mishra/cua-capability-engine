#!/usr/bin/env bash
#
# Regenerate every artifact in evidence/.
#
# Everything under evidence/ is produced by this script from a clean state, so a
# reviewer can reproduce the claims rather than take them on trust. Two things
# are deliberately NOT regenerated here:
#
#   * the discovery runs, which cost a live model call - they are captured once
#     and copied in by scripts/capture-discovery.sh
#   * the capabilities themselves, which are the OUTPUT of those discovery runs
#     and are committed as reviewed artifacts
#
# Usage:  ./scripts/make-evidence.sh            (expects the app on :4000)
#         PORT=4000 ./scripts/make-evidence.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4000}"
ORIGIN="http://localhost:${PORT}"
EV=evidence
export HEADLESS=1

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
curl -sf "${ORIGIN}/__control/state" >/dev/null || {
  echo "the target app is not answering on ${ORIGIN} - start it with: npm run app"
  exit 1
}

# Preserve live discovery captures. They cannot be regenerated without a model,
# and `runs/` is gitignored, so deleting 00-discovery here would destroy the
# only proof the brief requires.
DISCOVERY_BAK=""
if [ -d "${EV}/00-discovery" ]; then
  DISCOVERY_BAK="$(mktemp -d)"
  cp -R "${EV}/00-discovery" "${DISCOVERY_BAK}/00-discovery"
fi

rm -rf "${EV}"/0* "${EV}"/1* "${EV}"/2*
mkdir -p "${EV}"

if [ -n "${DISCOVERY_BAK}" ]; then
  mv "${DISCOVERY_BAK}/00-discovery" "${EV}/00-discovery"
  rmdir "${DISCOVERY_BAK}"
fi

# Rewind every capability to draft with no stability record.
#
# Replaying writes to the stability counters and approval flips the lifecycle
# state, so without this the script's own output would depend on how many times
# it had been run before - and the promotion demo would show an already-approved
# capability being approved. The point of this file is that a reviewer gets the
# same evidence we did.
echo "── resetting capability lifecycle to draft"
for cap in capabilities/*.json; do
  tmp=$(mktemp)
  jq '.lifecycle = {state: "draft", stability: {runs: 0, successes: 0}, stabilityByTenant: {}}' "${cap}" > "${tmp}"
  mv "${tmp}" "${cap}"
done

# ───────────────────────────────────────────────────────────────── discovery
# Copied rather than re-run: each of these is a live model session, and a
# reviewer should be looking at the run that actually produced the committed
# artifact, not a fresh one that might have found a different path. Every
# committed capability names its discovery run in provenance.runId, so the two
# can always be tied back together.
echo "── 00-discovery"
for cap in capabilities/*.json; do
  id=$(jq -r .capabilityId "${cap}")
  run=$(jq -r .provenance.runId "${cap}")
  if [ -d "runs/${run}" ]; then
    mkdir -p "${EV}/00-discovery/${id}"
    cp -R "runs/${run}" "${EV}/00-discovery/${id}/run"
    cp "${cap}" "${EV}/00-discovery/${id}/compiled-artifact.json"
    jq -r '.provenance | "capability: '"${id}"'\nmodel:      \(.discoveredBy)\nrun:        \(.runId)\nrecorded:   \(.recordedAt)"' \
      "${cap}" > "${EV}/00-discovery/${id}/provenance.txt"
  else
    echo "   keeping existing ${EV}/00-discovery/${id} (live run ${run} is not in runs/)"
  fi
done

cua() { npx tsx src/cli.ts "$@"; }
reset() { curl -sf -X POST "${ORIGIN}/__control/reset" -H 'content-type: application/json' -d '{}' >/dev/null; }
arm() { curl -sf -X POST "${ORIGIN}/__control/inject" -H 'content-type: application/json' -d "$1" >/dev/null; }

# Each case gets a directory holding the exact command, the console transcript,
# and the run's own evidence directory (log.jsonl, snapshots, screenshots).
capture() {
  local name="$1"; shift
  local dir="${EV}/${name}"
  mkdir -p "${dir}"
  printf '%s\n' "$*" > "${dir}/command.txt"
  echo "── ${name}"
  local out="${dir}/transcript.txt"
  ( "$@" ) > "${out}" 2>&1
  local code=$?
  echo "exit ${code}" >> "${out}"
  # Pull the run directory the CLI reported so the raw evidence travels with it.
  # Matched from "evidence: " to end of line rather than by shape, because an
  # absolute path can contain spaces and a shape-based pattern silently
  # captures nothing when it does.
  local run
  run=$(sed -n 's|^evidence: ||p' "${out}" | tail -1)
  if [ -n "${run}" ] && [ -d "${run}" ]; then
    cp -R "${run}" "${dir}/run"
    printf '%s\n' "$(basename "${run}")" > "${dir}/run-id.txt"
  fi
  reset
}

reset

# ───────────────────────────────────────────────────────── replay: the classes
# The four outcome classes the result contract distinguishes. The point of
# capturing all four is that they are structurally different answers, not one
# answer with different strings in it.

capture 01-replay-success \
  cua replay --capability member.savings_balance --input memberId=10042

capture 02-replay-business-outcome \
  cua replay --capability member.savings_balance --input memberId=99999

capture 03-replay-permission-denied \
  cua replay --capability member.savings_balance --input memberId=10099

capture 04-replay-input-rejected \
  cua replay --capability member.savings_balance --input memberId=abc

# ─────────────────────────────────────────────────────── replay: interference
# Faults armed out of band, so the automation drives byte-identical URLs
# whether or not something is about to go wrong.

# A 503 on the member page. Recovery reloads the frame and retries the step;
# the committed artifact's checkpoint (Open Sub-Account present) then passes.
# Two 503s against this checkpoint is a different story, pinned in tests/replay.test.ts
# with a route-based fixture - not this evidence folder.
echo "── 05-replay-recovers-from-transient"
arm '{"mode":"transient_503","count":1,"pathContains":"/frame/member"}'
capture 05-replay-recovers-from-transient \
  cua replay --capability member.savings_balance --input memberId=10042

echo "── 06-replay-recovers-from-interstitial"
arm '{"mode":"interstitial","count":1,"pathContains":"/frame/results"}'
capture 06-replay-recovers-from-interstitial \
  cua replay --capability member.savings_balance --input memberId=10042

echo "── 07-replay-recovers-from-session-timeout"
arm '{"mode":"session_timeout","count":1,"pathContains":"/frame/member/"}'
capture 07-replay-recovers-from-session-timeout \
  cua replay --capability member.savings_balance --input memberId=10042

echo "── 08-replay-hard-failure"
arm '{"mode":"app_error_500","count":6,"pathContains":"/frame/member/"}'
capture 08-replay-hard-failure \
  cua replay --capability member.savings_balance --input memberId=10042 --no-escalate

# ─────────────────────────────────────────────────────────────────── policy
capture 09-policy-denies-unrequested-write \
  cua replay --capability member.open_subaccount \
    --input memberId=10042 --input nickname=Vacation \
    --input initialDeposit=250.00 --input accountKind=Certificate

# ───────────────────────────────────────────────────────────── cross-tenant
# The same capability aimed at a second institution's instance, before and
# after that institution has an overlay.

capture 10-cross-tenant-without-overlay \
  cua replay --capability member.savings_balance --input memberId=10042 \
    --variant variant-b --no-escalate

capture 11-cross-tenant-with-overlay \
  cua replay --capability member.savings_balance --input memberId=10042 \
    --tenant summit-fcu

# ───────────────────────────────────────────────────────────────── writes
capture 12-write-attended-shadow-replay \
  cua replay --capability member.open_subaccount \
    --input memberId=10042 --input nickname=Vacation \
    --input initialDeposit=250.00 --input accountKind=Certificate \
    --allow-writes --attended

capture 13-write-validation-rejected \
  cua replay --capability member.open_subaccount \
    --input memberId=10042 --input nickname=ab \
    --input initialDeposit=250.00 --input accountKind=Certificate \
    --allow-writes --attended

# ─────────────────────────────────────────────────── escalation and handoff
capture 14-escalation-human-handoff \
  npx tsx scripts/operator-handoff-demo.ts

# ────────────────────────────────────────────────────────────── stability
# Rewind the lookup capability so the promotion evidence is "five green
# unattended runs, then approve" - not a pile of mixed earlier captures.
echo "── resetting member.savings_balance stability ahead of the sweep"
tmp=$(mktemp)
jq '.lifecycle = {state: "draft", stability: {runs: 0, successes: 0}, stabilityByTenant: {}}' \
  capabilities/member.savings_balance@1.0.0.json > "${tmp}"
mv "${tmp}" capabilities/member.savings_balance@1.0.0.json

# Five consecutive replays. This is what promotes a draft: the approval gate
# wants evidence, and this is the evidence.
capture 15-stability-five-runs \
  cua replay --capability member.savings_balance --input memberId=10042 --stability 5

# ─────────────────────────────────────────────────────────────── promotion
# Approval is not a rubber stamp: the gate reads the stability record written
# by the sweep above, and refuses without it. This is the whole draft →
# approved transition, and it is why the sweep runs before the catalog demos.
mkdir -p "${EV}/16-promotion"
{
  echo '$ cua catalog approve member.savings_balance'
  cua catalog approve member.savings_balance
  echo
  echo '# and the same request for the capability that has not earned it:'
  echo '$ cua catalog approve member.open_subaccount'
  cua catalog approve member.open_subaccount
} > "${EV}/16-promotion/transcript.txt" 2>&1

# ──────────────────────────────────────────────────────────────── catalog
mkdir -p "${EV}/17-catalog"
{
  echo '$ cua catalog list'
  cua catalog list
  echo
  echo '$ cua catalog describe member.savings_balance'
  cua catalog describe member.savings_balance
  echo
  echo '$ cua catalog describe member.open_subaccount --tenant summit-fcu'
  cua catalog describe member.open_subaccount --tenant summit-fcu
} > "${EV}/17-catalog/transcript.txt" 2>&1
cua catalog describe member.savings_balance --json > "${EV}/17-catalog/tool-contract.json" 2>/dev/null

capture 18-catalog-invoke \
  cua catalog invoke member.savings_balance --args '{"memberId":"10042"}'

capture 19-catalog-refuses-unapproved-write \
  cua catalog invoke member.open_subaccount \
    --args '{"memberId":"10042","nickname":"Vacation","initialDeposit":"250.00","accountKind":"Certificate"}'

# ───────────────────────────────────────────── overlay proposal + codegen
# The human click from 14, turned into a reviewable overlay against the BASE
# artifact (not the already-specialized Summit overlay).
echo "── 20-overlay-from-handoff"
mkdir -p "${EV}/20-overlay-from-handoff"
INT=$(find "${EV}/14-escalation-human-handoff/run/interventions" -name '*.json' | head -1)
{
  echo "\$ cua overlay propose --from ${INT} --tenant summit-fcu"
  cua overlay propose --from "${INT}" --tenant summit-fcu --out "${EV}/20-overlay-from-handoff/proposed.json"
} > "${EV}/20-overlay-from-handoff/transcript.txt" 2>&1
printf '%s\n' "cua overlay propose --from ${INT} --tenant summit-fcu" \
  > "${EV}/20-overlay-from-handoff/command.txt"

echo "── 21-emit-playwright"
mkdir -p "${EV}/21-emit-playwright"
{
  echo '$ cua emit --capability member.savings_balance --format page-object'
  cua emit --capability member.savings_balance --format page-object --out "${EV}/21-emit-playwright/page-object.ts"
} > "${EV}/21-emit-playwright/transcript.txt" 2>&1
printf '%s\n' "cua emit --capability member.savings_balance --format page-object" \
  > "${EV}/21-emit-playwright/command.txt"

echo
echo "wrote ${EV}/ - now regenerate the index:  npx tsx scripts/index-evidence.ts"
