# LegalRedactor 案卷脱敏

LegalRedactor 是一款离线文本脱敏桌面应用，用于在分享或加工材料前识别、复核和替换敏感内容。应用使用 Vue、Electron、TypeScript 和 ONNX Runtime。

## 0.0.3-alpha

- 导入 TXT 或粘贴文字。支持 UTF-8、带 BOM 的 UTF-16，以及显式选择 GB18030 重读。
- 在同一工作区处理多份材料，按位置核对脱敏结果。支持补选、更正范围、编辑和合并映射、撤销。
- 复制或另存当前材料的脱敏 TXT。工作区数据在当前窗口内保留。

Windows 是首要支持平台。当前版本提供 Windows x64 和 Linux x64 便携目录。Linux x64 已验证离线识别和 TXT 输出。Windows x64 已完成出包，原生 Windows 验收待完成。macOS 支持在规划中。

## 运行便携版

将整个目录解压到本机，Windows 打开 `LegalRedactor.exe`，Linux 运行 `legal-redactor`。便携包内置运行所需的模型和 CPU 推理组件。GPU 推理需要兼容的运行环境。在左侧添加材料，复核后从「脱敏文本」复制或导出。

## 从源码构建

需要 Node.js 24 或更新版本。在仓库根目录执行：

```sh
cd apps/desktop
npm ci --ignore-scripts
npm run build
```

源码运行需要 Electron 44.11.2 和本地 Otter 模型。将 `REDACTOR_ONNX_DIR` 设为包含 `otter.onnx`、`config.json` 和 `tokenizer.json` 的目录。在 `apps/desktop` 运行：

```sh
npm exec --yes --package=electron@44.11.2 -- electron .
```

也可将 `ELECTRON_BIN` 设为已有 Electron 可执行文件，再运行 `npm start`。

### 获取模型和组装便携目录

从 [Otter 模型主页](https://huggingface.co/whoisjones/otter-cross-mmbert) 下载发布的检查点。在安装了检查点所需依赖、PyTorch、Transformers 和 ONNX 的构建环境中，从仓库根目录运行：

```sh
python apps/desktop/scripts/export-otter.py models/otter-checkpoint models/otter-checkpoint/otter.onnx
```

将生成的文件和检查点的 `config.json`、`tokenizer.json`、`README.md` 一起用于打包。[组装脚本](apps/desktop/scripts/stage-portable.py) 接收目标平台、Electron 分发文件目录、输出目录和模型目录。输入目录使用 `electron-linux.zip` 或 `electron-windows.zip`，Windows 另需对应的应用本地 C++ 运行库文件。运行脚本的 `--help` 可查看参数。

## 测试

在 `apps/desktop` 运行 `npm test`，验证映射编辑、冲突处理、撤销和推理任务调度。

## 许可证

本项目采用 [Apache-2.0](LICENSE)。第三方声明见 [NOTICE](NOTICE)。所用拼音数据保留 [MIT 许可证](apps/desktop/engine/pinyin-LICENSE.txt)，模型及其他依赖适用各自的许可。
