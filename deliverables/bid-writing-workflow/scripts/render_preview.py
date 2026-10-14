"""从已校验的阶段产物生成可离线打开的审阅页面。"""

from html import escape
from pathlib import Path
from urllib.parse import quote


STAGE_TITLES = (
    '文件接入', '招标分析', '初版目录',
    '证据映射与终版目录', '章节写作与整书审核', 'DOCX 导出与验收',
)


def preview_name(index, stage_names):
    return f'{index + 1:02d}-{stage_names[index]}.html'


def value(item):
    return escape(str(item if item is not None else ''))


def panel(title, body):
    return f'<section class="panel"><h2>{value(title)}</h2>{body}</section>'


def item_list(items):
    if not items:
        return '<p class="muted">无</p>'
    return '<ul>' + ''.join(f'<li>{value(item)}</li>' for item in items) + '</ul>'


def source_label(source):
    if not isinstance(source, dict):
        return ''
    location = source.get('location', '')
    origin = source.get('file') or source.get('url') or ''
    return f'{origin} · {location}'


def table(headers, rows):
    head = ''.join(f'<th>{value(header)}</th>' for header in headers)
    body = ''.join('<tr>' + ''.join(f'<td>{value(cell)}</td>' for cell in row) + '</tr>' for row in rows)
    return f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def section_sequence(sections):
    children = {None: []}
    for position, section in enumerate(sections, 1):
        children.setdefault(section.get('parent_position'), []).append(position)
        children.setdefault(position, [])

    def visit(position, depth):
        yield position, depth
        for child in children[position]:
            yield from visit(child, depth + 1)

    for position in children[None]:
        yield from visit(position, 1)


def outline_cards(data, analysis):
    sections = data.get('sections', [])
    points = [point for group in data.get('response_points', []) for point in group]
    cards = []
    for position, depth in section_sequence(sections):
        section = sections[position - 1]
        requirements = [analysis['requirements'][item - 1]['text'] for item in section.get('requirement_positions', [])]
        response_points = [points[item - 1] for item in section.get('response_point_positions', [])]
        cards.append(
            f'<article class="section depth-{min(depth, 3)}">'
            f'<div class="section-head"><span class="number">{position:02d}</span>'
            f'<h3>{value(section.get("title"))}</h3>'
            f'<span class="tag">{"正文" if section.get("writable") else "结构"}</span></div>'
            f'<p><strong>必答：</strong>{value("；".join(section.get("must_answer", [])) or "无")}</p>'
            f'<p class="meta"><strong>响应要求：</strong>{value("；".join(requirements) or "无")}</p>'
            f'<p class="meta"><strong>评分响应点：</strong>{value("；".join(response_points) or "无")}</p>'
            '</article>'
        )
    return ''.join(cards)


def manuscript_html(body):
    blocks = []
    paragraph = []
    table_rows = []

    def flush_paragraph():
        if paragraph:
            blocks.append('<p>' + value(' '.join(paragraph)) + '</p>')
            paragraph.clear()

    def flush_table():
        if table_rows:
            headers = table_rows[0]
            blocks.append(table(headers, table_rows[1:]))
            table_rows.clear()

    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith('|') and line.endswith('|'):
            flush_paragraph()
            row = [cell.strip() for cell in line.strip('|').split('|')]
            if row and all(cell and set(cell) <= {':', '-'} for cell in row):
                continue
            table_rows.append(row)
        elif not line:
            flush_paragraph()
            flush_table()
        else:
            flush_table()
            if line.startswith(('# ', '## ')):
                flush_paragraph()
                blocks.append(f'<h4>{value(line.lstrip("# "))}</h4>')
            else:
                paragraph.append(line)
    flush_paragraph()
    flush_table()
    return ''.join(blocks)


def content(index, data, context):
    if index == 0:
        roles = {'tender': '招标文件', 'framework': '目录框架', 'prior_bid': '旧标参考', 'reference': '参考资料'}
        rows = [
            (Path(item.get('path', '')).name, roles.get(item.get('role'), item.get('role', '')),
             '可读' if item.get('readable') else '不可读', item.get('issue', ''))
            for item in data.get('files', [])
        ]
        return panel('资料清单', table(('文件', '角色', '状态', '问题'), rows)) + panel('接入检查', f'<p>{value(data.get("inspection"))}</p>')
    if index == 1:
        project = data.get('project', {})
        parts = [panel('项目概况', f'<p>{value(project.get("summary"))}</p>')]
        for label, key, field in (
            ('招标要求', 'requirements', 'text'), ('评分原文', 'scoring', 'original_text'),
            ('合规事项', 'compliance', 'text'),
        ):
            rows = [
                (number, item.get(field, ''), source_label(item.get('source')),
                 '强制' if key == 'requirements' and item.get('mandatory') else '')
                for number, item in enumerate(data.get(key, []), 1)
            ]
            parts.append(panel(label, table(('序号', '内容', '来源', '标记'), rows)))
        return ''.join(parts)
    if index == 2:
        points = [f'评分项 {number}：' + '；'.join(items)
                  for number, items in enumerate(data.get('response_points', []), 1)]
        return panel('评分响应点', item_list(points)) + panel('初版目录', outline_cards(data, context['analysis']))
    if index == 3:
        research = []
        for item in data.get('research', []):
            evidence = [f'{source_label(source)}｜用途：{source.get("use", "")}' for source in item.get('evidence', [])]
            title = data['sections'][item['section_position'] - 1]['title']
            research.append(
                f'<article class="research"><h3>{value(title)}</h3>'
                f'<p><strong>回答计划：</strong>{value(item.get("answer_plan"))}</p>'
                f'<h4>证据</h4>{item_list(evidence)}<h4>资料缺口</h4>'
                f'{item_list(item.get("missing_topics", []))}</article>'
            )
        return panel('终版目录', outline_cards(data, context['analysis'])) + panel('逐章证据与计划', ''.join(research))
    if index == 4:
        chapters = []
        by_position = {chapter['section_position']: chapter for chapter in data.get('chapters', [])}
        sections = context['outline']['sections']
        for position, _ in section_sequence(sections):
            if position not in by_position:
                continue
            chapter = by_position[position]
            title = sections[position - 1]['title']
            chapters.append(
                f'<article class="chapter"><h3>{value(title)}</h3>'
                f'<div class="manuscript">{manuscript_html(chapter.get("body", ""))}</div>'
                '<p class="meta">章节复核：已通过</p></article>'
            )
        return panel('章节正文', ''.join(chapters)) + panel('整书审核',
            '<p>已完成整书审核，未发现尚未解决的问题。</p>')
    filename = Path(data['file']).name
    href = '../output/' + quote(filename)
    return panel('最终文件',
        f'<p>文件名：{value(filename)}</p><p>大小：{data.get("size", 0) / 1024:.1f} KB</p>'
        f'<p><a class="download" href="{escape(href, quote=True)}">打开或下载 DOCX</a></p>'
        '<p class="muted">请用文档工具实际打开并检查版面；此页面只展示导出信息。</p>')


def render(index, data, state, stage_names, context):
    entry = state['stages'][index]
    status = entry['status'] if entry else 'pending'
    confirmed = status == 'confirmed'
    navigation = ''.join(
        f'<div class="step {"active" if number == index else ""} {"done" if item and item["status"] == "confirmed" else ""}">'
        f'<span>{number + 1:02d}</span><b>{value(STAGE_TITLES[number])}</b></div>'
        for number, item in enumerate(state['stages'])
    )
    confirmation = ''
    if confirmed:
        words = entry.get('confirmation', {}).get('user_words', '')
        confirmation = f'<p class="confirmation">用户确认：{value(words)}</p>'
    artifact_body = content(index, data, context)
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{value(STAGE_TITLES[index])} · 标书编制</title>'
        '<style>'
        ':root{color-scheme:light;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#18223a;background:#f4f6fa}'
        '*{box-sizing:border-box}body{margin:0}header{background:#152741;color:#fff;padding:32px max(24px,calc((100vw - 1100px)/2))}'
        'header p{margin:0 0 8px;color:#afc8e8}h1{font-size:30px;margin:0 0 10px}.subtitle{color:#d5e2f2}'
        'main{max-width:1100px;margin:24px auto;padding:0 20px 48px}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:24px}'
        '.step{background:#fff;border:1px solid #dce3ef;border-radius:9px;padding:11px 14px;color:#65738b;display:flex;gap:10px;align-items:center}'
        '.step span{font-size:12px;font-weight:700}.step b{font-size:13px}.step.active{border-color:#2d68c4;color:#174c9d;background:#eaf2ff}'
        '.step.done{border-color:#84c7a0;color:#196b44}.panel{background:#fff;border:1px solid #dce3ef;border-radius:12px;padding:24px;margin:16px 0;box-shadow:0 3px 16px #1527410a}'
        'h2{font-size:21px;margin:0 0 18px}h3{font-size:17px;margin:0}h4{font-size:14px;margin:18px 0 7px}p{line-height:1.75;margin:10px 0}'
        '.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid #e6ebf3;padding:10px;vertical-align:top}'
        'th{background:#f2f5fa;color:#4c5d78}.section,.research,.chapter{border:1px solid #e5eaf2;border-radius:9px;padding:15px;margin:10px 0}'
        '.section.depth-2{margin-left:24px}.section.depth-3{margin-left:48px}.section-head{display:flex;gap:12px;align-items:center}'
        '.number{font-size:12px;color:#4272ba}.tag{margin-left:auto;background:#edf2f9;border-radius:20px;padding:3px 9px;font-size:12px;color:#4c6281}'
        '.meta,.muted{color:#66768e;font-size:13px}.manuscript{line-height:1.85;white-space:normal}.manuscript p{margin:12px 0}'
        '.confirmation{background:#e5f6ec;border-left:4px solid #2e995e;padding:12px 16px;border-radius:5px}'
        '.download{display:inline-block;background:#2465bf;color:#fff;text-decoration:none;border-radius:7px;padding:10px 16px}'
        'footer{max-width:1100px;margin:0 auto 30px;padding:0 20px;color:#718097;font-size:13px}'
        '@media(max-width:720px){.steps{grid-template-columns:repeat(2,1fr)}header{padding:25px 20px}.panel{padding:16px}.section.depth-3{margin-left:20px}}'
        '</style></head><body>'
        f'<header><p>标书编制 · 第 {index + 1} 阶段</p><h1>{value(STAGE_TITLES[index])}</h1>'
        f'<div class="subtitle">{"已确认" if confirmed else "待用户审阅与确认"} · 阶段成果预览</div></header>'
        f'<main><nav class="steps" aria-label="阶段进度">{navigation}</nav>{confirmation}{artifact_body}</main>'
        '<footer>本页面由当前阶段产物生成。修改意见请在对话中提出；页面不会自动提交用户确认。</footer>'
        '</body></html>\n'
    )
