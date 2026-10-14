"""使用当前 Python 直接运行独立标书技能的全部回归，不安装依赖。"""
from pathlib import Path
import sys
import unittest


if __name__ == '__main__':
    directory = Path(__file__).resolve().parents[1] / 'deliverables' / 'tests'
    suite = unittest.defaultTestLoader.discover(str(directory), pattern='test_bid_workbuddy*.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
