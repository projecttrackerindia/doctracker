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
# For the "it pushes every Ns" message below. POLL_INTERVAL_SECONDS (60s
# default) is how often it CHECKS the log for new lines; PUSH_INTERVAL_SECONDS
# (900s / 15min default) is how often it actually SENDS to DocTracker - a
# hardcoded "every 60s" here was conflating the two and had people checking
# Observability minutes before the first real push could possibly land.
PUSHSECS=$( set -a; . ./agent.env; set +a; printf '%s' "${PUSH_INTERVAL_SECONDS:-900}" )

cat > "$DIR/start-agent.sh" <<'INNER'
#!/bin/bash
# Started by cron. Exits immediately if an agent is already running, so the
# 5-minute watchdog cannot end up with two agents fighting over state.json -
# which happened during testing and produced a muddled result that took a
# while to recognise as two writers rather than one misbehaving.
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
# A PID FILE, not a pgrep pattern. Matching on the command line was fragile
# and did break: adding `-u` made the real command "python3 -u /path/..."
# while the pattern still said "python3 /path/...", so the guard silently
# stopped matching and the 5-minute watchdog started a fresh agent every
# five minutes, all of them writing the same state.json. A pid file cannot
# drift out of step with the command line like that.
#
# `exec` below replaces this shell without changing the pid, so $$ recorded
# here is the python process's own pid.
PIDFILE="$DIR/agent.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
echo $$ > "$PIDFILE"
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
# -u is not optional here. Python block-buffers stdout when it is a file
# rather than a terminal, so with plain `python3` the startup and seeding
# lines sit in an 8 KB buffer and agent.log looks EMPTY for a long while -
# indistinguishable from the agent having failed to start, which cost real
# time to diagnose on this node.
exec python3 -u "$DIR/mule_doc_agent.py" $SEED >> "$DIR/agent.log" 2>&1
INNER
chmod 700 "$DIR/start-agent.sh"

# Log rotation, because this appends forever otherwise. Keeps one previous
# file; 20 MB is several days of normal output.
#
# copy-then-truncate, NOT rename: the agent has no signal handling and holds
# agent.log open via the shell's `>> agent.log` redirect for as long as it
# runs (days/weeks by design). A rename leaves that fd pointed at the old,
# now-unlinked inode - the running process keeps appending to it forever,
# every later rotation attempt finds no file at $LOG and silently no-ops, and
# the "one previous file, 20 MB cap" promise above only ever held once. This
# is the standard `copytruncate` logrotate strategy for exactly this case: a
# long-running process that can't be told to reopen its log. `: > "$LOG"`
# truncates the SAME inode the process is already writing to, so it keeps
# appending correctly with no restart and no signal needed. The accepted
# trade-off (same one real logrotate --copytruncate documents) is that a
# handful of lines written in the instant between the copy and the truncate
# can be lost - acceptable for a diagnostic log, not for request data (this
# never touches state.json or the log files being tailed).
cat > "$DIR/rotate-log.sh" <<'INNER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/agent.log"
[ -f "$LOG" ] || exit 0
SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
[ "$SIZE" -lt 20971520 ] && exit 0
cp -f "$LOG" "$LOG.1" && : > "$LOG"
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
if [ -f "$DIR/agent.pid" ] && kill -0 "$(cat "$DIR/agent.pid" 2>/dev/null)" 2>/dev/null; then
  echo "agent is running (pid $(cat "$DIR/agent.pid"))"
else
  echo "agent did NOT stay up - last 20 lines of agent.log:" >&2
  tail -20 "$DIR/agent.log" 2>/dev/null >&2
  exit 1
fi
echo
echo "  watch it:   tail -f $DIR/agent.log"
echo "  stop it:    kill \$(cat $DIR/agent.pid)   # then: crontab -l | grep -v '$TAG' | crontab -"
echo "  uninstall:  crontab -l | grep -v '$TAG' | crontab -"
echo
echo "It checks the log every 60s, but only PUSHES to DocTracker every ${PUSHSECS}s"
echo "(PUSH_INTERVAL_SECONDS) - that's the earliest Observability can show anything new."
