#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin

backup_root=/srv/rimo/backups
release_dir=$(readlink -f /srv/rimo/current)
case "$release_dir" in
    /srv/rimo/releases/*) ;;
    *) printf '{"event":"daily_backup_failed","reason":"invalid_release_path"}\n' >&2; exit 1 ;;
esac
install -d -m 0700 "$backup_root/staging"
exec 9>"$backup_root/daily.lock"
if ! flock -n 9; then
    printf '{"event":"daily_backup_failed","reason":"operation_locked"}\n' >&2
    exit 1
fi
run_dir=$(mktemp -d "$backup_root/staging/run.XXXXXXXX")
cd "$release_dir"

/usr/local/bin/node scripts/backup-service.mjs \
    --project rimo --env-file /srv/rimo/private/rimo.env \
    --compose-file "$release_dir/docker-compose.yml" --output "$run_dir/complete"

ops_exit=0
if /usr/bin/bash "$release_dir/deploy/backup-ops.sh" "$release_dir" "$run_dir"; then
    printf '{"event":"daily_ops_backup_complete"}\n'
else
    ops_exit=$?
    printf '{"event":"daily_ops_backup_failed","core_upload_continues":true}\n' >&2
fi

# The standard wrapper uploads core and verifies all repository data after ops.
/usr/local/bin/node scripts/restic-backup.mjs --project rimo --input "$run_dir/complete"
if (( ops_exit != 0 )); then
    exit 1
fi
printf '{"event":"daily_backup_complete","offsite_verified":false}\n'
