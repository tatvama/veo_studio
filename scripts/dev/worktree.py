"""Git worktrees for parallel work: one branch per task, each in its own folder.

    python scripts/dev/worktree.py new feat/poster-export     # branch + folder from the latest origin/main
    python scripts/dev/worktree.py list                       # every worktree, its branch and whether it is merged
    python scripts/dev/worktree.py clean                      # remove worktrees + branches already merged (asks first)
    python scripts/dev/worktree.py clean --yes                # same, without asking

New worktrees go in .claude/worktrees/<name> (git-ignored; Claude Code uses the same folder). Each one gets a copy
of the main checkout's .env and its own frontend/node_modules (npm ci). The backend venv is shared: use the main
checkout's backend/.venv (scripts/dev/check.py finds it automatically).

"Merged" means: the branch is contained in origin/main, its remote branch was deleted after a merge (GitHub
auto-delete), or GitHub reports a merged pull request for it. Worktrees with uncommitted changes are never removed.
Standard library only, so any Python 3.10+ runs it.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

BASE = "origin/main"
BRANCH_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]*$")
TYPES = ("feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert", "style")


def git(*args: str, cwd: Path | None = None, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stderr.strip()}")
    return r.stdout.strip()


def main_checkout() -> Path:
    """The main working tree (where .env and backend/.venv live), even when run from inside a worktree."""
    common = Path(git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    return common.parent


def worktrees() -> list[dict]:
    items, cur = [], {}
    for line in git("worktree", "list", "--porcelain", cwd=main_checkout()).splitlines() + [""]:
        if not line:
            if cur:
                items.append(cur)
            cur = {}
            continue
        key, _, val = line.partition(" ")
        cur[key] = val or True
    for w in items:
        w["path"] = Path(w["worktree"])
        w["branch_name"] = str(w.get("branch", "")).removeprefix("refs/heads/")
    return items


def merged_prs() -> set[str]:
    """Head branch names of merged GitHub PRs (empty when the gh CLI isn't available)."""
    gh = shutil.which("gh") or (r"C:\Program Files\GitHub CLI\gh.exe" if Path(r"C:\Program Files\GitHub CLI\gh.exe").exists() else None)
    if not gh:
        return set()
    r = subprocess.run([gh, "pr", "list", "--state", "merged", "--limit", "200", "--json", "headRefName", "--jq", ".[].headRefName"],
                       cwd=main_checkout(), capture_output=True, text=True, encoding="utf-8")
    return set(r.stdout.split()) if r.returncode == 0 else set()


def merge_state(branch: str, prs: set[str]) -> str | None:
    """Why the branch counts as merged, or None."""
    if not branch or branch == "main":
        return None
    root = main_checkout()
    if git("rev-parse", branch, cwd=root, check=False) == git("rev-parse", BASE, cwd=root, check=False):
        return None  # just created from origin/main, no commits yet
    if subprocess.run(["git", "merge-base", "--is-ancestor", branch, BASE], cwd=root).returncode == 0:
        return "in origin/main"
    track = git("for-each-ref", "--format=%(upstream:track)", f"refs/heads/{branch}", cwd=root, check=False)
    if "[gone]" in track:
        return "remote branch deleted"
    if branch in prs:
        return "PR merged"
    return None


def is_dirty(path: Path) -> bool:
    return bool(git("status", "--porcelain", cwd=path, check=False))


def cmd_new(a: argparse.Namespace) -> None:
    name = a.branch.strip()
    if not BRANCH_RE.match(name):
        sys.exit("Branch names are lower case: letters, digits, '-', '.', '/'. Example: feat/poster-export")
    if "/" not in name or name.split("/", 1)[0] not in TYPES:
        print(f"note: branches are easier to read as <type>/<topic>, type one of: {', '.join(TYPES)}")
    root = main_checkout()
    folder = root / ".claude" / "worktrees" / name.replace("/", "-")
    if folder.exists():
        sys.exit(f"{folder} already exists")
    if git("branch", "--list", name, cwd=root):
        sys.exit(f"branch {name} already exists (use `git worktree add {folder} {name}` to check it out)")

    print("Fetching origin …")
    git("fetch", "origin", "--prune", "--quiet", cwd=root)
    # --no-track: the branch must not follow origin/main; `git push -u origin <branch>` sets its own upstream
    git("worktree", "add", "--no-track", "-b", name, str(folder), a.base, cwd=root)

    env = root / ".env"
    if env.exists():
        shutil.copy2(env, folder / ".env")
        print("Copied .env (never commit it)")
    if not a.no_install and (folder / "frontend" / "package-lock.json").exists():
        npm = shutil.which("npm")
        if npm:
            print("Installing frontend packages (npm ci) …")
            subprocess.run([npm, "ci", "--no-audit", "--no-fund", "--loglevel=error"], cwd=folder / "frontend", check=False)
        else:
            print("npm not found: run `npm ci` in frontend/ before building the web app")

    venv = root / "backend" / ".venv"
    py = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    print(f"""
Ready: {folder}
  branch  {name}  (from {a.base})
  python  {py if py.exists() else 'create the shared venv first: see README → Quick start'}

Next:
  cd "{folder}"
  … make your change, commit …
  python scripts/dev/check.py            # same checks as CI
  git push -u origin {name}
  gh pr create --fill --title "<type>: <summary>"
""")


def cmd_list(_: argparse.Namespace) -> None:
    prs = merged_prs()
    git("fetch", "origin", "--prune", "--quiet", cwd=main_checkout(), check=False)
    for w in worktrees():
        b = w["branch_name"] or "(detached)"
        state = merge_state(w["branch_name"], prs) if w["branch_name"] else None
        flags = []
        if w["path"] == main_checkout():
            flags.append("main checkout")
        if state:
            flags.append(f"merged: {state}")
        if w["path"].exists() and is_dirty(w["path"]):
            flags.append("uncommitted changes")
        print(f"{b:45} {w['path']}" + (f"   [{'; '.join(flags)}]" if flags else ""))


def cmd_clean(a: argparse.Namespace) -> None:
    root = main_checkout()
    git("fetch", "origin", "--prune", "--quiet", cwd=root)
    prs = merged_prs()
    here = Path.cwd().resolve()
    remove_wt, keep = [], []
    for w in worktrees():
        if w["path"] == root:
            continue
        state = merge_state(w["branch_name"], prs)
        if not state:
            continue
        if w["path"].exists() and is_dirty(w["path"]):
            keep.append((w, "has uncommitted changes"))
        elif here == w["path"].resolve() or w["path"].resolve() in here.parents:
            keep.append((w, "you are inside it"))
        else:
            remove_wt.append((w, state))

    in_worktrees = {w["branch_name"] for w in worktrees()}
    branches = [b for b in git("for-each-ref", "--format=%(refname:short)", "refs/heads", cwd=root).splitlines()
                if b != "main" and b not in in_worktrees]
    remove_br = [(b, s) for b in branches if (s := merge_state(b, prs))]

    if not remove_wt and not remove_br:
        print("Nothing to clean: no merged worktrees or branches.")
    for w, why in keep:
        print(f"keep    {w['branch_name']:40} {w['path']}  ({why})")
    for w, why in remove_wt:
        print(f"remove  worktree {w['branch_name']:31} {w['path']}  ({why})")
    for b, why in remove_br:
        print(f"remove  branch   {b:31} ({why})")
    if not remove_wt and not remove_br:
        return
    if not a.yes:
        try:
            answer = input("Remove these? [y/N] ")
        except EOFError:  # no terminal to answer: never remove without a yes
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            print("Nothing removed.")
            return
    for w, _ in remove_wt:
        git("worktree", "remove", str(w["path"]), cwd=root)
        git("branch", "-D", w["branch_name"], cwd=root, check=False)
    for b, _ in remove_br:
        git("branch", "-D", b, cwd=root)
    git("worktree", "prune", cwd=root)
    print("Done.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="create a branch + worktree from the latest origin/main")
    n.add_argument("branch", help="e.g. feat/poster-export, fix/timeline-ducking")
    n.add_argument("--base", default=BASE, help=f"start point (default {BASE})")
    n.add_argument("--no-install", action="store_true", help="skip npm ci in frontend/")
    n.set_defaults(fn=cmd_new)
    sub.add_parser("list", help="list worktrees and their merge state").set_defaults(fn=cmd_list)
    c = sub.add_parser("clean", help="remove merged worktrees and local branches")
    c.add_argument("--yes", "-y", action="store_true", help="don't ask for confirmation")
    c.set_defaults(fn=cmd_clean)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
