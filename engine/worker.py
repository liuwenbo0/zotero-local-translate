#!/usr/bin/env python3
"""One-job JSON-lines bridge. Secrets arrive over stdin, never command arguments."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

PROTOCOL = sys.stdout
SECRETS = []
ANONYMOUS_API_KEY = "workload-identity-auth"


def emit(kind, **data):
    PROTOCOL.write(json.dumps({"type": kind, **data}, ensure_ascii=False) + "\n")
    PROTOCOL.flush()


def clean(message):
    text = str(message)
    for secret in SECRETS:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


def remember_secrets(data):
    if not isinstance(data, dict):
        return
    for field, value in data.items():
        if isinstance(value, dict):
            remember_secrets(value)
        elif (
            isinstance(value, str)
            and value
            and any(s in field.lower() for s in ("key", "secret", "token", "password"))
        ):
            SECRETS.append(value)


def install_cache_paths():
    # Spawned interpreters inherit this before importing any engine modules.
    root = os.environ.get("LOCAL_TRANSLATE_ASSETS_ROOT")
    if not root:
        return
    import babeldoc.const as const

    const.CACHE_FOLDER = Path(root)
    const.TIKTOKEN_CACHE_FOLDER = const.CACHE_FOLDER / "tiktoken"
    const.TIKTOKEN_CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = str(const.TIKTOKEN_CACHE_FOLDER)

    # PDFMathTranslate has a separate SQLite cache with a hardcoded home path.
    from pdf2zh_next.translator import cache

    folder = const.CACHE_FOLDER / "pdf2zh_next"
    folder.mkdir(parents=True, exist_ok=True)
    cache.db.close()
    cache.db.init(
        str(folder / "cache.v1.db"),
        pragmas={"journal_mode": "wal", "busy_timeout": 1000},
    )
    cache.db.create_tables([cache._TranslationCache], safe=True)


def install_openai_compatibility():
    from openai import OpenAI
    from openai._base_client import BaseClient

    validate_headers = OpenAI._validate_headers
    if not getattr(validate_headers, "_local_translate_headers", False):

        def validate_compatible_headers(self, headers, custom_headers):
            if self.api_key == ANONYMOUS_API_KEY:
                headers.pop("Authorization", None)
                return
            return validate_headers(self, headers, custom_headers)

        validate_compatible_headers._local_translate_headers = True
        OpenAI._validate_headers = validate_compatible_headers

    build_headers = BaseClient._build_headers
    if not getattr(build_headers, "_local_translate_headers", False):

        def build_compatible_headers(self, options, *, retries_taken=0):
            headers = build_headers(self, options, retries_taken=retries_taken)
            if urlsplit(str(self.base_url)).hostname == "index-translate.bilibili.com":
                headers["User-Agent"] = "Index-Translate-Client/1.0"
                for header in list(headers.keys()):
                    if header.lower().startswith(("x-stainless-", "x-request-id")):
                        headers.pop(header, None)
            return headers

        build_compatible_headers._local_translate_headers = True
        BaseClient._build_headers = build_compatible_headers


def install_rpm_compatibility():
    from pdf2zh_next.config.model import SettingsModel

    validate_settings = SettingsModel.validate_settings
    if getattr(validate_settings, "_local_translate_fractional_qps", False):
        return

    def validate_fractional_qps(self):
        # The pinned engine rejects QPS below 1, while its limiter supports it.
        # Validate all other settings at 1 QPS, then restore the requested rates.
        fractional = {
            name: value
            for name in ("qps", "term_qps")
            if (value := getattr(self.translation, name)) is not None and 0 < value < 1
        }
        try:
            for name in fractional:
                setattr(self.translation, name, 1)
            return validate_settings(self)
        finally:
            for name, value in fractional.items():
                setattr(self.translation, name, value)

    validate_fractional_qps._local_translate_fractional_qps = True
    SettingsModel.validate_settings = validate_fractional_qps


install_cache_paths()
install_openai_compatibility()
install_rpm_compatibility()


def reasoning_options(cfg, base_url):
    mode = cfg.get("thinking", "default")
    if mode == "default":
        return {}
    if mode not in {"enabled", "disabled"}:
        raise ValueError("Unknown thinking mode")
    protocol = cfg.get("thinkingProtocol", "auto")
    if protocol == "auto":
        host = urlsplit(base_url or "").hostname or ""
        if host == "api.deepseek.com":
            protocol = "thinking"
        elif host in {
            "dashscope.aliyuncs.com",
            "dashscope-intl.aliyuncs.com",
            "dashscope-us.aliyuncs.com",
        } or host.endswith((".dashscope.aliyuncs.com", ".maas.aliyuncs.com")):
            protocol = "enable_thinking"
        elif host == "api.openai.com":
            protocol = "reasoning_effort"
        else:
            raise ValueError("请为此 API 选择思考参数协议，或使用 API 默认思考模式")
    if protocol == "thinking":
        return {"thinking": {"type": mode}}
    if protocol == "enable_thinking":
        return {"enable_thinking": mode == "enabled"}
    if protocol == "reasoning_effort":
        effort = cfg.get("reasoningEffort", "medium")
        if effort not in {"low", "medium", "high"}:
            raise ValueError("Unknown reasoning effort")
        return {"reasoning_effort": effort if mode == "enabled" else "none"}
    raise ValueError("Unknown thinking protocol")


async def prepare_assets():
    # Upstream's five-second default is too short for first-run font/model downloads.
    # Keep its checksum validation and mirrors; bound concurrency to avoid pool timeouts.
    import httpx
    from babeldoc.assets import assets
    from tiktoken import encoding_for_model

    emit("engine_progress", progress=None, stage="检查分词器资源")
    await asyncio.to_thread(encoding_for_model, "gpt-4o")
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120, connect=20, pool=None),
        limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
    ) as client:

        async def prepare(label, operation):
            emit(
                "engine_progress",
                progress=None,
                stage="下载 / 校验" + label + "（首次准备）",
            )
            await operation(client)
            emit("engine_progress", progress=None, stage=label + "已就绪")

        await asyncio.gather(
            prepare("版面模型", assets.get_doclayout_onnx_model_path_async),
            prepare("字体", assets.download_all_fonts_async),
            prepare("字符映射", assets.download_all_cmaps_async),
        )


def build_settings(payload):
    cfg = payload["config"]
    from pdf2zh_next.config.model import SettingsModel
    from pdf2zh_next.config.translate_engine_model import OpenAISettings

    # The SDK accepts this sentinel but omits Authorization from requests.
    key = payload.get("apiKey", "") or ANONYMOUS_API_KEY
    settings = SettingsModel(
        translate_engine_settings=OpenAISettings(
            openai_base_url=cfg["baseURL"],
            openai_api_key=key,
            openai_model=cfg["model"],
            openai_timeout=str(cfg.get("timeout", 180)),
        )
    )
    settings.basic.input_files = set()
    settings.basic.gui = False
    settings.basic.debug = False
    settings.translation.lang_in = cfg.get("langIn", "en")
    settings.translation.lang_out = cfg.get("langOut", "zh")
    # Convert RPM to QPS; worker counts must remain positive integers.
    rpm = int(cfg.get("rpm", 240))
    if not 1 <= rpm <= 6000:
        raise ValueError("RPM must be between 1 and 6000")
    settings.translation.qps = rpm / 60.0
    settings.translation.term_qps = settings.translation.qps
    settings.translation.output = payload.get("output")
    settings.translation.pool_max_workers = int(cfg.get("maxWorkers", 0)) or max(
        1, (rpm + 59) // 60
    )
    settings.translation.term_pool_max_workers = settings.translation.pool_max_workers
    settings.translation.min_text_length = int(cfg.get("minTextLength", 5))
    settings.translation.no_auto_extract_glossary = not cfg.get(
        "autoExtractGlossary", True
    )
    settings.translation.ignore_cache = bool(cfg.get("ignoreCache", False))
    settings.translation.custom_system_prompt = (
        cfg.get("customPrompt", "").strip() or None
    )
    settings.translation.primary_font_family = (
        None if cfg.get("fontFamily", "auto") == "auto" else cfg["fontFamily"]
    )
    settings.pdf.pages = None
    settings.pdf.no_mono = False
    settings.pdf.no_dual = False
    settings.pdf.max_pages_per_part = int(cfg.get("maxPagesPerPart", 0)) or None
    settings.pdf.only_include_translated_page = False
    settings.pdf.watermark_output_mode = cfg.get("watermark", "watermarked")
    settings.pdf.use_alternating_pages_dual = (
        cfg.get("dualMode", "side_by_side") == "alternating"
    )
    settings.pdf.dual_translate_first = bool(cfg.get("dualTranslateFirst", False))
    settings.pdf.ocr_workaround = cfg.get("ocrMode", "off") == "force"
    settings.pdf.auto_enable_ocr_workaround = cfg.get("ocrMode", "off") == "auto"
    settings.pdf.enhance_compatibility = bool(cfg.get("enhanceCompatibility", False))
    settings.pdf.disable_rich_text_translate = not cfg.get("preserveRichText", True)
    settings.pdf.split_short_lines = bool(cfg.get("splitShortLines", False))
    settings.pdf.short_line_split_factor = float(cfg.get("shortLineSplitFactor", 0.8))
    settings.pdf.skip_scanned_detection = bool(cfg.get("skipScannedDetection", False))
    settings.pdf.formular_font_pattern = (
        cfg.get("formulaFontPattern", "").strip() or None
    )
    settings.pdf.formular_char_pattern = (
        cfg.get("formulaCharPattern", "").strip() or None
    )
    settings.pdf.figure_table_protection_threshold = float(
        cfg.get("figureTableProtectionThreshold", 0.9)
    )
    settings.validate_settings()
    engine = settings.translate_engine_settings
    for candidate in (engine, settings.term_extraction_engine_settings):
        if candidate and hasattr(candidate, "openai_timeout"):
            candidate.openai_timeout = str(cfg.get("timeout", 180))
    if getattr(engine, "openai_api_key", None):
        SECRETS.append(engine.openai_api_key)
    for candidate in (engine, settings.term_extraction_engine_settings):
        if candidate and hasattr(candidate, "_openai_extra_body"):
            candidate._openai_extra_body = {
                **(candidate._openai_extra_body or {}),
                **reasoning_options(cfg, getattr(candidate, "openai_base_url", "")),
            } or None
        elif candidate and cfg.get("thinking", "default") != "default":
            raise ValueError("此引擎不支持 OpenAI 兼容思考参数，请使用 API 默认值")
    return settings


def api_test_request(settings):
    engine = settings.translate_engine_settings
    request = {
        "model": engine.openai_model,
        "messages": [{"role": "user", "content": "Reply only: OK"}],
        "max_tokens": 128,
    }
    if engine._openai_extra_body:
        request["extra_body"] = engine._openai_extra_body
    return request


def preview_requests(settings):
    """Serialize real engine calls locally; the transport cannot access the network."""
    import httpx
    from openai import OpenAI
    from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
    from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import (
        ILTranslatorLLMOnly,
    )
    from babeldoc.format.pdf.document_il.midend.automatic_term_extractor import (
        LLM_PROMPT_TEMPLATE,
    )
    from pdf2zh_next.translator.base_rate_limiter import BaseRateLimiter
    from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator

    requests = []
    label = ""

    def capture(request):
        headers = dict(request.headers)
        if "authorization" in headers:
            headers["authorization"] = "Bearer [redacted]"
        requests.append(
            {
                "label": label,
                "request": {
                    "method": request.method,
                    "url": str(request.url),
                    "body": json.loads(request.content),
                    "headers": headers,
                },
            }
        )
        return httpx.Response(
            200,
            json={
                "id": "local-preview",
                "object": "chat.completion",
                "created": 0,
                "model": settings.translate_engine_settings.openai_model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "[]"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    engine = settings.translate_engine_settings
    with OpenAI(
        base_url=engine.openai_base_url,
        api_key=engine.openai_api_key,
        timeout=float(engine.openai_timeout),
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(capture)),
    ) as client:
        translator = OpenAITranslator(settings, BaseRateLimiter())
        translator.client.close()
        translator.client = client
        sample = "This study evaluates the accuracy of a neural network on scientific documents."
        config = SimpleNamespace(
            lang_out=settings.translation.lang_out,
            custom_system_prompt=settings.translation.custom_system_prompt,
        )
        # The prompt builders need no PDF, tokenizer, layout model, or downloaded fonts.
        batch = ILTranslatorLLMOnly.__new__(ILTranslatorLLMOnly)
        batch.translation_config = config
        batch._cached_glossaries = []
        prompt = batch._build_llm_prompt(
            json.dumps(
                [{"id": 0, "input": sample, "layout_label": "text"}],
                ensure_ascii=False,
                indent=2,
            ),
            None,
            None,
            sample,
        )
        label = "正文翻译（示例段落）"
        translator.do_llm_translate(prompt, {"request_json_mode": True})

        paragraph = ILTranslator.__new__(ILTranslator)
        paragraph.translation_config = config
        paragraph._cached_glossaries = []
        label = "单段翻译（回退请求）"
        translator.do_llm_translate(paragraph.generate_prompt_for_llm(sample))

        if not settings.translation.no_auto_extract_glossary:
            label = "自动术语提取（示例段落）"
            prompt = LLM_PROMPT_TEMPLATE.format(
                target_language=config.lang_out,
                text_to_process=sample,
                reference_glossary_section="",
                example_output='[\n  {"src": "LLM", "tgt": "大语言模型"},\n  {"src": "GPT", "tgt": "GPT"}\n]',
            )
            translator.do_llm_translate(prompt, {"request_json_mode": True})

        label = "引擎连接检查"
        translator.do_translate("Hello")
        label = "设置中的 API 测试"
        client.chat.completions.create(**api_test_request(settings))
    return requests


def cache_identity(settings, source_digest):
    from pdf2zh_next.const import __version__

    def public_engine(engine):
        if engine is None:
            return None
        fields = {
            k: v
            for k, v in engine.model_dump().items()
            if not any(s in k for s in ("key", "secret", "token", "password"))
        }
        fields["request_options"] = getattr(engine, "_openai_extra_body", None)
        return fields

    translation = settings.translation.model_dump(
        exclude={
            "output",
            "ignore_cache",
            "qps",
            "pool_max_workers",
            "term_qps",
            "term_pool_max_workers",
        }
    )
    return {
        "sha256": source_digest,
        "engine_version": __version__,
        "engine": public_engine(settings.translate_engine_settings),
        "term_engine": public_engine(settings.term_extraction_engine_settings),
        "translation": translation,
        "pdf": settings.pdf.model_dump(),
    }


def valid_pdf(path, expected=None, dual=False):
    import pymupdf

    with pymupdf.open(path) as pdf:
        if pdf.needs_pass or not pdf.page_count:
            raise ValueError("PDF is encrypted or empty")
        if expected and pdf.page_count not in (
            {expected, expected * 2} if dual else {expected}
        ):
            raise ValueError("Translation page count differs from the original")
        return pdf.page_count


async def translate(payload, settings):
    from pdf2zh_next.high_level import do_translate_async_stream

    source = Path(payload["input"]).resolve(strict=True)
    output = Path(payload["output"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    pages = valid_pdf(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    identity = cache_identity(settings, digest)
    checkpoint = output / "result.json"
    if checkpoint.exists() and not settings.translation.ignore_cache:
        try:
            saved = json.loads(checkpoint.read_text())
            if saved.get("identity") == identity and set(saved["outputs"]) == {
                "mono",
                "dual",
            }:
                for variant, path in saved["outputs"].items():
                    valid_pdf(path, pages, variant == "dual")
                emit("result", outputs=saved["outputs"], cached=True)
                return
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            # Missing, damaged or stale cached output must be regenerated on retry.
            pass
    emit(
        "engine_progress",
        progress=None,
        stage="准备本地模型与字体（首次运行可能需要下载）",
    )
    await prepare_assets()
    outputs = None
    async for event in do_translate_async_stream(settings, source):
        if event["type"] == "error":
            raise RuntimeError(event.get("error", "Translation failed"))
        if event["type"] == "finish":
            result = event["translate_result"]
            outputs = {
                "mono": str(result.mono_pdf_path or result.no_watermark_mono_pdf_path),
                "dual": str(result.dual_pdf_path or result.no_watermark_dual_pdf_path),
            }
        elif event.get("type") in {"progress_start", "progress_update", "progress_end"}:
            overall = event.get("overall_progress")
            if overall is None:
                overall = event.get("stage_progress")
            emit(
                "progress",
                progress=float(overall) if overall is not None else None,
                stage=event.get("stage", event["type"]),
                stageProgress=(
                    float(event["stage_progress"])
                    if event.get("stage_progress") is not None
                    else None
                ),
                stageCurrent=event.get("stage_current"),
                stageTotal=event.get("stage_total"),
                partIndex=event.get("part_index"),
                totalParts=event.get("total_parts"),
            )
    if not outputs or any(p == "None" for p in outputs.values()):
        raise RuntimeError("The engine did not produce both mono and dual PDFs")
    if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
        raise RuntimeError(
            "Original PDF changed during translation; results were not attached"
        )
    for variant, path in outputs.items():
        valid_pdf(path, pages, variant == "dual")
    temporary = checkpoint.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"identity": identity, "outputs": outputs}, ensure_ascii=False)
    )
    temporary.replace(checkpoint)
    emit("result", outputs=outputs, cached=False)


async def run(payload):
    action = payload.get("action", "translate")
    if action == "translate":
        import pymupdf

        with pymupdf.open(payload["input"]) as pdf:
            producer = (pdf.metadata or {}).get("producer", "") or ""
            if (
                "BabelDOC" in producer
                and "Translation_generated_by_AI,please_carefully_discern" in producer
            ):
                emit("result", skipped=True, reason="already_translated")
                return
    cfg = payload["config"]
    if cfg.get("assetsRoot") and cfg["assetsRoot"] != os.environ.get(
        "LOCAL_TRANSLATE_ASSETS_ROOT"
    ):
        raise ValueError("缓存目录必须在引擎进程启动前配置")
    if action == "probe":
        from pdf2zh_next.const import __version__
        import pymupdf  # noqa: F401
        from pdf2zh_next.high_level import do_translate_async_stream  # noqa: F401

        emit(
            "engine_progress",
            progress=None,
            stage="检查本地模型与字体（首次使用自动下载）",
        )
        await prepare_assets()

        emit(
            "result",
            version=__version__,
            engine="OpenAI",
            model=cfg.get("model", "configured"),
        )
        return
    settings = build_settings(payload)
    if action == "preview":
        emit("result", requests=await asyncio.to_thread(preview_requests, settings))
    elif action == "test_api":
        from openai import OpenAI

        engine = settings.translate_engine_settings
        if engine.translate_engine_type != "OpenAI":
            raise ValueError("API test requires an OpenAI-compatible engine")
        with OpenAI(
            base_url=engine.openai_base_url,
            api_key=engine.openai_api_key,
            timeout=float(engine.openai_timeout),
            max_retries=0,
        ) as client:
            response = await asyncio.to_thread(
                client.chat.completions.create,
                **api_test_request(settings),
            )
        emit("result", message=response.choices[0].message.content or "API connected")
    elif action == "translate":
        await translate(payload, settings)
    else:
        raise ValueError("Unknown worker action")


async def main_async(payload):
    task = asyncio.create_task(run(payload))
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
    await task


def main():
    logging.basicConfig(level=logging.ERROR)
    for name in ("httpx", "openai", "httpcore"):
        logging.getLogger(name).disabled = True
    try:
        payload = json.loads(sys.stdin.readline())
        remember_secrets(payload)
        with contextlib.redirect_stdout(sys.stderr):
            asyncio.run(main_async(payload))
    except asyncio.CancelledError:
        emit("error", message="Translation cancelled")
        return 130
    except Exception as exc:
        emit("error", message=clean(f"{type(exc).__name__}: {exc}"))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
