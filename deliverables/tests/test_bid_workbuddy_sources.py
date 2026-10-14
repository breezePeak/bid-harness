"""来源 CLI 的接纳、原文绑定、版本保留及磁盘输入校验。"""

import importlib.util
import json
import os
from contextlib import nullcontext
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bid-workbuddy" / "scripts" / "sources.py"
SPEC = importlib.util.spec_from_file_location("bid_workbuddy_sources", SCRIPT)
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)
DOCTOR_SCRIPT = SCRIPT.with_name("doctor.py")
DOCTOR_SPEC = importlib.util.spec_from_file_location("bid_workbuddy_doctor", DOCTOR_SCRIPT)
doctor = importlib.util.module_from_spec(DOCTOR_SPEC)
DOCTOR_SPEC.loader.exec_module(doctor)


class SourcesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "项目"
        self.file = self.base / "资料.txt"
        self.file.write_bytes("第一行\r\n第二行\r\n第三行\r\n".encode("utf-8"))

    def cli(self, *args, expected=0):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                                capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        if expected:
            self.assertEqual(result.stdout, "")
            self.assertIn("error", json.loads(result.stderr))
            return result.stderr
        return json.loads(result.stdout)

    def add(self, role="reference", **kwargs):
        args = ["add", self.root, "--file", self.file, "--role", role]
        for key, value in kwargs.items():
            args.extend([f"--{key}", value])
        return self.cli(*args)

    def test_cli_registers_original_and_reads_program_bound_lines(self):
        entry = self.add(title="实施依据")
        self.assertEqual(entry["position"], 1)
        self.assertEqual(entry["line_count"], 3)
        self.assertEqual((self.root / entry["original_path"]).read_bytes(), self.file.read_bytes())
        result = self.cli("read", self.root, "--source", 1, "--start", 2, "--end", 3)
        self.assertEqual(result["quote"], "第二行\n第三行")
        self.assertEqual(result["lines"], [{"line": 2, "text": "第二行"}, {"line": 3, "text": "第三行"}])
        self.assertEqual(self.cli("list", self.root)["sources"], [entry])

    def test_web_requires_url_and_preserves_read_body(self):
        self.cli("add", self.root, "--file", self.file, "--role", "web", expected=2)
        self.cli("add", self.root, "--file", self.file, "--role", "web", "--url", "file:///secret", expected=2)
        self.assertFalse(self.root.exists())
        entry = self.add("web", url="https://example.com/technical")
        self.assertEqual(entry["locator"], "https://example.com/technical")
        self.assertEqual(self.cli("read", self.root, "--source", 1)["quote"], "第一行\n第二行\n第三行")

    def test_binary_file_requires_explicit_extracted_text(self):
        binary = self.base / "原文件.pdf"
        binary.write_bytes(b"%PDF-1.7\x00")
        self.cli("add", self.root, "--file", binary, "--role", "tender", expected=2)
        result = self.cli("add", self.root, "--file", binary, "--role", "tender", "--text", self.file,
                          "--extraction", "WorkBuddy 文档读取")
        self.assertEqual((self.root / result["original_path"]).read_bytes(), binary.read_bytes())
        self.assertEqual(result["extraction"], "WorkBuddy 文档读取")

    def test_versions_append_and_citations_keep_their_original_source(self):
        first = self.add("company")
        bound = sources.bind_citation(self.root, {"source_position": 1, "start_line": 1, "end_line": 2})
        self.file.write_text("新版资料\n", encoding="utf-8")
        second = self.add("company")
        self.assertNotEqual(first["source_id"], second["source_id"])
        self.assertEqual(second["position"], 2)
        sources.verify_citation(self.root, bound)
        self.assertEqual(bound["quote"], "第一行\n第二行")
        self.assertEqual(sources.source_at(self.root, 1), first)

    def test_rejects_out_of_range_noninteger_and_model_supplied_identity(self):
        self.add()
        for flags in (("--source", 2), ("--source", 1, "--start", 0),
                      ("--source", 1, "--end", 4), ("--source", 1, "--start", 3, "--end", 2)):
            self.cli("read", self.root, *flags, expected=2)
        baseline = {"source_position": 1, "start_line": 1, "end_line": 1}
        for value in ({**baseline, "source_position": True}, {**baseline, "start_line": 1.0},
                      {**baseline, "end_line": False}, {**baseline, "source_id": "made-up"},
                      {"source_position": 1, "start_line": 1}):
            with self.assertRaises(ValueError):
                sources.bind_citation(self.root, value)

    def test_rejects_tampered_snapshot_original_and_citation(self):
        entry = self.add()
        bound = sources.bind_citation(self.root, {"source_position": 1, "start_line": 1, "end_line": 2})
        for key, value in (("quote", "编造原文"), ("source_id", "不存在"), ("text_sha256", "0" * 64),
                           ("start_line", True), ("role", "company"), ("title", "其他资料")):
            with self.assertRaises(ValueError):
                sources.verify_citation(self.root, {**bound, key: value})
        for field in ("text_path", "original_path"):
            path = self.root / entry[field]
            original = path.read_bytes()
            path.write_bytes(original + b"changed")
            self.cli("read", self.root, "--source", 1, expected=2)
            with self.assertRaises(ValueError):
                sources.verify_citation(self.root, bound)
            path.write_bytes(original)
        sources.verify_citation(self.root, bound)

    def test_rejects_blank_reference_range_through_cli_and_binding(self):
        self.file.write_text("真实内容\n\n  \n更多内容\n", encoding="utf-8")
        self.add()
        self.cli("read", self.root, "--source", 1, "--start", 2, "--end", 3, expected=2)
        with self.assertRaisesRegex(ValueError, "空白"):
            sources.bind_citation(self.root, {"source_position": 1, "start_line": 2, "end_line": 3})
        bound = sources.bind_citation(self.root, {"source_position": 1, "start_line": 1, "end_line": 3})
        sources.verify_citation(self.root, bound)
        self.assertEqual(bound["quote"], "真实内容\n\n  ")

    def test_rejects_path_traversal_and_missing_index_fields(self):
        self.add()
        index = self.root / "sources" / "index.json"
        original = json.loads(index.read_text(encoding="utf-8"))
        for field, value in (("original_path", "../资料.txt"), ("text_path", str(self.file)),
                             ("source_id", "../outside"), ("line_count", True)):
            changed = json.loads(json.dumps(original))
            changed["sources"][0][field] = value
            index.write_text(json.dumps(changed), encoding="utf-8")
            self.cli("list", self.root, expected=2)
        del original["sources"][0]["text_sha256"]
        index.write_text(json.dumps(original), encoding="utf-8")
        self.cli("list", self.root, expected=2)

    def test_rejects_symlink_to_outside_workspace(self):
        entry = self.add()
        outside = (self.root / entry["text_path"]).parent
        linked_root = self.base / "linked-project"
        (linked_root / "sources").mkdir(parents=True)
        (linked_root / "sources" / "index.json").write_bytes((self.root / "sources" / "index.json").read_bytes())
        link = (linked_root / entry["text_path"]).parent
        if os.name == "nt":
            # 原生目录联接避免依赖 _winapi.CreateJunction 对进程特权的调整。
            created = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                                      "New-Item -ItemType Junction -Path $env:BID_TEST_LINK "
                                      "-Target $env:BID_TEST_TARGET -ErrorAction Stop | Out-Null"],
                                     env={**os.environ, "BID_TEST_LINK": str(link), "BID_TEST_TARGET": str(outside)},
                                     capture_output=True, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(created.returncode, 0, created.stderr.decode(errors="replace"))
        else:
            link.symlink_to(outside, target_is_directory=True)
        self.assertEqual(link.resolve(), outside.resolve())
        self.assertFalse(outside.resolve().is_relative_to(linked_root.resolve()))
        error = json.loads(self.cli("read", linked_root, "--source", 1, expected=2))["error"]
        self.assertRegex(error, "符号链接|目录联接|越过工作区")

    def test_failed_index_replace_preserves_all_previous_sources(self):
        first = self.add()
        with patch.object(sources.os, "replace", side_effect=OSError("模拟磁盘替换失败")):
            with self.assertRaises(OSError):
                sources.add_source(self.root, self.file, "reference")
        self.assertEqual(self.cli("list", self.root)["sources"], [first])
        self.assertEqual(self.add()["position"], 2)


class DoctorTest(unittest.TestCase):
    def test_wps_compatibility_registration_does_not_claim_microsoft_word(self):
        registry = {
            r"Word.Application\CLSID": "{wps-compatibility-class}",
            r"CLSID\{wps-compatibility-class}\LocalServer32": r'"C:\WPS Office\wps.exe" /Automation',
        }
        fake_winreg = SimpleNamespace(HKEY_CLASSES_ROOT=0,
                                     OpenKey=lambda root, key: nullcontext(key),
                                     QueryValue=lambda key, name: registry[key])
        with patch.dict(sys.modules, {"winreg": fake_winreg}), patch.object(doctor.sys, "platform", "win32"):
            result = doctor.check_environment()
        self.assertTrue(result["optional"]["word_compatible_com_registered"])
        self.assertNotIn("word_com_registered", result["optional"])
        self.assertTrue(any("WPS" in message and "不证明 Microsoft Word 存在或 PDF 转换可用" in message
                            for message in result["limitations"]))

    def test_missing_docx_keeps_orchestration_available(self):
        with patch.object(doctor, "_package", side_effect=lambda module, distribution:
                          {"available": module == "PIL", "version": None}):
            result = doctor.check_environment()
        self.assertTrue(result["orchestration_available"])
        self.assertFalse(result["docx_export_available"])
        self.assertFalse(result["ready"])

    def test_missing_pillow_does_not_claim_complete_ready(self):
        with patch.object(doctor, "_package", side_effect=lambda module, distribution:
                          {"available": module == "docx", "version": None}):
            result = doctor.check_environment()
        self.assertTrue(result["docx_export_available"])
        self.assertFalse(result["ready"])

    def test_real_cli_reports_environment_as_json(self):
        result = subprocess.run([sys.executable, str(DOCTOR_SCRIPT), "--json"],
                                capture_output=True, text=True, encoding="utf-8", check=False)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if report["ready"] else 1)
        self.assertEqual(report["python"]["executable"], sys.executable)
        self.assertEqual(set(report["packages"]), {"python-docx", "Pillow"})
        self.assertIn("optional", report)


if __name__ == "__main__":
    unittest.main()
