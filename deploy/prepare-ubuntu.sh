#!/usr/bin/env bash
# Prepare the explicitly assigned empty Ubuntu host; keep existing SSH access.
set -euo pipefail
umask 027
export DEBIAN_FRONTEND=noninteractive

. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ]; then
    echo 'This preparation script requires Ubuntu 24.04.' >&2
    exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg jq dnsutils xz-utils git \
    fail2ban unattended-upgrades ufw

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

install -d -m 0750 /srv/rimo /srv/rimo/releases /srv/rimo/backups /srv/rimo/incoming
install -d -m 0700 /srv/rimo/private

cat > /etc/fail2ban/jail.d/rimo-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8443/tcp
ufw --force enable

# Host Node is used only for the read-only operator and backup scripts.
node_version=22.23.4
case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) echo 'Unsupported Node architecture' >&2; exit 1 ;;
esac
node_name="node-v${node_version}-linux-${node_arch}"
install -d -m 0755 /opt/rimo-tools
if [ ! -x "/opt/rimo-tools/${node_name}/bin/node" ]; then
    work_dir=$(mktemp -d /srv/rimo/incoming/node-install.XXXXXXXX)
    curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
        -o "${work_dir}/SHASUMS256.txt"
    curl -fsSL "https://nodejs.org/dist/v${node_version}/${node_name}.tar.xz" \
        -o "${work_dir}/${node_name}.tar.xz"
    (cd "$work_dir"; grep " ${node_name}.tar.xz$" SHASUMS256.txt | sha256sum --check -)
    tar -xJf "${work_dir}/${node_name}.tar.xz" -C /opt/rimo-tools
fi
ln -sfn "/opt/rimo-tools/${node_name}/bin/node" /usr/local/bin/node
ln -sfn "/opt/rimo-tools/${node_name}/bin/npm" /usr/local/bin/npm
ln -sfn "/opt/rimo-tools/${node_name}/bin/npx" /usr/local/bin/npx

docker version --format '{{.Server.Version}}'
docker compose version
node --version
ufw status
echo 'Rimo host preparation complete.'
