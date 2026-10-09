"""Run the same checks as CI on this machine, before you push.

    python scripts/dev/check.py              # backend lint + tests, frontend typecheck + build
    python scripts/dev/check.py --backend    # only the backend
    python scripts/dev/check.py --frontend   # only the frontend
    python scripts/dev/check.py --fast       # lint + typecheck only (no tests, no vite build): a few seconds

Finds the backend venv in this checkout, or in the main checkout when run from a worktree (the venv is shared).
Override with VEO_PYTHON=<path to python>. The Docker build and smoke test run in CI only.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]  # the checkout this script lives in


def find_python() -> Path:
    if os.environ.get("VEO_PYTHON"):
        return Path(os.environ["VEO_PYTHON"])
    rel = Path("backend/.venv") / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    candidates = [HERE / rel]
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=HERE, capture_output=True, text=True)
    if r.returncode == 0:
        candidates.append(Path(r.stdout.strip()).parent / rel)
    for c in candidates:
        if c.exists():
            return c
    sys.exit("No backend venv found. Create it (README → Quick start) or set VEO_PYTHON.")


def step(title: str, cmd: list[str], cwd: Path) -> bool:
    print(f"\n── {title} ".ljust(78, "─"), flush=True)
    start = time.time()
    ok = subprocess.run(cmd, cwd=cwd).returncode == 0
    print(f"{'PASS' if ok else 'FAIL'}  {title}  ({time.time() - start:.0f}s)", flush=True)
    return ok


def main() -> None:
    p = argparse.ArgumentParser(description="Run CI checks locally")
    p.add_argument("--backend", action="store_true", help="only backend checks")
    p.add_argument("--frontend", action="store_true", help="only frontend checks")
    p.add_argument("--fast", action="store_true", help="lint + typecheck only")
    a = p.parse_args()
    both = not a.backend and not a.frontend
    results: list[tuple[str, bool]] = []

    if a.backend or both:
        py = str(find_python())
        be = HERE / "backend"
        if subprocess.run([py, "-m", "ruff", "--version"], capture_output=True).returncode != 0:
            print("Installing dev tools (requirements-dev.txt) into the venv …")
            subprocess.run([py, "-m", "pip", "install", "-q", "-r", "requirements-dev.txt"], cwd=be, check=True)
        results.append(("backend lint", step("Backend lint (ruff)", [py, "-m", "ruff", "check", "."], be)))
        if not a.fast:
            results.append(("backend tests", step("Backend tests (pytest, mock providers)", [py, "-m", "pytest", "-q"], be)))

    if a.frontend or both:
        npm = shutil.which("npm")
        fe = HERE / "frontend"
        if not npm:
            sys.exit("npm not found: install Node.js 22+")
        if not (fe / "node_modules").exists():
            results.append(("npm ci", step("Frontend install (npm ci)", [npm, "ci", "--no-audit", "--no-fund"], fe)))
        tsc = [npm, "exec", "--", "tsc", "-b"] if a.fast else [npm, "run", "build"]
        title = "Frontend typecheck (tsc -b)" if a.fast else "Frontend typecheck + build (tsc -b && vite build)"
        results.append(("frontend", step(title, tsc, fe)))

    print("\n" + "═" * 78)
    for name, ok in results:
        print(f"  {'✔' if ok else '✘'} {name}")
    if all(ok for _, ok in results):
        print("All checks passed. Push and open a pull request.")
    else:
        sys.exit("Some checks failed.")


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
