#!/usr/bin/env python3
"""核对标书目录的结构和招标分析位置覆盖。"""

import argparse
import json
import sys
import unicodedata
from pathlib import Path


def normalized(value):
    return "".join(char.lower() for char in unicodedata.normalize("NFKC", value) if char.isalnum())


def text(value, label, problems):
    if not isinstance(value, str) or not value.strip():
        problems.append(f"{label} 必须是非空文字")
        return ""
    return value


def objects(value, label, problems):
    if not isinstance(value, list):
        problems.append(f"{label} 必须是数组")
        return []
    for index, item in enumerate(value, 1):
        if not isinstance(item, dict):
            problems.append(f"{label} 第 {index} 项必须是对象")
    return [item if isinstance(item, dict) else {} for item in value]


def positions(value, label, upper, problems):
    if not isinstance(value, list):
        problems.append(f"{label} 必须是位置数组")
        return []
    result = []
    for position in value:
        if type(position) is not int or position < 1 or position > upper:
            problems.append(f"{label} 包含无效位置 {position!r}")
        elif position in result:
            problems.append(f"{label} 重复引用位置 {position}")
        else:
            result.append(position)
    return result


def verify(data):
    problems = []
    if not isinstance(data, dict):
        return ["根值必须是对象"], {}

    requirements = objects(data.get("requirements"), "requirements", problems)
    scoring = objects(data.get("scoring"), "scoring", problems)
    compliance = objects(data.get("compliance"), "compliance", problems)
    sections = objects(data.get("sections"), "sections", problems)
    if not sections:
        problems.append("sections 至少需要一个章节")

    for index, item in enumerate(requirements, 1):
        text(item.get("text"), f"要求 {index} 的 text", problems)
        if type(item.get("mandatory")) is not bool:
            problems.append(f"要求 {index} 的 mandatory 必须是布尔值")
    response_parents = []
    for index, item in enumerate(scoring, 1):
        text(item.get("title"), f"评分项 {index} 的 title", problems)
        points = item.get("response_points")
        if not isinstance(points, list) or not points:
            problems.append(f"评分项 {index} 至少需要一个响应点")
            continue
        for point_index, point in enumerate(points, 1):
            text(point, f"评分项 {index} 的响应点 {point_index}", problems)
            response_parents.append(index)
    for index, item in enumerate(compliance, 1):
        text(item.get("text"), f"合规项 {index} 的 text", problems)

    parent_positions = []
    writable_positions = set()
    mapped = {name: set() for name in ("requirements", "scoring", "response_points", "compliance")}
    mapped_writable = {name: set() for name in mapped}
    seen_titles = set()
    for index, section in enumerate(sections, 1):
        title = text(section.get("title"), f"章节 {index} 的 title", problems)
        parent = section.get("parent_position")
        if parent is not None and (type(parent) is not int or parent < 1 or parent > len(sections) or parent == index):
            problems.append(f"章节 {index} 的 parent_position 无效")
            parent = None
        parent_positions.append(parent)
        title_key = (parent, normalized(title))
        if title and title_key in seen_titles:
            problems.append(f"章节 {index} 与同级章节标题重复")
        seen_titles.add(title_key)

        writable = section.get("writable")
        if type(writable) is not bool:
            problems.append(f"章节 {index} 的 writable 必须是布尔值")
            writable = False
        if writable:
            writable_positions.add(index)
        answers = section.get("must_answer")
        if not isinstance(answers, list):
            problems.append(f"章节 {index} 的 must_answer 必须是数组")
            answers = []
        for answer_index, answer in enumerate(answers, 1):
            text(answer, f"章节 {index} 的必答问题 {answer_index}", problems)
        if writable and not answers:
            problems.append(f"可写章节 {index} 缺少必答问题")
        if not writable and answers:
            problems.append(f"结构章节 {index} 不应承载必答问题")

        for name, key, upper in (
            ("requirements", "requirement_positions", len(requirements)),
            ("scoring", "scoring_positions", len(scoring)),
            ("response_points", "response_point_positions", len(response_parents)),
            ("compliance", "compliance_positions", len(compliance)),
        ):
            values = positions(section.get(key), f"章节 {index} 的 {key}", upper, problems)
            mapped[name].update(values)
            if writable:
                mapped_writable[name].update(values)
            if name == "response_points":
                scoring_values = section.get("scoring_positions")
                for position in values:
                    if not isinstance(scoring_values, list) or response_parents[position - 1] not in scoring_values:
                        problems.append(f"章节 {index} 的响应点 {position} 缺少所属评分项")

    children = {parent for parent in parent_positions if parent is not None}
    for index in range(1, len(sections) + 1):
        if index in writable_positions and index in children:
            problems.append(f"可写章节 {index} 不能有子章节")
        if index not in writable_positions and index not in children:
            problems.append(f"结构章节 {index} 缺少子章节")
        visited = set()
        current = index
        while current is not None and current not in visited:
            visited.add(current)
            current = parent_positions[current - 1]
        if current is not None:
            problems.append(f"章节 {index} 存在父子循环")

    for position, requirement in enumerate(requirements, 1):
        if position not in mapped["requirements"]:
            problems.append(f"要求 {position} 未分配章节")
        if requirement.get("mandatory") is True and position not in mapped_writable["requirements"]:
            problems.append(f"强制要求 {position} 未落在可写章节")
    for position in range(1, len(scoring) + 1):
        if position not in mapped_writable["scoring"]:
            problems.append(f"评分项 {position} 未落在可写章节")
    for position in range(1, len(response_parents) + 1):
        if position not in mapped_writable["response_points"]:
            problems.append(f"响应点 {position} 未落在可写章节")
    global_compliance = positions(data.get("global_compliance_positions"), "global_compliance_positions", len(compliance), problems)
    for position in range(1, len(compliance) + 1):
        if position not in mapped["compliance"] and position not in global_compliance:
            problems.append(f"合规项 {position} 未分配章节或全书")

    return problems, {"sections": len(sections), "requirements": len(requirements),
                      "scoring": len(scoring), "response_points": len(response_parents),
                      "compliance": len(compliance)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="包含 requirements、scoring、compliance、sections 的 JSON 文件")
    args = parser.parse_args()
    try:
        data = json.loads(args.file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        parser.exit(2, f"无法读取目录检查输入：{error}\n")
    problems, counts = verify(data)
    print(json.dumps({"ok": not problems, "counts": counts, "issues": problems}, ensure_ascii=False, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
