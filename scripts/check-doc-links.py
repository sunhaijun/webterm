#!/usr/bin/env python3
"""校验 docs/ 里的相对链接与锚点。

docs/ 是唯一事实来源（见 CLAUDE.md），坏链就是文档腐烂的第一个信号。
"""
import os
import re
import sys
import urllib.parse

LINK = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
HEADING = re.compile(r'#{1,6}\s+(.*)')


def slug(text: str) -> str:
    t = re.sub(r'[`*]', '', text.strip()).lower()
    t = re.sub(r'[^\w一-鿿\s-]', '', t)
    return t.strip().replace(' ', '-')


def anchors(path: str) -> set[str]:
    out = set()
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = HEADING.match(line)
            if m:
                out.add(slug(m.group(1)))
    return out


def main() -> int:
    files = []
    for root, dirs, names in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules')]
        files += [os.path.normpath(os.path.join(root, n))
                  for n in names if n.endswith('.md')]

    bad = []
    total = 0
    for f in files:
        with open(f, encoding='utf-8') as fh:
            body = fh.read()
        for m in LINK.finditer(body):
            target = m.group(2).strip()
            if target.startswith(('http://', 'https://', 'mailto:')):
                continue
            total += 1
            frag = ''
            if '#' in target:
                target, frag = target.split('#', 1)
            frag = urllib.parse.unquote(frag)
            path = f if target == '' else os.path.normpath(
                os.path.join(os.path.dirname(f), urllib.parse.unquote(target)))
            if not os.path.exists(path):
                bad.append((f, m.group(0), '文件不存在'))
            elif frag and path.endswith('.md') and frag not in anchors(path):
                bad.append((f, m.group(0), '锚点不存在'))

    for path, link, why in bad:
        print(f'{path}: {why}\n    {link}')
    print(f'检查了 {total} 条相对链接，{len(bad)} 条失效')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
