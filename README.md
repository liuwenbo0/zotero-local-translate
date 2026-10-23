# Local PDF Translate

Zotero PDF 翻译插件。使用自己的 OpenAI 兼容 API，为文献生成单语译文和双语对照附件。

[下载 XPI](https://github.com/liuwenbo0/zotero-local-translate/releases/latest) · [设置说明](docs/settings.md) · [问题反馈](https://github.com/liuwenbo0/zotero-local-translate/issues)

## 安装与使用

1. 在 Zotero 10.0.x「工具 → 插件」中选择「从文件安装附加组件」，安装下载的 XPI。
2. 打开 Zotero「设置 → 本地 PDF 翻译 → 翻译服务」，填写 Base URL、模型和 API 密钥并保存。
3. 选中文献或 PDF，点击「翻译选中条目」。译文会添加到原条目下，原 PDF 保留。

首次使用会自动联网下载引擎、模型和字体，无需配置 Python。建议预留 4 GB 空间。

## 功能

- 翻译选中条目、分类或整个文库，跳过已有译文
- 新增 PDF 时询问是否翻译
- 查看进度，支持多选、批量取消与重试、清空队列
- 配置翻译语言、思考模式、术语提取、提示词和 PDF 排版

## 说明

- PDF 解析与排版在本机完成；待译文字发送到配置的 API，密钥保存在 Zotero 登录管理器
- macOS 需 13 或更新版本；已在 macOS + Zotero 10.0.6 验证，Windows / Linux 尚未实机验证

翻译引擎：[PDFMathTranslate](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) / [BabelDOC](https://github.com/funstory-ai/BabelDOC)。许可：[AGPL-3.0-or-later](LICENSE)。
