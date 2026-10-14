"""从真实 CLI 验证整书流程、拒绝路径和修改后的审查失效。"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SKILL = Path(__file__).resolve().parents[1] / 'bid-workbuddy'
SPEC = importlib.util.spec_from_file_location('bid_example', SKILL / 'examples' / 'run_example.py')
EXAMPLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXAMPLE)


class ProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='bid-project-')
        cls.base = Path(cls.directory.name)
        cls.golden = cls.base / 'golden'
        cls.result = EXAMPLE.run(cls.golden)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        self.root = self.base / self.id().split('.')[-1]
        shutil.copytree(self.golden, self.root)

    def prepare(self, operation, section=None):
        return EXAMPLE.cli('project.py', 'prepare', self.root, operation, *([] if section is None else ['--section', section]))

    def raw_apply(self, prepared, payload):
        (self.root / prepared['input']).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        return subprocess.run([sys.executable, str(SKILL / 'scripts' / 'project.py'), 'apply', str(self.root),
                               '--request', prepared['request'], '--input', prepared['input']], capture_output=True, text=True, encoding='utf-8')

    def test_real_cli_whole_book_and_manual_submission(self):
        self.assertEqual(self.result['status']['status'], 'ready')
        self.assertEqual(len(self.result['status']['chapters']), 2)
        self.assertIn('不执行递交', self.result['status']['manual_actions'][0])
        book = json.loads((self.golden / 'build/book.json').read_text(encoding='utf-8'))
        self.assertEqual([row['number'] for row in book['sections']], ['1', '2'])
        self.assertNotIn('source_id', (self.golden / 'build/manuscript.md').read_text(encoding='utf-8'))

    def test_stale_request_is_rejected_without_mutation(self):
        prepared = self.prepare('chapter', 1)
        payload = {'body_file': 'drafts/chapter-1.md', 'uses': []}
        first = self.raw_apply(prepared, payload)
        self.assertEqual(first.returncode, 0, first.stderr)
        before = (self.root / 'project.json').read_bytes()
        second = self.raw_apply(prepared, payload)
        self.assertEqual(second.returncode, 2)
        self.assertIn('过期', second.stderr)
        self.assertEqual(before, (self.root / 'project.json').read_bytes())

    def test_addendum_reaccepts_original_body_and_citations_from_prepared_input(self):
        reference = self.root / 'drafts/technical-reference.txt'
        reference.write_text('故障处理参考\n处理岗位记录复核结果。\n关闭前核对记录。\n', encoding='utf-8')
        EXAMPLE.cli('sources.py', 'add', self.root, '--file', reference, '--role', 'reference')
        uses = [
            {'body_range': {'start_line': 1, 'end_line': 1}, 'claim_type': 'proposal', 'citations': [EXAMPLE.citation(2)]},
            {'body_range': {'start_line': 3, 'end_line': 3}, 'claim_type': 'proposal',
             'citations': [{'source_position': 2, 'start_line': 2, 'end_line': 3}]},
        ]
        EXAMPLE.accept(self.root, 'chapter', {'body_file': 'drafts/chapter-1.md', 'uses': uses}, 1)
        before = json.loads((self.root / 'project.json').read_text(encoding='utf-8'))
        section_id = before['outline']['sections'][0]['id']
        original = before['chapters'][section_id]
        body = (self.root / original['path']).read_bytes()
        supplement = self.root / 'drafts/addendum.txt'
        supplement.write_text('补遗：交付检查记录增加复查结果字段。\n', encoding='utf-8')
        EXAMPLE.cli('sources.py', 'add', self.root, '--file', supplement, '--role', 'tender')
        analysis = {'project': before['analysis']['project']}
        for kind in ('requirements', 'scoring', 'compliance'):
            analysis[kind] = []
            for position, item in enumerate(before['analysis'][kind], 1):
                row = {key: value for key, value in item.items() if key not in ('id', 'citations')}
                row.update(existing_position=position, citations=[
                    {'source_position': 1, 'start_line': citation['start_line'], 'end_line': citation['end_line']}
                    for citation in item['citations']])
                analysis[kind].append(row)
        analysis['requirements'][1]['text'] += '交付检查记录增加复查结果字段。'
        analysis['requirements'][1]['citations'].append({'source_position': 3, 'start_line': 1, 'end_line': 1})
        EXAMPLE.accept(self.root, 'analysis', analysis)
        prepared = self.prepare('research', 1)
        old_research = before['research'][section_id]
        EXAMPLE.accept(self.root, 'research', {
            'readiness': 'ready', 'reason': '补遗不改变本章实施方法，核对原依据后继续使用。', 'searches': [],
            'answers': [{'item_position': item['position'], 'mode': answer['mode'], 'claim_type': answer['claim_type'],
                         'content': answer['content'], 'boundary': answer['boundary'], 'citations': [EXAMPLE.citation(2)]}
                        for item, answer in zip(prepared['objects']['checklist'], old_research['answers'])],
        }, 1)
        prepared = self.prepare('chapter', 1)
        payload = json.loads((self.root / prepared['input']).read_text(encoding='utf-8'))
        self.assertEqual(payload, {'body_file': original['path'], 'uses': uses})
        result = EXAMPLE.cli('project.py', 'apply', self.root, '--request', prepared['request'], '--input', prepared['input'])
        self.assertEqual(result['accepted'], 'chapter')
        after = json.loads((self.root / 'project.json').read_text(encoding='utf-8'))['chapters'][section_id]
        self.assertEqual((self.root / after['path']).read_bytes(), body)
        self.assertEqual(after['uses'], original['uses'])
        self.assertNotEqual(after['context'], original['context'])

    def test_body_change_invalidates_review_and_downstream(self):
        path = self.root / 'drafts/chapter-1.md'
        path.write_text(path.read_text(encoding='utf-8') + '\n新增核对记录。\n', encoding='utf-8')
        EXAMPLE.accept(self.root, 'chapter', {'body_file': 'drafts/chapter-1.md', 'uses': []}, 1)
        status = EXAMPLE.cli('project.py', 'status', self.root)
        self.assertEqual(status['status'], 'draft')
        self.assertIn('当前正文尚未复核', status['chapters'][0]['issues'])
        self.assertIn('前置章节正文已变化', status['chapters'][1]['issues'])

    def test_review_cannot_pass_without_quote_or_all_items(self):
        prepared = self.prepare('review', 1)
        payload = json.loads((self.root / prepared['input']).read_text(encoding='utf-8'))
        payload['items'][0].update(verdict='met', reason='已覆盖')
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 2)
        self.assertIn('行范围', result.stderr)

    def test_web_cannot_prove_company_fact(self):
        web = self.root / 'drafts/web.txt'
        web.write_text('某企业拥有大量工程师。', encoding='utf-8')
        EXAMPLE.cli('sources.py', 'add', self.root, '--file', web, '--role', 'web', '--url', 'https://example.com/info')
        prepared = self.prepare('chapter', 1)
        payload = {'body_file': 'drafts/chapter-1.md', 'uses': [{'body_range': {'start_line': 1, 'end_line': 1},
                   'claim_type': 'company_fact', 'citations': [{'source_position': 2, 'start_line': 1, 'end_line': 1}]}]}
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 2)
        self.assertIn('公开资料', result.stderr)

    def outline_payload(self):
        prepared = self.prepare('outline')
        objects = prepared['objects']
        payload = {'response_points': [{'existing_position': index, 'scoring_position': 1, 'text': row['text']}
                                       for index, row in enumerate(objects['response_points'], 1)], 'sections': [],
                   'document_items': [{'kind': 'compliance', 'position': 1, 'handling': 'submission', 'plan': '负责人完成签章和递交。'}]}
        for index, row in enumerate(objects['sections'], 1):
            payload['sections'].append({'existing_position': index, 'title': row['title'], 'parent_position': None,
                                        'purpose': row['purpose'], 'must_answer': row['must_answer'], 'requirement_positions': [index],
                                        'response_point_positions': [index], 'compliance_positions': [], 'dependency_positions': []})
        return prepared, payload

    def test_outline_cannot_silently_drop_written_section(self):
        prepared, payload = self.outline_payload()
        payload['sections'].pop()
        payload['sections'][0]['requirement_positions'] = [1, 2]
        payload['sections'][0]['response_point_positions'] = [1, 2]
        before = (self.root / 'project.json').read_bytes()
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 2)
        self.assertIn('迁移', result.stderr)
        self.assertEqual(before, (self.root / 'project.json').read_bytes())

    def test_migration_preserves_every_line_and_marks_review_stale(self):
        prepared, payload = self.outline_payload()
        before = json.loads((self.root / 'project.json').read_text(encoding='utf-8'))
        originals = [(self.root / before['chapters'][section['id']]['path']).read_text(encoding='utf-8')
                     for section in before['outline']['sections']]
        payload['sections'].pop()
        payload['sections'][0]['requirement_positions'] = [1, 2]
        payload['sections'][0]['response_point_positions'] = [1, 2]
        payload['content_moves'] = [{'source_section_position': index, 'start_line': 1, 'end_line': len(body.splitlines()),
                                     'target_section_position': 1} for index, body in enumerate(originals, 1)]
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        EXAMPLE.cli('project.py', 'build', self.root)
        book = json.loads((self.root / 'build/book.json').read_text(encoding='utf-8'))
        self.assertEqual(book['sections'][0]['body'], ''.join(originals))
        self.assertEqual(book['status'], 'draft')

    def test_path_escape_and_bool_positions_rejected(self):
        prepared = self.prepare('chapter', 1)
        result = self.raw_apply(prepared, {'body_file': '../golden/drafts/chapter-1.md', 'uses': []})
        self.assertEqual(result.returncode, 2)
        self.assertIn('超出', result.stderr)
        prepared = self.prepare('research', 1)
        payload = json.loads((self.root / prepared['input']).read_text(encoding='utf-8'))
        payload['answers'][0]['item_position'] = True
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 2)
        self.assertIn('位置越界', result.stderr)

    def test_submission_cannot_be_claimed_done_from_tender_quote(self):
        prepared = self.prepare('final-review')
        payload = json.loads((self.root / prepared['input']).read_text(encoding='utf-8'))
        payload['items'] = [{'item_position': 1, 'verdict': 'met', 'reason': '招标文件写明要递交。', 'body_evidence': [], 'citations': [EXAMPLE.citation(5)]}]
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 2)
        self.assertIn('递交', result.stderr)

    def test_patch_preserves_unselected_text_and_invalidates_review(self):
        before = (self.root / 'drafts/chapter-1.md').read_text(encoding='utf-8')
        prepared = EXAMPLE.cli('project.py', 'prepare', self.root, 'patch', '--section', 1, '--start', 3, '--end', 3)
        result = self.raw_apply(prepared, {'text': '处理岗位在完成后保留复核记录。', 'uses': []})
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((self.root / 'project.json').read_text(encoding='utf-8'))
        chapter = state['chapters'][state['outline']['sections'][0]['id']]
        after = (self.root / chapter['path']).read_text(encoding='utf-8')
        lines = before.splitlines(keepends=True)
        self.assertEqual(after, ''.join(lines[:2]) + '处理岗位在完成后保留复核记录。\n' + ''.join(lines[3:]))
        self.assertEqual(json.loads(result.stdout)['status']['status'], 'draft')
        self.assertEqual(chapter['uses'][0]['body_range']['quote'], lines[0].rstrip('\n'))

    def test_migration_keeps_blank_lines_across_fragments(self):
        EXAMPLE.accept(self.root, 'chapter', {'body_file': 'drafts/chapter-1.md', 'uses': []}, 1)
        prepared, payload = self.outline_payload()
        state = json.loads((self.root / 'project.json').read_text(encoding='utf-8'))
        originals = [(self.root / state['chapters'][section['id']]['path']).read_text(encoding='utf-8')
                     for section in state['outline']['sections']]
        payload['sections'].pop()
        payload['sections'][0]['requirement_positions'] = [1, 2]
        payload['sections'][0]['response_point_positions'] = [1, 2]
        payload['content_moves'] = [
            {'source_section_position': 1, 'start_line': 1, 'end_line': 2, 'target_section_position': 1},
            {'source_section_position': 1, 'start_line': 3, 'end_line': len(originals[0].splitlines()), 'target_section_position': 1},
            {'source_section_position': 2, 'start_line': 1, 'end_line': len(originals[1].splitlines()), 'target_section_position': 1},
        ]
        result = self.raw_apply(prepared, payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        EXAMPLE.cli('project.py', 'build', self.root)
        book = json.loads((self.root / 'build/book.json').read_text(encoding='utf-8'))
        self.assertEqual(book['sections'][0]['body'], ''.join(originals))


if __name__ == '__main__':
    unittest.main()
