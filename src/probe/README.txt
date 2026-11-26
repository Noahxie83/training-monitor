T4 adds `readonly_probe.py` as a fixed, read-only SSH/WSL transport payload. It accepts
bounded protocol requests over stdin and emits framed JSON; it does not add a product
entry point or connect the current T1 demo to a remote host.

Probe behavior is covered locally with temporary fixtures and fake process execution.
The Linux `/proc`, symlink, SSH, and WSL integration paths have not been verified against
a real remote host in this phase.
