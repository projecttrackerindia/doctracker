#!/bin/bash
# Installs the DocTracker agent as a background service for THIS user.
#
#   bash install.sh
#
# No sudo, no systemd unit, nothing outside $HOME. Two cron entries:
#   @reboot        - start after the machine comes back
#   every 5 min    - a watchdog that starts it if it is not running
#
# The watchdog is what makes this survive an OOM kill, an unhandled
# exception or someone killing the process, without needing root to install
# a systemd service. It is a no-op when the agent is already up.
#
# Re-running this is safe: it replaces its own cron lines and leaves every
# other entry in the crontab untouched.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
TAG="# doctracker-agent"

if [ ! -f agent.env ]; then
  echo "agent.env not found. Run:  bash setup-env.sh 'the-password'" >&2
  exit 1
fi
if ! bash -n agent.env 2>/dev/null; then
  echo "agent.env is not valid shell. Rebuild:  bash setup-env.sh 'the-password'" >&2
  exit 1
fi
if [ ! -f mule_doc_agent.py ]; then
  echo "mule_doc_agent.py not found in $DIR" >&2
  exit 1
fi

# Refuse to install without an environment rather than let the agent start
# and exit every 5 minutes under the watchdog, which would look like a
# crash loop and bury the real reason in the log.
ENVNAME=$( set -a; . ./agent.env; set +a; printf '%s' "${DOCTRACKER_ENVIRONMENT:-}" )
if [ -z "$ENVNAME" ]; then
  echo "DOCTRACKER_ENVIRONMENT is not set in agent.env - the agent would refuse to push." >&2
  exit 1
fi

cat > "$DIR/start-agent.sh" <<'INNER'
#!/bin/bash
# Started by cron. Exits immediately if an agent is already running, so the
# 5-minute watchdog cannot end up with two agents fighting over state.json -
# which happened during testing and produced a muddled result that took a
# while to recognise as two writers rather than one misbehaving.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
if pgrep -f "python3 $DIR/mule_doc_agent.py" > /dev/null 2>&1; then
  exit 0
fi
set -a
. "$DIR/agent.env"
set +a

# Seed the inventory on a FIRST start only. Without this the agent begins at
# end-of-file knowing no endpoints, and since most of the inventory comes
# from "Starting flow:" lines that Mule emits only at application startup, a
# deployed-but-idle app stays invisible until the next Mule restart. The
# agent itself also refuses to re-seed once state.json records that it has,
# so this is safe on every restart and on the 5-minute watchdog.
SEED=""
if [ ! -f "${AGENT_STATE_FILE:-$DIR/state.json}" ]; then
  SEED="--seed-from-history ${SEED_LINES:-200000}"
fi
exec python3 "$DIR/mule_doc_agent.py" $SEED >> "$DIR/agent.log" 2>&1
INNER
chmod 700 "$DIR/start-agent.sh"

# Log rotation, because this appends forever otherwise. Keeps one previous
# file; 20 MB is several days of normal output.
cat > "$DIR/rotate-log.sh" <<'INNER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/agent.log"
[ -f "$LOG" ] || exit 0
SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
[ "$SIZE" -lt 20971520 ] && exit 0
mv -f "$LOG" "$LOG.1"
INNER
chmod 700 "$DIR/rotate-log.sh"

TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v "$TAG" > "$TMP"
{
  echo "@reboot $DIR/start-agent.sh $TAG"
  echo "*/5 * * * * $DIR/start-agent.sh $TAG"
  echo "17 * * * * $DIR/rotate-log.sh $TAG"
} >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

echo "installed for environment: $ENVNAME"
echo
crontab -l | grep "$TAG"
echo
echo "starting now..."
"$DIR/start-agent.sh" &
sleep 8
if pgrep -f "python3 $DIR/mule_doc_agent.py" > /dev/null 2>&1; then
  echo "agent is running (pid $(pgrep -f "python3 $DIR/mule_doc_agent.py" | head -1))"
else
  echo "agent did NOT stay up - last 20 lines of agent.log:" >&2
  tail -20 "$DIR/agent.log" 2>/dev/null >&2
  exit 1
fi
echo
echo "  watch it:   tail -f $DIR/agent.log"
echo "  stop it:    pkill -f 'python3 $DIR/mule_doc_agent.py'"
echo "  uninstall:  crontab -l | grep -v '$TAG' | crontab -"
echo
echo "It pushes every 60s. Give it 2 minutes, then check Observability."
