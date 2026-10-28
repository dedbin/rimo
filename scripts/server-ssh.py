"""Use the owner's existing SSH access with a mandatory pinned host key."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import secrets
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data/operator/python"))
import paramiko


ROOT = Path(__file__).resolve().parents[1]
KNOWN_HOSTS = ROOT / "data/operator/known_hosts"


def settings() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / ".env.server-access").read_text(encoding="utf-8-sig").splitlines():
        key, separator, value = line.partition("=")
        if not separator or not key.strip().startswith("SSH_"):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9:._-]*", values.get("SSH_HOST", "")):
        raise ValueError("Invalid SSH_HOST")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", values.get("SSH_USER", "")):
        raise ValueError("Invalid SSH_USER")
    if not 1 <= int(values.get("SSH_PORT", "22")) <= 65535:
        raise ValueError("Invalid SSH_PORT")
    return values


def connect() -> paramiko.SSHClient:
    config = settings()
    client = paramiko.SSHClient()
    if not KNOWN_HOSTS.is_file():
        raise ValueError("The SSH host key must be pinned by the operator first")
    client.load_host_keys(str(KNOWN_HOSTS))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(config["SSH_HOST"], port=int(config.get("SSH_PORT", "22")),
                   username=config["SSH_USER"], password=config.get("SSH_PASSWORD") or None,
                   key_filename=config.get("SSH_KEY_PATH") or None, allow_agent=False,
                   look_for_keys=False, timeout=20, auth_timeout=30, banner_timeout=30)
    client.get_transport().set_keepalive(20)
    return client


def run_script(client: paramiko.SSHClient, filename: str, timeout: int) -> int:
    script = Path(filename).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    remote_directory = f"/tmp/rimo-operator-{secrets.token_hex(16)}"
    remote_script = f"{remote_directory}/run.sh"
    with client.open_sftp() as sftp:
        sftp.mkdir(remote_directory, mode=0o700)
        with sftp.open(remote_script, "wx") as stream:
            stream.write(script.encode("utf-8"))
        sftp.chmod(remote_script, 0o600)
    stdin, stdout, stderr = client.exec_command(f"bash -e -- {remote_script}", timeout=30)
    stdin.channel.shutdown_write()
    channel = stdout.channel
    deadline = time.monotonic() + timeout
    while True:
        if channel.recv_ready():
            sys.stdout.write(channel.recv(65536).decode("utf-8", errors="replace"))
            sys.stdout.flush()
        if channel.recv_stderr_ready():
            sys.stderr.write(channel.recv_stderr(65536).decode("utf-8", errors="replace"))
            sys.stderr.flush()
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            with client.open_sftp() as sftp:
                sftp.remove(remote_script)
                sftp.rmdir(remote_directory)
            return channel.recv_exit_status()
        if time.monotonic() > deadline:
            raise TimeoutError("Remote command observation timed out; inspect before retrying")
        time.sleep(0.05)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run")
    run.add_argument("script")
    run.add_argument("--timeout", type=int, default=1200)
    for action in ("upload", "download"):
        transfer = sub.add_parser(action)
        transfer.add_argument("source")
        transfer.add_argument("destination")
    args = parser.parse_args()
    client = connect()
    try:
        if args.action == "run":
            return run_script(client, args.script, args.timeout)
        with client.open_sftp() as sftp:
            if args.action == "upload":
                sftp.put(args.source, args.destination)
                sftp.chmod(args.destination, 0o600)
            else:
                Path(args.destination).parent.mkdir(parents=True, exist_ok=True)
                sftp.get(args.source, args.destination)
        print(json.dumps({"event": args.action, "status": "complete"}))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (paramiko.SSHException, OSError, ValueError, TimeoutError) as error:
        print(json.dumps({"status": "failed", "code": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
