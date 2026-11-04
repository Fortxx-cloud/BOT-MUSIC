#!/bin/sh
set -eu

NODE_DIR="$HOME/.local/node24"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -x "$NODE_DIR/bin/node" ]; then
    echo "Node.js sudah terpasang:"
    "$NODE_DIR/bin/node" -v
    exit 0
fi

echo "Mendeteksi arsitektur hosting..."

FILE="$(python - <<'PY'
import json, platform, urllib.request

arch = platform.machine().lower()
arch_map = {
    "x86_64": "x64",
    "amd64": "x64",
    "aarch64": "arm64",
    "arm64": "arm64",
}

if arch not in arch_map:
    raise SystemExit("Arsitektur tidak didukung: " + arch)

with urllib.request.urlopen(
    "https://nodejs.org/dist/index.json", timeout=30
) as response:
    releases = json.load(response)

for release in releases:
    if release["version"].startswith("v24."):
        filename = f"node-{release['version']}-linux-{arch_map[arch]}.tar.xz"
        if "linux-" + arch_map[arch] in release["files"]:
            print(filename)
            break
else:
    raise SystemExit("Node.js 24 tidak ditemukan.")
PY
)"

echo "Mengunduh $FILE ..."
python - "$FILE" "$TMP_DIR" <<'PY'
import sys, urllib.request

filename, destination = sys.argv[1:]
url = "https://nodejs.org/dist/latest-v24.x/" + filename
urllib.request.urlretrieve(url, destination + "/" + filename)
PY

echo "Memasang Node.js..."
python - "$TMP_DIR/$FILE" "$TMP_DIR" <<'EXTRACT'
import sys, tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:xz") as tar:
    tar.extractall(destination, filter="data")
EXTRACT

mkdir -p "$HOME/.local"
mv "$TMP_DIR/${FILE%.tar.xz}" "$NODE_DIR"

echo "INSTALASI BERHASIL"
"$NODE_DIR/bin/node" -v
"$NODE_DIR/bin/npm" -v
