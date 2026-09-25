#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
#
# Validate GitHub Actions workflow files before pushing.
# Catches invalid YAML (e.g. an unquoted colon in a step name), which makes
# GitHub fail to start the whole workflow (0 jobs).
#
# Usage:
#   bash voice-opencode-plugin/check-workflows.sh [workflows-dir]
#
# Uses actionlint when available, otherwise PyYAML (pip install pyyaml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIR="${1:-$REPO_ROOT/.github/workflows}"

if [ ! -d "$DIR" ]; then
  echo "нет каталога с workflow: $DIR"
  exit 0
fi

if command -v actionlint >/dev/null 2>&1; then
  actionlint -color never "$DIR"/*.yml "$DIR"/*.yaml 2>/dev/null && echo "OK: actionlint" && exit 0
  exit 1
fi

python3 - "$DIR" <<'PY'
import glob
import os
import sys

try:
    import yaml
except ImportError:
    print("PyYAML не установлен: pip install pyyaml (или установите actionlint)")
    sys.exit(2)

directory = sys.argv[1]
files = sorted(glob.glob(os.path.join(directory, "*.yml")) + glob.glob(os.path.join(directory, "*.yaml")))
if not files:
    print(f"нет workflow-файлов в {directory}")
    sys.exit(0)

failed = False
for path in files:
    try:
        doc = yaml.safe_load(open(path, encoding="utf-8"))
        jobs = (doc or {}).get("jobs") or {}
        if not jobs:
            print(f"FAIL {os.path.relpath(path)}: нет блока jobs (workflow не запустится)")
            failed = True
            continue
        print(f"OK   {os.path.relpath(path)} (jobs: {len(jobs)})")
    except Exception as e:
        print(f"FAIL {os.path.relpath(path)}: {e}")
        failed = True

sys.exit(1 if failed else 0)
PY
