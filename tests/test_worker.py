import importlib.util
import asyncio
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "worker", Path(__file__).parents[1] / "engine/worker.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def _check_spawned_bilibili_request(headers_queue):
    import httpx
    from openai import OpenAI

    def respond(request):
        headers_queue.put(dict(request.headers))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 1,
                "model": "test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OK"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    with OpenAI(
        base_url="https://index-translate.bilibili.com/v1",
        api_key=worker.ANONYMOUS_API_KEY,
        http_client=httpx.Client(transport=httpx.MockTransport(respond)),
    ) as client:
        client.chat.completions.create(
            model="test", messages=[{"role": "user", "content": "OK"}]
        )


class WorkerTests(unittest.TestCase):
    def payload(self, **options):
        cfg = {
            "engineRoot": os.environ.get(
                "PDFMATH_ENGINE_ROOT", str(Path.home() / "Workspace/PDFMathTranslate")
            ),
            "useGlobalConfig": False,
            "baseURL": "https://example.invalid/v1",
            "model": "test-model",
        }
        cfg.update(options)
        return {"config": cfg, "apiKey": "example-private-key"}

    def test_generated_pdf_is_skipped_before_api_configuration_or_asset_download(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "renamed.pdf"
            with pymupdf.open() as pdf:
                pdf.new_page()
                pdf.set_metadata(
                    {
                        "producer": "BabelDOC_Translation_generated_by_AI,please_carefully_discern"
                    }
                )
                pdf.save(path, deflate=True, use_objstms=1)
            events = []
            with (
                patch.object(worker, "build_settings") as build,
                patch.object(worker, "prepare_assets") as assets,
                patch.object(
                    worker,
                    "emit",
                    side_effect=lambda kind, **data: events.append(
                        {"type": kind, **data}
                    ),
                ),
            ):
                asyncio.run(
                    worker.run(
                        {
                            "action": "translate",
                            "input": str(path),
                            "config": {},
                            "apiKey": "",
                        }
                    )
                )
                build.assert_not_called()
                assets.assert_not_called()
            self.assertEqual(
                events,
                [{"type": "result", "skipped": True, "reason": "already_translated"}],
            )

    def test_redacts_custom_keys(self):
        worker.SECRETS[:] = ["example-private-key"]
        self.assertEqual(
            worker.clean("failed: example-private-key"), "failed: [redacted]"
        )

    def test_pdf_validation_checks_page_counts(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pdf"
            with pymupdf.open() as pdf:
                pdf.new_page()
                pdf.save(path)
            self.assertEqual(worker.valid_pdf(path, 1), 1)
            with self.assertRaises(ValueError):
                worker.valid_pdf(path, 2)

    def test_practical_settings_reach_the_real_engine_models(self):
        payload = self.payload(
            langIn="ja",
            langOut="zh-TW",
            qps=3,
            timeout=77,
            maxWorkers=6,
            minTextLength=2,
            autoExtractGlossary=False,
            customPrompt="Use academic terms",
            fontFamily="sans-serif",
            ignoreCache=True,
            dualMode="alternating",
            dualTranslateFirst=True,
            watermark="no_watermark",
            ocrMode="auto",
            preserveRichText=False,
            splitShortLines=True,
            shortLineSplitFactor=0.6,
            maxPagesPerPart=50,
            skipScannedDetection=True,
            formulaFontPattern="Math",
            formulaCharPattern="[αβ]",
            figureTableProtectionThreshold=0.95,
        )
        s = worker.build_settings(payload)
        for field, expected in {
            "lang_in": "ja",
            "lang_out": "zh-TW",
            "qps": 3,
            "pool_max_workers": 6,
            "min_text_length": 2,
            "no_auto_extract_glossary": True,
            "ignore_cache": True,
            "custom_system_prompt": "Use academic terms",
            "primary_font_family": "sans-serif",
        }.items():
            self.assertEqual(getattr(s.translation, field), expected, field)
        for field, expected in {
            "use_alternating_pages_dual": True,
            "dual_translate_first": True,
            "watermark_output_mode": "no_watermark",
            "auto_enable_ocr_workaround": True,
            "disable_rich_text_translate": True,
            "split_short_lines": True,
            "short_line_split_factor": 0.6,
            "max_pages_per_part": 50,
            "skip_scanned_detection": False,
            "formular_font_pattern": "Math",
            "formular_char_pattern": "[αβ]",
            "figure_table_protection_threshold": 0.95,
        }.items():
            self.assertEqual(getattr(s.pdf, field), expected, field)
        self.assertEqual(s.translate_engine_settings.openai_timeout, "77")
        self.assertFalse(s.pdf.no_mono)
        self.assertFalse(s.pdf.no_dual)
        self.assertIsNone(s.pdf.pages)

    def test_bilibili_requests_omit_auth_and_openai_fingerprint_headers(self):
        import httpx
        from openai import OpenAI

        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "id": "chatcmpl-test",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "Index-Translate-35B-A3B",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "OK"},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )

        payload = self.payload(
            baseURL="https://index-translate.bilibili.com/v1",
            model="Index-Translate-35B-A3B",
        )
        payload["apiKey"] = ""
        worker.build_settings(payload)
        with OpenAI(
            base_url=payload["config"]["baseURL"],
            api_key=worker.ANONYMOUS_API_KEY,
            http_client=httpx.Client(transport=httpx.MockTransport(respond)),
        ) as client:
            client.chat.completions.create(
                model=payload["config"]["model"],
                messages=[{"role": "user", "content": "Reply only: OK"}],
                max_tokens=128,
            )

        self.assertEqual(len(requests), 1)
        headers = requests[0].headers
        self.assertNotIn("authorization", headers)
        self.assertEqual(headers["user-agent"], "Index-Translate-Client/1.0")
        self.assertFalse(any(name.startswith("x-stainless-") for name in headers))

    def test_spawned_translation_process_installs_bilibili_compatibility(self):
        context = multiprocessing.get_context("spawn")
        headers_queue = context.Queue()
        process = context.Process(
            target=_check_spawned_bilibili_request, args=(headers_queue,)
        )
        process.start()
        headers = headers_queue.get(timeout=15)
        process.join(timeout=15)

        self.assertEqual(process.exitcode, 0)
        self.assertNotIn("authorization", headers)
        self.assertEqual(headers["user-agent"], "Index-Translate-Client/1.0")
        self.assertFalse(any(name.startswith("x-stainless-") for name in headers))

    def test_compatibility_overrides_rich_text_and_force_ocr_is_distinct(self):
        s = worker.build_settings(
            self.payload(
                enhanceCompatibility=True, preserveRichText=True, ocrMode="force"
            )
        )
        self.assertTrue(s.pdf.disable_rich_text_translate)
        self.assertTrue(s.pdf.skip_clean)
        self.assertTrue(s.pdf.ocr_workaround)
        self.assertFalse(s.pdf.auto_enable_ocr_workaround)

    def test_invalid_formula_regex_fails_before_translation(self):
        with self.assertRaises(ValueError):
            worker.build_settings(self.payload(formulaFontPattern="["))

    def test_deepseek_thinking_uses_exact_hostname(self):
        self.assertEqual(
            worker.reasoning_options(
                {"thinking": "disabled"}, "https://api.deepseek.com/v1"
            ),
            {"thinking": {"type": "disabled"}},
        )
        with self.assertRaisesRegex(ValueError, "协议"):
            worker.reasoning_options(
                {"thinking": "disabled"}, "https://example.invalid/api.deepseek.com"
            )

    def test_reasoning_protocols_work_on_custom_gateways_and_default_is_untouched(self):
        for protocol, mode, expected in [
            ("thinking", "enabled", {"thinking": {"type": "enabled"}}),
            ("enable_thinking", "disabled", {"enable_thinking": False}),
            ("reasoning_effort", "enabled", {"reasoning_effort": "high"}),
            ("reasoning_effort", "disabled", {"reasoning_effort": "none"}),
        ]:
            s = worker.build_settings(
                self.payload(
                    thinkingProtocol=protocol, thinking=mode, reasoningEffort="high"
                )
            )
            self.assertEqual(s.translate_engine_settings._openai_extra_body, expected)
        self.assertEqual(worker.reasoning_options({}, "https://example.invalid/v1"), {})
        self.assertEqual(
            worker.reasoning_options(
                {"thinking": "enabled"},
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            ),
            {"enable_thinking": True},
        )

    def test_cache_tracks_layout_and_prompt_but_excludes_keys(self):
        s = worker.build_settings(self.payload())
        original = worker.cache_identity(s, "digest")
        self.assertNotIn("example-private-key", json.dumps(original))
        s.translation.qps = 12
        self.assertEqual(worker.cache_identity(s, "digest"), original)
        s.pdf.use_alternating_pages_dual = True
        self.assertNotEqual(worker.cache_identity(s, "digest"), original)
        s.pdf.use_alternating_pages_dual = False
        s.translation.custom_system_prompt = "new prompt"
        self.assertNotEqual(worker.cache_identity(s, "digest"), original)

    def test_missing_cached_pdf_is_regenerated_and_ignore_cache_forces_work(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.pdf"
            with pymupdf.open() as pdf:
                pdf.new_page()
                pdf.save(source)
            payload = self.payload()
            payload.update(input=str(source), output=str(root))
            s = worker.build_settings(payload)
            mono = root / "mono.pdf"
            dual = root / "dual.pdf"
            identity = worker.cache_identity(
                s, hashlib.sha256(source.read_bytes()).hexdigest()
            )
            (root / "result.json").write_text(
                json.dumps(
                    {
                        "identity": identity,
                        "outputs": {"mono": str(mono), "dual": str(dual)},
                    }
                )
            )
            calls = []
            events = []

            async def fake_stream(*_):
                calls.append(True)
                shutil.copy2(source, mono)
                shutil.copy2(source, dual)
                yield {
                    "type": "finish",
                    "translate_result": SimpleNamespace(
                        mono_pdf_path=mono, dual_pdf_path=dual
                    ),
                }

            with (
                patch("pdf2zh_next.high_level.do_translate_async_stream", fake_stream),
                patch.object(worker, "prepare_assets"),
                patch.object(
                    worker,
                    "emit",
                    side_effect=lambda kind, **data: events.append(
                        {"type": kind, **data}
                    ),
                ),
            ):
                asyncio.run(worker.translate(payload, s))
                self.assertFalse(events[-1]["cached"])
                self.assertEqual(len(calls), 1)
                asyncio.run(worker.translate(payload, s))
                self.assertTrue(events[-1]["cached"])
                self.assertEqual(len(calls), 1)
                s.translation.ignore_cache = True
                asyncio.run(worker.translate(payload, s))
                self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
