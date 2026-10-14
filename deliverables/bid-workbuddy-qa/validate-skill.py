"""在缺少 PyYAML 的现有环境中，用已安装 js-yaml 执行官方技能校验。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types


node, validator_path, skill_path = sys.argv[1:]


def safe_load(value):
    result = subprocess.run(
        [node, '-e', "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{try{process.stdout.write(JSON.stringify(require('js-yaml').load(s)??null))}catch(e){console.error(e.message);process.exitCode=1}})"],
        input=value, text=True, encoding='utf-8', capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError(result.stderr)
    return json.loads(result.stdout)


yaml = types.ModuleType('yaml')
yaml.safe_load = safe_load
yaml.YAMLError = ValueError
sys.modules['yaml'] = yaml
spec = importlib.util.spec_from_file_location('official_skill_validator', validator_path)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
assert safe_load('name: valid') == {'name': 'valid'}
try:
    safe_load('name: [')
except ValueError:
    pass
else:
    raise AssertionError('无效 YAML 未被拒绝')
valid, message = validator.validate_skill(Path(skill_path))
print(message)
raise SystemExit(0 if valid else 1)
