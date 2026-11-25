"""Export the pinned public model once for all platforms in a release."""

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

from huggingface_hub import snapshot_download


MODEL = "whoisjones/otter-cross-mmbert"
REVISION = "8729188e4f5fc7948d0e9dfd7d7e6d36c2e7270d"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as source:
        snapshot_download(MODEL, revision=REVISION, local_dir=source,
                          allow_patterns=["README.md", "*.json", "*.py", "model.safetensors"])
        subprocess.run([sys.executable, Path(__file__).with_name("export-otter.py"),
                        source, args.output / "otter.onnx"], check=True)
        for name in ("config.json", "tokenizer.json", "README.md"):
            shutil.copy2(Path(source) / name, args.output / name)


if __name__ == "__main__":
    main()
