"""登记只追加的资料快照和原文引用；仅支持单写入者，不访问网络。

哈希证明登记后内容的一致性，不能证明网页确实抓取、原文真实或支持某项结论。
二进制资料须同时提供已提取的 UTF-8 正文；网页须提供实际正文及 HTTP(S) URL。
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
from urllib.parse import urlsplit
import uuid


ROLES = ("tender", "company", "reference", "prior_bid", "framework", "web")
_TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".csv", ".tsv"}
_ENTRY_FIELDS = {
    "source_id", "role", "title", "locator", "original_path", "original_sha256",
    "text_path", "text_sha256", "line_count", "created_at", "extraction",
}
_CITATION_FIELDS = {
    "source_id", "text_sha256", "start_line", "end_line", "quote", "role", "title", "locator",
}


def _workspace(root: Path | str) -> Path:
    path = Path(root).expanduser().resolve()
    if path.exists() and not path.is_dir():
        raise ValueError("工作区必须是目录。")
    return path


def _safe_path(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("资料路径必须是工作区内的相对路径。")
    parts = PurePosixPath(relative).parts
    if PurePosixPath(relative).is_absolute() or any(part in {".", ".."} for part in parts):
        raise ValueError("资料路径不得越过工作区。")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("资料路径不得经过符号链接或目录联接。")
    if not path.resolve().is_relative_to(root):
        raise ValueError("资料路径不得越过工作区。")
    return path


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _positive_integer(value: object, label: str) -> int:
    if type(value) is not int or value < 1:
        raise ValueError(f"{label}必须是从 1 开始的整数。")
    return value


def _text(data: bytes) -> str:
    try:
        text = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError as error:
        raise ValueError("正文必须使用 UTF-8 编码；二进制资料请通过 --text 提供提取结果。") from error
    if not text.strip() or "\x00" in text:
        raise ValueError("正文必须包含非空文本，且不得包含 NUL 字节。")
    return text


def _lines(text: str) -> list[str]:
    lines = text.split("\n")
    return lines[:-1] if lines[-1] == "" else lines


def _url(value: str) -> str:
    if not isinstance(value, str) or value != value.strip() or any(char.isspace() for char in value):
        raise ValueError("网页来源必须使用有效的 HTTP(S) URL。")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("网页来源必须使用不含账号密码的 HTTP(S) URL。")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("网页 URL 的端口无效。") from error
    return value


def _object(value: object, fields: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label}字段不完整或包含不允许的字段。")
    return value


def _read_text(root: Path, entry: dict) -> str:
    data = _safe_path(root, entry["text_path"]).read_bytes()
    if _sha(data) != entry["text_sha256"]:
        raise ValueError(f"来源 {entry['source_id']} 的正文哈希不一致，不能继续引用。")
    text = _text(data)
    if text.encode("utf-8") != data or len(_lines(text)) != entry["line_count"]:
        raise ValueError(f"来源 {entry['source_id']} 的正文编码或行数与登记记录不一致。")
    return text


def load_sources(root: Path | str) -> list[dict]:
    """返回带 1 基 position 的来源；逐项核验结构、快照哈希和工作区内路径。"""
    root = _workspace(root)
    index = _safe_path(root, "sources/index.json")
    if not index.exists():
        return []
    value = _object(json.loads(index.read_text(encoding="utf-8")), {"version", "sources"}, "来源索引")
    if type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["sources"], list):
        raise ValueError("来源索引的版本或资料列表无效。")
    result = []
    ids = set()
    for position, raw in enumerate(value["sources"], 1):
        entry = _object(raw, _ENTRY_FIELDS, "来源记录")
        for field in _ENTRY_FIELDS - {"line_count"}:
            if not isinstance(entry[field], str) or not entry[field].strip():
                raise ValueError(f"来源字段 {field} 必须是非空文本。")
        source_id = entry["source_id"]
        try:
            valid_id = str(uuid.UUID(source_id)) == source_id
        except ValueError:
            valid_id = False
        if not valid_id or source_id in ids:
            raise ValueError("来源身份无效或重复。")
        ids.add(source_id)
        if entry["role"] not in ROLES:
            raise ValueError("来源角色无效。")
        if entry["role"] == "web":
            _url(entry["locator"])
        _positive_integer(entry["line_count"], "来源行数")
        for field in ("original_sha256", "text_sha256"):
            if re.fullmatch(r"[a-f0-9]{64}", entry[field]) is None:
                raise ValueError(f"来源字段 {field} 不是有效的 SHA-256。")
        try:
            created = datetime.fromisoformat(entry["created_at"].replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("来源登记时间无效。") from error
        if created.tzinfo is None:
            raise ValueError("来源登记时间必须包含时区。")
        original = PurePosixPath(entry["original_path"])
        if original.parent != PurePosixPath("sources", source_id) or re.fullmatch(r"original(?:\.[a-z0-9]{1,12})?", original.name) is None:
            raise ValueError("原文件路径与来源身份不一致。")
        if entry["text_path"] != f"sources/{source_id}/text.txt":
            raise ValueError("正文路径与来源身份不一致。")
        if _sha(_safe_path(root, entry["original_path"]).read_bytes()) != entry["original_sha256"]:
            raise ValueError(f"来源 {source_id} 的原文件哈希不一致。")
        _read_text(root, entry)
        result.append({"position": position, **entry})
    return result


def source_at(root: Path | str, pos: int) -> dict:
    """按稳定的 1 基位置取得已验证的来源；越界或非整数位置会被拒绝。"""
    _positive_integer(pos, "来源位置")
    entries = load_sources(root)
    if pos > len(entries):
        raise ValueError(f"来源位置 {pos} 越界，当前共有 {len(entries)} 份资料。")
    return entries[pos - 1]


def bind_citation(root: Path | str, value: dict) -> dict:
    """从来源位置和闭区间行号绑定引用；原文、身份及哈希均由程序生成。"""
    value = _object(value, {"source_position", "start_line", "end_line"}, "引用请求")
    entry = source_at(root, value["source_position"])
    start = _positive_integer(value["start_line"], "起始行")
    end = _positive_integer(value["end_line"], "结束行")
    if end < start or end > entry["line_count"]:
        raise ValueError(f"引用行范围无效，该来源共有 {entry['line_count']} 行。")
    lines = _lines(_read_text(_workspace(root), entry))
    quote = "\n".join(lines[start - 1:end])
    if not quote.strip():
        raise ValueError("引用行范围只有空白，不能作为原文依据。")
    return {
        "source_id": entry["source_id"], "text_sha256": entry["text_sha256"],
        "start_line": start, "end_line": end, "quote": quote,
        "role": entry["role"], "title": entry["title"], "locator": entry["locator"],
    }


def verify_citation(root: Path | str, bound: dict) -> None:
    """核验已绑定引用仍指向同一份快照及原文行范围；不判断原文的事实真伪。"""
    bound = _object(bound, _CITATION_FIELDS, "已绑定引用")
    for field in _CITATION_FIELDS - {"start_line", "end_line"}:
        if not isinstance(bound[field], str):
            raise ValueError(f"引用字段 {field} 必须是文本。")
    _positive_integer(bound["start_line"], "起始行")
    _positive_integer(bound["end_line"], "结束行")
    entries = load_sources(root)
    entry = next((entry for entry in entries if entry["source_id"] == bound["source_id"]), None)
    if entry is None:
        raise ValueError("引用的来源身份不存在。")
    expected = bind_citation(root, {
        "source_position": entry["position"], "start_line": bound["start_line"], "end_line": bound["end_line"],
    })
    if expected != bound:
        raise ValueError("引用的原文、哈希、角色或来源说明与登记快照不一致。")


def _write_index(path: Path, entries: list[dict]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump({"version": 1, "sources": entries}, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def add_source(root: Path | str, file: Path | str, role: str, *, text: Path | str | None = None,
               url: str | None = None, title: str | None = None, extraction: str | None = None) -> dict:
    """保存新版本的原文件与正文后原子追加索引；要求调用方串行登记。"""
    root = _workspace(root)
    if role not in ROLES:
        raise ValueError("来源角色无效。")
    if role == "web" and not url:
        raise ValueError("网页来源必须提供 --url 和实际读取的正文文件。")
    if url is not None:
        _url(url)
    source = Path(file)
    if not source.is_file():
        raise ValueError("--file 必须指向实际存在的原文件。")
    original = source.read_bytes()
    if not original:
        raise ValueError("原文件不能为空。")
    if text is None and source.suffix.lower() not in _TEXT_SUFFIXES:
        raise ValueError("该格式需要通过 --text 提供已提取的 UTF-8 正文。")
    body = _text(original if text is None else Path(text).read_bytes())
    for label, value in (("标题", title), ("提取方式", extraction)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f"{label}必须是非空文本。")
    entries = [{key: value for key, value in entry.items() if key != "position"} for entry in load_sources(root)]
    source_id = str(uuid.uuid4())
    suffix = source.suffix.lower()
    suffix = suffix if re.fullmatch(r"\.[a-z0-9]{1,12}", suffix) else ""
    entry = {
        "source_id": source_id, "role": role, "title": title or source.name,
        "locator": url or source.name, "original_path": f"sources/{source_id}/original{suffix}",
        "original_sha256": _sha(original), "text_path": f"sources/{source_id}/text.txt",
        "text_sha256": _sha(body.encode("utf-8")), "line_count": len(_lines(body)),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "extraction": extraction or ("外部提取正文" if text is not None else "UTF-8 原文"),
    }
    directory = _safe_path(root, f"sources/{source_id}")
    directory.mkdir(parents=True, exist_ok=False)
    for relative, data in ((entry["original_path"], original), (entry["text_path"], body.encode("utf-8"))):
        with _safe_path(root, relative).open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    _write_index(_safe_path(root, "sources/index.json"), [*entries, entry])
    return {"position": len(entries) + 1, **entry}


def main(argv: list[str] | None = None) -> int:
    """执行 add/list/read；成功输出 JSON，输入或文件错误输出到 stderr 并返回 2。"""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="串行追加一份新来源，保留所有旧版本")
    add.add_argument("workspace")
    add.add_argument("--file", required=True)
    add.add_argument("--role", choices=ROLES, required=True)
    add.add_argument("--text")
    add.add_argument("--url")
    add.add_argument("--title")
    add.add_argument("--extraction")
    listing = commands.add_parser("list", help="列出并验证全部来源")
    listing.add_argument("workspace")
    reading = commands.add_parser("read", help="读取带原文行号的资料窗口")
    reading.add_argument("workspace")
    reading.add_argument("--source", type=int, required=True)
    reading.add_argument("--start", type=int, default=1)
    reading.add_argument("--end", type=int)
    args = parser.parse_args(argv)
    try:
        if args.command == "add":
            result = add_source(args.workspace, args.file, args.role, text=args.text, url=args.url,
                                title=args.title, extraction=args.extraction)
        elif args.command == "list":
            result = {"sources": load_sources(args.workspace)}
        else:
            entry = source_at(args.workspace, args.source)
            bound = bind_citation(args.workspace, {
                "source_position": args.source, "start_line": args.start,
                "end_line": entry["line_count"] if args.end is None else args.end,
            })
            result = {"source_position": args.source, **bound,
                      "lines": [{"line": number, "text": line} for number, line in
                                enumerate(bound["quote"].split("\n"), bound["start_line"])]}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
