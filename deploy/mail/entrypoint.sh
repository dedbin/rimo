#!/usr/bin/env bash
set -euo pipefail
umask 077

helpers=/usr/local/lib/rimo-mail
"$helpers/configure-dkim.sh"
"$helpers/configure-postfix.sh"

certificate_ready=false
for ((attempt=1; attempt<=60; attempt++)); do
    if "$helpers/sync-cert.sh"; then
        certificate_ready=true
        break
    fi
    if (( attempt == 1 )); then
        printf 'Waiting for the Caddy SMTP certificate.\n'
    fi
    sleep 2
done
if [[ "$certificate_ready" != true ]]; then
    printf 'No valid SMTP certificate became available within 120 seconds.\n' >&2
    exit 1
fi
postfix check

opendkim -f -x /etc/opendkim.conf &
dkim_pid=$!
postfix start-fg &
postfix_pid=$!

watch_certificates() {
    while sleep 60; do
        if ! "$helpers/sync-cert.sh" --reload; then
            printf 'SMTP certificate refresh failed; retrying on the next check.\n' >&2
        fi
    done
}
watch_certificates &
watcher_pid=$!

stop_children() {
    trap - TERM INT EXIT
    kill "$watcher_pid" 2>/dev/null || true
    postfix stop > /dev/null 2>&1 || true
    kill "$dkim_pid" 2>/dev/null || true
    wait "$watcher_pid" "$postfix_pid" "$dkim_pid" 2>/dev/null || true
}
trap stop_children TERM INT EXIT

printf 'Authenticated SMTP submission and DKIM signing started.\n'
# Restart the complete service if any supervised component exits.
set +e
wait -n "$dkim_pid" "$postfix_pid" "$watcher_pid"
status=$?
set -e
if (( status == 0 )); then status=1; fi
exit "$status"
