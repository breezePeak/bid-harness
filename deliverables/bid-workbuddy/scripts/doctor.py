"""检查本地运行条件；不安装依赖，不启动 Office，也不执行文档渲染。"""

import argparse
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import shutil
import sys


def _package(module, distribution):
    try:
        available = importlib.util.find_spec(module) is not None
    except (ImportError, ValueError, AttributeError):
        available = False
    try:
        version = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        version = None
    return {"available": available, "version": version}


def _command(*names):
    return next((path for name in names if (path := shutil.which(name))), None)


def _word_compatible_registered():
    if sys.platform != "win32":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Word.Application\CLSID") as key:
            return bool(winreg.QueryValue(key, None))
    except OSError:
        return False


def check_environment():
    """返回解释器、必需包和可选渲染工具的发现结果；ready 不代表已通过版面验收。"""
    python_ready = sys.version_info >= (3, 10) and Path(sys.executable).is_file()
    packages = {"python-docx": _package("docx", "python-docx"), "Pillow": _package("PIL", "Pillow")}
    docx_ready = python_ready and packages["python-docx"]["available"]
    ready = docx_ready and packages["Pillow"]["available"]
    missing = [name for name, value in packages.items() if not value["available"]]
    messages = []
    if not python_ready:
        messages.append("请选择 Python 3.10 及以上的实际可执行文件；当前解释器不满足运行条件。")
    if python_ready and not docx_ready:
        messages.append("编排和来源校验可用；缺少 python-docx，DOCX 导出不可用。")
    if not packages["Pillow"]["available"]:
        messages.append("缺少 Pillow，图片处理与完整文档交付条件尚未就绪。")
    if missing:
        messages.append("安装依赖需要用户授权；检查器不会自动安装。")
    if ready:
        messages.append("Python 和依赖已找到；实际导出及页面效果仍须验证。")
    return {
        "ready": bool(ready), "orchestration_available": bool(python_ready),
        "docx_export_available": bool(docx_ready),
        "python": {"executable": sys.executable, "version": sys.version.split()[0], "minimum": "3.10",
                   "available": bool(python_ready)},
        "packages": packages,
        "optional": {
            "word_compatible_com_registered": _word_compatible_registered(),
            "libreoffice": _command("libreoffice", "soffice", "soffice.exe"),
            "pdftoppm": _command("pdftoppm", "pdftoppm.exe"),
            "pdftocairo": _command("pdftocairo", "pdftocairo.exe"),
            "mutool": _command("mutool", "mutool.exe"),
        },
        "messages": messages,
        "limitations": ["仅检查包与工具是否可发现，不证明导出或渲染成功。",
                        "Word.Application 兼容注册可由 WPS 提供，不证明 Microsoft Word 存在或 PDF 转换可用；命令检查仅覆盖 PATH。",
                        "WorkBuddy 的搜索、网页读取、文档读取和 OCR 工具须在实际会话中确认。"],
    }


def main(argv=None):
    """输出检查结果；完整依赖可发现时返回 0，缺少条件返回 1，参数错误返回 2。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args(argv)
    result = check_environment()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("完整运行条件：" + ("已找到" if result["ready"] else "尚未就绪"))
        print("Python：" + result["python"]["executable"] + "（" + result["python"]["version"] + "）")
        for name, value in result["packages"].items():
            print(name + "：" + ((value["version"] or "可发现") if value["available"] else "缺失"))
        for name, value in result["optional"].items():
            print(name + "：" + (str(value) if value else "未发现（可选）"))
        for message in result["messages"] + result["limitations"]:
            print(message)
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
