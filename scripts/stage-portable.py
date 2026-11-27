"""Assemble an offline desktop distribution with its native inference runtime."""

import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from release_targets import TARGETS, package_name

PROJECT = Path(__file__).resolve().parents[1]
PRODUCT_NAME = "法律文档脱敏工具"


def unpack_zip(archive, destination):
    with ZipFile(archive) as compressed:
        compressed.extractall(destination)
        for member in compressed.infolist():
            mode = (member.external_attr >> 16) & 0o777
            if mode and not member.is_dir():
                (destination / member.filename).chmod(mode)


def set_windows_icon(folder, executable):
    icon = folder / "resources" / "app" / "dist" / "legal-redactor-icon.ico"
    subprocess.run(["node", PROJECT / "scripts" / "set-windows-icon.mjs", folder / executable, icon], check=True)


def stage_mac_bundle(archive, folder, version):
    subprocess.run(["ditto", "-x", "-k", archive, folder], check=True)
    bundle = folder / "LegalRedactor.app"
    (folder / "Electron.app").rename(bundle)
    executable = bundle / "Contents" / "MacOS" / "Electron"
    executable.rename(executable.with_name("LegalRedactor"))
    info_path = bundle / "Contents" / "Info.plist"
    resources = bundle / "Contents" / "Resources"
    with info_path.open("rb") as source:
        info = plistlib.load(source)
    info.update(CFBundleName="LegalRedactor", CFBundleDisplayName=PRODUCT_NAME, CFBundleExecutable="LegalRedactor",
                CFBundleIdentifier="io.github.zhuziqi97.legalredactor",
                CFBundleShortVersionString=version, CFBundleVersion=version, CFBundleIconFile="LegalRedactor.icns")
    with info_path.open("wb") as output:
        plistlib.dump(info, output)
    with TemporaryDirectory() as temporary:
        iconset = Path(temporary) / "LegalRedactor.iconset"
        iconset.mkdir()
        source = PROJECT / "public" / "legal-redactor-icon.png"
        for size in (16, 32, 128, 256, 512):
            for scale, suffix in ((1, ""), (2, "@2x")):
                size_px = str(size * scale)
                subprocess.run(["sips", "-z", size_px, size_px, source,
                                "--out", iconset / f"icon_{size}x{size}{suffix}.png"], check=True,
                               stdout=subprocess.DEVNULL)
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", resources / "LegalRedactor.icns"], check=True)
    return bundle, resources


def stage_docx_dependencies(app):
    packages = json.loads((PROJECT / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    pending = [Path("node_modules", name) for name in ("mammoth", "parse5")]
    copied = set()
    while pending:
        package = pending.pop()
        if package in copied:
            continue
        copied.add(package)
        shutil.copytree(PROJECT / package, app / package,
                        ignore=shutil.ignore_patterns("node_modules"), dirs_exist_ok=True)
        for name in packages[package.as_posix()].get("dependencies", {}):
            for parent in (package, *package.parents):
                candidate = parent / "node_modules" / name
                if candidate.as_posix() in packages:
                    pending.append(candidate)
                    break
            else:
                raise ValueError(f"{package} has an unlocked dependency: {name}")


def stage(target, inputs, staging, model, windows_crt):
    metadata = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))
    spec = TARGETS[target]
    platform, arch, token_abi = spec["electron"], spec["arch"], spec["token_abi"]
    folder = staging / package_name(metadata["version"], target)
    folder.mkdir(parents=True)
    electron_zip = inputs / f"electron-{target}.zip"
    if target == "macos":
        bundle, resources = stage_mac_bundle(electron_zip, folder, metadata["version"])
        executable = bundle.name
    else:
        unpack_zip(electron_zip, folder)
        executable = "legal-redactor" if target == "linux" else "LegalRedactor.exe"
        (folder / ("electron" if target == "linux" else "electron.exe")).rename(folder / executable)
        if target == "linux":
            (folder / executable).chmod(0o755)
        resources = folder / "resources"

    (resources / "default_app.asar").unlink(missing_ok=True)
    app = resources / "app"
    app.mkdir()
    manifest = {
        "name": metadata["name"], "productName": PRODUCT_NAME,
        "version": metadata["version"], "type": metadata["type"], "main": metadata["main"],
    }
    (app / "package.json").write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    for path in ("dist", "build"):
        shutil.copytree(PROJECT / path, app / path)
    if target == "windows":
        set_windows_icon(folder, executable)
    node_modules = app / "node_modules"
    native = PROJECT / "node_modules"
    shutil.copytree(native / "@zip.js" / "zip.js", node_modules / "@zip.js" / "zip.js")
    shutil.copytree(native / "onnxruntime-common", node_modules / "onnxruntime-common")
    bindings = node_modules / "onnxruntime-node"
    shutil.copytree(native / "onnxruntime-node", bindings, ignore=shutil.ignore_patterns("bin"))
    platform_bin = Path("bin", "napi-v6", platform, arch)
    shutil.copytree(native / "onnxruntime-node" / platform_bin, bindings / platform_bin, symlinks=True)
    token_suffix = "-".join(part for part in (platform, arch, token_abi) if part)
    token_bin = f"tokenizers.{token_suffix}.node"
    shutil.copytree(native / "tokenizers", node_modules / "tokenizers",
                    ignore=lambda _, children: {name for name in children if name.endswith(".node") and name != token_bin})
    stage_docx_dependencies(app)
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
    shutil.copytree(PROJECT / "licenses" / "onnxruntime", resources / "licenses" / "onnxruntime")

    if target == "macos":
        subprocess.run(["codesign", "--force", "--deep", "--sign", "-", bundle], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", bundle], check=True)
    instructions = (
        f"{PRODUCT_NAME} {metadata['version']} · {target.capitalize()} {arch}\n\n"
        f"先解压整个目录，然后打开 {executable}。请保留同目录的资源文件。\n"
        "点击「添加文本材料」，可以打开 TXT 或 Word（DOCX），也可以粘贴文本。\n"
        "TXT 需要选择编码时，可用简体中文（GB18030）重读。首次识别需要加载本地模型。\n"
        "包内带有脱敏引擎、本地识别模型和推理组件。可以使用 CPU 离线识别。\n"
        "GPU 加速需要兼容的设备、驱动和对应的运行库。\n"
        "通过「文件」菜单保存或打开项目，可继续复核。对外可导出脱敏 TXT。\n\n"
        "Electron 和 Chromium 许可随其分发文件保存。识别模型为 whoisjones/otter-cross-mmbert，"
        "模型卡与 Apache-2.0 许可见 resources/otter/。\n"
    )
    (folder / "使用说明.txt").write_text(instructions, encoding="utf-8")
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--staging", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--windows-crt", type=Path)
    args = parser.parse_args()
    if args.target == "windows" and args.windows_crt is None:
        parser.error("--windows-crt is required for Windows")
    print(stage(args.target, args.inputs, args.staging, args.model, args.windows_crt))


if __name__ == "__main__":
    main()
