#!/bin/sh
# Litematic Studio launcher (Linux / macOS)
set -e
cd "$(dirname "$0")"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "[!] Python not found. Install Python 3.9+ and try again."
  exit 1
fi

if ! "$PY" -c "import litemapy" >/dev/null 2>&1; then
  echo "Installing litemapy ..."
  "$PY" -m pip install -r requirements.txt
fi

exec "$PY" server.py "$@"
