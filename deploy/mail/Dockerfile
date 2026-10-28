FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

ENV DEBIAN_FRONTEND=noninteractive
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && sed -i '\|^path-exclude[ =]*/usr/share/man/|d' /etc/dpkg/dpkg.cfg.d/docker \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates openssl postfix libsasl2-modules libsasl2-modules-db \
      sasl2-bin opendkim opendkim-tools \
    && test -r /usr/share/man/man1/mailq.1.gz \
    && postfix set-permissions \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/mail/*.sh /usr/local/lib/rimo-mail/
RUN chmod 0755 /usr/local/lib/rimo-mail/*.sh

EXPOSE 587
ENTRYPOINT ["/usr/local/lib/rimo-mail/entrypoint.sh"]
