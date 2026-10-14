#!/usr/bin/env python3
"""用 Python 标准库将已确认的标书正文写成基本 DOCX。"""

from datetime import datetime, timezone
from html import escape
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def _run(value):
    lines = value.split("\n")
    return "".join(
        f'<w:r><w:t xml:space="preserve">{escape(line)}</w:t></w:r>'
        + ('<w:r><w:br/></w:r>' if index < len(lines) - 1 else '')
        for index, line in enumerate(lines)
    )


def _paragraph(value, style=None):
    properties = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ''
    return f'<w:p>{properties}{_run(value)}</w:p>'


def _table(rows):
    cells = []
    for row in rows:
        cells.append('<w:tr>' + ''.join(
            '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>'
            + _paragraph(cell.strip()) + '</w:tc>' for cell in row
        ) + '</w:tr>')
    return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + ''.join(cells) + '</w:tbl>'


def _body_blocks(body):
    blocks = []
    paragraph = []
    table = []

    def flush_paragraph():
        if paragraph:
            blocks.append(_paragraph(' '.join(paragraph)))
            paragraph.clear()

    def flush_table():
        if table:
            blocks.append(_table(table))
            table.clear()

    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith('|') and line.endswith('|'):
            flush_paragraph()
            row = [cell.strip() for cell in line.strip('|').split('|')]
            if row and all(cell and set(cell) <= {':', '-'} for cell in row):
                continue
            table.append(row)
        elif not line:
            flush_paragraph()
            flush_table()
        else:
            flush_table()
            if line.startswith('# '):
                flush_paragraph()
                blocks.append(_paragraph(line[2:], 'Heading2'))
            elif line.startswith('## '):
                flush_paragraph()
                blocks.append(_paragraph(line[3:], 'Heading3'))
            else:
                paragraph.append(line)
    flush_paragraph()
    flush_table()
    return blocks


def write_docx(title, sections, chapters, destination):
    """按目录树的顺序导出可用 Word 打开的基本 DOCX。"""
    children = {None: []}
    for position, section in enumerate(sections, 1):
        children.setdefault(section.get('parent_position'), []).append(position)
        children.setdefault(position, [])

    blocks = [_paragraph(title, 'Title')]

    def visit(position, depth):
        section = sections[position - 1]
        blocks.append(_paragraph(section['title'], f'Heading{min(depth, 3)}'))
        if section['writable']:
            blocks.extend(_body_blocks(chapters[position]))
        for child in children[position]:
            visit(child, depth + 1)

    for root in children[None]:
        visit(root, 1)
    blocks.append('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' \
        + ''.join(blocks) + '</w:body></w:document>'
    styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' \
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' \
        '<w:rPr><w:rFonts w:eastAsia="SimSun"/><w:sz w:val="24"/></w:rPr></w:style>' \
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>' \
        '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>' \
        + ''.join(
            f'<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/>'
            f'<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="{level - 1}"/></w:pPr>'
            f'<w:rPr><w:b/><w:sz w:val="{max(24, 34 - level * 4)}"/></w:rPr></w:style>'
            for level in range(1, 4)
        ) + '</w:styles>'
    content_types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' \
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' \
        '<Default Extension="xml" ContentType="application/xml"/>' \
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' \
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' \
        '</Types>'
    root_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' \
        '</Relationships>'
    document_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' \
        '</Relationships>'
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        for name, contents in (
            ('[Content_Types].xml', content_types),
            ('_rels/.rels', root_rels),
            ('word/document.xml', document),
            ('word/styles.xml', styles),
            ('word/_rels/document.xml.rels', document_rels),
        ):
            archive.writestr(name, contents.encode('utf-8'))
    return {'file': str(destination), 'created_at': datetime.now(timezone.utc).isoformat()}
