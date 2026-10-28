#!/usr/bin/env bash
set -euo pipefail
postfix status > /dev/null 2>&1
[[ -s /run/opendkim/opendkim.pid ]]
dkim_pid=$(< /run/opendkim/opendkim.pid)
[[ "$dkim_pid" =~ ^[0-9]+$ ]]
kill -0 "$dkim_pid"
[[ -s /run/rimo-mail/tls/fullchain.pem && -s /run/rimo-mail/tls/privkey.pem ]]
openssl x509 -in /run/rimo-mail/tls/fullchain.pem -noout -checkend 0 > /dev/null 2>&1
