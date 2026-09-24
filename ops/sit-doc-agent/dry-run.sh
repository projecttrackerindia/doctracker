#!/bin/bash
# DocTracker agent - fetch, verify and dry-run in one short command.
#
# Why this file exists: pasting multi-line commands into some SSH clients
# replays the terminal's own scrollback back into stdin, so half the paste
# runs as commands and the shell ends up stuck at a `>` continuation prompt.
# Fetching a script and running it by name is one short typed line, so there
# is nothing multi-line to paste and nothing to get mangled.
#
#   curl -fsSL -o dry-run.sh https://raw.githubusercontent.com/projecttrackerindia/doctracker/main/ops/sit-doc-agent/dry-run.sh
#   bash dry-run.sh
#
# Writes NOTHING to DocTracker. It only reads log files and prints a summary.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

RAW=https://raw.githubusercontent.com/projecttrackerindia/doctracker/main/ops/sit-doc-agent/mule_doc_agent.py
SEED=${SEED_LINES:-200000}
SECS=${RUN_SECONDS:-180}
OUT=dry.txt

echo "== 1/5 downloading agent =="
if ! curl -fsSL -o mule_doc_agent.py "$RAW"; then
  echo "FAILED to download the agent. Check outbound HTTPS to raw.githubusercontent.com." >&2
  exit 1
fi
sha256sum mule_doc_agent.py

echo
echo "== 2/5 checking config =="
if [ ! -f agent.env ]; then
  echo "agent.env not found in $DIR - nothing to run with." >&2
  exit 1
fi
# Two separate checks, because they catch different corruption.
#
# `bash -n` catches a PARSE error - an unquoted regex containing | and ( ).
# Sourcing in a subshell does NOT reliably catch this: the error prints but
# the subshell can still exit 0, so the run carries on with the variable
# unset and only a message scrolling past to say so.
if ! bash -n agent.env 2>/tmp/agentenv.$$; then
  echo "agent.env is not valid shell:" >&2
  sed 's/^/    /' /tmp/agentenv.$$ >&2
  rm -f /tmp/agentenv.$$
  echo "Rebuild it:  bash setup-env.sh 'the-password'" >&2
  exit 1
fi
rm -f /tmp/agentenv.$$

# A line-shape check catches text that parses fine but is not config at all -
# e.g. a shell prompt replayed into the file by a mangled paste, which shows
# up later as "command not found" and leaves settings missing.
BAD=$(grep -vE '^[[:space:]]*(#|$)|^[A-Za-z_][A-Za-z0-9_]*=' agent.env | head -3)
if [ -n "$BAD" ]; then
  echo "agent.env has lines that are not KEY=VALUE:" >&2
  printf '    %s\n' "$BAD" >&2
  echo "Rebuild it:  bash setup-env.sh 'the-password'" >&2
  exit 1
fi

# Start from a clean slate so an exported leftover from an earlier
# `. ./agent.env` in the calling shell cannot mask a broken file.
unset DOCTRACKER_ENVIRONMENT DOCTRACKER_WRITER_ID DOCTRACKER_USERNAME \
      DOCTRACKER_PASSWORD DOCTRACKER_PROJECT_ID MULE_LOG_PATH \
      MULE_LOG_EXCLUDE_PATTERN AGENT_STATE_FILE
set -a; . ./agent.env; set +a

# Print what was loaded WITHOUT printing the password itself.
echo "environment : ${DOCTRACKER_ENVIRONMENT:-<unset>}"
echo "writer id   : ${DOCTRACKER_WRITER_ID:-<unset>}"
echo "username    : ${DOCTRACKER_USERNAME:-<unset>}"
echo "project     : ${DOCTRACKER_PROJECT_ID:-<unset>}"
echo "password    : ${#DOCTRACKER_PASSWORD} chars"
if [ -n "${MULE_LOG_EXCLUDE_PATTERN:-}" ]; then
  echo "exclude     : ${MULE_LOG_EXCLUDE_PATTERN}"
else
  echo "exclude     : NOT SET - rotated archives will be tailed too"
fi

if [ -z "${DOCTRACKER_ENVIRONMENT:-}" ]; then
  echo "DOCTRACKER_ENVIRONMENT is empty - a real push would refuse to run." >&2
  exit 1
fi

echo
echo "== 3/5 running for ${SECS}s (dry run - no network writes) =="
timeout "$SECS" python3 mule_doc_agent.py --dry-run --seed-from-history "$SEED" > "$OUT" 2>&1
echo "finished, $(wc -l < "$OUT") lines captured in $OUT"

echo
echo "== 4/5 what it found =="
grep -E '^\[info\] (tailing [0-9]+|seed)' "$OUT" | head -5
grep -E '^\[(warn|error)\]' "$OUT" | grep -v 'not written for' | head -10

echo
echo "== 5/5 the payload it would push =="
# Just the identifying head of the metrics payload - not the whole blob,
# which can be large and holds discovered field names.
sed -n '/would push endpoint metrics/,+12p' "$OUT"
echo
echo "endpoints in payload: $(grep -c '"totalRequests"' "$OUT")"
echo
echo "Nothing was sent to DocTracker. Full output is in $DIR/$OUT"
