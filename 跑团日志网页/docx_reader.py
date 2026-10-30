"""读取 Word（.docx）日志。

支持三种内容：
- 表格：每行两列，左列为角色名，右列为 RP（没有时间和 QQ 号）。
- 段落带标记：`<角色名> 内容`，`<kp>` 为主持人；`【场景】` 单独成段时作为章节标题，没有标记的段落接在上一条发言后面。
- 段落：与 TXT 相同的 QQ 导出格式，交给 log_parser.parse_text 处理。
"""
import re
import zipfile
import xml.etree.ElementTree as ET

from log_parser import CHAPTER_RE, CONTROL_RE, build_result, parse_text

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
HEADER_SPEAKERS = {'角色', '角色名', '姓名', '名字', '人物'}
HEADER_CONTENTS = {'rp', 'RP', '内容', '台词'}
MARKER_RE = re.compile(r'<([^<>\n]{1,20})>\s+')
SCENE_TAG_RE = re.compile(r'【[^【】\n]{1,30}】')
SEPARATOR_RE = re.compile(r'^[\s\-—–_=~·•*＊]{3,}$')
KP_NAMES = {'kp'}
# 骰子机器人附带在每条消息末尾的签名，导入时去掉。
DICE_SIGNATURES = ('对于我来说，迄今为止的一切都很重要，包括事件最终无论好坏的结局。',)


def _paragraph_text(p) -> str:
    parts = []
    for node in p.iter():
        if node.tag == W + 't':
            parts.append(node.text or '')
        elif node.tag == W + 'tab':
            parts.append('\t')
        elif node.tag == W + 'br':
            parts.append('\n')
    return ''.join(parts)


def _cell_text(tc) -> str:
    return '\n'.join(_paragraph_text(p) for p in tc.findall(W + 'p')).strip()


def read_blocks(path) -> list:
    """按文档顺序返回 ('p', 文本) 或 ('row', [单元格文本, ...])。"""
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read('word/document.xml'))
    body = root.find(W + 'body')
    blocks = []
    for child in body:
        if child.tag == W + 'p':
            blocks.append(('p', _paragraph_text(child)))
        elif child.tag == W + 'tbl':
            for tr in child.findall(W + 'tr'):
                blocks.append(('row', [_cell_text(tc) for tc in tr.findall(W + 'tc')]))
    return blocks


def _speaker(name: str) -> str:
    return 'KP' if name.strip().lower() in KP_NAMES else name.strip()


def _single_line_event(text: str):
    if CHAPTER_RE.fullmatch(text):
        return ('chapter', text)
    return ('msg', '', None, None, [text])


def _marker_events(text: str) -> list:
    """解析带 <角色> 标记的段落，可能包含【场景】前缀或段内的多个标记。"""
    if CHAPTER_RE.fullmatch(text) or SCENE_TAG_RE.fullmatch(text):
        return [('chapter', text)]
    events = []
    tag = SCENE_TAG_RE.match(text)
    if tag and text[tag.end():].startswith('<'):
        events.append(('chapter', tag.group(0)))
        text = text[tag.end():]
    matches = list(MARKER_RE.finditer(text))
    if not matches:
        return events + [('cont', text)]
    head = text[:matches[0].start()].strip()
    if head:
        events.append(('cont', head))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        events.append(('msg', _speaker(m.group(1)), None, None, [text[m.end():end].strip()]))
    return events


def _attach_continuations(events) -> list:
    """无标记的段落接到上一条发言后面；.log 指令单独保留。"""
    merged = []
    for event in events:
        if event[0] == 'cont' and not CONTROL_RE.match(event[1]):
            if merged and merged[-1][0] == 'msg':
                merged[-1][4].append(event[1])
            else:
                merged.append(('msg', '', None, None, [event[1]]))
        elif event[0] == 'cont':
            merged.append(('msg', '', None, None, [event[1]]))
        else:
            merged.append(event)
    return merged


def _table_events(blocks, marker_mode: bool) -> list:
    events = []
    for kind, value in blocks:
        if kind == 'p':
            text = value.strip()
            if not text:
                continue
            if SEPARATOR_RE.fullmatch(text):
                events.append(('sep',))
            elif marker_mode:
                events.extend(_marker_events(text))
            else:
                events.append(_single_line_event(text))
            continue
        cells = [c.strip() for c in value]
        if len(cells) == 1:
            if cells[0]:
                events.append(('sep',) if SEPARATOR_RE.fullmatch(cells[0]) else _single_line_event(cells[0]))
            continue
        if len(cells) < 2:
            continue
        speaker, content = cells[0], '\n'.join(c for c in cells[1:] if c)
        if speaker in HEADER_SPEAKERS and cells[1] in HEADER_CONTENTS:
            continue
        if SEPARATOR_RE.fullmatch(content):
            events.append(('sep',))
        elif content:
            events.append(('msg', speaker, None, None, [content]))
    return events


def _clean_line(line: str) -> str:
    for signature in DICE_SIGNATURES:
        line = line.replace(signature, '')
    return line.strip()


def _finalize(events) -> list:
    """去掉骰子签名与 .log 指令；分隔线只在其后出现消息时开启新章节。"""
    out = []
    pending = False
    separator_count = 0
    for event in events:
        if event[0] == 'sep':
            pending = True
            continue
        if event[0] != 'msg':
            out.append(event)
            continue
        lines = [c for c in (_clean_line(line) for line in event[4]) if c]
        if not lines or CONTROL_RE.match(lines[0]):
            continue
        if pending:
            separator_count += 1
            out.append(('chapter', f'第{separator_count}段'))
            pending = False
        out.append(('msg', event[1], None, None, lines))
    return out


def parse_docx(path) -> dict:
    blocks = read_blocks(path)
    has_table_rows = any(kind == 'row' and len([c for c in v if c]) >= 2 for kind, v in blocks)
    marker_mode = any(kind == 'p' and MARKER_RE.search(v.strip()) for kind, v in blocks)
    if not has_table_rows and not marker_mode:
        text = '\n'.join(v for kind, v in blocks if kind == 'p')
        return parse_text(text)
    # Word 日志没有 .log 开关，默认视为场内，仅括号开头的内容标为场外。
    events = _finalize(_attach_continuations(_table_events(blocks, marker_mode)))
    return build_result(events, default_scene_on=True)

