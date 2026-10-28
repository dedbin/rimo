#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${MAIL_HOSTNAME:?Set MAIL_HOSTNAME}"
: "${MAIL_DOMAIN:?Set MAIL_DOMAIN}"
: "${SMTP_USER:?Set SMTP_USER}"
: "${MAIL_FROM:?Set MAIL_FROM}"
secret_file=${SMTP_PASSWORD_FILE:-/run/secrets/smtp-password}

domain_pattern='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
for value in "$MAIL_HOSTNAME" "$MAIL_DOMAIN"; do
    if [[ ! "$value" =~ $domain_pattern || "$value" != *.* || "$value" == *..* ]]; then
        printf 'Invalid mail domain configuration.\n' >&2
        exit 64
    fi
done
user_name=${SMTP_USER%@*}
if [[ ! "$user_name" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$ || "$SMTP_USER" != "$user_name@$MAIL_DOMAIN" ]]; then
    printf 'SMTP_USER must be an account in MAIL_DOMAIN.\n' >&2
    exit 64
fi
if [[ "$MAIL_FROM" != "no-reply@$MAIL_DOMAIN" || ! -r "$secret_file" ]]; then
    printf 'Configure the no-reply sender and a readable SMTP password file.\n' >&2
    exit 64
fi
password=$(< "$secret_file")
if [[ ! "$password" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
    printf 'The SMTP password file must contain a generated base64url secret.\n' >&2
    exit 64
fi

install -d -m 0755 /etc/postfix/sasl /run/rimo-mail
cat > /etc/postfix/sasl/smtpd.conf <<'EOF'
pwcheck_method: auxprop
auxprop_plugin: sasldb
sasldb_path: /etc/sasldb2
mech_list: PLAIN LOGIN
EOF
chmod 0644 /etc/postfix/sasl/smtpd.conf
printf '%s\n' "$password" | saslpasswd2 -p -c -f /etc/sasldb2 -u "$MAIL_DOMAIN" "$user_name"
unset password
chown root:postfix /etc/sasldb2
chmod 0640 /etc/sasldb2

printf '%s %s\n' "$MAIL_FROM" "$SMTP_USER" > /etc/postfix/sender_login
postmap /etc/postfix/sender_login
chmod 0644 /etc/postfix/sender_login /etc/postfix/sender_login.db
printf '<> REJECT Empty sender is not permitted for application submission\n' > /etc/postfix/blocked_senders
postmap /etc/postfix/blocked_senders
chmod 0644 /etc/postfix/blocked_senders /etc/postfix/blocked_senders.db

postconf -e \
    "myhostname=$MAIL_HOSTNAME" \
    "mydomain=$MAIL_DOMAIN" \
    "myorigin=$MAIL_DOMAIN" \
    'mydestination=localhost' \
    'inet_interfaces=all' \
    'inet_protocols=ipv4' \
    'mynetworks=127.0.0.0/8' \
    'relayhost=' \
    'relay_domains=' \
    'smtpd_relay_restrictions=permit_sasl_authenticated,reject' \
    'smtpd_recipient_restrictions=permit_sasl_authenticated,reject' \
    'smtpd_sender_restrictions=reject_non_fqdn_sender,reject_unknown_sender_domain,check_sender_access hash:/etc/postfix/blocked_senders,reject_sender_login_mismatch,permit_sasl_authenticated,reject' \
    'smtpd_sender_login_maps=hash:/etc/postfix/sender_login' \
    'smtpd_sasl_type=cyrus' \
    'smtpd_sasl_path=smtpd' \
    "smtpd_sasl_local_domain=$MAIL_DOMAIN" \
    'smtpd_sasl_auth_enable=yes' \
    'smtpd_sasl_security_options=noanonymous' \
    'smtpd_sasl_tls_security_options=noanonymous' \
    'smtpd_tls_auth_only=yes' \
    'smtpd_tls_security_level=encrypt' \
    'smtpd_tls_cert_file=/run/rimo-mail/tls/fullchain.pem' \
    'smtpd_tls_key_file=/run/rimo-mail/tls/privkey.pem' \
    'smtpd_tls_mandatory_protocols=!SSLv2,!SSLv3,!TLSv1,!TLSv1.1' \
    'smtpd_tls_protocols=!SSLv2,!SSLv3,!TLSv1,!TLSv1.1' \
    'smtpd_tls_mandatory_ciphers=high' \
    'smtp_tls_security_level=encrypt' \
    'smtp_tls_CApath=/etc/ssl/certs' \
    'smtp_tls_protocols=!SSLv2,!SSLv3,!TLSv1,!TLSv1.1' \
    'smtp_tls_mandatory_protocols=!SSLv2,!SSLv3,!TLSv1,!TLSv1.1' \
    'smtp_tls_mandatory_ciphers=high' \
    'smtp_tls_loglevel=1' \
    'smtpd_milters=inet:127.0.0.1:8891' \
    'non_smtpd_milters=' \
    'milter_protocol=6' \
    'milter_default_action=tempfail' \
    'message_size_limit=1048576' \
    'default_process_limit=10' \
    'smtpd_client_connection_count_limit=10' \
    'smtpd_client_connection_rate_limit=20' \
    'anvil_rate_time_unit=60s' \
    'smtpd_helo_required=yes' \
    'disable_vrfy_command=yes' \
    'append_dot_mydomain=no' \
    'enable_long_queue_ids=yes' \
    'maillog_file=/dev/stdout' \
    'maillog_file_prefixes=/var,/dev/stdout' \
    'maximal_queue_lifetime=1d' \
    'bounce_queue_lifetime=1h' \
    'debug_peer_list='

# Preserve packaged queue/transport services, and expose only private submission.
postconf -MX smtp/inet
postconf -M 'submission/inet=submission inet n - n - - smtpd'
postconf -P 'submission/inet/syslog_name=postfix/submission'
postconf -P 'submission/inet/milter_macro_daemon_name=ORIGINATING'
postconf -M 'postlog/unix-dgram=postlog unix-dgram n - n - 1 postlogd'

# The container is the isolation boundary. Packaged Debian chroots otherwise
# require an init wrapper to populate resolver, CA and service files in the queue.
while read -r service type rest; do
    case "$type" in
        inet|unix|unix-dgram|fifo|pass) postconf -F "$service/$type/chroot=n" ;;
    esac
done < <(postconf -M)
postfix set-permissions
