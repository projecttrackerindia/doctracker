#!/bin/bash
# Writes a correct agent.env. One typed line, no multi-line paste:
#
#   bash setup-env.sh 'the-password'
#
# Put SINGLE quotes around the password. They stop the shell expanding a
# '$' inside it - a password containing e.g. '$@x' silently loses the '$@'
# under double quotes or no quotes at all, and produces an authentication
# error pointing at entirely the wrong thing.
set -u

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "usage: bash setup-env.sh 'the-password'   (single quotes matter)" >&2
  exit 1
fi
PW="$1"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# All overrides are DT_-prefixed on purpose. Plain names like USERNAME,
# ENVIRONMENT and LOGS already exist in many shells, so `${USERNAME:-svc-doc-agent}`
# silently picks up the logged-in user instead of the default - caught in
# testing, where it wrote the operator's own name as the service account.
DT_ENV=${DT_ENV:-SIT}
DT_WRITER=${DT_WRITER:-mule-sit-209}
DT_USER=${DT_USER:-svc-doc-agent}
DT_PROJECT=${DT_PROJECT:-sitautodisc1}
DT_LOGS=${DT_LOGS:-/data/mule/mule-enterprise-standalone-4.4.0/logs/*.log}

if [ -f agent.env ]; then
  cp -p agent.env "agent.env.bak.$(date +%s)"
  echo "existing agent.env backed up"
fi

# Every value is single-quoted. An unquoted regex containing | and ( ) is a
# shell syntax error, and a sourced file that fails to parse leaves the
# variable unset with nothing but a message scrolling past - which is how
# 124 files got tailed instead of 103.
{
  printf "DOCTRACKER_ENVIRONMENT='%s'\n" "$DT_ENV"
  printf "DOCTRACKER_WRITER_ID='%s'\n" "$DT_WRITER"
  printf "DOCTRACKER_USERNAME='%s'\n" "$DT_USER"
  printf "DOCTRACKER_PASSWORD='%s'\n" "$(printf '%s' "$PW" | sed "s/'/'\\\\''/g")"
  printf "DOCTRACKER_PROJECT_ID='%s'\n" "$DT_PROJECT"
  printf "MULE_LOG_PATH='%s'\n" "$DT_LOGS"
  printf "MULE_LOG_EXCLUDE_PATTERN='%s'\n" '-\d+\.log$|\.(gz|zip|bz2|xz|tar)$|\.log\.\d'
  printf "AGENT_STATE_FILE='%s'\n" "$DIR/state.json"
} > agent.env
chmod 600 agent.env

echo "wrote agent.env ($(wc -l < agent.env) lines, mode $(stat -c %a agent.env))"

# Prove it parses and that the password survived intact, in a SUBSHELL so
# nothing leaks into the caller's environment.
if ! bash -n agent.env; then
  echo "agent.env still does not parse - do not proceed." >&2
  exit 1
fi
( set -a; . ./agent.env; set +a
  echo "environment : ${DOCTRACKER_ENVIRONMENT}"
  echo "username    : ${DOCTRACKER_USERNAME}"
  echo "project     : ${DOCTRACKER_PROJECT_ID}"
  echo "password    : ${#DOCTRACKER_PASSWORD} chars"
  echo "exclude     : ${MULE_LOG_EXCLUDE_PATTERN}"
)

echo
echo "Check the character count above matches your password's length."
echo "If it is short, the shell ate a \$ - re-run with single quotes."
