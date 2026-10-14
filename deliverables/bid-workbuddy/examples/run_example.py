#!/usr/bin/env python3
"""用随包演示采购材料跑通真实 CLI；预写语义输入只验证程序，不评价模型写作能力。"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1]


def cli(script, *args):
    result = subprocess.run([sys.executable, str(SKILL / 'scripts' / script), *map(str, args)],
                            capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def accept(root, operation, payload, section=None):
    extra = [] if section is None else ['--section', section]
    prepared = cli('project.py', 'prepare', root, operation, *extra)
    (root / prepared['input']).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    return cli('project.py', 'apply', root, '--request', prepared['request'], '--input', prepared['input'])


def citation(line):
    return {'source_position': 1, 'start_line': line, 'end_line': line}


def quality(keys):
    return {key: {'verdict': 'met', 'reason': '演示输入已逐项核对；此记录用于验证程序接纳流程。'} for key in keys}


def run(root):
    root = Path(root).resolve()
    cli('project.py', 'init', root, '--title', '园区运维服务技术方案', '--bidder', '演示投标人', '--date', '2026年10月13日')
    cli('sources.py', 'add', root, '--file', SKILL / 'examples' / 'tender.txt', '--role', 'tender')
    accept(root, 'analysis', {
        'project': {'title': '园区运维服务技术方案', 'scope': '故障处理及交付检查。'},
        'requirements': [{'text': '建立故障分级、派单和关闭记录，说明岗位职责。', 'mandatory': True, 'citations': [citation(2)]},
                         {'text': '提供交付检查方法和记录表。', 'mandatory': True, 'citations': [citation(3)]}],
        'scoring': [{'text': '故障处理方案与验收安排共20分，根据方法、职责和记录的完整性评分。', 'category': 'technical', 'points': 20, 'citations': [citation(4)]}],
        'compliance': [{'text': '完成签章并按公告渠道递交。', 'citations': [citation(5)]}],
    })
    accept(root, 'outline', {
        'response_points': [{'scoring_position': 1, 'text': '故障处理方法与职责明确。'}, {'scoring_position': 1, 'text': '验收方法及记录完整。'}],
        'sections': [
            {'title': '故障处理', 'parent_position': None, 'purpose': '说明工单处理和关闭方法。', 'must_answer': ['如何处理故障并留痕？'],
             'requirement_positions': [1], 'response_point_positions': [1], 'compliance_positions': [], 'dependency_positions': []},
            {'title': '交付检查', 'parent_position': None, 'purpose': '说明验收依据和成果。', 'must_answer': ['怎样检查交付成果？'],
             'requirement_positions': [2], 'response_point_positions': [2], 'compliance_positions': [], 'dependency_positions': [1]},
        ],
        'document_items': [{'kind': 'compliance', 'position': 1, 'handling': 'submission', 'plan': '交项目负责人完成签章并按公告递交。'}],
    })
    bodies = [
        '本方案拟按故障影响范围进行分级，由值班岗位登记现象、影响对象和接报时间，并交对应处理岗位确认。\n\n'
        '处理岗位记录定位过程、采取的措施和复核结果。复核未通过时继续处理并更新记录，通过后由值班岗位核对关闭依据。\n\n'
        '表：故障工单记录字段\n| 字段 | 填写要求 |\n| --- | --- |\n| 故障现象 | 记录实际观察及影响范围 |\n| 处理措施 | 记录已执行动作及结果 |\n| 关闭依据 | 记录复核方法和结果 |\n',
        '本方案拟在交付前逐项检查工单资料和处理记录，并由交付岗位整理成果清单供项目负责人核对。\n\n'
        '检查时核对记录是否包含故障现象、实际措施及关闭依据；缺失项登记责任岗位和补齐事项，复查通过后归档。\n\n'
        '表：交付检查记录字段\n| 检查对象 | 检查方法 | 留存成果 |\n| --- | --- | --- |\n| 故障工单 | 对照处理及关闭记录逐项核对 | 检查记录 |\n| 缺失事项 | 核对补齐材料及复查结果 | 问题关闭清单 |\n',
    ]
    for section, body in enumerate(bodies, 1):
        prepared = cli('project.py', 'prepare', root, 'research', '--section', section)
        tasks = prepared['objects']['checklist']
        accept(root, 'research', {
            'readiness': 'ready', 'reason': '演示采购仅要求方案设计，所提方法不声称企业已有能力；未开展联网研究。', 'searches': [],
            'answers': [{'item_position': item['position'], 'mode': 'proposal', 'claim_type': 'proposal',
                         'content': '拟以角色、处理步骤和记录要求形成实施办法。', 'boundary': '属于拟议方案，不证明企业现有能力。',
                         'citations': [citation(section + 1)]} for item in tasks],
        }, section)
        path = root / 'drafts' / f'chapter-{section}.md'
        path.write_text(body, encoding='utf-8')
        accept(root, 'chapter', {'body_file': f'drafts/chapter-{section}.md', 'uses': [
            {'body_range': {'start_line': 1, 'end_line': 1}, 'claim_type': 'proposal', 'citations': [citation(section + 1)]}]}, section)
        accept(root, 'review', {
            'review_mode': 'self_review',
            'items': [{'item_position': item['position'], 'verdict': 'met', 'reason': '正文给出了对应方法和记录要求。',
                       'body_ranges': [{'start_line': 1, 'end_line': 3}]} for item in tasks],
            'claims': [{'claim_position': 1, 'verdict': 'met', 'reason': '明确表达为拟议方法，没有冒充企业既有事实。'}],
            'quality': quality(('specificity', 'feasibility', 'consistency', 'bidder_voice', 'no_padding', 'source_scope')), 'issues': [],
        }, section)
    accept(root, 'final-review', {
        'review_mode': 'self_review',
        'items': [{'item_position': 1, 'verdict': 'manual_action', 'reason': '项目负责人须完成签章并按公告渠道递交；演示不执行递交。',
                   'body_evidence': [], 'citations': []}],
        'quality': quality(('terminology', 'parameters', 'schedule', 'responsibilities', 'duplication', 'scoring_visibility', 'format_requirements')),
        'issues': [],
    })
    return cli('project.py', 'build', root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace', help='空的演示输出目录')
    args = parser.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(run(args.workspace), ensure_ascii=False, indent=2))
