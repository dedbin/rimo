#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MAIL_DOMAIN:?Set MAIL_DOMAIN}"
: "${MAIL_DKIM_SELECTOR:?Set MAIL_DKIM_SELECTOR}"
if [[ ! "$MAIL_DOMAIN" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ || "$MAIL_DOMAIN" == *..* \
   || ! "$MAIL_DKIM_SELECTOR" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$ ]]; then
    printf 'Invalid DKIM domain or selector.\n' >&2
    exit 64
fi
key_dir=/var/lib/rimo-dkim
key_file="$key_dir/$MAIL_DKIM_SELECTOR.private"
install -d -m 0750 -o root -g opendkim "$key_dir"
if [[ ! -e "$key_file" ]]; then
    opendkim-genkey -b 2048 -h sha256 -r -D "$key_dir" -d "$MAIL_DOMAIN" -s "$MAIL_DKIM_SELECTOR"
fi
if ! openssl pkey -in "$key_file" -check -noout > /dev/null 2>&1; then
    printf 'The persisted DKIM private key is invalid; refusing to replace it.\n' >&2
    exit 1
fi
chown root:opendkim "$key_file"
chmod 0640 "$key_file"
public_key=$(openssl pkey -in "$key_file" -pubout -outform DER 2>/dev/null | openssl base64 -A)
printf 'v=DKIM1; h=sha256; k=rsa; t=s; p=%s\n' "$public_key" > "$key_dir/$MAIL_DKIM_SELECTOR.public.txt"
chmod 0644 "$key_dir/$MAIL_DKIM_SELECTOR.public.txt"

install -d -m 0755 /etc/opendkim
install -d -m 0750 -o opendkim -g opendkim /run/opendkim
printf '%s._domainkey.%s %s:%s:%s\n' "$MAIL_DKIM_SELECTOR" "$MAIL_DOMAIN" \
    "$MAIL_DOMAIN" "$MAIL_DKIM_SELECTOR" "$key_file" > /etc/opendkim/KeyTable
printf '*@%s %s._domainkey.%s\n' "$MAIL_DOMAIN" "$MAIL_DKIM_SELECTOR" "$MAIL_DOMAIN" > /etc/opendkim/SigningTable
chmod 0644 /etc/opendkim/KeyTable /etc/opendkim/SigningTable
cat > /etc/opendkim.conf <<'EOF'
Syslog no
Mode s
Canonicalization relaxed/relaxed
SignatureAlgorithm rsa-sha256
Socket inet:8891@127.0.0.1
PidFile /run/opendkim/opendkim.pid
UserID opendkim
UMask 007
KeyTable file:/etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
MacroList {daemon_name}=ORIGINATING
OversignHeaders From
RequireSafeKeys yes
EOF
chmod 0644 /etc/opendkim.conf
opendkim -n -x /etc/opendkim.conf
