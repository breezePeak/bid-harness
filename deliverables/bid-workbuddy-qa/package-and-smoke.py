"""打包本地技能，并从解压后的独立副本运行真实示例与导出。"""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
import zipfile


qa = Path(__file__).resolve().parent
skill = qa.parent / 'bid-workbuddy'
archive = qa.parent / 'bid-workbuddy.zip'
files = sorted(path for path in skill.rglob('*') if path.is_file() and path.suffix in ('.md', '.py', '.txt'))
assert len(files) == 12, f'技能文件清单发生变化：{len(files)}'
for path in files:
    content = path.read_text(encoding='utf-8')
    assert content.endswith('\n') and not content.endswith('\n\n'), f'末尾换行：{path}'
    assert all(line == line.rstrip() for line in content.splitlines()), f'行末空白：{path}'
    if path.suffix == '.py':
        ast.parse(content, filename=str(path))
    assert 'C:/Users/Administrator' not in content and 'D:/my_project' not in content, f'宿主路径：{path}'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in files:
        bundle.write(path, f'bid-workbuddy/{path.relative_to(skill).as_posix()}')
unpacked = qa / f'package-smoke-{uuid.uuid4().hex[:8]}'
unpacked.mkdir()
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert all(name.startswith('bid-workbuddy/') and '..' not in Path(name).parts for name in bundle.namelist())
    bundle.extractall(unpacked)
for path in files:
    assert path.read_bytes() == (unpacked / 'bid-workbuddy' / path.relative_to(skill)).read_bytes()
copy = unpacked / 'bid-workbuddy'
workspace = unpacked / 'demo'


def run(*args):
    result = subprocess.run([sys.executable, '-B', *map(str, args)], cwd=unpacked, capture_output=True,
                            text=True, encoding='utf-8', env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return json.loads(result.stdout)


doctor = run(copy / 'scripts' / 'doctor.py', '--json')
assert doctor['ready']
run(copy / 'examples' / 'run_example.py', workspace)
status = run(copy / 'scripts' / 'project.py', 'status', workspace)
assert status['status'] == 'ready', status
word = run(copy / 'scripts' / 'export_word.py', workspace, '--output', qa / '演示技术标.docx')
assert word['tables'] == 2 and word['images'] == 0
receipt = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
           'files': len(files), 'workspace': str(workspace), 'doctor_ready': True, 'workflow_ready': True,
           'docx': word['output']}
(qa / 'package-smoke.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, ensure_ascii=False))
