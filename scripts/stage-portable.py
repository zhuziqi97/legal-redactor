"""Assemble the offline preview with the TypeScript engine and native ONNX inference."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from zipfile import ZipFile

PROJECT = Path(__file__).resolve().parents[1]


def unpack_zip(archive, destination):
    with ZipFile(archive) as compressed:
        compressed.extractall(destination)
        for member in compressed.infolist():
            mode = (member.external_attr >> 16) & 0o777
            if mode and not member.is_dir():
                (destination / member.filename).chmod(mode)


def set_windows_icon(folder, executable, rcedit):
    command = [str(rcedit.resolve())]
    if sys.platform != "win32":
        command.insert(0, "wine")
    icon = r"resources\app\dist\legal-redactor-icon.ico"
    subprocess.run([*command, executable, "--set-icon", icon], cwd=folder, check=True)


def stage(target, inputs, staging, model, windows_crt, windows_rcedit):
    metadata = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))
    folder = staging / f"LegalRedactor-{metadata['version']}-{target}-x64"
    folder.mkdir(parents=True)
    unpack_zip(inputs / f"electron-{target}.zip", folder)
    executable = "legal-redactor" if target == "linux" else "LegalRedactor.exe"
    (folder / ("electron" if target == "linux" else "electron.exe")).rename(folder / executable)
    if target == "linux":
        (folder / executable).chmod(0o755)

    resources = folder / "resources"
    (resources / "default_app.asar").unlink(missing_ok=True)
    app = resources / "app"
    app.mkdir()
    manifest = {
        "name": metadata["name"], "productName": "法律文档脱敏工具",
        "version": metadata["version"], "type": metadata["type"], "main": metadata["main"],
    }
    (app / "package.json").write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    for path in ("dist", "build"):
        shutil.copytree(PROJECT / path, app / path)
    if target == "windows":
        set_windows_icon(folder, executable, windows_rcedit)
    node_modules = app / "node_modules"
    native = PROJECT / "node_modules"
    shutil.copytree(native / "@zip.js" / "zip.js", node_modules / "@zip.js" / "zip.js")
    platform = "win32" if target == "windows" else "linux"
    shutil.copytree(native / "onnxruntime-common", node_modules / "onnxruntime-common")
    bindings = node_modules / "onnxruntime-node"
    shutil.copytree(native / "onnxruntime-node", bindings, ignore=shutil.ignore_patterns("bin"))
    platform_bin = Path("bin", "napi-v6", platform, "x64")
    shutil.copytree(native / "onnxruntime-node" / platform_bin, bindings / platform_bin)
    token_bin = "tokenizers.win32-x64-msvc.node" if target == "windows" else "tokenizers.linux-x64-gnu.node"
    shutil.copytree(native / "tokenizers", node_modules / "tokenizers",
                    ignore=lambda _, children: {name for name in children if name.endswith(".node") and name != token_bin})
    if target == "windows":
        for dll in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"):
            shutil.copy2(windows_crt / dll, folder)
    (resources / "otter").mkdir()
    for required in ("config.json", "otter.onnx", "tokenizer.json", "README.md"):
        shutil.copy2(model / required, resources / "otter" / required)
    shutil.copy2(PROJECT / "LICENSE", resources / "otter" / "LICENSE")
    shutil.copy2(PROJECT / "LICENSE", resources / "legal-redactor-LICENSE")
    shutil.copy2(PROJECT / "NOTICE", resources / "legal-redactor-NOTICE")
    shutil.copy2(PROJECT / "engine" / "pinyin-LICENSE.txt", resources / "pypinyin-LICENSE.txt")

    instructions = (
        f"法律文档脱敏工具 {metadata['version']} · {target.capitalize()} x64\n\n"
        f"先解压整个目录，然后打开 {executable}。请保留同目录的资源文件。\n"
        "左侧点「添加材料」，可以导入 UTF-8 或带 BOM 的 UTF-16 TXT，也可以粘贴文本。\n"
        "必要时可选择简体中文（GB18030）重读。首次识别需要加载本地模型。\n"
        "包内带有脱敏引擎、CPU ONNX Runtime 和 Otter 模型，可离线工作。\n"
        "推理设置显示本发行包的 ONNX Runtime 后端。GPU 后端需要兼容设备和本机驱动。\n"
        "通过「文件」菜单保存或打开项目，可继续复核。对外可导出脱敏 TXT。\n\n"
        "Electron 和 Chromium 许可随其分发文件保存。识别模型为 whoisjones/otter-cross-mmbert，"
        "模型卡与 Apache-2.0 许可见 resources/otter/。\n"
    )
    (folder / "使用说明.txt").write_text(instructions, encoding="utf-8")
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("linux", "windows"))
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--staging", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--windows-crt", type=Path)
    parser.add_argument("--windows-rcedit", type=Path, help="Path to Electron rcedit-x64.exe (uses Wine outside Windows)")
    args = parser.parse_args()
    if args.target == "windows":
        if args.windows_crt is None:
            parser.error("--windows-crt is required for Windows")
        if args.windows_rcedit is None or not args.windows_rcedit.is_file():
            parser.error("--windows-rcedit must point to rcedit-x64.exe for Windows")
    print(stage(args.target, args.inputs, args.staging, args.model, args.windows_crt, args.windows_rcedit))


if __name__ == "__main__":
    main()
