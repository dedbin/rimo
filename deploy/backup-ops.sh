#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin

if (( $# != 2 )); then
    printf '{"event":"ops_backup_failed","reason":"invalid_arguments"}\n' >&2
    exit 1
fi
release_dir=$1
run_dir=$2
ntfy_id=
resume_ntfy=0
ntfy_image=binwiederhier/ntfy:v2.34.0@sha256:901e14503d3f605f445be0e68f2ac71f0aa73391897ce6ceb599f8c48d8b3792

restore_ntfy() {
    result=$?
    trap - EXIT
    trap '' INT TERM
    if (( resume_ntfy )); then
        if docker start "$ntfy_id" >>"$run_dir/ntfy-control.log" 2>&1 \
            && [[ $(docker inspect --type container --format '{{.State.Running}}' "$ntfy_id" 2>>"$run_dir/ntfy-control.log") == true ]]; then
            printf '{"event":"ops_backup_ntfy_resumed"}\n'
        else
            printf '{"event":"ops_backup_ntfy_resume_failed"}\n' >&2
            result=1
        fi
    fi
    exit "$result"
}
trap restore_ntfy EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Logs remain private siblings of core's exact three-file backup directory.
restic backup --json --tag rimo-ops:configuration -- \
    /srv/rimo/private "$release_dir/config" "$release_dir/deploy/ops" \
    >"$run_dir/configuration-restic.log" 2>&1
printf '{"event":"ops_configuration_snapshot_created"}\n'

row=$(docker inspect --type container --format \
    '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{range .Mounts}}{{if eq .Destination "/var/lib/ntfy"}}{{.Name}}{{end}}{{end}}' \
    rimo-ntfy-1 2>"$run_dir/ntfy-control.log")
IFS='|' read -r ntfy_id project service state volume <<<"$row"
if [[ ! $ntfy_id =~ ^[a-f0-9]{64}$ || $project != rimo || $service != ntfy || $volume != rimo_ntfy-data ]]; then
    printf '{"event":"ops_backup_failed","reason":"ntfy_identity_mismatch"}\n' >&2
    exit 1
fi
volume_owner=$(docker volume inspect --format \
    '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' \
    rimo_ntfy-data 2>>"$run_dir/ntfy-control.log")
if [[ $volume_owner != 'rimo|ntfy-data' ]]; then
    printf '{"event":"ops_backup_failed","reason":"ntfy_volume_mismatch"}\n' >&2
    exit 1
fi
case "$state" in
    running)
        resume_ntfy=1
        docker stop --timeout 30 "$ntfy_id" >>"$run_dir/ntfy-control.log" 2>&1
        ;;
    exited|created) ;;
    *) printf '{"event":"ops_backup_failed","reason":"ntfy_unstable_state"}\n' >&2; exit 1 ;;
esac

# A failing tar/Docker producer must abort snapshot creation inside restic.
restic backup --json --stdin-from-command --stdin-filename ntfy.tar --tag rimo-ops:ntfy -- \
    docker run --rm --pull never --network none --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges:true --log-driver none \
    -v rimo_ntfy-data:/source:ro --entrypoint tar "$ntfy_image" -C /source -cf - . \
    >"$run_dir/ntfy-restic.log" 2>&1
printf '{"event":"ops_ntfy_snapshot_created"}\n'
