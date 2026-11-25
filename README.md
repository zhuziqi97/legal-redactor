# LegalRedactor

LegalRedactor 用于在共享或进一步处理法律文档前，识别和替换其中的敏感信息。识别、复核和导出均在本机离线完成。

## 主要功能

- 导入 TXT 或粘贴文本，识别人名、机构名、地址、联系方式等敏感信息。
- 并排查看原文和脱敏预览，定位并修正替换结果，手动补充遗漏。
- 为同一工作区的多份文档统一脱敏代号。
- 保存并重新打开本地项目，继续复核。
- 将复核后的文本复制到剪贴板或导出为 TXT。

## 从源码运行

需要 Node.js 24 或更新版本。从 [Otter 模型页](https://huggingface.co/whoisjones/otter-cross-mmbert) 获取模型，使用 [`scripts/export-otter.py`](scripts/export-otter.py) 导出 ONNX。将环境变量 `REDACTOR_ONNX_DIR` 指向包含 `otter.onnx`、`config.json` 和 `tokenizer.json` 的目录。

在仓库根目录构建并启动应用。

```sh
npm ci --ignore-scripts
npm run build
npm exec --yes --package=electron@44.11.2 -- electron .
```

使用 `npm test` 运行测试。

## 反馈

欢迎通过 [GitHub Issues](https://github.com/zhuziqi97/legal-redactor/issues) 反馈问题或提出建议。

## 许可证

项目采用 [Apache-2.0](LICENSE) 许可。第三方归属见 [NOTICE](NOTICE)。
