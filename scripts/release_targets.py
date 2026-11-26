"""Release target names shared by staging and the GitHub build matrix."""

import json
import sys

TARGETS = {
    "windows": {"electron": "win32", "arch": "x64", "runner": "windows-2022", "extension": "zip", "token_abi": "msvc"},
    "linux": {"electron": "linux", "arch": "x64", "runner": "ubuntu-24.04", "extension": "tar.gz", "token_abi": "gnu"},
    "macos": {"electron": "darwin", "arch": "arm64", "runner": "macos-15", "extension": "zip", "token_abi": ""},
}


def package_name(version, target):
    return f"LegalRedactor-{version}-{target}-{TARGETS[target]['arch']}"


if __name__ == "__main__":
    version, include_macos = sys.argv[1:]
    matrix = []
    for target, info in TARGETS.items():
        if target == "macos" and include_macos != "true":
            continue
        directory = package_name(version, target)
        matrix.append({**info, "target": target, "directory": directory, "archive": f"{directory}.{info['extension']}"})
    print(json.dumps(matrix, separators=(",", ":")))
