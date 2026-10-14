#!/usr/bin/env python3
"""独立标书项目的阶段、产物和用户确认记录。仅依赖 Python 标准库。"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from export_docx import write_docx
from render_preview import preview_name, render as render_preview
from verify_outline import verify as verify_outline


STAGES = (
    'file_intake', 'tender_analysis', 'initial_outline',
    'evidence_mapping', 'chapter_writing', 'docx_export',
)
ARTIFACTS = (
    '01-intake.json', '02-analysis.json', '03-initial-outline.json',
    '04-final-outline.json', '05-manuscript.json',
)


class WorkflowError(Exception):
    """可由用户或 Agent 修正的输入与阶段错误。"""


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(contents):
    return hashlib.sha256(contents).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def atomic_write(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(contents)
    os.replace(temporary, path)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WorkflowError(f'无法读取 JSON：{path}：{error}') from error


def load(root):
    state = read_json(root / 'state.json')
    if state.get('version') != 1 or not isinstance(state.get('sources'), list) or not isinstance(state.get('stages'), list) or len(state['stages']) != len(STAGES):
        raise WorkflowError('项目状态格式无效')
    return state


def save(root, state):
    atomic_write(root / 'state.json', json_bytes(state))


def preview_path(root, index):
    return root / 'previews' / preview_name(index, STAGES)


def remove_previews(root, start):
    for index in range(start, len(STAGES)):
        preview_path(root, index).unlink(missing_ok=True)


def write_preview(root, state, index, data):
    path = preview_path(root, index)
    context = {}
    if index >= 2:
        context['analysis'] = previous(root, 1)
    if index >= 4:
        context['outline'] = previous(root, 3)
    atomic_write(path, render_preview(index, data, state, STAGES, context).encode('utf-8'))
    return str(path)


def preview_artifact(root, state, index):
    entry = state['stages'][index]
    artifact = root / entry['artifact']
    if index < 5:
        return read_json(artifact)
    return {'file': str(artifact), 'size': artifact.stat().st_size, 'sha256': entry['sha256']}


def check_sources(root, state):
    for source in state['sources']:
        path = root / source['path']
        if not path.is_file() or digest(path.read_bytes()) != source['sha256']:
            raise WorkflowError(f'输入文件已丢失或改变：{source["path"]}；请重新建立项目或重新加入该资料')


def add_file(root, state, source_path, role):
    source_path = Path(source_path).resolve()
    if not source_path.is_file() or source_path.stat().st_size == 0:
        raise WorkflowError(f'资料不存在或为空：{source_path}')
    number = len(state['sources']) + 1
    relative = f'inputs/{number:03d}-{source_path.name}'
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source_path != target.resolve():
        shutil.copyfile(source_path, target)
    state['sources'].append({
        'path': relative, 'original_name': source_path.name,
        'role': role, 'sha256': digest(target.read_bytes()),
    })


def init(args):
    root = Path(args.workspace).resolve()
    if (root / 'state.json').exists():
        raise WorkflowError('项目已存在；使用 status、submit 或 add-source 继续')
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise WorkflowError('工作目录必须为空；请为本次标书选择独立目录')
    sources = [('tender', value) for value in args.tender]
    sources += [('framework', value) for value in args.framework]
    sources += [('prior_bid', value) for value in args.prior_bid]
    sources += [('reference', value) for value in args.reference]
    for _, value in sources:
        if not Path(value).is_file() or Path(value).stat().st_size == 0:
            raise WorkflowError(f'资料不存在或为空：{value}')
    state = {'version': 1, 'created_at': now(), 'sources': [], 'stages': [None] * len(STAGES)}
    for role, value in sources:
        add_file(root, state, value, role)
    candidate = {'files': [
        {'path': item['path'], 'role': item['role'], 'readable': False, 'issue': '待检查'}
        for item in state['sources']
    ], 'inspection': '逐份检查正文、评分和附件；标注无法读取的位置。'}
    atomic_write(root / 'artifacts' / ARTIFACTS[0], json_bytes(candidate))
    save(root, state)
    return {'workspace': str(root), 'stage': STAGES[0], 'candidate': str(root / 'artifacts' / ARTIFACTS[0])}


def add_source(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    add_file(root, state, args.file, args.role)
    candidate_path = root / 'artifacts' / ARTIFACTS[0]
    candidate = read_json(candidate_path)
    candidate['files'].append({
        'path': state['sources'][-1]['path'], 'role': args.role,
        'readable': False, 'issue': '待检查',
    })
    atomic_write(candidate_path, json_bytes(candidate))
    state['stages'] = [None] * len(STAGES)
    remove_previews(root, 0)
    save(root, state)
    return {'added': state['sources'][-1]['path'], 'stage': STAGES[0], 'candidate': str(candidate_path)}


def required_string(value, label, issues):
    if not isinstance(value, str) or not value.strip():
        issues.append(f'{label} 必须是非空文字')


def required_source(value, label, valid_files, issues):
    if not isinstance(value, dict):
        issues.append(f'{label} 必须包含 file 和 location')
        return
    if value.get('file') not in valid_files:
        issues.append(f'{label}.file 必须指向已入库的招标文件')
    required_string(value.get('location'), f'{label}.location', issues)


def previous(root, index):
    return read_json(root / 'artifacts' / ARTIFACTS[index])


def outline_input(root, outline, issues):
    analysis = previous(root, 1)
    scores = analysis.get('scoring', [])
    points = outline.get('response_points')
    if not isinstance(points, list) or len(points) != len(scores):
        issues.append('response_points 必须逐项对应已确认的评分项')
        points = [[] for _ in scores]
    combined = {
        'requirements': analysis.get('requirements'),
        'scoring': [{**score, 'response_points': value} for score, value in zip(scores, points)],
        'compliance': analysis.get('compliance'),
        'sections': outline.get('sections'),
        'global_compliance_positions': outline.get('global_compliance_positions'),
    }
    outline_issues, counts = verify_outline(combined)
    issues.extend(outline_issues)
    return combined, counts


def positioned_items(value, expected, label, issues):
    if not isinstance(value, list):
        issues.append(f'{label} 必须是数组')
        return None
    positions = []
    for number, item in enumerate(value, 1):
        if not isinstance(item, dict) or type(item.get('section_position')) is not int:
            issues.append(f'{label}[{number}].section_position 必须是章节位置')
            return None
        positions.append(item['section_position'])
    if len(positions) != len(expected) or set(positions) != set(expected):
        issues.append(f'{label} 必须逐一覆盖每个可写章节')
        return None
    return value


def validate(root, state, index, data):
    issues = []
    if not isinstance(data, dict):
        raise WorkflowError('阶段产物根值必须是对象')
    sources = state['sources']
    if index == 0:
        files = data.get('files')
        if not isinstance(files, list) or len(files) != len(sources):
            issues.append('files 必须逐份列出已入库资料')
        else:
            for number, (item, source) in enumerate(zip(files, sources), 1):
                if not isinstance(item, dict) or item.get('path') != source['path'] or item.get('role') != source['role']:
                    issues.append(f'资料 {number} 的路径或角色与原始清单不一致')
                    continue
                if type(item.get('readable')) is not bool:
                    issues.append(f'资料 {number} 的 readable 必须是布尔值')
                if not item.get('readable'):
                    required_string(item.get('issue'), f'资料 {number} 的 issue', issues)
            if not any(item.get('readable') is True and source['role'] == 'tender' for item, source in zip(files, sources) if isinstance(item, dict)):
                issues.append('至少一份招标文件必须成功读取')
        required_string(data.get('inspection'), 'inspection', issues)
    elif index == 1:
        project = data.get('project')
        if not isinstance(project, dict):
            issues.append('project 必须是对象')
        else:
            required_string(project.get('summary'), 'project.summary', issues)
        tender_files = {item['path'] for item in sources if item['role'] == 'tender'}
        for key in ('requirements', 'scoring', 'compliance'):
            entries = data.get(key)
            if not isinstance(entries, list) or (key == 'requirements' and not entries):
                issues.append(f'{key} 必须是数组，requirements 不可为空')
                continue
            for number, item in enumerate(entries, 1):
                if not isinstance(item, dict):
                    issues.append(f'{key}[{number}] 必须是对象')
                    continue
                required_string(item.get('text' if key != 'scoring' else 'title'), f'{key}[{number}] 内容', issues)
                required_source(item.get('source'), f'{key}[{number}].source', tender_files, issues)
                if key == 'requirements' and type(item.get('mandatory')) is not bool:
                    issues.append(f'{key}[{number}].mandatory 必须是布尔值')
                if key == 'scoring':
                    required_string(item.get('original_text'), f'{key}[{number}].original_text', issues)
    elif index in (2, 3):
        combined, _ = outline_input(root, data, issues)
        if index == 3 and not issues:
            research = data.get('research')
            writable = {position for position, section in enumerate(combined['sections'], 1) if section['writable']}
            if positioned_items(research, writable, 'research', issues) is not None:
                allowed = {item['path'] for item in sources}
                for item in research:
                    position = item['section_position']
                    required_string(item.get('answer_plan'), f'章节 {position} 的 answer_plan', issues)
                    missing = item.get('missing_topics')
                    if not isinstance(missing, list) or any(not isinstance(topic, str) for topic in missing):
                        issues.append(f'章节 {position} 的 missing_topics 必须是文字数组')
                    evidence = item.get('evidence')
                    if not isinstance(evidence, list):
                        issues.append(f'章节 {position} 的 evidence 必须是数组')
                        continue
                    if not evidence and not missing:
                        issues.append(f'章节 {position} 缺少证据且未说明缺口')
                    for source in evidence:
                        if not isinstance(source, dict):
                            issues.append(f'章节 {position} 的 evidence 条目必须是对象')
                            continue
                        web = isinstance(source.get('url'), str) and source['url'].startswith(('http://', 'https://'))
                        if source.get('file') not in allowed and not web:
                            issues.append(f'章节 {position} 的 evidence 必须指向已入库文件或公开网址')
                        if web:
                            required_string(source.get('accessed_at'), f'章节 {position} 的 evidence.accessed_at', issues)
                        required_string(source.get('location'), f'章节 {position} 的 evidence.location', issues)
                        required_string(source.get('use'), f'章节 {position} 的 evidence.use', issues)
    elif index == 4:
        outline = previous(root, 3)
        combined, _ = outline_input(root, outline, issues)
        writable = {position: section for position, section in enumerate(combined['sections'], 1) if section['writable']}
        chapters = data.get('chapters')
        if positioned_items(chapters, writable, 'chapters', issues) is not None:
            for chapter in chapters:
                position = chapter['section_position']
                required_string(chapter.get('body'), f'章节 {position} 的 body', issues)
                if chapter.get('review') != 'passed':
                    issues.append(f'章节 {position} 的 review 必须是 passed')
                for field, mapped in (
                    ('answered_requirement_positions', 'requirement_positions'),
                    ('answered_response_point_positions', 'response_point_positions'),
                ):
                    values = chapter.get(field)
                    if not isinstance(values, list) or any(type(value) is not int for value in values) or set(values) != set(writable[position][mapped]):
                        issues.append(f'章节 {position} 的 {field} 与目录归属不一致')
        review = data.get('whole_book_review')
        if not isinstance(review, dict) or review.get('result') != 'passed' or review.get('issues') != []:
            issues.append('whole_book_review 必须通过且没有未解决问题')
    if issues:
        raise WorkflowError('阶段产物未通过校验：\n- ' + '\n- '.join(issues))


def stage_index(value):
    if value not in STAGES:
        raise WorkflowError('未知阶段；可用阶段：' + ', '.join(STAGES))
    return STAGES.index(value)


def require_previous(root, state, index):
    for previous_index in range(index):
        entry = state['stages'][previous_index]
        if not entry or entry['status'] != 'confirmed':
            raise WorkflowError(f'前一阶段尚未确认：{STAGES[previous_index]}')
        artifact = root / entry['artifact']
        if not artifact.is_file() or digest(artifact.read_bytes()) != entry['sha256']:
            raise WorkflowError(f'已确认产物发生改变：{STAGES[previous_index]}；请重新提交并确认')


def submit(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    index = stage_index(args.stage)
    if index == 5:
        raise WorkflowError('DOCX 阶段使用 export 命令')
    require_previous(root, state, index)
    data = read_json(Path(args.file))
    validate(root, state, index, data)
    target = root / 'artifacts' / ARTIFACTS[index]
    contents = json_bytes(data)
    atomic_write(target, contents)
    state['stages'][index:] = [None] * (len(STAGES) - index)
    state['stages'][index] = {
        'status': 'submitted', 'artifact': str(target.relative_to(root)),
        'sha256': digest(contents), 'submitted_at': now(),
    }
    remove_previews(root, index + 1)
    preview = write_preview(root, state, index, data)
    save(root, state)
    return {'stage': args.stage, 'status': 'submitted', 'artifact': str(target),
            'preview': preview, 'next_action': '打开 HTML 预览，询问用户确认或修改'}


def confirm(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    index = stage_index(args.stage)
    require_previous(root, state, index)
    entry = state['stages'][index]
    if not entry or entry['status'] != 'submitted':
        raise WorkflowError('当前阶段没有待确认的最新产物')
    artifact = root / entry['artifact']
    if not artifact.is_file() or digest(artifact.read_bytes()) != entry['sha256']:
        raise WorkflowError('产物在提交后改变；请重新提交并重新展示给用户')
    if not args.user_confirmation.strip():
        raise WorkflowError('必须填写用户对当前阶段产物的明确确认原话')
    entry['status'] = 'confirmed'
    entry['confirmation'] = {'user_words': args.user_confirmation.strip(), 'at': now()}
    preview = write_preview(root, state, index, preview_artifact(root, state, index))
    save(root, state)
    return {'stage': args.stage, 'status': 'confirmed', 'preview': preview,
            'next_stage': STAGES[index + 1] if index + 1 < len(STAGES) else None}


def export(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    require_previous(root, state, 5)
    outline = previous(root, 3)
    manuscript = previous(root, 4)
    for index in (3, 4):
        artifact = root / state['stages'][index]['artifact']
        if digest(artifact.read_bytes()) != state['stages'][index]['sha256']:
            raise WorkflowError(f'{STAGES[index]} 的产物被修改；请重新提交')
    chapters = {item['section_position']: item['body'] for item in manuscript['chapters']}
    title = args.title or previous(root, 1).get('project', {}).get('title') or '标书'
    output = root / 'output' / f'标书-{state["stages"][4]["sha256"][:8]}.docx'
    write_docx(title, outline['sections'], chapters, output)
    state['stages'][5] = {
        'status': 'submitted', 'artifact': str(output.relative_to(root)),
        'sha256': digest(output.read_bytes()), 'submitted_at': now(),
    }
    preview = write_preview(root, state, 5, preview_artifact(root, state, 5))
    save(root, state)
    return {'stage': STAGES[5], 'status': 'submitted', 'file': str(output),
            'preview': preview, 'next_action': '打开 HTML 预览与 DOCX，检查版面后请用户验收'}


def submit_docx(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    require_previous(root, state, 5)
    source = Path(args.file).resolve()
    if source.suffix.lower() != '.docx' or not source.is_file():
        raise WorkflowError('最终文件必须是存在的 DOCX')
    try:
        with ZipFile(source) as archive:
            if archive.testzip() is not None or 'word/document.xml' not in archive.namelist():
                raise WorkflowError('DOCX 包损坏或缺少正文')
    except BadZipFile as error:
        raise WorkflowError('DOCX 包无法打开') from error
    contents = source.read_bytes()
    target = root / 'output' / f'标书-终版-{digest(contents)[:8]}.docx'
    atomic_write(target, contents)
    state['stages'][5] = {
        'status': 'submitted', 'artifact': str(target.relative_to(root)),
        'sha256': digest(contents), 'submitted_at': now(),
    }
    preview = write_preview(root, state, 5, preview_artifact(root, state, 5))
    save(root, state)
    return {'stage': STAGES[5], 'status': 'submitted', 'file': str(target),
            'preview': preview, 'next_action': '打开 HTML 预览与 DOCX，检查版面后请用户验收'}


def status(args):
    root = Path(args.workspace).resolve()
    state = load(root)
    check_sources(root, state)
    entries = []
    for name, entry in zip(STAGES, state['stages']):
        if entry is None:
            entries.append({'stage': name, 'status': 'pending'})
            continue
        artifact = root / entry['artifact']
        actual = digest(artifact.read_bytes()) if artifact.is_file() else None
        preview = preview_path(root, len(entries))
        entries.append({'stage': name, 'status': entry['status'] if actual == entry['sha256'] else 'changed',
                        'artifact': str(artifact), 'preview': str(preview) if preview.is_file() else None})
    current = next((item['stage'] for item in entries if item['status'] != 'confirmed'), None)
    return {'workspace': str(root), 'current_stage': current, 'stages': entries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    start = commands.add_parser('init', help='建立项目并复制招标资料')
    start.add_argument('workspace')
    for flag in ('tender', 'framework', 'prior-bid', 'reference'):
        start.add_argument('--' + flag, action='append', default=[], required=flag == 'tender')
    start.set_defaults(func=init)
    add = commands.add_parser('add-source', help='加入资料并退回文件接入阶段')
    add.add_argument('workspace')
    add.add_argument('--role', required=True, choices=('tender', 'framework', 'prior_bid', 'reference'))
    add.add_argument('--file', required=True)
    add.set_defaults(func=add_source)
    send = commands.add_parser('submit', help='校验并提交阶段 JSON 产物')
    send.add_argument('workspace')
    send.add_argument('stage', choices=STAGES[:-1])
    send.add_argument('file')
    send.set_defaults(func=submit)
    approve = commands.add_parser('confirm', help='记录用户对最新阶段产物的明确确认')
    approve.add_argument('workspace')
    approve.add_argument('stage', choices=STAGES)
    approve.add_argument('--user-confirmation', required=True)
    approve.set_defaults(func=confirm)
    output = commands.add_parser('export', help='从已确认正文生成 DOCX')
    output.add_argument('workspace')
    output.add_argument('--title')
    output.set_defaults(func=export)
    final = commands.add_parser('submit-docx', help='提交文档工具处理后的最终 DOCX')
    final.add_argument('workspace')
    final.add_argument('file')
    final.set_defaults(func=submit_docx)
    view = commands.add_parser('status', help='读取阶段与确认状态')
    view.add_argument('workspace')
    view.set_defaults(func=status)
    args = parser.parse_args()
    try:
        print(json.dumps(args.func(args), ensure_ascii=False, indent=2))
    except WorkflowError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
