#!/usr/bin/env python3
"""Scan this repo for secrets and private data before anything is pushed. Fails closed.

    python3 scripts/scan.py            # every tracked file plus untracked, non-ignored files
    python3 scripts/scan.py --history  # gitleaks over the full git history instead

This repo is meant to be public, so the scan answers one question: does anything in the file
set that would be pushed look like a credential, a real person's contact details, private
infrastructure, or a dataset? Four checks run over the same file set:

1. Regex patterns for credentials, email addresses and phone numbers (rule name and count are
   printed, never the matched text).
2. A private-data denylist: built-in names of private machines, repos and paths, plus an
   optional untracked `private/denylist.txt` (one string per line, case-insensitive).
3. A data-file rule: JSON belongs in fixtures/ or results/ (or is config); JSONL and CSV are
   never committed.
4. gitleaks over a copy of the same files.

Exits non-zero on any finding, and also when gitleaks is missing or fails: a scanner that did
not run is not a pass. Python 3 standard library only, so it runs without a venv.
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SELF = "scripts/scan.py"

# Copied verbatim from labs-takehome-critique bench/common.py (SECRET_PATTERNS, EMAIL_RE,
# PHONE_RE), the scanner this one is ported from. Keep the list in step with that source rather
# than editing patterns here one at a time.
SECRET_PATTERNS = [
    r"sk-ant-[A-Za-z0-9_\-]{10,}",
    r"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}",
    r"\bsk-[A-Za-z0-9]{20,}",
    r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}",
    r"\bgh[pousr]_[A-Za-z0-9]{20,}",
    r"\bgithub_pat_[A-Za-z0-9_]{20,}",
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\bAIza[0-9A-Za-z_\-]{35}\b",
    r"\bxox[abprs]-[A-Za-z0-9\-]{10,}",
    r"hooks\.slack\.com/services/[A-Za-z0-9/]+",
    r"\b(?:AC|SK)[0-9a-fA-F]{32}\b",                     # Twilio account and key IDs
    r"\b[0-9a-fA-F]{32,}\b",                             # any hex run of 32+ (tokens, keys, hashes)
    r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",  # JSON web tokens
    r"(?i)\bbearer\s+[A-Za-z0-9_\-\.=]{16,}",
    r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b",                  # Telegram bot tokens
    r"(?<=://)[^\s/:@]+:[^\s/@]+(?=@)",                  # user:password inside a URL
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    r"(?i)(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+",
]
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(?<!\d)(?:\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)")

_RX = [(p, re.compile(p)) for p in SECRET_PATTERNS] + [("email", EMAIL_RE), ("phone", PHONE_RE)]

# Email addresses that are allowed to appear. `.example` is reserved by RFC 2606 and cannot be a
# real mailbox; the fixtures' synthetic company uses larkspur.example. The Anthropic noreply
# address is the commit co-author trailer.
EMAIL_ALLOW_SUFFIXES = (".example",)
EMAIL_ALLOW_EXACT = {"noreply@anthropic.com"}

# The key=value rule above was written for prose, where a credential name followed by a colon and
# a value is a leak. In TypeScript the same shape is a type annotation (`secret: string`), so a
# match whose value is a bare TypeScript type name is not a finding. Any other value still is.
KEY_VALUE_RULE = SECRET_PATTERNS[-1]
TS_TYPE_VALUE_RE = re.compile(r"[:=]\s*(?:string|number|boolean|undefined|unknown|null|any|never)\b[^\w.]*$")
# A value read from the Worker's environment (`apiKey: env.ANTHROPIC_API_KEY`) names where a secret
# lives, not the secret itself, so it is not a finding either.
ENV_REF_VALUE_RE = re.compile(r"[:=]\s*(?:env|process\.env)\.[A-Z_][A-Z0-9_]*\b[^\w]*$")

# Files whose content is generated or not text worth scanning.
SKIP_NAMES = {"package-lock.json"}
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2",
                   ".ttf", ".otf", ".mp3", ".mp4", ".wav", ".webm", ".zip", ".gz"}
BINARY_SNIFF_BYTES = 8192  # a NUL byte in the first 8 KiB marks a file as binary (git's heuristic)

# Strings that must never appear in this public repo: private machine names, private repos and
# local paths that would point at the material this prototype was built from. Matched
# case-insensitively, and only where the string is not glued onto a preceding letter or digit,
# so that `CHANGELOG.md` does not count as `LOG.md`.
BUILTIN_DENYLIST = ["labs-takehome", "LOG.md", "~/.claude/projects", "fleet-cos",
                    "monster4", "grunthor", "trogdor", "claude-config"]
# Per-file exemptions from the built-in list. This file names every entry by necessity;
# CLAUDE.md names ~/.claude/projects in its guardrail ("treat it as read-only").
BUILTIN_EXEMPT = {SELF: set(BUILTIN_DENYLIST), "CLAUDE.md": {"~/.claude/projects"}}
PRIVATE_DENYLIST = ROOT / "private" / "denylist.txt"

# JSON that is configuration rather than data, and the directories where data files may live.
JSON_CONFIG_NAMES = {"package.json", "package-lock.json"}
JSON_ALLOWED_DIRS = ("fixtures/", "results/", ".github/", "src/")

GITLEAKS_ARGS = ["--redact", "--no-banner", "--log-level", "error", "--report-format", "json"]


def git(*args):
    out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"FAIL: git {' '.join(args)} exited {out.returncode}: {out.stderr.strip()}")
    return [line for line in out.stdout.splitlines() if line]


def file_set():
    """Tracked files plus untracked files that .gitignore does not exclude, as repo-relative paths."""
    names = sorted(set(git("ls-files") + git("ls-files", "--others", "--exclude-standard")))
    return [n for n in names if (ROOT / n).is_file()]  # drop deletions not yet staged


def is_binary(rel):
    if pathlib.Path(rel).suffix.lower() in BINARY_SUFFIXES:
        return True
    with open(ROOT / rel, "rb") as fh:
        return b"\0" in fh.read(BINARY_SNIFF_BYTES)


# Files whose long hex runs are SHA-256 digests by design (cache keys of recorded and evaluated model
# calls), not credentials. Only the bare-hex rule is waived for them; every other pattern and gitleaks
# still apply.
HEX_RULE = r"\b[0-9a-fA-F]{32,}\b"
HEX_DIGEST_FILES = ("fixtures/captures/recorded.json",)


def pattern_findings(rel, text):
    hits = {}
    for name, rx in _RX:
        if name == HEX_RULE and (rel in HEX_DIGEST_FILES or rel.startswith("results/")):
            continue
        matches = rx.findall(text)
        if name == KEY_VALUE_RULE:
            matches = [m for m in matches if not TS_TYPE_VALUE_RE.search(m) and not ENV_REF_VALUE_RE.search(m)]
        if name == "email":
            matches = [m for m in matches
                       if m.lower() not in EMAIL_ALLOW_EXACT and not m.lower().endswith(EMAIL_ALLOW_SUFFIXES)]
        if matches:
            hits[name] = len(matches)
    return hits


def load_denylist():
    builtin = [(s, re.compile(r"(?<![A-Za-z0-9])" + re.escape(s), re.I)) for s in BUILTIN_DENYLIST]
    private = []
    if PRIVATE_DENYLIST.is_file():
        for line in PRIVATE_DENYLIST.read_text().splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                private.append(s.lower())
        print(f"private denylist: {len(private)} entries from private/denylist.txt")
    else:
        print("private denylist: skipped (private/denylist.txt not present)")
    return builtin, private


def denylist_findings(rel, text, builtin, private):
    exempt = BUILTIN_EXEMPT.get(rel, set())
    hits = {}
    for s, rx in builtin:
        if s not in exempt:
            n = len(rx.findall(text))
            if n:
                hits[f"denylist:{s}"] = n
    lowered = text.lower()
    for i, s in enumerate(private, 1):
        n = lowered.count(s)
        if n:
            hits[f"private-denylist entry {i}"] = n  # the entry number, never the private string
    return hits


def data_file_finding(rel):
    path = pathlib.PurePosixPath(rel)
    suffix = path.suffix.lower()
    if suffix in (".jsonl", ".csv"):
        return f"{suffix} files are never committed"
    if suffix == ".json":
        if path.name in JSON_CONFIG_NAMES or re.fullmatch(r"tsconfig.*\.json", path.name):
            return None
        if rel.startswith(JSON_ALLOWED_DIRS):
            return None
        return "data file outside fixtures/ or results/"
    return None


def run_gitleaks(mode, target, report):
    """Run gitleaks and return {rule: count}. Raises SystemExit if it is missing or fails."""
    exe = shutil.which("gitleaks")
    if not exe:
        raise SystemExit("FAIL: gitleaks not found on PATH; refusing to treat an unscanned tree as clean")
    proc = subprocess.run([exe, mode, str(target), *GITLEAKS_ARGS, "--report-path", str(report)],
                          capture_output=True, text=True)
    # gitleaks exits 0 when clean and 1 (its --exit-code default) when it finds leaks.
    if proc.returncode not in (0, 1) or not report.exists():
        raise SystemExit(f"FAIL: gitleaks {mode} failed to run (exit {proc.returncode}): {proc.stderr[:300]}")
    found = json.loads(report.read_text() or "[]")
    if proc.returncode == 1 and not found:
        raise SystemExit("FAIL: gitleaks reported leaks but wrote an empty report")
    counts = {}
    for f in found:
        key = f"{f['RuleID']} in {f.get('File', '?')}"
        counts[key] = counts.get(key, 0) + 1
    return counts


def scan_tree():
    builtin, private = load_denylist()
    names = file_set()
    scanned, bad = [], 0
    for rel in names:
        reason = data_file_finding(rel)
        if reason:
            bad += 1
            print(f"FAIL data-file {rel}: {reason}")
        if pathlib.Path(rel).name in SKIP_NAMES or is_binary(rel):
            continue
        text = (ROOT / rel).read_text(errors="replace")
        scanned.append(rel)
        hits = pattern_findings(rel, text)
        hits.update(denylist_findings(rel, text, builtin, private))
        if hits:
            bad += 1
            print(f"FAIL {rel}: {hits}")

    tmp = pathlib.Path(tempfile.mkdtemp())
    try:
        tree = tmp / "tree"  # the report lives beside the copy, so gitleaks never scans it
        for rel in scanned:
            dest = tree / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / rel, dest)
        tree.mkdir(exist_ok=True)
        gl = run_gitleaks("dir", tree, tmp / "report.json")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if gl:
        bad += 1
        prefix = str(tree) + "/"
        print("FAIL gitleaks: " + ", ".join(f"{k.replace(prefix, '')} x{v}" for k, v in sorted(gl.items())))

    detail = (f"{len(names)} files ({len(scanned)} text files with {len(_RX)} patterns, "
              f"{len(BUILTIN_DENYLIST)}+{len(private)} denylist entries and gitleaks)")
    print(f"FAIL: {bad} finding(s) across {detail}" if bad else f"OK: scanned {detail}")
    return bad


def scan_history():
    commits = git("rev-list", "--all")
    tmp = pathlib.Path(tempfile.mkdtemp())
    try:
        gl = run_gitleaks("git", ROOT, tmp / "report.json")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if gl:
        print("FAIL gitleaks history: " + ", ".join(f"{k} x{v}" for k, v in sorted(gl.items())))
        print(f"FAIL: gitleaks found leaks in git history ({len(commits)} commits)")
        return 1
    print(f"OK: scanned {len(commits)} commits of git history with gitleaks")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args not in ([], ["--history"]):
        raise SystemExit(__doc__)
    sys.exit(1 if (scan_history() if args else scan_tree()) else 0)
