#!/usr/bin/env python3
"""标书产物的接纳、来源绑定、逐章复核及交付清单；语义判断由执行 Agent 提交。"""

import argparse
import hashlib
import html
import json
import os
import re
import sys
import uuid
from pathlib import Path

from sources import bind_citation, load_sources, verify_citation


OPERATIONS = ('analysis', 'outline', 'research', 'chapter', 'patch', 'review', 'final-review')
QUALITY = ('specificity', 'feasibility', 'consistency', 'bidder_voice', 'no_padding', 'source_scope')
BOOK_QUALITY = ('terminology', 'parameters', 'schedule', 'responsibilities', 'duplication', 'scoring_visibility', 'format_requirements')
VERDICTS = ('met', 'unmet', 'needs_input')


class InputError(ValueError):
    """可修正的输入、过期请求或项目完整性错误。"""


def require(condition, message):
    if not condition:
        raise InputError(message)


def text(value, name):
    require(isinstance(value, str) and bool(value.strip()), f'{name} 必须是非空文字')
    return value.strip()


def array(value, name):
    require(isinstance(value, list), f'{name} 必须是数组')
    return value


def obj(value, name, allowed, required=()):
    require(isinstance(value, dict), f'{name} 必须是对象')
    require(not (set(value) - set(allowed)), f'{name} 存在未知字段：{sorted(set(value) - set(allowed))}')
    require(set(required).issubset(value), f'{name} 缺少字段：{sorted(set(required) - set(value))}')
    return value


def choose(items, position, name):
    require(type(position) is int and 1 <= position <= len(items), f'{name} 位置越界；先读取当前对象表')
    return items[position - 1]


def positions(items, values, name):
    values = array(values, name)
    require(all(type(value) is int for value in values), f'{name} 只能包含整数位置')
    require(len(values) == len(set(values)), f'{name} 不允许重复位置')
    return [choose(items, value, name)['id'] for value in values]


def hash_value(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.bid-' + uuid.uuid4().hex[:12] + '.tmp')
    temporary.write_text(value, encoding='utf-8', newline='\n')
    os.replace(temporary, path)


def write_json(path, value):
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def inside(root, relative):
    root = Path(root).resolve()
    relative = Path(relative)
    require(not relative.is_absolute(), '项目文件须使用工作目录内的相对路径')
    target = (root / relative).resolve()
    require(target.is_relative_to(root) and target != root, '文件路径超出项目目录')
    return target


def load(root):
    state = read_json(inside(root, 'project.json'))
    require(state.get('version') == 1 and type(state.get('revision')) is int, '项目格式不支持；请使用匹配版本的技能')
    return state


def save(root, state):
    old = load(root)
    write_json(inside(root, f'history/{old["revision"]:06d}.json'), old)
    state['revision'] = old['revision'] + 1
    write_json(inside(root, 'project.json'), state)


def identity(item, prior, used):
    position = item.get('existing_position')
    result = uuid.uuid4().hex if position is None else choose(prior, position, 'existing_position')['id']
    require(result not in used, '同一旧对象不能被重复使用')
    used.add(result)
    return result


def citations(root, values, source_count):
    result = []
    for value in array(values, 'citations'):
        obj(value, 'citation', ('source_position', 'start_line', 'end_line'), ('source_position', 'start_line', 'end_line'))
        require(type(value['source_position']) is int and 1 <= value['source_position'] <= source_count,
                '引用不属于请求中的来源表；登记新资料后重新 prepare')
        bound = bind_citation(root, value)
        require(bool(bound['quote'].strip()), '来源引用不得只包含空白行')
        result.append(bound)
    return result


def numbered(items):
    return [{'position': index, **item} for index, item in enumerate(items, 1)]


def outline_sections(state):
    return (state.get('outline') or {}).get('sections', [])


def checklist(state, section):
    result = [{'key': 'task:' + hash_value(value), 'kind': 'must_answer', 'text': value}
              for value in section['must_answer']]
    for kind, field, records in (
        ('requirement', 'requirements', state['analysis']['requirements']),
        ('response_point', 'response_points', state['outline']['response_points']),
        ('compliance', 'compliance', state['analysis']['compliance']),
    ):
        by_id = {record['id']: record for record in records}
        for reference in section[field]:
            require(reference in by_id, '目录引用的招标条目已变；请更新目录')
            result.append({'key': reference, 'kind': kind, 'text': by_id[reference]['text']})
    return numbered(result)


def section_context(state, section):
    ancestors = []
    sections = {item['id']: item for item in outline_sections(state)}
    parent = section['parent_id']
    while parent is not None:
        ancestors.append(sections[parent]['title'])
        parent = sections[parent]['parent_id']
    return hash_value({'section': section, 'ancestors': ancestors,
                       'analysis': state['analysis'], 'checklist': checklist(state, section)})


def body_text(root, chapter):
    body = inside(root, chapter['path']).read_text(encoding='utf-8')
    require(hash_value(body) == chapter['body_hash'], '已接纳正文被外部修改；请通过 chapter 接纳新稿')
    for item in chapter.get('images', []):
        require(hashlib.sha256(inside(root, item['path']).read_bytes()).hexdigest() == item['sha256'],
                f'正文图片已变化：{item["path"]}；重新接纳章节并复核')
    return body


def images(root, body):
    result = []
    for value in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', body):
        path = inside(root, value)
        require(path.is_file(), f'正文图片不存在：{value}')
        result.append({'path': value, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return result


def quote(body, span):
    obj(span, '正文范围', ('start_line', 'end_line'), ('start_line', 'end_line'))
    start, end = span['start_line'], span['end_line']
    lines = body.splitlines()
    require(type(start) is int and type(end) is int and 1 <= start <= end <= len(lines), '正文引用行范围无效')
    value = '\n'.join(lines[start - 1:end])
    require(bool(value.strip()), '正文引用不可为空')
    return {**span, 'quote': value}


def source_scope(kind, sources):
    allowed = {
        'company_fact': {'company'}, 'requirement': {'tender'},
        'technical_fact': {'tender', 'company', 'reference', 'prior_bid', 'web'},
        'proposal': {'tender', 'company', 'reference', 'prior_bid', 'web'},
    }
    require(kind in allowed, 'claim_type 只能为 company_fact、requirement、technical_fact、proposal')
    require(kind == 'proposal' or bool(sources), '事实或要求必须有来源')
    require(all(source['role'] in allowed[kind] for source in sources), '资料角色不能证明该声明；框架不证明事实，公开资料不证明企业事实')


def dependency_hashes(state, section):
    chapters = state['chapters']
    return {key: chapters.get(key, {}).get('body_hash') for key in section['dependencies']}


def chapter_issues(root, state, section):
    issues = []
    context = section_context(state, section)
    research = state['research'].get(section['id'])
    if not research or research['context'] != context:
        issues.append('章节研究缺失或已过期')
    elif research['readiness'] != 'ready' or any(item['mode'] == 'gap' for item in research['answers']):
        issues.append('章节仍有资料缺口或搜索阻断')
    chapter = state['chapters'].get(section['id'])
    if not chapter:
        return issues + ['正文未接纳']
    body_text(root, chapter)
    for use in chapter['uses']:
        for citation in use['citations']:
            verify_citation(root, citation)
    if chapter['context'] != context or chapter['research_hash'] != hash_value(research):
        issues.append('正文对应的目录、要求或研究已变化')
    if chapter['dependencies'] != dependency_hashes(state, section):
        issues.append('前置章节正文已变化')
    review = state['reviews'].get(section['id'])
    if not review or review['candidate_hash'] != hash_value(chapter):
        issues.append('当前正文尚未复核')
    elif not review['passed']:
        issues.append('章节复核存在未解决项')
    return issues


def current_book_hash(state):
    return hash_value({key: state[key] for key in ('analysis', 'outline', 'research', 'chapters', 'reviews')})


def collect_status(root, state):
    issues = []
    if not state['analysis']:
        issues.append('招标分析未接纳')
    if not state['outline']:
        issues.append('目录未接纳')
    chapters = []
    if state['outline']:
        try:
            validate_coverage(state)
        except InputError as error:
            issues.append(str(error))
        for position, section in enumerate(outline_sections(state), 1):
            if not section['writable']:
                continue
            try:
                problems = chapter_issues(root, state, section)
            except InputError as error:
                problems = [str(error)]
            chapters.append({'position': position, 'title': section['title'], 'issues': problems})
            issues.extend(f'{section["number"]} {section["title"]}：{value}' for value in problems)
    final = state['final_review']
    if not final or final['book_hash'] != current_book_hash(state):
        issues.append('当前全书尚未复核')
    elif not final['passed']:
        issues.append('整书审查存在未解决项')
    manual_actions = [item['reason'] for item in (final or {}).get('items', []) if item['verdict'] == 'manual_action']
    return {'revision': state['revision'], 'status': 'draft' if issues else 'ready',
            'chapters': chapters, 'issues': issues,
            'manual_actions': manual_actions,
            'quality_notice': 'ready 仅表示正文审查记录齐全且无未解决内容项；不代表语义判断正确、最终 Word 版面已验收、签章或递交完成。'}


def validate_coverage(state):
    analysis, outline = state['analysis'], state['outline']
    kinds = {'requirement': analysis['requirements'], 'response_point': outline['response_points'], 'compliance': analysis['compliance']}
    for kind, records in kinds.items():
        valid = {item['id'] for item in records}
        field = {'requirement': 'requirements', 'response_point': 'response_points', 'compliance': 'compliance'}[kind]
        covered = {key for section in outline['sections'] for key in section[field]}
        covered.update(item['target_id'] for item in outline['document_items'] if item['kind'] == kind)
        require(covered <= valid, f'{kind} 引用了已移除条目；请更新目录')
        require(valid <= covered, f'{kind} 存在未安排的条目；须分配正文、附件或递交任务')
    scored = {point['scoring_id'] for point in outline['response_points']}
    require(scored == {item['id'] for item in analysis['scoring']}, '每项评分须有响应点；价格或资格评分也须安排核对任务')


def apply_analysis(root, state, payload, request):
    obj(payload, 'analysis', ('project', 'requirements', 'scoring', 'compliance'), ('project', 'requirements', 'scoring', 'compliance'))
    obj(payload['project'], 'project', ('title', 'scope'), ('title', 'scope'))
    project = {key: text(payload['project'][key], 'project.' + key) for key in ('title', 'scope')}
    result = {'project': project}
    previous = state['analysis'] or {}
    for key in ('requirements', 'scoring', 'compliance'):
        result[key] = []
        used = set()
        for item in array(payload[key], key):
            fields = ('existing_position', 'text', 'citations', 'mandatory') if key == 'requirements' else (
                ('existing_position', 'text', 'citations', 'points', 'category') if key == 'scoring' else ('existing_position', 'text', 'citations'))
            obj(item, key, fields, ('text', 'citations'))
            bound = citations(root, item['citations'], request['source_count'])
            require(bound and all(value['role'] == 'tender' for value in bound), '招标要求和评分必须绑定招标原文')
            row = {'id': identity(item, previous.get(key, []), used), 'text': text(item['text'], key + '.text'), 'citations': bound}
            if key == 'requirements':
                require(type(item.get('mandatory')) is bool, 'requirement.mandatory 必须为布尔值')
                row['mandatory'] = item['mandatory']
            if key == 'scoring':
                require(item.get('category') in ('technical', 'business', 'price', 'qualification'), '评分类别无效')
                points = item.get('points')
                require(points is None or type(points) in (int, float) and 0 <= points < float('inf'), '分值须为非负有限数或 null')
                row.update(points=points, category=item['category'])
            result[key].append(row)
    require(result['requirements'], '招标要求不可为空')
    state['analysis'] = result


def apply_outline(root, state, payload, request):
    obj(payload, 'outline', ('response_points', 'sections', 'document_items', 'content_moves'), ('response_points', 'sections', 'document_items'))
    require(state['analysis'], '先完成招标分析')
    previous = state['outline'] or {'sections': [], 'response_points': []}
    response_points, used = [], set()
    for item in array(payload['response_points'], 'response_points'):
        obj(item, 'response_point', ('existing_position', 'scoring_position', 'text'), ('scoring_position', 'text'))
        response_points.append({'id': identity(item, previous['response_points'], used),
                                'scoring_id': choose(state['analysis']['scoring'], item['scoring_position'], 'scoring')['id'],
                                'text': text(item['text'], 'response_point.text')})
    raw = array(payload['sections'], 'sections')
    require(raw, '目录不可为空')
    sections, used, counts = [], set(), {}
    for position, item in enumerate(raw, 1):
        obj(item, 'section', ('existing_position', 'title', 'parent_position', 'purpose', 'summary', 'must_answer', 'requirement_positions',
                             'response_point_positions', 'compliance_positions', 'dependency_positions'),
            ('title', 'parent_position', 'purpose', 'must_answer', 'requirement_positions', 'response_point_positions', 'compliance_positions'))
        parent_pos = item['parent_position']
        parent = None if parent_pos is None else choose(sections, parent_pos, 'parent_position')
        parent_id = parent['id'] if parent else None
        level = parent['level'] + 1 if parent else 1
        require(level <= 6, '目录层级不能超过六级')
        counts[parent_id] = counts.get(parent_id, 0) + 1
        number = f'{parent["number"]}.{counts[parent_id]}' if parent else str(counts[parent_id])
        tasks = [text(value, 'must_answer') for value in array(item['must_answer'], 'must_answer')]
        require(len(tasks) == len(set(tasks)), '本节必答问题不能重复')
        sections.append({'id': identity(item, previous['sections'], used), 'title': text(item['title'], 'title'),
                         'parent_id': parent_id, 'level': level, 'number': number,
                         'purpose': text(item['purpose'], 'purpose'), 'summary': item.get('summary', ''), 'must_answer': tasks,
                         'requirements': positions(state['analysis']['requirements'], item['requirement_positions'], 'requirements'),
                         'response_points': positions(response_points, item['response_point_positions'], 'response_points'),
                         'compliance': positions(state['analysis']['compliance'], item['compliance_positions'], 'compliance')})
        require(isinstance(sections[-1]['summary'], str), 'summary 必须是文字')
    parent_ids = {item['parent_id'] for item in sections}
    for position, (section, item) in enumerate(zip(sections, raw), 1):
        section['writable'] = section['id'] not in parent_ids
        section['dependencies'] = positions(sections, item.get('dependency_positions', []), 'dependencies')
        if section['writable']:
            require(section['must_answer'], '可写叶节必须有必答问题')
        else:
            require(not any(section[key] for key in ('must_answer', 'requirements', 'response_points', 'compliance', 'dependencies')),
                    '结构父节点只提供 purpose 和 summary；作答分配给叶节')
    by_id = {item['id']: item for item in sections}
    def visit(key, stack, done):
        require(key not in stack, '章节强依赖不能成环')
        if key in done:
            return
        require(by_id[key]['writable'], '依赖对象必须是可写叶节')
        for dependency in by_id[key]['dependencies']:
            visit(dependency, stack | {key}, done)
        done.add(key)
    done = set()
    for section in sections:
        if section['writable']:
            visit(section['id'], set(), done)
    document_items = []
    tables = {'requirement': state['analysis']['requirements'], 'response_point': response_points, 'compliance': state['analysis']['compliance']}
    for item in array(payload['document_items'], 'document_items'):
        obj(item, 'document_item', ('kind', 'position', 'handling', 'plan'), ('kind', 'position', 'handling', 'plan'))
        require(item['kind'] in tables and item['handling'] in ('attachment', 'submission', 'whole_book'), '整书任务种类或处理方式无效')
        target = choose(tables[item['kind']], item['position'], 'document_item')
        require(not any(row['target_id'] == target['id'] for row in document_items), '整书任务重复')
        document_items.append({'kind': item['kind'], 'target_id': target['id'], 'text': target['text'],
                               'handling': item['handling'], 'plan': text(item['plan'], 'plan')})
    migrate_content(root, state, previous['sections'], sections, payload.get('content_moves', []))
    def descend(parent):
        result = []
        for section in sections:
            if section['parent_id'] == parent:
                result.extend([section, *descend(section['id'])])
        return result
    state['outline'] = {'response_points': response_points, 'sections': descend(None), 'document_items': document_items}
    validate_coverage(state)


def migrate_content(root, state, previous, current, moves):
    """拆并目录时由程序迁移完整原文行；没有显式完整映射的已有正文不允许消失。"""
    active = {section['id'] for section in current if section['writable']}
    written = {section['id'] for section in previous if section['id'] in state['chapters'] and section['writable']}
    required = written - active
    chosen, destinations, source_lines = {}, {}, {}
    for item in array(moves, 'content_moves'):
        obj(item, 'content_move', ('source_section_position', 'start_line', 'end_line', 'target_section_position'),
            ('source_section_position', 'start_line', 'end_line', 'target_section_position'))
        source = choose(previous, item['source_section_position'], 'source_section_position')
        target = choose(current, item['target_section_position'], 'target_section_position')
        require(source['id'] in written and target['writable'], '迁移来源须有已接纳正文，目标须为可写叶节')
        chapter = state['chapters'][source['id']]
        body = body_text(root, chapter)
        start, end = item['start_line'], item['end_line']
        lines = body.splitlines()
        require(type(start) is int and type(end) is int and 1 <= start <= end <= len(lines), '迁移原文行范围无效')
        fragment = lines[start - 1:end]
        covered = chosen.setdefault(source['id'], set())
        indices = set(range(start, end + 1))
        require(not covered & indices, '同一原文行不能重复迁移')
        covered.update(indices)
        source_lines[source['id']] = len(body.splitlines())
        for use in chapter['uses']:
            use_start, use_end = use['body_range']['start_line'], use['body_range']['end_line']
            require(end < use_start or start > use_end or start <= use_start <= use_end <= end,
                    '迁移范围切断了已登记的声明；请选择包含完整声明的原文范围')
        destinations.setdefault(target['id'], []).append((chapter, fragment, start, end))
        required.add(source['id'])
        if target['id'] in written:
            required.add(target['id'])
    require(required <= set(chosen), '目录变更会移除或覆盖已有正文；须用 content_moves 明确迁移全部原文')
    for source_id in required:
        require(chosen[source_id] == set(range(1, source_lines[source_id] + 1)), '迁移必须恰好保留来源全部原文行；未授权删改不能静默接受')
    for target_id, fragments in destinations.items():
        lines, uses = [], []
        for chapter, fragment, start, end in fragments:
            offset = len(lines)
            lines.extend(fragment)
            for use in chapter['uses']:
                old = use['body_range']
                if start <= old['start_line'] <= old['end_line'] <= end:
                    uses.append({**use, 'body_range': {**old, 'start_line': offset + old['start_line'] - start + 1,
                                                      'end_line': offset + old['end_line'] - start + 1}})
        body = '\n'.join(lines) + '\n'
        digest = hash_value(body)
        path = f'chapters/{target_id}/{digest}.md'
        write(inside(root, path), body)
        state['chapters'][target_id] = {'path': path, 'body_hash': digest, 'context': 'migration_pending',
                                        'research_hash': None, 'dependencies': {}, 'uses': uses, 'images': images(root, body)}
    for source_id in chosen.keys() - destinations.keys():
        state['chapters'].pop(source_id, None)
        state['reviews'].pop(source_id, None)


def apply_research(root, state, payload, request, section):
    obj(payload, 'research', ('readiness', 'reason', 'searches', 'answers'), ('readiness', 'reason', 'searches', 'answers'))
    require(payload['readiness'] in ('ready', 'needs_input', 'search_blocked'), '研究 readiness 无效')
    tasks = checklist(state, section)
    answers, seen = [], set()
    for item in array(payload['answers'], 'answers'):
        obj(item, 'answer', ('item_position', 'mode', 'claim_type', 'content', 'boundary', 'citations', 'required_input'),
            ('item_position', 'mode', 'claim_type', 'content', 'boundary', 'citations'))
        target = choose(tasks, item['item_position'], 'answer.item_position')
        require(target['key'] not in seen, '每项任务只能有一个回答计划')
        seen.add(target['key'])
        require(item['mode'] in ('supported', 'proposal', 'gap'), 'answer.mode 无效')
        require(item['claim_type'] in ('company_fact', 'requirement', 'technical_fact', 'proposal'), 'answer.claim_type 无效')
        bound = citations(root, item['citations'], request['source_count'])
        if item['mode'] != 'gap':
            require(item['mode'] != 'proposal' or item['claim_type'] == 'proposal', '拟议方案的 claim_type 必须为 proposal')
            require(item['mode'] != 'supported' or item['claim_type'] != 'proposal', '已有事实不能标成 proposal')
            source_scope(item['claim_type'], bound)
        required = text(item.get('required_input'), 'required_input') if item['mode'] == 'gap' else None
        answers.append({'target_key': target['key'], 'mode': item['mode'], 'claim_type': item['claim_type'],
                        'content': text(item['content'], 'content'), 'boundary': text(item['boundary'], 'boundary'),
                        'citations': bound, 'required_input': required})
    require(seen == {item['key'] for item in tasks}, '回答计划必须覆盖当前章节全部任务')
    searches = []
    for item in array(payload['searches'], 'searches'):
        obj(item, 'search', ('query', 'outcome', 'note'), ('query', 'outcome', 'note'))
        require(item['outcome'] in ('read', 'no_relevant_result', 'failed'), 'search.outcome 无效')
        searches.append({key: text(item[key], key) for key in ('query', 'outcome', 'note')})
    state['research'][section['id']] = {'context': section_context(state, section), 'readiness': payload['readiness'],
                                       'reason': text(payload['reason'], 'reason'), 'searches': searches, 'answers': answers}


def apply_chapter(root, state, payload, request, section):
    obj(payload, 'chapter', ('body_file', 'uses'), ('body_file', 'uses'))
    research = state['research'].get(section['id'])
    require(research and research['context'] == section_context(state, section), '先完成当前章节研究；有缺口的章节仍可保存草稿')
    body = inside(root, text(payload['body_file'], 'body_file')).read_text(encoding='utf-8-sig').replace('\r\n', '\n').rstrip() + '\n'
    require(bool(body.strip()), '正文不可为空')
    uses = []
    for item in array(payload['uses'], 'uses'):
        obj(item, 'use', ('body_range', 'claim_type', 'citations'), ('body_range', 'claim_type', 'citations'))
        bound = citations(root, item['citations'], request['source_count'])
        source_scope(item['claim_type'], bound)
        uses.append({'body_range': quote(body, item['body_range']), 'claim_type': item['claim_type'], 'citations': bound})
    store_chapter(root, state, section, research, body, uses)


def store_chapter(root, state, section, research, body, uses):
    """在正文文件保存成功后更新当前章节引用；旧版本始终保留。"""
    body_hash = hash_value(body)
    path = f'chapters/{section["id"]}/{body_hash}.md'
    write(inside(root, path), body)
    state['chapters'][section['id']] = {'path': path, 'body_hash': body_hash, 'context': section_context(state, section),
                                      'research_hash': hash_value(research), 'dependencies': dependency_hashes(state, section), 'uses': uses,
                                      'images': images(root, body)}


def apply_patch_chapter(root, state, payload, request, section):
    obj(payload, 'patch', ('text', 'uses'), ('text', 'uses'))
    require(isinstance(payload['text'], str) and '\x00' not in payload['text'], 'replacement text 必须为普通文字；空文字表示删除选区')
    chapter = state['chapters'].get(section['id'])
    require(chapter, '本章尚无正文')
    research = state['research'].get(section['id'])
    require(research and research['context'] == section_context(state, section), '章节要求已变化；先更新研究')
    body = body_text(root, chapter)
    scope = request['edit_scope']
    start, end = scope['start_line'], scope['end_line']
    quote(body, scope)
    replacement = payload['text'].replace('\r\n', '\n')
    if replacement and not replacement.endswith('\n'):
        replacement += '\n'
    lines = body.splitlines(keepends=True)
    updated = ''.join(lines[:start - 1]) + replacement + ''.join(lines[end:])
    require(updated.strip(), '局部修改不能清空整章')
    shift = len(replacement.splitlines()) - (end - start + 1)
    uses = []
    for use in chapter['uses']:
        old = use['body_range']
        if old['end_line'] < start:
            uses.append(use)
        elif old['start_line'] > end:
            span = {'start_line': old['start_line'] + shift, 'end_line': old['end_line'] + shift}
            uses.append({**use, 'body_range': quote(updated, span)})
    for item in array(payload['uses'], 'uses'):
        obj(item, 'patch use', ('body_range', 'claim_type', 'citations'), ('body_range', 'claim_type', 'citations'))
        span = quote(replacement, item['body_range'])
        bound = citations(root, item['citations'], request['source_count'])
        source_scope(item['claim_type'], bound)
        absolute = {'start_line': span['start_line'] + start - 1, 'end_line': span['end_line'] + start - 1}
        uses.append({'body_range': quote(updated, absolute), 'claim_type': item['claim_type'], 'citations': bound})
    store_chapter(root, state, section, research, updated, uses)
    state['chapters'][section['id']]['last_edit'] = {'scope': scope, 'before_hash': chapter['body_hash']}


def assessments(values, keys, label):
    values = obj(values, label, keys, keys)
    result = {}
    for key in keys:
        item = obj(values[key], label + '.' + key, ('verdict', 'reason'), ('verdict', 'reason'))
        require(item['verdict'] in VERDICTS, f'{key}.verdict 无效')
        result[key] = {'verdict': item['verdict'], 'reason': text(item['reason'], key + '.reason')}
    return result


def apply_review(root, state, payload, request, section):
    obj(payload, 'review', ('items', 'claims', 'quality', 'issues', 'review_mode'), ('items', 'claims', 'quality', 'issues', 'review_mode'))
    require(payload['review_mode'] in ('separate_context', 'self_review'), '如无独立上下文，只能声明 self_review')
    chapter = state['chapters'].get(section['id'])
    require(chapter, '先接纳本章正文')
    body, tasks = body_text(root, chapter), checklist(state, section)
    items, seen = [], set()
    for item in array(payload['items'], 'items'):
        obj(item, 'review item', ('item_position', 'verdict', 'reason', 'body_ranges'), ('item_position', 'verdict', 'reason', 'body_ranges'))
        target = choose(tasks, item['item_position'], 'item_position')
        require(target['key'] not in seen and item['verdict'] in VERDICTS, '审查项重复或结论无效')
        seen.add(target['key'])
        quotes = [quote(body, span) for span in array(item['body_ranges'], 'body_ranges')]
        require(item['verdict'] != 'met' or quotes, '声称已回应时必须选择当前正文行范围')
        items.append({'target_key': target['key'], 'verdict': item['verdict'], 'reason': text(item['reason'], 'reason'), 'quotes': quotes})
    require(seen == {item['key'] for item in tasks}, '章节审查漏项')
    claims, seen = [], set()
    for item in array(payload['claims'], 'claims'):
        obj(item, 'claim review', ('claim_position', 'verdict', 'reason'), ('claim_position', 'verdict', 'reason'))
        choose(chapter['uses'], item['claim_position'], 'claim_position')
        require(item['claim_position'] not in seen and item['verdict'] in VERDICTS, '事实审查重复或结论无效')
        seen.add(item['claim_position'])
        claims.append({'claim_position': item['claim_position'], 'verdict': item['verdict'], 'reason': text(item['reason'], 'reason')})
    require(len(seen) == len(chapter['uses']), '必须检查全部登记的事实与方案声明')
    quality = assessments(payload['quality'], QUALITY, 'quality')
    issues = [text(item, 'issue') for item in array(payload['issues'], 'issues')]
    passed = not issues and all(item['verdict'] == 'met' for item in [*items, *claims, *quality.values()])
    state['reviews'][section['id']] = {'candidate_hash': hash_value(chapter), 'passed': passed, 'review_mode': payload['review_mode'],
                                     'items': items, 'claims': claims, 'quality': quality, 'issues': issues}


def apply_final_review(root, state, payload, request):
    obj(payload, 'final-review', ('items', 'quality', 'issues', 'review_mode'), ('items', 'quality', 'issues', 'review_mode'))
    require(state['outline'], '先完成目录')
    require(payload['review_mode'] in ('separate_context', 'self_review'), 'review_mode 无效')
    tasks, items, seen = state['outline']['document_items'], [], set()
    for item in array(payload['items'], 'items'):
        obj(item, 'final item', ('item_position', 'verdict', 'reason', 'body_evidence', 'citations'),
            ('item_position', 'verdict', 'reason', 'body_evidence', 'citations'))
        target = choose(tasks, item['item_position'], 'item_position')
        allowed = ('manual_action', 'needs_input', 'unmet') if target['handling'] == 'submission' else VERDICTS
        require(target['target_id'] not in seen and item['verdict'] in allowed,
                '整书审查重复或结论无效；递交/签章事项只登记 manual_action、needs_input 或 unmet，不以正文证明已执行')
        seen.add(target['target_id'])
        evidence = []
        for value in array(item['body_evidence'], 'body_evidence'):
            obj(value, 'body_evidence', ('section_position', 'start_line', 'end_line'), ('section_position', 'start_line', 'end_line'))
            section = choose(outline_sections(state), value['section_position'], 'section_position')
            chapter = state['chapters'].get(section['id'])
            require(chapter, '引用的章节没有正文')
            evidence.append({'section_id': section['id'], **quote(body_text(root, chapter), {key: value[key] for key in ('start_line', 'end_line')})})
        bound = citations(root, item['citations'], request['source_count'])
        require(item['verdict'] != 'met' or evidence or bound, '整书任务 met 须引用实际正文或材料；不能仅填结论')
        items.append({'target_id': target['target_id'], 'verdict': item['verdict'], 'reason': text(item['reason'], 'reason'),
                      'body_evidence': evidence, 'citations': bound})
    require(len(seen) == len(tasks), '整书任务审查漏项')
    quality = assessments(payload['quality'], BOOK_QUALITY, 'quality')
    issues = [text(item, 'issue') for item in array(payload['issues'], 'issues')]
    state['final_review'] = {'book_hash': current_book_hash(state), 'passed': not issues and all(
        item['verdict'] in ('met', 'manual_action') for item in [*items, *quality.values()]), 'review_mode': payload['review_mode'],
        'items': items, 'quality': quality, 'issues': issues}


def templates(operation):
    citation = {'source_position': 1, 'start_line': 1, 'end_line': 1}
    quality = lambda keys: {key: {'verdict': 'unmet', 'reason': '填写实际审查依据'} for key in keys}
    return {
        'analysis': {'project': {'title': '填写项目名称', 'scope': '填写采购范围'},
                     'requirements': [{'text': '填写真实要求', 'mandatory': True, 'citations': [citation]}],
                     'scoring': [{'text': '保留评分完整规则', 'category': 'technical', 'points': None, 'citations': [citation]}], 'compliance': []},
        'outline': {'response_points': [{'scoring_position': 1, 'text': '填写评分响应点'}],
                    'sections': [{'title': '填写章节名称', 'parent_position': None, 'purpose': '填写章节职责', 'summary': '',
                                  'must_answer': ['填写本章必须回答的问题'], 'requirement_positions': [1],
                                  'response_point_positions': [1], 'compliance_positions': [], 'dependency_positions': []}], 'document_items': []},
        'research': {'readiness': 'needs_input', 'reason': '填写研究判断', 'searches': [],
                     'answers': [{'item_position': 1, 'mode': 'gap', 'claim_type': 'technical_fact', 'content': '填写具体缺口',
                                  'boundary': '填写可支持的范围', 'citations': [], 'required_input': '填写所需输入'}]},
        'chapter': {'body_file': 'drafts/chapter.md', 'uses': []},
        'patch': {'text': '填写选区替换正文，选区之外的内容由程序保留。', 'uses': []},
        'review': {'review_mode': 'self_review', 'items': [{'item_position': 1, 'verdict': 'unmet', 'reason': '填写实际问题', 'body_ranges': []}],
                   'claims': [], 'quality': quality(QUALITY), 'issues': []},
        'final-review': {'review_mode': 'self_review', 'items': [], 'quality': quality(BOOK_QUALITY), 'issues': []},
    }[operation]


def prepare(root, operation, section_position, start=None, end=None):
    state = load(root)
    sources = load_sources(root)
    payload = templates(operation)
    section = None
    if operation in ('research', 'chapter', 'patch', 'review'):
        section = choose(outline_sections(state), section_position, 'section_position')
        require(section['writable'], '只能为可写叶节创建本操作')
    tables = {'sources': sources, 'sections': numbered(outline_sections(state))}
    if state['analysis']:
        tables.update({key: numbered(state['analysis'][key]) for key in ('requirements', 'scoring', 'compliance')})
    if state['outline']:
        tables.update(response_points=numbered(state['outline']['response_points']), document_items=numbered(state['outline']['document_items']))
    if section:
        tables['checklist'] = checklist(state, section)
        tables['research'] = state['research'].get(section['id'])
        chapter = state['chapters'].get(section['id'])
        if chapter:
            tables['body_file'] = chapter['path']
            tables['body_lines'] = [{'line': index, 'text': line} for index, line in enumerate(body_text(root, chapter).splitlines(), 1)]
            tables['claims'] = numbered(chapter['uses'])
            tables['previous_review'] = state['reviews'].get(section['id'])
            if operation == 'chapter':
                source_positions = {source['source_id']: source['position'] for source in sources}
                for use in chapter['uses']:
                    for citation in use['citations']:
                        verify_citation(root, citation)
                payload = {'body_file': chapter['path'], 'uses': [
                    {'body_range': {key: use['body_range'][key] for key in ('start_line', 'end_line')},
                     'claim_type': use['claim_type'], 'citations': [
                         {'source_position': source_positions[citation['source_id']],
                          'start_line': citation['start_line'], 'end_line': citation['end_line']}
                         for citation in use['citations']]}
                    for use in chapter['uses']]}
    name = uuid.uuid4().hex
    request_path, input_path = f'requests/{name}.json', f'drafts/{name}.json'
    request = {'project_id': state['project_id'], 'revision': state['revision'], 'operation': operation,
               'section_id': section['id'] if section else None, 'source_count': len(sources), 'objects': tables}
    if operation == 'patch':
        chapter = state['chapters'].get(section['id'])
        require(chapter, '本章尚无正文')
        scope = {'start_line': start, 'end_line': end}
        selected = quote(body_text(root, chapter), scope)
        request['edit_scope'] = scope
        tables['selected_text'] = selected
    write_json(inside(root, request_path), request)
    write_json(inside(root, input_path), payload)
    return {'request': request_path, 'input': input_path, 'objects': tables,
            'next': '只填写 input 的语义字段；不要编辑 request、ID、哈希或 project.json。使用 apply --request <request> --input <input> 接纳。'}


def apply(root, request_path, input_path):
    state = load(root)
    request = read_json(inside(root, request_path))
    require(request['project_id'] == state['project_id'] and request['revision'] == state['revision'], '请求已过期或不属于本项目；保留草稿，重新 prepare 后按新对象表选择位置')
    load_sources(root)
    payload = read_json(inside(root, input_path))
    operation = request['operation']
    require(operation in OPERATIONS, '请求操作无效')
    section = next((value for value in outline_sections(state) if value['id'] == request['section_id']), None)
    if operation in ('research', 'chapter', 'patch', 'review'):
        require(section and section['writable'], '请求章节已失效')
        {'research': apply_research, 'chapter': apply_chapter, 'patch': apply_patch_chapter, 'review': apply_review}[operation](root, state, payload, request, section)
    else:
        {'analysis': apply_analysis, 'outline': apply_outline, 'final-review': apply_final_review}[operation](root, state, payload, request)
    save(root, state)
    return {'accepted': operation, 'revision': state['revision'], 'status': collect_status(root, state)}


def build(root):
    state = load(root)
    load_sources(root)
    status = collect_status(root, state)
    sections = []
    for section in outline_sections(state):
        chapter = state['chapters'].get(section['id']) if section['writable'] else None
        sections.append({'title': section['title'], 'number': section['number'], 'level': section['level'],
                         'body': body_text(root, chapter) if chapter else section['summary']})
    book = {'title': (state['analysis'] or {}).get('project', {}).get('title', state['title']), 'bidder': state['bidder'],
            'date': state['date'], 'sections': sections, 'status': status['status'], 'issues': status['issues']}
    write_json(inside(root, 'build/book.json'), book)
    markdown = '\n\n'.join('#' * item['level'] + ' ' + item['number'] + ' ' + item['title'] + '\n\n' + item['body'].rstrip() for item in sections) + '\n'
    write(inside(root, 'build/manuscript.md'), markdown)
    review_report = {'status': status, 'research': state['research'], 'chapter_reviews': state['reviews'], 'whole_book_review': state['final_review']}
    write_json(inside(root, 'build/review-report.json'), review_report)
    rows = ''.join('<tr><td>' + html.escape(item['number'] + ' ' + item['title']) + '</td><td><pre>' + html.escape(item['body']) + '</pre></td></tr>' for item in sections)
    problems = ''.join('<li>' + html.escape(item) + '</li>' for item in status['issues'])
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>标书工作预览</title><style>body{font:16px/1.7 system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172033}table{border-collapse:collapse;width:100%}td{border:1px solid #ccd4df;padding:16px;vertical-align:top}pre{white-space:pre-wrap;font:inherit}li{color:#9d352b}</style><h1>' + html.escape(book['title']) + '</h1><p>状态：' + status['status'] + '。' + html.escape(status['quality_notice']) + '</p><ul>' + problems + '</ul><table>' + rows + '</table></html>\n'
    write(inside(root, 'build/preview.html'), page)
    return {'book': str(inside(root, 'build/book.json')), 'preview': str(inside(root, 'build/preview.html')), 'status': status}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init')
    init.add_argument('workspace')
    init.add_argument('--title', required=True)
    init.add_argument('--bidder', default='')
    init.add_argument('--date', default='')
    for name in ('status', 'build'):
        sub.add_parser(name).add_argument('workspace')
    prep = sub.add_parser('prepare')
    prep.add_argument('workspace')
    prep.add_argument('operation', choices=OPERATIONS)
    prep.add_argument('--section', type=int)
    prep.add_argument('--start', type=int)
    prep.add_argument('--end', type=int)
    accept = sub.add_parser('apply')
    accept.add_argument('workspace')
    accept.add_argument('--request', required=True)
    accept.add_argument('--input', required=True)
    args = parser.parse_args(argv)
    root = Path(args.workspace).resolve()
    if args.command == 'init':
        require(not root.exists() or root.is_dir() and not any(root.iterdir()), '新标书工作目录必须为空；已有项目用 status 继续')
        root.mkdir(parents=True, exist_ok=True)
        state = {'version': 1, 'project_id': uuid.uuid4().hex, 'revision': 0, 'title': text(args.title, 'title'),
                 'bidder': args.bidder, 'date': args.date, 'analysis': None, 'outline': None,
                 'research': {}, 'chapters': {}, 'reviews': {}, 'final_review': None}
        write_json(root / 'project.json', state)
        result = {'workspace': str(root), 'next': '用 sources.py add 登记招标文件、企业资料与已读取网页，再 prepare analysis。'}
    elif args.command == 'prepare':
        result = prepare(root, args.operation, args.section, args.start, args.end)
    elif args.command == 'apply':
        result = apply(root, args.request, args.input)
    elif args.command == 'build':
        result = build(root)
    else:
        load_sources(root)
        result = collect_status(root, load(root))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
