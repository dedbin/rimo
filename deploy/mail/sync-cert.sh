#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MAIL_TLS_NAME:?Set MAIL_TLS_NAME}"
if [[ ! "$MAIL_TLS_NAME" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ || "$MAIL_TLS_NAME" == *..* ]]; then
    exit 64
fi
runtime=/run/rimo-mail
source_root=/caddy/caddy/certificates
[[ -d "$source_root" ]] || exit 1
certificate=
while IFS= read -r candidate; do
    if [[ "$candidate" == *"/$MAIL_TLS_NAME/$MAIL_TLS_NAME.crt" ]]; then
        certificate=$candidate
        break
    fi
done < <(find "$source_root" -type f -name "$MAIL_TLS_NAME.crt" ! -path '*/acme-staging-*' | sort)
[[ -n "$certificate" ]] || exit 1
private_key="${certificate%.crt}.key"
[[ -r "$private_key" ]] || exit 1
install -d -m 0700 "$runtime"
source_fingerprint=$(cat "$certificate" "$private_key" | sha256sum | cut -d ' ' -f 1)
fingerprint=$source_fingerprint
stage=

remove_unused_set() {
    local directory=$1
    [[ "$directory" == "$runtime"/tls-set.* && -d "$directory" && ! -L "$directory" ]] || return 0
    [[ "$(readlink -f "$runtime/tls" 2>/dev/null || true)" != "$directory" ]] || return 0
    rm -f -- "$directory/fullchain.pem" "$directory/privkey.pem" "$directory/fingerprint"
    # Unexpected files prevent removal instead of being recursively deleted.
    rmdir -- "$directory" 2>/dev/null || true
}
cleanup_stage() {
    if [[ -n "$stage" ]]; then remove_unused_set "$stage"; fi
}
trap cleanup_stage EXIT

if [[ ! -f "$runtime/tls/fingerprint" ]] || [[ "$(< "$runtime/tls/fingerprint")" != "$source_fingerprint" ]]; then
    stage=$(mktemp -d "$runtime/tls-set.XXXXXXXX")
    install -m 0644 "$certificate" "$stage/fullchain.pem"
    install -m 0600 "$private_key" "$stage/privkey.pem"
    # Caddy can rotate source files during copying. Validate the private snapshot.
    openssl x509 -in "$stage/fullchain.pem" -noout -checkhost "$MAIL_TLS_NAME" -checkend 3600 > /dev/null 2>&1 || exit 1
    certificate_public=$(openssl x509 -in "$stage/fullchain.pem" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)
    key_public=$(openssl pkey -in "$stage/privkey.pem" -pubout -outform DER 2>/dev/null | sha256sum)
    [[ "$certificate_public" == "$key_public" ]] || exit 1
    fingerprint=$(cat "$stage/fullchain.pem" "$stage/privkey.pem" | sha256sum | cut -d ' ' -f 1)
    printf '%s\n' "$fingerprint" > "$stage/fingerprint"
    # Publish the validated pair atomically; application is tracked separately.
    ln -sfnT "$stage" "$runtime/tls.next"
    mv -Tf "$runtime/tls.next" "$runtime/tls"
fi

if [[ "${1:-}" != --reload ]]; then exit 0; fi
if [[ -f "$runtime/applied-fingerprint" ]] && [[ "$(< "$runtime/applied-fingerprint")" == "$fingerprint" ]]; then
    exit 0
fi
# Failed reloads leave the applied marker unchanged, so the next tick retries.
postfix reload > /dev/null
printf '%s\n' "$fingerprint" > "$runtime/applied-fingerprint.next"
mv -Tf "$runtime/applied-fingerprint.next" "$runtime/applied-fingerprint"
while IFS= read -r directory; do
    remove_unused_set "$directory"
done < <(find "$runtime" -mindepth 1 -maxdepth 1 -type d -name 'tls-set.*')
printf 'SMTP certificate applied.\n'
