"""Exercise the real SMTP relay without submitting or delivering any message."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import shutil
import smtplib
import ssl
import subprocess
import tempfile
import time
from typing import Any, Iterator, Sequence


OWNER_LABEL = "rimo.mail-smoke-owner"
# Reserved example domains publish null MX and fail the production sender policy.
DOMAIN = "iana.org"
TLS_NAME = "smtp.example.com"
USERNAME = f"rimo@{DOMAIN}"
SENDER = f"no-reply@{DOMAIN}"
RECIPIENT = "recipient@example.net"


class SmokeFailure(RuntimeError):
    """A bounded error whose message contains no protocol secrets."""


@dataclass(frozen=True)
class Fixture:
    image: str
    name: str
    volume: str
    owner: str
    root: Path
    password: str


def command(arguments: Sequence[str], timeout: float = 30) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(arguments), capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SmokeFailure(f"{arguments[0]} command could not complete") from error


def checked(arguments: Sequence[str], timeout: float = 30) -> str:
    result = command(arguments, timeout)
    if result.returncode:
        raise SmokeFailure(f"{arguments[0]} command failed with status {result.returncode}")
    return result.stdout.strip()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def metadata(kind: str, name: str) -> dict[str, Any] | None:
    require(kind in ("container", "volume"), "Unsupported Docker resource kind")
    arguments = ["docker", kind, "ls", "--filter", f"name={name}"]
    if kind == "container":
        arguments.append("--all")
    arguments.extend(("--format", "{{.Names}}" if kind == "container" else "{{.Name}}"))
    # Only a successful inventory can prove absence; daemon errors must fail cleanup.
    if name not in checked(arguments).splitlines():
        return None
    output = checked(("docker", kind, "inspect", name))
    try:
        values = json.loads(output)
    except ValueError as error:
        raise SmokeFailure("Docker returned invalid resource metadata") from error
    require(
        isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict),
        "Docker returned invalid resource metadata",
    )
    return values[0]


def create_files(fixture: Fixture) -> Path:
    certificate_root = fixture.root / "caddy"
    certificate_dir = certificate_root / "caddy" / "certificates" / "smoke" / TLS_NAME
    certificate_dir.mkdir(parents=True)
    certificate = certificate_dir / f"{TLS_NAME}.crt"
    key = certificate_dir / f"{TLS_NAME}.key"
    checked((
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
        "-days", "2", "-subj", f"/CN={TLS_NAME}", "-addext",
        f"subjectAltName=DNS:{TLS_NAME},IP:127.0.0.1", "-keyout", str(key), "-out", str(certificate),
    ))
    password_file = fixture.root / "smtp-password"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    descriptor = os.open(password_file, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as stream:
        stream.write(fixture.password + "\n")
    for path in (password_file, key, certificate):
        path.chmod(0o600)
    return certificate


def start_container(fixture: Fixture) -> None:
    checked(("docker", "volume", "create", "--label", f"{OWNER_LABEL}={fixture.owner}", fixture.volume))
    arguments = [
        "docker", "run", "--detach", "--name", fixture.name,
        "--label", f"{OWNER_LABEL}={fixture.owner}", "--init",
        "--memory", "256m", "--pids-limit", "128", "--cap-drop", "NET_RAW",
        "--security-opt", "no-new-privileges:true", "--publish", "127.0.0.1::587",
        "--mount", f"type=bind,source={fixture.root / 'caddy'},target=/caddy,readonly",
        "--mount", f"type=bind,source={fixture.root / 'smtp-password'},target=/run/secrets/smtp-password,readonly",
        "--mount", f"type=volume,source={fixture.volume},target=/var/lib/rimo-dkim",
    ]
    settings = {
        "MAIL_HOSTNAME": DOMAIN, "MAIL_DOMAIN": DOMAIN, "MAIL_TLS_NAME": TLS_NAME,
        "MAIL_DKIM_SELECTOR": "smoke", "SMTP_USER": USERNAME,
        "SMTP_PASSWORD_FILE": "/run/secrets/smtp-password", "MAIL_FROM": SENDER,
    }
    for key, value in settings.items():
        arguments.extend(("--env", f"{key}={value}"))
    checked((*arguments, fixture.image))


def wait_ready(fixture: Fixture, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        details = metadata("container", fixture.name)
        require(details is not None, "The owned SMTP container disappeared")
        state = details.get("State", {})
        require(state.get("Running") is True, "The SMTP container exited before becoming ready")
        health = command((
            "docker", "exec", fixture.name, "/usr/local/lib/rimo-mail/healthcheck.sh",
        ), timeout=8)
        if health.returncode == 0:
            mappings = details.get("NetworkSettings", {}).get("Ports", {}).get("587/tcp") or []
            require(len(mappings) == 1, "Submission must have exactly one test port binding")
            require(mappings[0].get("HostIp") == "127.0.0.1", "The SMTP test port must be loopback-only")
            return int(mappings[0]["HostPort"])
        time.sleep(0.5)
    raise SmokeFailure("The SMTP container did not become healthy within the test deadline")


@contextmanager
def session(port: int, context: ssl.SSLContext | None = None) -> Iterator[smtplib.SMTP]:
    client = smtplib.SMTP("127.0.0.1", port, timeout=10)
    try:
        require(client.ehlo()[0] == 250, "SMTP EHLO failed")
        if context is not None:
            require(client.starttls(context=context)[0] == 220, "SMTP STARTTLS failed")
            require(isinstance(client.sock, ssl.SSLSocket), "The submission socket is not encrypted")
            require(client.sock.version() in ("TLSv1.2", "TLSv1.3"), "Submission negotiated an obsolete TLS version")
            require(client.ehlo()[0] == 250, "SMTP EHLO after STARTTLS failed")
        yield client
    finally:
        try:
            client.quit()
        except (OSError, smtplib.SMTPException):
            client.close()


def reject_envelope(client: smtplib.SMTP, sender: str, label: str) -> None:
    # Postfix may delay sender and authentication restrictions until RCPT TO.
    code = client.mail(sender)[0]
    if code < 400:
        code = client.rcpt(RECIPIENT)[0]
    require(400 <= code < 600, f"Submission incorrectly accepted {label}")
    require(client.rset()[0] == 250, "SMTP transaction reset failed")


def protocol_checks(port: int, fixture: Fixture, certificate: Path) -> dict[str, bool]:
    context = ssl.create_default_context(cafile=str(certificate))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with session(port) as client:
        require(client.has_extn("starttls"), "Submission did not advertise STARTTLS")
        require(not client.has_extn("auth"), "Submission advertised AUTH before STARTTLS")
        require(400 <= client.docmd("AUTH", "PLAIN")[0] < 600, "Submission allowed AUTH before STARTTLS")
        require(400 <= client.mail(SENDER)[0] < 600, "Submission allowed MAIL before STARTTLS")
    with session(port, context) as client:
        reject_envelope(client, SENDER, "an unauthenticated client")
    with session(port, context) as client:
        try:
            client.login(USERNAME, fixture.password + "wrong")
        except smtplib.SMTPAuthenticationError as error:
            require(error.smtp_code == 535, "Incorrect password did not receive an authentication rejection")
        else:
            raise SmokeFailure("Submission accepted an incorrect password")
    with session(port, context) as client:
        require(client.login(USERNAME, fixture.password)[0] == 235, "SMTP AUTH failed for the configured account")
        reject_envelope(client, f"other@{DOMAIN}", "an unassigned sender")
        reject_envelope(client, "", "an empty sender")
        require(client.mail(SENDER)[0] == 250, "Submission rejected the configured sender")
        require(client.rcpt(RECIPIENT)[0] == 250, "Submission rejected an authenticated envelope")
        require(client.rset()[0] == 250, "The accepted envelope could not be reset")
    return {
        "tls_and_auth": True, "pre_tls_denied": True, "unauthenticated_denied": True,
        "wrong_password_denied": True, "foreign_sender_denied": True, "empty_sender_denied": True,
    }


def dkim_fingerprint(fixture: Fixture) -> str:
    output = checked((
        "docker", "exec", fixture.name, "sha256sum", "/var/lib/rimo-dkim/smoke.private",
    ))
    fingerprint = output.split()[0]
    require(len(fingerprint) == 64, "The persistent DKIM key fingerprint is invalid")
    return fingerprint


def diagnostics(fixture: Fixture) -> None:
    details = metadata("container", fixture.name)
    if not details or details.get("Config", {}).get("Labels", {}).get(OWNER_LABEL) != fixture.owner:
        return
    result = command(("docker", "logs", "--tail", "20", fixture.name))
    output = (result.stdout + result.stderr)[-8_000:]
    for password in (fixture.password, fixture.password + "wrong"):
        for secret in (
            password, base64.b64encode(password.encode()).decode(),
            base64.b64encode(f"\0{USERNAME}\0{password}".encode()).decode(),
        ):
            output = output.replace(secret, "[REDACTED]")
    print(json.dumps({"smtp_diagnostics": output}, ensure_ascii=True))


def cleanup(fixture: Fixture) -> None:
    details = metadata("container", fixture.name)
    if details is not None:
        labels = details.get("Config", {}).get("Labels", {})
        require(labels.get(OWNER_LABEL) == fixture.owner, "Refusing to remove an unowned test container")
        checked(("docker", "rm", "--force", "--volumes", fixture.name))
    volume = metadata("volume", fixture.volume)
    if volume is not None:
        require(volume.get("Labels", {}).get(OWNER_LABEL) == fixture.owner, "Refusing to remove an unowned test volume")
        checked(("docker", "volume", "rm", fixture.volume))


def execute(image: str, timeout: float, root: Path) -> dict[str, bool]:
    owner = secrets.token_hex(12)
    fixture = Fixture(
        image=image, name=f"rimo-mail-smoke-{owner}", volume=f"rimo-mail-smoke-dkim-{owner}",
        owner=owner, root=root, password=secrets.token_urlsafe(48),
    )
    certificate = create_files(fixture)
    try:
        start_container(fixture)
        port = wait_ready(fixture, timeout)
        results = protocol_checks(port, fixture, certificate)
        original_key = dkim_fingerprint(fixture)
        checked(("docker", "restart", "--time", "5", fixture.name), timeout=30)
        port = wait_ready(fixture, timeout)
        require(dkim_fingerprint(fixture) == original_key, "Restart replaced the persisted DKIM key")
        context = ssl.create_default_context(cafile=str(certificate))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        with session(port, context) as client:
            require(client.login(USERNAME, fixture.password)[0] == 235, "SMTP AUTH failed after restart")
        require(not checked(("docker", "exec", fixture.name, "postqueue", "-j")), "Smoke checks unexpectedly queued a message")
        return {**results, "restart_and_dkim_persistence": True, "no_message_submitted": True}
    except (OSError, ValueError, smtplib.SMTPException, SmokeFailure):
        diagnostics(fixture)
        raise
    finally:
        cleanup(fixture)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="rimo-mail:ci", help="An already-built relay image")
    parser.add_argument("--timeout", type=float, default=120, help="Readiness deadline in seconds")
    arguments = parser.parse_args()
    require(arguments.timeout > 0, "The readiness timeout must be positive")
    for executable in ("docker", "openssl"):
        require(shutil.which(executable) is not None, f"Required executable is unavailable: {executable}")
    workspace = Path.cwd().resolve()
    base = workspace / "temp" / "mail-relay-smoke"
    require(base.resolve().is_relative_to(workspace), "Unexpected temporary workspace path")
    base.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="run-", dir=base) as directory:
        root = Path(directory).resolve()
        require(root.parent == base.resolve(), "Unexpected temporary fixture path")
        results = execute(arguments.image, arguments.timeout, root)
    print(json.dumps({"status": "passed", "checks": results, "temporary_resources_removed": True}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, smtplib.SMTPException, SmokeFailure) as error:
        # SMTP and TLS exception strings can contain protocol data; print only the type.
        detail = str(error) if isinstance(error, SmokeFailure) else type(error).__name__
        print(json.dumps({"status": "failed", "reason": detail}))
        raise SystemExit(1)
